import type { Ctx } from '../lib/context.js';
import { cat, m, type MessageKey, type Text } from '../i18n/index.js';
import { notifyRoles } from '../services/notify.js';
import { claimTexts, type Section, type Source } from './content.js';
import { kindLabel } from './quality.js';
import { sourceMetrics } from './sourcecheck.js';

// AI quality dashboard for the product owner (R4-08): hit rate, correction rate, source errors,
// failures and costs per agent and per week or month, with the history of the last twelve
// periods and an alarm on deterioration. Everything is aggregated per agent; ratings ("hilfreich?")
// only count from the minimum group size on, nothing is reported per person.

export type Granularity = 'week' | 'month';
export const PERIODS = 12;
/** Periods before the evaluated one that form the baseline of the alarm. */
export const BASELINE_PERIODS = 3;

export interface PeriodMetric {
  /** First day of the period (ISO date). */
  period: string;
  calls: number;
  errors: number;
  errorRate: number | null;
  costEur: number;
  costPerCall: number | null;
  /** Hit rate: results accepted unchanged (review "geprüft", sample "korrekt", triage lane = decision). */
  hitBase: number;
  hits: number;
  hitRate: number | null;
  /** Ratings "hilfreich?": the counts are hidden below the minimum group size. */
  ratings: number;
  helpful: number | null;
  helpfulRate: number | null;
  /** Correction rate: corrected or discarded statements per statement of the results of the period. */
  claims: number;
  corrected: number;
  correctionRate: number | null;
  /** Source errors: unreachable sources plus facts not found on the fetched page. */
  sourceChecks: number;
  sourceErrors: number;
  sourceErrorRate: number | null;
}

export const ALARM_METRICS = ['hitRate', 'helpfulRate', 'correctionRate', 'sourceErrorRate', 'errorRate', 'costPerCall'] as const;
export type AlarmMetric = (typeof ALARM_METRICS)[number];

export interface Finding {
  agent: string;
  label: string;
  metric: AlarmMetric;
  before: number;
  after: number;
}

export interface AgentSeries {
  agent: string;
  label: string;
  series: PeriodMetric[];
  /** Last finished period and the baseline before it, as compared by the alarm. */
  latest: PeriodMetric | null;
  baseline: PeriodMetric | null;
  findings: Finding[];
}

export interface Dashboard {
  granularity: Granularity;
  periods: string[];
  /** The running period (shown, but not judged). */
  current: string;
  /** The last finished period, judged by the alarm. */
  evaluated: string;
  minGroupSize: number;
  alarm: Ctx['settings']['ai']['qualityAlarm'];
  agents: AgentSeries[];
  findings: Finding[];
  alarms: { id: string; granularity: Granularity; period: string; findings: Finding[]; createdAt: string }[];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const round = (n: number, digits = 4) => Math.round(n * 10 ** digits) / 10 ** digits;
const rate = (part: number, n: number) => (n > 0 ? round(part / n, 4) : null);

/** First days of the last `n` periods up to and including the one containing `today`, oldest first. */
export function periodStarts(today: string, g: Granularity, n = PERIODS): string[] {
  const d = new Date(`${today}T12:00:00Z`);
  if (g === 'month') d.setUTCDate(1);
  else d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d);
    if (g === 'month') x.setUTCMonth(x.getUTCMonth() - i);
    else x.setUTCDate(x.getUTCDate() - 7 * i);
    out.push(iso(x));
  }
  return out;
}

