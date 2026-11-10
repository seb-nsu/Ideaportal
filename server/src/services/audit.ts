import type { Ctx } from '../lib/context.js';

// Append-only audit trail of decisions, deadline changes, settings and role changes (R1-06).
export async function audit(
  ctx: Ctx,
  action: string,
  entity: string,
  entityId: string | null,
  before: unknown,
  after: unknown,
): Promise<void> {
  await ctx.db.query(
    'INSERT INTO audit_log (tenant_id, actor_id, action, entity, entity_id, before, after) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [ctx.tenantId, ctx.user?.id ?? null, action, entity, entityId, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after)],
  );
}
