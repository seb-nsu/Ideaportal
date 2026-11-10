import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, withSystem, withTenant } from '../src/db/pool.js';
import { LEARNING_CLUSTERS, seedLearningData } from '../src/db/learning-data.js';
import { runAllJobs } from '../src/jobs/deadlines.js';
import type { SessionUser } from '../src/lib/context.js';
import { setConnectorHttp } from '../src/services/connectors.js';
import { countRequest, parseCount, type HttpRequest, type HttpResponse } from '../src/services/connectorKinds.js';
import { quantile, spread } from '../src/services/learning.js';
import { addDays } from '../src/services/impactMetrics.js';
import { client, createTenant, createUser, login, resetDb, testApp, validIdea } from './helpers.js';

// AP-28 Wirkung und Lernen: metrics before and after with automatic measurement through a fake
// connector and values from an API token (R4-04), report draft for Gate 3, effort estimate
// from similar implemented ideas from 5 references on (R4-06), calibration with deviation
// report, correction factors and the hit band in the committee pack from 20 closed ideas on
// (R4-07). Two tenants (row-level security); the closed ideas come from the test-data generator.

const BASE = 'https://93.184.216.34';
const SUBMIT = { confirmNotReport: true, boundaryAcknowledged: true };
const cluster = LEARNING_CLUSTERS[0];

let app: FastifyInstance;
let tenant: string;
let other: string;
let small: string;
let users: Record<string, SessionUser>;
let anna: ReturnType<typeof client>;
let max: ReturnType<typeof client>;
let mia: ReturnType<typeof client>;
let olaf: ReturnType<typeof client>;
let otto: ReturnType<typeof client>;
let bea: ReturnType<typeof client>;
let carl: ReturnType<typeof client>;
let today: string;

// ---------------------------------------------------------------- fake Jira

const requests: HttpRequest[] = [];
async function fakeApi(req: HttpRequest): Promise<HttpResponse> {
  requests.push(req);
  const url = new URL(req.url);
  if (req.method === 'POST' && url.pathname === '/rest/api/3/search/approximate-count') {
    const jql = JSON.parse(req.body ?? '{}').jql as string;
    // Baseline period in January: 120 tickets; after the implementation: 80.
    return { status: 200, json: { count: jql.includes('2026-01-01') ? 120 : 80 } };
  }
  if (req.method === 'GET') return { status: 200, json: {} };
  return { status: 404, json: null };
}

function bearer(token: string) {
  return async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, payload: payload as object | undefined, headers: { authorization: `Bearer ${token}` } });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
}

/** Idea in elaboration with mentor max (Gate 2 not decided yet). */
async function elaborationIdea(as: ReturnType<typeof client>, tenantId: string, mentorId: string | null, text = cluster): Promise<string> {
  const created = await as.post('/api/ideas', { ...validIdea, title: text.title, problem: text.problem, solution: text.solution });
  expect(created.status).toBe(201);
  const id = created.body.id as string;
  expect((await as.post(`/api/ideas/${id}/submit`, SUBMIT)).status).toBe(200);
  await withSystem((c) => c.query(`UPDATE ideas SET status = 'elaboration', mentor_id = $2, plan_benefit_euro = 50000 WHERE id = $1 AND tenant_id = $3`, [id, mentorId, tenantId]));
  return id;
}

/** Gate 2 decided: implementing with owner otto. */
async function toImplementing(id: string, tenantId: string, ownerId: string): Promise<void> {
  await withSystem(async (c) => {
    await c.query(`UPDATE ideas SET status = 'implementing' WHERE id = $1`, [id]);
    await c.query(
      `INSERT INTO implementations (tenant_id, idea_id, owner_id, channel, target_date, status, accepted_at) VALUES ($1, $2, $3, 'project', '2027-06-30', 'active', now())`,
      [tenantId, id, ownerId],
    );
  });
}

const seed = (tenantId: string, count: number, s: number) =>
  withSystem((c) => seedLearningData(c, tenantId, { count, authorId: users.anna.id, today, seed: s }));

