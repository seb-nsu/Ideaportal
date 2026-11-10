import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, withSystem, withTenant } from '../src/db/pool.js';
import { runTenantJobs } from '../src/jobs/deadlines.js';
import { restrictToAreas, scopeAreas, type SessionUser } from '../src/lib/context.js';
import { groupRoleSchema, loadIdentity, scopedRolesFromGroups, syncRoles } from '../src/services/identity.js';
import { asUser, client, createTenant, createUser, login, resetDb, testApp, validIdea } from './helpers.js';

// Roles per area (AP-19, R3-29): areas as master data, roles with a scope, board, tasks,
// escalation, notifications and dashboard filtered by the scope, group → role + area from the
// identity provider, co-determination overview, two tenants.

let app: FastifyInstance;
let tenant: string;
let other: string;
type Who = 'admin' | 'triageAll' | 'triageNord' | 'triageSued' | 'committeeNord' | 'committeeAll' | 'council' | 'erika' | 'otto' | 'zora' | 'otherAdmin';
const api = {} as Record<Who, ReturnType<typeof client>>;
const users = {} as Record<Who, SessionUser>;
let nord: string;
let councilCookie = '';
let sued: string;
const idea = {} as Record<'n' | 's' | 'both' | 'none' | 'secret', string>;

async function submit(by: Who, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await api[by].post('/api/ideas', { ...validIdea, ...extra });
  expect(created.status).toBe(201);
  const sub = await api[by].post(`/api/ideas/${created.body.id}/submit`, { confirmNotReport: true });
  expect(sub.status).toBe(200);
  return created.body.id;
}

const outbox = (userId: string, ideaId: string, category?: string) =>
  withSystem(async (c) => (await c.query(
    'SELECT subject FROM outbox WHERE user_id = $1 AND idea_id = $2 AND ($3::text IS NULL OR category = $3)', [userId, ideaId, category ?? null],
  )).rowCount ?? 0);

beforeAll(async () => {
  await resetDb();
  app = await testApp();
  tenant = await createTenant('bereiche');
  other = await createTenant('fremd');
  Object.assign(users, {
    admin: await createUser(tenant, 'admin@bereiche.example', ['submitter', 'admin'], 'Zentrale'),
    triageAll: await createUser(tenant, 'triage@bereiche.example', ['submitter', 'triage'], 'Zentrale'),
    triageNord: await createUser(tenant, 'triage-nord@bereiche.example', ['submitter'], 'Werk Nord'),
    triageSued: await createUser(tenant, 'triage-sued@bereiche.example', ['submitter'], 'Werk Süd'),
    committeeNord: await createUser(tenant, 'gremium-nord@bereiche.example', ['submitter'], 'Werk Nord'),
    committeeAll: await createUser(tenant, 'gremium@bereiche.example', ['submitter', 'committee'], 'Zentrale'),
    council: await createUser(tenant, 'betriebsrat@bereiche.example', ['works_council'], 'Zentrale'),
    erika: await createUser(tenant, 'erika@bereiche.example', ['submitter'], 'Werk Nord'),
    otto: await createUser(tenant, 'otto@bereiche.example', ['submitter'], 'werk süd'),
    zora: await createUser(tenant, 'zora@bereiche.example', ['submitter'], 'Zentrale'),
    otherAdmin: await createUser(other, 'admin@fremd.example', ['submitter', 'admin'], 'Werk Nord'),
  });
  for (const [k, u] of Object.entries(users)) {
    const cookie = await login(app, k === 'otherAdmin' ? 'fremd' : 'bereiche', u.email);
    if (k === 'council') councilCookie = cookie;
    api[k as Who] = client(app, cookie);
  }
});

afterAll(async () => {
  await app.close();
  await closePool();
});

