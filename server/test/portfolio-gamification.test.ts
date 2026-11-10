import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_FILTER, parsePortfolioQuestion, type QueryContext } from '../src/ai/insights.js';
import { setProviderFactory, type GenerateRequest, type ModelProvider } from '../src/ai/providers.js';
import { closePool, withSystem, withTenant } from '../src/db/pool.js';
import type { SessionUser } from '../src/lib/context.js';
import { MIN_CASES, aggregate, ensureBenchmarkSnapshot, previousQuarter, quarterOf, type TenantKpis } from '../src/services/benchmark.js';
import { client, createTenant, createUser, login, resetDb, testApp, validIdea } from './helpers.js';

// AP-24: questions to the portfolio (R3-23), translations (R3-30), public benchmark (R3-40) and
// gamification per challenge (R2-53). Two tenants everywhere.

let app: FastifyInstance;
let tenant: string;
let other: string;
let users: Record<string, SessionUser>;
let api: Record<string, ReturnType<typeof client>>;
let today: string;

const SUBMIT = { confirmNotReport: true, boundaryAcknowledged: true };

beforeAll(async () => {
  await resetDb();
  app = await testApp();
  tenant = await createTenant('ap24', { holidays: [] });
  other = await createTenant('ap24b', { holidays: [] });
  users = {
    lead: await createUser(tenant, 'lead@ap24.example', ['submitter', 'lead']),
    triage: await createUser(tenant, 'triage@ap24.example', ['submitter', 'triage']),
    admin: await createUser(tenant, 'admin@ap24.example', ['submitter', 'admin']),
    anna: await createUser(tenant, 'anna@ap24.example'),
    ben: await createUser(tenant, 'ben@ap24.example'),
    cleo: await createUser(tenant, 'cleo@ap24.example'),
    stranger: await createUser(other, 'stranger@ap24.example', ['submitter', 'triage', 'admin']),
  };
  api = {};
  for (const [k, u] of Object.entries(users)) api[k] = client(app, await login(app, k === 'stranger' ? 'ap24b' : 'ap24', u.email));
  today = (await api.anna.get('/api/settings')).body.today;
});

afterEach(() => setProviderFactory(null));

afterAll(async () => {
  await app.close();
  await closePool();
});

async function submit(by: string, extra: Record<string, unknown> = {}) {
  const d = await api[by].post('/api/ideas', { ...validIdea, ...extra });
  expect(d.status).toBe(201);
  expect((await api[by].post(`/api/ideas/${d.body.id}/submit`, SUBMIT)).status).toBe(200);
  return d.body.id as string;
}

const setAi = (tenantId: string, ai: Record<string, unknown>) =>
  withSystem((c) => c.query(`UPDATE tenants SET settings = jsonb_set(settings, '{ai}', $2::jsonb) WHERE id = $1`, [tenantId, JSON.stringify(ai)]));

// ---------------------------------------------------------------- R3-23

