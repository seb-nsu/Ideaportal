import { z } from 'zod';
import { withSystem, type Db } from '../db/pool.js';
import { notFound } from '../lib/errors.js';
import { FEATURES, LIMIT_KEYS } from '../lib/plans.js';
import { m } from '../i18n/index.js';
import { operatorLog, type Operator } from './operator.js';

// Feature switches and limits per tenant set by the operator (enterprise), on top of the
// package and its overrides in tenant_plans. Each override has a reason and may expire; expired
// rows are ignored by the request context (lib/context.ts, services/billing.ts loadPlanState).

export const overrideInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('feature'),
    key: z.enum(FEATURES),
    enabled: z.boolean(),
    reason: z.string().trim().min(3).max(300),
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  }),
  z.object({
    kind: z.literal('limit'),
    key: z.enum(LIMIT_KEYS),
    value: z.number().int().min(0).max(100_000),
    reason: z.string().trim().min(3).max(300),
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  }),
]);
export type OverrideInput = z.infer<typeof overrideInput>;

export interface OverrideView {
  key: string;
  kind: 'feature' | 'limit';
  enabled: boolean | null;
  value: number | null;
  reason: string;
  expiresAt: string | null;
  expired: boolean;
  setBy: string;
  setAt: string;
}

export async function listOverrides(tenantId: string): Promise<OverrideView[]> {
  return withSystem(
    async (c) =>
      (
        await c.query<OverrideView>(
          `SELECT key, kind, bool_value AS enabled, int_value AS value, reason, expires_at AS "expiresAt",
            coalesce(expires_at <= now(), false) AS expired, set_by AS "setBy", set_at AS "setAt"
       FROM tenant_overrides WHERE tenant_id = $1 ORDER BY kind, key`,
          [tenantId],
        )
      ).rows,
  );
}

async function writeAudit(c: Db, tenantId: string, action: string, before: unknown, after: unknown) {
  await c.query('INSERT INTO audit_log (tenant_id, actor_id, action, entity, entity_id, before, after) VALUES ($1, NULL, $2, $3, $4, $5, $6)', [
    tenantId,
    action,
    'tenant',
    tenantId,
    before == null ? null : JSON.stringify(before),
    after == null ? null : JSON.stringify(after),
  ]);
}

export async function setOverride(op: Operator, tenantId: string, input: OverrideInput): Promise<void> {
  await withSystem(async (c) => {
    if (!(await c.query('SELECT 1 FROM tenants WHERE id = $1', [tenantId])).rowCount) throw notFound(m('saas.tenantNotFound'));
    const before =
      (await c.query('SELECT kind, bool_value, int_value, reason, expires_at FROM tenant_overrides WHERE tenant_id = $1 AND key = $2', [tenantId, input.key]))
        .rows[0] ?? null;
    const bool = input.kind === 'feature' ? input.enabled : null;
    const int = input.kind === 'limit' ? input.value : null;
    await c.query(
      `INSERT INTO tenant_overrides (tenant_id, key, kind, bool_value, int_value, reason, expires_at, set_by, set_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (tenant_id, key) DO UPDATE SET kind = $3, bool_value = $4, int_value = $5, reason = $6, expires_at = $7, set_by = $8, set_at = now()`,
      [tenantId, input.key, input.kind, bool, int, input.reason, input.expiresAt ?? null, op.name],
    );
    const after = {
      key: input.key,
      kind: input.kind,
      enabled: bool,
      value: int,
      reason: input.reason,
      expiresAt: input.expiresAt ?? null,
      operator: op.name,
      operatorId: op.id,
    };
    await writeAudit(c, tenantId, 'tenant.override_set', before, after);
    await operatorLog(c, op, 'tenant.override_set', tenantId, after);
  });
}

export async function removeOverride(op: Operator, tenantId: string, key: string, reason: string): Promise<void> {
  await withSystem(async (c) => {
    const r = await c.query('DELETE FROM tenant_overrides WHERE tenant_id = $1 AND key = $2 RETURNING kind, bool_value, int_value, reason', [tenantId, key]);
    if (!r.rowCount) throw notFound(m('tenantlc.overrideNotFound'));
    await writeAudit(c, tenantId, 'tenant.override_removed', r.rows[0], { key, reason, operator: op.name, operatorId: op.id });
    await operatorLog(c, op, 'tenant.override_removed', tenantId, { key, reason });
  });
}