describe('areas as master data (R3-29)', () => {
  it('admins create, change and list areas; names are unique per tenant', async () => {
    const n = await api.admin.post('/api/admin/areas', { name: 'Werk Nord', orgUnits: ['Werk Nord'] });
    expect(n.status).toBe(201);
    nord = n.body.id;
    const s = await api.admin.post('/api/admin/areas', { name: 'Werk Süd', topics: ['Nachhaltigkeit'], orgUnits: ['Werk Süd'] });
    expect(s.status).toBe(201);
    sued = s.body.id;
    expect((await api.admin.post('/api/admin/areas', { name: 'werk nord' })).status).toBe(409);
    const changed = await api.admin.put(`/api/admin/areas/${sued}`, { name: 'Werk Süd', description: 'Standort Süd', topics: ['Nachhaltigkeit'], orgUnits: ['Werk Süd'] });
    expect(changed.status).toBe(200);
    expect(changed.body.description).toBe('Standort Süd');
    const list = await api.admin.get('/api/admin/areas');
    expect(list.body.map((a: { name: string }) => a.name)).toEqual(['Werk Nord', 'Werk Süd']);
    expect((await api.triageAll.get('/api/admin/areas')).status).toBe(403);
    // A temporary area can be deleted again.
    const tmp = await api.admin.post('/api/admin/areas', { name: 'Vertrieb' });
    expect((await api.admin.del(`/api/admin/areas/${tmp.body.id}`)).status).toBe(200);
    expect((await api.admin.del(`/api/admin/areas/${tmp.body.id}`)).status).toBe(404);
  });

  it('admins give roles with a scope; tenant-wide roles stay in roles', async () => {
    const set = (who: Who, scopedRoles: unknown[]) => api.admin.patch(`/api/admin/users/${users[who].id}`, { scopedRoles });
    expect((await set('triageNord', [{ role: 'triage', areaId: nord }])).status).toBe(200);
    expect((await set('triageSued', [{ role: 'triage', areaId: sued }])).status).toBe(200);
    expect((await set('committeeNord', [{ role: 'committee', areaId: nord }])).status).toBe(200);
    // Only triage, committee and lead can be scoped; areas must exist.
    expect((await set('erika', [{ role: 'admin', areaId: nord }])).status).toBe(400);
    expect((await set('erika', [{ role: 'triage', areaId: '00000000-0000-4000-8000-000000000000' }])).status).toBe(400);
    const people = (await api.admin.get('/api/admin/users')).body as { email: string; roles: string[]; scopedRoles: { role: string; areaId: string }[] }[];
    const tn = people.find((p) => p.email === users.triageNord.email)!;
    expect(tn.roles).toEqual(['submitter']);
    expect(tn.scopedRoles).toEqual([{ role: 'triage', areaId: nord, source: 'manual' }]);
    const me = (await api.triageNord.get('/api/me')).body.user;
    expect(me.roles).toContain('triage');
    expect(me.scopes).toEqual({ triage: [nord] });
    expect((await api.triageAll.get('/api/me')).body.user.scopes).toBeUndefined();
  });
});

