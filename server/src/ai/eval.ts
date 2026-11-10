import { createHash } from 'node:crypto';
import type { Ctx } from '../lib/context.js';
import { claimTexts, type Section, type Source } from './content.js';
import { agentLabel, runSuites, type AgentResult } from './evalCore.js';
import { casesOf, compareRuns, metricsOf, type AgentMetric, type CaseScore, type Comparison, type RunData } from './evalReport.js';
import { AiError, allProviders, resolveModel, runAgent, setModelCheck, setReleaseCheck } from './gateway.js';
import { tx } from './pipeline.js';
import { agentPromptVersion, allPromptVersions } from './promptVersion.js';
import { sourceMetrics, type BlockSourceMetric } from './sourcecheck.js';
import { AGENT_DEFAULTS, DEFAULT_EVALS, agentLabel as labelFor, type AgentName, type AiSettings } from './settings.js';
import { m, tr } from '../i18n/index.js';
import { loadTestSet } from './testset.js';

// Quality measurement against the AI test set (R2-12): every agent needs its minimum score
// before it goes live; a change of model, prompt (per-agent prompt version) or test set starts a
// new run automatically. Each run stores the score per case and the comparison with the
// previous run (regressions); reports come from evalReport.ts.

export { loadTestSet, type TestIdea, type TestSet } from './testset.js';
export type { AgentMetric } from './evalReport.js';

