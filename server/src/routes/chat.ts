import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { withScopes } from '../services/areas.js';
import { z } from 'zod';
import { withSystem, withTenant, type Db } from '../db/pool.js';
import { tenantHandler } from '../http.js';
import { isLocale, m, tr, type Locale, type Text } from '../i18n/index.js';
import { buildCtx, type Ctx, type Role, type SessionUser } from '../lib/context.js';
import { notFound } from '../lib/errors.js';
import { openSecret } from '../lib/secretbox.js';
import { audit } from '../services/audit.js';
import { saveSubscription, saveWorkspace, slackApi, subscriptionView, workspaceView, type ChatProvider, type WorkspaceRow } from '../services/chat.js';
import {
  answerById, guarded, linkTeams, newLinkCode, parseCommand, plainText, runCommand, submitShortForm,
  userByEmail, userByTeamsId, verifySlack, verifyBotToken, verifyTeamsHmac, type Command,
} from '../services/chatInbound.js';
import { CATEGORIES } from '../services/notify.js';

// Chat channels (R3-16): configuration for admins, opt-in per person, and the endpoints
// Slack and Teams call. The endpoints carry no session; every request is signed.

const admin = { roles: ['admin' as const] };

const workspaceInput = z.object({
  enabled: z.boolean(),
  externalId: z.string().trim().max(200).nullable().optional(),
  signingSecret: z.string().trim().max(500).nullable().optional(),
  botToken: z.string().trim().max(500).nullable().optional(),
});

const subscriptionInput = z.object({
  channel: z.enum(['off', 'slack', 'teams']),
  muted: z.array(z.enum(CATEGORIES)).default([]),
  webhookUrl: z.string().trim().max(1000).nullable().optional(),
});

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  org_unit: string | null;
  roles: Role[];
  mfa_enabled: boolean;
  locale: string | null;
}

/** Context of a person found through the chat, with their own rights (no admin shortcut). */
async function personCtx(db: Db, tenantId: string, userId: string): Promise<Ctx> {
  const u = (await db.query<UserRow>('SELECT id, email, display_name, org_unit, roles, mfa_enabled, locale FROM users WHERE id = $1 AND active', [userId])).rows[0];
  const user: SessionUser = {
    id: u.id, tenantId, email: u.email, displayName: u.display_name, orgUnit: u.org_unit, roles: u.roles, mfaEnabled: u.mfa_enabled,
    locale: isLocale(u.locale) ? u.locale : 'de',
  };
  // Roles with a scope (R3-29) apply in the chat as in the portal.
  return buildCtx(db, tenantId, await withScopes(db, user));
}

async function loadWorkspace(id: string, provider: ChatProvider): Promise<WorkspaceRow> {
  if (!z.uuid().safeParse(id).success) throw notFound();
  const w = await withSystem(async (c) =>
    (await c.query<WorkspaceRow>('SELECT id, tenant_id, provider, enabled, external_id, signing_secret_enc, bot_token_enc FROM chat_workspaces WHERE id = $1', [id])).rows[0],
  );
  if (!w || w.provider !== provider || !w.enabled) throw notFound();
  return w;
}

const raw = (req: FastifyRequest) => (typeof req.body === 'string' ? req.body : '');
const header = (req: FastifyRequest, name: string) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

