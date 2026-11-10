import { checkBoundary } from '../lib/boundary.js';
import type { Settings } from '../lib/settings.js';
import { refText } from '../i18n/index.js';
import {
  boundaryCall,
  businessCaseCall,
  challengeSuggestionsCall,
  coachCall,
  competitionCall,
  counterCall,
  dossierCall,
  experimentCall,
  gate2Call,
  internalMarketCall,
  marketSizeCall,
  patentsCall,
  positioningCall,
  replyCall,
  riskCall,
  shortAnalysisCall,
  successStoryCall,
  summaryCall,
  triageCall,
} from './agents.js';
import type { Source } from './content.js';
import { AiError, type AgentCall, type AgentRun } from './gateway.js';
import { importCleanupCall } from './importCleanup.js';
import { combinedScore, judgeCall, judgeScore } from './judge.js';
import { packageCall } from './package.js';
import { finalize } from './pipeline.js';
import { agentPromptVersion } from './promptVersion.js';
import { scoreOutput, type Check } from './scorers.js';
import { AGENTS, agentLabel as labelIn, type AgentName } from './settings.js';
import { factsOf, localeOf, sampleCases, sourcesOf, untrustedOf, type TestIdea, type TestSet } from './testset.js';

// The evaluation engine (R2-12) without database: builds the agent calls for the test cases,
// runs them through an executor (the gateway of a workspace, or a direct model call in the CLI),
// applies the same post-processing as in production and scores every case. The workspace run
// (eval.ts) stores the results; the CLI (eval-cli.ts) prints a report for CI.

/** Runs one agent call; the workspace uses runAgent, the CLI a direct provider call. */
export type Exec = <T extends object>(call: AgentCall<T>) => Promise<AgentRun<T> & { servedBy?: string | null }>;

export interface CaseResult {
  caseId: string;
  score: number;
  deterministic: number;
  judge: number | null;
  checks: Check[];
  failed: string[];
  note?: string;
  /** Confidential case that the gateway correctly kept from an external model. */
  blocked?: boolean;
  costEur: number;
  servedBy?: string | null;
  judgeIssues?: string[];
}

export interface AgentResult {
  agent: AgentName;
  score: number;
  /** Mean of the deterministic scores (without judge). */
  deterministic: number;
  minScore: number;
  passed: boolean;
  n: number;
  model: string;
  promptVersion: string;
  judged: number;
  cases: CaseResult[];
  notes: string[];
}

export interface JudgeOptions {
  enabled: boolean;
  weight: number;
  maxCostEurPerRun: number;
  maxCasesPerAgent: number;
}

export interface EvalOptions {
  settings: Settings;
  exec: Exec;
  /** Only these agents (default: all with a minimum score above 0 that are switched on). */
  agents?: AgentName[];
  /** Cases per expensive agent. */
  sampleSize: number;
  minScore: (agent: AgentName) => number;
  modelLabel: (agent: AgentName) => string;
  /** LLM-as-judge; only when a model (not the builtin provider) is set for "deep". */
  judge?: JudgeOptions | null;
  /** Cases of one agent run at the same time (CLI against a model API); default 1. */
  concurrency?: number;
}

