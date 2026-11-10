import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { getPool, withSystem, type Db } from '../db/pool.js';
import type { SessionUser } from '../lib/context.js';
import { sha256 } from '../lib/crypto.js';
import { HttpError, badRequest, conflict, notFound } from '../lib/errors.js';
import { m } from '../i18n/index.js';
import { operatorLog, type Operator } from './operator.js';

// Tenant lifecycle (enterprise): suspend and resume by the operator, offboarding with a grace
// period (requested by an admin with re-authentication or by the operator), cancellation during
// the grace period, final purge by the job with a proof of deletion outside the tenant.
//
// Effects of the status:
//  - suspended: no sign-in (trigger on sessions), every request of people, API tokens and SCIM
//    is refused with a clear message, jobs and the AI worker skip the tenant.
//  - deleting: only admins may sign in; they can read, export the data and cancel the
//    deletion. Everyone else is refused. Jobs and the AI worker skip the tenant; the export
//    worker still runs for it.
// The trial read-only mode (services/billing.ts) is independent of this status.

export const TENANT_STATUSES = ['active', 'suspended', 'deleting'] as const;
export type TenantStatusValue = (typeof TENANT_STATUSES)[number];

export interface Lifecycle {
  status: TenantStatusValue;
  suspendedAt: Date | null;
  suspendedReason: string | null;
  deletionRequestedAt: Date | null;
  deletionRequestedBy: string | null;
  deleteAfter: Date | null;
}

export async function tenantLifecycle(tenantId: string, db?: Db): Promise<Lifecycle | null> {
  const q = db ?? getPool();
  return (
    (
      await q.query<Lifecycle>(
        `SELECT status, suspended_at AS "suspendedAt", suspended_reason AS "suspendedReason", deletion_requested_at AS "deletionRequestedAt",
            deletion_requested_by AS "deletionRequestedBy", delete_after AS "deleteAfter"
       FROM tenants WHERE id = $1`,
        [tenantId],
      )
    ).rows[0] ?? null
  );
}

export const suspendedError = () => new HttpError(403, m('tenantlc.suspended'), 'TENANT_SUSPENDED');
export const deletingError = () => new HttpError(403, m('tenantlc.deleting'), 'TENANT_DELETING');

/** Error for the triggers on sessions (SQLSTATE IPT01/IPT02), see migration 032. */
export function lifecycleDbError(err: unknown): HttpError | null {
  const code = (err as { code?: string } | null)?.code;
  if (code === 'IPT01') return suspendedError();
  if (code === 'IPT02') return deletingError();
  return null;
}

// While a tenant is being deleted, its admins may still use these (besides reading).
const DELETING_OPEN = ['/api/auth/', '/api/admin/workspace/delete/cancel', '/api/admin/exports'];
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Request guard, called for every authenticated request (services/billing.ts enforcePlan). */
export async function enforceTenantStatus(req: FastifyRequest, user: SessionUser): Promise<void> {
  const r = await getPool().query<{ status: TenantStatusValue }>('SELECT status FROM tenants WHERE id = $1', [user.tenantId]);
  const status = r.rows[0]?.status ?? 'active';
  if (status === 'active') return;
  if (status === 'suspended') throw suspendedError();
  const path = req.url.split('?')[0];
  if (user.technical || !user.roles.includes('admin')) throw deletingError();
  if (SAFE.has(req.method) || DELETING_OPEN.some((p) => path.startsWith(p))) return;
  throw new HttpError(403, m('tenantlc.deletingReadOnly'), 'TENANT_DELETING');
}

/** For token-based entry points without a person (SCIM): true when the tenant may be used. */
export async function tenantUsable(tenantId: string): Promise<boolean> {
  const r = await getPool().query<{ status: TenantStatusValue }>('SELECT status FROM tenants WHERE id = $1', [tenantId]);
  return (r.rows[0]?.status ?? 'active') === 'active';
}

async function tenantAudit(c: Db, tenantId: string, actorId: string | null, action: string, before: unknown, after: unknown) {
  await c.query('INSERT INTO audit_log (tenant_id, actor_id, action, entity, entity_id, before, after) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
    tenantId,
    actorId,
    action,
    'tenant',
    tenantId,
    before == null ? null : JSON.stringify(before),
    after == null ? null : JSON.stringify(after),
  ]);
}

async function lockTenant(c: Db, tenantId: string) {
  const t = (
    await c.query<{ status: TenantStatusValue; slug: string; suspended_at: Date | null }>(
      'SELECT status, slug, suspended_at FROM tenants WHERE id = $1 FOR UPDATE',
      [tenantId],
    )
  ).rows[0];
  if (!t) throw notFound(m('saas.tenantNotFound'));
  return t;
}