beforeAll(async () => {
  await resetDb();
  setConnectorHttp(fakeApi);
  app = await testApp();
  tenant = await createTenant('lern-a', { holidays: [] });
  other = await createTenant('lern-b', { holidays: [] });
  small = await createTenant('lern-c', { holidays: [] });
  users = {
    anna: await createUser(tenant, 'anna@a.example', ['submitter', 'admin', 'triage', 'committee']),
    max: await createUser(tenant, 'max@a.example', ['submitter', 'mentor']),
    mia: await createUser(tenant, 'mia@a.example', ['submitter']),
    olaf: await createUser(tenant, 'olaf@a.example', ['submitter']),
    otto: await createUser(tenant, 'otto@a.example', ['submitter', 'implementer']),
    bea: await createUser(other, 'bea@b.example', ['submitter', 'admin', 'triage', 'committee']),
    carl: await createUser(small, 'carl@c.example', ['submitter', 'admin', 'triage', 'committee']),
  };
  anna = client(app, await login(app, 'lern-a', 'anna@a.example'));
  max = client(app, await login(app, 'lern-a', 'max@a.example'));
  mia = client(app, await login(app, 'lern-a', 'mia@a.example'));
  olaf = client(app, await login(app, 'lern-a', 'olaf@a.example'));
  otto = client(app, await login(app, 'lern-a', 'otto@a.example'));
  bea = client(app, await login(app, 'lern-b', 'bea@b.example'));
  carl = client(app, await login(app, 'lern-c', 'carl@c.example'));
  // Tenant C has the team package: no connectors, but the API.
  await withSystem((c) => c.query(
    `INSERT INTO tenant_plans (tenant_id, plan, status, employees, feature_overrides) VALUES ($1, 'team', 'active', 300, '{"api": true}')`, [small],
  ));
  today = (await withSystem((c) => c.query<{ d: string }>(`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d`))).rows[0].d;
});

afterAll(async () => {
  setConnectorHttp();
  await app.close();
  await closePool();
});

describe('statistics and request shapes', () => {
  it('computes quantiles and spreads', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(spread([4, 1, 3, 2])).toEqual({ low: 1.75, median: 2.5, high: 3.25, min: 1, max: 4 });
    expect(spread([])).toBeNull();
  });

  it('builds count requests for Jira, ServiceNow and Azure DevOps', () => {
    const cfg = { project: 'INNO', itemType: 'incident', storyType: 'x', parentField: 'parent', fieldMap: [], statusMap: [], poll: false };
    const jira = countRequest({ kind: 'jira', baseUrl: BASE, config: cfg }, 'project = SUP');
    expect(jira).toMatchObject({ method: 'POST', url: `${BASE}/rest/api/3/search/approximate-count` });
    expect(parseCount({ kind: 'jira', baseUrl: BASE, config: cfg }, { status: 200, json: { count: 7 } })).toBe(7);
    const sn = countRequest({ kind: 'servicenow', baseUrl: BASE, config: cfg }, 'active=true');
    expect(sn.url).toBe(`${BASE}/api/now/stats/incident?sysparm_count=true&sysparm_query=active%3Dtrue`);
    expect(parseCount({ kind: 'servicenow', baseUrl: BASE, config: cfg }, { status: 200, json: { result: { stats: { count: '12' } } } })).toBe(12);
    const ado = countRequest({ kind: 'azure_devops', baseUrl: BASE, config: cfg }, 'SELECT [System.Id] FROM WorkItems');
    expect(ado.url).toBe(`${BASE}/INNO/_apis/wit/wiql?api-version=7.1`);
    expect(parseCount({ kind: 'azure_devops', baseUrl: BASE, config: cfg }, { status: 200, json: { workItems: [{ id: 1 }, { id: 2 }] } })).toBe(2);
    expect(parseCount({ kind: 'azure_devops', baseUrl: BASE, config: cfg }, { status: 200, json: {} })).toBeNull();
  });
});

