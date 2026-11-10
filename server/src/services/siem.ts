import { z } from 'zod';
import { withSystem, withTenant } from '../db/pool.js';
import { buildCtx, type Ctx } from '../lib/context.js';
import { newToken } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { siemBatches } from '../lib/prometheus.js';
import { openSecret, sealSecret } from '../lib/secretbox.js';
import { m, type MessageKey } from '../i18n/index.js';
import { audit } from './audit.js';
import { notifyRoles } from './notify.js';
import { requirePerson } from './apitokens.js';
import {
  BACKOFF_SECONDS,
  DISABLE_AFTER_FAILURES,
  SIGNATURE_HEADER,
  checkWebhookUrl,
  currentWebhookSender,
  signPayload,
  type WebhookSender,
} from './webhooks.js';

// SIEM forwarding of the audit log (enterprise security). One https target per tenant gets the
// audit rows in batches, oldest first, signed like webhooks (HMAC-SHA256 over "<t>.<body>").
// The position (forwarded_seq) only moves after a 2xx answer, so no row is lost: a failing
// target is retried with backoff (1 min … 12 h) and the admins are told once after 10 failures.
// Every event carries its hash-chain values (seq, prevHash, rowHash, canonical), so the
// receiver can check the chain and holds an external copy of the hashes.

export const SIEM_BATCH = 500;
export const SIEM_EVENT = 'audit.batch';

export const siemInput = z.object({
  url: z.url().max(500),
  active: z.boolean().default(true),
  /** true: send the whole existing log first; false: start with the next entry. */
  backfill: z.boolean().default(false),
});
export const siemUpdate = z.object({ url: z.url().max(500).optional(), active: z.boolean().optional() });

const newSecret = () => `siemsec_${newToken()}`;

async function assertUrl(raw: string): Promise<void> {
  const r = await checkWebhookUrl(raw);
  if (!r.ok) throw badRequest(m(`api.webhookUrl.${r.reason}` as MessageKey), { code: 'WEBHOOK_URL', reason: r.reason });
}

interface SiemRow {
  url: string;
  active: boolean;
  forwarded_seq: number;
  failure_count: number;
  next_attempt_at: Date;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  last_error: string | null;
}

export async function getSiem(ctx: Ctx) {
  const r = (
    await ctx.db.query<SiemRow>(
      'SELECT url, active, forwarded_seq, failure_count, next_attempt_at, last_success_at, last_failure_at, last_error FROM siem_settings',
    )
  ).rows[0];
  if (!r) return null;
  const head = (await ctx.db.query<{ last_seq: number }>('SELECT last_seq FROM audit_chain_heads WHERE tenant_id = $1', [ctx.tenantId])).rows[0];
  return {
    url: r.url,
    active: r.active,
    forwardedSeq: r.forwarded_seq,
    pending: Math.max(0, (head?.last_seq ?? 0) - r.forwarded_seq),
    failureCount: r.failure_count,
    nextAttemptAt: r.next_attempt_at,
    lastSuccessAt: r.last_success_at,
    lastFailureAt: r.last_failure_at,
    lastError: r.last_error,
  };
}

/** Creates or replaces the target; returns the signing secret once. */
export async function saveSiem(ctx: Ctx, input: z.infer<typeof siemInput>): Promise<{ secret: string }> {
  requirePerson(ctx);
  await assertUrl(input.url);
  const secret = newSecret();
  const head = (await ctx.db.query<{ last_seq: number }>('SELECT last_seq FROM audit_chain_heads WHERE tenant_id = $1', [ctx.tenantId])).rows[0];
  const start = input.backfill ? 0 : (head?.last_seq ?? 0);
  await ctx.db.query(
    `INSERT INTO siem_settings (tenant_id, url, secret_enc, active, forwarded_seq, created_by) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id) DO UPDATE SET url = EXCLUDED.url, secret_enc = EXCLUDED.secret_enc, active = EXCLUDED.active,
       forwarded_seq = EXCLUDED.forwarded_seq, failure_count = 0, next_attempt_at = now(), last_error = NULL, updated_at = now()`,
    [ctx.tenantId, input.url, await sealSecret(ctx.db, ctx.tenantId, secret), input.active, start, ctx.user!.id],
  );
  await audit(ctx, 'siem.save', 'siem', ctx.tenantId, null, { url: input.url, active: input.active, backfill: input.backfill });
  return { secret };
}