// ---------------------------------------------------------------- suspend / resume (operator)

export async function suspendTenant(op: Operator, tenantId: string, reason: string): Promise<void> {
  await withSystem(async (c) => {
    const t = await lockTenant(c, tenantId);
    if (t.status !== 'active') throw conflict(m('tenantlc.notActive'), 'TENANT_NOT_ACTIVE');
    await c.query(`UPDATE tenants SET status = 'suspended', suspended_at = now(), suspended_reason = $2, suspended_by = $3 WHERE id = $1`, [
      tenantId,
      reason,
      op.name,
    ]);
    // Signed-in people are signed out at once; API tokens and SCIM are refused by the guards.
    await c.query('DELETE FROM sessions WHERE tenant_id = $1', [tenantId]);
    await tenantAudit(c, tenantId, null, 'tenant.suspend', { status: t.status }, { status: 'suspended', reason, operator: op.name, operatorId: op.id });
    await operatorLog(c, op, 'tenant.suspend', tenantId, { reason });
  });
}

export async function resumeTenant(op: Operator, tenantId: string, reason: string): Promise<void> {
  await withSystem(async (c) => {
    const t = await lockTenant(c, tenantId);
    if (t.status !== 'suspended') throw conflict(m('tenantlc.notSuspended'), 'TENANT_NOT_SUSPENDED');
    await c.query(`UPDATE tenants SET status = 'active', suspended_at = NULL, suspended_reason = NULL, suspended_by = NULL WHERE id = $1`, [tenantId]);
    await tenantAudit(c, tenantId, null, 'tenant.resume', { status: 'suspended' }, { status: 'active', reason, operator: op.name, operatorId: op.id });
    await operatorLog(c, op, 'tenant.resume', tenantId, { reason });
  });
}

// ---------------------------------------------------------------- offboarding

export interface DeletionRequester {
  kind: 'admin' | 'operator';
  /** Name shown in the workspace and the operator log. */
  name: string;
  userId?: string;
  operator?: Operator;
}

/** Starts the grace period; the job deletes the tenant after `graceDays`. */
export async function requestDeletion(tenantId: string, by: DeletionRequester, reason: string | null, graceDays = config.tenantDeleteGraceDays): Promise<Date> {
  return withSystem(async (c) => {
    const t = await lockTenant(c, tenantId);
    if (t.status === 'deleting') throw conflict(m('tenantlc.alreadyDeleting'), 'TENANT_DELETING');
    const after = (
      await c.query<{ delete_after: Date }>(
        `UPDATE tenants SET status = 'deleting', deletion_requested_at = now(), deletion_requested_by = $2, deletion_reason = $3,
              delete_after = now() + make_interval(days => $4) WHERE id = $1 RETURNING delete_after`,
        [tenantId, `${by.kind}:${by.kind === 'admin' ? by.userId : by.name}`, reason, graceDays],
      )
    ).rows[0].delete_after;
    // Only admins keep access during the grace period.
    await c.query(`DELETE FROM sessions s USING users u WHERE s.user_id = u.id AND s.tenant_id = $1 AND NOT ('admin' = ANY(u.roles))`, [tenantId]);
    await tenantAudit(
      c,
      tenantId,
      by.userId ?? null,
      'tenant.delete_requested',
      { status: t.status },
      {
        status: 'deleting',
        deleteAfter: after,
        graceDays,
        reason,
        by: by.kind,
        operator: by.operator?.name,
        operatorId: by.operator?.id,
      },
    );
    await operatorLog(c, by.operator ?? `${by.kind}:${by.name}`, 'tenant.delete_requested', tenantId, { deleteAfter: after, graceDays, by: by.kind });
    return after;
  });
}

