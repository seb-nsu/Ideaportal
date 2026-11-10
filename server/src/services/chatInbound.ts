import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature, type webcrypto } from 'node:crypto';
import { ZodError } from 'zod';
import { config } from '../config.js';
import { m, tr, type Locale, type Text } from '../i18n/index.js';
import { checkBoundary } from '../lib/boundary.js';
import type { Ctx } from '../lib/context.js';
import { sha256 } from '../lib/crypto.js';
import { HttpError } from '../lib/errors.js';
import { answerQuestion, createIdea, ideaInput, loadIdea } from './workflow.js';
import { chatHttp } from './chat.js';

type JsonWebKey = webcrypto.JsonWebKey;

// Incoming requests from Slack and Microsoft Teams (R3-16). Every request is verified
// before anything is read: Slack with its signing secret (v0, 5-minute window), Teams either
// as an outgoing webhook (HMAC-SHA256 with the security token) or as a bot / message
// extension (Bot Framework JWT). Commands call the same service functions as the API.

export type Verdict = 'ok' | 'invalid' | 'expired';

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Slack request signing: v0=HMAC-SHA256(secret, "v0:{timestamp}:{raw body}"), at most 5 minutes old. */
export function verifySlack(secret: string, timestamp: string | undefined, signature: string | undefined, rawBody: string, nowSeconds = Math.floor(Date.now() / 1000)): Verdict {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return 'invalid';
  if (Math.abs(nowSeconds - Number(timestamp)) > 300) return 'expired';
  const expected = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
  return safeEqual(expected, signature) ? 'ok' : 'invalid';
}

export function slackSignature(secret: string, timestamp: string, rawBody: string): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
}

/** Teams outgoing webhook: "Authorization: HMAC base64(HMAC-SHA256(base64-decoded token, raw body))". */
export function verifyTeamsHmac(securityToken: string, authorization: string | undefined, rawBody: string): Verdict {
  if (!authorization?.startsWith('HMAC ')) return 'invalid';
  const expected = createHmac('sha256', Buffer.from(securityToken, 'base64')).update(rawBody, 'utf8').digest('base64');
  return safeEqual(expected, authorization.slice(5).trim()) ? 'ok' : 'invalid';
}

// ---------------------------------------------------------------- Bot Framework JWT

export interface Jwk extends JsonWebKey {
  kid?: string;
  endorsements?: string[];
}
export type JwksSource = (refresh: boolean) => Promise<Jwk[]>;

const BOT_ISSUER = 'https://api.botframework.com';
const OPENID_CONFIG = 'https://login.botframework.com/v1/.well-known/openidconfiguration';
let cache: { keys: Jwk[]; at: number } | null = null;

const fetchJwks: JwksSource = async (refresh) => {
  if (cache && !refresh && Date.now() - cache.at < 24 * 3600_000) return cache.keys;
  const meta = (await chatHttp({ method: 'GET', url: OPENID_CONFIG })).body as { jwks_uri?: string };
  if (!meta?.jwks_uri?.startsWith('https://')) throw new Error('no jwks_uri');
  const keys = ((await chatHttp({ method: 'GET', url: meta.jwks_uri })).body as { keys?: Jwk[] })?.keys ?? [];
  cache = { keys, at: Date.now() };
  return keys;
};
let jwks: JwksSource = fetchJwks;

/** Replaces the key source (tests); returns the previous one. */
export function setJwksSource(source: JwksSource): JwksSource {
  const prev = jwks;
  jwks = source;
  return prev;
}

const b64json = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Record<string, unknown>;

/**
 * Checks a Bot Framework token: RS256 signature with a published key (endorsed for Teams),
 * issuer, audience (the bot's Microsoft app id), expiry and not-before with 5 minutes skew.
 */