/** Fingerprint of everything that changes agent behaviour: providers, models, prompt versions, test set. */
export function configHash(ai: AiSettings): string {
  let version = 0;
  try {
    version = loadTestSet().version;
  } catch {
    version = -1;
  }
  const payload = {
    providers: allProviders(ai).map((p) => ({ id: p.id, kind: p.kind, baseUrl: p.baseUrl, hosting: p.hosting })),
    models: ai.models,
    agents: Object.fromEntries(Object.entries(ai.agents).map(([k, v]) => [k, v?.model ?? null])),
    prompts: allPromptVersions(),
    testset: version,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

export function minScore(ai: AiSettings, agent: AgentName): number {
  return ai.agents[agent]?.minScore ?? AGENT_DEFAULTS[agent].minScore;
}

interface EvalRunRow {
  id: string;
  status: 'running' | 'done' | 'failed';
  metrics: Record<string, AgentMetric>;
  config_hash: string;
  created_at: Date;
}

export async function latestRun(c: Ctx, hash: string): Promise<EvalRunRow | null> {
  const r = await c.db.query<EvalRunRow>('SELECT id, status, metrics, config_hash, created_at FROM ai_eval_runs WHERE config_hash = $1 ORDER BY created_at DESC LIMIT 1', [hash]);
  return r.rows[0] ?? null;
}

/** Queues an evaluation run unless one is already queued or running. */
export async function enqueueEval(c: Ctx, trigger: 'manual' | 'config_change' | 'initial'): Promise<void> {
  await c.db.query(
    `INSERT INTO ai_jobs (tenant_id, kind, params, created_by) VALUES ($1, 'eval_run', $2, $3) ON CONFLICT DO NOTHING`,
    [c.tenantId, JSON.stringify({ trigger }), c.user?.id ?? null],
  );
}

export type ReleaseState = { released: true; reason: 'no_eval' | 'passed' | 'override' | 'not_required' } | { released: false; reason: 'pending' | 'failed'; score?: number; minScore: number };

export async function releaseState(c: Ctx, agent: AgentName): Promise<ReleaseState> {
  const ai = c.settings.ai;
  const min = minScore(ai, agent);
  if (!ai.requireEval) return { released: true, reason: 'not_required' };
  if (min === 0) return { released: true, reason: 'no_eval' };
  const hash = configHash(ai);
  const override = ai.releaseOverrides[agent];
  if (override && override.configHash === hash) return { released: true, reason: 'override' };
  const run = await latestRun(c, hash);
  if (!run || run.status === 'running') return { released: false, reason: 'pending', minScore: min };
  const m = run.metrics[agent];
  if (run.status === 'failed' || !m) return { released: false, reason: 'failed', minScore: min };
  return m.score >= min ? { released: true, reason: 'passed' } : { released: false, reason: 'failed', score: m.score, minScore: min };
}

setReleaseCheck(async (ctx, agent) => {
  const state = await tx(ctx, async (c) => {
    const s = await releaseState(c, agent);
    if (!s.released && s.reason === 'pending') {
      const any = await c.db.query('SELECT 1 FROM ai_eval_runs LIMIT 1');
      await enqueueEval(c, any.rowCount ? 'config_change' : 'initial');
    }
    return s;
  });
  if (state.released) return;
  const label = labelFor(ctx.locale, agent);
  if (state.reason === 'pending') {
    throw new AiError(m('aigw.err.evalPending', { label }), 'AI_EVAL_PENDING', true);
  }
  const pct = (n: number) => `${Math.round(n * 100)} %`;
  throw new AiError(
    m('aigw.err.notReleased', { label, score: state.score !== undefined ? pct(state.score) : tr(ctx.locale, m('aigw.err.noResults')), min: pct(state.minScore) }),
    'AI_NOT_RELEASED',
  );
});

/**
 * Whether a model passed the test set for an agent with the current prompt version in this
 * workspace (R2-12). Used for answers of a server-side fallback model.
 */
export async function modelPassed(c: Ctx, agent: AgentName, model: string): Promise<boolean> {
  const r = await c.db.query(
    `SELECT 1 FROM ai_eval_runs
      WHERE status = 'done' AND (metrics->$1->>'passed')::boolean IS TRUE
        AND metrics->$1->>'modelId' = $2 AND metrics->$1->>'promptVersion' = $3
      LIMIT 1`,
    [agent, model, agentPromptVersion(agent)],
  );
  return (r.rowCount ?? 0) > 0;
}

setModelCheck((ctx, agent, model) => tx(ctx, (c) => modelPassed(c, agent, model)));

// ---------------------------------------------------------------- the evaluation run

function modelOf(ai: AiSettings, agent: AgentName): { label: string; id: string } {
  try {
    const m = resolveModel(ai, agent, agent === 'boundary');
    return { label: `${m.provider.name} / ${m.model}`, id: m.model };
  } catch (err) {
    return { label: (err as Error).message, id: '-' };
  }
}

/** The judge needs a real model in the "deep" slot; the builtin provider cannot judge. */
export function judgeAvailable(ai: AiSettings): boolean {
  const ref = ai.models.deep;
  const p = allProviders(ai).find((x) => x.id === ref.provider);
  return !!p && p.kind !== 'builtin' && ai.agents.eval_judge?.enabled !== false;
}

/** Runs the whole test set for the current configuration and stores metrics, cases and the comparison. */
export async function runEvaluation(ctx: Ctx, trigger: 'manual' | 'config_change' | 'initial'): Promise<{ id: string; metrics: Record<string, AgentMetric>; comparison: Comparison }> {
  const ai = ctx.settings.ai;
  const evals = ai.evals ?? DEFAULT_EVALS;
  const hash = configHash(ai);
  const set = loadTestSet();
  const prompts = allPromptVersions();
  const judge = evals.judge.enabled && judgeAvailable(ai) ? evals.judge : null;
  const config = {
    models: ai.models,
    agents: ai.agents,
    providers: allProviders(ai).map((p) => ({ id: p.id, kind: p.kind, hosting: p.hosting })),
    promptVersions: prompts,
    sampleSize: evals.sampleSize,
    judge: judge ? { weight: judge.weight, maxCostEurPerRun: judge.maxCostEurPerRun, maxCasesPerAgent: judge.maxCasesPerAgent } : null,
  };
  const runId = await tx(ctx, async (c) =>
    (await c.db.query<{ id: string }>(
      'INSERT INTO ai_eval_runs (tenant_id, config_hash, trigger, config, created_by, testset_version, prompt_versions) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [c.tenantId, hash, trigger, JSON.stringify(config), c.user?.id ?? null, set.version, JSON.stringify(prompts)],
    )).rows[0].id,
  );
  try {
    const results: Record<string, AgentResult> = await runSuites(set, {
      settings: ctx.settings,
      exec: (call) => runAgent(ctx, call),
      sampleSize: evals.sampleSize,
      minScore: (a) => minScore(ai, a),
      modelLabel: (a) => modelOf(ai, a).label,
      judge,
    });
    const metrics: Record<string, AgentMetric & { modelId: string }> = Object.fromEntries(
      Object.entries(metricsOf(results)).map(([k, v]) => [k, { ...v, modelId: modelOf(ai, k as AgentName).id }]),
    );
    const cases = casesOf(results);
    const cost = Object.values(results).reduce((s, r) => s + r.cases.reduce((x, c) => x + c.costEur, 0), 0);
    const rows = Object.values(results).flatMap((r) =>
      r.cases.map((c) => ({
        agent: r.agent, case_id: c.caseId, score: c.score, deterministic: c.deterministic, judge: c.judge, failed: c.failed,
        checks: c.checks, note: c.note ?? null, blocked: !!c.blocked, served_by: c.servedBy ?? null, cost_eur: c.costEur,
      })),
    );
    const comparison = await tx(ctx, async (c) => {
      if (rows.length) {
        await c.db.query(
          `INSERT INTO ai_eval_cases (tenant_id, run_id, agent, case_id, score, deterministic, judge, failed, checks, note, blocked, served_by, cost_eur)
           SELECT $1, $2, x.agent, x.case_id, x.score, x.deterministic, x.judge, coalesce(x.failed, '[]'::jsonb), coalesce(x.checks, '[]'::jsonb), x.note, coalesce(x.blocked, false), x.served_by, coalesce(x.cost_eur, 0)
             FROM jsonb_to_recordset($3::jsonb) AS x(agent text, case_id text, score numeric, deterministic numeric, judge numeric, failed jsonb, checks jsonb, note text, blocked boolean, served_by text, cost_eur numeric)`,
          [c.tenantId, runId, JSON.stringify(rows)],
        );
      }
      const prev = await c.db.query<{ id: string; created_at: Date; metrics: Record<string, AgentMetric> }>(
        `SELECT id, created_at, metrics FROM ai_eval_runs
          WHERE status = 'done' AND id <> $1 AND created_at <= (SELECT created_at FROM ai_eval_runs WHERE id = $1)
          ORDER BY created_at DESC LIMIT 1`,
        [runId],
      );
      const p = prev.rows[0];
      const previous = p ? { id: p.id, createdAt: p.created_at.toISOString(), metrics: p.metrics, cases: await runCases(c, p.id) } : null;
      const cmp = compareRuns({ metrics, cases }, previous, evals.regressionTolerance);
      const details = Object.values(results).map((r) => ({ agent: r.agent, label: agentLabel(r.agent), notes: r.notes }));
      await c.db.query(
        `UPDATE ai_eval_runs SET status = 'done', metrics = $2, details = $3, cost_eur = $4, comparison = $5, previous_run_id = $6, finished_at = now() WHERE id = $1`,
        [runId, JSON.stringify(metrics), JSON.stringify(details), Math.round(cost * 10_000) / 10_000, JSON.stringify(cmp), p?.id ?? null],
      );
      return cmp;
    });
    return { id: runId, metrics, comparison };
  } catch (err) {
    await tx(ctx, (c) => c.db.query(`UPDATE ai_eval_runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [runId, (err as Error).message]));
    throw err;
  }
}

async function runCases(c: Ctx, runId: string): Promise<CaseScore[]> {
  const r = await c.db.query<CaseScore>(
    `SELECT agent, case_id AS "caseId", score, deterministic, judge, failed, note, blocked, served_by AS "servedBy" FROM ai_eval_cases WHERE run_id = $1 ORDER BY agent, case_id`,
    [runId],
  );
  return r.rows;
}

/** Everything a report needs for one run of this workspace; null when the run does not exist here. */
export async function loadRunData(c: Ctx, runId: string): Promise<{ run: RunData; comparison: Comparison | null } | null> {
  const r = await c.db.query<{
    id: string; created_at: Date; finished_at: Date | null; trigger: string; status: string; config_hash: string; testset_version: number | null;
    cost_eur: number; config: Record<string, unknown>; metrics: Record<string, AgentMetric>; comparison: Comparison | null;
  }>(
    'SELECT id, created_at, finished_at, trigger, status, config_hash, testset_version, cost_eur, config, metrics, comparison FROM ai_eval_runs WHERE id = $1',
    [runId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    run: {
      id: row.id, createdAt: row.created_at.toISOString(), finishedAt: row.finished_at?.toISOString() ?? null, trigger: row.trigger, status: row.status,
      configHash: row.config_hash, testsetVersion: row.testset_version, costEur: Number(row.cost_eur), config: row.config, metrics: row.metrics, cases: await runCases(c, row.id),
    },
    comparison: row.comparison,
  };
}

/** Quality in real use: hit rate of triage suggestions (R2-18) and correction rate per agent (R2-15). */
export async function qualityInUse(c: Ctx): Promise<{ triage: { suggestions: number; hits: number; rate: number | null }; corrections: { kind: string; claims: number; corrected: number; rate: number | null }[]; briefReading: { reads: number; medianSeconds: number | null }; sourceCheck: BlockSourceMetric[] }> {
  const t = await c.db.query<{ n: number; hits: number }>(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE s.content->'data'->>'lane' = d.outcome)::int AS hits
       FROM decisions d
       JOIN LATERAL (SELECT content FROM ai_results r WHERE r.idea_id = d.idea_id AND r.kind = 'triage_suggestion' AND r.created_at <= d.decided_at
                      ORDER BY r.version DESC LIMIT 1) s ON true
      WHERE d.gate = 1`,
  );
  const results = await c.db.query<{ kind: string; content: { sections?: Section[]; sources?: Source[] }; corrected: number }>(
    `SELECT r.kind, r.content, (SELECT count(*)::int FROM ai_corrections k WHERE k.result_id = r.id) AS corrected
       FROM ai_results r WHERE r.created_at > now() - interval '180 days'`,
  );
  const byKind = new Map<string, { claims: number; corrected: number }>();
  for (const r of results.rows) {
    const claims = claimTexts((r.content.sections ?? []) as never).length;
    if (!claims) continue;
    const e = byKind.get(r.kind) ?? { claims: 0, corrected: 0 };
    e.claims += claims;
    e.corrected += r.corrected;
    byKind.set(r.kind, e);
  }
  const n = t.rows[0].n;
  // Reading time of the Gate 2 brief (R2-43); target: at most 10 minutes.
  const reads = await c.db.query<{ reads: number; median: number | null }>(
    `SELECT count(*)::int AS reads, percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds)::float AS median FROM brief_reads WHERE created_at > now() - interval '180 days'`,
  );
  return {
    // Source check (R2-46): share of numbers with a source, reachable pages, quotes found, per block.
    sourceCheck: sourceMetrics(results.rows),
    briefReading: { reads: reads.rows[0].reads, medianSeconds: reads.rows[0].median == null ? null : Math.round(reads.rows[0].median) },
    triage: { suggestions: n, hits: t.rows[0].hits, rate: n >= 1 ? Math.round((t.rows[0].hits / n) * 100) / 100 : null },
    corrections: [...byKind.entries()].map(([kind, e]) => ({ kind, ...e, rate: Math.round((e.corrected / e.claims) * 100) / 100 })),
  };
}
