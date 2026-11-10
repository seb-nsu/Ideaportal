import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withSystem, withTenant } from '../src/db/pool.js';
import type { Ctx, SessionUser } from '../src/lib/context.js';
import { isSealed } from '../src/lib/secretbox.js';
import { pollConnectors, setConnectorHttp } from '../src/services/connectors.js';
import { mapStatus, parseInbound, type HttpRequest, type HttpResponse } from '../src/services/connectorKinds.js';
import { generatePackage } from '../src/services/implpackage.js';
import { signPayload } from '../src/services/webhooks.js';
import { loadIdea } from '../src/services/workflow.js';
import { asUser, client, createTenant, createUser, login, resetDb, testApp, validIdea } from './helpers.js';

// AP-20 (R3-13 Jira, R3-14 ServiceNow, R3-15 Azure DevOps, R3-18 implementation package):
// connectors against fake APIs (no network), request shapes, status back into the
// implementation (R1-31) by callback (secret or API token) and polling, confidential ideas,
// audit and two tenants.

const BASE = 'https://93.184.216.34';
const SUBMIT = { confirmNotReport: true, boundaryAcknowledged: true };

let app: FastifyInstance;
let tenant: string;
let other: string;
let users: Record<string, SessionUser>;
let adminA: ReturnType<typeof client>;
let adminB: ReturnType<typeof client>;
let owner: ReturnType<typeof client>;
let mia: ReturnType<typeof client>;
let ownerB: ReturnType<typeof client>;

// ---------------------------------------------------------------- fake target systems

interface Fake {
  requests: HttpRequest[];
  status: string;
  fail: boolean;
}
const fake: Fake = { requests: [], status: 'In Progress', fail: false };
let counter = 100;

async function fakeApi(req: HttpRequest): Promise<HttpResponse> {
  fake.requests.push(req);
  if (fake.fail) throw new Error('connection refused');
  const url = new URL(req.url);
  const id = String(++counter);
  if (req.method === 'POST' && url.pathname === '/rest/api/3/issue') return { status: 201, json: { id, key: `INNO-${id}`, self: `${BASE}/rest/api/3/issue/${id}` } };
  if (req.method === 'POST' && url.pathname.startsWith('/api/now/table/')) return { status: 201, json: { result: { sys_id: `sys${id}`, number: `DMND00${id}` } } };
  if (req.method === 'POST' && url.pathname.includes('/_apis/wit/workitems/')) return { status: 200, json: { id: Number(id), url: `${BASE}/Proj/_apis/wit/workItems/${id}`, _links: { html: { href: `${BASE}/Proj/_workitems/edit/${id}` } } } };
  if (req.method === 'GET' && url.pathname.startsWith('/rest/api/3/issue/')) return { status: 200, json: { fields: { status: { name: fake.status, statusCategory: { key: 'indeterminate' } } } } };
  if (req.method === 'GET' && url.pathname.startsWith('/api/now/table/')) return { status: 200, json: { result: { state: fake.status } } };
  if (req.method === 'GET' && url.pathname.includes('/_apis/wit/workItems/')) return { status: 200, json: { id: 1, fields: { 'System.State': fake.status } } };
  if (req.method === 'GET') return { status: 200, json: {} };
  return { status: 404, json: null };
}

const body = (r: HttpRequest) => JSON.parse(r.body ?? 'null');

// ---------------------------------------------------------------- helpers

async function implementingIdea(title: string, opts: { confidential?: boolean; tenantId?: string; author?: ReturnType<typeof client>; ownerId?: string } = {}): Promise<string> {
  const author = opts.author ?? mia;
  const created = await author.post('/api/ideas', { ...validIdea, title, confidential: !!opts.confidential });
  expect(created.status).toBe(201);
  const id = created.body.id as string;
  expect((await author.post(`/api/ideas/${id}/submit`, SUBMIT)).status).toBe(200);
  const t = opts.tenantId ?? tenant;
  await withSystem(async (c) => {
    await c.query(`UPDATE ideas SET status = 'implementing' WHERE id = $1`, [id]);
    await c.query(
      `INSERT INTO implementations (tenant_id, idea_id, owner_id, channel, target_date, status, accepted_at) VALUES ($1, $2, $3, 'project', '2027-03-31', 'active', now())`,
      [t, id, opts.ownerId ?? users.owner.id],
    );
  });
  return id;
}

async function createConnector(as: ReturnType<typeof client>, payload: Record<string, unknown>) {
  const r = await as.post('/api/admin/connectors', payload);
  expect(r.status).toBe(201);
  return r.body as { id: string; callbackSecret: string; callbackUrl: string };
}

async function enabledConnector(payload: Record<string, unknown>, as = adminA) {
  const c = await createConnector(as, payload);
  expect((await as.post(`/api/admin/connectors/${c.id}/enable`)).status).toBe(200);
  return c;
}

