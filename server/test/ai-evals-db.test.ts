import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runAgent } from '../src/ai/gateway.js';
import { detachedCtx } from '../src/ai/pipeline.js';
import { agentPromptVersion } from '../src/ai/promptVersion.js';
import { setProviderFactory, type GenerateRequest } from '../src/ai/providers.js';
import { AGENTS, type AiSettings } from '../src/ai/settings.js';
import { drainAiJobs } from '../src/ai/worker.js';
import { closePool, withTenant } from '../src/db/pool.js';
import type { SessionUser } from '../src/lib/context.js';
import { client, createTenant, createUser, login, resetDb, testApp } from './helpers.js';

// Evaluation runs with stored cases and comparison, report downloads, quality settings, the
// fallback-model warning and the transparency page (R2-12, R3-22): permissions and tenant isolation.

let app: FastifyInstance;
let tenant: string;
let other: string;
let users: Record<string, SessionUser>;
let api: Record<string, ReturnType<typeof client>>;
let cookies: Record<string, string>;

beforeAll(async () => {
  await resetDb();
  app = await testApp();
  tenant = await createTenant('evals');
  other = await createTenant('evals-andere');
  users = {
    erika: await createUser(tenant, 'erika@evals.example', ['submitter']),
    admin: await createUser(tenant, 'chefin@evals.example', ['submitter', 'admin']),
    otherAdmin: await createUser(other, 'admin@andere.example', ['submitter', 'admin']),
  };
  api = {};
  cookies = {};
  for (const [k, u] of Object.entries(users)) {
    cookies[k] = await login(app, k === 'otherAdmin' ? 'evals-andere' : 'evals', u.email);
    api[k] = client(app, cookies[k]);
  }
});

afterEach(() => setProviderFactory(null));

afterAll(async () => {
  await app.close();
  await closePool();
});

const raw = (who: string, url: string) => app.inject({ method: 'GET', url, headers: { cookie: cookies[who] } });

const external = {
  providers: [
    { id: 'builtin', name: 'Eingebaut', kind: 'builtin' as const, baseUrl: '', hosting: 'local' as const, keySource: 'none' as const },
    { id: 'anthropic', name: 'Anthropic Claude', kind: 'anthropic' as const, baseUrl: '', hosting: 'other' as const, keySource: 'tenant' as const },
  ],
  models: {
    fast: { provider: 'anthropic', model: 'claude-haiku-5-5' },
    deep: { provider: 'anthropic', model: 'claude-opus-5-5' },
    vision: { provider: 'anthropic', model: 'claude-opus-5-5' },
    speech: { provider: 'builtin', model: 'regelbasiert' },
    confidential: { provider: 'builtin', model: 'regelbasiert' },
  },
};

async function setAi(patch: Partial<AiSettings>) {
  const current = (await api.admin.get('/api/admin/ai')).body.settings as AiSettings;
  return api.admin.put('/api/admin/ai', { ...current, ...patch });
}

describe('quality settings (Einstellungen › KI › Qualität)', () => {
  it('only admins read and change them; invalid values are refused; the change is audited', async () => {
    const current = await api.admin.get('/api/admin/ai/quality-settings');
    expect(current.status).toBe(200);
    expect(current.body).toMatchObject({ evals: { sampleSize: 15, judge: { enabled: false } }, fallback: { serverSide: true } });
    expect((await api.erika.get('/api/admin/ai/quality-settings')).status).toBe(403);
    const next = { ...current.body, evals: { ...current.body.evals, sampleSize: 3 } };
    expect((await api.erika.put('/api/admin/ai/quality-settings', next)).status).toBe(403);
    expect((await api.admin.put('/api/admin/ai/quality-settings', { ...next, evals: { ...next.evals, sampleSize: 1 } })).status).toBe(400);
    expect((await api.admin.put('/api/admin/ai/quality-settings', next)).status).toBe(200);
    expect((await api.admin.get('/api/admin/ai')).body.settings.evals.sampleSize).toBe(3);
    // Other workspaces keep their own values.
    expect((await api.otherAdmin.get('/api/admin/ai/quality-settings')).body.evals.sampleSize).toBe(15);
    const audit = await withTenant(tenant, (db) => db.query(`SELECT after FROM audit_log WHERE action = 'settings.ai' ORDER BY id DESC LIMIT 1`));
    expect(audit.rows[0].after.evals.sampleSize).toBe(3);
  });
});