function deny(reply: FastifyReply, verdict: string) {
  return reply.status(401).send({ error: verdict === 'expired' ? 'request expired' : 'invalid signature', code: 'INVALID_SIGNATURE' }); // texts-ok: technical answer to Slack/Teams
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  // --- Admins: workspace configuration (secrets stored encrypted, never returned)
  app.get('/api/admin/chat', tenantHandler(async (ctx) => workspaceView(ctx), admin));

  app.put(
    '/api/admin/chat/:provider',
    tenantHandler(async (ctx, req) => {
      const { provider } = z.object({ provider: z.enum(['slack', 'teams']) }).parse(req.params);
      await saveWorkspace(ctx, provider, workspaceInput.parse(req.body));
      return workspaceView(ctx);
    }, admin),
  );

  // --- Each person: opt-in, categories (same as e-mail, R1-36) and destination
  app.get('/api/me/chat', tenantHandler(async (ctx) => subscriptionView(ctx)));

  app.put(
    '/api/me/chat',
    tenantHandler(async (ctx, req) => {
      const body = subscriptionInput.parse(req.body);
      await saveSubscription(ctx, { ...body, webhookUrl: body.webhookUrl === undefined ? undefined : body.webhookUrl || null });
      await audit(ctx, 'chat.subscription', 'user', ctx.user!.id, null, { channel: body.channel, muted: body.muted });
      return subscriptionView(ctx);
    }),
  );

  app.post('/api/me/chat/link-code', tenantHandler(async (ctx) => newLinkCode(ctx)));

  // --- Endpoints for Slack and Teams: raw body for the signature check
  await app.register(async (scope) => {
    scope.removeContentTypeParser(['application/json']);
    scope.addContentTypeParser(['application/json', 'application/x-www-form-urlencoded'], { parseAs: 'string', bodyLimit: 200_000 }, (_req, body, done) => done(null, body));

    // Slack slash command "/idee …"
    scope.post('/api/integrations/slack/:id/commands', async (req, reply) => {
      const w = await loadWorkspace((req.params as { id: string }).id, 'slack');
      const verdict = await slackVerdict(w, req);
      if (verdict !== 'ok') return deny(reply, verdict);
      const form = new URLSearchParams(raw(req));
      if (w.external_id && form.get('team_id') !== w.external_id) return deny(reply, 'invalid');
      const text = await slackPerson(w, form.get('user_id'), async (ctx, token) => {
        const command = parseCommand(form.get('text') ?? '');
        const trigger = form.get('trigger_id');
        // "/idee" alone opens the short form; "/idee hilfe" shows the help.
        if (!(form.get('text') ?? '').trim() && trigger) {
          await slackApi(token, 'views.open', { trigger_id: trigger, view: submitModal(ctx.locale) });
          return null;
        }
        return runCommand(ctx, command.kind === 'link' ? { kind: 'help' } : command, `${form.get('command') || '/idee'} `);
      });
      return text === null ? reply.status(200).send() : { response_type: 'ephemeral', text };
    });

    // Slack interactivity: "Rückfrage beantworten" button and the two modals
    scope.post('/api/integrations/slack/:id/interactions', async (req, reply) => {
      const w = await loadWorkspace((req.params as { id: string }).id, 'slack');
      const verdict = await slackVerdict(w, req);
      if (verdict !== 'ok') return deny(reply, verdict);
      let payload: SlackPayload;
      try {
        payload = JSON.parse(new URLSearchParams(raw(req)).get('payload') ?? '{}') as SlackPayload;
      } catch {
        return reply.status(400).send();
      }
      if (w.external_id && payload.team?.id !== w.external_id) return deny(reply, 'invalid');
      let response: unknown = null;
      await slackPerson(w, payload.user?.id ?? null, async (ctx, token) => {
        if (payload.type === 'block_actions') {
          const action = payload.actions?.find((a) => a.action_id === 'ip_answer');
          if (action?.value && payload.trigger_id) {
            await slackApi(token, 'views.open', { trigger_id: payload.trigger_id, view: answerModal(ctx.locale, action.value) });
          }
          return null;
        }
        if (payload.type === 'view_submission') {
          const values = payload.view?.state?.values ?? {};
          const val = (block: string) => values[block]?.v?.value ?? '';
          let text: Text | null = null;
          if (payload.view?.callback_id === 'ip_submit') {
            text = await guarded(() => submitShortForm(ctx, { title: val('title'), problem: val('problem'), solution: val('solution') }, '/idee '));
          } else if (payload.view?.callback_id === 'ip_answer' && payload.view.private_metadata) {
            const ideaId = payload.view.private_metadata;
            text = await guarded(() => answerById(ctx, ideaId, val('answer')));
          }
          if (text) response = { response_action: 'update', view: doneModal(ctx.locale, tr(ctx.locale, text)) };
        }
        return null;
      }, (text) => {
        response = payload.type === 'view_submission' ? { response_action: 'update', view: doneModal('de', text) } : { response_type: 'ephemeral', text };
      });
      return response ?? reply.status(200).send();
    });

    // Microsoft Teams: outgoing webhook (HMAC) or bot / message extension (Bot Framework JWT)
    scope.post('/api/integrations/teams/:id/messages', async (req, reply) => {
      const w = await loadWorkspace((req.params as { id: string }).id, 'teams');
      const auth = header(req, 'authorization');
      let mode: 'webhook' | 'bot';
      if (auth?.startsWith('HMAC ')) {
        const verdict = w.signing_secret_enc ? verifyTeamsHmac(await openSecret(null, w.tenant_id, w.signing_secret_enc), auth, raw(req)) : 'invalid';
        if (verdict !== 'ok') return deny(reply, verdict);
        mode = 'webhook';
      } else {
        const verdict = await verifyBotToken(auth, w.external_id);
        if (verdict !== 'ok') return deny(reply, verdict);
        mode = 'bot';
      }
      let activity: TeamsActivity;
      try {
        activity = JSON.parse(raw(req)) as TeamsActivity;
      } catch {
        return reply.status(400).send();
      }
      // A bot cannot answer a plain message in the HTTP response; it only handles the
      // message extension (invoke). Text commands go through the outgoing webhook.
      if (mode === 'bot' && activity.type !== 'invoke') return reply.status(200).send({});
      const text = await teamsActivity(w, activity);
      if (text === null) return reply.status(200).send({});
      if (mode === 'webhook') return { type: 'message', text };
      // Message extension action: the answer is shown in the task dialog.
      return { task: { type: 'message', value: text } };
    });
  });
}

