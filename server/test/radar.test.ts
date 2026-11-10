import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setWebSearch, type WebHit } from '../src/ai/search.js';
import { drainAiJobs } from '../src/ai/worker.js';
import { closePool, withSystem, withTenant } from '../src/db/pool.js';
import type { SessionUser } from '../src/lib/context.js';
import { setConnectorHttp } from '../src/services/connectors.js';
import type { HttpRequest, HttpResponse } from '../src/services/connectorKinds.js';
import { enqueueWeeklyTrends, feedbackRows, isoWeek, redactPersonal } from '../src/services/radar.js';
import { asUser, client, createTenant, createUser, login, resetDb, testApp, validIdea } from './helpers.js';

// AP-27 "Erkennen": trend radar (R4-11), weekly trend hints with sources and unsubscribe
// (R4-02), white spots (R4-03) and the problem radar from a fake Jira and a CSV upload
// (R4-01): rights, two tenants, no person data in clusters, package feature.

const BASE = 'https://93.184.216.34';
const SUBMIT = { confirmNotReport: true, boundaryAcknowledged: true };
const TOPICS = ['Nachhaltigkeit', 'Falke Logistik', 'Kundenerlebnis', 'Arbeitsumfeld'];

let app: FastifyInstance;
let tenant: string;
let other: string;
let users: Record<string, SessionUser>;
let api: Record<string, ReturnType<typeof client>>;
let today: string;

const queries: string[] = [];
const HITS: WebHit[] = [
  { title: 'Wärmepumpen im Gewerbe', url: 'https://example.org/waermepumpen', snippet: 'Wärmepumpen senken den Energiebedarf von Hallen deutlich. Studie 2026.' },
  { title: 'Förderung für Wärmepumpen', url: 'https://example.org/foerderung', snippet: 'Neue Programme fördern Wärmepumpen in Betrieben.' },
  { title: 'Abwärme nutzen', url: 'https://example.org/abwaerme', snippet: 'Wärmepumpen und Abwärme aus Rechenzentren.' },
];

// Fake Jira: tickets with person fields that must never reach the portal.
const jiraRequests: HttpRequest[] = [];
const ISSUES = [
  ['VPN Verbindung bricht ständig ab', 'Seit dem Update bricht die VPN Verbindung im Homeoffice ab. Gemeldet von Erika Mustermann, erika.mustermann@radara.example, Tel. +49 170 1234567'],
  ['VPN Verbindung langsam', 'Die VPN Verbindung ist morgens sehr langsam. Reporter: Max Muster'],
  ['Keine VPN Verbindung möglich', 'Ich bekomme keine VPN Verbindung. Herr Schulze aus dem Einkauf hat das gleiche Problem.'],
  ['VPN Verbindung trennt', 'Die VPN Verbindung trennt nach zehn Minuten. @jonas bitte prüfen'],
  ['Drucker Papierstau', 'Der Drucker im zweiten Stock hat ständig Papierstau.'],
  ['Papierstau am Drucker', 'Wieder Papierstau am Drucker im Flur.'],
  ['Drucker meldet Papierstau', 'Der Drucker meldet Papierstau ohne Papier.'],
  ['Kaffeemaschine leer', 'Die Kaffeemaschine ist immer leer.'],
];

async function jiraFake(req: HttpRequest): Promise<HttpResponse> {
  jiraRequests.push(req);
  const url = new URL(req.url);
  if (req.method === 'GET' && url.pathname === '/rest/api/3/search/jql') {
    return {
      status: 200,
      json: {
        issues: ISSUES.map(([summary, text], i) => ({
          id: String(1000 + i),
          key: `SUP-${i + 1}`,
          fields: {
            summary,
            description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
            // Fields the portal never asked for and must drop:
            reporter: { displayName: 'Max Muster', emailAddress: 'max.muster@radara.example' },
            assignee: { displayName: 'Petra Pfleger' },
          },
        })),
      },
    };
  }
  return { status: 200, json: {} };
}

