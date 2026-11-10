import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drainAiJobs } from '../src/ai/worker.js';
import { closePool, withTenant } from '../src/db/pool.js';
import type { SessionUser } from '../src/lib/context.js';
import { client, createTenant, createUser, login, resetDb, testApp, validIdea } from './helpers.js';

// Use cases (AP-22): problem exchange (R3-31), sustainability challenge with kWh and ESG export
// (R3-32), target value with controlling confirmation (R3-33), hackathon mode (R3-34).

let app: FastifyInstance;
let tenant: string;
let other: string;
let users: Record<string, SessionUser>;
let api: Record<string, ReturnType<typeof client>>;
let today: string;

const SUBMIT = { confirmNotReport: true, boundaryAcknowledged: true };
const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const hoursFromNow = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

beforeAll(async () => {
  await resetDb();
  app = await testApp();
  tenant = await createTenant('uc', { holidays: [] });
  other = await createTenant('ucb', { holidays: [] });
  users = {
    triage: await createUser(tenant, 'triage@uc.example', ['submitter', 'triage']),
    sponsor: await createUser(tenant, 'sponsor@uc.example', ['submitter', 'committee']),
    mia: await createUser(tenant, 'mia@uc.example'),
    max: await createUser(tenant, 'max@uc.example'),
    owner: await createUser(tenant, 'owner@uc.example', ['submitter', 'implementer']),
    ctrl: await createUser(tenant, 'ctrl@uc.example', ['submitter', 'controlling']),
    confirmer: await createUser(tenant, 'confirmer@uc.example'),
    jury: await createUser(tenant, 'jury@uc.example'),
    v1: await createUser(tenant, 'v1@uc.example'),
    v2: await createUser(tenant, 'v2@uc.example'),
    stranger: await createUser(other, 'stranger@ucb.example', ['submitter', 'triage', 'controlling', 'admin']),
  };
  api = {};
  for (const [k, u] of Object.entries(users)) api[k] = client(app, await login(app, k === 'stranger' ? 'ucb' : 'uc', u.email));
  today = (await api.mia.get('/api/settings')).body.today;
});

afterAll(async () => {
  await app.close();
  await closePool();
});

async function draft(by: string, extra: Record<string, unknown> = {}) {
  const d = await api[by].post('/api/ideas', { ...validIdea, ...extra });
  expect(d.status).toBe(201);
  return d.body.id as string;
}

async function submitted(by: string, extra: Record<string, unknown> = {}) {
  const id = await draft(by, extra);
  expect((await api[by].post(`/api/ideas/${id}/submit`, SUBMIT)).status).toBe(200);
  return id;
}

/** Submitted, fast lane, accepted and closed with the given benefit. */
async function implemented(challengeId: string, title: string, benefitKind: string, benefitValue: number | null) {
  const id = await submitted('mia', { title, challengeId });
  const tr = await api.triage.post(`/api/ideas/${id}/triage`, { lane: 'fast_lane', ownerId: users.owner.id, orgUnit: 'Technik', targetDate: addDays(today, 30) });
  expect(tr.status).toBe(200);
  expect((await api.owner.post(`/api/ideas/${id}/implementation/accept`)).status).toBe(200);
  const close = await api.owner.post(`/api/ideas/${id}/implementation/close`, { benefitKind, benefitValue, benefitEvidence: 'Zählerstände vorher und nachher verglichen.' });
  expect(close.status).toBe(200);
  return id;
}