async function slackVerdict(w: WorkspaceRow, req: FastifyRequest) {
  if (!w.signing_secret_enc) return 'invalid';
  return verifySlack(await openSecret(null, w.tenant_id, w.signing_secret_enc), header(req, 'x-slack-request-timestamp'), header(req, 'x-slack-signature'), raw(req));
}

/**
 * Finds the person behind a Slack member: the e-mail address from Slack (users.info, bot
 * token) mapped to an active person of the same tenant. Returns the reply text.
 */
async function slackPerson(
  w: WorkspaceRow,
  slackUserId: string | null,
  fn: (ctx: Ctx, token: string) => Promise<Text | null>,
  onText?: (text: string) => void,
): Promise<string | null> {
  return withTenant(w.tenant_id, async (db) => {
    const finish = (locale: Locale, text: Text | null) => {
      if (text === null) return null;
      const s = tr(locale, text);
      onText?.(s);
      return s;
    };
    if (!w.bot_token_enc) return finish('de', m('chat.needsBotToken'));
    if (!slackUserId) return finish('de', m('chat.unknownPerson'));
    const token = await openSecret(db, w.tenant_id, w.bot_token_enc);
    const cached = await db.query<{ user_id: string }>(
      'SELECT s.user_id FROM chat_subscriptions s JOIN users u ON u.id = s.user_id AND u.active WHERE s.slack_user_id = $1',
      [slackUserId],
    );
    let userId: string | null = cached.rows[0]?.user_id ?? null;
    if (!userId) {
      const info = await slackApi(token, 'users.info', { user: slackUserId }, true);
      const email = info.ok ? (info.user as { profile?: { email?: string } } | undefined)?.profile?.email : undefined;
      userId = await userByEmail(await buildCtx(db, w.tenant_id, null), email);
    }
    if (!userId) return finish('de', m('chat.unknownPerson'));
    const ctx = await personCtx(db, w.tenant_id, userId);
    return finish(ctx.locale, await fn(ctx, token));
  });
}

