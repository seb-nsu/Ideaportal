import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { checkPublicUrl, publicFetch } from '../ai/providers.js';
import { config } from '../config.js';
import { withSystem, withTenant } from '../db/pool.js';
import { buildCtx, type Ctx } from '../lib/context.js';
import { newToken } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { openSecret, sealSecret } from '../lib/secretbox.js';
import { m, type MessageKey } from '../i18n/index.js';
import { audit } from './audit.js';
import { notifyRoles } from './notify.js';
import { requirePerson } from './apitokens.js';

// Webhooks per tenant (R3-17). Domain events are written into an outbox table
// (webhook_deliveries) in the same transaction as the change; the job loop sends them with an
// HMAC-SHA256 signature and retries with exponential backoff. Confidential ideas leave the
// portal only as id, number and status, never with title or texts.

export const WEBHOOK_EVENTS = ['idea.submitted', 'idea.status_changed', 'idea.gate_decided', 'challenge.phase_changed'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number] | 'webhook.test';

export const MAX_ATTEMPTS = 6;
/** Wait after attempt n (1-based) before the next one: 1 min, 5 min, 30 min, 2 h, 12 h. */
export const BACKOFF_SECONDS = [60, 300, 1800, 7200, 43200];
/** Failed attempts in a row after which a subscription is switched off. */
export const DISABLE_AFTER_FAILURES = 10;
/** Accepted age of a signature on the receiving side (replay window). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;
export const SIGNATURE_HEADER = 'x-ideenportal-signature';
const TIMEOUT_MS = 10_000;
const BATCH = 20;

export const webhookInput = z.object({
  name: z.string().trim().min(2).max(80),
  url: z.url().max(500),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
});
export const webhookUpdate = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  url: z.url().max(500).optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional(),
  active: z.boolean().optional(),
});

// ---------------------------------------------------------------- signature

/** Signature header value: "t=<unix seconds>,v1=<hex HMAC-SHA256 of '<t>.<body>'>". */
export function signPayload(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** Check for receivers (and tests): valid HMAC and a timestamp inside the replay window. */
export function verifySignature(secret: string, header: string, body: string, opts: { now?: number; toleranceSeconds?: number } = {}): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=', 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1) return false;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS)) return false;
  const expected = Buffer.from(signPayload(secret, t, body).split('v1=')[1], 'hex');
  const given = Buffer.from(parts.v1, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// ---------------------------------------------------------------- HTTP sender (injectable)

export interface WebhookRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}
export type WebhookSender = (req: WebhookRequest) => Promise<{ status: number }>;

/** Real sender: no redirects (they could lead into the private network), short timeout. */
const fetchSender: WebhookSender = async (req) => {
  // Pinned to the checked public address, so DNS cannot change between check and connect.
  const res = await publicFetch(req.url, { method: 'POST', headers: req.headers, body: req.body, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  await res.body?.cancel().catch(() => undefined);
  return { status: res.status };
};

let sender: WebhookSender = fetchSender;
/** Tests replace the sender with a fake; no network. Without argument the real sender is restored. */
export function setWebhookSender(s?: WebhookSender): void {
  sender = s ?? fetchSender;
}

/** The sender in use (SIEM forwarding shares it, so tests fake both with setWebhookSender). */
export function currentWebhookSender(): WebhookSender {
  return sender;
}

// ---------------------------------------------------------------- URL check

/** https only, never the private network (reuses the SSRF guard of the source check). */
export async function checkWebhookUrl(raw: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!raw.startsWith('https://')) return { ok: false, reason: 'https' };
  const r = await checkPublicUrl(raw);
  return 'refused' in r ? { ok: false, reason: r.refused } : { ok: true };
}

async function assertWebhookUrl(raw: string): Promise<void> {
  const r = await checkWebhookUrl(raw);
  if (!r.ok) throw badRequest(m(`api.webhookUrl.${r.reason}` as MessageKey), { code: 'WEBHOOK_URL', reason: r.reason });
}

// ---------------------------------------------------------------- events

interface IdeaLike {
  id: string;
  number: number;
  status: string;
  confidential: boolean;
  title?: string;
  topic?: string | null;
  idea_type?: string;
  challenge_id?: string | null;
}

/** Idea part of a payload. Confidential ideas: id, number and status only. Never the texts or the author. */
export function ideaPayload(idea: IdeaLike) {
  const base = { id: idea.id, number: idea.number, status: idea.status, confidential: idea.confidential };
  if (idea.confidential) return base;
  return {
    ...base,
    title: idea.title ?? null,
    topic: idea.topic ?? null,
    ideaType: idea.idea_type ?? null,
    challengeId: idea.challenge_id ?? null,
    url: `${config.publicUrl}/ideen/${idea.id}`,
  };
}

/** Writes the event into the outbox of every active subscription for it (same transaction as the change). */
export async function emitWebhook(ctx: Ctx, event: WebhookEvent, data: Record<string, unknown>, onlySubscription?: string): Promise<number> {
  const subs = await ctx.db.query<{ id: string }>(
    onlySubscription
      ? 'SELECT id FROM webhook_subscriptions WHERE id = $1'
      : 'SELECT id FROM webhook_subscriptions WHERE active AND $1 = ANY(events)',
    [onlySubscription ?? event],
  );
  if (!subs.rowCount) return 0;
  const payload = { id: randomUUID(), type: event, createdAt: new Date().toISOString(), data };
  for (const s of subs.rows) {
    await ctx.db.query('INSERT INTO webhook_deliveries (tenant_id, subscription_id, event, payload) VALUES ($1, $2, $3, $4)', [
      ctx.tenantId, s.id, event, JSON.stringify(payload),
    ]);
  }
  return subs.rowCount;
}

export const emitIdeaEvent = (ctx: Ctx, event: 'idea.submitted' | 'idea.status_changed' | 'idea.gate_decided', idea: IdeaLike, extra: Record<string, unknown> = {}) =>
  emitWebhook(ctx, event, { idea: ideaPayload(idea), ...extra });

// ---------------------------------------------------------------- delivery (job loop)

export interface WebhookRunResult {
  delivered: number;
  retried: number;
  failed: number;
  disabled: number;
}

interface DueRow {
  id: string;
  subscription_id: string;
  event: string;
  payload: unknown;
  attempts: number;
  url: string;
  secret_enc: string;
  name: string;
  failure_count: number;
}

/** Sends due deliveries of the tenant. `now` and `send` can be set by tests. */
export async function processWebhookDeliveries(ctx: Ctx, opts: { now?: Date; send?: WebhookSender } = {}): Promise<WebhookRunResult> {
  const res: WebhookRunResult = { delivered: 0, retried: 0, failed: 0, disabled: 0 };
  const now = opts.now ?? new Date();
  const send = opts.send ?? sender;
  await ctx.db.query(`DELETE FROM webhook_deliveries WHERE status <> 'pending' AND created_at < $1::timestamptz - interval '30 days'`, [now]);
  const due = await ctx.db.query<DueRow>(
    `SELECT d.id, d.subscription_id, d.event, d.payload, d.attempts, s.url, s.secret_enc, s.name, s.failure_count
       FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id = d.subscription_id
      WHERE d.status = 'pending' AND d.next_attempt_at <= $1 AND s.active
      ORDER BY d.next_attempt_at LIMIT $2 FOR UPDATE OF d SKIP LOCKED`,
    [now, BATCH],
  );
  const disabledNow = new Set<string>();
  for (const d of due.rows) {
    if (disabledNow.has(d.subscription_id)) continue;
    const body = JSON.stringify(d.payload);
    let status: number | null = null;
    let error: string | null = null;
    const guard = await checkWebhookUrl(d.url);
    if (!guard.ok) {
      error = `url_refused:${guard.reason}`;
    } else {
      try {
        const ts = Math.floor(now.getTime() / 1000);
        const r = await send({
          url: d.url,
          body,
          headers: {
            'content-type': 'application/json',
            'user-agent': 'Ideenportal-Webhooks/1',
            'x-ideenportal-event': d.event,
            'x-ideenportal-delivery': d.id,
            [SIGNATURE_HEADER]: signPayload(await openSecret(ctx.db, ctx.tenantId, d.secret_enc), ts, body),
          },
        });
        status = r.status;
        if (r.status < 200 || r.status >= 300) error = `http_${r.status}`;
      } catch (err) {
        error = (err as Error).name === 'TimeoutError' ? 'timeout' : 'network';
      }
    }
    const attempts = d.attempts + 1;
    if (!error) {
      await ctx.db.query(
        `UPDATE webhook_deliveries SET status = 'delivered', attempts = $2, last_attempt_at = $3, delivered_at = $3, response_status = $4, error = NULL WHERE id = $1`,
        [d.id, attempts, now, status],
      );
      await ctx.db.query('UPDATE webhook_subscriptions SET failure_count = 0, last_success_at = $2 WHERE id = $1', [d.subscription_id, now]);
      res.delivered++;
      continue;
    }
    const final = attempts >= MAX_ATTEMPTS;
    const next = new Date(now.getTime() + (BACKOFF_SECONDS[attempts - 1] ?? BACKOFF_SECONDS.at(-1)!) * 1000);
    await ctx.db.query(
      `UPDATE webhook_deliveries SET status = $2, attempts = $3, last_attempt_at = $4, next_attempt_at = $5, response_status = $6, error = $7 WHERE id = $1`,
      [d.id, final ? 'failed' : 'pending', attempts, now, next, status, error],
    );
    if (final) res.failed++;
    else res.retried++;
    const sub = (await ctx.db.query<{ failure_count: number }>(
      'UPDATE webhook_subscriptions SET failure_count = failure_count + 1, last_failure_at = $2 WHERE id = $1 RETURNING failure_count',
      [d.subscription_id, now],
    )).rows[0];
    if (sub.failure_count >= DISABLE_AFTER_FAILURES) {
      await disableSubscription(ctx, d.subscription_id, d.name, d.url, sub.failure_count);
      disabledNow.add(d.subscription_id);
      res.disabled++;
    }
  }
  return res;
}

async function disableSubscription(ctx: Ctx, id: string, name: string, url: string, failures: number): Promise<void> {
  await ctx.db.query(
    `UPDATE webhook_subscriptions SET active = false, disabled_at = now(), disabled_reason = 'failures' WHERE id = $1`,
    [id],
  );
  await ctx.db.query(
    `UPDATE webhook_deliveries SET status = 'failed', error = coalesce(error, 'subscription_disabled') WHERE subscription_id = $1 AND status = 'pending'`,
    [id],
  );
  await audit(ctx, 'webhook.disabled', 'webhook', id, null, { failures });
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  await notifyRoles(ctx, ['admin'], m('api.webhookDisabled.subject', { name }), m('api.webhookDisabled.body', { name, host, n: failures }));
}

/** Short delivery loop of the server (main.ts): every tenant with due deliveries. */
export async function runWebhookDeliveries(): Promise<number> {
  const tenants = await withSystem(async (c) =>
    (await c.query<{ tenant_id: string }>(
      `SELECT DISTINCT d.tenant_id FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id = d.subscription_id
        WHERE d.status = 'pending' AND d.next_attempt_at <= now() AND s.active
          AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = d.tenant_id AND t.status = 'active')`,
    )).rows,
  );
  let sent = 0;
  for (const t of tenants) {
    const r = await withTenant(t.tenant_id, async (db) => processWebhookDeliveries(await buildCtx(db, t.tenant_id, null)));
    sent += r.delivered;
  }
  return sent;
}

// ---------------------------------------------------------------- management (admins)

const newSecret = () => `whsec_${newToken()}`;

export async function createWebhook(ctx: Ctx, input: z.infer<typeof webhookInput>) {
  requirePerson(ctx);
  await assertWebhookUrl(input.url);
  const secret = newSecret();
  const r = await ctx.db.query<{ id: string }>(
    'INSERT INTO webhook_subscriptions (tenant_id, name, url, events, secret_enc, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [ctx.tenantId, input.name, input.url, Array.from(new Set(input.events)), await sealSecret(ctx.db, ctx.tenantId, secret), ctx.user!.id],
  );
  await audit(ctx, 'webhook.create', 'webhook', r.rows[0].id, null, input);
  return { id: r.rows[0].id, secret };
}

export async function listWebhooks(ctx: Ctx) {
  const r = await ctx.db.query(
    `SELECT s.id, s.name, s.url, s.events, s.active, s.failure_count AS "failureCount", s.disabled_at AS "disabledAt",
            s.disabled_reason AS "disabledReason", s.last_success_at AS "lastSuccessAt", s.last_failure_at AS "lastFailureAt",
            s.created_at AS "createdAt",
            (SELECT count(*)::int FROM webhook_deliveries d WHERE d.subscription_id = s.id AND d.status = 'pending') AS pending
       FROM webhook_subscriptions s ORDER BY s.created_at DESC`,
  );
  return r.rows;
}

async function loadWebhook(ctx: Ctx, id: string) {
  const r = await ctx.db.query<{ id: string; name: string; url: string; events: string[]; active: boolean }>(
    'SELECT id, name, url, events, active FROM webhook_subscriptions WHERE id = $1 FOR UPDATE',
    [id],
  );
  if (!r.rows[0]) throw notFound(m('api.webhookNotFound'));
  return r.rows[0];
}

export async function updateWebhook(ctx: Ctx, id: string, input: z.infer<typeof webhookUpdate>): Promise<void> {
  requirePerson(ctx);
  const before = await loadWebhook(ctx, id);
  if (input.url) await assertWebhookUrl(input.url);
  const after = {
    name: input.name ?? before.name,
    url: input.url ?? before.url,
    events: input.events ? Array.from(new Set(input.events)) : before.events,
    active: input.active ?? before.active,
  };
  await ctx.db.query(
    `UPDATE webhook_subscriptions SET name = $2, url = $3, events = $4, active = $5,
            failure_count = CASE WHEN $5 AND NOT active THEN 0 ELSE failure_count END,
            disabled_at = CASE WHEN $5 THEN NULL WHEN active THEN now() ELSE disabled_at END,
            disabled_reason = CASE WHEN $5 THEN NULL WHEN active THEN 'manual' ELSE disabled_reason END
      WHERE id = $1`,
    [id, after.name, after.url, after.events, after.active],
  );
  if (!after.active) {
    await ctx.db.query(`UPDATE webhook_deliveries SET status = 'failed', error = 'subscription_disabled' WHERE subscription_id = $1 AND status = 'pending'`, [id]);
  }
  await audit(ctx, 'webhook.update', 'webhook', id, before, after);
}

export async function rotateWebhookSecret(ctx: Ctx, id: string): Promise<{ secret: string }> {
  requirePerson(ctx);
  await loadWebhook(ctx, id);
  const secret = newSecret();
  await ctx.db.query('UPDATE webhook_subscriptions SET secret_enc = $2 WHERE id = $1', [id, await sealSecret(ctx.db, ctx.tenantId, secret)]);
  await audit(ctx, 'webhook.rotate_secret', 'webhook', id, null, null);
  return { secret };
}

export async function deleteWebhook(ctx: Ctx, id: string): Promise<void> {
  requirePerson(ctx);
  const before = await loadWebhook(ctx, id);
  await ctx.db.query('DELETE FROM webhook_subscriptions WHERE id = $1', [id]);
  await audit(ctx, 'webhook.delete', 'webhook', id, before, null);
}

/** Test event to one subscription, delivered with the next run. */
export async function testWebhook(ctx: Ctx, id: string): Promise<void> {
  requirePerson(ctx);
  const w = await loadWebhook(ctx, id);
  if (!w.active) throw badRequest(m('api.webhookInactive'));
  await emitWebhook(ctx, 'webhook.test', { message: 'test' }, id);
}

export async function listDeliveries(ctx: Ctx, id: string) {
  await loadWebhook(ctx, id);
  const r = await ctx.db.query(
    `SELECT id, event, status, attempts, response_status AS "responseStatus", error, created_at AS "createdAt",
            last_attempt_at AS "lastAttemptAt", next_attempt_at AS "nextAttemptAt", delivered_at AS "deliveredAt"
       FROM webhook_deliveries WHERE subscription_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [id],
  );
  return r.rows;
}