describe('rule-based reading of portfolio questions (R3-23, builtin provider)', () => {
  const qc: QueryContext = { today: '2026-10-13', topics: ['Prozesse und Effizienz', 'Nachhaltigkeit', 'Kundenerlebnis'], challenges: ['Energie sparen 2026'] };

  it('reads status, topic, benefit, period and sort in German', () => {
    const f = parsePortfolioQuestion('Welche Ideen zur Nachhaltigkeit wurden dieses Jahr umgesetzt, mit Nutzen über 10.000 €? Die höchsten zuerst.', qc);
    expect(f.statuses.sort()).toEqual(['completed', 'integrated']);
    expect(f.topics).toEqual(['Nachhaltigkeit']);
    expect(f.submittedFrom).toBe('2026-01-01');
    expect(f.submittedTo).toBe('2026-12-31');
    expect(f.planBenefitMin).toBe(10_000);
    expect(f.sort).toBe('plan_benefit');
    expect(f.personFilterIgnored).toBe(false);
  });

  it('reads English phrasings, quarters, amounts with units and a top-n', () => {
    const f = parsePortfolioQuestion('Show the top 5 product ideas in implementation from last quarter with an actual benefit of more than 50k', qc);
    expect(f.statuses.sort()).toEqual(['implementing', 'piloting']);
    expect(f.ideaType).toBe('product');
    expect(f.submittedFrom).toBe('2026-07-01');
    expect(f.submittedTo).toBe('2026-09-30');
    expect(f.actualBenefitMin).toBe(50_000);
    expect(f.limit).toBe(5);
    expect(f.sort).toBe('actual_benefit');
  });

  it('finds challenges by title and treats a bare year as the period, not as an amount', () => {
    const f = parsePortfolioQuestion('Offene Ideen der Challenge Energie sparen 2026', qc);
    expect(f.challenge).toBe('Energie sparen 2026');
    expect(f.statuses.sort()).toEqual(['in_question', 'submitted']);
    const g = parsePortfolioQuestion('Abgelehnte Ideen seit 2025', qc);
    expect(g.statuses).toEqual(['rejected']);
    expect(g.submittedFrom).toBe('2025-01-01');
    expect(g.submittedTo).toBeNull();
    expect(g.planBenefitMin).toBeNull();
  });

  it('flags questions about people instead of filtering by them', () => {
    expect(parsePortfolioQuestion('Welche Ideen hat Anna Schmidt eingereicht?', qc).personFilterIgnored).toBe(true);
    expect(parsePortfolioQuestion('Ideen von Anna aus 2026', qc).personFilterIgnored).toBe(true);
    expect(parsePortfolioQuestion('Wer hat die meisten Ideen eingereicht?', qc).personFilterIgnored).toBe(true);
    expect(parsePortfolioQuestion('Which employee submitted most ideas?', qc).personFilterIgnored).toBe(true);
    expect(parsePortfolioQuestion('Ideen von Kunden zum Kundenerlebnis', qc).personFilterIgnored).toBe(false);
    // The filter has no field for people at all.
    expect(Object.keys(EMPTY_FILTER).some((k) => /author|person|user|mentor|unit/i.test(k) && k !== 'personFilterIgnored')).toBe(false);
  });
});