const jiraPayload = (extra: Record<string, unknown> = {}) => ({
  kind: 'jira',
  name: 'Jira Produkt',
  baseUrl: BASE,
  config: { project: 'INNO', itemType: 'Epic', fieldMap: [{ source: 'number', target: 'customfield_10010' }, { source: 'targetDate', target: 'duedate' }] },
  credentials: { email: 'bot@firma.example', apiToken: 'jira-token-123' },
  ...extra,
});

async function progressOf(ideaId: string, t = tenant): Promise<{ progress: number; status: string; external_ref: string | null }> {
  return withTenant(t, async (db) => (await db.query('SELECT progress, status, external_ref FROM implementations WHERE idea_id = $1', [ideaId])).rows[0]);
}

async function auditActions(t: string, entityId: string): Promise<{ action: string; after: Record<string, unknown> }[]> {
  return withTenant(t, async (db) => (await db.query('SELECT action, after FROM audit_log WHERE entity_id = $1 ORDER BY created_at, id', [entityId])).rows);
}

async function callback(connectorId: string, payload: unknown, headers: Record<string, string>) {
  const raw = JSON.stringify(payload);
  const res = await app.inject({ method: 'POST', url: `/api/integrations/connectors/${connectorId}/status`, payload: raw, headers: { 'content-type': 'application/json', ...headers } });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

const hub = (secret: string, payload: unknown) => ({ 'x-hub-signature': `sha256=${createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex')}` });

beforeAll(async () => {
  await resetDb();
  app = await testApp();
  tenant = await createTenant('cona', { holidays: [] });
  other = await createTenant('conb', { holidays: [] });
  users = {
    admin: await createUser(tenant, 'admin@cona.example', ['submitter', 'admin']),
    owner: await createUser(tenant, 'owner@cona.example', ['submitter', 'implementer']),
    mia: await createUser(tenant, 'mia@cona.example'),
    adminB: await createUser(other, 'admin@conb.example', ['submitter', 'admin']),
    ownerB: await createUser(other, 'owner@conb.example', ['submitter', 'implementer']),
  };
  adminA = client(app, await login(app, 'cona', users.admin.email));
  adminB = client(app, await login(app, 'conb', users.adminB.email));
  owner = client(app, await login(app, 'cona', users.owner.email));
  mia = client(app, await login(app, 'cona', users.mia.email));
  ownerB = client(app, await login(app, 'conb', users.ownerB.email));
  // The quality gate of new agents is covered in ai-quality.test.ts; here the builtin provider answers directly.
  const current = (await adminA.get('/api/admin/ai')).body.settings;
  expect((await adminA.put('/api/admin/ai', { ...current, requireEval: false })).status).toBe(200);
  setConnectorHttp(fakeApi);
});

beforeEach(() => {
  fake.requests = [];
  fake.status = 'In Progress';
  fake.fail = false;
});

afterAll(async () => {
  setConnectorHttp();
  await app.close();
  await closePool();
});

// ---------------------------------------------------------------- framework

describe('connector configuration', () => {
  it('admins create a connector: switched off, secrets encrypted and never returned', async () => {
    const c = await createConnector(adminA, jiraPayload({ name: 'Jira Konfig' }));
    expect(c.callbackSecret).toMatch(/^cbsec_/);
    expect(c.callbackUrl).toContain(`/api/integrations/connectors/${c.id}/status`);
    const list = (await adminA.get('/api/admin/connectors')).body as Record<string, unknown>[];
    const row = list.find((x) => x.id === c.id)!;
    expect(row).toMatchObject({ kind: 'jira', enabled: false, hasCredentials: true });
    expect(JSON.stringify(list)).not.toContain('jira-token-123');
    expect(JSON.stringify(list)).not.toContain(c.callbackSecret);
    const stored = await withSystem(async (db) => (await db.query('SELECT credentials_enc, callback_secret_enc FROM connectors WHERE id = $1', [c.id])).rows[0]);
    expect(isSealed(stored.credentials_enc)).toBe(true);
    expect(isSealed(stored.callback_secret_enc)).toBe(true);
    expect(stored.credentials_enc).not.toContain('jira-token-123');
    expect((await auditActions(tenant, c.id)).map((a) => a.action)).toContain('connector.create');
  });

  it('accepts only https addresses outside the internal network', async () => {
    for (const baseUrl of ['http://93.184.216.34', 'https://10.0.0.5', 'https://localhost', 'https://user:pw@93.184.216.34']) {
      const r = await adminA.post('/api/admin/connectors', jiraPayload({ baseUrl }));
      expect(r.status, baseUrl).toBe(400);
      expect(r.body.code).toBe('CONNECTOR_URL');
    }
  });

  it('checks the target configuration per kind', async () => {
    expect((await adminA.post('/api/admin/connectors', jiraPayload({ config: { project: 'kein key' } }))).status).toBe(400);
    expect((await adminA.post('/api/admin/connectors', jiraPayload({ config: { project: 'INNO', itemType: 'Bug' } }))).status).toBe(400);
    expect((await adminA.post('/api/admin/connectors', { kind: 'servicenow', name: 'SN', baseUrl: BASE, config: { itemType: 'incident' } })).status).toBe(400);
    expect((await adminA.post('/api/admin/connectors', { kind: 'azure_devops', name: 'ADO', baseUrl: BASE, config: {} })).status).toBe(400);
    expect((await adminA.post('/api/admin/connectors', { ...jiraPayload(), credentials: { email: 'x@y.example' } })).status).toBe(400);
  });

  it('activation per click needs credentials; only admins manage connectors', async () => {
    const c = await createConnector(adminA, { kind: 'servicenow', name: 'SN ohne Zugang', baseUrl: BASE, config: { itemType: 'pm_project' } });
    const r = await adminA.post(`/api/admin/connectors/${c.id}/enable`);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('CONNECTOR_CREDENTIALS');
    expect((await adminA.patch(`/api/admin/connectors/${c.id}`, { credentials: { username: 'svc', password: 'geheim' } })).status).toBe(200);
    expect((await adminA.post(`/api/admin/connectors/${c.id}/enable`)).status).toBe(200);
    expect((await adminA.post(`/api/admin/connectors/${c.id}/disable`)).status).toBe(200);
    expect((await auditActions(tenant, c.id)).map((a) => a.action)).toEqual(['connector.create', 'connector.update', 'connector.enable', 'connector.disable']);
    expect((await mia.get('/api/admin/connectors')).status).toBe(403);
    expect((await owner.post('/api/admin/connectors', jiraPayload())).status).toBe(403);
  });

  it('connection test sends an authenticated read to the fake API', async () => {
    const c = await createConnector(adminA, jiraPayload({ name: 'Jira Test' }));
    const r = await adminA.post(`/api/admin/connectors/${c.id}/test`);
    expect(r.body).toEqual({ ok: true });
    expect(fake.requests[0]).toMatchObject({ method: 'GET', url: `${BASE}/rest/api/3/myself` });
    expect(fake.requests[0].headers.authorization).toBe(`Basic ${Buffer.from('bot@firma.example:jira-token-123').toString('base64')}`);
    fake.fail = true;
    expect((await adminA.post(`/api/admin/connectors/${c.id}/test`)).body).toEqual({ ok: false, reason: 'network' });
  });

  it('status mapping and inbound parsing per kind', () => {
    const map = [{ external: 'In Progress', progress: 50 }, { external: 'done', progress: 100 }];
    expect(mapStatus(map, ['in progress'])).toBe(50);
    expect(mapStatus(map, ['Erledigt', 'done'])).toBe(100);
    expect(mapStatus(map, ['Unbekannt'])).toBeNull();
    expect(parseInbound('jira', { webhookEvent: 'jira:issue_updated', issue: { id: '1', key: 'INNO-1', fields: { status: { name: 'Done', statusCategory: { key: 'done' } } } } })).toEqual({ ref: 'INNO-1', status: ['Done', 'done'] });
    expect(parseInbound('azure_devops', { eventType: 'workitem.updated', resource: { id: 9, workItemId: 42, fields: { 'System.State': { oldValue: 'New', newValue: 'Active' } } } })).toEqual({ ref: '42', status: ['Active'] });
    expect(parseInbound('servicenow', { externalId: 'abc', status: 'Completed' })).toEqual({ ref: 'abc', status: ['Completed'] });
    expect(parseInbound('servicenow', { foo: 1 })).toBeNull();
  });
});

// ---------------------------------------------------------------- R3-13 Jira

describe('Jira (R3-13)', () => {
  let conn: { id: string; callbackSecret: string };
  let ideaId: string;

  beforeAll(async () => {
    conn = await enabledConnector(jiraPayload());
    ideaId = await implementingIdea('Freigegebene Idee für Jira');
  });

  it('creates an epic with the mapped fields and stores the link on the idea', async () => {
    const view = (await owner.get(`/api/ideas/${ideaId}/handover`)).body;
    expect(view).toMatchObject({ canManage: true, allowed: true, confidential: false });
    expect(view.connectors.map((c: { id: string }) => c.id)).toContain(conn.id);

    const r = await owner.post(`/api/ideas/${ideaId}/handover`, { connectorId: conn.id });
    expect(r.status).toBe(200);
    expect(r.body.main.key).toMatch(/^INNO-\d+$/);
    expect(fake.requests).toHaveLength(1);
    const req = fake.requests[0];
    expect(req).toMatchObject({ method: 'POST', url: `${BASE}/rest/api/3/issue` });
    expect(req.headers.authorization).toBe(`Basic ${Buffer.from('bot@firma.example:jira-token-123').toString('base64')}`);
    const fields = body(req).fields;
    expect(fields.project).toEqual({ key: 'INNO' });
    expect(fields.issuetype).toEqual({ name: 'Epic' });
    expect(fields.summary).toBe('Freigegebene Idee für Jira');
    expect(fields.description.type).toBe('doc');
    expect(JSON.stringify(fields.description)).toContain(`/ideen/${ideaId}`);
    expect(fields.customfield_10010).toBeGreaterThan(0);
    expect(fields.duedate).toBe('2027-03-31');
    expect(JSON.stringify(fields)).not.toContain('mia');

    const impl = await progressOf(ideaId);
    expect(impl.external_ref).toBe(`Jira Produkt: ${r.body.main.key}`);
    const after = (await owner.get(`/api/ideas/${ideaId}/handover`)).body;
    expect(after.links).toHaveLength(1);
    expect(after.links[0]).toMatchObject({ role: 'main', externalKey: r.body.main.key, externalUrl: `${BASE}/browse/${r.body.main.key}` });
    const audits = await auditActions(tenant, ideaId);
    expect(audits.find((a) => a.action === 'connector.handover')!.after).toMatchObject({ connectorId: conn.id, kind: 'jira', createdMain: true, confidential: false });
    const detail = (await owner.get(`/api/ideas/${ideaId}`)).body;
    expect(detail.events.some((e: { kind: string }) => e.kind === 'handover')).toBe(true);
  });

  it('a second handover to the same connector is refused', async () => {
    const r = await owner.post(`/api/ideas/${ideaId}/handover`, { connectorId: conn.id });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('ALREADY_HANDED_OVER');
    expect(fake.requests).toHaveLength(0);
  });

  it('status flows back by Jira webhook with signature and moves the progress', async () => {
    const link = (await owner.get(`/api/ideas/${ideaId}/handover`)).body.links[0];
    const event = { webhookEvent: 'jira:issue_updated', issue: { id: '1', key: link.externalKey, fields: { status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } } } };
    const r = await callback(conn.id, event, hub(conn.callbackSecret, event));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ matched: true, progress: 50 });
    expect((await progressOf(ideaId)).progress).toBe(50);
    const audit = (await auditActions(tenant, ideaId)).find((a) => a.action === 'connector.status')!;
    expect(audit.after).toMatchObject({ progress: 50, status: 'In Progress', source: 'callback' });

    const done = { ...event, issue: { ...event.issue, fields: { status: { name: 'Done', statusCategory: { key: 'done' } } } } };
    expect((await callback(conn.id, done, hub(conn.callbackSecret, done))).body.progress).toBe(100);
    const impl = await progressOf(ideaId);
    expect(impl).toMatchObject({ progress: 100, status: 'active' }); // closing needs the actual benefit (R1-32)
    const mails = await withTenant(tenant, async (db) => (await db.query('SELECT user_id FROM outbox WHERE idea_id = $1 AND subject LIKE $2', [ideaId, 'Erledigt im Zielsystem%'])).rows);
    expect(mails.map((x) => x.user_id)).toEqual([users.owner.id]);
  });

  it('refuses callbacks without or with a wrong signature', async () => {
    const event = { issue: { key: 'INNO-1', fields: { status: { name: 'Done' } } } };
    expect((await callback(conn.id, event, {})).status).toBe(401);
    expect((await callback(conn.id, event, hub('falsches-geheimnis', event))).status).toBe(401);
    expect((await callback(conn.id, event, { 'x-hub-signature': 'sha256=00' })).status).toBe(401);
    expect((await callback(conn.id, event, { 'x-ideenportal-signature': signPayload(conn.callbackSecret, Math.floor(Date.now() / 1000) - 3600, JSON.stringify(event)) })).status).toBe(401);
    expect((await callback('00000000-0000-4000-8000-000000000000', event, hub(conn.callbackSecret, event))).status).toBe(404);
  });

  it('accepts an API token of the tenant with an implementation role (AP-12)', async () => {
    const id = await implementingIdea('Jira per Token');
    const handed = (await owner.post(`/api/ideas/${id}/handover`, { connectorId: conn.id })).body;
    const tokenOk = (await adminA.post('/api/admin/api-tokens', { name: 'Jira Rückkanal', roles: ['implementer'] })).body.token;
    const tokenWeak = (await adminA.post('/api/admin/api-tokens', { name: 'Nur Einreichen', roles: ['submitter'] })).body.token;
    const tokenB = (await adminB.post('/api/admin/api-tokens', { name: 'Fremder Mandant', roles: ['implementer'] })).body.token;
    const event = { externalId: handed.main.key, status: 'In Review' };
    expect((await callback(conn.id, event, { authorization: `Bearer ${tokenWeak}` })).status).toBe(401);
    expect((await callback(conn.id, event, { authorization: `Bearer ${tokenB}` })).status).toBe(401);
    expect((await callback(conn.id, event, { authorization: 'Bearer ipt_000000000000_abcdefghijklmnopqrstuvwxyz' })).status).toBe(401);
    const r = await callback(conn.id, event, { authorization: `Bearer ${tokenOk}` });
    expect(r.status).toBe(200);
    expect((await progressOf(id)).progress).toBe(80);
  });

  it('polling asks Jira for the status of ongoing implementations', async () => {
    await adminA.patch(`/api/admin/connectors/${conn.id}`, { config: { poll: true } });
    const id = await implementingIdea('Jira per Abfrage');
    await owner.post(`/api/ideas/${id}/handover`, { connectorId: conn.id });
    fake.requests = [];
    fake.status = 'To Do';
    const r = await asUser(null, tenant, (ctx) => pollConnectors(ctx));
    expect(r.errors).toBe(0);
    expect(fake.requests.every((q) => q.method === 'GET' && /\/rest\/api\/3\/issue\/INNO-\d+\?fields=status$/.test(q.url))).toBe(true);
    expect((await progressOf(id)).progress).toBe(10);
    await adminA.patch(`/api/admin/connectors/${conn.id}`, { config: { poll: false } });
  });

  it('only the owner, the deputy or triage hand over; only after Gate 2; only active connectors', async () => {
    const id = await implementingIdea('Rechte bei der Übergabe');
    expect((await mia.post(`/api/ideas/${id}/handover`, { connectorId: conn.id })).status).toBe(403);
    expect((await mia.get(`/api/ideas/${id}/handover`)).body).toMatchObject({ canManage: false, connectors: [] });
    const draft = (await mia.post('/api/ideas', { ...validIdea, title: 'Noch nicht freigegeben' })).body.id;
    await mia.post(`/api/ideas/${draft}/submit`, SUBMIT);
    expect((await adminA.post(`/api/ideas/${draft}/handover`, { connectorId: conn.id })).status).toBe(409);
    const off = await createConnector(adminA, jiraPayload({ name: 'Jira aus' }));
    const r = await owner.post(`/api/ideas/${id}/handover`, { connectorId: off.id });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('CONNECTOR_DISABLED');
    expect(fake.requests).toHaveLength(0);
  });

  it('a failing target system creates nothing and the attempt stays in the audit log', async () => {
    const id = await implementingIdea('Ziel nicht erreichbar');
    fake.fail = true;
    const r = await owner.post(`/api/ideas/${id}/handover`, { connectorId: conn.id });
    expect(r.status).toBe(502);
    expect(r.body.code).toBe('CONNECTOR_FAILED');
    expect((await owner.get(`/api/ideas/${id}/handover`)).body.links).toHaveLength(0);
    const audits = await auditActions(tenant, id);
    expect(audits.find((a) => a.action === 'connector.handover_failed')!.after).toMatchObject({ reason: 'network', connectorId: conn.id });
  });
});

