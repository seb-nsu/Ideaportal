import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, withSystem } from './pool.js';

// Break-glass for the platform operator (R3-26): switches the password login of a workspace
// back on when the company login fails (identity provider down, wrong configuration, no admin
// left in the mapped groups). Runs with the owner connection on the server, not through the API.
//
//   npm run identity -w server -- local-login <slug> on|off
//
// Every change is written to the tenant's audit log.

export async function setLocalLogin(slug: string, enabled: boolean): Promise<boolean> {
  return withSystem(async (c) => {
    const t = (await c.query<{ id: string }>('SELECT id FROM tenants WHERE slug = $1', [slug])).rows[0];
    if (!t) return false;
    await c.query(
      `INSERT INTO tenant_identity (tenant_id, local_login_disabled) VALUES ($1, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET local_login_disabled = EXCLUDED.local_login_disabled, updated_by = NULL, updated_at = now()`,
      [t.id, !enabled],
    );
    await c.query('INSERT INTO audit_log (tenant_id, actor_id, action, entity, entity_id, after) VALUES ($1, NULL, $2, $3, $4, $5)', [
      t.id, 'identity.break_glass', 'tenant', t.id, JSON.stringify({ localLogin: enabled, via: 'cli' }),
    ]);
    return true;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [cmd, slug, value] = process.argv.slice(2);
  const run = async () => {
    if (cmd !== 'local-login' || !slug || !['on', 'off'].includes(value)) {
      console.error('usage: identity local-login <slug> on|off');
      process.exitCode = 2;
      return;
    }
    const ok = await setLocalLogin(slug, value === 'on');
    console.log(ok ? `local login for ${slug}: ${value}` : `workspace ${slug} not found`);
    if (!ok) process.exitCode = 1;
  };
  run().finally(() => closePool());
}
