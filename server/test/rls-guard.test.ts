import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, withSystem } from '../src/db/pool.js';
import { resetDb } from './helpers.js';

// Guard for the rule in CLAUDE.md (guard rail 1): every table with tenant_id has row-level
// security switched on AND forced, and a policy that uses the tenant context (app.tenant_id,
// usually via current_tenant()). The request role ideenportal_app must never bypass RLS.
// Runs against the schema after ALL migrations, so a new migration that forgets the policy fails here.

const APP_ROLE = 'ideenportal_app';
/** Tables without tenant_id the request role may still use; each must have a forced policy of its own. */
const SHARED_TABLES_FOR_APP = ['tenants'];
/** Policy expressions that bind rows to the tenant of the request. */
const TENANT_CONTEXT = /current_tenant\(\)|current_setting\('app\.tenant_id'/;

interface TableInfo {
  name: string;
  rls: boolean;
  force: boolean;
  hasTenantId: boolean;
  appAccess: boolean;
  policies: { name: string; roles: string[]; using: string | null; check: string | null }[];
}

async function tables(): Promise<TableInfo[]> {
  return withSystem(async (c) => {
    const rows = (
      await c.query<{ name: string; rls: boolean; force: boolean; has_tenant_id: boolean; app_access: boolean; policies: TableInfo['policies'] }>(
        `SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
              EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped) AS has_tenant_id,
              has_table_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, DELETE') AS app_access,
              coalesce((SELECT json_agg(json_build_object(
                         'name', p.polname,
                         'roles', (SELECT coalesce(json_agg(CASE WHEN r = 0 THEN 'public' ELSE pg_get_userbyid(r) END), '[]'::json) FROM unnest(p.polroles) r),
                         'using', pg_get_expr(p.polqual, p.polrelid),
                         'check', pg_get_expr(p.polwithcheck, p.polrelid)))
                        FROM pg_policy p WHERE p.polrelid = c.oid), '[]'::json) AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        ORDER BY c.relname`,
        [APP_ROLE],
      )
    ).rows;
    return rows.map((r) => ({ name: r.name, rls: r.rls, force: r.force, hasTenantId: r.has_tenant_id, appAccess: r.app_access, policies: r.policies }));
  });
}

let all: TableInfo[];

beforeAll(async () => {
  await resetDb();
  all = await tables();
});

afterAll(async () => {
  await closePool();
});

describe('row-level security guard (CLAUDE.md guard rail 1)', () => {
  it('finds the tenant tables at all (sanity check of the query)', () => {
    const tenantTables = all.filter((t) => t.hasTenantId).map((t) => t.name);
    expect(tenantTables.length).toBeGreaterThan(50);
    expect(tenantTables).toEqual(expect.arrayContaining(['users', 'ideas', 'audit_log']));
  });

  it('every table with tenant_id has RLS enabled and forced', () => {
    const missing = all.filter((t) => t.hasTenantId && !(t.rls && t.force)).map((t) => `${t.name} (rls=${t.rls}, force=${t.force})`);
    expect(missing, 'add ENABLE and FORCE ROW LEVEL SECURITY in the migration').toEqual([]);
  });

  it('every table with tenant_id the request role can use has a policy bound to app.tenant_id', () => {
    const missing = all
      .filter((t) => t.hasTenantId && t.appAccess)
      .filter(
        (t) =>
          !t.policies.some(
            (p) =>
              (p.roles.includes('public') || p.roles.includes(APP_ROLE)) &&
              TENANT_CONTEXT.test(p.using ?? '') &&
              (p.check === null || TENANT_CONTEXT.test(p.check)),
          ),
      )
      .map((t) => t.name);
    expect(missing, 'add a tenant_isolation policy USING (tenant_id = current_tenant()) WITH CHECK (...)').toEqual([]);
  });

  it('tables with tenant_id that the request role cannot use are system tables with a policy of their own', () => {
    // E.g. operator_log: only the system connection (owner) writes it; RLS is still forced.
    const systemOnly = all.filter((t) => t.hasTenantId && !t.appAccess);
    for (const t of systemOnly) expect(t.policies.length, t.name).toBeGreaterThan(0);
  });

  it('the request role reaches no table without tenant_id except the allowed shared ones', () => {
    const unexpected = all.filter((t) => !t.hasTenantId && t.appAccess && !SHARED_TABLES_FOR_APP.includes(t.name)).map((t) => t.name);
    expect(unexpected, 'give the table a tenant_id and a policy, or REVOKE ALL FROM ideenportal_app').toEqual([]);
    for (const name of SHARED_TABLES_FOR_APP) {
      const t = all.find((x) => x.name === name)!;
      expect(t.rls && t.force, name).toBe(true);
      expect(
        t.policies.some((p) => TENANT_CONTEXT.test(p.using ?? '')),
        name,
      ).toBe(true);
    }
  });

  it('the request role cannot bypass RLS, is no superuser and owns no table', async () => {
    const role = await withSystem(
      async (c) =>
        (await c.query<{ rolbypassrls: boolean; rolsuper: boolean }>('SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = $1', [APP_ROLE])).rows[0],
    );
    expect(role).toEqual({ rolbypassrls: false, rolsuper: false });
    const owned = await withSystem(
      async (c) =>
        (
          await c.query(
            `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = $1)`,
            [APP_ROLE],
          )
        ).rows,
    );
    // A table owner is exempt from RLS unless FORCE is set; the request role should own nothing.
    expect(owned).toEqual([]);
  });

  it('detects a new table that forgets the rule (self-test of the guard)', async () => {
    await withSystem(async (c) => {
      await c.query('CREATE TABLE rls_guard_probe (id serial PRIMARY KEY, tenant_id uuid NOT NULL)');
      await c.query(`GRANT SELECT ON rls_guard_probe TO ${APP_ROLE}`);
    });
    try {
      const probe = (await tables()).find((t) => t.name === 'rls_guard_probe')!;
      expect(probe).toMatchObject({ hasTenantId: true, rls: false, force: false, appAccess: true, policies: [] });
    } finally {
      await withSystem((c) => c.query('DROP TABLE rls_guard_probe'));
    }
  });

  it("views the request role can read run with the caller's rights (security_invoker)", async () => {
    const views = await withSystem(
      async (c) =>
        (
          await c.query<{ relname: string; reloptions: string[] | null }>(
            `SELECT c.relname, c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm') AND has_table_privilege($1, c.oid, 'SELECT')`,
            [APP_ROLE],
          )
        ).rows,
    );
    const unsafe = views.filter((v) => !(v.reloptions ?? []).some((o) => /^security_invoker=(true|on|1)$/i.test(o))).map((v) => v.relname);
    expect(unsafe).toEqual([]);
  });
});