// ---------------------------------------------------------------- R3-14 ServiceNow

describe('ServiceNow (R3-14)', () => {
  it('creates a demand with a link back, takes the status from the callback and from polling', async () => {
    const conn = await enabledConnector({ kind: 'servicenow', name: 'ServiceNow Demand', baseUrl: BASE, config: { itemType: 'dmn_demand', fieldMap: [{ source: 'benefit', target: 'u_benefit' }] }, credentials: { username: 'svc.ideen', password: 'geheim-123' } });
    const id = await implementingIdea('Freigegebene Idee für ServiceNow');
    const r = await owner.post(`/api/ideas/${id}/handover`, { connectorId: conn.id });
    expect(r.status).toBe(200);
    const req = fake.requests[0];
    expect(req).toMatchObject({ method: 'POST', url: `${BASE}/api/now/table/dmn_demand` });
    expect(req.headers.authorization).toBe(`Basic ${Buffer.from('svc.ideen:geheim-123').toString('base64')}`);
    const record = body(req);
    expect(record).toMatchObject({ short_description: 'Freigegebene Idee für ServiceNow', correlation_id: id, u_benefit: validIdea.benefit });
    expect(record.correlation_display).toMatch(/^Ideenportal #\d+$/);
    expect(record.description).toContain(`/ideen/${id}`);
    // Both directions: the portal stores sys_id and link, ServiceNow holds the portal id and link.
    expect(r.body.main.id).toMatch(/^sys\d+$/);
    expect(r.body.main.url).toContain('nav_to.do?uri=dmn_demand.do');

    const event = { externalId: r.body.main.id, status: 'Work in Progress' };
    const raw = JSON.stringify(event);
    const signed = { 'x-ideenportal-signature': signPayload(conn.callbackSecret, Math.floor(Date.now() / 1000), raw) };
    expect((await callback(conn.id, event, signed)).body).toMatchObject({ matched: true, progress: 50 });
    expect((await progressOf(id)).progress).toBe(50);

    fake.requests = [];
    fake.status = 'Completed';
    const polled = await adminA.post(`/api/admin/connectors/${conn.id}/poll`);
    expect(polled.body).toMatchObject({ checked: 1, updated: 1, errors: 0 });
    expect(fake.requests[0].url).toBe(`${BASE}/api/now/table/dmn_demand/${r.body.main.id}?sysparm_fields=state&sysparm_display_value=true`);
    expect((await progressOf(id)).progress).toBe(100);
    const audit = (await auditActions(tenant, id)).filter((a) => a.action === 'connector.status').at(-1)!;
    expect(audit.after).toMatchObject({ source: 'poll', status: 'Completed' });
  });

  it('creates a project in pm_project when configured', async () => {
    const conn = await enabledConnector({ kind: 'servicenow', name: 'ServiceNow Projekt', baseUrl: BASE, config: { itemType: 'pm_project' }, credentials: { username: 'svc', password: 'pw' } });
    const id = await implementingIdea('Idee als Projekt');
    expect((await owner.post(`/api/ideas/${id}/handover`, { connectorId: conn.id })).status).toBe(200);
    expect(fake.requests[0].url).toBe(`${BASE}/api/now/table/pm_project`);
  });
});

// ---------------------------------------------------------------- R3-15 Azure DevOps and R3-18 package

describe('Azure DevOps (R3-15) and implementation package (R3-18)', () => {
  let conn: { id: string; callbackSecret: string };
  let ideaId: string;

  beforeAll(async () => {
    conn = await enabledConnector({ kind: 'azure_devops', name: 'Azure DevOps', baseUrl: `${BASE}/firma`, config: { project: 'Proj', itemType: 'Feature', storyType: 'User Story', fieldMap: [{ source: 'targetDate', target: 'Microsoft.VSTS.Scheduling.TargetDate' }] }, credentials: { pat: 'ado-pat-xyz' } });
    ideaId = await implementingIdea('Freigegebene Idee für Azure DevOps');
  });

  it('owner generates an editable package with the builtin provider; AI action is logged', async () => {
    expect((await mia.post(`/api/ideas/${ideaId}/package/generate`, {})).status).toBe(403);
    expect((await owner.get(`/api/ideas/${ideaId}/package`)).status).toBe(404);
    const r = await owner.post(`/api/ideas/${ideaId}/package/generate`, {});
    expect(r.status).toBe(200);
    expect(r.body.source).toBe('ai');
    expect(r.body.version).toBe(1);
    expect(r.body.brief.goal.length).toBeGreaterThan(0);
    expect(r.body.brief.milestones).toContain('31.3.2027');
    expect(r.body.stories.length).toBeGreaterThanOrEqual(2);
    expect(r.body.stories.at(-1).title).toBe('Wirkung messen');
    const action = await withTenant(tenant, async (db) => (await db.query('SELECT agent, provider, local, status FROM ai_actions WHERE id = $1', [r.body.aiActionId])).rows[0]);
    expect(action).toEqual({ agent: 'implementation_package', provider: 'builtin', local: true, status: 'ok' });

    const edited = { ...r.body, stories: [{ title: 'Schnittstelle bauen', description: 'Als Team möchte ich eine Schnittstelle.', acceptance: ['Daten kommen an'] }, { title: 'Einführung', description: 'Schulung der Teams.', acceptance: [] }] };
    const saved = await owner.put(`/api/ideas/${ideaId}/package`, { brief: { ...r.body.brief, scope: 'Nur Standort Nord.' }, stories: edited.stories, version: 1 });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ source: 'human', version: 2 });
    expect(saved.body.brief.scope).toBe('Nur Standort Nord.');
    expect((await owner.put(`/api/ideas/${ideaId}/package`, { brief: r.body.brief, stories: edited.stories, version: 1 })).status).toBe(409);
    const again = await owner.post(`/api/ideas/${ideaId}/package/generate`, {});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('PACKAGE_EDITED');
    expect((await auditActions(tenant, ideaId)).map((a) => a.action)).toEqual(expect.arrayContaining(['package.generate', 'package.update']));
  });

  it('exports the package as Markdown and PDF', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/ideas/${ideaId}/package/export?format=md` })).statusCode).toBe(401);
    const cookie = await login(app, 'cona', users.owner.email);
    const mdRes = await app.inject({ method: 'GET', url: `/api/ideas/${ideaId}/package/export?format=md`, headers: { cookie } });
    expect(mdRes.statusCode).toBe(200);
    expect(mdRes.headers['content-type']).toContain('text/markdown');
    expect(mdRes.body).toContain('## Projektsteckbrief');
    expect(mdRes.body).toContain('### 1. Schnittstelle bauen');
    expect(mdRes.body).toContain('- Daten kommen an');
    const pdf = await app.inject({ method: 'GET', url: `/api/ideas/${ideaId}/package/export?format=pdf`, headers: { cookie } });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('hands over a work item with the stories as child items (JSON Patch)', async () => {
    const r = await owner.post(`/api/ideas/${ideaId}/handover`, { connectorId: conn.id, withPackage: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ createdMain: true, stories: 2, failed: [] });
    expect(fake.requests).toHaveLength(3);
    const main = fake.requests[0];
    expect(main.url).toBe(`${BASE}/firma/Proj/_apis/wit/workitems/%24Feature?api-version=7.1`);
    expect(main.headers['content-type']).toBe('application/json-patch+json');
    expect(main.headers.authorization).toBe(`Basic ${Buffer.from(':ado-pat-xyz').toString('base64')}`);
    const ops = body(main) as { op: string; path: string; value: unknown }[];
    expect(ops.every((o) => o.op === 'add')).toBe(true);
    expect(ops.find((o) => o.path === '/fields/System.Title')!.value).toBe('Freigegebene Idee für Azure DevOps');
    expect(String(ops.find((o) => o.path === '/fields/System.Description')!.value)).toContain('<p>Umfang<br>Nur Standort Nord.</p>');
    expect(ops.find((o) => o.path === '/fields/Microsoft.VSTS.Scheduling.TargetDate')!.value).toBe('2027-03-31');
    expect(ops).toContainEqual({ op: 'add', path: '/relations/-', value: { rel: 'Hyperlink', url: expect.stringContaining(`/ideen/${ideaId}`) } });
    const story = fake.requests[1];
    expect(story.url).toBe(`${BASE}/firma/Proj/_apis/wit/workitems/%24User%20Story?api-version=7.1`);
    const storyOps = body(story) as { path: string; value: { rel?: string; url?: string } }[];
    expect(storyOps).toContainEqual({ op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `${BASE}/firma/Proj/_apis/wit/workItems/${r.body.main.id}` } });
    expect(storyOps.find((o) => o.path === '/fields/System.Title')!.value).toBe('Schnittstelle bauen');
    const links = (await owner.get(`/api/ideas/${ideaId}/handover`)).body.links;
    expect(links.map((l: { role: string; storyIndex: number }) => `${l.role}${l.storyIndex}`)).toEqual(['main-1', 'story0', 'story1']);
  });

  it('new stories are added later without a second main item', async () => {
    const pkg = (await owner.get(`/api/ideas/${ideaId}/package`)).body;
    await owner.put(`/api/ideas/${ideaId}/package`, { brief: pkg.brief, stories: [...pkg.stories, { title: 'Dokumentation', description: 'Handbuch schreiben.', acceptance: [] }], version: pkg.version });
    fake.requests = [];
    const r = await owner.post(`/api/ideas/${ideaId}/handover`, { connectorId: conn.id, withPackage: true });
    expect(r.body).toMatchObject({ createdMain: false, stories: 1 });
    expect(fake.requests).toHaveLength(1);
  });

  it('status comes back by service hook with basic authentication', async () => {
    const workItemId = (await owner.get(`/api/ideas/${ideaId}/handover`)).body.links.find((l: { role: string }) => l.role === 'main').externalKey;
    const hook = { eventType: 'workitem.updated', resource: { id: 7, workItemId: Number(workItemId), fields: { 'System.State': { oldValue: 'New', newValue: 'Active' } } } };
    const basic = (secret: string) => ({ authorization: `Basic ${Buffer.from(`ado:${secret}`).toString('base64')}` });
    expect((await callback(conn.id, hook, basic('falsch'))).status).toBe(401);
    expect((await callback(conn.id, hook, basic(conn.callbackSecret))).body).toMatchObject({ matched: true, progress: 50 });
    expect((await progressOf(ideaId)).progress).toBe(50);
    // A child item only records its status.
    const child = (await owner.get(`/api/ideas/${ideaId}/handover`)).body.links.find((l: { role: string }) => l.role === 'story').externalKey;
    const childHook = { eventType: 'workitem.updated', resource: { workItemId: Number(child), fields: { 'System.State': { newValue: 'Closed' } } } };
    expect((await callback(conn.id, childHook, basic(conn.callbackSecret))).body).toMatchObject({ matched: true, progress: 100 });
    expect((await progressOf(ideaId)).progress).toBe(50);
    // Unrelated events are acknowledged and ignored.
    expect((await callback(conn.id, { eventType: 'build.complete' }, basic(conn.callbackSecret))).body).toEqual({ ok: true, matched: false });
  });
});

// ---------------------------------------------------------------- confidential ideas

describe('confidential ideas', () => {
  it('leave the portal only with explicit confirmation, and the audit records it', async () => {
    const conn = await enabledConnector(jiraPayload({ name: 'Jira vertraulich' }));
    const id = await implementingIdea('Vertrauliche Umsetzung', { confidential: true });
    const refused = await owner.post(`/api/ideas/${id}/handover`, { connectorId: conn.id });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('CONFIDENTIAL_CONFIRM');
    expect(fake.requests).toHaveLength(0);
    const ok = await owner.post(`/api/ideas/${id}/handover`, { connectorId: conn.id, confirmConfidential: true });
    expect(ok.status).toBe(200);
    const audit = (await auditActions(tenant, id)).find((a) => a.action === 'connector.handover')!;
    expect(audit.after).toMatchObject({ confidential: true, confirmedConfidential: true });
  });

  it('the package of a confidential idea never goes to an external model', async () => {
    const id = await implementingIdea('Vertrauliches Paket', { confidential: true });
    const external = (ctx: Ctx): Ctx => ({
      ...ctx,
      settings: {
        ...ctx.settings,
        ai: {
          ...ctx.settings.ai,
          providers: [...ctx.settings.ai.providers, { id: 'extern', name: 'Extern', kind: 'openai_compatible', baseUrl: 'https://model.example', hosting: 'eu', keySource: 'none' }],
          models: { ...ctx.settings.ai.models, deep: { provider: 'extern', model: 'extern-1' } },
        },
      },
    });
    const pkg = await asUser(users.owner, tenant, async (ctx) => generatePackage(external(ctx), await loadIdea(ctx, id), { replaceEdited: false }));
    const action = await withTenant(tenant, async (db) => (await db.query('SELECT provider, local, input FROM ai_actions WHERE id = $1', [pkg!.aiActionId])).rows[0]);
    expect(action).toMatchObject({ provider: 'builtin', local: true });
  });
});

// ---------------------------------------------------------------- two tenants

describe('tenant separation', () => {
  it('tenant B sees and uses nothing of tenant A', async () => {
    const a = await enabledConnector(jiraPayload({ name: 'Jira nur A' }));
    const ideaA = await implementingIdea('Idee in A für Trennung');
    await owner.post(`/api/ideas/${ideaA}/handover`, { connectorId: a.id });
    await owner.post(`/api/ideas/${ideaA}/package/generate`, {});

    expect((await adminB.get('/api/admin/connectors')).body).toEqual([]);
    expect((await adminB.patch(`/api/admin/connectors/${a.id}`, { name: 'Übernommen' })).status).toBe(404);
    expect((await adminB.post(`/api/admin/connectors/${a.id}/enable`)).status).toBe(404);
    expect((await adminB.post(`/api/admin/connectors/${a.id}/test`)).status).toBe(404);

    const ideaB = await implementingIdea('Idee in B', { tenantId: other, author: ownerB, ownerId: users.ownerB.id });
    const r = await ownerB.post(`/api/ideas/${ideaB}/handover`, { connectorId: a.id });
    expect(r.status).toBe(404);
    expect((await ownerB.get(`/api/ideas/${ideaA}/package`)).status).toBe(404);
    expect((await ownerB.get(`/api/ideas/${ideaA}/handover`)).status).toBe(404);

    const counts = await withTenant(other, async (db) => (await db.query(
      `SELECT (SELECT count(*)::int FROM connectors) AS c, (SELECT count(*)::int FROM connector_links) AS l, (SELECT count(*)::int FROM implementation_packages) AS p`,
    )).rows[0]);
    expect(counts).toEqual({ c: 0, l: 0, p: 0 });
    const inA = await withTenant(tenant, async (db) => (await db.query('SELECT count(*)::int AS n FROM connector_links WHERE idea_id = $1', [ideaA])).rows[0].n);
    expect(inA).toBe(1);
    // Writing a row for another tenant is refused by row-level security.
    await expect(withTenant(other, (db) => db.query(
      `INSERT INTO connectors (tenant_id, kind, name, base_url, callback_secret_enc) VALUES ($1, 'jira', 'x', 'https://x', 'v1.x')`, [tenant],
    ))).rejects.toThrow();

    // Polling of B's job does not touch A's connector.
    fake.requests = [];
    await adminA.patch(`/api/admin/connectors/${a.id}`, { config: { poll: true } });
    await asUser(null, other, (ctx) => pollConnectors(ctx));
    expect(fake.requests).toHaveLength(0);
  });
});
