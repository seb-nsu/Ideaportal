import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setProviderFactory, type ModelProvider } from '../src/ai/providers.js';
import { anonymizeQueryCounted, setWebSearch } from '../src/ai/search.js';
import { defaultAiSettings, type AiSettings } from '../src/ai/settings.js';
import { drainAiJobs } from '../src/ai/worker.js';
import { closePool } from '../src/db/pool.js';
import type { SessionUser } from '../src/lib/context.js';
import { client, createTenant, createUser, login, resetDb, testApp, validIdea } from './helpers.js';

// Privacy proof per AI analysis (AP-04, R2-42): provider, region, model, cost and web queries
// per action; PDF export; readable for the works council; no idea texts, for confidential
// ideas not even the title.

let app: FastifyInstance;
let users: Record<string, SessionUser>;
let api: Record<string, ReturnType<typeof client>>;
let cookies: Record<string, string>;

beforeAll(async () => {
  await resetDb();
  app = await testApp();
  const tenant = await createTenant('nachweis');
  const other = await createTenant('woanders');
  users = {
    author: await createUser(tenant, 'erika.mustermann@nachweis.example', ['submitter']),
    max: await createUser(tenant, 'max@nachweis.example', ['submitter']),
    triage: await createUser(tenant, 'triage@nachweis.example', ['submitter', 'triage']),
    admin: await createUser(tenant, 'admin@nachweis.example', ['submitter', 'admin']),
    council: await createUser(tenant, 'betriebsrat@nachweis.example', ['works_council']),
    otherAdmin: await createUser(other, 'admin@woanders.example', ['submitter', 'admin']),
  };
  api = {};
  cookies = {};
  for (const [k, u] of Object.entries(users)) {
    cookies[k] = await login(app, k === 'otherAdmin' ? 'woanders' : 'nachweis', u.email);
    api[k] = client(app, cookies[k]);
  }
  // An external model in another region and an own web search.
  setProviderFactory((p) => {
    if (p.kind === 'builtin') throw new Error('builtin');
    const provider: ModelProvider = {
      async generate(req) {
        return {
          json: {
            summary: 'Kurz.',
            sections: [{ heading: 'Wettbewerb', claims: [{ text: 'Es gibt Anbieter.', kind: 'fact', sources: [1], confidence: null }] }],
            completeness: { complete: true, missing: [] },
            ...(req.prompt.includes('Schlage für Gate 1') ? { lane: 'elaborate', topic: 'Arbeitsumfeld', reason: 'Potenzial.', confidence: 'medium', missing: [] } : {}),
          },
          inputTokens: 1200,
          outputTokens: 300,
          servedBy: req.model,
          refused: false,
        };
      },
    };
    return provider;
  });
  setWebSearch(async () => [{ title: 'Anbieter', url: 'https://example.org/a', snippet: 'Ein Anbieter.' }]);
  const current = (await api.admin.get('/api/admin/ai')).body.settings as AiSettings;
  const res = await api.admin.put('/api/admin/ai', {
    ...current,
    requireEval: false,
    internalTerms: ['Projekt Falke'],
    providers: [
      { id: 'builtin', name: 'Eingebaut', kind: 'builtin', baseUrl: '', hosting: 'local', keySource: 'none' },
      { id: 'anthropic', name: 'Anthropic Claude', kind: 'anthropic', baseUrl: '', hosting: 'other', keySource: 'tenant' },
    ],
    models: { ...current.models, fast: { provider: 'anthropic', model: 'claude-haiku-5-5' }, deep: { provider: 'anthropic', model: 'claude-opus-5-5' } },
    search: { ...defaultAiSettings.search, kind: 'searxng', baseUrl: 'https://searx.example' },
  });
  expect(res.status).toBe(200);
});

afterEach(() => undefined);

afterAll(async () => {
  setProviderFactory(null);
  setWebSearch(null);
  await app.close();
  await closePool();
});

async function submitted(extra: Record<string, unknown>): Promise<string> {
  const created = await api.author.post('/api/ideas', { ...validIdea, ...extra });
  expect(created.status).toBe(201);
  expect((await api.author.post(`/api/ideas/${created.body.id}/submit`, { confirmNotReport: true })).status).toBe(200);
  await drainAiJobs();
  return created.body.id;
}