async function patchSettings(t: string, patch: (s: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  await withSystem(async (c) => {
    const s = (await c.query<{ settings: Record<string, unknown> }>('SELECT settings FROM tenants WHERE id = $1', [t])).rows[0].settings;
    await c.query('UPDATE tenants SET settings = $2 WHERE id = $1', [t, JSON.stringify(patch(s))]);
  });
}

async function submitted(as: ReturnType<typeof client>, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await as.post('/api/ideas', { ...validIdea, ...extra });
  expect(created.status).toBe(201);
  expect((await as.post(`/api/ideas/${created.body.id}/submit`, SUBMIT)).status).toBe(200);
  return created.body.id;
}

beforeAll(async () => {
  await resetDb();
  app = await testApp();
  tenant = await createTenant('radara', { holidays: [], topics: TOPICS });
  other = await createTenant('radarb', { holidays: [], topics: TOPICS });
  users = {
    lead: await createUser(tenant, 'lead@radara.example', ['submitter', 'lead']),
    triage: await createUser(tenant, 'triage@radara.example', ['submitter', 'triage']),
    committee: await createUser(tenant, 'gremium@radara.example', ['submitter', 'committee']),
    admin: await createUser(tenant, 'admin@radara.example', ['submitter', 'admin']),
    sponsor: await createUser(tenant, 'sponsor@radara.example', ['submitter']),
    muted: await createUser(tenant, 'leise@radara.example', ['submitter']),
    author: await createUser(tenant, 'erika.mustermann@radara.example', ['submitter']),
    leadB: await createUser(other, 'lead@radarb.example', ['submitter', 'lead', 'admin']),
  };
  api = {};
  for (const [k, u] of Object.entries(users)) api[k] = client(app, await login(app, k === 'leadB' ? 'radarb' : 'radara', u.email));
  today = (await api.author.get('/api/settings')).body.today;
});

afterEach(() => {
  setWebSearch(null);
  setConnectorHttp();
});

afterAll(async () => {
  await app.close();
  await closePool();
});

describe('helpers', () => {
  it('computes the ISO week', () => {
    expect(isoWeek('2026-10-13')).toBe('2026-W42');
    expect(isoWeek('2027-01-01')).toBe('2026-W53');
    expect(isoWeek('2026-01-01')).toBe('2026-W01');
  });

  it('removes names, contact data and labelled person fields', () => {
    const out = redactPersonal('Reporter: Max Muster meldet über max@firma.example und +49 170 1234567, Frau Meier und @jonas, siehe https://x.example/u/7. Erika war auch betroffen.', ['Erika Beispiel']);
    expect(out).not.toMatch(/Max|Muster|max@|170|Meier|jonas|https|Erika/);
    expect(out).toContain('meldet');
  });

  it('reads only title and text columns of a feedback CSV', () => {
    const rows = feedbackRows('Name;E-Mail;Betreff;Feedback\nAnna Alt;anna@x.example;Lieferung;Zu spät geliefert\n');
    expect(rows).toEqual([{ title: 'Lieferung', description: 'Zu spät geliefert' }]);
  });
});

describe('trend radar (R4-11)', () => {
  let trendId: string;

  it('lets the innovation lead maintain the radar; others only read or nothing', async () => {
    expect((await api.author.get('/api/radar')).status).toBe(403);
    const created = await api.lead.post('/api/radar/items', { title: 'Wärmepumpen', description: 'Wärmepumpen für Hallen und Büros', topic: 'Nachhaltigkeit', horizon: 'next', maturity: 'growing' });
    expect(created.status).toBe(201);
    trendId = created.body.id;
    expect((await api.lead.post('/api/radar/items', { title: 'X-Trend', topic: 'Unbekannt', horizon: 'now', maturity: 'emerging' })).status).toBe(400);
    expect((await api.committee.post('/api/radar/items', { title: 'Gremium', topic: 'Nachhaltigkeit', horizon: 'now', maturity: 'emerging' })).status).toBe(403);
    const view = await api.committee.get('/api/radar');
    expect(view.status).toBe(200);
    expect(view.body.canManage).toBe(false);
    expect(view.body.items).toHaveLength(1);
    expect(view.body.items[0]).toMatchObject({ title: 'Wärmepumpen', topic: 'Nachhaltigkeit', horizon: 'next', maturity: 'growing', origin: 'manual' });
    const upd = await api.lead.patch(`/api/radar/items/${trendId}`, { horizon: 'now' });
    expect(upd.status).toBe(200);
  });

  it('keeps tenants apart', async () => {
    expect((await api.leadB.get('/api/radar')).body.items).toEqual([]);
    expect((await api.leadB.patch(`/api/radar/items/${trendId}`, { horizon: 'later' })).status).toBe(404);
    expect((await api.leadB.del(`/api/radar/items/${trendId}`)).status).toBe(404);
    const n = await withTenant(other, async (db) => (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM trend_items')).rows[0].n);
    expect(n).toBe(0);
  });

  it('links an idea and a trend; confidential ideas of others stay invisible', async () => {
    const ideaId = await submitted(api.author, { title: 'Abwärme der Kompressoren nutzen', topic: 'Nachhaltigkeit' });
    const secret = await submitted(api.author, { title: 'Geheime Wärmepumpe', confidential: true, topic: 'Nachhaltigkeit' });
    expect((await api.lead.post(`/api/radar/items/${trendId}/ideas`, { ideaId })).status).toBe(200);
    expect((await api.lead.post(`/api/radar/items/${trendId}/ideas`, { ideaId: secret })).status).toBe(404);
    const view = await api.lead.get('/api/radar');
    expect(view.body.items[0].ideas.map((i: { id: string }) => i.id)).toEqual([ideaId]);
    const trends = await api.author.get(`/api/ideas/${ideaId}/trends`);
    expect(trends.body.map((t: { id: string }) => t.id)).toEqual([trendId]);
    expect((await api.lead.del(`/api/radar/items/${trendId}/ideas/${ideaId}`)).status).toBe(200);
    expect((await api.lead.get('/api/radar')).body.items[0].ideas).toEqual([]);
  });
});

describe('trend hints for sponsors (R4-02)', () => {
  it('sends a weekly summary with sources, never to people who unsubscribed, once per week', async () => {
    setWebSearch(async (_ctx, q) => {
      queries.push(q);
      return q.startsWith('Nachhaltigkeit') ? HITS : [];
    });
    await patchSettings(tenant, (s) => ({ ...s, radar: { trendHints: true, weekday: 1, queriesPerTopic: 2, whiteSpotMonths: 12, minClusterSize: 3, maxTickets: 200, ticketDays: 90 }, ai: { ...(s.ai as object ?? {}), search: { kind: 'searxng', baseUrl: 'https://suche.example', costPerQueryEur: 0, perMonthEur: 20, maxQueriesPerRun: 6 }, internalTerms: ['Falke'] } }));
    // Sponsors of two topic fields; one of them unsubscribed in the notification settings.
    expect((await api.author.put('/api/radar/sponsors', { topic: 'Nachhaltigkeit', userIds: [users.sponsor.id] })).status).toBe(403);
    expect((await api.lead.put('/api/radar/sponsors', { topic: 'Nachhaltigkeit', userIds: [users.sponsor.id, users.muted.id] })).status).toBe(200);
    expect((await api.lead.put('/api/radar/sponsors', { topic: 'Falke Logistik', userIds: [users.sponsor.id] })).status).toBe(200);
    expect((await api.muted.put('/api/me/preferences', { notifyEmail: 'immediate', muted: ['trends'] })).status).toBe(200);
    // The neighbour workspace has the same topic field and a sponsor, but no web search.
    expect((await api.leadB.put('/api/radar/sponsors', { topic: 'Nachhaltigkeit', userIds: [users.leadB.id] })).status).toBe(200);

    expect(await asUser(null, tenant, (ctx) => enqueueWeeklyTrends(ctx), today)).toBe(true);
    expect(await asUser(null, other, (ctx) => enqueueWeeklyTrends(ctx), today)).toBe(false);
    await drainAiJobs();
    // A second run in the same week queues nothing.
    expect(await asUser(null, tenant, (ctx) => enqueueWeeklyTrends(ctx), today)).toBe(false);

    // Queries are built by code from the topic field; internal terms never leave the house.
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.some((q) => /Falke/i.test(q))).toBe(false);
    expect(queries).toContain(`Nachhaltigkeit Trends ${today.slice(0, 4)}`);

    const mails = await withSystem(async (c) => (await c.query<{ user_id: string; subject: string; body: string; category: string }>(
      `SELECT user_id, subject, body, category FROM outbox WHERE tenant_id = $1 AND category = 'trends'`, [tenant],
    )).rows);
    expect(mails.map((x) => x.user_id)).toEqual([users.sponsor.id]);
    expect(mails[0].subject).toContain(isoWeek(today));
    expect(mails[0].body).toContain('https://example.org/waermepumpen');
    expect(mails[0].body).toContain('Abbestellen');
    expect(mails[0].body).toMatch(/\[1\]/);
    const theirs = await withSystem(async (c) => (await c.query(`SELECT 1 FROM outbox WHERE tenant_id = $1 AND category = 'trends'`, [other])).rowCount);
    expect(theirs).toBe(0);
  });

  it('shows digests to sponsors for their topic fields and to the radar roles', async () => {
    const own = await api.sponsor.get('/api/radar/digests');
    expect(own.status).toBe(200);
    expect(own.body.map((d: { topic: string }) => d.topic).sort()).toEqual(['Falke Logistik', 'Nachhaltigkeit']);
    const d = own.body.find((x: { topic: string }) => x.topic === 'Nachhaltigkeit');
    expect(d.points.length).toBe(3);
    expect(d.points.every((p: { sources: number[] }) => p.sources.length > 0)).toBe(true);
    expect((await api.author.get('/api/radar/digests')).body).toEqual([]);
    expect((await api.leadB.get('/api/radar/digests')).body).toEqual([]);
  });

  it('adopts a candidate of the digest into the radar once', async () => {
    const d = (await api.lead.get('/api/radar/digests')).body.find((x: { topic: string }) => x.topic === 'Nachhaltigkeit');
    expect(d.candidates.length).toBeGreaterThan(0);
    const adopted = await api.lead.post(`/api/radar/digests/${d.id}/adopt`, { index: 0, horizon: 'now', maturity: 'emerging' });
    expect(adopted.status).toBe(201);
    expect((await api.lead.post(`/api/radar/digests/${d.id}/adopt`, { index: 0, horizon: 'now', maturity: 'emerging' })).status).toBe(409);
    expect((await api.leadB.post(`/api/radar/digests/${d.id}/adopt`, { index: 0, horizon: 'now', maturity: 'emerging' })).status).toBe(404);
    const item = (await api.lead.get('/api/radar')).body.items.find((i: { id: string }) => i.id === adopted.body.id);
    expect(item.origin).toBe('digest');
    expect(item.sources.length).toBeGreaterThan(0);
  });

  it('suggests signals from ideas and web hits; a person confirms', async () => {
    const ideaId = await submitted(api.author, { title: 'Wärmepumpen für die Lagerhalle', problem: 'Die Lagerhalle wird mit Gas geheizt; Wärmepumpen wären günstiger.', topic: 'Nachhaltigkeit' });
    const secret = await submitted(api.author, { title: 'Vertrauliche Wärmepumpen', problem: 'Wärmepumpen geheim.', confidential: true });
    const r = await api.lead.post('/api/radar/assign');
    expect(r.status).toBe(200);
    expect(r.body.suggestions).toBeGreaterThan(0);
    expect((await api.author.post('/api/radar/assign')).status).toBe(403);
    const items = (await api.lead.get('/api/radar')).body.items as { id: string; title: string; suggestions: { id: string; kind: string; idea: { id: string } | null; source: { url: string } | null }[]; ideas: { id: string }[]; sources: { url: string }[] }[];
    const all = items.flatMap((i) => i.suggestions.map((s) => ({ ...s, trend: i.id })));
    expect(all.some((s) => s.idea?.id === secret)).toBe(false);
    const ideaSug = all.find((s) => s.idea?.id === ideaId);
    expect(ideaSug).toBeTruthy();
    // Nothing is linked before a person confirms.
    expect(items.find((i) => i.id === ideaSug!.trend)!.ideas.some((x) => x.id === ideaId)).toBe(false);
    expect((await api.committee.post(`/api/radar/suggestions/${ideaSug!.id}/accept`)).status).toBe(403);
    expect((await api.lead.post(`/api/radar/suggestions/${ideaSug!.id}/accept`)).status).toBe(200);
    expect((await api.lead.post(`/api/radar/suggestions/${ideaSug!.id}/accept`)).status).toBe(409);
    const web = all.find((s) => s.kind === 'web');
    expect(web).toBeTruthy();
    expect((await api.lead.post(`/api/radar/suggestions/${web!.id}/accept`)).status).toBe(200);
    const after = (await api.lead.get('/api/radar')).body.items as typeof items;
    expect(after.find((i) => i.id === ideaSug!.trend)!.ideas.some((x) => x.id === ideaId)).toBe(true);
    expect(after.find((i) => i.id === web!.trend)!.sources.some((s) => s.url === web!.source!.url)).toBe(true);
    // The assignment ran through the gateway and is logged.
    const log = await withTenant(tenant, async (db) => (await db.query<{ provider: string }>(`SELECT provider FROM ai_actions WHERE agent = 'trend_assign'`)).rows);
    expect(log.length).toBeGreaterThan(0);
  });
});

describe('white spots (R4-03)', () => {
  it('compares topic fields against ideas', async () => {
    expect((await api.author.get('/api/radar/white-spots')).status).toBe(403);
    const r = await api.committee.get('/api/radar/white-spots');
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.topics.map((t: { topic: string }) => [t.topic, t]));
    expect(by.Nachhaltigkeit.whiteSpot).toBe(false);
    expect(by.Nachhaltigkeit.recentIdeas).toBeGreaterThanOrEqual(2);
    expect(by.Kundenerlebnis).toMatchObject({ ideas: 0, recentIdeas: 0, whiteSpot: true });
    expect(by.Nachhaltigkeit.trends).toBeGreaterThanOrEqual(1);
    const theirs = await api.leadB.get('/api/radar/white-spots');
    expect(theirs.body.topics.every((t: { ideas: number }) => t.ideas === 0)).toBe(true);
  });
});

describe('problem radar (R4-01)', () => {
  let sourceId: string;
  let clusterIds: string[] = [];

  it('reads tickets of a connector and clusters them without people', async () => {
    setConnectorHttp(jiraFake);
    const c = await api.admin.post('/api/admin/connectors', {
      kind: 'jira', name: 'Jira Support', baseUrl: BASE, config: { project: 'SUP', itemType: 'Epic' }, credentials: { email: 'bot@radara.example', apiToken: 'token-1' },
    });
    expect(c.status).toBe(201);
    expect((await api.admin.post(`/api/admin/connectors/${c.body.id}/enable`)).status).toBe(200);
    expect((await api.triage.post('/api/radar/problems/sources', { connectorId: c.body.id, name: 'Support-Tickets', query: 'project = SUP' })).status).toBe(403);
    const s = await api.lead.post('/api/radar/problems/sources', { connectorId: c.body.id, name: 'Support-Tickets', query: 'project = SUP' });
    expect(s.status).toBe(201);
    sourceId = s.body.id;

    expect((await api.author.post(`/api/radar/problems/sources/${sourceId}/run`)).status).toBe(403);
    const run = await api.lead.post(`/api/radar/problems/sources/${sourceId}/run`);
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ items: 8, clusters: 2 });
    // Only title and description were asked for, nothing about people.
    const url = new URL(jiraRequests[0].url);
    expect(url.searchParams.get('fields')).toBe('summary,description');
    expect(url.searchParams.get('jql')).toMatch(/^\(project = SUP\) AND created >= -90d/);

    const view = await api.lead.get('/api/radar/problems');
    const clusters = view.body.runs[0].clusters as { id: string; label: string; frequency: number; examples: string[]; summary: string }[];
    clusterIds = clusters.map((x) => x.id);
    expect(clusters.map((x) => x.frequency)).toEqual([4, 3]);
    expect(clusters[0].label).toMatch(/VPN|Verbindung/);
    expect(clusters[0].examples.length).toBe(3);
    // No person data anywhere in what was stored or logged.
    const stored = await withTenant(tenant, async (db) => JSON.stringify([
      (await db.query('SELECT * FROM problem_clusters')).rows,
      (await db.query('SELECT * FROM problem_runs')).rows,
      (await db.query(`SELECT input, output FROM ai_actions WHERE agent = 'problem_clusters'`)).rows,
    ]));
    for (const p of ['Max Muster', 'Petra', 'Erika', 'Mustermann', 'erika.mustermann@', '1234567', 'Schulze', 'jonas', 'SUP-1']) expect(stored).not.toContain(p);
    // Clustering ran through the gateway on a local model only.
    const log = await withTenant(tenant, async (db) => (await db.query<{ local: boolean; provider: string }>(`SELECT local, provider FROM ai_actions WHERE agent = 'problem_clusters'`)).rows);
    expect(log).toEqual([{ local: true, provider: 'builtin' }]);
  });

  it('respects the configured minimum cluster size', async () => {
    expect((await api.lead.put('/api/radar/settings', { trendHints: true, weekday: 1, queriesPerTopic: 2, whiteSpotMonths: 12, minClusterSize: 4, maxTickets: 200, ticketDays: 90 })).status).toBe(403);
    expect((await api.admin.put('/api/radar/settings', { trendHints: true, weekday: 1, queriesPerTopic: 2, whiteSpotMonths: 12, minClusterSize: 4, maxTickets: 200, ticketDays: 90 })).status).toBe(200);
    setConnectorHttp(jiraFake);
    const run = await api.lead.post(`/api/radar/problems/sources/${sourceId}/run`);
    expect(run.body.clusters).toBe(1);
    expect((await api.admin.put('/api/radar/settings', { trendHints: true, weekday: 1, queriesPerTopic: 2, whiteSpotMonths: 12, minClusterSize: 3, maxTickets: 200, ticketDays: 90 })).status).toBe(200);
  });

  it('clusters an uploaded feedback CSV and ignores person columns', async () => {
    const csv = ['Name;E-Mail;Feedback',
      'Anna Alt;anna@kunde.example;Lieferung kommt zu spät an',
      'Bernd Bau;bernd@kunde.example;Die Lieferung kam wieder zu spät',
      'Clara Cool;clara@kunde.example;Lieferung zu spät, Ware beschädigt',
      'Dora Dorn;dora@kunde.example;Die App stürzt ab'].join('\n');
    expect((await api.author.post('/api/radar/problems/csv', { name: 'Kundenfeedback', csv })).status).toBe(403);
    const r = await api.lead.post('/api/radar/problems/csv', { name: 'Kundenfeedback', csv });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ items: 4, clusters: 1 });
    const view = await api.lead.get('/api/radar/problems');
    const text = JSON.stringify(view.body.runs[0]);
    expect(view.body.runs[0].sourceKind).toBe('csv');
    for (const p of ['Anna', 'Bernd', 'Clara', 'kunde.example']) expect(text).not.toContain(p);
  });

  it('turns a cluster into a problem draft or a challenge', async () => {
    const p = await api.lead.post(`/api/radar/problems/clusters/${clusterIds[0]}/problem`, { topic: 'Arbeitsumfeld' });
    expect(p.status).toBe(201);
    const idea = await withTenant(tenant, async (db) => (await db.query('SELECT idea_kind, status, author_id, problem FROM ideas WHERE id = $1', [p.body.ideaId])).rows[0]);
    expect(idea).toMatchObject({ idea_kind: 'problem', status: 'draft', author_id: users.lead.id });
    expect(idea.problem).toContain('4');
    expect((await api.lead.post(`/api/radar/problems/clusters/${clusterIds[0]}/challenge`, { title: 'Stabiles VPN', question: 'Wie wird das VPN im Homeoffice stabil?', endsOn: '2099-12-31' })).status).toBe(409);
    const c = await api.lead.post(`/api/radar/problems/clusters/${clusterIds[1]}/challenge`, { title: 'Nie wieder Papierstau', question: 'Wie vermeiden wir Papierstau an den Druckern?', endsOn: '2099-12-31' });
    expect(c.status).toBe(201);
    const ch = await withTenant(tenant, async (db) => (await db.query('SELECT title, sponsor_id FROM challenges WHERE id = $1', [c.body.challengeId])).rows[0]);
    expect(ch).toMatchObject({ title: 'Nie wieder Papierstau', sponsor_id: users.lead.id });
    expect((await api.leadB.post(`/api/radar/problems/clusters/${clusterIds[1]}/dismiss`)).status).toBe(404);
  });

  it('keeps the problem radar per tenant', async () => {
    const theirs = await api.leadB.get('/api/radar/problems');
    expect(theirs.body.runs).toEqual([]);
    expect(theirs.body.sources).toEqual([]);
    expect((await api.leadB.post(`/api/radar/problems/sources/${sourceId}/run`)).status).toBe(404);
    const n = await withTenant(other, async (db) => (await db.query<{ n: number }>(
      'SELECT (SELECT count(*) FROM problem_clusters) + (SELECT count(*) FROM problem_runs) + (SELECT count(*) FROM problem_sources) + (SELECT count(*) FROM trend_digests) AS n',
    )).rows[0].n);
    expect(Number(n)).toBe(0);
    expect((await api.committee.get('/api/radar/problems')).status).toBe(403);
  });

  it('needs the connectors feature for ticket sources, not for CSV', async () => {
    await withSystem((c) => c.query(`INSERT INTO tenant_plans (tenant_id, plan, status, employees) VALUES ($1, 'team', 'active', 300)`, [tenant]));
    try {
      const r = await api.lead.post(`/api/radar/problems/sources/${sourceId}/run`);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('FEATURE_UNAVAILABLE');
      const csv = await api.lead.post('/api/radar/problems/csv', { name: 'Feedback', csv: 'Text\nA\nB' });
      expect(csv.status).toBe(200);
    } finally {
      await withSystem((c) => c.query('DELETE FROM tenant_plans WHERE tenant_id = $1', [tenant]));
    }
  });
});