describe('questions to the portfolio (R3-23)', () => {
  let open: string;
  let done: string;
  let secret: string;

  beforeAll(async () => {
    open = await submit('anna', { title: 'Solarpanels auf dem Parkhaus', topic: 'Nachhaltigkeit' });
    done = await submit('ben', { title: 'LED-Beleuchtung in der Halle', topic: 'Nachhaltigkeit' });
    secret = await submit('cleo', { title: 'Vertrauliche Energie-Idee', topic: 'Nachhaltigkeit', confidential: true });
    await submit('anna', { title: 'Kantine mit Vorbestellung', topic: 'Arbeitsumfeld' });
    await withSystem(async (c) => {
      await c.query(`UPDATE ideas SET status = 'completed', plan_benefit_euro = 20000 WHERE id = $1`, [done]);
      await c.query(`UPDATE ideas SET status = 'completed', plan_benefit_euro = 50000 WHERE id = $1`, [secret]);
      await c.query(`UPDATE ideas SET plan_benefit_euro = 5000 WHERE id = $1`, [open]);
    });
    // An idea in the other tenant that matches every question.
    const s = client(app, await login(app, 'ap24b', users.stranger.email));
    const d = await s.post('/api/ideas', { ...validIdea, title: 'Fremde Nachhaltigkeitsidee', topic: 'Nachhaltigkeit' });
    expect(d.status).toBe(201);
    const sub = await s.post(`/api/ideas/${d.body.id}/submit`, SUBMIT);
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  });

  it('answers with a list, links and a summary, only with read rights', async () => {
    const res = await api.lead.post('/api/portfolio/ask', { question: 'Welche Ideen zur Nachhaltigkeit wurden umgesetzt?' });
    expect(res.status).toBe(200);
    expect(res.body.filter.statuses.sort()).toEqual(['completed', 'integrated']);
    expect(res.body.filter.topics).toEqual(['Nachhaltigkeit']);
    // The lead may not read the confidential idea; triage may.
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([done]);
    expect(res.body.items[0].url).toBe(`/ideen/${done}`);
    expect(res.body.summary).toContain('1 Idee gefunden');
    expect(res.body.summary).toContain('20.000 €');
    expect(res.body.ai.builtin).toBe(true);
    const tri = await api.triage.post('/api/portfolio/ask', { question: 'Welche Ideen zur Nachhaltigkeit wurden umgesetzt? Die höchsten zuerst.' });
    expect(tri.body.items.map((i: { id: string }) => i.id)).toEqual([secret, done]);
    expect(tri.body.summary).toContain('70.000 €');
  });

  it('never returns ideas of another tenant and never names people', async () => {
    const res = await api.triage.post('/api/portfolio/ask', { question: 'Alle offenen Ideen' });
    const titles = res.body.items.map((i: { title: string }) => i.title);
    expect(titles).toContain('Solarpanels auf dem Parkhaus');
    expect(titles).not.toContain('Fremde Nachhaltigkeitsidee');
    const keys = Object.keys(res.body.items[0]);
    expect(keys.some((k) => /author|mentor|user|unit|name/i.test(k))).toBe(false);
    const theirs = await api.stranger.post('/api/portfolio/ask', { question: 'Alle offenen Ideen' });
    expect(theirs.body.items.map((i: { title: string }) => i.title)).toEqual(['Fremde Nachhaltigkeitsidee']);
  });

  it('answers questions about people without evaluating people', async () => {
    const res = await api.triage.post('/api/portfolio/ask', { question: 'Wer hat die meisten Ideen zur Nachhaltigkeit eingereicht?' });
    expect(res.status).toBe(200);
    expect(res.body.personFilterIgnored).toBe(true);
    expect(res.body.summary).toContain('Angaben zu Personen wurden nicht ausgewertet');
    expect(JSON.stringify(res.body)).not.toContain('anna');
  });

  it('is open to the portfolio roles only and logs the AI action', async () => {
    expect((await api.anna.post('/api/portfolio/ask', { question: 'Alle Ideen' })).status).toBe(403);
    const log = await withTenant(tenant, (db) => db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_actions WHERE agent = 'portfolio_query'`));
    expect(log.rows[0].n).toBeGreaterThanOrEqual(3);
    const theirs = await withTenant(other, (db) => db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_actions WHERE agent = 'portfolio_query'`));
    expect(theirs.rows[0].n).toBe(1);
  });

  it('accepts only whitelisted filters from a model, never free SQL', async () => {
    const seen: GenerateRequest[] = [];
    setProviderFactory((): ModelProvider => ({
      generate: async (req) => {
        seen.push(req);
        return {
          json: {
            statuses: ['completed'], topics: ['Nachhaltigkeit', "x'; DROP TABLE ideas; --"], ideaType: null, challenge: null,
            submittedFrom: null, submittedTo: null, planBenefitMin: null, planBenefitMax: null, actualBenefitMin: null, actualBenefitMax: null,
            text: "' OR 1=1 --", sort: 'newest', limit: 50, personFilterIgnored: false, authorId: users.ben.id,
          },
          inputTokens: 10, outputTokens: 10, servedBy: 'fake-1', refused: false,
        };
      },
    }));
    const ai = (await withSystem((c) => c.query<{ settings: { ai?: Record<string, unknown> } }>('SELECT settings FROM tenants WHERE id = $1', [tenant]))).rows[0].settings.ai ?? {};
    await setAi(tenant, {
      ...ai,
      providers: [{ id: 'builtin', name: 'Eingebaut', kind: 'builtin', baseUrl: '', hosting: 'local', keySource: 'none' }, { id: 'fake', name: 'Fake', kind: 'openai_compatible', baseUrl: 'https://model.example', hosting: 'eu', keySource: 'none' }],
      models: { fast: { provider: 'fake', model: 'fake-1' }, deep: { provider: 'builtin', model: 'regelbasiert' }, vision: { provider: 'builtin', model: 'regelbasiert' }, speech: { provider: 'builtin', model: 'regelbasiert' }, confidential: { provider: 'builtin', model: 'regelbasiert' } },
    });
    try {
      const res = await api.triage.post('/api/portfolio/ask', { question: 'Umgesetzte Ideen von Ben' });
      expect(res.status).toBe(200);
      expect(res.body.filter.topics).toEqual(['Nachhaltigkeit']);
      expect(res.body.filter).not.toHaveProperty('authorId');
      // The injected text is a search term, nothing matches it.
      expect(res.body.items).toEqual([]);
      // Only the question, topics and challenge titles go to the model; no idea content.
      expect(seen[0].prompt).not.toContain('LED-Beleuchtung');
      expect(seen[0].prompt).toContain('Umgesetzte Ideen von Ben');
      expect((await withTenant(tenant, (db) => db.query('SELECT 1 FROM ideas'))).rowCount).toBeGreaterThan(0);
    } finally {
      await setAi(tenant, ai);
    }
  });
});