/** Maps with at most n promises at a time, keeping the order. */
async function mapPool<A, B>(items: A[], n: number, fn: (a: A) => Promise<B>): Promise<B[]> {
  const out: B[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}

interface Built {
  call: AgentCall<object>;
  /** Further input the answer may quote from (comments, facts). */
  context?: string;
  untrusted?: string;
}

interface Suite {
  /** Cases of the agent before sampling. */
  pool: (ideas: TestIdea[]) => TestIdea[];
  sampled: boolean;
  build?: (t: TestIdea, s: Settings) => Built;
  /** Own runner for agents that are not a single model call per case. */
  custom?: (t: TestIdea, opts: EvalOptions) => Promise<CaseResult>;
  /** One case for the whole sample (e.g. challenge suggestions from a strategy text). */
  whole?: (ideas: TestIdea[], s: Settings) => { idea: TestIdea; built: Built };
}

const all = (ideas: TestIdea[]) => ideas;
const regular = (ideas: TestIdea[]) => ideas.filter((t) => !t.expected.boundary);
const en = (t: TestIdea) => localeOf(t) === 'en';

const COACH_Q = { de: 'Was läuft heute nicht gut?', en: 'What is not working well today?' };
const REASON = { de: 'Begründung des Triage-Teams.', en: 'Reasoning of the triage team.' };
const comments = (t: TestIdea) =>
  en(t)
    ? [
        { n: 1, body: t.problem },
        { n: 2, body: `Good idea. ${t.benefit}` },
        { n: 3, body: 'But who takes care of running it?' },
      ]
    : [
        { n: 1, body: t.problem },
        { n: 2, body: `Gute Idee. ${t.benefit}` },
        { n: 3, body: 'Aber wer kümmert sich um den Betrieb?' },
      ];
const withLocale = <T extends object>(t: TestIdea, call: AgentCall<T>): AgentCall<object> => ({ ...call, locale: localeOf(t) }) as AgentCall<object>;

/** Boundary check: local rules first, then the boundary agent (only on local models). */
async function boundaryCase(t: TestIdea, opts: EvalOptions): Promise<CaseResult> {
  const text = untrustedOf(t);
  let predicted: string | null = checkBoundary(text, opts.settings)[0]?.category ?? null;
  let cost = 0;
  if (!predicted) {
    try {
      const run = await opts.exec({ ...boundaryCall(text, opts.settings), evaluation: true });
      cost = run.costEur;
      predicted = run.output.category === 'none' ? null : run.output.category;
    } catch (err) {
      if (!(err instanceof AiError && err.code === 'AI_CONFIDENTIAL')) throw err;
    }
  }
  const pass = (predicted ?? null) === (t.expected.boundary ?? null);
  const check: Check = {
    id: 'category',
    value: pass ? 1 : 0,
    weight: 1,
    ...(pass ? {} : { note: `erkannt ${predicted ?? 'keine'}, erwartet ${t.expected.boundary ?? 'keine'}` }),
  };
  return {
    caseId: t.id,
    score: pass ? 1 : 0,
    deterministic: pass ? 1 : 0,
    judge: null,
    checks: [check],
    failed: pass ? [] : ['category'],
    costEur: cost,
    ...(pass ? {} : { note: check.note }),
  };
}

export const SUITES: Partial<Record<AgentName, Suite>> = {
  boundary: { pool: all, sampled: false, custom: boundaryCase },
  short_analysis: { pool: all, sampled: false, build: (t) => ({ call: withLocale(t, shortAnalysisCall(factsOf(t), sourcesOf(t))) }) },
  triage_suggestion: { pool: all, sampled: false, build: (t, s) => ({ call: withLocale(t, triageCall(factsOf(t), null, s)) }) },
  coach: {
    pool: regular,
    sampled: true,
    build: (t) => ({
      call: withLocale(
        t,
        coachCall(
          [
            { role: 'coach', text: COACH_Q[localeOf(t)], asks: 'problem' },
            { role: 'user', text: t.problem },
          ],
          { title: '', problem: '', solution: '', benefit: '' },
          t.confidential,
        ),
      ),
      untrusted: t.problem,
    }),
  },
  reply_draft: { pool: all, sampled: true, build: (t, s) => ({ call: withLocale(t, replyCall(factsOf(t), t.expected.lane, REASON[localeOf(t)], s)) }) },
  discussion_summary: {
    pool: regular,
    sampled: true,
    build: (t) => {
      const c = comments(t);
      return {
        call: withLocale(t, summaryCall(factsOf(t), c)),
        context: c.map((x) => `#${x.n}`).join(' '),
        untrusted: `${untrustedOf(t)}\n${c.map((x) => x.body).join('\n')}`,
      };
    },
  },
  competition: { pool: regular, sampled: true, build: (t) => ({ call: withLocale(t, competitionCall(factsOf(t), sourcesOf(t))) }) },
  patents: { pool: regular, sampled: true, build: (t) => ({ call: withLocale(t, patentsCall(factsOf(t), sourcesOf(t))) }) },
  positioning: { pool: regular, sampled: true, build: (t) => ({ call: withLocale(t, positioningCall(factsOf(t), null)) }) },
  market_size: {
    pool: (ideas) => regular(ideas).filter((t) => t.ideaType === 'product'),
    sampled: true,
    build: (t) => ({ call: withLocale(t, marketSizeCall(factsOf(t), sourcesOf(t))) }),
  },
  internal_market: {
    pool: (ideas) => regular(ideas).filter((t) => t.ideaType === 'internal'),
    sampled: true,
    build: (t) => ({ call: withLocale(t, internalMarketCall(factsOf(t), sourcesOf(t))) }),
  },
  business_case: { pool: regular, sampled: true, build: (t) => ({ call: withLocale(t, businessCaseCall(factsOf(t), {}, sourcesOf(t))) }) },
  risk_check: { pool: regular, sampled: true, build: (t) => ({ call: withLocale(t, riskCall(factsOf(t))) }) },
  experiment: { pool: regular, sampled: true, build: (t) => ({ call: withLocale(t, experimentCall(factsOf(t), null)) }) },
  dossier_draft: { pool: regular, sampled: true, build: (t) => ({ call: withLocale(t, dossierCall(factsOf(t), {})) }) },
  gate2_brief: {
    pool: regular,
    sampled: true,
    build: (t) => ({ call: withLocale(t, gate2Call(factsOf(t), { benefit: t.benefit }, {}, sourcesOf(t))), context: t.benefit }),
  },
  counterarguments: { pool: regular, sampled: true, build: (t) => ({ call: withLocale(t, counterCall(factsOf(t), {}, sourcesOf(t))) }) },
  success_story: {
    pool: regular,
    sampled: true,
    build: (t) => ({ call: withLocale(t, successStoryCall(factsOf(t), { dossier: {}, benefit: null, review: null })) }),
  },
  implementation_package: {
    pool: regular,
    sampled: true,
    build: (t) => ({ call: withLocale(t, packageCall(factsOf(t), { dossier: { benefit: t.benefit }, targetDate: null, channel: null })) }),
  },
  import_cleanup: {
    pool: regular,
    sampled: true,
    build: (t, s) => ({
      call: withLocale(
        t,
        importCleanupCall(
          [
            {
              row: 2,
              title: t.title.toUpperCase(),
              problem: `${t.problem.replace(/ä/g, 'Ã¤')}\n\nViele Grüße\nTest`,
              solution: t.solution,
              benefit: t.benefit,
              topic: '',
            },
          ],
          s.topics,
          t.confidential,
        ),
      ),
    }),
  },
  challenge_suggestions: {
    pool: (ideas) => regular(ideas).filter((t) => localeOf(t) === 'de'),
    sampled: true,
    whole: (ideas, s) => {
      const strategy = ideas.map((i) => `${i.title}. ${i.problem}`).join('\n');
      const first = ideas[0];
      const idea: TestIdea = {
        ...first,
        id: 'STRATEGIE',
        title: '',
        problem: strategy,
        solution: '',
        benefit: '',
        expected: {
          ...first.expected,
          keyPoints: [],
          injection: ideas.some((i) => i.expected.injection),
          forbidden: [...new Set(ideas.flatMap((i) => i.expected.forbidden))],
        },
      };
      return { idea, built: { call: challengeSuggestionsCall(strategy, s) as AgentCall<object>, untrusted: strategy } };
    },
  },
};

const HARD_STOP = ['AI_BUDGET', 'AI_DISABLED', 'AI_CONFIG'];

interface JudgeState {
  spentEur: number;
}

async function modelCase(agent: AgentName, t: TestIdea, built: Built, opts: EvalOptions, judged: { n: number }, js: JudgeState): Promise<CaseResult> {
  const sources: Source[] = built.call.sources ?? [];
  try {
    const run = await opts.exec({ ...built.call, evaluation: true });
    const untrusted = built.untrusted ?? untrustedOf(t);
    const fin = finalize(run, sources, untrusted);
    const raw = run.output as Record<string, unknown>;
    const shown = fin.output as Record<string, unknown>;
    const det = scoreOutput(agent, raw, shown, {
      idea: t,
      sources,
      locale: built.call.locale ?? localeOf(t),
      warnings: fin.warnings,
      topics: opts.settings.topics,
      context: built.context,
    });
    const hardFailed = det.checks.some((c) => c.hard && c.value < 1);
    let judge: number | null = null;
    let judgeIssues: string[] | undefined;
    let cost = run.costEur;
    const j = opts.judge;
    if (j?.enabled && !hardFailed && judged.n < j.maxCasesPerAgent && js.spentEur < j.maxCostEurPerRun) {
      try {
        const jr = await opts.exec({ ...judgeCall(agent, factsOf(t), shown, sources, built.call.locale ?? localeOf(t)), evaluation: true });
        judge = judgeScore(agent, jr.output);
        judgeIssues = jr.output.issues.slice(0, 5);
        js.spentEur += jr.costEur;
        cost += jr.costEur;
        judged.n++;
      } catch (err) {
        if (err instanceof AiError && HARD_STOP.includes(err.code ?? '')) throw err;
        judgeIssues = [refText('aigw.err.judgeFailed', { error: (err as Error).message })];
      }
    }
    const score = combinedScore(det.score, judge, j?.weight ?? 0, hardFailed);
    const notes = det.checks.filter((c) => c.value < 1 && c.note).map((c) => c.note);
    return {
      caseId: t.id,
      score,
      deterministic: det.score,
      judge,
      checks: det.checks,
      failed: det.failed,
      costEur: cost,
      servedBy: run.servedBy ?? null,
      ...(notes.length ? { note: notes.slice(0, 3).join('; ') } : {}),
      ...(judgeIssues ? { judgeIssues } : {}),
    };
  } catch (err) {
    // Keeping a confidential idea from an external model is the expected behaviour.
    if (err instanceof AiError && err.code === 'AI_CONFIDENTIAL' && t.confidential) {
      return {
        caseId: t.id,
        score: 1,
        deterministic: 1,
        judge: null,
        checks: [{ id: 'confidential.blocked', value: 1, weight: 1 }],
        failed: [],
        blocked: true,
        costEur: 0,
        note: 'vertraulich, korrekt blockiert',
      };
    }
    if (err instanceof AiError && HARD_STOP.includes(err.code ?? '')) throw err;
    return {
      caseId: t.id,
      score: 0,
      deterministic: 0,
      judge: null,
      checks: [{ id: 'call', value: 0, weight: 1, note: (err as Error).message }],
      failed: ['call'],
      costEur: 0,
      note: (err as Error).message,
    };
  }
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const mean = (xs: number[]) => (xs.length ? round3(xs.reduce((s, x) => s + x, 0) / xs.length) : 0);

/** Agents that a run evaluates: with a suite, a minimum score above 0 and switched on. */
export function agentsToEvaluate(opts: Pick<EvalOptions, 'agents' | 'minScore' | 'settings'>): AgentName[] {
  return AGENTS.filter((a) => SUITES[a] && opts.minScore(a) > 0 && opts.settings.ai.agents[a]?.enabled !== false && (!opts.agents || opts.agents.includes(a)));
}

/** Runs the test set for the selected agents and scores every case. */
export async function runSuites(set: TestSet, opts: EvalOptions): Promise<Record<string, AgentResult>> {
  const out: Record<string, AgentResult> = {};
  const js: JudgeState = { spentEur: 0 };
  for (const agent of agentsToEvaluate(opts)) {
    const suite = SUITES[agent]!;
    const pool = suite.pool(set.ideas);
    const ideas = suite.sampled ? sampleCases(pool, opts.sampleSize) : pool;
    const judged = { n: 0 };
    const n = opts.concurrency ?? 1;
    let cases: CaseResult[];
    if (suite.custom) {
      cases = await mapPool(ideas, n, (t) => suite.custom!(t, opts));
    } else if (suite.whole) {
      const w = suite.whole(ideas, opts.settings);
      cases = [await modelCase(agent, w.idea, w.built, opts, judged, js)];
    } else {
      cases = await mapPool(ideas, n, (t) => modelCase(agent, t, suite.build!(t, opts.settings), opts, judged, js));
    }
    const min = opts.minScore(agent);
    const score = mean(cases.map((c) => c.score));
    const notes = cases.filter((c) => c.note && !c.blocked).map((c) => `${c.caseId}: ${c.note}`);
    out[agent] = {
      agent,
      score,
      deterministic: mean(cases.map((c) => c.deterministic)),
      minScore: min,
      passed: score >= min,
      n: cases.length,
      model: opts.modelLabel(agent),
      promptVersion: agentPromptVersion(agent),
      judged: judged.n,
      cases,
      notes,
    };
  }
  return out;
}

/** Label of an agent for reports. */
export const agentLabel = (agent: string): string => labelIn('de', agent);