export async function updateSiem(ctx: Ctx, input: z.infer<typeof siemUpdate>): Promise<void> {
  requirePerson(ctx);
  const before = (await ctx.db.query<{ url: string; active: boolean }>('SELECT url, active FROM siem_settings FOR UPDATE')).rows[0];
  if (!before) throw notFound(m('security.siem.notFound'));
  if (input.url) await assertUrl(input.url);
  const after = { url: input.url ?? before.url, active: input.active ?? before.active };
  await ctx.db.query(
    `UPDATE siem_settings SET url = $2, active = $3, updated_at = now(),
            failure_count = CASE WHEN $3 AND NOT active THEN 0 ELSE failure_count END,
            next_attempt_at = CASE WHEN $3 AND NOT active THEN now() ELSE next_attempt_at END
      WHERE tenant_id = $1`,
    [ctx.tenantId, after.url, after.active],
  );
  await audit(ctx, 'siem.update', 'siem', ctx.tenantId, before, after);
}

export async function rotateSiemSecret(ctx: Ctx): Promise<{ secret: string }> {
  requirePerson(ctx);
  const secret = newSecret();
  const r = await ctx.db.query('UPDATE siem_settings SET secret_enc = $1, updated_at = now() WHERE tenant_id = $2', [
    await sealSecret(ctx.db, ctx.tenantId, secret),
    ctx.tenantId,
  ]);
  if (!r.rowCount) throw notFound(m('security.siem.notFound'));
  await audit(ctx, 'siem.rotate_secret', 'siem', ctx.tenantId, null, null);
  return { secret };
}

export async function deleteSiem(ctx: Ctx): Promise<void> {
  requirePerson(ctx);
  const r = await ctx.db.query('DELETE FROM siem_settings WHERE tenant_id = $1 RETURNING url', [ctx.tenantId]);
  if (!r.rowCount) throw notFound(m('security.siem.notFound'));
  await audit(ctx, 'siem.delete', 'siem', ctx.tenantId, { url: r.rows[0].url }, null);
}

// ---------------------------------------------------------------- delivery

export interface SiemRunResult {
  sent: number;
  failed: boolean;
}

/** Sends due batches of the tenant (at most maxBatches per run). `now` and `send` can be set by tests. */
export async function forwardSiem(ctx: Ctx, opts: { now?: Date; send?: WebhookSender; maxBatches?: number } = {}): Promise<SiemRunResult> {
  const total: SiemRunResult = { sent: 0, failed: false };
  for (let i = 0; i < (opts.maxBatches ?? 10); i++) {
    const r = await forwardBatch(ctx, opts);
    total.sent += r.sent;
    total.failed = r.failed;
    if (r.failed || r.sent < SIEM_BATCH) break;
  }
  return total;
}

