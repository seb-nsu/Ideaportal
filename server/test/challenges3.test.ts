import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, withTenant } from '../src/db/pool.js';
import { runTenantJobs } from '../src/jobs/deadlines.js';
import type { SessionUser } from '../src/lib/context.js';
import { asUser, client, createTenant, createUser, login, resetDb, testApp, validIdea } from './helpers.js';

// Crowd rating by fixed criteria (R2-51) and challenge phases with templates (R2-52).

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
const runJobs = (day: string) => asUser(null, tenant, (ctx) => runTenantJobs(ctx), day);
const mails = async (user: SessionUser, subject: string) =>
  (await withTenant(tenant, (db) => db.query<{ n: number }>('SELECT count(*)::int AS n FROM outbox WHERE user_id = $1 AND subject = $2', [user.id, subject]))).rows[0].n;

beforeAll(async () => {
  await resetDb();
  app = await testApp();
  tenant = await createTenant('ch3', { holidays: [] });
  other = await createTenant('ch3b', { holidays: [] });
  users = {
    sponsor: await createUser(tenant, 'sponsor@c3.example', ['submitter', 'committee']),
    admin: await createUser(tenant, 'admin@c3.example', ['submitter', 'admin']),
    mia: await createUser(tenant, 'mia@c3.example'),
    jury: await createUser(tenant, 'jury@c3.example'),
    stranger: await createUser(other, 'stranger@c3.example', ['submitter', 'triage']),
  };
  for (let i = 1; i <= 6; i++) users[`r${i}`] = await createUser(tenant, `r${i}@c3.example`);
  api = {};
  for (const [k, u] of Object.entries(users)) api[k] = client(app, await login(app, k === 'stranger' ? 'ch3b' : 'ch3', u.email));
  today = (await api.mia.get('/api/settings')).body.today;
});

afterAll(async () => {
  await app.close();
  await closePool();
});

async function submitIdea(challengeId: string, by = 'mia', title = validIdea.title) {
  const d = await api[by].post('/api/ideas', { ...validIdea, title, challengeId });
  expect(d.status).toBe(201);
  return { id: d.body.id as string, submit: await api[by].post(`/api/ideas/${d.body.id}/submit`, SUBMIT) };
}