describe('problem exchange (R3-31)', () => {
  let problemId: string;

  it('takes a problem without a solution, an idea still needs one', async () => {
    const noSolution = await draft('mia', { solution: '' });
    expect((await api.mia.post(`/api/ideas/${noSolution}/submit`, SUBMIT)).status).toBe(400);
    problemId = await submitted('mia', { title: 'Druckluft zischt in Halle 3', ideaKind: 'problem', solution: '' });
    const d = await api.mia.get(`/api/ideas/${problemId}`);
    expect(d.body.ideaKind).toBe('problem');
    const list = await api.max.get('/api/ideas?scope=all&kind=problem');
    expect(list.body.map((i: { id: string }) => i.id)).toEqual([problemId]);
    expect(list.body[0].ideaKind).toBe('problem');
  });

  it('lets the community propose solutions, only for problems', async () => {
    expect((await api.max.post(`/api/ideas/${problemId}/comments`, { body: 'Leckage-Ortung mit Ultraschall', kind: 'solution' })).status).toBe(201);
    expect((await api.max.post(`/api/ideas/${problemId}/comments`, { body: 'Ich höre das auch jeden Tag.' })).status).toBe(201);
    const d = await api.mia.get(`/api/ideas/${problemId}`);
    expect(d.body.comments.map((c: { kind: string }) => c.kind)).toEqual(['solution', 'comment']);
    const idea = await submitted('max', { title: 'Normale Idee mit Lösung' });
    expect((await api.mia.post(`/api/ideas/${idea}/comments`, { body: 'Lösung', kind: 'solution' })).status).toBe(400);
  });

  it('gives root-cause questions instead of competition in the short analysis, without web search', async () => {
    await drainAiJobs();
    const ai = await api.triage.get(`/api/ideas/${problemId}/ai`);
    const short = ai.body.results.find((r: { kind: string }) => r.kind === 'short_analysis');
    const headings = short.sections.map((s: { heading: string }) => s.heading);
    expect(headings).toContain('Ursachenfragen');
    expect(headings).not.toContain('Wettbewerber und Ersatzprodukte');
    expect(headings).not.toContain('Fertige Lösungen und Vorgehen anderer');
    const causes = short.sections.find((s: { heading: string }) => s.heading === 'Ursachenfragen');
    expect(causes.claims.length).toBeGreaterThanOrEqual(5);
    expect(causes.claims.every((c: { text: string }) => c.text.endsWith('?'))).toBe(true);
    // Through the gateway: logged like every AI action.
    const log = await withTenant(tenant, (db) => db.query<{ agent: string }>('SELECT agent FROM ai_actions WHERE idea_id = $1', [problemId]));
    expect(log.rows.map((r) => r.agent)).toContain('short_analysis');
  });

  it('lets only triage turn a problem into a challenge', async () => {
    const body = { title: 'Druckluftlecks finden', question: 'Wie finden und beheben wir Druckluftlecks schneller?', endsOn: addDays(today, 30) };
    expect((await api.mia.post(`/api/ideas/${problemId}/to-challenge`, body)).status).toBe(403);
    expect((await api.stranger.post(`/api/ideas/${problemId}/to-challenge`, body)).status).toBe(404);
    const idea = (await api.max.get('/api/ideas?scope=mine')).body[0].id;
    expect((await api.triage.post(`/api/ideas/${idea}/to-challenge`, body)).status).toBe(400);
    const r = await api.triage.post(`/api/ideas/${problemId}/to-challenge`, { ...body, reason: 'Viele Bereiche betroffen.' });
    expect(r.status).toBe(201);
    const d = await api.mia.get(`/api/ideas/${problemId}`);
    expect(d.body.status).toBe('forwarded');
    expect(d.body.forwardedTo).toBe('Druckluftlecks finden');
    const view = await api.mia.get(`/api/challenges/${r.body.challengeId}/use-cases`);
    expect(view.body.sourceIdea).toMatchObject({ id: problemId });
    const mails = await withTenant(tenant, (db) => db.query('SELECT 1 FROM outbox WHERE user_id = $1 AND subject LIKE $2', [users.mia.id, '%wird zur Challenge%']));
    expect(mails.rowCount).toBe(1);
  });

  it('merges a problem with an idea', async () => {
    const p2 = await submitted('max', { title: 'Lecks an Kupplungen', ideaKind: 'problem', solution: '' });
    const target = await submitted('mia', { title: 'Schnellkupplungen tauschen' });
    const r = await api.triage.post(`/api/ideas/${p2}/merge`, { targetId: target, reason: 'Gleiches Thema wie die Idee.' });
    expect(r.status).toBe(200);
    expect((await api.max.get(`/api/ideas/${p2}`)).body.status).toBe('merged');
  });
});

