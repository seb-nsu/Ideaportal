import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { closePool, withSystem } from '../src/db/pool.js';
import { createSession } from '../src/routes/auth.js';
import { applyRetention } from '../src/services/privacy.js';
import { asUser, client, createTenant, createUser, login, resetDb, testApp } from './helpers.js';

// SCIM 2.0 provisioning (R3-27) with requests shaped like Entra ID's (fixtures), Okta-style
// PATCH, deactivation with anonymisation period, groups → roles, token handling and strict
// tenant separation: a token of tenant A never reaches tenant B.

const fx = JSON.parse(readFileSync(new URL('./fixtures/entra-scim.json', import.meta.url), 'utf8'));
const withUser = (payload: unknown, userId: string) => JSON.parse(JSON.stringify(payload).replaceAll('{userId}', userId));

let app: FastifyInstance;
let tenantA: string;
let tenantB: string;
let tokenA: string;
let tokenB: string;
let adminA: ReturnType<typeof client>;
let bUserId: string;

async function scim(token: string | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const res = await app.inject({
    method,
    url: `/scim/v2${url}`,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload !== undefined ? { 'content-type': 'application/scim+json' } : {}) },
    payload: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
}

const userRow = (id: string) => withSystem(async (c) => (await c.query<{ active: boolean; roles: string[]; org_unit: string | null; display_name: string; deactivated_at: Date | null; anonymized_at: Date | null; scim_deleted_at: Date | null; email: string; tenant_id: string }>(
  'SELECT active, roles, org_unit, display_name, deactivated_at, anonymized_at, scim_deleted_at, email, tenant_id FROM users WHERE id = $1', [id])).rows[0]);

beforeAll(async () => {
  await resetDb();
  app = await testApp();
  tenantA = await createTenant('contoso');
  tenantB = await createTenant('fabrikam');
  await createUser(tenantA, 'admin@contoso.example', ['submitter', 'admin']);
  await createUser(tenantB, 'admin@fabrikam.example', ['submitter', 'admin']);
  bUserId = (await createUser(tenantB, 'person@fabrikam.example')).id;
  const mapping = JSON.stringify([{ group: 'Ideenportal Triage', roles: ['triage'] }, { group: 'okta-committee', roles: ['committee'] }]);
  await withSystem(async (c) => {
    await c.query(`INSERT INTO tenant_identity (tenant_id, allowed_domains, group_roles) VALUES ($1, '{contoso.example}', $2)`, [tenantA, mapping]);
    await c.query(`INSERT INTO tenant_identity (tenant_id, allowed_domains, group_roles) VALUES ($1, '{fabrikam.example}', $2)`, [tenantB, mapping]);
  });
  adminA = client(app, await login(app, 'contoso', 'admin@contoso.example'));
  const adminB = client(app, await login(app, 'fabrikam', 'admin@fabrikam.example'));
  const a = await adminA.post('/api/admin/identity/scim-tokens', { label: 'Entra ID' });
  expect(a.status).toBe(201);
  tokenA = a.body.token;
  tokenB = (await adminB.post('/api/admin/identity/scim-tokens', { label: 'Okta' })).body.token;
});

afterAll(async () => {
  await app.close();
  await closePool();
});