describe('crowd rating (R2-51)', () => {
  let challengeId: string;
  let ideaId: string;

  beforeAll(async () => {
    const c = await api.sponsor.post('/api/challenges', {
      title: 'Schwarm', question: 'Welche Ideen findet die Belegschaft am besten?', contact: 'Sponsor', startsOn: today, endsOn: '2099-12-31',
      ratingCriteria: [{ id: 'nutzen', label: 'Nutzen' }, { id: 'machbarkeit', label: 'Machbarkeit' }],
    });
    expect(c.status).toBe(201);
    challengeId = c.body.id;
    const idea = await submitIdea(challengeId);
    expect(idea.submit.status).toBe(200);
    ideaId = idea.id;
  });

  const rate = (by: string, scores: Record<string, number>) => api[by].put(`/api/challenges/${challengeId}/ideas/${ideaId}/rating`, { scores });

  it('allows one changeable rating per person, not on the own idea', async () => {
    expect((await rate('mia', { nutzen: 5, machbarkeit: 5 })).status).toBe(403);
    expect((await rate('r1', { nutzen: 5 })).status).toBe(400);
    expect((await rate('r1', { nutzen: 6, machbarkeit: 1 })).status).toBe(400);
    const first = await rate('r1', { nutzen: 1, machbarkeit: 1 });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ count: 1, criteria: null });
    // Changing the rating keeps one row per person.
    expect((await rate('r1', { nutzen: 5, machbarkeit: 4 })).body.count).toBe(1);
    const rows = await withTenant(tenant, (db) => db.query('SELECT scores FROM challenge_ratings WHERE idea_id = $1', [ideaId]));
    expect(rows.rows).toEqual([{ scores: { nutzen: 5, machbarkeit: 4 } }]);
  });

  it('shows mean and spread only from the minimum group size on', async () => {
    await rate('r2', { nutzen: 3, machbarkeit: 4 });
    await rate('r3', { nutzen: 4, machbarkeit: 4 });
    const four = await rate('r4', { nutzen: 2, machbarkeit: 4 });
    expect(four.body).toEqual({ count: 4, criteria: null });
    const below = await api.sponsor.get(`/api/challenges/${challengeId}`);
    expect(below.body.crowdRating.aggregates[ideaId]).toEqual({ count: 4, criteria: null });
    expect(below.body.crowdRating.minRatings).toBe(5);
    await rate('r5', { nutzen: 1, machbarkeit: 4 });
    const d = await api.sponsor.get(`/api/challenges/${challengeId}`);
    // nutzen 5,3,4,2,1: mean 3, population sd 1.414 -> 1.4; machbarkeit all 4: sd 0.
    expect(d.body.crowdRating.aggregates[ideaId]).toEqual({
      count: 5,
      criteria: [{ id: 'nutzen', mean: 3, sd: 1.4 }, { id: 'machbarkeit', mean: 4, sd: 0 }],
    });
    expect(d.body.crowdRating.criteria.map((c: { id: string }) => c.id)).toEqual(['nutzen', 'machbarkeit']);
    expect(d.body.crowdRating.open).toBe(true);
  });

  it('never shows who rated what, only the own rating to oneself', async () => {
    const mine = await api.r2.get(`/api/challenges/${challengeId}`);
    expect(mine.body.crowdRating.mine).toEqual({ [ideaId]: { nutzen: 3, machbarkeit: 4 } });
    expect((await api.sponsor.get(`/api/challenges/${challengeId}`)).body.crowdRating.mine).toEqual({});
    for (const who of ['sponsor', 'admin', 'r1']) {
      const body = JSON.stringify((await api[who].get(`/api/challenges/${challengeId}`)).body);
      for (let i = 1; i <= 5; i++) {
        if (who === `r${i}`) continue;
        expect(body).not.toContain(users[`r${i}`].id);
        expect(body).not.toContain(users[`r${i}`].email);
      }
    }
    // The idea itself does not list raters either.
    expect(JSON.stringify((await api.sponsor.get(`/api/ideas/${ideaId}`)).body)).not.toContain(users.r3.id);
  });

  it('keeps ratings within the tenant', async () => {
    expect((await api.stranger.get(`/api/challenges/${challengeId}`)).status).toBe(404);
    expect((await api.stranger.put(`/api/challenges/${challengeId}/ideas/${ideaId}/rating`, { scores: { nutzen: 1, machbarkeit: 1 } })).status).toBe(404);
    const theirs = await withTenant(other, (db) => db.query<{ n: number }>('SELECT count(*)::int AS n FROM challenge_ratings'));
    expect(theirs.rows[0].n).toBe(0);
    const ours = await withTenant(tenant, (db) => db.query<{ n: number }>('SELECT count(*)::int AS n FROM challenge_ratings'));
    expect(ours.rows[0].n).toBe(5);
  });

  it('can be switched off per tenant', async () => {
    const s = (await api.admin.get('/api/admin/settings')).body;
    expect(s.challenges).toMatchObject({ crowdRating: true }); // plus kWh factors (R3-32)
    expect((await api.admin.put('/api/admin/settings', { ...s, challenges: { crowdRating: false } })).status).toBe(200);
    expect((await rate('r6', { nutzen: 3, machbarkeit: 3 })).status).toBe(403);
    expect((await api.sponsor.get(`/api/challenges/${challengeId}`)).body.crowdRating).toBeNull();
    // Settings are versioned (R3-41): read the current version before the second change.
    const s2 = (await api.admin.get('/api/admin/settings')).body;
    expect((await api.admin.put('/api/admin/settings', { ...s2, challenges: { ...s2.challenges, crowdRating: true } })).status).toBe(200);
    expect((await rate('r6', { nutzen: 3, machbarkeit: 3 })).status).toBe(200);
  });
});