export async function verifyBotToken(authorization: string | undefined, appId: string | null, nowMs = Date.now()): Promise<Verdict> {
  if (!appId || !authorization?.startsWith('Bearer ')) return 'invalid';
  const parts = authorization.slice(7).trim().split('.');
  if (parts.length !== 3) return 'invalid';
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = b64json(parts[0]);
    claims = b64json(parts[1]);
  } catch {
    return 'invalid';
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return 'invalid';
  let key = (await jwks(false)).find((k) => k.kid === header.kid);
  if (!key) key = (await jwks(true)).find((k) => k.kid === header.kid);
  if (!key || (key.endorsements && !key.endorsements.includes('msteams'))) return 'invalid';
  let ok = false;
  try {
    const { kid: _kid, endorsements: _e, ...jwk } = key;
    ok = verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  } catch {
    return 'invalid';
  }
  if (!ok || claims.iss !== BOT_ISSUER || claims.aud !== appId) return 'invalid';
  const skew = 300_000;
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < nowMs - skew) return 'expired';
  if (typeof claims.nbf === 'number' && claims.nbf * 1000 > nowMs + skew) return 'invalid';
  return 'ok';
}

// ---------------------------------------------------------------- identity

/** Active person with this e-mail address in the tenant of the request (RLS keeps other tenants out). */
export async function userByEmail(ctx: Ctx, email: string | undefined | null): Promise<string | null> {
  if (!email) return null;
  const r = await ctx.db.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = lower($1) AND active', [email.trim()]);
  return r.rows[0]?.id ?? null;
}

export async function userByTeamsId(ctx: Ctx, aadObjectId: string | undefined | null): Promise<string | null> {
  if (!aadObjectId) return null;
  const r = await ctx.db.query<{ user_id: string }>(
    'SELECT s.user_id FROM chat_subscriptions s JOIN users u ON u.id = s.user_id AND u.active WHERE s.teams_aad_id = $1',
    [aadObjectId],
  );
  return r.rows[0]?.user_id ?? null;
}

/** One-time code (10 minutes) that links a Teams account to the person in the portal. */
export async function newLinkCode(ctx: Ctx): Promise<{ code: string; expiresAt: string }> {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  const code = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  const expires = new Date(Date.now() + 10 * 60_000);
  await ctx.db.query(
    `INSERT INTO chat_subscriptions (user_id, tenant_id, link_code_hash, link_code_expires_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET link_code_hash = EXCLUDED.link_code_hash, link_code_expires_at = EXCLUDED.link_code_expires_at`,
    [ctx.user!.id, ctx.tenantId, sha256(code), expires],
  );
  return { code, expiresAt: expires.toISOString() };
}

export async function linkTeams(ctx: Ctx, code: string, aadObjectId: string): Promise<boolean> {
  const r = await ctx.db.query<{ user_id: string }>(
    'SELECT user_id FROM chat_subscriptions WHERE link_code_hash = $1 AND link_code_expires_at > now() FOR UPDATE',
    [sha256(code.trim().toUpperCase())],
  );
  const userId = r.rows[0]?.user_id;
  if (!userId) return false;
  // One Teams account belongs to one person: an older link moves to the new person.
  await ctx.db.query('UPDATE chat_subscriptions SET teams_aad_id = NULL WHERE teams_aad_id = $1 AND user_id <> $2', [aadObjectId, userId]);
  await ctx.db.query('UPDATE chat_subscriptions SET teams_aad_id = $2, link_code_hash = NULL, link_code_expires_at = NULL WHERE user_id = $1', [userId, aadObjectId]);
  return true;
}

// ---------------------------------------------------------------- commands

export type Command =
  | { kind: 'help' }
  | { kind: 'submit'; title: string; problem: string; solution: string }
  | { kind: 'answer'; number: number | null; answer: string }
  | { kind: 'link'; code: string };