interface SlackPayload {
  type?: string;
  trigger_id?: string;
  team?: { id?: string };
  user?: { id?: string };
  actions?: { action_id?: string; value?: string }[];
  view?: { callback_id?: string; private_metadata?: string; state?: { values?: Record<string, { v?: { value?: string | null } }> } };
}

interface TeamsActivity {
  type?: string;
  name?: string;
  text?: string;
  from?: { aadObjectId?: string };
  value?: { commandId?: string; data?: Record<string, unknown> };
}

async function teamsActivity(w: WorkspaceRow, activity: TeamsActivity): Promise<string | null> {
  return withTenant(w.tenant_id, async (db) => {
    const sys = await buildCtx(db, w.tenant_id, null);
    const aad = activity.from?.aadObjectId;
    let command: Command;
    if (activity.type === 'invoke' && activity.name === 'composeExtension/submitAction') {
      const d = activity.value?.data ?? {};
      const s = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : '');
      const id = activity.value?.commandId;
      command = id === 'answerQuestion'
        ? { kind: 'answer', number: Number(s('number').replace('#', '')) || null, answer: s('answer') }
        : id === 'link' ? { kind: 'link', code: s('code') } : { kind: 'submit', title: s('title'), problem: s('problem'), solution: s('solution') };
    } else if (activity.type === 'message') {
      command = parseCommand(plainText(activity.text ?? ''));
    } else {
      return null;
    }
    if (command.kind === 'link') {
      const ok = !!aad && (await linkTeams(sys, command.code, aad));
      return tr('de', m(ok ? 'chat.linked' : 'chat.linkInvalid'));
    }
    const userId = await userByTeamsId(sys, aad);
    if (!userId) return tr('de', m('chat.teamsNotLinked'));
    const ctx = await personCtx(db, w.tenant_id, userId);
    return tr(ctx.locale, await runCommand(ctx, command, ''));
  });
}

// ---------------------------------------------------------------- Slack modals

const plain = (text: string) => ({ type: 'plain_text', text });

function input(locale: Locale, block: string, label: 'chat.modal.title' | 'chat.modal.problem' | 'chat.modal.solution' | 'chat.modal.answer', multiline: boolean, max: number, optional = false) {
  return { type: 'input', block_id: block, optional, label: plain(tr(locale, m(label))), element: { type: 'plain_text_input', action_id: 'v', multiline, max_length: max } };
}

function submitModal(locale: Locale) {
  return {
    type: 'modal',
    callback_id: 'ip_submit',
    title: plain(tr(locale, m('chat.modal.submitTitle'))),
    submit: plain(tr(locale, m('chat.modal.send'))),
    close: plain(tr(locale, m('chat.modal.cancel'))),
    blocks: [input(locale, 'title', 'chat.modal.title', false, 140), input(locale, 'problem', 'chat.modal.problem', true, 2900, true), input(locale, 'solution', 'chat.modal.solution', true, 2900, true)],
  };
}

function answerModal(locale: Locale, ideaId: string) {
  return {
    type: 'modal',
    callback_id: 'ip_answer',
    private_metadata: ideaId,
    title: plain(tr(locale, m('chat.modal.answerTitle')).slice(0, 24)),
    submit: plain(tr(locale, m('chat.modal.send'))),
    close: plain(tr(locale, m('chat.modal.cancel'))),
    blocks: [input(locale, 'answer', 'chat.modal.answer', true, 2900)],
  };
}

function doneModal(locale: Locale, text: string) {
  return {
    type: 'modal',
    title: plain(tr(locale, m('chat.modal.submitTitle'))),
    close: plain(tr(locale, m('chat.modal.done'))),
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') } }],
  };
}