describe('phases and templates (R2-52)', () => {
  let challengeId: string;
  let ideaId: string;
  const title = 'Phasen-Challenge';
  const plan = () => ({ collect: today, rate: addDays(today, 10), elaborate: addDays(today, 20), jury: addDays(today, 30), result: addDays(today, 40) });

  it('offers the templates to the people who start challenges', async () => {
    expect((await api.mia.get('/api/challenges/templates')).status).toBe(403);
    const t = await api.sponsor.get('/api/challenges/templates');
    expect(t.status).toBe(200);
    expect(t.body.map((x: { name: string }) => x.name)).toEqual(['Ideenwettbewerb', 'Nachhaltigkeit', 'Kostensenkung', 'Hackathon']); // Hackathon: R3-34
    const green = t.body[1];
    expect(green.topic).toBe('Nachhaltigkeit');
    expect(green.ratingCriteria.length).toBeGreaterThan(1);
    expect(green.customFields[0].type).toBe('number');
    expect(Object.keys(green.phaseDays)).toEqual(['collect', 'rate', 'elaborate', 'jury', 'result']);
  });

  it('checks the phase plan', async () => {
    const base = { title, question: 'Wie führen wir Wettbewerbe in Phasen durch?', contact: 'Sponsor', startsOn: today, endsOn: addDays(today, 50) };
    expect((await api.sponsor.post('/api/challenges', { ...base, phasePlan: { ...plan(), rate: addDays(today, 25) } })).status).toBe(400);
    expect((await api.sponsor.post('/api/challenges', { ...base, endsOn: addDays(today, 35), phasePlan: plan() })).status).toBe(400);
    const c = await api.sponsor.post('/api/challenges', { ...base, phasePlan: plan(), template: 'idea_contest' });
    expect(c.status).toBe(201);
    challengeId = c.body.id;
    const d = await api.mia.get(`/api/challenges/${challengeId}`);
    expect(d.body.phase).toBe('collect');
    expect(d.body.acceptsIdeas).toBe(true);
    expect(d.body.template).toBe('idea_contest');
    // Default crowd-rating criteria.
    expect(d.body.crowdRating.criteria.map((x: { label: string }) => x.label)).toEqual(['Nutzen', 'Machbarkeit']);
    expect((await api.sponsor.put(`/api/challenges/${challengeId}/jury`, { userIds: [users.jury.id] })).status).toBe(200);
  });

  it('takes ideas only while collecting and ratings only while rating', async () => {
    const idea = await submitIdea(challengeId, 'mia', 'Phasenidee');
    expect(idea.submit.status).toBe(200);
    ideaId = idea.id;
    expect((await api.r1.put(`/api/challenges/${challengeId}/ideas/${ideaId}/rating`, { scores: { benefit: 4, feasibility: 4 } })).status).toBe(409);

    const res = await runJobs(addDays(today, 10));
    expect(res.challengePhases).toBe(1);
    const d = await api.mia.get(`/api/challenges/${challengeId}`);
    expect(d.body.phase).toBe('rate');
    expect(d.body.acceptsIdeas).toBe(false);
    expect((await api.mia.get('/api/challenges')).body.find((c: { id: string }) => c.id === challengeId).acceptsIdeas).toBe(false);
    const late = await submitIdea(challengeId, 'r2', 'Zu spät');
    expect(late.submit.status).toBe(409);
    expect((await api.r1.put(`/api/challenges/${challengeId}/ideas/${ideaId}/rating`, { scores: { benefit: 4, feasibility: 4 } })).status).toBe(200);
  });

  it('notifies sponsor and participants once per transition', async () => {
    const subject = `Challenge „${title}“: Jetzt wird bewertet`;
    expect(await mails(users.sponsor, subject)).toBe(1);
    expect(await mails(users.mia, subject)).toBe(1);
    expect(await mails(users.r5, subject)).toBe(0);
    // Same day again: no new transition, no new mail.
    expect((await runJobs(addDays(today, 10))).challengePhases).toBe(0);
    expect(await mails(users.sponsor, subject)).toBe(1);
    // Skipping a phase: only the phase reached is announced; the jury gets its task.
    expect((await runJobs(addDays(today, 31))).challengePhases).toBe(1);
    expect((await api.mia.get(`/api/challenges/${challengeId}`)).body.phase).toBe('jury');
    const jury = `Challenge „${title}“: Die Jury bewertet`;
    expect(await mails(users.jury, jury)).toBe(1);
    expect(await mails(users.sponsor, jury)).toBe(1);
    expect(await mails(users.mia, jury)).toBe(1);
    expect(await mails(users.mia, `Challenge „${title}“: Phase Ausarbeiten`)).toBe(0);
    expect((await api.r1.put(`/api/challenges/${challengeId}/ideas/${ideaId}/rating`, { scores: { benefit: 1, feasibility: 1 } })).status).toBe(409);
  });

  it('lets the sponsor change the plan and ends in the result phase', async () => {
    expect((await api.mia.patch(`/api/challenges/${challengeId}`, { phasePlan: plan() })).status).toBe(403);
    // Moving the plan into the past switches the phase right away.
    const past = { collect: addDays(today, -40), rate: addDays(today, -30), elaborate: addDays(today, -20), jury: addDays(today, -10), result: addDays(today, -1) };
    expect((await api.sponsor.patch(`/api/challenges/${challengeId}`, { phasePlan: past })).status).toBe(200);
    const d = await api.mia.get(`/api/challenges/${challengeId}`);
    expect(d.body.phase).toBe('result');
    expect(d.body.ended).toBe(true);
    expect(d.body.startsOn).toBe(past.collect);
    expect(await mails(users.mia, `Challenge „${title}“: Ergebnis`)).toBe(1);
    expect((await api.sponsor.post(`/api/challenges/${challengeId}/ranking/publish`)).status).toBe(200);
  });

  it('keeps challenges without a phase plan as before', async () => {
    const c = await api.sponsor.post('/api/challenges', {
      title: 'Ohne Phasen', question: 'Läuft eine Challenge ohne Phasen wie bisher?', contact: 'Sponsor', startsOn: today, endsOn: '2099-12-31',
    });
    const d = await api.mia.get(`/api/challenges/${c.body.id}`);
    expect(d.body.phase).toBeNull();
    expect(d.body.acceptsIdeas).toBe(true);
    expect((await submitIdea(c.body.id, 'r3', 'Ohne Phasen')).submit.status).toBe(200);
    expect((await runJobs(addDays(today, 100))).challengePhases).toBe(0);
    // Closing sets no phase.
    expect((await api.sponsor.post(`/api/challenges/${c.body.id}/close`, {})).status).toBe(200);
    expect((await api.mia.get(`/api/challenges/${c.body.id}`)).body.phase).toBeNull();
  });
});
