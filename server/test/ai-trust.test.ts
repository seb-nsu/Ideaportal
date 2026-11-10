import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GATE2_MAX_WORDS, gate2Schema } from '../src/ai/agents.js';
import { drainAiJobs } from '../src/ai/worker.js';
import { closePool, withTenant } from '../src/db/pool.js';
import type { SessionUser } from '../src/lib/context.js';
import { client, createTenant, createUser, login, resetDb, testApp, validIdea } from './helpers.js';

// Trust in AI results (AP-02): triage suggestion only for those who decide (R2-39),
// builtin provider without invented figures (R2-40), one-page Gate 2 brief with the basis
// of every figure and measured reading time (R2-43).

let app: FastifyInstance;
let tenant: string;
let other: string;
let users: Record<string, SessionUser>;
let api: Record<string, ReturnType<typeof client>>;

beforeAll(async () => {
  await resetDb();
  app = await testApp();
  tenant = await createTenant('vertrauen');
  other = await createTenant('fremd');
  users = {
    author: await createUser(tenant, 'autorin@vertrauen.example', ['submitter']),
    triage: await createUser(tenant, 'triage@vertrauen.example', ['submitter', 'triage']),
    committee: await createUser(tenant, 'gremium@vertrauen.example', ['submitter', 'committee']),
    mentor: await createUser(tenant, 'pate@vertrauen.example', ['submitter', 'mentor']),
    lead: await createUser(tenant, 'leitung@vertrauen.example', ['submitter', 'lead']),
    admin: await createUser(tenant, 'admin@vertrauen.example', ['submitter', 'admin']),
    otherAdmin: await createUser(other, 'admin@fremd.example', ['submitter', 'admin']),
  };
  api = {};
  for (const [k, u] of Object.entries(users)) api[k] = client(app, await login(app, k === 'otherAdmin' ? 'fremd' : 'vertrauen', u.email));
});

afterAll(async () => {
  await app.close();
  await closePool();
});

async function elaborated(title: string): Promise<string> {
  const created = await api.author.post('/api/ideas', { ...validIdea, title, ideaType: 'product' });
  expect(created.status).toBe(201);
  expect((await api.author.post(`/api/ideas/${created.body.id}/submit`, { confirmNotReport: true })).status).toBe(200);
  await drainAiJobs();
  expect((await api.triage.post(`/api/ideas/${created.body.id}/triage`, { lane: 'elaborate', mentorId: users.mentor.id })).status).toBe(200);
  await drainAiJobs();
  return created.body.id;
}

const kindsFor = async (who: string, id: string) => {
  const res = await api[who].get(`/api/ideas/${id}/ai`);
  return res.status === 200 ? res.body.results.map((r: { kind: string }) => r.kind) : res.status;
};

describe('triage suggestion only for those who decide (R2-39)', () => {
  it('hides the suggestion from authors and leads, shows it to triage, committee and the mentor', async () => {
    const id = await elaborated('Ersatzteil-Portal für Servicepartner');
    expect(await kindsFor('triage', id)).toContain('triage_suggestion');
    expect(await kindsFor('committee', id)).toContain('triage_suggestion');
    expect(await kindsFor('mentor', id)).toContain('triage_suggestion');
    const author = await kindsFor('author', id);
    expect(author).toContain('short_analysis');
    expect(author).not.toContain('triage_suggestion');
    const lead = await kindsFor('lead', id);
    if (Array.isArray(lead)) expect(lead).not.toContain('triage_suggestion');
    // Not even the version history leaks it.
    const suggestion = (await api.triage.get(`/api/ideas/${id}/ai`)).body.results.find((r: { kind: string }) => r.kind === 'triage_suggestion');
    expect(suggestion).toBeTruthy();
    expect((await api.author.get(`/api/ai/results/${suggestion.id}/versions`)).status).toBe(403);
    expect((await api.triage.get(`/api/ai/results/${suggestion.id}/versions`)).status).toBe(200);
  });
});

