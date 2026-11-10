import { hasRole, isDecider, type Ctx } from '../lib/context.js';
import { forbidden } from '../lib/errors.js';
import { m } from '../i18n/index.js';
import { findReferences, type ReferenceIdea } from '../search/references.js';
import { canEditDossier } from './elaboration.js';
import type { IdeaRow } from './workflow.js';

// Learning from closed ideas (AP-28): effort estimate from similar implemented ideas (R4-06) and
// calibration of the benefit forecasts (R4-07). Everything here is aggregated over ideas; no
// value is ever computed or shown per person. Below the thresholds (settings.learning, at least
// 5 references and 20 closed ideas) the answers say "not enough data yet" instead of numbers.

// ---------------------------------------------------------------- statistics

/** Quantile with linear interpolation; xs must be sorted ascending and not empty. */
export function quantile(xs: number[], q: number): number {
  if (xs.length === 1) return xs[0];
  const pos = (xs.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
}

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

export interface Spread {
  low: number;
  median: number;
  high: number;
  min: number;
  max: number;
}

/** Interquartile range (25th to 75th percentile) with median, minimum and maximum. */
export function spread(values: number[], digits = 2): Spread | null {
  const xs = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!xs.length) return null;
  return {
    low: round(quantile(xs, 0.25), digits),
    median: round(quantile(xs, 0.5), digits),
    high: round(quantile(xs, 0.75), digits),
    min: round(xs[0], digits),
    max: round(xs[xs.length - 1], digits),
  };
}

// ---------------------------------------------------------------- closed ideas with forecast and actual

export interface ClosedIdea {
  ideaType: 'internal' | 'product';
  ideaKind: 'idea' | 'problem';
  /** Planned benefit in euro (forecast at Gate 2). */
  plan: number;
  /** Actual benefit in euro: confirmed by controlling, else Gate 3, else at closing. */
  actual: number;
  closedAt: Date;
  estDays: number | null;
  actDays: number | null;
}

/**
 * Closed ideas of the tenant whose forecast and actual benefit are both known in euro. Counted
 * over the whole workspace (confidential ideas included), shown only in aggregates.
 */
export async function closedIdeas(ctx: Ctx): Promise<ClosedIdea[]> {
  const r = await ctx.db.query<{
    idea_type: ClosedIdea['ideaType']; idea_kind: ClosedIdea['ideaKind'] | null; plan: string; actual: string; closed_at: Date;
    est_days: string | null; act_days: string | null;
  }>(
    `SELECT * FROM (
       SELECT i.idea_type, i.idea_kind, im.closed_at,
              coalesce(i.plan_benefit_euro, ir.plan_value) AS plan,
              coalesce(CASE WHEN bc.benefit_kind IN ('euro', 'revenue') THEN bc.confirmed_value END,
                       CASE WHEN ir.done_at IS NOT NULL THEN ir.actual_value END,
                       CASE WHEN im.benefit_kind IN ('euro', 'revenue') THEN im.benefit_value END) AS actual,
              i.effort_person_days AS est_days, im.actual_effort_person_days AS act_days
         FROM ideas i
         JOIN implementations im ON im.idea_id = i.id AND im.status = 'done' AND im.closed_at IS NOT NULL
         LEFT JOIN impact_reviews ir ON ir.idea_id = i.id
         LEFT JOIN benefit_confirmations bc ON bc.idea_id = i.id
        WHERE i.status = 'completed'
     ) x WHERE x.plan > 0 AND x.actual IS NOT NULL`,
  );
  return r.rows.map((x) => ({
    ideaType: x.idea_type,
    ideaKind: x.idea_kind ?? 'idea',
    plan: Number(x.plan),
    actual: Number(x.actual),
    closedAt: x.closed_at,
    estDays: x.est_days == null ? null : Number(x.est_days),
    actDays: x.act_days == null ? null : Number(x.act_days),
  }));
}