async function forwardBatch(ctx: Ctx, opts: { now?: Date; send?: WebhookSender }): Promise<SiemRunResult> {
  const now = opts.now ?? new Date();
  const send = opts.send ?? currentWebhookSender();
  // The job loop and the short delivery loop may run at the same time: one of them wins the row.
  const cfg = (
    await ctx.db.query<SiemRow & { secret_enc: string }>(
      `SELECT url, secret_enc, active, forwarded_seq, failure_count, next_attempt_at FROM siem_settings
      WHERE active AND next_attempt_at <= $1 FOR UPDATE SKIP LOCKED`,
      [now],
    )
  ).rows[0];
  if (!cfg) return { sent: 0, failed: false };
  const rows = (
    await ctx.db.query<Record<string, unknown> & { seq: number }>(
      `SELECT a.chain_seq AS seq, a.id, to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
            a.actor_id AS "actorId", u.email AS "actorEmail", a.action, a.entity, a.entity_id AS "entityId", a.before, a.after,
            a.ip_hash AS "ipHash", a.user_agent AS "userAgent", a.request_id AS "requestId",
            a.prev_hash AS "prevHash", a.row_hash AS "rowHash", audit_canonical(a) AS canonical
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.chain_seq > $1 ORDER BY a.chain_seq LIMIT $2`,
      [cfg.forwarded_seq, SIEM_BATCH],
    )
  ).rows;
  if (!rows.length) return { sent: 0, failed: false };
  const first = rows[0].seq;
  const last = rows[rows.length - 1].seq;
  const body = JSON.stringify({ type: SIEM_EVENT, tenantId: ctx.tenantId, sentAt: now.toISOString(), fromSeq: first, toSeq: last, events: rows });
  let error: string | null = null;
  const guard = await checkWebhookUrl(cfg.url);
  if (!guard.ok) error = `url_refused:${guard.reason}`;
  else {
    try {
      const r = await send({
        url: cfg.url,
        body,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Ideenportal-SIEM/1',
          'x-ideenportal-event': SIEM_EVENT,
          // Same id for a repeated batch: receivers can drop duplicates.
          'x-ideenportal-delivery': `${ctx.tenantId}:${first}-${last}`,
          [SIGNATURE_HEADER]: signPayload(await openSecret(ctx.db, ctx.tenantId, cfg.secret_enc), Math.floor(now.getTime() / 1000), body),
        },
      });
      if (r.status < 200 || r.status >= 300) error = `http_${r.status}`;
    } catch (err) {
      error = (err as Error).name === 'TimeoutError' ? 'timeout' : 'network';
    }
  }
  if (!error) {
    await ctx.db.query(
      'UPDATE siem_settings SET forwarded_seq = $2, failure_count = 0, last_success_at = $3, last_error = NULL, next_attempt_at = $3 WHERE tenant_id = $1',
      [ctx.tenantId, last, now],
    );
    siemBatches.inc({ outcome: 'ok' });
    return { sent: rows.length, failed: false };
  }
  const failures = cfg.failure_count + 1;
  const next = new Date(now.getTime() + BACKOFF_SECONDS[Math.min(failures, BACKOFF_SECONDS.length) - 1] * 1000);
  await ctx.db.query('UPDATE siem_settings SET failure_count = $2, last_failure_at = $3, last_error = $4, next_attempt_at = $5 WHERE tenant_id = $1', [
    ctx.tenantId,
    failures,
    now,
    error,
    next,
  ]);
  siemBatches.inc({ outcome: 'failed' });
  if (failures === DISABLE_AFTER_FAILURES) {
    let host = cfg.url;
    try {
      host = new URL(cfg.url).host;
    } catch {
      // keep the stored value
    }
    await notifyRoles(ctx, ['admin'], m('security.siem.failingSubject'), m('security.siem.failingBody', { host, n: failures }));
  }
  return { sent: 0, failed: true };
}

/** Short delivery loop (main.ts): every tenant with a due SIEM target and new rows. */
export async function runSiemForwarding(): Promise<number> {
  const tenants = await withSystem(
    async (c) =>
      (
        await c.query<{ tenant_id: string }>(
          `SELECT s.tenant_id FROM siem_settings s JOIN audit_chain_heads h ON h.tenant_id = s.tenant_id
        WHERE s.active AND s.next_attempt_at <= now() AND h.last_seq > s.forwarded_seq`,
        )
      ).rows,
  );
  let sent = 0;
  for (const t of tenants) {
    const r = await withTenant(t.tenant_id, async (db) => forwardSiem(await buildCtx(db, t.tenant_id, null)));
    sent += r.sent;
  }
  return sent;
}