describe('evaluation runs, cases, comparison and reports', () => {
  let first: string;
  let second: string;

  it('stores every case and compares the second run with the first', async () => {
    expect((await api.admin.post('/api/admin/ai/eval')).status).toBe(202);
    await drainAiJobs();
    expect((await api.admin.post('/api/admin/ai/eval')).status).toBe(202);
    await drainAiJobs();
    const runs = (await api.admin.get('/api/admin/ai/evals')).body as {
      id: string;
      status: string;
      testsetVersion: number;
      metrics: Record<string, { n: number; passed: boolean; promptVersion: string }>;
      comparison: { previousRunId: string | null; agents: unknown[]; regressions: unknown[] };
      names: Record<string, string>;
    }[];
    const done = runs.filter((r) => r.status === 'done');
    expect(done.length).toBeGreaterThanOrEqual(2);
    [second, first] = [done[0].id, done[1].id];
    expect(done[0].testsetVersion).toBeGreaterThanOrEqual(2);
    expect(done[0].comparison.previousRunId).toBe(first);
    expect(done[0].comparison.regressions).toEqual([]);
    expect(done[0].names.triage_suggestion).toBe('Triage-Vorschlag');
    // The sample size of the workspace applies to sampled agents; triage runs on all cases.
    expect(done[0].metrics.coach.n).toBe(3);
    expect(done[0].metrics.triage_suggestion.n).toBeGreaterThanOrEqual(85);
    expect(done[0].metrics.triage_suggestion.promptVersion).toBe(agentPromptVersion('triage_suggestion'));
    expect(Object.values(done[0].metrics).every((m) => m.passed)).toBe(true);
    const cases = await withTenant(tenant, (db) => db.query<{ n: number }>('SELECT count(*)::int AS n FROM ai_eval_cases WHERE run_id = $1', [second]));
    expect(cases.rows[0].n).toBeGreaterThan(200);
  });

  it('downloads the report as JSON and Markdown, for admins of the workspace only', async () => {
    const json = await raw('admin', `/api/admin/ai/evals/${second}/report.json`);
    expect(json.statusCode).toBe(200);
    expect(json.headers['content-disposition']).toContain('attachment');
    const body = JSON.parse(json.body);
    expect(body).toMatchObject({ kind: 'ideenportal-ai-eval-report', formatVersion: 1, run: { id: second }, comparison: { previousRunId: first } });
    expect(body.cases.length).toBeGreaterThan(200);
    expect(JSON.stringify(body)).not.toContain('baseUrl');
    const md = await raw('admin', `/api/admin/ai/evals/${second}/report.md`);
    expect(md.statusCode).toBe(200);
    expect(md.headers['content-type']).toContain('text/markdown');
    expect(md.body).toContain('# KI-Qualitätsbericht');
    expect(md.body).toContain(first);
    expect((await raw('erika', `/api/admin/ai/evals/${second}/report.md`)).statusCode).toBe(403);
    expect((await raw('otherAdmin', `/api/admin/ai/evals/${second}/report.json`)).statusCode).toBe(404);
    expect((await raw('otherAdmin', `/api/admin/ai/evals/${second}/report.md`)).statusCode).toBe(404);
    expect((await raw('admin', '/api/admin/ai/evals/00000000-0000-0000-0000-000000000000/report.json')).statusCode).toBe(404);
  });

  it('keeps the cases of one workspace invisible to another (row-level security)', async () => {
    const seen = await withTenant(other, (db) => db.query<{ n: number }>('SELECT count(*)::int AS n FROM ai_eval_cases'));
    expect(seen.rows[0].n).toBe(0);
    await expect(
      withTenant(other, (db) =>
        db.query(`INSERT INTO ai_eval_cases (tenant_id, run_id, agent, case_id, score, deterministic) VALUES ($1, $2, 'coach', 'T01', 1, 1)`, [tenant, second]),
      ),
    ).rejects.toThrow();
    expect((await api.otherAdmin.get('/api/admin/ai/evals')).body.some((r: { id: string }) => r.id === second)).toBe(false);
  });
});

describe('transparency page "KI im Portal"', () => {
  it('shows every agent with purpose, model, data, last check and oversight to every member', async () => {
    const res = await api.erika.get('/api/ai/transparency');
    expect(res.status).toBe(200);
    expect(res.body.agents.map((a: { agent: string }) => a.agent)).toEqual([...AGENTS]);
    const triage = res.body.agents.find((a: { agent: string }) => a.agent === 'triage_suggestion');
    expect(triage).toMatchObject({
      name: 'Triage-Vorschlag',
      model: { kind: 'builtin', local: true },
      oversight: { kind: 'gate' },
      evaluation: { passed: true, current: true },
    });
    expect(triage.purpose.length).toBeGreaterThan(10);
    expect(triage.data.labels.length).toBeGreaterThan(0);
    expect(res.body.models.length).toBeGreaterThan(0);
    // Another workspace sees its own state, not the checks of this one.
    const theirs = (await api.otherAdmin.get('/api/ai/transparency')).body;
    expect(theirs.agents.find((a: { agent: string }) => a.agent === 'triage_suggestion').evaluation).toBeNull();
  });

  it('lists model changes from the audit log without names, keys or addresses', async () => {
    expect((await api.admin.put('/api/admin/ai/keys', { name: 'provider:anthropic', value: 'test-key-123456' })).status).toBe(200);
    expect((await setAi({ ...external, requireEval: false })).status).toBe(200);
    const res = await api.erika.get('/api/ai/transparency');
    const short = res.body.agents.find((a: { agent: string }) => a.agent === 'short_analysis');
    expect(short.model).toMatchObject({ provider: 'Anthropic Claude', model: 'claude-haiku-5-5', hosting: 'other', local: false });
    expect(short.history[0]).toMatchObject({ to: 'Anthropic Claude / claude-haiku-5-5' });
    expect(short.history[0].from).toContain('regelbasiert');
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('chefin@evals.example');
    expect(text).not.toContain('test-key-123456');
    expect(text).not.toContain('baseUrl');
    expect(res.body.confidential).toMatchObject({ kind: 'builtin', local: true });
  });

  it('generates a model card per configured model', async () => {
    const card = await raw('erika', '/api/ai/transparency/model-card.md?provider=anthropic&model=claude-haiku-5-5');
    expect(card.statusCode).toBe(200);
    expect(card.headers['content-type']).toContain('text/markdown');
    expect(card.body).toContain('# Modellkarte: Anthropic Claude / claude-haiku-5-5');
    expect(card.body).toContain('Kurzanalyse');
    expect(card.body).toContain('Vertrauliche Ideen');
    expect((await raw('erika', '/api/ai/transparency/model-card.md?provider=anthropic&model=unbekannt')).statusCode).toBe(404);
    expect((await raw('otherAdmin', '/api/ai/transparency/model-card.md?provider=anthropic&model=claude-haiku-5-5')).statusCode).toBe(404);
  });
});