/** Readable name of a period: "2026-09" or "2026-W41". */
export function periodLabel(start: string, g: Granularity): string {
  if (g === 'month') return start.slice(0, 7);
  const d = new Date(`${start}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 3);
  // The Thursday of the week decides the ISO year; its day of the year gives the week number.
  const year = d.getUTCFullYear();
  const day = Math.round((d.getTime() - Date.UTC(year, 0, 1, 12)) / 86_400_000);
  const week = Math.ceil((day + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function empty(period: string): PeriodMetric {
  return {
    period, calls: 0, errors: 0, errorRate: null, costEur: 0, costPerCall: null, hitBase: 0, hits: 0, hitRate: null,
    ratings: 0, helpful: null, helpfulRate: null, claims: 0, corrected: 0, correctionRate: null, sourceChecks: 0, sourceErrors: 0, sourceErrorRate: null,
  };
}

/** Raw counts with the helpful count always present (needed to merge periods before hiding it). */
type Raw = PeriodMetric & { helpfulRaw: number };

function finish(r: Raw, minGroup: number): PeriodMetric {
  const enough = r.ratings >= minGroup;
  const { helpfulRaw, ...rest } = r;
  return {
    ...rest,
    costEur: round(r.costEur),
    errorRate: rate(r.errors, r.calls),
    costPerCall: r.calls ? round(r.costEur / r.calls) : null,
    hitRate: rate(r.hits, r.hitBase),
    helpful: enough ? helpfulRaw : null,
    helpfulRate: enough ? rate(helpfulRaw, r.ratings) : null,
    correctionRate: rate(r.corrected, r.claims),
    sourceErrorRate: rate(r.sourceErrors, r.sourceChecks),
  };
}

function merge(period: string, rows: Raw[]): Raw {
  const out: Raw = { ...empty(period), helpfulRaw: 0 };
  for (const r of rows) {
    out.calls += r.calls;
    out.errors += r.errors;
    out.costEur += r.costEur;
    out.hitBase += r.hitBase;
    out.hits += r.hits;
    out.ratings += r.ratings;
    out.helpfulRaw += r.helpfulRaw;
    out.claims += r.claims;
    out.corrected += r.corrected;
    out.sourceChecks += r.sourceChecks;
    out.sourceErrors += r.sourceErrors;
  }
  return out;
}

/** Deterioration of the evaluated period against the baseline, per the alarm settings. */
export function compare(agent: string, label: string, last: Raw, base: Raw, cfg: Dashboard['alarm'], minGroup: number): Finding[] {
  const out: Finding[] = [];
  const pts = cfg.dropPoints / 100;
  const min = cfg.minCases;
  const push = (metric: AlarmMetric, before: number | null, after: number | null, worse: (b: number, a: number) => boolean) => {
    if (before === null || after === null) return;
    if (worse(before, after)) out.push({ agent, label, metric, before, after });
  };
  const lower = (b: number, a: number) => a <= b - pts + 1e-9;
  const higher = (b: number, a: number) => a >= b + pts - 1e-9;
  if (last.hitBase >= min && base.hitBase >= min) push('hitRate', rate(base.hits, base.hitBase), rate(last.hits, last.hitBase), lower);
  const minRatings = Math.max(min, minGroup);
  if (last.ratings >= minRatings && base.ratings >= minRatings) push('helpfulRate', rate(base.helpfulRaw, base.ratings), rate(last.helpfulRaw, last.ratings), lower);
  if (last.claims >= min && base.claims >= min) push('correctionRate', rate(base.corrected, base.claims), rate(last.corrected, last.claims), higher);
  if (last.sourceChecks >= min && base.sourceChecks >= min) push('sourceErrorRate', rate(base.sourceErrors, base.sourceChecks), rate(last.sourceErrors, last.sourceChecks), higher);
  if (last.calls >= min && base.calls >= min) {
    push('errorRate', rate(base.errors, base.calls), rate(last.errors, last.calls), higher);
    const before = base.costEur / base.calls;
    const after = last.costEur / last.calls;
    if (before > 0 && after >= before * (1 + cfg.costRisePercent / 100)) out.push({ agent, label, metric: 'costPerCall', before: round(before), after: round(after) });
  }
  return out;
}

export async function qualityDashboard(ctx: Ctx, g: Granularity): Promise<Dashboard> {
  const periods = periodStarts(ctx.today, g);
  const from = periods[0];
  const tz = ctx.settings.timezone;
  const minGroup = ctx.settings.minGroupSize;
  const cfg = ctx.settings.ai.qualityAlarm;
  const bucket = (col: string) => `date_trunc($1, ${col} AT TIME ZONE $2)::date::text`;
  const params = [g, tz, from];
  const since = (col: string) => `(${col} AT TIME ZONE $2) >= $3::date`;

  const cells = new Map<string, Map<string, Raw>>();
  const cell = (agent: string, p: string): Raw | null => {
    if (!periods.includes(p)) return null;
    let a = cells.get(agent);
    if (!a) cells.set(agent, (a = new Map()));
    let c = a.get(p);
    if (!c) a.set(p, (c = { ...empty(p), helpfulRaw: 0 }));
    return c;
  };

  // Calls, failures and costs from the AI log (only real model calls: ok, error, refused).
  const actions = await ctx.db.query<{ agent: string; p: string; calls: number; errors: number; cost: number }>(
    `SELECT agent, ${bucket('created_at')} AS p, count(*)::int AS calls,
            count(*) FILTER (WHERE status IN ('error', 'refused'))::int AS errors, coalesce(sum(cost_eur), 0)::float AS cost
       FROM ai_actions WHERE ${since('created_at')} AND status IN ('ok', 'error', 'refused') GROUP BY 1, 2`,
    params,
  );
  for (const r of actions.rows) {
    const c = cell(r.agent, r.p);
    if (!c) continue;
    c.calls += r.calls;
    c.errors += r.errors;
    c.costEur += r.cost;
  }

  // Hits: review status (R2-44) and monthly sample (R2-46) of the building blocks.
  const reviews = await ctx.db.query<{ kind: string; p: string; n: number; hits: number }>(
    `SELECT r.kind, ${bucket('v.created_at')} AS p, count(*)::int AS n, count(*) FILTER (WHERE v.status = 'checked')::int AS hits
       FROM ai_reviews v JOIN ai_results r ON r.id = v.result_id WHERE ${since('v.created_at')} GROUP BY 1, 2`,
    params,
  );
  const samples = await ctx.db.query<{ kind: string; p: string; n: number; hits: number }>(
    `SELECT r.kind, ${bucket('s.rated_at')} AS p, count(*)::int AS n, count(*) FILTER (WHERE s.verdict = 'correct')::int AS hits
       FROM ai_samples s JOIN ai_results r ON r.id = s.result_id WHERE s.verdict IS NOT NULL AND ${since('s.rated_at')} GROUP BY 1, 2`,
    params,
  );
  // Triage suggestion (R2-18): the suggested lane against the decision at Gate 1.
  const triage = await ctx.db.query<{ kind: string; p: string; n: number; hits: number }>(
    `SELECT 'triage_suggestion' AS kind, ${bucket('d.decided_at')} AS p, count(*)::int AS n,
            count(*) FILTER (WHERE s.content->'data'->>'lane' = d.outcome)::int AS hits
       FROM decisions d
       JOIN LATERAL (SELECT content FROM ai_results r WHERE r.idea_id = d.idea_id AND r.kind = 'triage_suggestion' AND r.created_at <= d.decided_at
                      ORDER BY r.version DESC LIMIT 1) s ON true
      WHERE d.gate = 1 AND ${since('d.decided_at')} GROUP BY 1, 2`,
    params,
  );
  for (const r of [...reviews.rows, ...samples.rows, ...triage.rows]) {
    const c = cell(r.kind, r.p);
    if (!c) continue;
    c.hitBase += r.n;
    c.hits += r.hits;
  }

  const ratings = await ctx.db.query<{ kind: string; p: string; n: number; helpful: number }>(
    `SELECT kind, ${bucket('created_at')} AS p, count(*)::int AS n, count(*) FILTER (WHERE helpful)::int AS helpful
       FROM ai_ratings WHERE ${since('created_at')} GROUP BY 1, 2`,
    params,
  );
  for (const r of ratings.rows) {
    const c = cell(r.kind, r.p);
    if (!c) continue;
    c.ratings += r.n;
    c.helpfulRaw += r.helpful;
  }

  // Corrections (R2-15) and source check (R2-46) from the results created in the period.
  const results = await ctx.db.query<{ kind: string; p: string; content: { sections?: Section[]; sources?: Source[] }; corrected: number }>(
    `SELECT r.kind, ${bucket('r.created_at')} AS p, r.content, (SELECT count(*)::int FROM ai_corrections k WHERE k.result_id = r.id) AS corrected
       FROM ai_results r WHERE ${since('r.created_at')}`,
    params,
  );
  const byCell = new Map<string, typeof results.rows>();
  for (const r of results.rows) {
    const c = cell(r.kind, r.p);
    if (!c) continue;
    const sections = Array.isArray(r.content?.sections) ? r.content.sections : [];
    c.claims += claimTexts(sections).length;
    c.corrected += r.corrected;
    const key = `${r.kind}|${r.p}`;
    byCell.set(key, [...(byCell.get(key) ?? []), { ...r, content: { sections, sources: Array.isArray(r.content?.sources) ? r.content.sources : [] } }]);
  }
  for (const [key, rows] of byCell) {
    const [kind, p] = key.split('|');
    const s = sourceMetrics(rows)[0];
    const c = cell(kind, p)!;
    if (!s) continue;
    c.sourceChecks += s.sourcesChecked + s.claimsChecked;
    c.sourceErrors += s.sourcesChecked - s.reachable + (s.claimsChecked - s.claimsConfirmed);
  }

  const evalIdx = periods.length - 2;
  const agents: AgentSeries[] = [...cells.keys()].sort().map((agent) => {
    const label = kindLabel(ctx.locale, agent);
    const raw = periods.map((p) => cells.get(agent)!.get(p) ?? { ...empty(p), helpfulRaw: 0 });
    const last = raw[evalIdx];
    const base = merge(periods[evalIdx - BASELINE_PERIODS], raw.slice(evalIdx - BASELINE_PERIODS, evalIdx));
    return {
      agent,
      label,
      series: raw.map((r) => finish(r, minGroup)),
      latest: finish(last, minGroup),
      baseline: finish(base, minGroup),
      findings: compare(agent, label, last, base, cfg, minGroup),
    };
  });
  const alarms = await ctx.db.query<{ id: string; granularity: Granularity; period: string; findings: Finding[]; created_at: Date }>(
    'SELECT id, granularity, period::text AS period, findings, created_at FROM ai_quality_alarms ORDER BY created_at DESC LIMIT 20',
  );
  return {
    granularity: g,
    periods,
    current: periods[periods.length - 1],
    evaluated: periods[evalIdx],
    minGroupSize: minGroup,
    alarm: cfg,
    agents,
    findings: agents.flatMap((a) => a.findings),
    alarms: alarms.rows.map((a) => ({ id: a.id, granularity: a.granularity, period: a.period, findings: a.findings, createdAt: a.created_at.toISOString() })),
  };
}

const pct = (n: number) => `${Math.round(n * 100)} %`;

function findingText(f: Finding): Text {
  const money = f.metric === 'costPerCall';
  const vars = { agent: f.label, before: money ? `${f.before.toFixed(4)} €` : pct(f.before), after: money ? `${f.after.toFixed(4)} €` : pct(f.after) };
  return m(`aiq.alarm.finding.${f.metric}` as MessageKey, vars);
}

/**
 * Daily check from the deadline job (R4-08): when the last finished period is worse than the
 * baseline, the admins get one notification. The unique key (tenant, granularity, period) makes
 * sure this happens only once per period. Returns the number of alarms raised (0 or 1).
 */
export async function checkQualityAlarm(ctx: Ctx): Promise<number> {
  const cfg = ctx.settings.ai.qualityAlarm;
  if (!cfg.enabled) return 0;
  const d = await qualityDashboard(ctx, cfg.period);
  if (!d.findings.length) return 0;
  const inserted = await ctx.db.query(
    `INSERT INTO ai_quality_alarms (tenant_id, granularity, period, findings) VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, granularity, period) DO NOTHING RETURNING id`,
    [ctx.tenantId, cfg.period, d.evaluated, JSON.stringify(d.findings)],
  );
  if (!inserted.rowCount) return 0;
  const period = periodLabel(d.evaluated, cfg.period);
  await notifyRoles(
    ctx,
    ['admin'],
    m('aiq.alarm.subject', { period }),
    cat([m('aiq.alarm.body', { period, n: d.findings.length }), ...d.findings.slice(0, 20).map(findingText), m('aiq.alarm.where')], '\n'),
    undefined,
    'tasks',
  );
  return 1;
}
