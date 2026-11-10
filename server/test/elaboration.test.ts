import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, withTenant } from '../src/db/pool.js';
import type { SessionUser } from '../src/lib/context.js';
import { createExperiment, saveDossierSection } from '../src/services/elaboration.js';
import { upsertSuccessStoryDraft } from '../src/services/recognition.js';
import { loadIdea } from '../src/services/workflow.js';
import { asUser, client, createTenant, createUser, login, resetDb, testApp, validIdea } from './helpers.js';

// Release 2, epic J: mentor and timebox (R2-01), dossier (R2-02), scorecard (R2-03), meetings (R2-04),
// delegation (R2-05), experiments (R2-06), impact review (R2-07), portfolio (R2-08),
// success stories (R2-37, R2-38) and tenant separation of all new tables.

let app: FastifyInstance;
let tenant: string;
let other: string;
let users: Record<string, SessionUser>;
let api: Record<string, ReturnType<typeof client>>;
let today: string;

function plusDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The Monday three to four weeks after `date`, so working-day arithmetic does not depend on the weekday the tests run. */
function mondayInThreeWeeks(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return plusDays(date, 21 + ((8 - weekday) % 7));
}

beforeAll(async () => {
  await resetDb();
  app = await testApp();
  tenant = await createTenant('r2', { holidays: [] });
  other = await createTenant('r2-nachbar', { holidays: [] });
  users = {
    author: await createUser(tenant, 'author@r2.example', ['submitter'], 'Vertrieb'),
    max: await createUser(tenant, 'max@r2.example', ['submitter'], 'Einkauf'),
    triage: await createUser(tenant, 'triage@r2.example', ['submitter', 'triage'], 'Innovation'),
    committee: await createUser(tenant, 'committee@r2.example', ['submitter', 'committee'], 'Leitung'),
    mentor: await createUser(tenant, 'mentor@r2.example', ['submitter', 'mentor'], 'Produkt'),
    lead: await createUser(tenant, 'lead@r2.example', ['submitter', 'lead'], 'Vertrieb'),
    leadOther: await createUser(tenant, 'lead2@r2.example', ['submitter', 'lead'], 'Einkauf'),
    owner: await createUser(tenant, 'owner@r2.example', ['submitter', 'implementer'], 'Produktion'),
    sponsor: await createUser(tenant, 'sponsor@r2.example', ['submitter'], 'Leitung'),
    stranger: await createUser(other, 'stranger@n.example', ['submitter', 'triage', 'committee', 'admin']),
  };
  api = {};
  for (const [k, u] of Object.entries(users)) api[k] = client(app, await login(app, k === 'stranger' ? 'r2-nachbar' : 'r2', u.email));
  today = (await api.author.get('/api/settings')).body.today;
});

afterAll(async () => {
  await app.close();
  await closePool();
});

async function submitted(extra: Record<string, unknown> = {}, by = 'author'): Promise<string> {
  const created = await api[by].post('/api/ideas', { ...validIdea, ...extra });
  expect(created.status).toBe(201);
  expect((await api[by].post(`/api/ideas/${created.body.id}/submit`, { confirmNotReport: true, boundaryAcknowledged: true })).status).toBe(200);
  return created.body.id;
}

async function elaborated(extra: Record<string, unknown> = {}, mentorId: string | undefined = users.mentor.id): Promise<string> {
  const id = await submitted(extra);
  const res = await api.triage.post(`/api/ideas/${id}/triage`, { lane: 'elaborate', mentorId });
  expect(res.status).toBe(200);
  return id;
}

const inbox = async (user: SessionUser, subject: string) =>
  (await withTenant(tenant, (db) => db.query('SELECT count(*)::int AS n FROM outbox WHERE user_id = $1 AND subject LIKE $2', [user.id, `${subject}%`]))).rows[0].n;

const allFives = () => Object.fromEntries(['strategic_fit', 'user_value', 'economic_value', 'feasibility', 'risk'].map((k) => [k, 5]));