describe('sustainability, target value and controlling confirmation (R3-32, R3-33)', () => {
  let challengeId: string;
  let kwhIdea: string;
  let co2Idea: string;

  it('offers the sustainability template with kWh and a CO₂ target', async () => {
    const t = await api.sponsor.get('/api/challenges/templates');
    const green = t.body.find((x: { id: string }) => x.id === 'sustainability');
    expect(green.customFields.map((f: { id: string }) => f.id)).toEqual(['co2', 'kwh']);
    expect(green.targetKind).toBe('co2');
    const c = await api.sponsor.post('/api/challenges', {
      title: 'Energie sparen', question: 'Wie senken wir den Stromverbrauch der Standorte?', contact: 'Sponsor', startsOn: today, endsOn: addDays(today, 60),
      template: 'sustainability', targetKind: 'co2', targetValue: 10, targetFrom: today, targetUntil: addDays(today, 365),
    });
    expect(c.status).toBe(201);
    challengeId = c.body.id;
    // Target value and benefit kind belong together.
    expect((await api.sponsor.patch(`/api/challenges/${challengeId}/use-cases`, { targetKind: null })).status).toBe(400);
    expect((await api.mia.patch(`/api/challenges/${challengeId}/use-cases`, { targetValue: 20 })).status).toBe(403);
  });

  it('reports the impact per benefit kind with kWh converted to CO₂', async () => {
    kwhIdea = await implemented(challengeId, 'LED in Halle 2', 'kwh', 20000);
    co2Idea = await implemented(challengeId, 'Dienstreisen per Bahn', 'co2', 2);
    const v = await api.mia.get(`/api/challenges/${challengeId}/use-cases`);
    expect(v.status).toBe(200);
    const kinds = Object.fromEntries(v.body.impact.kinds.map((k: { kind: string; estimated: number }) => [k.kind, k.estimated]));
    expect(kinds).toEqual({ co2: 2, kwh: 20000 });
    expect(v.body.impact.kgCo2PerKwh).toBe(0.38);
    expect(v.body.impact.co2FromKwh).toEqual({ estimated: 7.6, confirmed: 0 });
    expect(v.body.target).toMatchObject({ kind: 'co2', value: 10, estimated: 9.6, confirmed: 0, estimatedPercent: 96, confirmedPercent: 0 });
    // Confirmation details only for the people who manage or confirm.
    expect(v.body.confirmations).toBeNull();
    expect((await api.sponsor.get(`/api/challenges/${challengeId}/use-cases`)).body.confirmations).toHaveLength(2);
  });

  it('uses the conversion factors of the workspace', async () => {
    await withTenant(tenant, (db) => db.query(`UPDATE tenants SET settings = jsonb_set(settings, '{challenges}', '{"kgCo2PerKwh": 0.5}') WHERE id = $1`, [tenant]));
    const v = await api.mia.get(`/api/challenges/${challengeId}/use-cases`);
    expect(v.body.impact.co2FromKwh.estimated).toBe(10);
    await withTenant(tenant, (db) => db.query(`UPDATE tenants SET settings = settings - 'challenges' WHERE id = $1`, [tenant]));
  });

  it('lets controlling confirm or correct each actual benefit with a comment', async () => {
    const ok = { outcome: 'confirmed', comment: 'Zählerstände geprüft.' };
    expect((await api.mia.post(`/api/ideas/${kwhIdea}/benefit-confirmation`, ok)).status).toBe(403);
    expect((await api.owner.post(`/api/ideas/${kwhIdea}/benefit-confirmation`, ok)).status).toBe(403);
    expect((await api.stranger.post(`/api/ideas/${kwhIdea}/benefit-confirmation`, ok)).status).toBe(404);
    expect((await api.ctrl.post(`/api/ideas/${kwhIdea}/benefit-confirmation`, { outcome: 'confirmed', comment: '' })).status).toBe(400);
    expect((await api.ctrl.post(`/api/ideas/${kwhIdea}/benefit-confirmation`, ok)).status).toBe(200);
    expect((await api.ctrl.post(`/api/ideas/${co2Idea}/benefit-confirmation`, { outcome: 'corrected', comment: 'Nur halbes Jahr wirksam.' })).status).toBe(400);
    const corr = await api.ctrl.post(`/api/ideas/${co2Idea}/benefit-confirmation`, { outcome: 'corrected', value: 1.5, comment: 'Nur ein Teil der Reisen umgestellt.' });
    expect(corr.status).toBe(200);
    expect(corr.body.confirmedValue).toBe(1.5);
    const v = await api.sponsor.get(`/api/challenges/${challengeId}/use-cases`);
    expect(v.body.target).toMatchObject({ estimated: 9.6, confirmed: 9.1, confirmedPercent: 91 });
    const list = v.body.confirmations;
    expect(list.find((x: { ideaId: string }) => x.ideaId === co2Idea)).toMatchObject({ outcome: 'corrected', confirmedValue: 1.5, comment: 'Nur ein Teil der Reisen umgestellt.' });
    // The idea history shows the confirmation; the owner is told.
    const d = await api.mia.get(`/api/ideas/${co2Idea}`);
    expect(d.body.events.some((e: { kind: string }) => e.kind === 'benefit_confirmed')).toBe(true);
    // The audit log has the correction.
    const a = await withTenant(tenant, (db) => db.query("SELECT 1 FROM audit_log WHERE action = 'benefit.confirm' AND entity_id = $1", [co2Idea]));
    expect(a.rowCount).toBe(1);
  });

  it('lists the actual benefits for controlling and the confirmer of a challenge only', async () => {
    const list = await api.ctrl.get('/api/benefit-confirmations');
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBe(2);
    expect((await api.mia.get('/api/benefit-confirmations')).status).toBe(403);
    expect((await api.stranger.get('/api/benefit-confirmations')).body.items).toEqual([]);
    // A configured confirmer confirms in the own challenge.
    const c2 = await api.sponsor.post('/api/challenges', {
      title: 'Kosten senken', question: 'Wo können wir Kosten senken, ohne Qualität zu verlieren?', contact: 'Sponsor', startsOn: today, endsOn: addDays(today, 60),
      template: 'cost_reduction', targetKind: 'euro', targetValue: 50000, confirmerId: users.confirmer.id,
    });
    expect(c2.status).toBe(201);
    const euroIdea = await implemented(c2.body.id, 'Papierlose Rechnungen', 'euro', 12000);
    expect((await api.confirmer.post(`/api/ideas/${kwhIdea}/benefit-confirmation`, { outcome: 'confirmed', comment: 'Nicht meine Challenge.' })).status).toBe(403);
    expect((await api.confirmer.post(`/api/ideas/${euroIdea}/benefit-confirmation`, { outcome: 'confirmed', comment: 'Belege geprüft.' })).status).toBe(200);
    const mine = await api.confirmer.get('/api/benefit-confirmations');
    expect(mine.body.items.map((x: { ideaId: string }) => x.ideaId)).toEqual([euroIdea]);
  });

  it('shows confirmed against estimated in the dashboard and the ESG export', async () => {
    const dash = await api.sponsor.get('/api/dashboard/challenges');
    const row = dash.body.items.find((x: { id: string }) => x.id === challengeId);
    expect(row.benefit).toEqual(expect.arrayContaining([{ kind: 'kwh', total: 20000, confirmed: 20000 }, { kind: 'co2', total: 2, confirmed: 1.5 }]));
    expect(row.target).toMatchObject({ kind: 'co2', value: 10 });
    const csv = await app.inject({ method: 'GET', url: `/api/challenges/${challengeId}/esg.csv`, headers: { cookie: (await login(app, 'uc', users.sponsor.email)) } });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body).toContain('kwh;kWh pro Jahr;1;20000;20000;1');
    expect(csv.body).toContain('CO₂ aus kWh (umgerechnet)');
    expect(csv.body).toContain('LED in Halle 2');
    expect(csv.body).not.toContain('mia');
    expect((await api.mia.get(`/api/challenges/${challengeId}/esg.csv`)).status).toBe(403);
    expect((await api.stranger.get(`/api/challenges/${challengeId}/esg.csv`)).status).toBe(404);
    expect((await api.stranger.get(`/api/challenges/${challengeId}/use-cases`)).status).toBe(404);
  });

  it('names the savings in the success story', async () => {
    const r = await api.triage.post(`/api/ideas/${kwhIdea}/ai/success-story`);
    expect(r.status).toBe(200);
    expect(r.body.body).toContain('20.000 kWh pro Jahr');
    expect(r.body.body).toContain('7,6 t CO₂');
    expect(r.body.body).toContain('vom Controlling bestätigt');
  });
});

