import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, withTenant } from '../src/db/pool.js';
import type { SessionUser } from '../src/lib/context.js';
import { client, createTenant, createUser, login, resetDb, testApp, validIdea } from './helpers.js';

// Core flow of Release 1: submit -> Gate 1 -> fast lane / elaboration -> Gate 2 -> implementation -> benefit.

let app: FastifyInstance;
let tenant: string;
let users: Record<string, SessionUser>;
let api: Record<string, ReturnType<typeof client>>;

const channel = { id: 'servicedesk', name: 'IT-Service-Desk', kind: 'service_desk', contact: 'servicedesk@x.example', url: 'https://sd.example' };

beforeAll(async () => {
  await resetDb();
  app = await testApp();
  tenant = await createTenant('flow', { targetChannels: [channel] });
  users = {
    mia: await createUser(tenant, 'mia@x.example', ['submitter'], 'Vertrieb'),
    max: await createUser(tenant, 'max@x.example', ['submitter'], 'Einkauf'),
    triage: await createUser(tenant, 'triage@x.example', ['submitter', 'triage']),
    committee: await createUser(tenant, 'gremium@x.example', ['submitter', 'committee']),
    owner: await createUser(tenant, 'owner@x.example', ['submitter', 'implementer'], 'Produktion'),
  };
  api = {};
  for (const [k, u] of Object.entries(users)) api[k] = client(app, await login(app, 'flow', u.email));
});

afterAll(async () => {
  await app.close();
  await closePool();
});

async function submitted(by = 'mia', extra: Record<string, unknown> = {}): Promise<string> {
  const created = await api[by].post('/api/ideas', { ...validIdea, ...extra });
  expect(created.status).toBe(201);
  const sub = await api[by].post(`/api/ideas/${created.body.id}/submit`, { confirmNotReport: true });
  expect(sub.status).toBe(200);
  return created.body.id;
}