describe('builtin provider without invented figures (R2-40)', () => {
  it('says that no model is configured and who can change it', async () => {
    const id = await elaborated('Wartungsplanung mit Sensordaten');
    const admin = (await api.admin.get(`/api/ideas/${id}/ai`)).body;
    expect(admin).toMatchObject({ modelConfigured: false, canConfigure: true });
    expect((await api.triage.get(`/api/ideas/${id}/ai`)).body.canConfigure).toBe(false);
  });

  it('delivers questions instead of amounts and computes only from filled values', async () => {
    const id = await elaborated('Abo-Modell für Verbrauchsmaterial');
    const results = (await api.triage.get(`/api/ideas/${id}/ai`)).body.results as { kind: string; id: string; data: any; computed: any }[];
    const bc = results.find((r) => r.kind === 'business_case')!;
    expect(bc.data.assumptions.length).toBeGreaterThan(0);
    for (const a of bc.data.assumptions) expect([a.low, a.base, a.high]).toEqual([null, null, null]);
    expect(bc.data.toClarify.length).toBeGreaterThan(0);
    expect(bc.computed).toBeNull();
    const market = results.find((r) => r.kind === 'market_size')!;
    expect(market.data.topDown).toBeNull();
    expect(market.computed).toBeNull();
    expect(market.data.toClarify.length).toBeGreaterThan(0);
    // No amount appears in any builtin statement.
    for (const r of results) {
      for (const s of (r as unknown as { sections: { claims: { text: string }[] }[] }).sections) {
        for (const c of s.claims) expect(c.text).not.toMatch(/\d[\d.,]*\s?(€|Euro|EUR)/);
      }
    }
    // Export needs complete values.
    expect((await api.triage.get(`/api/ai/results/${bc.id}/business-case.csv`)).status).toBe(400);
    // Partly filled: saved, still no figures.
    const partly = bc.data.assumptions.map((a: object, i: number) => (i === 0 ? { ...a, low: 1000, base: 2000, high: 3000 } : a));
    const p = await api.triage.put(`/api/ai/results/${bc.id}/business-case`, { horizonYears: 3, assumptions: partly });
    expect(p.status).toBe(200);
    expect(p.body.computed).toBeNull();
    // Filled by the team: now the portal computes.
    const filled = bc.data.assumptions.map((a: object) => ({ ...a, low: 1000, base: 2000, high: 3000 }));
    const f = await api.triage.put(`/api/ai/results/${bc.id}/business-case`, { horizonYears: 3, assumptions: filled });
    expect(f.status).toBe(200);
    expect(f.body.computed.scenarios).toHaveLength(3);
    const csv = await app.inject({ method: 'GET', url: `/api/ai/results/${f.body.id}/business-case.csv`, headers: { cookie: await login(app, 'vertrauen', users.triage.email) } });
    expect(csv.statusCode).toBe(200);
  });
});