describe('ideas belong to areas by topic or org unit of the author', () => {
  beforeAll(async () => {
    idea.n = await submit('erika'); // org unit Werk Nord
    idea.s = await submit('otto'); // org unit "werk süd" (case-insensitive)
    idea.both = await submit('erika', { title: 'Solarstrom für die Halle', topic: 'Nachhaltigkeit' }); // Nord by unit, Süd by topic
    idea.none = await submit('zora'); // Zentrale, no area
    idea.secret = await submit('otto', { title: 'Vertrauliche Idee Süd', confidential: true });
  });

  it('computes the areas of an idea in SQL', async () => {
    const areas = (id: string) => withTenant(tenant, async (c) => (await c.query<{ a: string[] }>('SELECT idea_area_ids($1)::text[] AS a', [id])).rows[0].a.sort());
    expect(await areas(idea.n)).toEqual([nord]);
    expect(await areas(idea.s)).toEqual([sued]);
    expect(await areas(idea.both)).toEqual([nord, sued].sort());
    expect(await areas(idea.none)).toEqual([]);
  });

  it('board: scoped triage sees only its areas, tenant-wide triage sees all', async () => {
    const board = async (who: Who) => ((await api[who].get('/api/triage/board')).body as { id: string }[]).map((x) => x.id);
    const nordBoard = await board('triageNord');
    expect(nordBoard).toEqual(expect.arrayContaining([idea.n, idea.both]));
    expect(nordBoard).not.toContain(idea.s);
    expect(nordBoard).not.toContain(idea.none);
    expect(nordBoard).not.toContain(idea.secret);
    const suedBoard = await board('triageSued');
    expect(suedBoard).toEqual(expect.arrayContaining([idea.s, idea.both, idea.secret]));
    expect(suedBoard).not.toContain(idea.n);
    expect(await board('triageAll')).toEqual(expect.arrayContaining(Object.values(idea)));
    // Paged board: column counts follow the scope as well.
    const paged = await api.triageNord.get('/api/triage/board?limit=10');
    expect(paged.body.counts.submitted).toBe(2);
    expect((await api.erika.get('/api/triage/board')).status).toBe(403);
  });

  it('confidential ideas: visible for triage of the area only', async () => {
    expect((await api.triageNord.get(`/api/ideas/${idea.secret}`)).status).toBe(404);
    expect((await api.triageSued.get(`/api/ideas/${idea.secret}`)).status).toBe(200);
    expect((await api.triageAll.get(`/api/ideas/${idea.secret}`)).status).toBe(200);
    const list = async (who: Who) => ((await api[who].get('/api/ideas?scope=all')).body as { id: string }[]).map((x) => x.id);
    expect(await list('triageNord')).not.toContain(idea.secret);
    expect(await list('triageSued')).toContain(idea.secret);
    expect(await list('triageAll')).toContain(idea.secret);
  });

  it('notifications to roles reach scoped people for ideas of their areas only', async () => {
    expect(await outbox(users.triageNord.id, idea.n)).toBeGreaterThan(0);
    expect(await outbox(users.triageNord.id, idea.s)).toBe(0);
    expect(await outbox(users.triageSued.id, idea.s)).toBeGreaterThan(0);
    expect(await outbox(users.triageSued.id, idea.both)).toBeGreaterThan(0);
    expect(await outbox(users.triageNord.id, idea.none)).toBe(0);
    for (const id of Object.values(idea)) expect(await outbox(users.triageAll.id, id)).toBeGreaterThan(0);
  });

  it('scoped triage cannot decide ideas of other areas; tenant-wide triage can', async () => {
    expect((await api.triageNord.post(`/api/ideas/${idea.s}/triage`, { lane: 'elaborate' })).status).toBe(403);
    expect((await api.triageNord.post(`/api/ideas/${idea.none}/triage`, { lane: 'elaborate' })).status).toBe(403);
    expect((await api.triageNord.post(`/api/ideas/${idea.n}/triage`, { lane: 'elaborate' })).status).toBe(200);
    expect((await api.triageSued.post(`/api/ideas/${idea.both}/triage`, { lane: 'elaborate' })).status).toBe(200);
    expect((await api.triageAll.post(`/api/ideas/${idea.s}/triage`, { lane: 'elaborate' })).status).toBe(200);
  });

  it('a scoped committee cannot decide Gate 2 for ideas of other areas', async () => {
    const decide = (who: Who, id: string) => api[who].post(`/api/ideas/${id}/decision`, { outcome: 'park', reason: 'Budget erst im nächsten Jahr.', resubmitOn: '2099-01-01' });
    expect((await decide('committeeNord', idea.s)).status).toBe(403);
    // In the own area the rights check passes (the decision may still need more input).
    expect((await decide('committeeNord', idea.n)).status).not.toBe(403);
    expect((await decide('committeeAll', idea.s)).status).not.toBe(403);
  });

  it('tasks follow the scope', async () => {
    for (const who of ['committeeNord', 'committeeAll', 'triageNord'] as Who[]) expect((await api[who].get('/api/tasks')).status).toBe(200);
  });

  it('escalation of overdue deadlines goes to scoped roles of the area only', async () => {
    await asUser(null, tenant, (ctx) => runTenantJobs(ctx), '2099-06-01');
    // idea.none and idea.secret are still at Gate 1 and overdue; idea.secret belongs to Süd.
    expect(await outbox(users.triageSued.id, idea.secret, 'reminders')).toBeGreaterThan(0);
    expect(await outbox(users.triageNord.id, idea.secret, 'reminders')).toBe(0);
    expect(await outbox(users.triageNord.id, idea.none, 'reminders')).toBe(0);
    expect(await outbox(users.triageAll.id, idea.none, 'reminders')).toBeGreaterThan(0);
  });

  it('dashboard: scoped roles see their areas, tenant-wide roles can filter by area', async () => {
    const submitted = async (who: Who, q = '') => {
      const r = await api[who].get(`/api/dashboard?from=2000-01-01&to=2099-12-31${q}`);
      expect(r.status).toBe(200);
      return r.body.submitted as number;
    };
    expect(await submitted('triageAll')).toBe(5);
    expect(await submitted('triageNord')).toBe(2);
    expect(await submitted('triageSued')).toBe(3);
    expect(await submitted('triageAll', `&areaId=${sued}`)).toBe(3);
    // A scoped person cannot pick an area outside the own scope.
    expect(await submitted('triageNord', `&areaId=${sued}`)).toBe(0);
    const areas = await api.triageNord.get('/api/dashboard/areas');
    expect(areas.body).toEqual({ items: [{ id: nord, name: 'Werk Nord' }], restricted: true });
    expect((await api.triageAll.get('/api/dashboard/areas')).body.items).toHaveLength(2);
    expect((await api.triageNord.get('/api/dashboard/challenges?from=2000-01-01&to=2099-12-31')).status).toBe(200);
    expect((await api.erika.get('/api/dashboard')).status).toBe(403);
  });
});

