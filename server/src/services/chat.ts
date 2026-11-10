import { config } from '../config.js';
import { isLocale, m, tr, type Locale } from '../i18n/index.js';
import { checkBoundary } from '../lib/boundary.js';
import type { Ctx } from '../lib/context.js';
import { badRequest } from '../lib/errors.js';
import { openSecret, sealSecret } from '../lib/secretbox.js';
import { audit } from './audit.js';
import { maskEmail, mailSubject } from './mailer.js';
import { CATEGORIES, type Category } from './notify.js';

// Chat channels Slack and Microsoft Teams (R3-16): one more delivery channel of the outbox,
// next to the in-app inbox and e-mail. Each person opts in with the same categories as for
// e-mail (R1-36). Confidential ideas and possible reports never show their title or text in
// a chat: only "Idee #N", a neutral sentence and the link to the portal.

export type ChatProvider = 'slack' | 'teams';
export const PROVIDERS: readonly ChatProvider[] = ['slack', 'teams'];

// ---------------------------------------------------------------- HTTP (injectable, no network in tests)

export interface ChatRequest {
  method?: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  /** JSON body for POST. */
  body?: unknown;
}
export interface ChatResponse {
  status: number;
  body: unknown;
}
export type ChatHttp = (req: ChatRequest) => Promise<ChatResponse>;

const fetchHttp: ChatHttp = async (req) => {
  const res = await fetch(req.url, {
    method: req.method ?? 'POST',
    headers: { ...(req.body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }), ...req.headers },
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // webhooks answer with plain text ("ok", "1")
  }
  return { status: res.status, body };
};

let http: ChatHttp = fetchHttp;

/** Replaces the HTTP sender (tests); returns the previous one. */
export function setChatHttp(h: ChatHttp): ChatHttp {
  const prev = http;
  http = h;
  return prev;
}
export const chatHttp: ChatHttp = (req) => http(req);

// ---------------------------------------------------------------- Slack Web API

export interface SlackResult {
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}

export async function slackApi(token: string, method: string, args: Record<string, unknown>, get = false): Promise<SlackResult> {
  const url = `https://slack.com/api/${method}`;
  const res = get
    ? await chatHttp({ method: 'GET', url: `${url}?${new URLSearchParams(Object.entries(args).map(([k, v]) => [k, String(v)]))}`, headers: { authorization: `Bearer ${token}` } })
    : await chatHttp({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, body: args });
  const body = (res.body ?? {}) as SlackResult;
  return typeof body === 'object' ? body : { ok: false, error: 'bad_response' };
}

// ---------------------------------------------------------------- personal webhooks

/**
 * Hosts a personal incoming webhook may point to (no requests to arbitrary addresses):
 * Slack incoming webhooks, Teams connectors and Teams Workflows (Power Automate).
 */
const WEBHOOK_HOSTS = [/^hooks\.slack\.com$/, /\.webhook\.office\.com$/, /\.logic\.azure\.com$/, /\.powerplatform\.com$/, /\.powerautomate\.com$/];

export function validWebhookUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.port && !u.username && WEBHOOK_HOSTS.some((h) => h.test(u.hostname));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- workspace configuration (admins)

export interface WorkspaceRow {
  id: string;
  tenant_id: string;
  provider: ChatProvider;
  enabled: boolean;
  external_id: string | null;
  signing_secret_enc: string | null;
  bot_token_enc: string | null;
}

export async function workspaces(ctx: Ctx): Promise<Record<ChatProvider, WorkspaceRow | null>> {
  const r = await ctx.db.query<WorkspaceRow>('SELECT id, tenant_id, provider, enabled, external_id, signing_secret_enc, bot_token_enc FROM chat_workspaces');
  return { slack: r.rows.find((w) => w.provider === 'slack') ?? null, teams: r.rows.find((w) => w.provider === 'teams') ?? null };
}

const endpoint = (w: WorkspaceRow | null, path: string) => (w ? `${config.publicUrl}/api/integrations/${w.provider}/${w.id}/${path}` : null);