// ---------------------------------------------------------------- R3-30

describe('translation of ideas and comments (R3-30)', () => {
  let ideaId: string;
  let secretId: string;
  let commentId: string;
  let calls: GenerateRequest[];
  const fakeAi = (confidentialLocal: boolean) => ({
    providers: [
      { id: 'builtin', name: 'Eingebaut', kind: 'builtin', baseUrl: '', hosting: 'local', keySource: 'none' },
      { id: 'fake', name: 'Fake EU', kind: 'openai_compatible', baseUrl: 'https://model.example', hosting: 'eu', keySource: 'none' },
      { id: 'own', name: 'Own', kind: 'openai_compatible', baseUrl: 'https://own.example', hosting: 'local', keySource: 'none' },
    ],
    models: {
      fast: { provider: 'fake', model: 'fake-1' }, deep: { provider: 'builtin', model: 'regelbasiert' }, vision: { provider: 'builtin', model: 'regelbasiert' },
      speech: { provider: 'builtin', model: 'regelbasiert' }, confidential: confidentialLocal ? { provider: 'own', model: 'own-1' } : { provider: 'builtin', model: 'regelbasiert' },
    },
  });

  beforeAll(async () => {
    ideaId = await submit('anna', { title: 'Mehrsprachige Schichtübergabe' });
    secretId = await submit('anna', { title: 'Vertrauliche Übergabe', confidential: true });
    const c = await api.ben.post(`/api/ideas/${ideaId}/comments`, { body: 'Gute Idee, das hilft der Frühschicht.' });
    expect(c.status).toBe(201);
    commentId = (await withSystem((db) => db.query<{ id: string }>('SELECT id FROM comments WHERE idea_id = $1', [ideaId]))).rows[0].id;
  });

  function fake() {
    calls = [];
    setProviderFactory((p): ModelProvider => ({
      generate: async (req) => {
        calls.push({ ...req, model: `${p.id}:${req.model}` });
        const n = (req.prompt.match(/<untrusted_input id="text-/g) ?? []).length;
        return { json: { sourceLanguage: 'de', texts: Array.from({ length: n }, (_, i) => `EN ${i + 1}`) }, inputTokens: 10, outputTokens: 10, servedBy: req.model, refused: false };
      },
    }));
  }

  it('says clearly that the builtin provider cannot translate', async () => {
    const res = await api.ben.post(`/api/ideas/${ideaId}/translate`, { target: 'en' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AI_NO_TRANSLATION');
    expect(res.body.error).toContain('eingebaute Anbieter kann nicht übersetzen');
    const langs = await api.ben.get('/api/translate/languages');
    expect(langs.body.available).toBe(false);
    expect(langs.body.languages).toContain('fr');
  });

  it('translates an idea on demand, keeps the original and caches per target language', async () => {
    const before = await withSystem((c) => c.query<{ settings: { ai?: Record<string, unknown> } }>('SELECT settings FROM tenants WHERE id = $1', [tenant]));
    const ai = before.rows[0].settings.ai ?? {};
    await setAi(tenant, { ...ai, ...fakeAi(false) });
    fake();
    try {
      const res = await api.ben.post(`/api/ideas/${ideaId}/translate`, { target: 'en' });
      expect(res.status).toBe(200);
      expect(res.body.fields).toEqual({ title: 'EN 1', problem: 'EN 2', solution: 'EN 3', benefit: 'EN 4' });
      expect(res.body.cached).toBe(false);
      expect(calls[0].prompt).toContain('English');
      const again = await api.ben.post(`/api/ideas/${ideaId}/translate`, { target: 'en' });
      expect(again.body.cached).toBe(true);
      expect(calls).toHaveLength(1);
      // Another target language is a new translation.
      expect((await api.ben.post(`/api/ideas/${ideaId}/translate`, { target: 'fr' })).body.cached).toBe(false);
      expect(calls).toHaveLength(2);
      // The original is unchanged.
      expect((await api.ben.get(`/api/ideas/${ideaId}`)).body.title).toBe('Mehrsprachige Schichtübergabe');
      // Comments are translated one by one.
      const com = await api.anna.post(`/api/ideas/${ideaId}/translate`, { target: 'en', commentId });
      expect(com.body.fields).toEqual({ body: 'EN 1' });
      expect((await api.anna.post(`/api/ideas/${ideaId}/translate`, { target: 'en', commentId: ideaId })).status).toBe(404);
      expect((await api.anna.post(`/api/ideas/${ideaId}/translate`, { target: 'xx' })).status).toBe(400);
    } finally {
      await setAi(tenant, ai);
    }
  });

  it('sends confidential ideas only to a local model', async () => {
    const before = await withSystem((c) => c.query<{ settings: { ai?: Record<string, unknown> } }>('SELECT settings FROM tenants WHERE id = $1', [tenant]));
    const ai = before.rows[0].settings.ai ?? {};
    fake();
    try {
      await setAi(tenant, { ...ai, ...fakeAi(false) });
      const refused = await api.anna.post(`/api/ideas/${secretId}/translate`, { target: 'en' });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toContain('eigener Infrastruktur');
      expect(calls).toHaveLength(0);
      await setAi(tenant, { ...ai, ...fakeAi(true) });
      const ok = await api.anna.post(`/api/ideas/${secretId}/translate`, { target: 'en' });
      expect(ok.status).toBe(200);
      expect(ok.body.local).toBe(true);
      expect(calls.map((c) => c.model)).toEqual(['own:own-1']);
      // Without read rights there is nothing to translate.
      expect((await api.ben.post(`/api/ideas/${secretId}/translate`, { target: 'en' })).status).toBe(404);
    } finally {
      await setAi(tenant, ai);
    }
  });

  it('keeps translations per tenant', async () => {
    expect((await api.stranger.post(`/api/ideas/${ideaId}/translate`, { target: 'en' })).status).toBe(404);
    const mine = await withTenant(tenant, (db) => db.query('SELECT 1 FROM translations'));
    const theirs = await withTenant(other, (db) => db.query('SELECT 1 FROM translations'));
    expect(mine.rowCount).toBeGreaterThan(0);
    expect(theirs.rowCount).toBe(0);
  });
});

// ---------------------------------------------------------------- R2-53

describe('gamification per challenge (R2-53)', () => {
  let challengeId: string;
  let ideas: string[];

  beforeAll(async () => {
    const c = await api.admin.post('/api/challenges', { title: 'Ideen für die Logistik', question: 'Wie machen wir die Logistik schneller?', contact: 'Logistik-Team', startsOn: today, endsOn: '2099-12-31' });
    expect(c.status).toBe(201);
    challengeId = c.body.id;
    ideas = [
      await submit('anna', { challengeId, title: 'Routen bündeln' }),
      await submit('anna', { challengeId, title: 'Leergut sammeln' }),
      await submit('ben', { challengeId, title: 'Anonyme Idee', anonymous: true }),
    ];
    for (let i = 0; i < 2; i++) expect((await api.ben.post(`/api/ideas/${ideas[0]}/comments`, { body: `Kommentar ${i}` })).status).toBe(201);
    const rate = await api.cleo.put(`/api/challenges/${challengeId}/ideas/${ideas[0]}/rating`, { scores: { benefit: 4, feasibility: 3 } });
    expect(rate.status).toBe(200);
  });

  it('gives points for submitting, commenting and rating, and badges', async () => {
    const anna = (await api.anna.get(`/api/challenges/${challengeId}/gamification`)).body;
    expect(anna.enabled).toBe(true);
    expect(anna.me).toMatchObject({ ideas: 2, comments: 0, ratings: 0, points: 20, consent: false });
    expect(anna.me.badges).toEqual(['first_idea']);
    // Anonymous ideas earn no points, so the leaderboard reveals nothing about them.
    const ben = (await api.ben.get(`/api/challenges/${challengeId}/gamification`)).body;
    expect(ben.me).toMatchObject({ ideas: 0, comments: 2, points: 4 });
    expect((await api.cleo.get(`/api/challenges/${challengeId}/gamification`)).body.me).toMatchObject({ ratings: 1, points: 1 });
  });

  it('lists only people who agreed, per challenge', async () => {
    expect((await api.anna.get(`/api/challenges/${challengeId}/gamification`)).body.leaderboard).toEqual([]);
    expect((await api.anna.put(`/api/challenges/${challengeId}/gamification/consent`, { consent: true })).status).toBe(200);
    expect((await api.cleo.put(`/api/challenges/${challengeId}/gamification/consent`, { consent: true })).status).toBe(200);
    const board = (await api.ben.get(`/api/challenges/${challengeId}/gamification`)).body.leaderboard;
    expect(board.map((r: { name: string; points: number; rank: number }) => [r.rank, r.name, r.points])).toEqual([[1, 'anna', 20], [2, 'cleo', 1]]);
    expect(JSON.stringify(board)).not.toContain('ben');
    expect(board.some((r: Record<string, unknown>) => 'id' in r || 'email' in r)).toBe(false);
    // Revoking removes the person at once.
    await api.cleo.put(`/api/challenges/${challengeId}/gamification/consent`, { consent: false });
    expect((await api.ben.get(`/api/challenges/${challengeId}/gamification`)).body.leaderboard.map((r: { name: string }) => r.name)).toEqual(['anna']);
  });

  it('has no export per person and nothing in the dashboard', async () => {
    expect((await api.admin.get(`/api/challenges/${challengeId}/gamification.csv`)).status).toBe(404);
    expect((await api.admin.get(`/api/challenges/${challengeId}/leaderboard.csv`)).status).toBe(404);
    const dash = await api.admin.get('/api/dashboard');
    expect(JSON.stringify(dash.body)).not.toMatch(/leaderboard|badge/i);
  });

  it('is listed as a report in the co-determination overview', async () => {
    const res = await api.admin.get('/api/codetermination');
    const report = res.body.reports.find((r: { key: string }) => r.key === 'leaderboard');
    expect(report.endpoint).toBe('GET /api/challenges/:id/gamification');
    expect(report.aggregation).toBe('consent');
    expect(res.body.reports.find((r: { key: string }) => r.key === 'portfolioAsk').endpoint).toBe('POST /api/portfolio/ask');
  });

  it('can be switched off per challenge by the admin only', async () => {
    expect((await api.anna.patch(`/api/challenges/${challengeId}/gamification`, { leaderboard: false })).status).toBe(403);
    const off = await api.admin.patch(`/api/challenges/${challengeId}/gamification`, { leaderboard: false });
    expect(off.status).toBe(200);
    expect(off.body.leaderboard).toBeNull();
    expect((await api.anna.put(`/api/challenges/${challengeId}/gamification/consent`, { consent: true })).status).toBe(409);
    // Consents are deleted with the switch: a later switch-on starts empty.
    await api.admin.patch(`/api/challenges/${challengeId}/gamification`, { leaderboard: true });
    expect((await api.ben.get(`/api/challenges/${challengeId}/gamification`)).body.leaderboard).toEqual([]);
    await api.admin.patch(`/api/challenges/${challengeId}/gamification`, { enabled: false });
    const all = (await api.anna.get(`/api/challenges/${challengeId}/gamification`)).body;
    expect(all).toMatchObject({ enabled: false, me: null, leaderboard: null });
  });

  it('keeps challenges and consents per tenant', async () => {
    expect((await api.stranger.get(`/api/challenges/${challengeId}/gamification`)).status).toBe(404);
    expect((await api.stranger.patch(`/api/challenges/${challengeId}/gamification`, { enabled: true })).status).toBe(404);
    await api.admin.patch(`/api/challenges/${challengeId}/gamification`, { enabled: true, leaderboard: true });
    await api.anna.put(`/api/challenges/${challengeId}/gamification/consent`, { consent: true });
    expect((await withTenant(tenant, (db) => db.query('SELECT 1 FROM gamification_consents'))).rowCount).toBe(1);
    expect((await withTenant(other, (db) => db.query('SELECT 1 FROM gamification_consents'))).rowCount).toBe(0);
  });
});

// ---------------------------------------------------------------- R3-40

describe('public benchmark (R3-40)', () => {
  it('works with quarters', () => {
    expect(quarterOf('2026-10-13')).toEqual({ key: '2026-Q4', from: '2026-10-01', to: '2026-12-31' });
    expect(previousQuarter('2026-10-13')).toEqual({ key: '2026-Q3', from: '2026-07-01', to: '2026-09-30' });
    expect(previousQuarter('2026-02-01').key).toBe('2025-Q4');
  });

  it('shows a figure only from 5 workspaces, as a rounded mean without single values', () => {
    const t = (x: number | null): TenantKpis => ({ deadlineAdherence: x, cycleTimeDays: x == null ? null : x * 10, realizationRate: null, aiCorrectionRate: x });
    expect(aggregate([t(1), t(1), t(1), t(0.5)]).deadlineAdherence).toBeNull();
    const five = aggregate([t(1), t(1), t(1), t(1), t(0.5), t(null)]);
    expect(five.deadlineAdherence).toEqual({ value: 90, unit: 'percent', tenants: 5 });
    expect(five.cycleTimeDays).toEqual({ value: 9, unit: 'days', tenants: 5 });
    expect(five.realizationRate).toBeNull();
    const seven = aggregate(Array.from({ length: 7 }, () => t(0.333)));
    expect(seven.aiCorrectionRate).toEqual({ value: 33, unit: 'percent', tenants: 5 });
  });

  /** One workspace with MIN_CASES ideas in the quarter: deadlines (share on time), Gate 1 after 10 days, done, AI results. */
  async function seedWorkspace(slug: string, share: boolean, onTime: number, from: string) {
    const id = await createTenant(slug, { benchmark: { share } });
    const u = await createUser(id, `owner@${slug}.example`, ['submitter', 'triage']);
    await withSystem(async (c) => {
      for (let n = 1; n <= MIN_CASES; n++) {
        const idea = (await c.query<{ id: string }>(
          `INSERT INTO ideas (tenant_id, number, title, status, author_id, created_at, submitted_at)
           VALUES ($1, $2, 'Idee', 'completed', $3, $4::date, $4::date) RETURNING id`,
          [id, n, u.id, from],
        )).rows[0].id;
        await c.query(
          `INSERT INTO deadlines (tenant_id, idea_id, phase, started_on, due_on, completed_at)
           VALUES ($1, $2, 'gate1', $3::date, $3::date + 10, $3::date + CASE WHEN $4 THEN 5 ELSE 20 END)`,
          [id, idea, from, n <= onTime],
        );
        await c.query(`INSERT INTO decisions (tenant_id, idea_id, gate, outcome, decided_by, decided_at) VALUES ($1, $2, 1, 'fast_lane', $3, $4::date + 10)`, [id, idea, u.id, from]);
        await c.query(
          `INSERT INTO implementations (tenant_id, idea_id, owner_id, channel, target_date, status, closed_at) VALUES ($1, $2, $3, 'line', $4::date + 30, 'done', $4::date + 30)`,
          [id, idea, u.id, from],
        );
        await c.query(`INSERT INTO ai_results (tenant_id, idea_id, kind, content, created_at) VALUES ($1, $2, 'short_analysis', '{}', $3::date + 1)`, [id, idea, from]);
      }
    });
    return id;
  }

  it('averages only consenting workspaces, once per quarter, from 5 workspaces on', async () => {
    // 2025-Q1: four consenting workspaces are not enough.
    for (let i = 1; i <= 4; i++) await seedWorkspace(`bm-a${i}`, true, MIN_CASES, '2025-02-03');
    expect(await ensureBenchmarkSnapshot('2025-04-10')).toBe('2025-Q1');
    expect(await ensureBenchmarkSnapshot('2025-04-11')).toBeNull();
    let pub = await app.inject({ method: 'GET', url: '/api/benchmark' });
    expect(pub.statusCode).toBe(200);
    expect(pub.json().quarters[0]).toMatchObject({ quarter: '2025-Q1', published: false, figures: null, tenants: null });

    // 2025-Q2: five consenting workspaces (one with 1 of 3 deadlines on time) and one without consent.
    for (let i = 1; i <= 4; i++) await seedWorkspace(`bm-b${i}`, true, MIN_CASES, '2025-05-05');
    await seedWorkspace('bm-b5', true, 1, '2025-05-05');
    await seedWorkspace('bm-no', false, 0, '2025-05-05');
    // The workspaces seeded for Q1 have no data in Q2; they agreed but contribute nothing.
    expect(await ensureBenchmarkSnapshot('2025-07-02')).toBe('2025-Q2');
    pub = await app.inject({ method: 'GET', url: '/api/benchmark' });
    const q2 = pub.json().quarters[0];
    expect(q2.quarter).toBe('2025-Q2');
    expect(q2.published).toBe(true);
    // (4 × 100 % + 33 %) / 5 = 87 %; the workspace without consent (0 %) is not part of it.
    expect(q2.figures.deadlineAdherence).toEqual({ value: 87, unit: 'percent', tenants: 5 });
    expect(q2.figures.cycleTimeDays).toEqual({ value: 10, unit: 'days', tenants: 5 });
    expect(q2.figures.realizationRate).toEqual({ value: 100, unit: 'percent', tenants: 5 });
    expect(q2.figures.aiCorrectionRate).toEqual({ value: 0, unit: 'percent', tenants: 5 });
    // Nine workspaces agreed; the page shows the number rounded down to a multiple of 5.
    expect(q2.tenants).toBe(5);
    // No workspace names or IDs on the public page.
    expect(pub.body).not.toMatch(/bm-|Mandant|[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('keeps the snapshots away from the app role', async () => {
    await expect(withTenant(tenant, (db) => db.query('SELECT * FROM benchmark_snapshots'))).rejects.toThrow(/permission denied/);
  });

  it('is off by default and switched in the settings', async () => {
    const s = await api.admin.get('/api/admin/settings');
    expect(s.body.benchmark).toEqual({ share: false });
    expect(s.body.gamification).toEqual({ pointsSubmit: 10, pointsComment: 2, pointsRating: 1 });
  });
});