/** Cancels a requested deletion during the grace period (admin of the tenant or operator). */
export async function cancelDeletion(tenantId: string, by: DeletionRequester): Promise<TenantStatusValue> {
  return withSystem(async (c) => {
    const t = await lockTenant(c, tenantId);
    if (t.status !== 'deleting') throw conflict(m('tenantlc.notDeleting'), 'TENANT_NOT_DELETING');
    // A tenant suspended before the request stays suspended.
    const next: TenantStatusValue = t.suspended_at ? 'suspended' : 'active';
    await c.query(
      `UPDATE tenants SET status = $2, deletion_requested_at = NULL, deletion_requested_by = NULL, deletion_reason = NULL, delete_after = NULL WHERE id = $1`,
      [tenantId, next],
    );
    await tenantAudit(
      c,
      tenantId,
      by.userId ?? null,
      'tenant.delete_cancelled',
      { status: 'deleting' },
      {
        status: next,
        by: by.kind,
        operator: by.operator?.name,
        operatorId: by.operator?.id,
      },
    );
    await operatorLog(c, by.operator ?? `${by.kind}:${by.name}`, 'tenant.delete_cancelled', tenantId, { by: by.kind });
    return next;
  });
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

/** Rows per table of a tenant (for the proof of deletion); owner connection. */
export async function tenantRowCounts(c: Db, tenantId: string): Promise<Record<string, number>> {
  const tables = (
    await c.query<{ table_name: string }>(
      `SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' ORDER BY c.table_name`,
    )
  ).rows
    .map((r) => r.table_name)
    .filter((n) => IDENT.test(n));
  const out: Record<string, number> = {};
  for (const name of tables) {
    const n = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${name}" WHERE tenant_id = $1`, [tenantId])).rows[0].n; // security-ok: table name from information_schema, checked against IDENT
    if (n) out[name] = n;
  }
  return out;
}

/** Deletes a tenant with all its data and keeps the proof of deletion (owner connection). */
export async function purgeWithProof(
  tenantId: string,
  requester: { kind: 'admin' | 'operator' | 'system'; name: string } | null = null,
  db?: Db,
): Promise<void> {
  const run = async (c: Db) => {
    const t = (
      await c.query<{
        slug: string;
        deletion_requested_at: Date | null;
        deletion_requested_by: string | null;
        deletion_reason: string | null;
        delete_after: Date | null;
      }>('SELECT slug, deletion_requested_at, deletion_requested_by, deletion_reason, delete_after FROM tenants WHERE id = $1 FOR UPDATE', [tenantId])
    ).rows[0];
    if (!t) return;
    const [kind, ...rest] = (t.deletion_requested_by ?? `${requester?.kind ?? 'system'}:${requester?.name ?? 'system'}`).split(':');
    // An admin is kept only as a pseudonym: the person's data goes with the tenant.
    const who = kind === 'admin' ? `user-${sha256(`user:${rest.join(':')}`).slice(0, 16)}` : rest.join(':') || 'system';
    const counts = await tenantRowCounts(c, tenantId);
    await c.query(
      `INSERT INTO tenant_deletions (tenant_id_hash, slug, requested_by_kind, requested_by, reason, requested_at, delete_after, row_counts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        sha256(`tenant:${tenantId}`),
        t.slug,
        ['admin', 'operator', 'system'].includes(kind) ? kind : 'system',
        who,
        t.deletion_reason,
        t.deletion_requested_at ?? new Date(),
        t.delete_after ?? new Date(),
        JSON.stringify(counts),
      ],
    );
    await c.query("SELECT set_config('app.purge_tenant', $1, true)", [tenantId]);
    await c.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    await operatorLog(c, 'system', 'tenant.purged', null, { slug: t.slug, tenantIdHash: sha256(`tenant:${tenantId}`) });
  };
  await (db ? run(db) : withSystem(run));
}

/** Job: deletes every tenant whose grace period is over. Returns the number of tenants. */
export async function purgeDueTenants(db?: Db): Promise<number> {
  const run = async (c: Db) => {
    const due = (await c.query<{ id: string }>(`SELECT id FROM tenants WHERE status = 'deleting' AND delete_after <= now() ORDER BY delete_after`)).rows;
    for (const t of due) await purgeWithProof(t.id, null, c);
    return due.length;
  };
  return db ? run(db) : withSystem(run);
}

export async function listDeletions(limit = 100) {
  return withSystem(
    async (c) =>
      (
        await c.query(
          `SELECT id, tenant_id_hash AS "tenantIdHash", slug, requested_by_kind AS "requestedByKind", requested_by AS "requestedBy", reason,
            requested_at AS "requestedAt", delete_after AS "deleteAfter", purged_at AS "purgedAt", row_counts AS "rowCounts"
       FROM tenant_deletions ORDER BY purged_at DESC LIMIT $1`,
          [limit],
        )
      ).rows,
  );
}

export function graceDaysInput(v: number | undefined): number {
  const d = v ?? config.tenantDeleteGraceDays;
  if (!Number.isInteger(d) || d < 0 || d > 365) throw badRequest(m('tenantlc.graceInvalid'));
  return d;
}