export function quarterOf(d: Date): string {
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

const isHit = (c: ClosedIdea, tolerancePercent: number) => Math.abs(c.actual / c.plan - 1) * 100 <= tolerancePercent;
const hitRate = (rows: ClosedIdea[], tol: number) => round(rows.filter((c) => isHit(c, tol)).length / rows.length, 2);

export interface Band {
  ideaType: ClosedIdea['ideaType'];
  n: number;
  /** Ratio actual / forecast: 25th percentile, median, 75th percentile. */
  low: number;
  median: number;
  high: number;
  /** Share of forecasts within the tolerance. */
  hitRate: number;
}

function bandOf(rows: ClosedIdea[], ideaType: ClosedIdea['ideaType'], tol: number, minGroup: number): Band | null {
  const own = rows.filter((c) => c.ideaType === ideaType);
  if (own.length < minGroup) return null;
  const s = spread(own.map((c) => c.actual / c.plan))!;
  return { ideaType, n: own.length, low: s.low, median: s.median, high: s.high, hitRate: hitRate(own, tol) };
}

/** Who may see the calibration: idea management, committee, heads of department, controlling. */
export function canSeeCalibration(ctx: Ctx): boolean {
  return hasRole(ctx.user, 'triage', 'committee', 'lead', 'admin', 'controlling');
}

// ---------------------------------------------------------------- calibration report (R4-07)

export async function calibrationReport(ctx: Ctx) {
  if (!canSeeCalibration(ctx)) throw forbidden();
  const { calibrationMinClosed: minClosed, hitTolerancePercent: tol } = ctx.settings.learning;
  const minGroup = ctx.settings.minGroupSize;
  const rows = await closedIdeas(ctx);
  const head = { closed: rows.length, minClosed, minGroup, tolerancePercent: tol };
  if (rows.length < minClosed) return { ...head, enough: false as const };

  // Deviation report per quarter of closing; a quarter with fewer ideas than the minimum group
  // size shows only its count, so no single idea can be read from it.
  const byQuarter = new Map<string, ClosedIdea[]>();
  for (const c of rows) byQuarter.set(quarterOf(c.closedAt), [...(byQuarter.get(quarterOf(c.closedAt)) ?? []), c]);
  const quarters = [...byQuarter.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([quarter, list]) => {
    if (list.length < minGroup) return { quarter, n: list.length, enough: false as const };
    const plan = list.reduce((s, c) => s + c.plan, 0);
    const actual = list.reduce((s, c) => s + c.actual, 0);
    return {
      quarter,
      n: list.length,
      enough: true as const,
      plan: round(plan, 0),
      actual: round(actual, 0),
      deviationPercent: round(((actual - plan) / plan) * 100, 1),
      medianRatio: spread(list.map((c) => c.actual / c.plan))!.median,
      hitRate: hitRate(list, tol),
    };
  });

  // Correction factor per idea type and per idea type and kind: median of actual / forecast.
  // The effort factor uses the ideas with estimated and actual effort.
  const groups: { ideaType: ClosedIdea['ideaType']; ideaKind: ClosedIdea['ideaKind'] | null; list: ClosedIdea[] }[] = [];
  for (const ideaType of ['internal', 'product'] as const) {
    groups.push({ ideaType, ideaKind: null, list: rows.filter((c) => c.ideaType === ideaType) });
    for (const ideaKind of ['idea', 'problem'] as const) {
      groups.push({ ideaType, ideaKind, list: rows.filter((c) => c.ideaType === ideaType && c.ideaKind === ideaKind) });
    }
  }
  const factors = groups.filter((g) => g.list.length > 0).map(({ ideaType, ideaKind, list }) => {
    if (list.length < minGroup) return { ideaType, ideaKind, n: list.length, enough: false as const };
    const effort = list.filter((c) => c.estDays && c.actDays != null);
    return {
      ideaType,
      ideaKind,
      n: list.length,
      enough: true as const,
      factor: spread(list.map((c) => c.actual / c.plan))!.median,
      hitRate: hitRate(list, tol),
      effortFactor: effort.length >= minGroup ? spread(effort.map((c) => c.actDays! / c.estDays!))!.median : null,
      effortN: effort.length,
    };
  });

  const bands = (['internal', 'product'] as const).map((t) => bandOf(rows, t, tol, minGroup)).filter((b): b is Band => !!b);
  const all = spread(rows.map((c) => c.actual / c.plan))!;
  return {
    ...head,
    enough: true as const,
    overall: { factor: all.median, low: all.low, high: all.high, hitRate: hitRate(rows, tol) },
    quarters,
    factors,
    bands,
  };
}

// ---------------------------------------------------------------- hit band in the committee pack (R4-07)

export interface ItemCalibration {
  enough: boolean;
  band?: Band;
  /** Forecast of the idea corrected with the band: expected actual benefit in euro. */
  expected?: { low: number; median: number; high: number } | null;
}

/**
 * Adds the hit band of earlier forecasts of the same idea type to every item of a meeting
 * (Gremiumsvorlage). Below 20 closed ideas (or fewer than the minimum group size of that type)
 * the item says so instead.
 */
export async function withCalibrationBand<T extends { items: { id: string; planBenefitEuro: number | null }[] }>(ctx: Ctx, detail: T) {
  const { calibrationMinClosed: minClosed, hitTolerancePercent: tol } = ctx.settings.learning;
  const rows = await closedIdeas(ctx);
  const enough = rows.length >= minClosed;
  const types = new Map<string, ClosedIdea['ideaType']>();
  if (detail.items.length) {
    const r = await ctx.db.query<{ id: string; idea_type: ClosedIdea['ideaType'] }>('SELECT id, idea_type FROM ideas WHERE id = ANY($1::uuid[])', [
      detail.items.map((i) => i.id),
    ]);
    for (const x of r.rows) types.set(x.id, x.idea_type);
  }
  const bands = new Map<string, Band | null>();
  const bandFor = (t: ClosedIdea['ideaType']) => {
    if (!bands.has(t)) bands.set(t, enough ? bandOf(rows, t, tol, ctx.settings.minGroupSize) : null);
    return bands.get(t) ?? null;
  };
  return {
    ...detail,
    calibration: { enough, closed: rows.length, minClosed, tolerancePercent: tol },
    items: detail.items.map((item) => {
      const t = types.get(item.id);
      const band = t ? bandFor(t) : null;
      const plan = item.planBenefitEuro == null ? null : Number(item.planBenefitEuro);
      const calibration: ItemCalibration = band
        ? {
            enough: true,
            band,
            expected: plan != null ? { low: round(plan * band.low, 0), median: round(plan * band.median, 0), high: round(plan * band.high, 0) } : null,
          }
        : { enough: false };
      return { ...item, calibration };
    }),
  };
}

// ---------------------------------------------------------------- effort estimate (R4-06)

/** Mentor, authors and triage during elaboration, and everyone who decides or prepares Gate 2. */
export function canSeeEffortEstimate(ctx: Ctx, idea: IdeaRow): boolean {
  return canEditDossier(ctx, idea) || isDecider(ctx.user) || hasRole(ctx.user, 'triage', 'lead', 'mentor') || idea.mentor_id === ctx.user?.id;
}

export async function effortEstimate(ctx: Ctx, idea: IdeaRow) {
  if (!canSeeEffortEstimate(ctx, idea)) throw forbidden(m('learning.effort.forbidden'));
  const min = ctx.settings.learning.effortMinReferences;
  const references: ReferenceIdea[] = await findReferences(ctx, idea, Math.max(10, min));
  const days = references.map((r) => r.personDays).filter((x): x is number => x != null);
  const euro = references.map((r) => r.euro).filter((x): x is number => x != null);
  const enough = references.length >= min;
  return {
    enough,
    minReferences: min,
    references,
    range: enough
      ? {
          personDays: days.length >= min ? spread(days, 1) : null,
          euro: euro.length >= min ? spread(euro, 0) : null,
        }
      : null,
    own: {
      personDays: idea.effort_person_days == null ? null : Number(idea.effort_person_days),
      euro: idea.effort_euro == null ? null : Number(idea.effort_euro),
    },
  };
}
