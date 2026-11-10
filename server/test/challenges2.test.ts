import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, withTenant } from '../src/db/pool.js';
import type { SessionUser } from '../src/lib/context.js';
import { client, createTenant, createUser, login, resetDb, testApp, validIdea } from './helpers.js';

// Challenges with own fields, teams, jury scorecard and ranking (R2-35).

let app: FastifyInstance;
let tenant: string;
let users: Record<string, SessionUser>;
let api: Record<string, ReturnType<typeof client>>;
let challengeId: string;
let today: string;

const fields = [
  { id: 'site', label: 'Standort', type: 'select', options: ['Nord', 'Süd'], required: true },
  { id: 'savings', label: 'Einsparung in kWh', type: 'number', required: false },
  { id: 'note', label: 'Bemerkung', type: 'text' },
];
const criteria = [
  { id: 'impact', label: 'Wirkung', weight: 60 },
  { id: 'effort', label: 'Aufwand', weight: 40 },
];

beforeAll(async () => {
  await resetDb();
  app = await testApp();
  tenant = await createTenant('ch2', { holidays: [] });
  users = {
    sponsor: await createUser(tenant, 'sponsor@c.example', ['submitter', 'committee']),
    triage: await createUser(tenant, 'triage@c.example', ['submitter', 'triage']),
    jury: await createUser(tenant, 'jury@c.example', ['submitter']),
    jury2: await createUser(tenant, 'jury2@c.example', ['submitter']),
    mia: await createUser(tenant, 'mia@c.example'),
    max: await createUser(tenant, 'max@c.example'),
  };
  api = {};
  for (const [k, u] of Object.entries(users)) api[k] = client(app, await login(app, 'ch2', u.email));
  today = (await api.mia.get('/api/settings')).body.today;
  const c = await api.sponsor.post('/api/challenges', {
    title: 'Energie sparen', question: 'Wie sparen wir Energie an unseren Standorten?', contact: 'Sponsor', startsOn: today, endsOn: '2099-12-31',
    customFields: fields, teamsAllowed: true, juryCriteria: criteria,
  });
  expect(c.status).toBe(201);
  challengeId = c.body.id;
});

afterAll(async () => {
  await app.close();
  await closePool();
});

async function draft(extra: Record<string, unknown>, by = 'mia') {
  return api[by].post('/api/ideas', { ...validIdea, challengeId, ...extra });
}

describe('own fields and teams', () => {
  it('validates the custom fields of the challenge', async () => {
    const bad = await api.sponsor.post('/api/challenges', {
      title: 'Kaputt', question: 'Auswahl ohne Optionen geht nicht?', contact: 'x', startsOn: today, endsOn: '2099-12-31',
      customFields: [{ id: 'a', label: 'A', type: 'select', options: [] }],
    });
    expect(bad.status).toBe(400);
    expect((await draft({ customValues: { site: 'West' } })).status).toBe(400);
    expect((await draft({ customValues: { savings: 'viel' } })).status).toBe(400);
    const missing = await draft({ customValues: { savings: 1200 } });
    expect(missing.status).toBe(201);
    const blocked = await api.mia.post(`/api/ideas/${missing.body.id}/submit`, { confirmNotReport: true, boundaryAcknowledged: true });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toMatch(/Standort/);
    expect((await api.mia.patch(`/api/ideas/${missing.body.id}`, { customValues: { site: 'Nord', savings: 1200, unknown: 'x' } })).status).toBe(200);
    const ok = await api.mia.post(`/api/ideas/${missing.body.id}/submit`, { confirmNotReport: true, boundaryAcknowledged: true });
    expect(ok.body).toEqual({ ok: true });
    const d = await api.max.get(`/api/ideas/${missing.body.id}`);
    expect(d.body.challengeValues).toEqual([
      { id: 'site', label: 'Standort', value: 'Nord' },
      { id: 'savings', label: 'Einsparung in kWh', value: 1200 },
    ]);
  });

  it('accepts teams with members as co-authors', async () => {
    const created = await draft({ teamName: 'Team Licht', customValues: { site: 'Süd' } }, 'max');
    expect(created.status).toBe(201);
    expect((await api.max.post(`/api/ideas/${created.body.id}/coauthors`, { userId: users.mia.id })).status).toBe(200);
    expect((await api.max.post(`/api/ideas/${created.body.id}/submit`, { confirmNotReport: true, boundaryAcknowledged: true })).status).toBe(200);
    const d = await api.mia.get(`/api/ideas/${created.body.id}`);
    expect(d.body.teamName).toBe('Team Licht');
    expect(d.body.coauthors.map((c: { name: string }) => c.name)).toEqual(['mia']);
    // Teams only where the challenge allows them.
    expect((await api.max.post('/api/ideas', { ...validIdea, teamName: 'Ohne Challenge' })).status).toBe(400);
  });
});