describe('mentor and timebox (R2-01)', () => {
  it('assigns the mentor with a task and a default timebox of six weeks', async () => {
    const id = await elaborated({ title: 'Paten-Test eins' });
    const d = await api.author.get(`/api/ideas/${id}`);
    expect(d.body.mentor.id).toBe(users.mentor.id);
    expect(d.body.timeboxUntil).toBe(plusDays(today, 42));
    expect(await inbox(users.mentor, 'Du bist Pate')).toBeGreaterThanOrEqual(1);
    const tasks = await api.mentor.get('/api/tasks');
    expect(tasks.body.mentoring.map((t: { id: string }) => t.id)).toContain(id);
  });

  it('warns from two active ideas per mentor', async () => {
    await elaborated({ title: 'Paten-Test zwei' });
    const load = await api.triage.get(`/api/mentors/${users.mentor.id}/load`);
    expect(load.body.active).toBeGreaterThanOrEqual(2);
    expect(load.body.warning).toMatch(/bereits/);
    expect((await api.author.get(`/api/mentors/${users.mentor.id}/load`)).status).toBe(403);
    const id = await submitted({ title: 'Paten-Test drei' });
    const res = await api.triage.post(`/api/ideas/${id}/triage`, { lane: 'elaborate', mentorId: users.mentor.id });
    expect(res.body.warning).toMatch(/Warnschwelle 2/);
  });

  it('lets only triage reassign the mentor', async () => {
    const id = await elaborated({ title: 'Paten-Wechsel' }, undefined);
    expect((await api.author.post(`/api/ideas/${id}/mentor`, { mentorId: users.max.id })).status).toBe(403);
    const res = await api.triage.post(`/api/ideas/${id}/mentor`, { mentorId: users.max.id, timeboxUntil: plusDays(today, 14) });
    expect(res.status).toBe(200);
    expect(res.body.warning).toBeNull();
    expect((await api.max.get(`/api/ideas/${id}`)).body.timeboxUntil).toBe(plusDays(today, 14));
  });

  it('shows confidential ideas to their mentor', async () => {
    const id = await elaborated({ title: 'Vertraulich mit Pate', confidential: true });
    expect((await api.mentor.get(`/api/ideas/${id}`)).status).toBe(200);
    expect((await api.max.get(`/api/ideas/${id}`)).status).toBe(404);
  });
});