describe('group → role + area from the identity provider (AP-11)', () => {
  it('maps groups to scoped roles; only triage, committee and lead can be scoped', async () => {
    expect(groupRoleSchema.safeParse({ group: 'g', roles: ['admin'], areaId: nord }).success).toBe(false);
    expect(groupRoleSchema.safeParse({ group: 'g', roles: ['triage'], areaId: nord }).success).toBe(true);
    expect(scopedRolesFromGroups([{ group: 'GRP-Triage-Nord', roles: ['triage'], areaId: nord }, { group: 'GRP-Triage', roles: ['triage'] }], ['grp-triage-nord']))
      .toEqual([{ role: 'triage', areaId: nord }]);
  });

  it('syncs scoped roles of managed accounts and keeps manual ones', async () => {
    const u = await createUser(tenant, 'scim@bereiche.example', ['submitter'], 'Zentrale');
    await withTenant(tenant, async (db) => {
      await db.query(`INSERT INTO tenant_identity (tenant_id, group_roles) VALUES ($1, $2)`, [tenant, JSON.stringify([
        { group: 'GRP-Triage-Sued', roles: ['triage'], areaId: sued },
        { group: 'GRP-Gremium', roles: ['committee'] },
      ])]);
      await db.query("UPDATE users SET idp_managed = true, idp_groups = ARRAY['GRP-Triage-Sued', 'GRP-Gremium'] WHERE id = $1", [u.id]);
      await db.query("INSERT INTO role_assignments (tenant_id, user_id, role, area_id) VALUES ($1, $2, 'lead', $3)", [tenant, u.id, nord]);
      const cfg = await loadIdentity(db, tenant);
      expect(await syncRoles(db, cfg, u.id)).toEqual(['submitter', 'committee']);
      const rows = (await db.query('SELECT role, area_id, source FROM role_assignments WHERE user_id = $1 ORDER BY role', [u.id])).rows;
      expect(rows).toEqual([{ role: 'lead', area_id: nord, source: 'manual' }, { role: 'triage', area_id: sued, source: 'idp' }]);
      // Group removed in the directory: the scoped role goes, the manual one stays.
      await db.query("UPDATE users SET idp_groups = ARRAY['GRP-Gremium'] WHERE id = $1", [u.id]);
      await syncRoles(db, cfg, u.id);
      expect((await db.query('SELECT role FROM role_assignments WHERE user_id = $1', [u.id])).rows).toEqual([{ role: 'lead' }]);
    });
  });
});