describe('privacy proof per AI analysis (R2-42)', () => {
  let normal: string;
  let secret: string;
  const SECRET_PROBLEM = 'Die Rezeptur Quarzblau wird an der Linie 3 falsch dosiert und kostet uns Ausschuss.';

  it('lists provider, region, model, cost and the anonymised web queries', async () => {
    normal = await submitted({ ideaType: 'product', title: 'Projekt Falke Raumbuchung mit Check-in für erika.mustermann', problem: 'Besprechungsräume sind gebucht, aber leer; niemand weiß, ob sie frei sind.' });
    const proof = (await api.triage.get(`/api/ideas/${normal}/ai/proof`)).body;
    expect(proof.idea.title).toContain('Raumbuchung');
    const search = proof.entries.find((e: { agent: string }) => e.agent === 'web_search');
    expect(search.searchQueries.length).toBeGreaterThan(0);
    for (const q of search.searchQueries) expect(q.toLowerCase()).not.toMatch(/falke|erika|mustermann/);
    expect(search.removedTerms).toBeGreaterThan(0);
    expect(search.hosting).toBe('local');
    const short = proof.entries.find((e: { agent: string }) => e.agent === 'short_analysis');
    expect(short).toMatchObject({ provider: 'Anthropic Claude', hosting: 'other', model: 'claude-haiku-5-5', local: false, inputTokens: 1200 });
    expect(short.hostingLabel).toContain('außerhalb der EU');
    expect(short.costEur).toBeGreaterThan(0);
    expect(proof.totals.external).toBeGreaterThan(0);
    // No prompts, answers or idea texts.
    expect(JSON.stringify(proof)).not.toContain('niemand weiß');
    expect(JSON.stringify(proof)).not.toContain('Es gibt Anbieter');
  });

  it('shows confidential ideas only by number and with local processing', async () => {
    secret = await submitted({ title: 'Quarzblau-Rezeptur verbessern', problem: SECRET_PROBLEM, confidential: true });
    const proof = (await api.council.get(`/api/ideas/${secret}/ai/proof`)).body;
    expect(proof.idea).toMatchObject({ title: null, confidential: true });
    expect(proof.entries.length).toBeGreaterThan(0);
    expect(proof.entries.every((e: { local: boolean; agent: string }) => e.local && e.agent !== 'web_search')).toBe(true);
    expect(JSON.stringify(proof)).not.toContain('Quarzblau');
  });

  it('exports the proof as PDF without the texts of confidential ideas', async () => {
    const pdf = await app.inject({ method: 'GET', url: `/api/ideas/${secret}/ai/proof.pdf`, headers: { cookie: cookies.council } });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    const raw = pdf.rawPayload.toString('latin1');
    expect(raw.startsWith('%PDF-1.4')).toBe(true);
    expect(raw).toContain('Datenschutz-Nachweis der KI-Verarbeitung');
    expect(raw).toContain('vertraulich');
    expect(raw).not.toContain('Quarzblau');
    expect(raw).toMatch(/startxref\n\d+\n%%EOF/);
    const normalPdf = await app.inject({ method: 'GET', url: `/api/ideas/${normal}/ai/proof.pdf`, headers: { cookie: cookies.triage } });
    expect(normalPdf.rawPayload.toString('latin1')).toContain('Websuche');
  });

  it('is readable for the works council, not for uninvolved people or other workspaces', async () => {
    const list = await api.council.get('/api/ai/proofs');
    expect(list.status).toBe(200);
    const line = list.body.items.find((x: { ideaId: string }) => x.ideaId === secret);
    expect(line).toMatchObject({ title: null, confidential: true });
    expect((await api.max.get('/api/ai/proofs')).status).toBe(403);
    expect([403, 404]).toContain((await api.max.get(`/api/ideas/${secret}/ai/proof`)).status);
    expect((await api.author.get(`/api/ideas/${secret}/ai/proof`)).status).toBe(200);
    expect((await api.otherAdmin.get(`/api/ideas/${normal}/ai/proof`)).status).toBe(404);
    // The works council reads proofs but not the analyses themselves.
    expect([403, 404]).toContain((await api.council.get(`/api/ideas/${secret}/ai`)).status);
  });

  it('counts what anonymisation removed', () => {
    const r = anonymizeQueryCounted('Raumbuchung erika@firma.de Projekt Falke +49 170 1234567', ['Projekt Falke']);
    expect(r.query).toBe('Raumbuchung');
    expect(r.removed).toBe(3);
  });
});
