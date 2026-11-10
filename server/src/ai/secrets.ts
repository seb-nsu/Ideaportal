import type { Ctx } from '../lib/context.js';
import { openSecret, sealSecret } from '../lib/secretbox.js';

// Provider and search keys per tenant, encrypted with AES-256-GCM and the tenant's own data
// key (R3-01). The API never returns them; the admin page only shows whether a key is set.

export async function setSecret(ctx: Ctx, name: string, value: string | null): Promise<void> {
  if (value === null || value === '') {
    await ctx.db.query('DELETE FROM tenant_secrets WHERE name = $1', [name]);
    return;
  }
  await ctx.db.query(
    `INSERT INTO tenant_secrets (tenant_id, name, ciphertext, updated_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, name) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [ctx.tenantId, name, await sealSecret(ctx.db, ctx.tenantId, value), ctx.user?.id ?? null],
  );
}

export async function getSecret(ctx: Ctx, name: string): Promise<string | null> {
  const r = await ctx.db.query<{ ciphertext: string }>('SELECT ciphertext FROM tenant_secrets WHERE name = $1', [name]);
  return r.rows[0] ? openSecret(ctx.db, ctx.tenantId, r.rows[0].ciphertext) : null;
}

export async function secretNames(ctx: Ctx): Promise<string[]> {
  return (await ctx.db.query<{ name: string }>('SELECT name FROM tenant_secrets ORDER BY name')).rows.map((r) => r.name);
}