describe('one-page Gate 2 brief (R2-43)', () => {
  let meetingId: string;
  let ideaId: string;

  it('rejects a brief over the word limit', () => {
    const long = Array.from({ length: GATE2_MAX_WORDS + 10 }, () => 'Wort').join(' ');
    const claim = { text: long, kind: 'assumption', sources: [], confidence: null };
    expect(gate2Schema.safeParse({ sections: [{ heading: 'Problem', claims: [claim] }], strengths: [], risks: [], openQuestions: [] }).success).toBe(false);
  });

  it('fits on one page, labels every statement and names the basis of every figure', async () => {
    ideaId = await elaborated('Rückruf-Service im Kundenportal');
    await api.mentor.patch(`/api/ideas/${ideaId}/estimates`, { effortPersonDays: 30, effortEuro: 45000, planBenefitEuro: 90000, horizon: 1 });
    const m = await api.triage.post('/api/meetings', { title: 'Gremium Vertrauen', meetsOn: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10) });
    expect(m.status).toBe(201);
    meetingId = m.body.id;
    expect((await api.triage.post(`/api/meetings/${meetingId}/items`, { ideaId })).status).toBe(200);
    const created = await api.triage.post(`/api/meetings/${meetingId}/ai/brief`);
    expect(created.status).toBe(200);
    expect(created.body.errors).toEqual([]);

    const items = (await api.committee.get(`/api/meetings/${meetingId}/ai/brief`)).body;
    const item = items.find((x: { ideaId: string }) => x.ideaId === ideaId);
    expect(item.words).toBeGreaterThan(0);
    expect(item.words).toBeLessThanOrEqual(GATE2_MAX_WORDS);
    expect(item.readingMinutes).toBeLessThanOrEqual(2);
    const claims = item.brief.sections.flatMap((s: { claims: unknown[] }) => s.claims) as { text: string; kind: string; sources: number[]; confidence: string | null }[];
    expect(claims.length).toBeGreaterThan(0);
    for (const c of claims) {
      expect(['fact', 'assumption', 'estimate']).toContain(c.kind);
      if (c.kind === 'fact') expect(c.sources.length).toBeGreaterThan(0);
      // A number without a source is an estimate with a stated confidence.
      if (/\d/.test(c.text) && c.sources.length === 0) {
        expect(c.kind).toBe('estimate');
        expect(c.confidence).toBeTruthy();
      }
    }
    expect(item.figures.length).toBeGreaterThanOrEqual(3);
    for (const f of item.figures) {
      expect(['source', 'calculation', 'estimate', 'rating']).toContain(f.basis);
      expect(f.note).toBeTruthy();
      expect(f.href).toMatch(new RegExp(`^/ideen/${ideaId}/steckbrief/(zusammenfassung|analysen|scorecard)#`));
    }
    expect(item.figures.find((f: { label: string; unit: string }) => f.label === 'Aufwand' && f.unit === '€').value).toBe(45000);
  });

  it('measures reading time without storing the reader', async () => {
    expect((await api.committee.post(`/api/meetings/${meetingId}/ai/brief/read`, { ideaId, seconds: 95 })).status).toBe(200);
    expect((await api.author.post(`/api/meetings/${meetingId}/ai/brief/read`, { ideaId, seconds: 30 })).status).toBe(403);
    const elsewhere = await elaborated('Nicht auf der Tagesordnung');
    expect((await api.committee.post(`/api/meetings/${meetingId}/ai/brief/read`, { ideaId: elsewhere, seconds: 30 })).status).toBe(404);
    const quality = (await api.admin.get('/api/admin/ai')).body.quality;
    expect(quality.briefReading).toMatchObject({ reads: 1, medianSeconds: 95 });
    const cols = await withTenant(tenant, async (db) => (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'brief_reads'`)).rows.map((r) => r.column_name));
    expect(cols).not.toContain('user_id');
  });

  it('keeps reading times per workspace', async () => {
    expect(await withTenant(other, async (db) => (await db.query('SELECT count(*)::int AS n FROM brief_reads')).rows[0].n)).toBe(0);
    expect(await withTenant(tenant, async (db) => (await db.query('SELECT count(*)::int AS n FROM brief_reads')).rows[0].n)).toBe(1);
    await expect(
      withTenant(other, (db) => db.query('INSERT INTO brief_reads (tenant_id, meeting_id, idea_id, seconds) VALUES ($1, $2, $3, 10)', [tenant, meetingId, ideaId])),
    ).rejects.toThrow();
    expect((await api.otherAdmin.post(`/api/meetings/${meetingId}/ai/brief/read`, { ideaId, seconds: 30 })).status).toBe(404);
    const quality = (await api.otherAdmin.get('/api/admin/ai')).body.quality;
    expect(quality.briefReading.reads).toBe(0);
  });
});