describe('R4-06 effort estimate and R4-07 calibration with thresholds', () => {
  let ideaA: string;
  let ideaB: string;

  it('says "not enough data yet" without closed ideas', async () => {
    ideaA = await elaborationIdea(mia, tenant, users.max.id);
    ideaB = await elaborationIdea(bea, other, null);
    const est = await max.get(`/api/ideas/${ideaA}/effort-estimate`);
    expect(est.status).toBe(200);
    expect(est.body).toMatchObject({ enough: false, minReferences: 5, references: [], range: null });
    const cal = await anna.get('/api/calibration');
    expect(cal.body).toEqual({ closed: 0, minClosed: 20, minGroup: 5, tolerancePercent: 20, enough: false });
  });

  it('shows references but no range below 5 references', async () => {
    await seed(tenant, 4, 1);
    const est = await max.get(`/api/ideas/${ideaA}/effort-estimate`);
    expect(est.body.enough).toBe(false);
    expect(est.body.references.length).toBeGreaterThan(0);
    expect(est.body.references.length).toBeLessThan(5);
    expect(est.body.range).toBeNull();
  });

  it('only the patron, triage, committee and leads see the estimate', async () => {
    expect((await olaf.get(`/api/ideas/${ideaA}/effort-estimate`)).status).toBe(403);
    // The author edits the dossier during elaboration and may see it.
    expect((await mia.get(`/api/ideas/${ideaA}/effort-estimate`)).status).toBe(200);
  });

  it('gives a range from 5 references, with the most similar idea first', async () => {
    await seed(tenant, 15, 2);
    const est = await max.get(`/api/ideas/${ideaA}/effort-estimate`);
    expect(est.body.enough).toBe(true);
    expect(est.body.references.length).toBeGreaterThanOrEqual(5);
    expect(est.body.references[0].title).toContain(cluster.title);
    expect(est.body.references[0]).toMatchObject({ actual: true });
    const r = est.body.range.personDays;
    expect(r.low).toBeLessThanOrEqual(r.median);
    expect(r.median).toBeLessThanOrEqual(r.high);
    expect(est.body.range.euro.median).toBeGreaterThan(0);
  });

  it('keeps the calibration closed with 19 closed ideas', async () => {
    const cal = await anna.get('/api/calibration');
    expect(cal.body).toMatchObject({ closed: 19, enough: false });
    expect(cal.body.quarters).toBeUndefined();
    const meeting = await anna.post('/api/meetings', { title: 'Gremium Kalibrierung', meetsOn: addDays(today, 30) });
    expect(meeting.status).toBe(201);
    expect((await anna.post(`/api/meetings/${meeting.body.id}/items`, { ideaId: ideaA })).status).toBe(200);
    const pack = await anna.get(`/api/meetings/${meeting.body.id}`);
    expect(pack.body.calibration).toMatchObject({ enough: false, closed: 19, minClosed: 20 });
    expect(pack.body.items[0].calibration).toEqual({ enough: false });
  });

  it('opens the deviation report, correction factors and the hit band from 20 closed ideas', async () => {
    await seed(tenant, 1, 3);
    const cal = await anna.get('/api/calibration');
    expect(cal.status).toBe(200);
    expect(cal.body).toMatchObject({ closed: 20, enough: true });
    expect(cal.body.quarters.length).toBeGreaterThanOrEqual(4);
    for (const q of cal.body.quarters) {
      expect(q.quarter).toMatch(/^\d{4}-Q[1-4]$/);
      if (q.enough) expect(q).toHaveProperty('deviationPercent');
      else expect(q).not.toHaveProperty('plan');
    }
    const internal = cal.body.factors.find((f: { ideaType: string; ideaKind: string | null }) => f.ideaType === 'internal' && f.ideaKind === null);
    expect(internal).toMatchObject({ n: 11, enough: true });
    // Internal ideas of the generator reach 60-110 % of the forecast.
    expect(internal.factor).toBeGreaterThan(0.55);
    expect(internal.factor).toBeLessThan(1.15);
    expect(internal.effortFactor).toBeGreaterThan(1);
    expect(cal.body.bands.map((b: { ideaType: string }) => b.ideaType).sort()).toEqual(['internal', 'product']);
    // Aggregated only: no idea, title or person in the report.
    expect(JSON.stringify(cal.body)).not.toMatch(/anna|title|authorId|"id"/);

    const meetings = await anna.get('/api/meetings');
    const pack = await anna.get(`/api/meetings/${meetings.body.items[0].id}`);
    const item = pack.body.items[0];
    expect(item.calibration.enough).toBe(true);
    expect(item.calibration.band).toMatchObject({ ideaType: 'internal', n: 11 });
    expect(item.calibration.expected.low).toBeLessThanOrEqual(item.calibration.expected.high);
    expect(item.calibration.expected.median).toBe(Math.round(50000 * item.calibration.band.median));
  });

  it('keeps tenants apart and closes the report to submitters', async () => {
    const calB = await bea.get('/api/calibration');
    expect(calB.body).toMatchObject({ closed: 0, enough: false });
    const estB = await bea.get(`/api/ideas/${ideaB}/effort-estimate`);
    expect(estB.body.references).toEqual([]);
    expect((await mia.get('/api/calibration')).status).toBe(403);
    // Another tenant's idea is not found at all.
    expect((await bea.get(`/api/ideas/${ideaA}/effort-estimate`)).status).toBe(404);
  });
});

