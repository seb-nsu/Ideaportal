import { m, tr, type Locale, type MessageKey, type Vars } from '../i18n/index.js';
import type { AgentResult, CaseResult } from './evalCore.js';
import { de } from '../i18n/de/index.js';

/** Localised name of an agent (falls back to the identifier). */
export function agentName(locale: Locale, agent: string): string {
  const key = `aieval.agent.${agent}`;
  return key in de ? tr(locale, m(key as MessageKey)) : agent;
}

// Eval reports and regression check (R2-12): every run is compared with the previous finished
// run of the workspace (or a baseline report in CI); the report exists as JSON (machines, CI
// artefact) and Markdown (people, audit, buyer due diligence).

/** Metric per agent as stored in ai_eval_runs.metrics. */
export interface AgentMetric {
  score: number;
  minScore: number;
  passed: boolean;
  n: number;
  notes: string[];
  deterministic?: number;
  model?: string;
  promptVersion?: string;
  judged?: number;
}

export interface CaseScore {
  agent: string;
  caseId: string;
  score: number;
  deterministic?: number;
  judge?: number | null;
  failed?: string[];
  note?: string | null;
  blocked?: boolean;
  servedBy?: string | null;
}

export interface RunData {
  id: string;
  createdAt: string;
  finishedAt?: string | null;
  trigger: string;
  status: string;
  configHash: string;
  testsetVersion: number | null;
  costEur: number;
  /** Provider and model per agent, prompt versions, judge setting. */
  config: Record<string, unknown>;
  metrics: Record<string, AgentMetric>;
  cases: CaseScore[];
}

export type AgentTrend = 'new' | 'improved' | 'unchanged' | 'regressed';