describe('hackathon mode (R3-34)', () => {
  let challengeId: string;
  let ideaA: string;
  let ideaB: string;

  it('takes submissions only inside the window and locks them afterwards', async () => {
    const c = await api.sponsor.post('/api/challenges', {
      title: 'Hackathon Logistik', question: 'Welche Lösung baut ihr in 48 Stunden für die Logistik?', contact: 'Sponsor', startsOn: today, endsOn: addDays(today, 10),
      template: 'hackathon', teamsAllowed: true, hackathon: true, submissionOpensAt: hoursFromNow(-2), submissionClosesAt: hoursFromNow(2),
      audienceVoting: true, audienceWeight: 40,
    });
    expect(c.status).toBe(201);
    challengeId = c.body.id;
    expect((await api.sponsor.patch(`/api/challenges/${challengeId}/use-cases`, { submissionClosesAt: hoursFromNow(-3) })).status).toBe(400);
    ideaA = await submitted('mia', { title: 'Team A: Routenplaner', challengeId, teamName: 'Team A' });
    expect((await api.mia.post(`/api/ideas/${ideaA}/coauthors`, { userId: users.max.id })).status).toBe(200);
    ideaB = await submitted('max', { title: 'Team B: Lager-Scanner', challengeId, teamName: 'Team B' });
    const late = await draft('v2', { title: 'Zu spät', challengeId });
    // Voting starts only after the window.
    expect((await api.v1.put(`/api/challenges/${challengeId}/vote`, { ideaId: ideaA })).status).toBe(409);
    expect((await api.sponsor.patch(`/api/challenges/${challengeId}/use-cases`, { submissionClosesAt: hoursFromNow(-1) })).status).toBe(200);
    const r = await api.v2.post(`/api/ideas/${late}/submit`, SUBMIT);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('SUBMISSION_WINDOW');
    // The team is locked after the window.
    expect((await api.mia.post(`/api/ideas/${ideaA}/coauthors`, { userId: users.v2.id })).status).toBe(409);
  });

  it('keeps a pitch list in the order the sponsor sets', async () => {
    expect((await api.mia.patch(`/api/challenges/${challengeId}/use-cases`, { pitchOrder: [ideaB, ideaA] })).status).toBe(403);
    expect((await api.sponsor.patch(`/api/challenges/${challengeId}/use-cases`, { pitchOrder: [ideaB, ideaA], pitchMinutes: 7 })).status).toBe(200);
    const v = await api.v1.get(`/api/challenges/${challengeId}/use-cases`);
    expect(v.body.hackathon.pitch.map((p: { id: string; position: number; startsAfterMinutes: number }) => [p.id, p.position, p.startsAfterMinutes])).toEqual([[ideaB, 1, 0], [ideaA, 2, 7]]);
    expect(v.body.hackathon.locked).toBe(true);
    expect(v.body.hackathon.submissionOpen).toBe(false);
  });

  it('counts one audience vote per person, separate from the jury, never per person', async () => {
    expect((await api.sponsor.put(`/api/challenges/${challengeId}/jury`, { userIds: [users.jury.id] })).status).toBe(200);
    expect((await api.mia.put(`/api/challenges/${challengeId}/vote`, { ideaId: ideaA })).status).toBe(403);
    expect((await api.max.put(`/api/challenges/${challengeId}/vote`, { ideaId: ideaA })).status).toBe(403); // co-author of Team A
    expect((await api.jury.put(`/api/challenges/${challengeId}/vote`, { ideaId: ideaA })).status).toBe(403);
    expect((await api.stranger.put(`/api/challenges/${challengeId}/vote`, { ideaId: ideaA })).status).toBe(404);
    expect((await api.v1.put(`/api/challenges/${challengeId}/vote`, { ideaId: ideaA })).status).toBe(200);
    expect((await api.v1.put(`/api/challenges/${challengeId}/vote`, { ideaId: ideaB })).status).toBe(200); // changes the one vote
    expect((await api.v2.put(`/api/challenges/${challengeId}/vote`, { ideaId: ideaB })).status).toBe(200);
    const mine = await api.v1.get(`/api/challenges/${challengeId}/use-cases`);
    expect(mine.body.hackathon.myVote).toBe(ideaB);
    expect(mine.body.hackathon.ranking).toBeNull();
    // Jury rates separately.
    const scores = Object.fromEntries((await api.jury.get(`/api/challenges/${challengeId}`)).body.juryCriteria.map((c: { id: string }) => [c.id, 5]));
    expect((await api.jury.put(`/api/challenges/${challengeId}/ideas/${ideaA}/jury-score`, { scores })).status).toBe(200);
    const view = await api.sponsor.get(`/api/challenges/${challengeId}/use-cases`);
    const ranking = view.body.hackathon.ranking;
    expect(ranking).toMatchObject({ juryWeight: 60, audienceWeight: 40 });
    const [first, second] = ranking.rows;
    expect(first).toMatchObject({ id: ideaA, rank: 1, juryScore: 100, votes: 0, audienceScore: 0, score: 60 });
    expect(second).toMatchObject({ id: ideaB, rank: 2, juryScore: null, votes: 2, audienceScore: 100, score: 40 });
    // No voter appears anywhere.
    const raw = JSON.stringify(view.body);
    expect(raw).not.toContain(users.v1.id);
    expect(raw).not.toContain(users.v2.id);
    // Weights follow the setting.
    expect((await api.sponsor.patch(`/api/challenges/${challengeId}/use-cases`, { audienceWeight: 70 })).status).toBe(200);
    const again = (await api.sponsor.get(`/api/challenges/${challengeId}/use-cases`)).body.hackathon.ranking.rows;
    expect(again.map((r: { id: string; score: number }) => [r.id, r.score])).toEqual([[ideaB, 70], [ideaA, 30]]);
  });

  it('shows the team page with members, anonymous teams hidden', async () => {
    await withTenant(tenant, (db) => db.query('UPDATE ideas SET anonymous = true WHERE id = $1', [ideaB]));
    const t = await api.v1.get(`/api/challenges/${challengeId}/teams`);
    expect(t.status).toBe(200);
    expect(t.body.locked).toBe(true);
    const a = t.body.teams.find((x: { id: string }) => x.id === ideaA);
    expect(a).toMatchObject({ teamName: 'Team A', size: 2 });
    expect(a.members.map((p: { name: string }) => p.name)).toEqual(['mia', 'max']);
    expect(t.body.teams.find((x: { id: string }) => x.id === ideaB).members).toBeNull();
    expect((await api.max.get(`/api/challenges/${challengeId}/teams`)).body.teams.find((x: { id: string }) => x.id === ideaB).members).toHaveLength(1);
    expect((await api.stranger.get(`/api/challenges/${challengeId}/teams`)).status).toBe(404);
  });
});

describe('tenant separation and roles (AP-22)', () => {
  it('keeps confirmations and votes inside the tenant (RLS)', async () => {
    const own = await withTenant(tenant, (db) => db.query<{ n: number }>('SELECT (SELECT count(*) FROM benefit_confirmations)::int + (SELECT count(*) FROM challenge_audience_votes)::int AS n'));
    expect(own.rows[0].n).toBeGreaterThan(0);
    const foreign = await withTenant(other, (db) => db.query<{ n: number }>('SELECT (SELECT count(*) FROM benefit_confirmations)::int + (SELECT count(*) FROM challenge_audience_votes)::int AS n'));
    expect(foreign.rows[0].n).toBe(0);
  });

  it('lists the controlling role with its right in the co-determination overview', async () => {
    const admin = await createUser(tenant, 'admin@uc.example', ['submitter', 'admin']);
    const c = client(app, await login(app, 'uc', admin.email));
    const o = await c.get('/api/codetermination');
    expect(o.status).toBe(200);
    const role = o.body.roles.find((r: { role: string }) => r.role === 'controlling');
    expect(role.permissions.map((p: { key: string }) => p.key)).toEqual(['confirmBenefit']);
  });
});