describe('R4-04 metrics before and after', () => {
  let idea: string;
  let connectorId: string;
  let jiraMetric: string;
  let apiMetric: string;

  it('fixes metrics at Gate 2 only, with a connector query', async () => {
    idea = await elaborationIdea(mia, tenant, users.max.id, LEARNING_CLUSTERS[1]);
    const c = await anna.post('/api/admin/connectors', {
      kind: 'jira', name: 'Jira Support', baseUrl: BASE, config: { project: 'SUP', itemType: 'Epic' }, credentials: { email: 'bot@firma.example', apiToken: 'jira-token-123' },
    });
    expect(c.status).toBe(201);
    connectorId = c.body.id;
    expect((await anna.post(`/api/admin/connectors/${connectorId}/enable`)).status).toBe(200);

    const list = await max.get(`/api/ideas/${idea}/impact-metrics`);
    expect(list.body.can).toEqual({ define: true, record: true });
    expect(list.body.connectors.map((x: { id: string }) => x.id)).toEqual([connectorId]);

    const payload = {
      name: 'Tickets zur Hotline', unit: 'Tickets', direction: 'decrease', source: 'connector', connectorId,
      query: 'project = SUP AND created >= "{from}" AND created <= "{to}"', baselineFrom: '2026-01-01', baselineTo: '2026-01-31',
    };
    expect((await olaf.post(`/api/ideas/${idea}/impact-metrics`, payload)).status).toBe(403);
    expect((await max.post(`/api/ideas/${idea}/impact-metrics`, { ...payload, connectorId: undefined })).status).toBe(400);
    expect((await max.post(`/api/ideas/${idea}/impact-metrics`, { ...payload, baselineTo: '2025-12-01' })).status).toBe(400);
    const created = await max.post(`/api/ideas/${idea}/impact-metrics`, payload);
    expect(created.status).toBe(201);
    jiraMetric = created.body.id;
    const manual = await max.post(`/api/ideas/${idea}/impact-metrics`, {
      name: 'Bearbeitungszeit je Anruf', unit: 'Minuten', direction: 'decrease', source: 'api', baselineFrom: '2026-01-01', baselineTo: '2026-01-31',
    });
    expect(manual.status).toBe(201);
    apiMetric = manual.body.id;

    // After the Gate 2 decision the metric is fixed.
    await toImplementing(idea, tenant, users.otto.id);
    expect((await max.post(`/api/ideas/${idea}/impact-metrics`, payload)).status).toBe(403);
    expect((await max.patch(`/api/ideas/${idea}/impact-metrics/${jiraMetric}`, { name: 'Anders' })).status).toBe(403);
    expect((await max.del(`/api/ideas/${idea}/impact-metrics/${jiraMetric}`)).status).toBe(403);
  });

  it('measures the baseline and, after go-live, the after-value automatically', async () => {
    await runAllJobs(today);
    let list = await max.get(`/api/ideas/${idea}/impact-metrics`);
    let jira = list.body.metrics.find((x: { id: string }) => x.id === jiraMetric);
    expect(jira.baseline).toMatchObject({ value: 120, periodFrom: '2026-01-01', periodTo: '2026-01-31', source: 'connector' });
    expect(jira.after).toBeNull();
    const countCall = requests.find((r) => r.url.endsWith('/approximate-count'))!;
    expect(JSON.parse(countCall.body!).jql).toBe('project = SUP AND created >= "2026-01-01" AND created <= "2026-01-31"');
    expect(countCall.headers.authorization).toMatch(/^Basic /);

    // Close the implementation (go-live) with actual effort.
    const closed = await otto.post(`/api/ideas/${idea}/implementation/close`, {
      benefitKind: 'euro', benefitValue: 42000, benefitEvidence: 'Weniger Tickets laut Auswertung.', actualEffortPersonDays: 12, actualEffortEuro: 9600,
    });
    expect(closed.status).toBe(200);
    const effort = await withTenant(tenant, async (db) => (await db.query('SELECT actual_effort_person_days AS d FROM implementations WHERE idea_id = $1', [idea])).rows[0]);
    expect(effort.d).toBe(12);

    // A full window of 31 days after go-live is needed.
    await runAllJobs(addDays(today, 10));
    list = await max.get(`/api/ideas/${idea}/impact-metrics`);
    expect(list.body.metrics.find((x: { id: string }) => x.id === jiraMetric).after).toBeNull();

    const later = addDays(today, 32);
    const res = await runAllJobs(later);
    expect(res!['lern-a'].metrics).toBe(1);
    list = await max.get(`/api/ideas/${idea}/impact-metrics`);
    jira = list.body.metrics.find((x: { id: string }) => x.id === jiraMetric);
    expect(jira.after).toMatchObject({ value: 80, periodTo: addDays(later, -1), periodFrom: addDays(later, -31) });
    expect(jira).toMatchObject({ change: -40, changePercent: -33.3, assessment: 'better', nextMeasureOn: addDays(later, 30) });
    // Not again before the interval is over.
    expect((await runAllJobs(later))!['lern-a'].metrics).toBe(0);
    // Tenant B has nothing of it.
    expect((await runAllJobs(later))!['lern-b'].metrics).toBe(0);
  });

  it('takes values from an API token and from people', async () => {
    const tok = await anna.post('/api/admin/api-tokens', { name: 'Telefonanlage', roles: ['implementer'] });
    expect(tok.status).toBe(201);
    const api = bearer(tok.body.token);
    const before = await api('POST', `/api/impact-metrics/${apiMetric}/values`, { period: 'baseline', value: 7.5 });
    expect(before.status).toBe(201);
    expect(before.body.source).toBe('api');
    expect((await api('POST', `/api/impact-metrics/${apiMetric}/values`, { period: 'after', value: 5, periodFrom: '2026-11-01', periodTo: '2026-11-30' })).status).toBe(201);
    // Connector metrics take no values from outside.
    expect((await api('POST', `/api/impact-metrics/${jiraMetric}/values`, { period: 'after', value: 1 })).status).toBe(409);
    // A token without a suitable role, and a person without a relation to the idea, are refused.
    const weak = await anna.post('/api/admin/api-tokens', { name: 'Nur lesen', roles: ['submitter'] });
    expect((await bearer(weak.body.token)('POST', `/api/impact-metrics/${apiMetric}/values`, { period: 'after', value: 1 })).status).toBe(403);
    expect((await olaf.post(`/api/impact-metrics/${apiMetric}/values`, { period: 'after', value: 1 })).status).toBe(403);
    // The implementation owner enters a value by hand.
    const manual = await otto.post(`/api/impact-metrics/${apiMetric}/values`, { period: 'after', value: 4.5, note: 'Stichprobe Dezember' });
    expect(manual.status).toBe(201);
    expect(manual.body.source).toBe('manual');
    // Tenant B cannot reach the metric, neither by token nor by session.
    const tokB = await bea.post('/api/admin/api-tokens', { name: 'Fremd', roles: ['implementer'] });
    expect((await bearer(tokB.body.token)('POST', `/api/impact-metrics/${apiMetric}/values`, { period: 'after', value: 1 })).status).toBe(404);
    expect((await bea.get(`/api/ideas/${idea}/impact-metrics`)).status).toBe(404);
    const rowsB = await withTenant(other, async (db) => (await db.query('SELECT count(*)::int AS n FROM impact_metric_values')).rows[0].n);
    expect(rowsB).toBe(0);
    const rowsA = await withTenant(tenant, async (db) => (await db.query('SELECT count(*)::int AS n FROM impact_metric_values')).rows[0].n);
    expect(rowsA).toBe(5);
  });

  it('drafts the Gate 3 report from the measured values', async () => {
    const r = await max.get(`/api/ideas/${idea}/impact-report`);
    expect(r.status).toBe(200);
    expect(r.body.metrics).toHaveLength(2);
    const api = r.body.metrics.find((x: { id: string }) => x.id === apiMetric);
    expect(api).toMatchObject({ assessment: 'better', change: -3 });
    expect(r.body.benefit).toEqual({ plan: 50000, actual: 42000, kind: 'euro' });
    expect(r.body.calibration.enough).toBe(true);
    expect(r.body.text).toContain('Tickets zur Hotline');
    expect(r.body.text).toContain('Vorher: 120 Tickets');
    expect(r.body.text).toContain('Nachher: 80 Tickets');
    expect(r.body.text).toContain('in die gewünschte Richtung');
    expect(r.body.text).toContain('Frühere Prognosen desselben Ideentyps');
  });

  it('needs the connectors feature for connector metrics', async () => {
    const id = await elaborationIdea(carl, small, null);
    const r = await carl.post(`/api/ideas/${id}/impact-metrics`, {
      name: 'Tickets', unit: 'Tickets', direction: 'decrease', source: 'connector', connectorId: '00000000-0000-4000-8000-000000000000',
      query: 'project = X', baselineFrom: '2026-01-01', baselineTo: '2026-01-31',
    });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('FEATURE_UNAVAILABLE');
    const list = await carl.get(`/api/ideas/${id}/impact-metrics`);
    expect(list.body).toMatchObject({ connectorsAvailable: false, connectors: [] });
    // Manual metrics work in every package.
    expect((await carl.post(`/api/ideas/${id}/impact-metrics`, {
      name: 'Durchlaufzeit', unit: 'Tage', direction: 'decrease', source: 'manual', baselineFrom: '2026-01-01', baselineTo: '2026-01-31',
    })).status).toBe(201);
  });
});