describe('tokens', () => {
  it('shows the token once and stores only its hash', async () => {
    expect(tokenA).toMatch(/^scim_/);
    const view = await adminA.get('/api/admin/identity');
    expect(view.body.tokens).toHaveLength(1);
    expect(JSON.stringify(view.body)).not.toContain(tokenA);
    expect(view.body.scimUrl).toMatch(/\/scim\/v2$/);
    const stored = await withSystem(async (c) => (await c.query<{ token_hash: string }>('SELECT token_hash FROM scim_tokens WHERE tenant_id = $1', [tenantA])).rows[0]);
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses requests without or with an unknown token in SCIM error format', async () => {
    const none = await scim(null, 'GET', '/Users');
    expect(none.status).toBe(401);
    expect(none.body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error']);
    expect(none.headers['content-type']).toMatch(/application\/scim\+json/);
    expect((await scim('scim_wrong', 'GET', '/Users')).status).toBe(401);
  });

  it('revokes a token; another tenant cannot revoke it', async () => {
    const extra = (await adminA.post('/api/admin/identity/scim-tokens', { label: 'temp' })).body;
    expect((await scim(extra.token, 'GET', '/Users')).status).toBe(200);
    const adminB = client(app, await login(app, 'fabrikam', 'admin@fabrikam.example'));
    expect((await adminB.del(`/api/admin/identity/scim-tokens/${extra.id}`)).status).toBe(404);
    expect((await scim(extra.token, 'GET', '/Users')).status).toBe(200);
    expect((await adminA.del(`/api/admin/identity/scim-tokens/${extra.id}`)).status).toBe(200);
    expect((await scim(extra.token, 'GET', '/Users')).status).toBe(401);
  });
});

describe('discovery', () => {
  it('serves ServiceProviderConfig, Schemas and ResourceTypes', async () => {
    const spc = await scim(null, 'GET', '/ServiceProviderConfig');
    expect(spc.status).toBe(200);
    expect(spc.body.patch.supported).toBe(true);
    expect(spc.body.filter.supported).toBe(true);
    const schemas = await scim(null, 'GET', '/Schemas');
    expect(schemas.body.Resources.map((s: { id: string }) => s.id)).toContain('urn:ietf:params:scim:schemas:core:2.0:User');
    const types = await scim(null, 'GET', '/ResourceTypes');
    expect(types.body.Resources.map((r: { id: string }) => r.id)).toEqual(['User', 'Group']);
    expect((await scim(tokenA, 'GET', '/Nothing')).status).toBe(404);
  });
});

describe('users (Entra ID)', () => {
  let lena: string;

  it('answers the connection test with an empty list', async () => {
    const r = await scim(tokenA, 'GET', `/Users?filter=${encodeURIComponent('userName eq "ab6490ee-1e48-479e-a20b-2d77186b5dd1"')}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ totalResults: 0, Resources: [], schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'] });
  });

  it('creates a user and keeps only the attributes the portal needs', async () => {
    const r = await scim(tokenA, 'POST', '/Users', fx.createUser);
    expect(r.status).toBe(201);
    lena = r.body.id;
    expect(r.body).toMatchObject({ userName: 'lena.vogel@contoso.example', displayName: 'Lena Vogel', active: true, externalId: '0a21f0f2-8d2a-4f8e-bf98-7363c4aed4ef' });
    expect(r.body['urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'].department).toBe('Innovation');
    expect(JSON.stringify(r.body)).not.toContain('4711');
    expect(JSON.stringify(r.body)).not.toContain('+49');
    const row = await userRow(lena);
    expect(row).toMatchObject({ tenant_id: tenantA, active: true, org_unit: 'Innovation', roles: ['submitter'] });
    // Duplicate userName → 409 uniqueness
    const dup = await scim(tokenA, 'POST', '/Users', fx.createUser);
    expect(dup.status).toBe(409);
    expect(dup.body.scimType).toBe('uniqueness');
  });

  it('uses the work address when userName is not an address', async () => {
    const r = await scim(tokenA, 'POST', '/Users', fx.createUserWithoutUpnMail);
    expect(r.status).toBe(201);
    expect(r.body.userName).toBe('test_user_ab6490ee-1e48-479e-a20b-2d77186b5dd1');
    expect(r.body.emails[0].value).toBe('test_user_fd0ea19b@contoso.example');
    const found = await scim(tokenA, 'GET', `/Users?filter=${encodeURIComponent('userName eq "Test_User_ab6490ee-1e48-479e-a20b-2d77186b5dd1"')}`);
    expect(found.body.totalResults).toBe(1);
  });

  it('refuses addresses outside the allowed domains', async () => {
    const r = await scim(tokenA, 'POST', '/Users', { ...fx.createUser, userName: 'x@elsewhere.example', emails: [] });
    expect(r.status).toBe(400);
  });

  it('finds the user by userName filter and patches attributes', async () => {
    const found = await scim(tokenA, 'GET', `/Users?filter=${encodeURIComponent('userName eq "Lena.Vogel@contoso.example"')}`);
    expect(found.body.totalResults).toBe(1);
    expect(found.body.Resources[0].id).toBe(lena);
    const p = await scim(tokenA, 'PATCH', `/Users/${lena}`, fx.patchUserAttributes);
    expect(p.status).toBe(200);
    expect(p.body.displayName).toBe('Lena Vogel-Hart');
    expect(p.body.name.familyName).toBe('Vogel-Hart');
    expect((await userRow(lena)).org_unit).toBe('Strategie');
  });

  it('rejects unsupported filters', async () => {
    const r = await scim(tokenA, 'GET', `/Users?filter=${encodeURIComponent('title co "x"')}`);
    expect(r.status).toBe(400);
    expect(r.body.scimType).toBe('invalidFilter');
  });

  it('deactivation locks the account, ends sessions and starts the anonymisation period', async () => {
    await withSystem((c) => createSession(c, lena, tenantA));
    const p = await scim(tokenA, 'PATCH', `/Users/${lena}`, fx.patchUserDisable);
    expect(p.status).toBe(200);
    expect(p.body.active).toBe(false);
    const row = await userRow(lena);
    expect(row.active).toBe(false);
    expect(row.deactivated_at).not.toBeNull();
    const sessions = await withSystem(async (c) => (await c.query('SELECT 1 FROM sessions WHERE user_id = $1', [lena])).rowCount);
    expect(sessions).toBe(0);
    // Reactivation before the period ends clears the start of the period.
    await scim(tokenA, 'PATCH', `/Users/${lena}`, fx.patchUserEnable);
    expect((await userRow(lena)).deactivated_at).toBeNull();
    // Okta style: replace without path.
    await scim(tokenA, 'PATCH', `/Users/${lena}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', value: { active: false } }] });
    expect((await userRow(lena)).active).toBe(false);
    // The retention job anonymises after the configured days (default 30).
    const later = new Date(Date.now() + 31 * 86_400_000).toISOString().slice(0, 10);
    await asUser(null, tenantA, (ctx) => applyRetention(ctx), later);
    const anon = await userRow(lena);
    expect(anon.anonymized_at).not.toBeNull();
    expect(anon.email).toMatch(/^anonym-/);
    expect((await scim(tokenA, 'GET', `/Users/${lena}`)).status).toBe(404);
  });

  it('DELETE locks the account; it disappears from SCIM and can come back', async () => {
    const created = await scim(tokenA, 'POST', '/Users', { ...fx.createUser, userName: 'max@contoso.example', externalId: 'max', emails: [] });
    const id = created.body.id;
    expect((await scim(tokenA, 'DELETE', `/Users/${id}`)).status).toBe(204);
    expect((await scim(tokenA, 'GET', `/Users/${id}`)).status).toBe(404);
    const row = await userRow(id);
    expect(row.active).toBe(false);
    expect(row.scim_deleted_at).not.toBeNull();
    expect(row.deactivated_at).not.toBeNull();
    const again = await scim(tokenA, 'POST', '/Users', { ...fx.createUser, userName: 'max@contoso.example', externalId: 'max', emails: [] });
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(id);
    expect((await userRow(id)).active).toBe(true);
  });

  it('pages with startIndex and count', async () => {
    for (const n of [1, 2, 3]) await scim(tokenA, 'POST', '/Users', { userName: `page${n}@contoso.example`, active: true });
    const all = await scim(tokenA, 'GET', '/Users');
    const page = await scim(tokenA, 'GET', '/Users?startIndex=2&count=2');
    expect(page.body.startIndex).toBe(2);
    expect(page.body.itemsPerPage).toBe(2);
    expect(page.body.totalResults).toBe(all.body.totalResults);
    expect(page.body.Resources[0].id).toBe(all.body.Resources[1].id);
  });
});

describe('groups → roles', () => {
  let user: string;
  let group: string;

  it('creates a group and maps membership to roles', async () => {
    user = (await scim(tokenA, 'POST', '/Users', { userName: 'gruppe@contoso.example', active: true })).body.id;
    const g = await scim(tokenA, 'POST', '/Groups', fx.createGroup);
    expect(g.status).toBe(201);
    group = g.body.id;
    const filtered = await scim(tokenA, 'GET', `/Groups?excludedAttributes=members&filter=${encodeURIComponent('displayName eq "Ideenportal Triage"')}`);
    expect(filtered.body.totalResults).toBe(1);
    expect(filtered.body.Resources[0].members).toBeUndefined();

    expect((await scim(tokenA, 'PATCH', `/Groups/${group}`, withUser(fx.patchGroupAddMember, user))).status).toBe(204);
    expect((await userRow(user)).roles.sort()).toEqual(['submitter', 'triage']);
    const full = await scim(tokenA, 'GET', `/Groups/${group}`);
    expect(full.body.members.map((mb: { value: string }) => mb.value)).toEqual([user]);
    expect((await scim(tokenA, 'GET', `/Users/${user}`)).body.groups[0].display).toBe('Ideenportal Triage');

    expect((await scim(tokenA, 'PATCH', `/Groups/${group}`, withUser(fx.patchGroupRemoveMember, user))).status).toBe(204);
    expect((await userRow(user)).roles).toEqual(['submitter']);
  });

  it('supports Okta-style member removal by filter and group deletion', async () => {
    const okta = await scim(tokenA, 'POST', '/Groups', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName: 'okta-committee', members: [{ value: user }] });
    expect((await userRow(user)).roles.sort()).toEqual(['committee', 'submitter']);
    await scim(tokenA, 'PATCH', `/Groups/${okta.body.id}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'remove', path: `members[value eq "${user}"]` }] });
    expect((await userRow(user)).roles).toEqual(['submitter']);
    await scim(tokenA, 'PATCH', `/Groups/${okta.body.id}`, withUser(fx.patchGroupAddMember, user));
    expect((await scim(tokenA, 'DELETE', `/Groups/${okta.body.id}`)).status).toBe(204);
    expect((await userRow(user)).roles).toEqual(['submitter']);
  });
});

describe('tenant separation', () => {
  it('a token of tenant A never reads or changes users of tenant B', async () => {
    expect((await scim(tokenA, 'GET', `/Users/${bUserId}`)).status).toBe(404);
    expect((await scim(tokenA, 'PATCH', `/Users/${bUserId}`, fx.patchUserDisable)).status).toBe(404);
    expect((await scim(tokenA, 'PUT', `/Users/${bUserId}`, { userName: 'person@fabrikam.example', active: false })).status).toBe(404);
    expect((await scim(tokenA, 'DELETE', `/Users/${bUserId}`)).status).toBe(404);
    const listed = await scim(tokenA, 'GET', `/Users?filter=${encodeURIComponent('userName eq "person@fabrikam.example"')}`);
    expect(listed.body.totalResults).toBe(0);
    expect((await scim(tokenA, 'GET', '/Users')).body.Resources.some((u: { id: string }) => u.id === bUserId)).toBe(false);
    expect((await userRow(bUserId)).active).toBe(true);
  });

  it('a token of tenant A cannot add users of tenant B to its groups or see B groups', async () => {
    const g = await scim(tokenA, 'POST', '/Groups', { displayName: 'A-Gruppe', members: [{ value: bUserId }] });
    expect(g.status).toBe(201);
    expect(g.body.members).toEqual([]);
    await scim(tokenA, 'PATCH', `/Groups/${g.body.id}`, withUser(fx.patchGroupAddMember, bUserId));
    const members = await withSystem(async (c) => (await c.query('SELECT 1 FROM scim_group_members WHERE user_id = $1', [bUserId])).rowCount);
    expect(members).toBe(0);

    const gB = await scim(tokenB, 'POST', '/Groups', { displayName: 'B-Gruppe' });
    expect((await scim(tokenA, 'GET', `/Groups/${gB.body.id}`)).status).toBe(404);
    expect((await scim(tokenA, 'DELETE', `/Groups/${gB.body.id}`)).status).toBe(404);
    expect((await scim(tokenB, 'GET', `/Groups/${gB.body.id}`)).status).toBe(200);
    expect((await scim(tokenB, 'GET', '/Users')).body.Resources.every((u: { userName: string }) => u.userName.endsWith('@fabrikam.example'))).toBe(true);
  });

  it('row-level security hides identity tables of other tenants', async () => {
    const rows = await asUser(null, tenantB, async (ctx) => ({
      tokens: (await ctx.db.query('SELECT tenant_id FROM scim_tokens')).rows,
      groups: (await ctx.db.query('SELECT tenant_id FROM scim_groups')).rows,
      identity: (await ctx.db.query('SELECT tenant_id FROM tenant_identity')).rows,
    }));
    for (const list of Object.values(rows)) expect(list.every((r) => r.tenant_id === tenantB)).toBe(true);
    // Writing a row for tenant A from tenant B's context fails.
    await expect(asUser(null, tenantB, (ctx) => ctx.db.query(`INSERT INTO scim_groups (tenant_id, display_name) VALUES ($1, 'x')`, [tenantA]))).rejects.toThrow();
  });
});

describe('rate limits', () => {
  it('limits failed SCIM authentications per IP', async () => {
    const factor = config.rateLimitFactor;
    config.rateLimitFactor = 0.05; // scimAuthIp: 1 per window
    try {
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) {
        codes.push((await app.inject({ method: 'GET', url: '/scim/v2/Users', remoteAddress: '10.7.7.7', headers: { authorization: 'Bearer scim_nope' } })).statusCode);
      }
      expect(codes[0]).toBe(401);
      expect(codes[2]).toBe(429);
    } finally {
      config.rateLimitFactor = factor;
    }
  });
});