describe('jury and ranking', () => {
  it('lets only the sponsor or triage manage the jury', async () => {
    expect((await api.max.put(`/api/challenges/${challengeId}/jury`, { userIds: [users.max.id] })).status).toBe(403);
    expect((await api.sponsor.put(`/api/challenges/${challengeId}/jury`, { userIds: [users.jury.id, users.jury2.id] })).status).toBe(200);
    const c = await api.jury.get(`/api/challenges/${challengeId}`);
    expect(c.body.isJury).toBe(true);
    expect(c.body.juryCriteria.map((x: { id: string }) => x.id)).toEqual(['impact', 'effort']);
    expect(c.body.jury).toHaveLength(2);
  });

  it('rates with the jury scorecard and keeps the ranking hidden until published', async () => {
    const ideas = (await api.jury.get(`/api/challenges/${challengeId}`)).body.ideas.map((i: { id: string }) => i.id);
    expect(ideas).toHaveLength(2);
    expect((await api.max.put(`/api/challenges/${challengeId}/ideas/${ideas[0]}/jury-score`, { scores: { impact: 5, effort: 5 } })).status).toBe(403);
    expect((await api.jury.put(`/api/challenges/${challengeId}/ideas/${ideas[0]}/jury-score`, { scores: { impact: 5 } })).status).toBe(400);
    expect((await api.jury.put(`/api/challenges/${challengeId}/ideas/${ideas[0]}/jury-score`, { scores: { impact: 5, effort: 3 } })).body.total).toBe(4.2);
    await api.jury2.put(`/api/challenges/${challengeId}/ideas/${ideas[0]}/jury-score`, { scores: { impact: 3, effort: 3 } });
    await api.jury.put(`/api/challenges/${challengeId}/ideas/${ideas[1]}/jury-score`, { scores: { impact: 4, effort: 4 } });
    const forJury = await api.jury.get(`/api/challenges/${challengeId}`);
    expect(forJury.body.ranking.map((r: { total: number; rank: number }) => [r.rank, r.total])).toEqual([[1, 4], [2, 3.6]]);
    expect(forJury.body.myJuryScores[ideas[0]].total).toBe(4.2);
    expect((await api.triage.get(`/api/challenges/${challengeId}`)).body.ranking).toHaveLength(2);
    expect((await api.max.get(`/api/challenges/${challengeId}`)).body.ranking).toBeNull();
    // The jury table only holds this tenant's rows.
    const n = await withTenant(tenant, (db) => db.query('SELECT count(*)::int AS n FROM challenge_jury'));
    expect(n.rows[0].n).toBe(2);
  });

  it('publishes the ranking only after the end, by the sponsor', async () => {
    expect((await api.sponsor.post(`/api/challenges/${challengeId}/ranking/publish`)).status).toBe(409);
    await api.sponsor.post(`/api/challenges/${challengeId}/close`, {});
    expect((await api.jury.post(`/api/challenges/${challengeId}/ranking/publish`)).status).toBe(403);
    expect((await api.max.get(`/api/challenges/${challengeId}`)).body.ranking).toBeNull();
    expect((await api.sponsor.post(`/api/challenges/${challengeId}/ranking/publish`)).status).toBe(200);
    const pub = await api.max.get(`/api/challenges/${challengeId}`);
    expect(pub.body.ranking).toHaveLength(2);
    expect(pub.body.rankingPublishedAt).toBeTruthy();
  });

  it('updates fields, teams and criteria', async () => {
    expect((await api.max.patch(`/api/challenges/${challengeId}`, { teamsAllowed: false })).status).toBe(403);
    expect((await api.triage.patch(`/api/challenges/${challengeId}`, { teamsAllowed: false, juryCriteria: [] })).status).toBe(200);
    const c = await api.mia.get(`/api/challenges/${challengeId}`);
    expect(c.body.teamsAllowed).toBe(false);
    // Fallback: tenant scorecard criteria.
    expect(c.body.juryCriteria.map((x: { id: string }) => x.id)).toContain('strategic_fit');
  });
});