describe('fallback model and prompt version (R2-12)', () => {
  const call = {
    agent: 'coach' as const,
    ideaId: null,
    sensitive: false,
    system: 'System',
    prompt: 'Prompt',
    maxTokens: 100,
    schema: z.object({ ok: z.boolean() }),
    builtin: () => ({ ok: true }),
  };
  function fallbackModel(servedBy: string) {
    const calls: GenerateRequest[] = [];
    setProviderFactory((p) => {
      if (p.kind === 'builtin') throw new Error('builtin');
      return {
        async generate(req) {
          calls.push(req);
          return { json: { ok: true }, inputTokens: 10, outputTokens: 5, servedBy, refused: false };
        },
      };
    });
    return calls;
  }
  const lastAction = () =>
    withTenant(tenant, (db) =>
      db.query('SELECT prompt_version, served_by, model_checked, warnings FROM ai_actions WHERE agent = $1 ORDER BY created_at DESC LIMIT 1', ['coach']),
    );

  it('marks an answer of an unchecked fallback model and logs it', async () => {
    const calls = fallbackModel('claude-fallback-1');
    const run = await runAgent(await detachedCtx(tenant, users.admin), call);
    expect(calls[0].allowFallback).toBe(true);
    expect(run.uncheckedModel).toBe('claude-fallback-1');
    expect(run.warnings[0]).toContain('ungeprüftes Modell');
    expect(run.promptVersion).toBe(agentPromptVersion('coach'));
    const row = (await lastAction()).rows[0];
    expect(row).toMatchObject({ prompt_version: agentPromptVersion('coach'), served_by: 'claude-fallback-1', model_checked: false });
  });

  it('does not warn for a dated snapshot of the configured model', async () => {
    fallbackModel('claude-haiku-5-5-20260301');
    const run = await runAgent(await detachedCtx(tenant, users.admin), call);
    expect(run.uncheckedModel).toBeNull();
    expect((await lastAction()).rows[0].served_by).toBeNull();
  });

  it('accepts a fallback model that passed the test set for the agent with the current prompt', async () => {
    await withTenant(tenant, (db) =>
      db.query(`INSERT INTO ai_eval_runs (tenant_id, config_hash, trigger, status, config, metrics) VALUES ($1, 'x', 'manual', 'done', '{}', $2)`, [
        tenant,
        JSON.stringify({
          coach: { score: 1, minScore: 0.8, passed: true, n: 3, notes: [], modelId: 'claude-fallback-1', promptVersion: agentPromptVersion('coach') },
        }),
      ]),
    );
    fallbackModel('claude-fallback-1');
    const run = await runAgent(await detachedCtx(tenant, users.admin), call);
    expect(run.uncheckedModel).toBeNull();
    expect(run.warnings.join(' ')).toContain('bestanden');
    expect((await lastAction()).rows[0]).toMatchObject({ served_by: 'claude-fallback-1', model_checked: true });
    // The check is per workspace: the same model is unchecked in another one.
    expect(await withTenant(other, (db) => db.query('SELECT 1 FROM ai_eval_runs')).then((r) => r.rowCount)).toBe(0);
  });

  it('switching off the server-side fallback is passed to the provider', async () => {
    const q = (await api.admin.get('/api/admin/ai/quality-settings')).body;
    expect((await api.admin.put('/api/admin/ai/quality-settings', { ...q, fallback: { serverSide: false } })).status).toBe(200);
    const calls = fallbackModel('claude-haiku-5-5');
    await runAgent(await detachedCtx(tenant, users.admin), call);
    expect(calls[0].allowFallback).toBe(false);
    const transparency = (await api.erika.get('/api/ai/transparency')).body;
    expect(transparency.fallbackServerSide).toBe(false);
  });
});