/** Teams sends "<at>Ideenportal</at> text" with HTML; plain text is enough here. */
export function plainText(s: string): string {
  return s
    .replace(/<at>.*?<\/at>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

export function parseCommand(input: string): Command {
  const text = input.trim();
  if (!text || /^(hilfe|help|\?)$/i.test(text)) return { kind: 'help' };
  const answer = text.match(/^(?:antwort|answer|antworten)\b\s*(?:#?(\d+))?\s*([\s\S]*)$/i);
  if (answer) return { kind: 'answer', number: answer[1] ? Number(answer[1]) : null, answer: answer[2].trim() };
  const link = text.match(/^(?:verbinden|link)\s+([A-Za-z0-9]{4,16})$/i);
  if (link) return { kind: 'link', code: link[1] };
  const body = text.replace(/^(?:einreichen|submit|idee|idea)\b\s*:?\s*/i, '');
  const [title = '', problem = '', ...rest] = body.split('|').map((p) => p.trim());
  return { kind: 'submit', title, problem, solution: rest.join(' | ') };
}

/** Short form (title, problem, solution): creates a draft through the same service as POST /api/ideas. */
export async function submitShortForm(ctx: Ctx, form: { title: string; problem: string; solution: string }, cmd: string): Promise<Text> {
  let input;
  try {
    input = ideaInput.parse({ title: form.title, problem: form.problem, solution: form.solution });
  } catch (err) {
    if (err instanceof ZodError) return m('chat.shortFormInvalid', { cmd });
    throw err;
  }
  const idea = await createIdea(ctx, input);
  const parts: Text[] = [m('chat.draftCreated', { number: idea.number, url: `${config.publicUrl}/einreichen/${idea.id}` })];
  // The boundary check runs locally; the reply never repeats the text (no report texts in chats).
  const matches = checkBoundary(`${input.title} ${input.problem} ${input.solution}`, ctx.settings);
  if (matches.length) {
    const labels = [...new Set(matches.map((x) => x.label))].join(', ');
    const channels = [...new Set(matches.flatMap((x) => (x.channel ? [`${x.channel.name} (${x.channel.contact || x.channel.url})`] : [])))].join(', ');
    parts.push(channels ? m('chat.boundary', { labels, channels }) : m('chat.boundaryNoChannel', { labels }));
  }
  return { parts, sep: '\n\n' };
}

export async function answerByNumber(ctx: Ctx, number: number, answer: string): Promise<Text> {
  const r = await ctx.db.query<{ id: string }>('SELECT id FROM ideas WHERE number = $1', [number]);
  if (!r.rows[0]) return m('chat.ideaNotFound', { number });
  const idea = await loadIdea(ctx, r.rows[0].id, true);
  await answerQuestion(ctx, idea, answer.slice(0, 3000));
  return m('chat.answered', { number });
}

export async function answerById(ctx: Ctx, ideaId: string, answer: string): Promise<Text> {
  if (!/^[0-9a-f-]{36}$/i.test(ideaId)) return m('chat.ideaNotFound', { number: '?' });
  const idea = await loadIdea(ctx, ideaId, true);
  await answerQuestion(ctx, idea, answer.slice(0, 3000));
  return m('chat.answered', { number: idea.number });
}

/** Runs a command for a known person. Service errors become a readable reply. */
export async function runCommand(ctx: Ctx, command: Command, cmd: string): Promise<Text> {
  return guarded(async () => {
    switch (command.kind) {
      case 'help':
        return m('chat.help', { cmd });
      case 'submit':
        return submitShortForm(ctx, command, cmd);
      case 'answer':
        if (command.number == null || command.answer.length < 2) return m('chat.answerUsage', { cmd });
        return answerByNumber(ctx, command.number, command.answer);
      case 'link':
        return m('chat.help', { cmd });
    }
  });
}

export async function guarded(fn: () => Promise<Text>): Promise<Text> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) return errorText(err.text);
    throw err;
  }
}

const errorText = (text: Text): Text => ({ parts: [m('chat.error', { error: '' }), text], sep: '' });

export const reply = (locale: Locale, text: Text) => tr(locale, text);