export interface Comparison {
  previousRunId: string | null;
  previousAt: string | null;
  tolerance: number;
  agents: {
    agent: string;
    score: number;
    previous: number | null;
    delta: number | null;
    passed: boolean;
    previouslyPassed: boolean | null;
    trend: AgentTrend;
    promptChanged: boolean;
    modelChanged: boolean;
  }[];
  regressions: { kind: 'agent_failed' | 'agent_drop' | 'case_drop'; agent: string; caseId?: string; before: number; after: number; delta: number }[];
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function metricsOf(results: Record<string, AgentResult>): Record<string, AgentMetric> {
  return Object.fromEntries(
    Object.entries(results).map(([k, r]) => [
      k,
      {
        score: r.score,
        deterministic: r.deterministic,
        minScore: r.minScore,
        passed: r.passed,
        n: r.n,
        model: r.model,
        promptVersion: r.promptVersion,
        judged: r.judged,
        notes: [`Modell: ${r.model}`, ...r.notes.slice(0, 20)],
      },
    ]),
  );
}

export function casesOf(results: Record<string, AgentResult>): CaseScore[] {
  return Object.values(results).flatMap((r) =>
    r.cases.map((c: CaseResult) => ({
      agent: r.agent,
      caseId: c.caseId,
      score: c.score,
      deterministic: c.deterministic,
      judge: c.judge,
      failed: c.failed,
      note: c.note ?? null,
      blocked: !!c.blocked,
      servedBy: c.servedBy ?? null,
    })),
  );
}

/** Delta per agent and the list of regressions against a previous run. */
export function compareRuns(
  current: Pick<RunData, 'metrics' | 'cases'>,
  previous: Pick<RunData, 'id' | 'createdAt' | 'metrics' | 'cases'> | null,
  tolerance: number,
): Comparison {
  const agents: Comparison['agents'] = [];
  const regressions: Comparison['regressions'] = [];
  for (const [agent, mt] of Object.entries(current.metrics)) {
    const before = previous?.metrics[agent];
    const delta = before ? round3(mt.score - before.score) : null;
    const trend: AgentTrend = !before ? 'new' : delta! < -tolerance ? 'regressed' : delta! > tolerance ? 'improved' : 'unchanged';
    agents.push({
      agent,
      score: mt.score,
      previous: before?.score ?? null,
      delta,
      passed: mt.passed,
      previouslyPassed: before ? before.passed : null,
      trend,
      promptChanged: !!before?.promptVersion && !!mt.promptVersion && before.promptVersion !== mt.promptVersion,
      modelChanged: !!before?.model && !!mt.model && before.model !== mt.model,
    });
    if (!before) continue;
    if (before.passed && !mt.passed) regressions.push({ kind: 'agent_failed', agent, before: before.score, after: mt.score, delta: delta! });
    else if (delta! < -tolerance) regressions.push({ kind: 'agent_drop', agent, before: before.score, after: mt.score, delta: delta! });
  }
  if (previous) {
    const prev = new Map(previous.cases.map((c) => [`${c.agent}/${c.caseId}`, c.score]));
    for (const c of current.cases) {
      const b = prev.get(`${c.agent}/${c.caseId}`);
      if (b != null && c.score < b - Math.max(tolerance, 0.1))
        regressions.push({ kind: 'case_drop', agent: c.agent, caseId: c.caseId, before: b, after: c.score, delta: round3(c.score - b) });
    }
  }
  const order = { agent_failed: 0, agent_drop: 1, case_drop: 2 };
  regressions.sort((a, b) => order[a.kind] - order[b.kind] || a.delta - b.delta);
  return { previousRunId: previous?.id ?? null, previousAt: previous?.createdAt ?? null, tolerance, agents, regressions };
}

export function reportJson(run: RunData, comparison: Comparison | null): Record<string, unknown> {
  const passed = Object.values(run.metrics).filter((x) => x.passed).length;
  return {
    kind: 'ideenportal-ai-eval-report',
    formatVersion: 1,
    run: {
      id: run.id,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt ?? null,
      trigger: run.trigger,
      status: run.status,
      configHash: run.configHash,
      testsetVersion: run.testsetVersion,
      costEur: run.costEur,
    },
    config: run.config,
    summary: {
      agents: Object.keys(run.metrics).length,
      passed,
      failed: Object.keys(run.metrics).length - passed,
      regressions: comparison?.regressions.length ?? 0,
    },
    metrics: run.metrics,
    comparison,
    cases: run.cases,
  };
}

const pct = (n: number | null | undefined) => (n == null ? '–' : `${Math.round(n * 100)} %`);
const signed = (n: number | null) => (n == null ? '–' : `${n > 0 ? '+' : ''}${Math.round(n * 100)}`);
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** The report for people, in the reader's language. */
export function reportMarkdown(run: RunData, comparison: Comparison | null, locale: Locale): string {
  const T = (key: MessageKey, vars?: Vars) => tr(locale, m(key, vars));
  const lines: string[] = [];
  const metrics = Object.entries(run.metrics);
  const passed = metrics.filter(([, x]) => x.passed).length;
  lines.push(`# ${T('aieval.report.title')}`, '');
  lines.push(`| ${T('aieval.report.field')} | ${T('aieval.report.value')} |`, '| --- | --- |');
  lines.push(`| ${T('aieval.report.run')} | ${run.id} |`);
  lines.push(`| ${T('aieval.report.date')} | ${run.createdAt} |`);
  lines.push(`| ${T('aieval.report.trigger')} | ${run.trigger} |`);
  lines.push(`| ${T('aieval.report.status')} | ${run.status} |`);
  lines.push(`| ${T('aieval.report.configHash')} | \`${run.configHash}\` |`);
  lines.push(`| ${T('aieval.report.testset')} | ${run.testsetVersion ?? '–'} |`);
  lines.push(`| ${T('aieval.report.cost')} | ${Number(run.costEur ?? 0).toFixed(2)} € |`);
  lines.push(`| ${T('aieval.report.result')} | ${T('aieval.report.passedOf', { passed, n: metrics.length })} |`);
  if (comparison?.previousRunId) lines.push(`| ${T('aieval.report.previous')} | ${comparison.previousRunId} (${comparison.previousAt}) |`);
  lines.push('');
  lines.push(`## ${T('aieval.report.agents')}`, '');
  lines.push(
    `| ${T('aieval.report.agent')} | ${T('aieval.report.model')} | ${T('aieval.report.prompt')} | ${T('aieval.report.cases')} | ${T('aieval.report.score')} | ${T('aieval.report.min')} | ${T('aieval.report.delta')} | ${T('aieval.report.status')} |`,
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const [agent, x] of metrics) {
    const cmp = comparison?.agents.find((a) => a.agent === agent);
    lines.push(
      `| ${cell(agentName(locale, agent))} (\`${agent}\`) | ${cell(x.model ?? '–')} | \`${x.promptVersion ?? '–'}\` | ${x.n} | ${pct(x.score)} | ${pct(x.minScore)} | ${signed(cmp?.delta ?? null)} | ${x.passed ? T('aieval.report.passed') : T('aieval.report.failed')} |`,
    );
  }
  lines.push('');
  lines.push(`## ${T('aieval.report.regressions')}`, '');
  if (!comparison?.previousRunId) lines.push(T('aieval.report.noPrevious'));
  else if (!comparison.regressions.length) lines.push(T('aieval.report.noRegressions', { tolerance: Math.round(comparison.tolerance * 100) }));
  else
    for (const r of comparison.regressions)
      lines.push(
        `- ${T(`aieval.report.regression.${r.kind}`, { agent: agentName(locale, r.agent), case: r.caseId ?? '', before: pct(r.before), after: pct(r.after) })}`,
      );
  lines.push('');
  lines.push(`## ${T('aieval.report.failedCases')}`, '');
  const weak = run.cases
    .filter((c) => c.score < 1 && !c.blocked)
    .sort((a, b) => a.score - b.score)
    .slice(0, 60);
  if (!weak.length) lines.push(T('aieval.report.allCasesFull'));
  else {
    lines.push(
      `| ${T('aieval.report.agent')} | ${T('aieval.report.case')} | ${T('aieval.report.score')} | ${T('aieval.report.checks')} |`,
      '| --- | --- | --- | --- |',
    );
    for (const c of weak) lines.push(`| \`${c.agent}\` | ${c.caseId} | ${pct(c.score)} | ${cell((c.failed ?? []).join(', ') || c.note || '–')} |`);
  }
  lines.push('', `## ${T('aieval.report.method')}`, '', T('aieval.report.methodText'), '');
  return lines.join('\n');
}
