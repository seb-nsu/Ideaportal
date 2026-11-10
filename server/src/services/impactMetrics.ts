import { z } from 'zod';
import { hasRole, isDecider, isTriage, type Ctx } from '../lib/context.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { cat, fmt, m, tr, type Text } from '../i18n/index.js';
import { audit } from './audit.js';
import { hasFeature, requireFeature } from './billing.js';
import { ConnectorCallError, countWithConnector } from './connectors.js';
import { fillPeriod } from './connectorKinds.js';
import { canEditDossier } from './elaboration.js';
import { withCalibrationBand } from './learning.js';
import { actsFor, addEvent, implementationOwner, loadIdea, type IdeaRow } from './workflow.js';

// Metrics before and after (R4-04): a metric is fixed at Gate 2 (name, unit, direction, source,
// baseline period). Values come from a connector query (Jira JQL, ServiceNow query, Azure DevOps
// WIQL; measured automatically by the job), from another system with an API token, or by hand.
// The comparison of the baseline with the latest after-value is the draft for the Gate 3 report.

export const METRIC_SOURCES = ['manual', 'api', 'connector'] as const;
/** Roles an API token needs to send values (like the connector status callback). */
const INBOUND_ROLES = ['implementer', 'triage', 'admin'] as const;

export interface MetricRow {
  id: string;
  tenant_id: string;
  idea_id: string;
  name: string;
  unit: string;
  direction: 'increase' | 'decrease';
  source: (typeof METRIC_SOURCES)[number];
  connector_id: string | null;
  query: string | null;
  query_table: string | null;
  baseline_from: string;
  baseline_to: string;
  interval_days: number;
  next_measure_on: string | null;
  last_measured_at: Date | null;
  last_error: string | null;
}

interface ValueRow {
  id: string;
  metric_id: string;
  period: 'baseline' | 'after';
  period_from: string | null;
  period_to: string | null;
  value: string;
  source: MetricRow['source'];
  note: string | null;
  created_at: Date;
}

// ---------------------------------------------------------------- input

const base = {
  name: z.string().trim().min(2).max(120),
  unit: z.string().trim().min(1).max(40),
  direction: z.enum(['increase', 'decrease']),
  baselineFrom: z.iso.date(),
  baselineTo: z.iso.date(),
  intervalDays: z.number().int().min(1).max(365).optional(),
};
export const metricInput = z.object({
  ...base,
  source: z.enum(METRIC_SOURCES),
  connectorId: z.uuid().nullable().optional(),
  query: z.string().trim().min(3).max(2000).nullable().optional(),
  queryTable: z.string().trim().max(80).regex(/^[A-Za-z0-9_]*$/).nullable().optional(),
});
export const metricUpdate = z.object({
  name: base.name.optional(),
  unit: base.unit.optional(),
  direction: base.direction.optional(),
  baselineFrom: base.baselineFrom.optional(),
  baselineTo: base.baselineTo.optional(),
  intervalDays: base.intervalDays,
  query: metricInput.shape.query,
  queryTable: metricInput.shape.queryTable,
});
export const valueInput = z.object({
  period: z.enum(['baseline', 'after']),
  value: z.number().min(-1e12).max(1e12),
  periodFrom: z.iso.date().optional(),
  periodTo: z.iso.date().optional(),
  note: z.string().trim().max(500).optional(),
});

// ---------------------------------------------------------------- dates

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const isoDay = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));

// ---------------------------------------------------------------- rights

/** The metric is fixed at Gate 2: while the idea is in elaboration, by mentor, authors, triage or the committee. */
export function canDefineMetrics(ctx: Ctx, idea: IdeaRow): boolean {
  return idea.status === 'elaboration' && !ctx.user?.technical && (canEditDossier(ctx, idea) || isDecider(ctx.user));
}

/** Values: triage, mentor, the implementation owner (or deputy), or an API token with an implementer, triage or admin role. */
async function canRecordValues(ctx: Ctx, idea: IdeaRow): Promise<boolean> {
  const u = ctx.user;
  if (!u) return false;
  if (u.technical) return hasRole(u, ...INBOUND_ROLES);
  if (isTriage(u) || idea.mentor_id === u.id) return true;
  const owner = await implementationOwner(ctx, idea.id);
  return !!owner && (await actsFor(ctx, owner));
}

// ---------------------------------------------------------------- reading