/** What the admin page shows; secrets only as "set". */
export async function workspaceView(ctx: Ctx) {
  const w = await workspaces(ctx);
  return {
    slack: {
      enabled: !!w.slack?.enabled,
      teamId: w.slack?.external_id ?? null,
      signingSecretSet: !!w.slack?.signing_secret_enc,
      botTokenSet: !!w.slack?.bot_token_enc,
      commandsUrl: endpoint(w.slack, 'commands'),
      interactionsUrl: endpoint(w.slack, 'interactions'),
    },
    teams: {
      enabled: !!w.teams?.enabled,
      botAppId: w.teams?.external_id ?? null,
      secretSet: !!w.teams?.signing_secret_enc,
      messagesUrl: endpoint(w.teams, 'messages'),
    },
  };
}

export interface WorkspaceInput {
  enabled: boolean;
  externalId?: string | null;
  /** undefined: keep, null or '': delete, else: replace. */
  signingSecret?: string | null;
  botToken?: string | null;
}

export async function saveWorkspace(ctx: Ctx, provider: ChatProvider, input: WorkspaceInput): Promise<void> {
  const seal = async (v: string | null | undefined) => (v === undefined ? undefined : v ? sealSecret(ctx.db, ctx.tenantId, v) : null);
  const secret = await seal(input.signingSecret);
  const token = provider === 'slack' ? await seal(input.botToken) : null;
  const before = (await workspaces(ctx))[provider];
  await ctx.db.query(
    `INSERT INTO chat_workspaces (tenant_id, provider, enabled, external_id, signing_secret_enc, bot_token_enc, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, provider) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       external_id = CASE WHEN $8 THEN EXCLUDED.external_id ELSE chat_workspaces.external_id END,
       signing_secret_enc = CASE WHEN $9 THEN EXCLUDED.signing_secret_enc ELSE chat_workspaces.signing_secret_enc END,
       bot_token_enc = CASE WHEN $10 THEN EXCLUDED.bot_token_enc ELSE chat_workspaces.bot_token_enc END,
       updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [ctx.tenantId, provider, input.enabled, input.externalId ?? null, secret ?? null, token ?? null, ctx.user?.id ?? null,
     input.externalId !== undefined, secret !== undefined, token !== undefined || provider === 'teams'],
  );
  // Secrets never go into the audit log, only whether they are set.
  await audit(ctx, 'chat.workspace', 'chat_workspace', provider,
    before && { enabled: before.enabled, externalId: before.external_id },
    { enabled: input.enabled, externalId: input.externalId, signingSecretChanged: secret !== undefined, botTokenChanged: token !== undefined });
}

// ---------------------------------------------------------------- personal opt-in

export interface Subscription {
  channel: 'off' | ChatProvider;
  muted: Category[];
  webhookUrl?: string | null;
}

export async function subscriptionView(ctx: Ctx) {
  const w = await workspaces(ctx);
  const r = await ctx.db.query<{ channel: string; muted: string[]; webhook: boolean; slack_user_id: string | null; teams_aad_id: string | null }>(
    'SELECT channel, muted, webhook_url_enc IS NOT NULL AS webhook, slack_user_id, teams_aad_id FROM chat_subscriptions WHERE user_id = $1',
    [ctx.user!.id],
  );
  const s = r.rows[0];
  return {
    available: {
      slack: !!w.slack?.enabled,
      slackBot: !!w.slack?.enabled && !!w.slack.bot_token_enc,
      teams: !!w.teams?.enabled,
    },
    channel: s?.channel ?? 'off',
    muted: s?.muted ?? [],
    webhookSet: !!s?.webhook,
    slackLinked: !!s?.slack_user_id,
    teamsLinked: !!s?.teams_aad_id,
  };
}

export async function saveSubscription(ctx: Ctx, input: Subscription): Promise<void> {
  const w = await workspaces(ctx);
  if (input.webhookUrl && !validWebhookUrl(input.webhookUrl)) throw badRequest(m('chat.invalidWebhook'));
  if (input.channel !== 'off') {
    const ws = w[input.channel];
    if (!ws?.enabled) throw badRequest(m('chat.notConfigured'));
    const current = await ctx.db.query<{ webhook: boolean }>('SELECT webhook_url_enc IS NOT NULL AS webhook FROM chat_subscriptions WHERE user_id = $1', [ctx.user!.id]);
    const hasWebhook = input.webhookUrl === undefined ? !!current.rows[0]?.webhook : !!input.webhookUrl;
    const botDm = input.channel === 'slack' && !!ws.bot_token_enc;
    if (!hasWebhook && !botDm) throw badRequest(m('chat.noDestination'));
  }
  const webhook = input.webhookUrl === undefined ? undefined : input.webhookUrl ? await sealSecret(ctx.db, ctx.tenantId, input.webhookUrl) : null;
  await ctx.db.query(
    `INSERT INTO chat_subscriptions (user_id, tenant_id, channel, muted, webhook_url_enc) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET channel = EXCLUDED.channel, muted = EXCLUDED.muted,
       webhook_url_enc = CASE WHEN $6 THEN EXCLUDED.webhook_url_enc ELSE chat_subscriptions.webhook_url_enc END, updated_at = now()`,
    [ctx.user!.id, ctx.tenantId, input.channel, input.muted.filter((c) => (CATEGORIES as readonly string[]).includes(c)), webhook ?? null, webhook !== undefined],
  );
}

// ---------------------------------------------------------------- messages

export interface ChatNote {
  title: string;
  text: string | null;
  url: string;
  /** Set when the note is an open question to the author: the chat shows the answer path. */
  questionFor: number | null;
}

interface NoteSource {
  subject: string;
  body: string;
  category: string;
  idea_id: string | null;
  number: number | null;
  confidential: boolean | null;
  idea_status: string | null;
}

const MAX_TEXT = 1500;

/**
 * Turns an outbox row into a chat note. Confidential ideas, forwarded ideas (they may be
 * reports) and texts that the local boundary check flags show only "Idee #N" (R1-45, R1-18).
 */
export function chatNote(ctx: Ctx, row: NoteSource, locale: Locale): ChatNote {
  const url = row.idea_id ? `${config.publicUrl}/ideen/${row.idea_id}` : `${config.publicUrl}/`;
  const flagged = checkBoundary(`${row.subject} ${row.body}`, ctx.settings).length > 0;
  const minimal = !!row.confidential || row.idea_status === 'forwarded' || flagged;
  const questionFor = row.idea_status === 'in_question' && row.category === 'my_ideas' && row.number != null ? row.number : null;
  if (minimal) {
    const title = row.number != null ? mailSubject({ subject: row.subject, confidential: true, number: row.number }, locale) : tr(locale, m('chat.genericTitle'));
    return { title, text: tr(locale, m('chat.confidentialBody')), url, questionFor };
  }
  const text = row.body.length > MAX_TEXT ? `${row.body.slice(0, MAX_TEXT)}…` : row.body;
  return { title: row.subject, text, url, questionFor };
}

const slackEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function slackMessage(note: ChatNote, locale: Locale, opts: { interactive: boolean; ideaId?: string | null }) {
  const lines = [`*${slackEscape(note.title)}*`];
  if (note.text) lines.push(slackEscape(note.text));
  if (note.questionFor != null) lines.push(`_${slackEscape(tr(locale, m('chat.questionHint', { cmd: '/idee ', number: note.questionFor })))}_`);
  const buttons: unknown[] = [{ type: 'button', text: { type: 'plain_text', text: tr(locale, m('chat.open')) }, url: note.url, action_id: 'ip_open' }];
  if (note.questionFor != null && opts.interactive && opts.ideaId) {
    buttons.push({ type: 'button', style: 'primary', text: { type: 'plain_text', text: tr(locale, m('chat.answerButton')) }, action_id: 'ip_answer', value: opts.ideaId });
  }
  return {
    text: note.title,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
      { type: 'actions', elements: buttons },
      { type: 'context', elements: [{ type: 'mrkdwn', text: slackEscape(tr(locale, m('chat.settings', { url: config.publicUrl }))) }] },
    ],
  };
}

/** Adaptive Card for a Teams incoming webhook (Workflows); the question variant is the "Rückfrage-Karte". */
export function teamsCard(note: ChatNote, locale: Locale) {
  const body: unknown[] = [{ type: 'TextBlock', text: note.title, weight: 'Bolder', size: 'Medium', wrap: true }];
  if (note.text) body.push({ type: 'TextBlock', text: note.text, wrap: true });
  if (note.questionFor != null) {
    body.unshift({ type: 'TextBlock', text: tr(locale, m('chat.questionTitle')), color: 'Accent', weight: 'Bolder', wrap: true });
    body.push({ type: 'TextBlock', text: tr(locale, m('chat.questionHint', { cmd: '', number: note.questionFor })), isSubtle: true, wrap: true });
  }
  body.push({ type: 'TextBlock', text: tr(locale, m('chat.settings', { url: config.publicUrl })), isSubtle: true, size: 'Small', wrap: true });
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      contentUrl: null,
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body,
        actions: [{ type: 'Action.OpenUrl', title: tr(locale, m(note.questionFor != null ? 'chat.answerButton' : 'chat.open')), url: note.url }],
      },
    }],
  };
}

// ---------------------------------------------------------------- dispatch from the outbox

interface PendingChat extends NoteSource {
  id: number;
  user_id: string;
  email: string;
  locale: string | null;
  channel: ChatProvider;
  muted: string[];
  webhook_url_enc: string | null;
  slack_user_id: string | null;
}

/**
 * Sends new outbox rows to the chat of everyone who opted in. Every row is handled once:
 * rows of people without chat, muted categories and failed deliveries are marked as done;
 * the in-app inbox and e-mail stay the reliable channels.
 */
export async function dispatchChat(ctx: Ctx, limit = 200): Promise<number> {
  const ws = await workspaces(ctx);
  const pending = await ctx.db.query<PendingChat>(
    `SELECT o.id, o.user_id, o.subject, o.body, o.category, o.idea_id, i.number, i.confidential, i.status AS idea_status,
            u.email, u.locale, s.channel, s.muted, s.webhook_url_enc, s.slack_user_id
       FROM outbox o JOIN users u ON u.id = o.user_id AND u.active
       JOIN chat_subscriptions s ON s.user_id = o.user_id AND s.channel <> 'off'
       LEFT JOIN ideas i ON i.id = o.idea_id
      WHERE o.chat_sent_at IS NULL ORDER BY o.id LIMIT $1 FOR UPDATE OF o SKIP LOCKED`,
    [limit],
  );
  let sent = 0;
  for (const row of pending.rows) {
    const w = ws[row.channel];
    if (w?.enabled && !row.muted.includes(row.category)) {
      try {
        if (await deliverChat(ctx, w, row)) sent++;
      } catch (err) {
        // No idea content in logs (R1-05).
        console.warn(`[chat] ${row.channel} delivery failed for ${maskEmail(row.email)}: ${(err as Error).message.slice(0, 120)}`);
      }
    }
    await ctx.db.query('UPDATE outbox SET chat_sent_at = now() WHERE id = $1', [row.id]);
  }
  // Rows nobody reads in a chat (system mails, people without opt-in) are closed in one go.
  await ctx.db.query(
    `UPDATE outbox o SET chat_sent_at = now() WHERE o.chat_sent_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM chat_subscriptions s JOIN users u ON u.id = s.user_id AND u.active
                         WHERE s.user_id = o.user_id AND s.channel <> 'off')`,
  );
  return sent;
}

async function deliverChat(ctx: Ctx, w: WorkspaceRow, row: PendingChat): Promise<boolean> {
  const locale: Locale = isLocale(row.locale) ? row.locale : 'de';
  const note = chatNote(ctx, row, locale);
  if (row.channel === 'slack' && w.bot_token_enc) {
    const token = await openSecret(ctx.db, ctx.tenantId, w.bot_token_enc);
    let member = row.slack_user_id;
    if (!member) {
      // Mapping by e-mail address (needs the scope users:read.email).
      const found = await slackApi(token, 'users.lookupByEmail', { email: row.email }, true);
      member = found.ok ? ((found.user as { id?: string } | undefined)?.id ?? null) : null;
      if (member) await ctx.db.query('UPDATE chat_subscriptions SET slack_user_id = $2 WHERE user_id = $1', [row.user_id, member]);
    }
    if (member) {
      const res = await slackApi(token, 'chat.postMessage', { channel: member, ...slackMessage(note, locale, { interactive: true, ideaId: row.idea_id }) });
      if (!res.ok) throw new Error(`slack ${res.error ?? 'error'}`);
      return true;
    }
  }
  if (!row.webhook_url_enc) return false;
  const url = await openSecret(ctx.db, ctx.tenantId, row.webhook_url_enc);
  if (!validWebhookUrl(url)) return false;
  const body = row.channel === 'slack' ? slackMessage(note, locale, { interactive: false }) : teamsCard(note, locale);
  const res = await chatHttp({ url, body });
  if (res.status >= 300) throw new Error(`webhook ${res.status}`);
  return true;
}