describe('co-determination overview shows scoped roles (R3-12)', () => {
  it('lists the areas with the number of people per scoped role', async () => {
    const res = await api.council.get('/api/codetermination');
    expect(res.status).toBe(200);
    const n = res.body.scopedRoles.areas.find((a: { id: string }) => a.id === nord);
    expect(n.orgUnits).toEqual(['Werk Nord']);
    expect(n.roles.find((r: { role: string }) => r.role === 'triage').people).toBe(1);
    expect(n.roles.find((r: { role: string }) => r.role === 'committee').people).toBe(1);
    expect(res.body.scopedRoles.roles.map((r: { role: string }) => r.role)).toEqual(['triage', 'committee', 'lead']);
    expect(res.body.history.some((h: { action: string }) => h.action === 'area.create')).toBe(true);
  });

  it('the generated works agreement lists the areas with their scoped roles', async () => {
    const md = await app.inject({ method: 'GET', url: '/api/codetermination/agreements/betriebsvereinbarung?format=md', headers: { cookie: councilCookie } });
    expect(md.statusCode).toBe(200);
    expect(md.body).toContain('| Werk Nord | Einheiten: Werk Nord | Triage: 1, Gremium: 1');
  });
});

describe('two tenants', () => {
  it('areas and scoped roles stay in their tenant', async () => {
    expect((await api.otherAdmin.get('/api/admin/areas')).body).toEqual([]);
    expect((await api.otherAdmin.put(`/api/admin/areas/${nord}`, { name: 'Gekapert' })).status).toBe(404);
    expect((await api.otherAdmin.del(`/api/admin/areas/${nord}`)).status).toBe(404);
    // An area of another tenant cannot be assigned.
    expect((await api.otherAdmin.patch(`/api/admin/users/${users.otherAdmin.id}`, { scopedRoles: [{ role: 'triage', areaId: nord }] })).status).toBe(400);
    await withTenant(other, async (db) => {
      expect((await db.query('SELECT * FROM areas')).rowCount).toBe(0);
      expect((await db.query('SELECT * FROM role_assignments')).rowCount).toBe(0);
    });
    // Even the owner connection cannot point a role at an area of another tenant (composite key).
    await expect(withSystem((c) => c.query("INSERT INTO role_assignments (tenant_id, user_id, role, area_id) VALUES ($1, $2, 'triage', $3)",
      [other, users.otherAdmin.id, nord]))).rejects.toThrow();
  });
});

describe('rights helpers', () => {
  const base: SessionUser = { id: 'u', tenantId: 't', email: '', displayName: '', orgUnit: null, roles: ['submitter', 'triage', 'lead'], mfaEnabled: false, scopes: { triage: ['a1', 'a2'] } };
  it('drops scoped roles outside the idea areas and keeps tenant-wide roles', () => {
    expect(restrictToAreas(base, ['a2']).roles).toEqual(['submitter', 'triage', 'lead']);
    expect(restrictToAreas(base, ['a3']).roles).toEqual(['submitter', 'lead']);
    expect(scopeAreas(base, ['triage'])).toEqual(['a1', 'a2']);
    expect(scopeAreas(base, ['triage', 'lead'])).toBeNull();
  });
});