describe('submission (R1-12, R1-18)', () => {
  it('requires the "idea, not a report" confirmation', async () => {
    const created = await api.mia.post('/api/ideas', validIdea);
    const res = await api.mia.post(`/api/ideas/${created.body.id}/submit`, { confirmNotReport: false });
    expect(res.status).toBe(400);
  });

  it('detects concerns that belong into another channel and stores nothing on its own', async () => {
    const check = await api.mia.post('/api/boundary-check', { text: 'Ich möchte eine Belästigung durch einen Kollegen melden' });
    expect(check.body.matches[0].category).toBe('report');
    const check2 = await api.mia.post('/api/boundary-check', { text: 'Der Drucker hat eine Störung' });
    expect(check2.body.matches[0].channel.name).toBe('IT-Service-Desk');

    const before = await withTenant(tenant, (db) => db.query('SELECT count(*)::int AS n FROM ideas'));
    expect(check.status).toBe(200);
    const after = await withTenant(tenant, (db) => db.query('SELECT count(*)::int AS n FROM ideas'));
    expect(after.rows[0].n).toBe(before.rows[0].n);

    const created = await api.mia.post('/api/ideas', { ...validIdea, problem: 'Es gibt ständig eine Störung beim Kaffeeautomaten im 2. Stock.' });
    const blocked = await api.mia.post(`/api/ideas/${created.body.id}/submit`, { confirmNotReport: true });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('BOUNDARY_CHECK');
    const ok = await api.mia.post(`/api/ideas/${created.body.id}/submit`, { confirmNotReport: true, boundaryAcknowledged: true });
    expect(ok.status).toBe(200);
  });

  it('starts the Gate 1 deadline in working days', async () => {
    const id = await submitted();
    const detail = await api.mia.get(`/api/ideas/${id}`);
    expect(detail.body.status).toBe('submitted');
    expect(detail.body.deadline.phase).toBe('gate1');
    expect(detail.body.deadline.remainingWorkdays).toBe(10);
    expect(detail.body.deadline.light).toBe('green');
  });

  it('finds similar ideas', async () => {
    const res = await api.max.get(`/api/ideas/similar?text=${encodeURIComponent('Wartezeit an der Kantine verkürzen')}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.length).toBeLessThanOrEqual(5);
  });
});

describe('rights (R1-10, R1-14)', () => {
  it('lets only the triage team triage', async () => {
    const id = await submitted();
    expect((await api.max.post(`/api/ideas/${id}/triage`, { lane: 'elaborate' })).status).toBe(403);
    expect((await api.committee.post(`/api/ideas/${id}/triage`, { lane: 'elaborate' })).status).toBe(403);
    expect((await api.max.get('/api/triage/board')).status).toBe(403);
    expect((await api.max.get('/api/admin/settings')).status).toBe(403);
  });

  it('hides confidential ideas from the community', async () => {
    const id = await submitted('mia', { confidential: true, title: 'Vertrauliche Idee zur Preisgestaltung' });
    expect((await api.max.get(`/api/ideas/${id}`)).status).toBe(404);
    expect((await api.triage.get(`/api/ideas/${id}`)).status).toBe(200);
    expect((await api.mia.get(`/api/ideas/${id}`)).status).toBe(200);
    const feed = await api.max.get('/api/ideas?scope=feed');
    expect(feed.body.some((i: { id: string }) => i.id === id)).toBe(false);
  });

  it('hides the author of anonymous ideas from everyone except triage', async () => {
    const id = await submitted('mia', { anonymous: true, title: 'Anonyme Idee für bessere Meetings' });
    expect((await api.max.get(`/api/ideas/${id}`)).body.author).toBeNull();
    expect((await api.triage.get(`/api/ideas/${id}`)).body.author.name).toBe('mia');
    const feed = await api.max.get('/api/ideas?scope=feed');
    expect(feed.body.find((i: { id: string }) => i.id === id).authorName).toBeNull();
  });

  it('keeps drafts private', async () => {
    const created = await api.mia.post('/api/ideas', validIdea);
    expect((await api.max.get(`/api/ideas/${created.body.id}`)).status).toBe(404);
    expect((await api.triage.get(`/api/ideas/${created.body.id}`)).status).toBe(404);
  });
});

describe('Gate 1 (R1-24, R1-27, R1-28)', () => {
  it('pauses the deadline during a question and allows at most two rounds', async () => {
    const id = await submitted();
    expect((await api.triage.post(`/api/ideas/${id}/question`, { question: 'Welche Abteilungen sind betroffen?' })).status).toBe(200);
    let d = await api.mia.get(`/api/ideas/${id}`);
    expect(d.body.status).toBe('in_question');
    expect(d.body.deadline.paused).toBe(true);
    expect(d.body.deadline.light).toBe('paused');
    expect((await api.mia.post(`/api/ideas/${id}/answer`, { answer: 'Alle Abteilungen am Standort.' })).status).toBe(200);
    d = await api.mia.get(`/api/ideas/${id}`);
    expect(d.body.status).toBe('submitted');
    expect(d.body.deadline.paused).toBe(false);
    await api.triage.post(`/api/ideas/${id}/question`, { question: 'Wie viele Personen pro Tag?' });
    await api.mia.post(`/api/ideas/${id}/answer`, { answer: 'Etwa 300.' });
    const third = await api.triage.post(`/api/ideas/${id}/question`, { question: 'Noch eine Frage?' });
    expect(third.status).toBe(409);
  });

  it('requires a reason for reject and forward and informs the author', async () => {
    const id = await submitted();
    expect((await api.triage.post(`/api/ideas/${id}/triage`, { lane: 'reject' })).status).toBe(400);
    expect((await api.triage.post(`/api/ideas/${id}/triage`, { lane: 'forward', channelId: 'servicedesk' })).status).toBe(400);
    const res = await api.triage.post(`/api/ideas/${id}/triage`, {
      lane: 'forward', channelId: 'servicedesk', reason: 'Das ist eine Service-Anfrage.', deleteContent: true,
    });
    expect(res.status).toBe(200);
    const d = await api.mia.get(`/api/ideas/${id}`);
    expect(d.body.status).toBe('forwarded');
    expect(d.body.forwardedTo).toBe('IT-Service-Desk');
    expect(d.body.problem).toBe('[Inhalt entfernt]');
    expect(d.body.deadline).toBeNull();
    expect(d.body.feedbackPending).toBe('gate1');
    const inbox = await api.mia.get('/api/notifications');
    expect(inbox.body.items.some((n: { body: string }) => n.body.includes('servicedesk@x.example'))).toBe(true);
  });
});

describe('fast lane to benefit (R1-29, R1-31, R1-32, R1-35)', () => {
  it('runs the whole fast lane', async () => {
    const id = await submitted();
    const target = '2099-12-31';
    const tri = await api.triage.post(`/api/ideas/${id}/triage`, {
      lane: 'fast_lane', reason: 'Kleiner Aufwand.', ownerId: users.owner.id, orgUnit: 'Produktion', targetDate: target,
    });
    expect(tri.status).toBe(200);
    // Someone else cannot accept or close.
    expect((await api.max.post(`/api/ideas/${id}/implementation/accept`)).status).toBe(403);
    expect((await api.owner.post(`/api/ideas/${id}/implementation/accept`)).status).toBe(200);
    expect((await api.owner.patch(`/api/ideas/${id}/implementation`, { progress: 50, externalRef: 'JIRA-1' })).status).toBe(200);
    const close = await api.owner.post(`/api/ideas/${id}/implementation/close`, {
      benefitKind: 'hours', benefitValue: 120, benefitEvidence: 'Messung über vier Wochen im Pilotbereich.',
    });
    expect(close.status).toBe(200);
    const d = await api.mia.get(`/api/ideas/${id}`);
    expect(d.body.status).toBe('completed');
    expect(d.body.implementation.benefitValue).toBe(120);
    expect(d.body.feedbackPending).toBe('completed');
    expect((await api.mia.post(`/api/ideas/${id}/feedback`, { score: 5 })).status).toBe(200);
    expect((await api.mia.post(`/api/ideas/${id}/feedback`, { score: 4 })).status).toBe(409);
  });
});

describe('Gate 2 (R1-30)', () => {
  it('decides with reason and owner and creates the implementation', async () => {
    const id = await submitted();
    await api.triage.post(`/api/ideas/${id}/triage`, { lane: 'elaborate' });
    const d1 = await api.mia.get(`/api/ideas/${id}`);
    expect(d1.body.status).toBe('elaboration');
    expect(d1.body.deadline.phase).toBe('elaboration');
    expect(d1.body.deadline.remainingWorkdays).toBe(30);

    expect((await api.triage.post(`/api/ideas/${id}/decision`, { outcome: 'implement', reason: 'Guter Business Case.' })).status).toBe(403);
    expect((await api.committee.post(`/api/ideas/${id}/decision`, { outcome: 'implement', reason: 'Guter Business Case.' })).status).toBe(400);
    const ok = await api.committee.post(`/api/ideas/${id}/decision`, {
      outcome: 'pilot', reason: 'Erst im Pilotbereich testen.', ownerId: users.owner.id, targetDate: '2099-06-30',
    });
    expect(ok.status).toBe(200);
    const d2 = await api.owner.get(`/api/ideas/${id}`);
    expect(d2.body.status).toBe('piloting');
    expect(d2.body.implementation.channel).toBe('experiment');
    expect(d2.body.implementation.status).toBe('active');
    expect(d2.body.can.closeImplementation).toBe(true);
  });

  it('parks only with a resubmission date within six months', async () => {
    const id = await submitted();
    await api.triage.post(`/api/ideas/${id}/triage`, { lane: 'elaborate' });
    const tooLate = await api.committee.post(`/api/ideas/${id}/decision`, { outcome: 'park', reason: 'Budget erst nächstes Jahr.', resubmitOn: '2099-01-01' });
    expect(tooLate.status).toBe(400);
    const settings = await api.max.get('/api/settings');
    const soon = new Date(`${settings.body.today}T00:00:00Z`);
    soon.setUTCMonth(soon.getUTCMonth() + 2);
    const ok = await api.committee.post(`/api/ideas/${id}/decision`, { outcome: 'park', reason: 'Budget erst nächstes Jahr.', resubmitOn: soon.toISOString().slice(0, 10) });
    expect(ok.status).toBe(200);
    expect((await api.mia.get(`/api/ideas/${id}`)).body.status).toBe('parked');
  });
});

describe('community, challenges and dashboard', () => {
  it('supports once per person and comments', async () => {
    const id = await submitted();
    expect((await api.max.post(`/api/ideas/${id}/support`)).status).toBe(200);
    expect((await api.max.post(`/api/ideas/${id}/support`)).status).toBe(200);
    expect((await api.mia.post(`/api/ideas/${id}/support`)).status).toBe(400);
    expect((await api.max.post(`/api/ideas/${id}/comments`, { body: 'Gute Idee!' })).status).toBe(201);
    const d = await api.max.get(`/api/ideas/${id}`);
    expect(d.body.supporters).toBe(1);
    expect(d.body.comments).toHaveLength(1);
  });

  it('creates challenges and assigns ideas', async () => {
    expect((await api.max.post('/api/challenges', {})).status).toBe(403);
    const c = await api.triage.post('/api/challenges', {
      title: 'Weniger Papier', question: 'Wo können wir auf Papier verzichten?', contact: 'Team Innovation', startsOn: '2026-01-01', endsOn: '2099-12-31',
    });
    expect(c.status).toBe(201);
    await submitted('max', { challengeId: c.body.id, title: 'Rechnungen nur noch digital' });
    const detail = await api.mia.get(`/api/challenges/${c.body.id}`);
    expect(detail.body.ideas).toHaveLength(1);
    const closed = await api.triage.post(`/api/challenges/${c.body.id}/close`, {});
    expect(closed.body.summary).toMatch(/^1 Idee/);
  });

  it('aggregates the dashboard and hides groups below five people', async () => {
    const res = await api.triage.get('/api/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.submitted).toBeGreaterThan(5);
    // Only two people submitted (mia, max) -> merged group without numbers; satisfaction hidden.
    expect(res.body.byUnit.every((u: { merged: boolean; ideas: number | null }) => u.merged && u.ideas === null)).toBe(true);
    expect(res.body.satisfaction.avg).toBeNull();
    const csv = await app.inject({ method: 'GET', url: '/api/dashboard.csv', headers: { cookie: '' } });
    expect(csv.statusCode).toBe(401);
  });
});