async function loadMetric(ctx: Ctx, ideaId: string | null, metricId: string, forUpdate = false): Promise<MetricRow> {
  if (!z.uuid().safeParse(metricId).success) throw notFound(m('learning.metric.notFound'));
  const r = await ctx.db.query<MetricRow>(`SELECT * FROM impact_metrics WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [metricId]);
  const row = r.rows[0];
  if (!row || (ideaId && row.idea_id !== ideaId)) throw notFound(m('learning.metric.notFound'));
  return row;
}

const num = (v: string | number | null | undefined) => (v == null ? null : Number(v));

export type Assessment = 'better' | 'worse' | 'same' | 'open';

/** Baseline against the latest after-value; the direction decides what is better. */
export function compare(direction: MetricRow['direction'], baseline: number | null, after: number | null) {
  if (baseline == null || after == null) return { change: null, changePercent: null, assessment: 'open' as Assessment };
  const change = after - baseline;
  const changePercent = baseline !== 0 ? Math.round((change / Math.abs(baseline)) * 1000) / 10 : null;
  const assessment: Assessment = change === 0 ? 'same' : (change > 0) === (direction === 'increase') ? 'better' : 'worse';
  return { change, changePercent, assessment };
}

function present(row: MetricRow & { connector_name?: string | null }, values: ValueRow[]) {
  const own = values.filter((v) => v.metric_id === row.id);
  const asValue = (v: ValueRow) => ({
    id: v.id, value: Number(v.value), periodFrom: v.period_from, periodTo: v.period_to, source: v.source, note: v.note, createdAt: v.created_at,
  });
  const baselines = own.filter((v) => v.period === 'baseline');
  const afters = own.filter((v) => v.period === 'after');
  const baseline = baselines.length ? asValue(baselines[baselines.length - 1]) : null;
  const after = afters.length ? asValue(afters[afters.length - 1]) : null;
  return {
    id: row.id,
    name: row.name,
    unit: row.unit,
    direction: row.direction,
    source: row.source,
    connectorId: row.connector_id,
    connectorName: row.connector_name ?? null,
    query: row.query,
    queryTable: row.query_table,
    baselineFrom: row.baseline_from,
    baselineTo: row.baseline_to,
    intervalDays: row.interval_days,
    nextMeasureOn: row.next_measure_on,
    lastMeasuredAt: row.last_measured_at,
    lastError: row.last_error,
    baseline,
    after,
    series: afters.map(asValue),
    ...compare(row.direction, baseline?.value ?? null, after?.value ?? null),
  };
}

async function metricsOf(ctx: Ctx, ideaId: string) {
  const rows = await ctx.db.query<MetricRow & { connector_name: string | null }>(
    `SELECT mt.*, c.name AS connector_name FROM impact_metrics mt LEFT JOIN connectors c ON c.id = mt.connector_id
      WHERE mt.idea_id = $1 ORDER BY mt.created_at`,
    [ideaId],
  );
  const values = await ctx.db.query<ValueRow>(
    `SELECT id, metric_id, period, to_char(period_from, 'YYYY-MM-DD') AS period_from, to_char(period_to, 'YYYY-MM-DD') AS period_to,
            value, source, note, created_at
       FROM impact_metric_values WHERE idea_id = $1 ORDER BY created_at, period_to NULLS FIRST`,
    [ideaId],
  );
  return rows.rows.map((r) => present(r, values.rows));
}

export async function listMetrics(ctx: Ctx, idea: IdeaRow) {
  const define = canDefineMetrics(ctx, idea);
  const connectorsOn = hasFeature(ctx, 'connectors');
  const connectors = define && connectorsOn
    ? (await ctx.db.query<{ id: string; name: string; kind: string; enabled: boolean }>('SELECT id, name, kind, enabled FROM connectors ORDER BY name')).rows
    : [];
  return {
    metrics: await metricsOf(ctx, idea.id),
    connectors,
    connectorsAvailable: connectorsOn,
    defaultIntervalDays: ctx.settings.learning.measureEveryDays,
    can: { define, record: await canRecordValues(ctx, idea) },
  };
}

// ---------------------------------------------------------------- defining (Gate 2)

async function checkSource(ctx: Ctx, source: MetricRow['source'], connectorId: string | null | undefined, query: string | null | undefined): Promise<void> {
  if (source !== 'connector') return;
  requireFeature(ctx, 'connectors');
  if (!connectorId || !query) throw badRequest(m('learning.metric.connectorNeeded'));
  const c = await ctx.db.query('SELECT 1 FROM connectors WHERE id = $1', [connectorId]);
  if (!c.rowCount) throw notFound(m('conn.notFound'));
}

function checkPeriod(from: string, to: string): void {
  if (to < from) throw badRequest(m('learning.metric.period'));
  if (daysBetween(from, to) > 366) throw badRequest(m('learning.metric.periodLong'));
}

export async function createMetric(ctx: Ctx, idea: IdeaRow, input: z.infer<typeof metricInput>): Promise<{ id: string }> {
  if (!canDefineMetrics(ctx, idea)) throw forbidden(m('learning.metric.defineOnlyGate2'));
  checkPeriod(input.baselineFrom, input.baselineTo);
  await checkSource(ctx, input.source, input.connectorId, input.query);
  const connector = input.source === 'connector';
  const r = await ctx.db.query<{ id: string }>(
    `INSERT INTO impact_metrics (tenant_id, idea_id, name, unit, direction, source, connector_id, query, query_table,
       baseline_from, baseline_to, interval_days, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
    [ctx.tenantId, idea.id, input.name, input.unit, input.direction, input.source, connector ? input.connectorId : null,
     connector ? input.query : null, connector ? input.queryTable || null : null, input.baselineFrom, input.baselineTo,
     input.intervalDays ?? ctx.settings.learning.measureEveryDays, ctx.user!.id],
  );
  await audit(ctx, 'impact_metric.create', 'idea', idea.id, null, { metricId: r.rows[0].id, ...input });
  await addEvent(ctx, idea, 'impact_metric', m('learning.event.defined', { name: input.name, unit: input.unit }));
  return { id: r.rows[0].id };
}

export async function updateMetric(ctx: Ctx, idea: IdeaRow, metricId: string, input: z.infer<typeof metricUpdate>): Promise<void> {
  if (!canDefineMetrics(ctx, idea)) throw forbidden(m('learning.metric.defineOnlyGate2'));
  const mt = await loadMetric(ctx, idea.id, metricId, true);
  const from = input.baselineFrom ?? mt.baseline_from;
  const to = input.baselineTo ?? mt.baseline_to;
  checkPeriod(from, to);
  const query = input.query === undefined ? mt.query : input.query;
  if (mt.source === 'connector' && !query) throw badRequest(m('learning.metric.connectorNeeded'));
  await ctx.db.query(
    `UPDATE impact_metrics SET name = $2, unit = $3, direction = $4, baseline_from = $5, baseline_to = $6, interval_days = $7,
       query = $8, query_table = $9, updated_at = now() WHERE id = $1`,
    [mt.id, input.name ?? mt.name, input.unit ?? mt.unit, input.direction ?? mt.direction, from, to, input.intervalDays ?? mt.interval_days,
     mt.source === 'connector' ? query : null, mt.source === 'connector' ? (input.queryTable === undefined ? mt.query_table : input.queryTable || null) : null],
  );
  await audit(ctx, 'impact_metric.update', 'idea', idea.id, { metricId, name: mt.name, query: mt.query }, input);
}

export async function deleteMetric(ctx: Ctx, idea: IdeaRow, metricId: string): Promise<void> {
  if (!canDefineMetrics(ctx, idea)) throw forbidden(m('learning.metric.defineOnlyGate2'));
  const mt = await loadMetric(ctx, idea.id, metricId, true);
  await ctx.db.query('DELETE FROM impact_metrics WHERE id = $1', [mt.id]);
  await audit(ctx, 'impact_metric.delete', 'idea', idea.id, { metricId, name: mt.name }, null);
}

// ---------------------------------------------------------------- values: manual and inbound API

/**
 * A value from a person or from another system (API token). Values of connector metrics come
 * from the connector only. The baseline defaults to the baseline period of the metric.
 */
export async function recordValue(ctx: Ctx, metricId: string, input: z.infer<typeof valueInput>) {
  const mt = await loadMetric(ctx, null, metricId);
  // loadIdea checks that the person (or token) may see the idea at all.
  const idea = await loadIdea(ctx, mt.idea_id);
  if (!(await canRecordValues(ctx, idea))) throw forbidden(m('learning.metric.recordForbidden'));
  if (mt.source === 'connector') throw conflict(m('learning.metric.fromConnector'), 'METRIC_FROM_CONNECTOR');
  const from = input.periodFrom ?? (input.period === 'baseline' ? mt.baseline_from : null);
  const to = input.periodTo ?? (input.period === 'baseline' ? mt.baseline_to : ctx.today);
  if (from && to && to < from) throw badRequest(m('learning.metric.period'));
  const source = ctx.user?.technical ? 'api' : 'manual';
  const r = await ctx.db.query<{ id: string }>(
    `INSERT INTO impact_metric_values (tenant_id, metric_id, idea_id, period, period_from, period_to, value, source, note, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [ctx.tenantId, mt.id, mt.idea_id, input.period, from, to, input.value, source, input.note ?? null, ctx.user!.id],
  );
  await ctx.db.query('UPDATE impact_metrics SET last_measured_at = now(), last_error = NULL WHERE id = $1', [mt.id]);
  await audit(ctx, 'impact_metric.value', 'idea', mt.idea_id, null, { metricId: mt.id, ...input, source });
  return { id: r.rows[0].id, source };
}

// ---------------------------------------------------------------- automatic measurement (connector)

interface DueRow extends MetricRow {
  closed_on: string | null;
  has_baseline: boolean;
}

/**
 * Measures one connector metric if something is due: the baseline once its period is over,
 * then an after-value every interval_days for a window as long as the baseline period, which
 * starts no earlier than the day the implementation was closed (go-live).
 */
async function measureDue(ctx: Ctx, mt: DueRow, force = false): Promise<number> {
  let measured = 0;
  const length = daysBetween(mt.baseline_from, mt.baseline_to) + 1;
  const jobs: { period: 'baseline' | 'after'; from: string; to: string }[] = [];
  if (!mt.has_baseline && mt.baseline_to < ctx.today) jobs.push({ period: 'baseline', from: mt.baseline_from, to: mt.baseline_to });
  if (mt.closed_on) {
    const to = addDays(ctx.today, -1);
    const from = addDays(to, -(length - 1));
    if (from >= mt.closed_on && (force || !mt.next_measure_on || mt.next_measure_on <= ctx.today)) jobs.push({ period: 'after', from, to });
  }
  if (!jobs.length) return 0;
  let error: string | null = null;
  for (const j of jobs) {
    try {
      const value = await countWithConnector(ctx, mt.connector_id ?? '', fillPeriod(mt.query ?? '', j.from, j.to), mt.query_table);
      await ctx.db.query(
        `INSERT INTO impact_metric_values (tenant_id, metric_id, idea_id, period, period_from, period_to, value, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'connector')`,
        [ctx.tenantId, mt.id, mt.idea_id, j.period, j.from, j.to, value],
      );
      if (j.period === 'after') {
        await ctx.db.query('UPDATE impact_metrics SET next_measure_on = $2 WHERE id = $1', [mt.id, addDays(ctx.today, mt.interval_days)]);
      }
      measured++;
    } catch (err) {
      if (!(err instanceof ConnectorCallError)) throw err;
      error = err.reason;
    }
  }
  await ctx.db.query(
    `UPDATE impact_metrics SET last_error = $2, last_measured_at = CASE WHEN $3 THEN now() ELSE last_measured_at END WHERE id = $1`,
    [mt.id, error, measured > 0],
  );
  return measured;
}

const DUE_SQL = `SELECT mt.*, to_char(mt.baseline_from, 'YYYY-MM-DD') AS baseline_from, to_char(mt.baseline_to, 'YYYY-MM-DD') AS baseline_to,
       to_char(mt.next_measure_on, 'YYYY-MM-DD') AS next_measure_on,
       to_char(im.closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS closed_on,
       EXISTS (SELECT 1 FROM impact_metric_values v WHERE v.metric_id = mt.id AND v.period = 'baseline') AS has_baseline
  FROM impact_metrics mt LEFT JOIN implementations im ON im.idea_id = mt.idea_id AND im.status = 'done'
 WHERE mt.source = 'connector' AND mt.connector_id IS NOT NULL`;

/** Background job (jobs/deadlines.ts): every connector metric with something due. */
export async function runMetricJobs(ctx: Ctx): Promise<number> {
  if (!hasFeature(ctx, 'connectors')) return 0;
  const rows = await ctx.db.query<DueRow>(
    `${DUE_SQL} AND ((mt.baseline_to < $1 AND NOT EXISTS (SELECT 1 FROM impact_metric_values v WHERE v.metric_id = mt.id AND v.period = 'baseline'))
        OR (im.closed_at IS NOT NULL AND (mt.next_measure_on IS NULL OR mt.next_measure_on <= $1)))
      ORDER BY mt.created_at LIMIT 500`,
    [ctx.today],
  );
  let n = 0;
  for (const mt of rows.rows) n += await measureDue(ctx, mt);
  return n;
}

/** "Measure now" on the idea page: what is due, and an after-value even before the interval. */
export async function measureNow(ctx: Ctx, idea: IdeaRow, metricId: string) {
  if (!canDefineMetrics(ctx, idea) && !(await canRecordValues(ctx, idea))) throw forbidden(m('learning.metric.recordForbidden'));
  requireFeature(ctx, 'connectors');
  await loadMetric(ctx, idea.id, metricId);
  const row = (await ctx.db.query<DueRow>(`${DUE_SQL} AND mt.id = $1`, [metricId])).rows[0];
  if (!row) throw conflict(m('learning.metric.notConnector'), 'METRIC_NOT_CONNECTOR');
  const measured = await measureDue(ctx, row, true);
  const after = (await ctx.db.query<{ last_error: string | null }>('SELECT last_error FROM impact_metrics WHERE id = $1', [metricId])).rows[0];
  return { measured, error: after.last_error };
}

// ---------------------------------------------------------------- report draft for Gate 3

/**
 * Draft for the impact review at Gate 3: every metric with baseline, latest after-value and
 * change, the planned and the actual benefit, and the hit band of earlier forecasts of the same
 * idea type. A draft for people; it recommends no outcome.
 */
export async function impactReport(ctx: Ctx, idea: IdeaRow) {
  const metrics = await metricsOf(ctx, idea.id);
  const impl = (await ctx.db.query<{ benefit_kind: string | null; benefit_value: string | null; closed_at: Date | null }>(
    'SELECT benefit_kind, benefit_value, closed_at FROM implementations WHERE idea_id = $1',
    [idea.id],
  )).rows[0];
  const plan = num(idea.plan_benefit_euro ?? null);
  const actual = impl && ['euro', 'revenue'].includes(impl.benefit_kind ?? '') ? num(impl.benefit_value) : null;
  const band = (await withCalibrationBand(ctx, { items: [{ id: idea.id, planBenefitEuro: plan }] })).items[0].calibration;
  const l = ctx.locale;
  const n = (v: number | null) => (v == null ? '–' : fmt.number(l, v));
  const lines: Text[] = [m('learning.report.heading', { number: idea.number, title: idea.title })];
  if (!metrics.length) lines.push(m('learning.report.noMetric'));
  for (const x of metrics) {
    lines.push(m('learning.report.metric', { name: x.name, unit: x.unit }));
    lines.push(x.baseline
      ? m('learning.report.baseline', { value: n(x.baseline.value), unit: x.unit, from: x.baseline.periodFrom ?? x.baselineFrom, to: x.baseline.periodTo ?? x.baselineTo })
      : m('learning.report.baselineMissing'));
    lines.push(x.after
      ? m('learning.report.after', { value: n(x.after.value), unit: x.unit, from: x.after.periodFrom ?? '–', to: x.after.periodTo ?? '–' })
      : m('learning.report.afterMissing'));
    if (x.assessment !== 'open') {
      lines.push(m(`learning.report.change.${x.assessment}`, {
        change: `${x.change! > 0 ? '+' : ''}${n(x.change)}`, unit: x.unit, percent: x.changePercent == null ? '–' : `${x.changePercent > 0 ? '+' : ''}${n(x.changePercent)}`,
      }));
    }
  }
  lines.push(m('learning.report.benefit', { plan: n(plan), actual: n(actual) }));
  if (band.enough && band.band) {
    lines.push(m('learning.report.band', { low: Math.round(band.band.low * 100), high: Math.round(band.band.high * 100), n: band.band.n }));
  } else {
    lines.push(m('learning.report.bandMissing'));
  }
  lines.push(m('learning.report.footer'));
  return {
    metrics,
    benefit: { plan, actual, kind: impl?.benefit_kind ?? null },
    calibration: band,
    text: tr(l, cat(lines, '\n')),
  };
}