describe('dossier (R2-02)', () => {
  let id: string;
  beforeAll(async () => {
    id = await elaborated({ title: 'Dossier-Test' });
  });

  it('allows editing only for mentor, authors and triage', async () => {
    expect((await api.max.post(`/api/ideas/${id}/dossier/benefit/lock`)).status).toBe(403);
    expect((await api.committee.put(`/api/ideas/${id}/dossier/benefit`, { content: 'x', expectedVersion: 0 })).status).toBe(403);
    expect((await api.max.patch(`/api/ideas/${id}/estimates`, { effortPersonDays: 3 })).status).toBe(403);
    const overview = await api.mentor.get(`/api/ideas/${id}/elaboration`);
    expect(overview.body.can.editDossier).toBe(true);
    expect(overview.body.sections.map((s: { section: string }) => s.section)).toEqual(['summary', 'benefit', 'effort', 'risks', 'affected', 'path', 'analyses']);
    expect((await api.max.get(`/api/ideas/${id}/elaboration`)).body.can.editDossier).toBe(false);
  });

  it('locks a section while someone edits it', async () => {
    const lock = await api.mentor.post(`/api/ideas/${id}/dossier/benefit/lock`);
    expect(lock.status).toBe(200);
    const blocked = await api.author.post(`/api/ideas/${id}/dossier/benefit/lock`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('SECTION_LOCKED');
    expect((await api.author.put(`/api/ideas/${id}/dossier/benefit`, { content: 'Zwischenruf', expectedVersion: 0 })).body.code).toBe('SECTION_LOCKED');
    // Other sections are free.
    expect((await api.author.post(`/api/ideas/${id}/dossier/risks/lock`)).status).toBe(200);
    expect((await api.author.del(`/api/ideas/${id}/dossier/risks/lock`)).status).toBe(200);
    // AI never overwrites a section someone is editing.
    await expect(asUser(null, tenant, async (ctx) => saveDossierSection(ctx, await loadIdea(ctx, id), 'benefit', 'KI', { source: 'ai' }))).rejects.toThrow(/bearbeitet/);
  });

  it('saves versions, checks the version and keeps a history', async () => {
    const saved = await api.mentor.put(`/api/ideas/${id}/dossier/benefit`, { content: 'Nutzen: 200 Stunden pro Jahr (Schätzung).', expectedVersion: 0, openPoints: ['Zahlen prüfen'] });
    expect(saved.body.version).toBe(1);
    // The lock is released on save.
    const stale = await api.author.put(`/api/ideas/${id}/dossier/benefit`, { content: 'Alte Fassung', expectedVersion: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    expect((await api.author.put(`/api/ideas/${id}/dossier/benefit`, { content: 'Nutzen: 250 Stunden pro Jahr.', expectedVersion: 1 })).body.version).toBe(2);
    const ai = await asUser(null, tenant, async (ctx) => saveDossierSection(ctx, await loadIdea(ctx, id), 'benefit', 'KI-Entwurf', { source: 'ai', openPoints: ['Quelle fehlt'] }));
    expect(ai.version).toBe(3);
    const history = await api.max.get(`/api/ideas/${id}/dossier/benefit/history`);
    expect(history.body.map((h: { version: number; source: string }) => [h.version, h.source])).toEqual([[3, 'ai'], [2, 'human'], [1, 'human']]);
    expect(history.body[2].content).toMatch(/200 Stunden/);
    const overview = await api.max.get(`/api/ideas/${id}/elaboration`);
    expect(overview.body.sections.find((s: { section: string }) => s.section === 'benefit').openPoints).toEqual(['Quelle fehlt']);
  });

  it('stores the structured estimates', async () => {
    expect((await api.mentor.patch(`/api/ideas/${id}/estimates`, { horizon: 2, effortPersonDays: 12, effortEuro: 8000, planBenefitEuro: 40000 })).status).toBe(200);
    expect((await api.mentor.patch(`/api/ideas/${id}/estimates`, { horizon: 4 })).status).toBe(400);
    const o = await api.author.get(`/api/ideas/${id}/elaboration`);
    expect(o.body.estimates).toEqual({ horizon: 2, effortPersonDays: 12, effortEuro: 8000, planBenefitEuro: 40000 });
  });
});

describe('weighted scorecard (R2-03)', () => {
  it('computes the weighted total and shows single ratings only to deciders', async () => {
    const id = await elaborated({ title: 'Scorecard-Test' });
    expect((await api.max.put(`/api/ideas/${id}/scorecard`, { scores: allFives() })).status).toBe(403);
    expect((await api.mentor.put(`/api/ideas/${id}/scorecard`, { scores: { strategic_fit: 5 } })).status).toBe(400);
    const scores = { strategic_fit: 5, user_value: 4, economic_value: 3, feasibility: 2, risk: 1 };
    const r = await api.mentor.put(`/api/ideas/${id}/scorecard`, { scores });
    expect(r.body.total).toBe(3.3); // (5*25 + 4*25 + 3*20 + 2*15 + 1*15) / 100
    expect((await api.committee.put(`/api/ideas/${id}/scorecard`, { scores: allFives() })).body.total).toBe(5);
    // Updating replaces the own rating.
    expect((await api.committee.put(`/api/ideas/${id}/scorecard`, { scores: { ...allFives(), risk: 3 } })).body.total).toBe(4.7);
    const view = await api.committee.get(`/api/ideas/${id}/scorecard`);
    expect(view.body.average).toMatchObject({ total: 4, count: 2 });
    expect(view.body.ratings).toHaveLength(2);
    expect(view.body.criteria[0].anchors['1']).toBeTruthy();
    const authorView = await api.author.get(`/api/ideas/${id}/scorecard`);
    expect(authorView.body.ratings).toBeNull();
    expect(authorView.body.average.total).toBe(4);
  });
});

describe('delegation to the head of department (R2-05)', () => {
  it('lets the lead decide below the threshold for ideas of the own unit', async () => {
    const id = await elaborated({ title: 'Delegation klein' });
    expect((await api.lead.post(`/api/ideas/${id}/decision`, { outcome: 'reject', reason: 'Passt nicht in die Planung.' })).status).toBe(403);
    await api.mentor.patch(`/api/ideas/${id}/estimates`, { effortPersonDays: 10, effortEuro: 5000 });
    expect((await api.leadOther.post(`/api/ideas/${id}/decision`, { outcome: 'reject', reason: 'Passt nicht in die Planung.' })).status).toBe(403);
    const detail = await api.lead.get(`/api/ideas/${id}`);
    expect(detail.body.can.decide).toBe(true);
    expect(detail.body.can.decideDelegated).toBe(true);
    const ok = await api.lead.post(`/api/ideas/${id}/decision`, {
      outcome: 'implement', reason: 'Kleiner Aufwand im eigenen Bereich.', ownerId: users.owner.id, targetDate: plusDays(today, 60),
    });
    expect(ok.status).toBe(200);
    const d = await withTenant(tenant, (db) => db.query('SELECT delegated FROM decisions WHERE idea_id = $1 AND gate = 2', [id]));
    expect(d.rows[0].delegated).toBe(true);
    const dash = await api.lead.get('/api/dashboard');
    expect(dash.body.gate2Decisions.delegated).toBeGreaterThanOrEqual(1);
  });

  it('refuses the lead above the threshold', async () => {
    const id = await elaborated({ title: 'Delegation groß' });
    await api.mentor.patch(`/api/ideas/${id}/estimates`, { effortPersonDays: 26, effortEuro: 5000 });
    const res = await api.lead.post(`/api/ideas/${id}/decision`, { outcome: 'reject', reason: 'Passt nicht in die Planung.' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Delegationsschwelle/);
    // The committee decides as before, not delegated.
    expect((await api.committee.post(`/api/ideas/${id}/decision`, { outcome: 'reject', reason: 'Passt nicht in die Planung.' })).status).toBe(200);
    const d = await withTenant(tenant, (db) => db.query('SELECT delegated FROM decisions WHERE idea_id = $1 AND gate = 2', [id]));
    expect(d.rows[0].delegated).toBe(false);
  });
});

describe('committee meetings (R2-04)', () => {
  let meetingId: string;
  const ideas: string[] = [];

  it('plans meetings with the pack five working days before', async () => {
    const meetsOn = mondayInThreeWeeks(today);
    expect((await api.committee.post('/api/meetings', { title: 'Gremium Q4', meetsOn })).status).toBe(403);
    const r = await api.triage.post('/api/meetings', { title: 'Gremium Q4', meetsOn });
    expect(r.status).toBe(201);
    expect(r.body.packDueOn).toBe(plusDays(meetsOn, -7)); // a Monday minus 5 working days is the Monday before
    meetingId = r.body.id;
    expect((await api.max.get('/api/meetings')).status).toBe(403);
    expect((await api.committee.get('/api/meetings')).body.items.length).toBe(1);
  });

  it('accepts at most five ideas in elaboration', async () => {
    const notReady = await submitted({ title: 'Noch nicht ausgearbeitet' });
    expect((await api.triage.post(`/api/meetings/${meetingId}/items`, { ideaId: notReady })).status).toBe(409);
    for (let i = 0; i < 6; i++) ideas.push(await elaborated({ title: `Sitzungsidee ${i + 1}` }));
    for (let i = 0; i < 5; i++) expect((await api.triage.post(`/api/meetings/${meetingId}/items`, { ideaId: ideas[i] })).status).toBe(200);
    const full = await api.triage.post(`/api/meetings/${meetingId}/items`, { ideaId: ideas[5] });
    expect(full.status).toBe(409);
    expect(full.body.code).toBe('MEETING_FULL');
    expect((await api.triage.del(`/api/meetings/${meetingId}/items/${ideas[4]}`)).status).toBe(200);
    expect((await api.triage.post(`/api/meetings/${meetingId}/items`, { ideaId: ideas[5] })).status).toBe(200);
  });

  it('shows a comparison and decides from the meeting', async () => {
    await api.mentor.put(`/api/ideas/${ideas[0]}/scorecard`, { scores: allFives() });
    await api.mentor.patch(`/api/ideas/${ideas[0]}/estimates`, { effortPersonDays: 40, effortEuro: 60000, planBenefitEuro: 120000, horizon: 1 });
    const view = await api.committee.get(`/api/meetings/${meetingId}`);
    expect(view.body.items).toHaveLength(5);
    expect(view.body.items[0]).toMatchObject({ score: 5, raters: 1, effortPersonDays: 40, planBenefitEuro: 120000, horizon: 1, mentorName: 'mentor' });
    expect(view.body.can.decide).toBe(true);
    expect((await api.max.post(`/api/meetings/${meetingId}/decisions/${ideas[0]}`, { outcome: 'reject', reason: 'Nicht priorisiert.' })).status).toBe(403);
    expect((await api.committee.post(`/api/meetings/${meetingId}/decisions/${ideas[4]}`, { outcome: 'reject', reason: 'Nicht auf der Agenda.' })).status).toBe(404);
    const ok = await api.committee.post(`/api/meetings/${meetingId}/decisions/${ideas[0]}`, {
      outcome: 'pilot', reason: 'Im Pilotbereich erproben.', ownerId: users.owner.id, targetDate: plusDays(today, 90), sponsorId: users.sponsor.id,
    });
    expect(ok.status).toBe(200);
    const d = await withTenant(tenant, (db) => db.query('SELECT meeting_id FROM decisions WHERE idea_id = $1 AND gate = 2', [ideas[0]]));
    expect(d.rows[0].meeting_id).toBe(meetingId);
    expect((await api.committee.get(`/api/meetings/${meetingId}`)).body.items[0].decision.outcome).toBe('pilot');
  });

  it('sends the pack to the committee on request', async () => {
    expect((await api.committee.post(`/api/meetings/${meetingId}/send`)).status).toBe(403);
    expect((await api.triage.post(`/api/meetings/${meetingId}/send`)).status).toBe(200);
    expect(await inbox(users.committee, 'Unterlagen für die Gremiumssitzung')).toBe(1);
    expect((await api.committee.get('/api/tasks')).body.meetings).toHaveLength(1);
  });

  it('runs an experiment for the piloting idea and returns it to Gate 2', async () => {
    const id = ideas[0];
    const input = { hypothesis: 'Kunden bestellen lieber online.', smallestTest: 'Landingpage für zwei Wochen', metric: 'Bestellungen pro Woche', successCriteria: 'mindestens 20', startsOn: today, endsOn: plusDays(today, 14) };
    expect((await api.max.post(`/api/ideas/${id}/experiments`, input)).status).toBe(403);
    expect((await api.owner.post(`/api/ideas/${id}/experiments`, { ...input, endsOn: plusDays(today, -1) })).status).toBe(400);
    const created = await api.owner.post(`/api/ideas/${id}/experiments`, input);
    expect(created.status).toBe(201);
    expect((await api.owner.get('/api/tasks')).body.experiments.map((e: { id: string }) => e.id)).toContain(id);
    const result = await api.owner.post(`/api/ideas/${id}/experiments/${created.body.id}/result`, { outcome: 'confirmed', result: '35 Bestellungen pro Woche über zwei Wochen.' });
    expect(result.status).toBe(200);
    const detail = await api.author.get(`/api/ideas/${id}`);
    expect(detail.body.status).toBe('elaboration');
    expect(detail.body.deadline.phase).toBe('elaboration');
    expect(await inbox(users.committee, 'Experiment abgeschlossen')).toBe(1);
    // Decide again: the existing implementation is replaced.
    const again = await api.committee.post(`/api/ideas/${id}/decision`, { outcome: 'implement', reason: 'Experiment war erfolgreich.', ownerId: users.owner.id, targetDate: plusDays(today, 120) });
    expect(again.status).toBe(200);
    const d2 = await api.owner.get(`/api/ideas/${id}`);
    expect(d2.body.status).toBe('implementing');
    expect(d2.body.implementation.status).toBe('active');
  });

  it('adopts an experiment proposal through the exported function', async () => {
    const id = ideas[1];
    const r = await asUser(users.mentor, tenant, async (ctx) =>
      createExperiment(ctx, await loadIdea(ctx, id), { hypothesis: 'Hypothese aus dem Vorschlag', smallestTest: '', metric: 'Quote', successCriteria: '', startsOn: today, endsOn: plusDays(today, 7) }));
    expect(r.id).toBeTruthy();
    await expect(asUser(users.max, tenant, async (ctx) =>
      createExperiment(ctx, await loadIdea(ctx, id), { hypothesis: 'Hypothese', smallestTest: '', metric: 'Quote', successCriteria: '', startsOn: today, endsOn: today }))).rejects.toThrow();
  });

  it('records and confirms the impact review at Gate 3 (R2-07)', async () => {
    const id = ideas[0];
    const close = await api.owner.post(`/api/ideas/${id}/implementation/close`, { benefitKind: 'euro', benefitValue: 90000, benefitEvidence: 'Buchhaltung, erstes Quartal.' });
    expect(close.status).toBe(200);
    const review = await api.mentor.get(`/api/ideas/${id}/impact-review`);
    const due = new Date(`${today}T00:00:00Z`);
    due.setUTCMonth(due.getUTCMonth() + 3);
    expect(review.body.review.dueOn).toBe(due.toISOString().slice(0, 10));
    expect(review.body.review.reviewerName).toBe('mentor');
    expect(review.body.review.planValue).toBe(120000);
    const input = { planValue: 120000, actualValue: 90000, outcome: 'scale', notes: 'Wirkt, auf weitere Standorte ausrollen.' };
    expect((await api.max.put(`/api/ideas/${id}/impact-review`, input)).status).toBe(403);
    expect((await api.mentor.post(`/api/ideas/${id}/impact-review/confirm`)).status).toBe(403);
    expect((await api.mentor.put(`/api/ideas/${id}/impact-review`, input)).status).toBe(200);
    expect((await api.committee.post(`/api/ideas/${id}/impact-review/confirm`)).status).toBe(403); // a sponsor is set
    expect((await api.sponsor.get('/api/tasks')).body.impactConfirmations.map((t: { id: string }) => t.id)).toContain(id);
    expect((await api.sponsor.post(`/api/ideas/${id}/impact-review/confirm`)).status).toBe(200);
    expect((await api.sponsor.post(`/api/ideas/${id}/impact-review/confirm`)).status).toBe(409);
    expect((await api.author.get(`/api/ideas/${id}`)).body.events.some((e: { kind: string }) => e.kind === 'impact_review')).toBe(true);
  });
});

describe('portfolio board (R2-08)', () => {
  it('groups by phase with sums and filters', async () => {
    expect((await api.max.get('/api/portfolio')).status).toBe(403);
    const confidential = await elaborated({ title: 'Vertrauliches Portfolio', confidential: true });
    await api.mentor.patch(`/api/ideas/${confidential}/estimates`, { planBenefitEuro: 1000, horizon: 3 });
    const all = await api.triage.get('/api/portfolio');
    expect(all.status).toBe(200);
    expect(all.body.columns.map((c: { key: string }) => c.key)).toEqual(['submit', 'elaborate', 'implement', 'impact', 'parked']);
    const impact = all.body.columns.find((c: { key: string }) => c.key === 'impact');
    expect(impact.sums.actualBenefitEuro).toBe(90000);
    expect(impact.sums.planBenefitEuro).toBe(120000);
    const elaborate = all.body.columns.find((c: { key: string }) => c.key === 'elaborate');
    expect(elaborate.items.some((i: { id: string }) => i.id === confidential)).toBe(true);
    const committee = await api.committee.get('/api/portfolio');
    expect(committee.body.columns[1].items.some((i: { id: string }) => i.id === confidential)).toBe(false);
    const h3 = await api.triage.get('/api/portfolio?horizon=3');
    expect(h3.body.columns.flatMap((c: { items: { id: string }[] }) => c.items).map((i: { id: string }) => i.id)).toEqual([confidential]);
    const topic = await api.lead.get(`/api/portfolio?topic=${encodeURIComponent('Kundenerlebnis')}`);
    expect(topic.body.totals.planBenefitEuro).toBe(0);
  });
});

describe('success stories (R2-37, R2-38)', () => {
  let ideaId: string;
  beforeAll(async () => {
    ideaId = await submitted({ title: 'Erfolgsidee' });
    await api.triage.post(`/api/ideas/${ideaId}/triage`, { lane: 'fast_lane', ownerId: users.owner.id, orgUnit: 'Produktion', targetDate: plusDays(today, 30) });
    await api.owner.post(`/api/ideas/${ideaId}/implementation/accept`);
    await api.owner.post(`/api/ideas/${ideaId}/implementation/close`, { benefitKind: 'hours', benefitValue: 300, benefitEvidence: 'Zeiterfassung im Team.' });
    await api.author.post(`/api/ideas/${ideaId}/coauthors`, { userId: users.max.id });
  });

  it('runs draft, approval by the author and publication', async () => {
    const story = { title: 'Weniger Warten in der Kantine', body: 'Dank einer einfachen Idee spart das Team 300 Stunden im Jahr.' };
    expect((await api.author.put(`/api/ideas/${ideaId}/success-story`, story)).status).toBe(403);
    expect((await api.triage.put(`/api/ideas/${ideaId}/success-story`, story)).status).toBe(200);
    // AI drafts go through the same function while the story is a draft.
    await asUser(users.triage, tenant, (ctx) => upsertSuccessStoryDraft(ctx, ideaId, story.title, `${story.body} Überarbeitet.`, null));
    expect((await api.author.get(`/api/ideas/${ideaId}/success-story`)).body.story).toBeNull(); // drafts are internal
    expect((await api.triage.post(`/api/ideas/${ideaId}/success-story/send`)).status).toBe(200);
    expect((await api.triage.put(`/api/ideas/${ideaId}/success-story`, story)).status).toBe(409);
    expect((await api.author.get('/api/tasks')).body.stories).toHaveLength(1);
    expect((await api.committee.post(`/api/ideas/${ideaId}/success-story/approve`, { nameAuthors: true })).status).toBe(403);
    expect((await api.author.post(`/api/ideas/${ideaId}/success-story/approve`, { nameAuthors: true })).status).toBe(200);
    const page = await api.committee.get('/api/success-stories');
    expect(page.body).toHaveLength(1);
    expect(page.body[0].names).toEqual(['author', 'max']);
    expect((await api.committee.get(`/api/success-stories/${page.body[0].id}`)).body.title).toBe(story.title);
  });

  it('respects the opt-out on the success page', async () => {
    const r = await api.max.put('/api/me/recognition', { showOnSuccessPage: false });
    expect(r.body.showOnSuccessPage).toBe(false);
    expect(r.body.implementedIdeas).toBe(1);
    expect((await api.committee.get('/api/success-stories')).body[0].names).toEqual(['author']);
    expect((await api.author.get('/api/me/recognition')).body.stories).toHaveLength(1);
  });
});

describe('tenant separation of the Release 2 tables', () => {
  const tables = ['dossier_sections', 'dossier_history', 'scorecards', 'meetings', 'meeting_items', 'experiments', 'impact_reviews', 'challenge_jury', 'success_stories'];

  beforeAll(async () => {
    const c = await api.triage.post('/api/challenges', { title: 'Jury-Challenge', question: 'Wie sparen wir Energie im Büro?', contact: 'Team', startsOn: today, endsOn: plusDays(today, 30) });
    expect((await api.triage.put(`/api/challenges/${c.body.id}/jury`, { userIds: [users.committee.id] })).status).toBe(200);
  });

  it('has rows in every new table of tenant A and none visible to tenant B', async () => {
    for (const t of tables) {
      const a = await withTenant(tenant, (db) => db.query(`SELECT count(*)::int AS n FROM ${t}`));
      expect(a.rows[0].n, t).toBeGreaterThan(0);
      const b = await withTenant(other, (db) => db.query(`SELECT count(*)::int AS n FROM ${t}`));
      expect(b.rows[0].n, t).toBe(0);
    }
  });

  it('rejects writes into another tenant', async () => {
    const meeting = (await withTenant(tenant, (db) => db.query('SELECT id FROM meetings LIMIT 1'))).rows[0].id;
    expect((await withTenant(other, (db) => db.query(`UPDATE meetings SET title = 'gehackt' WHERE id = $1`, [meeting]))).rowCount).toBe(0);
    await expect(withTenant(other, (db) => db.query(`INSERT INTO meetings (tenant_id, title, meets_on, pack_due_on) VALUES ($1, 'x', now(), now())`, [tenant]))).rejects.toThrow(/row-level security/);
    await expect(withTenant(other, (db) => db.query(`INSERT INTO success_stories (tenant_id, idea_id, title, body) SELECT $1, idea_id, 'x', 'y' FROM success_stories`, [tenant]))).resolves.toMatchObject({ rowCount: 0 });
  });

  it('does not leak over the API', async () => {
    const meeting = (await withTenant(tenant, (db) => db.query('SELECT id FROM meetings LIMIT 1'))).rows[0].id;
    expect((await api.stranger.get(`/api/meetings/${meeting}`)).status).toBe(404);
    expect((await api.stranger.get('/api/meetings')).body.items).toEqual([]);
    expect((await api.stranger.get('/api/success-stories')).body).toEqual([]);
    expect((await api.stranger.get('/api/portfolio')).body.totals.planBenefitEuro).toBe(0);
  });
});
