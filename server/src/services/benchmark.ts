import { withSystem, withTenant } from '../db/pool.js';
import { resolveSettings } from '../lib/settings.js';
import { todayIn } from '../lib/workdays.js';
import type { Db } from '../db/pool.js';

// Public benchmark across workspaces (R3-40). Once per quarter the job computes four figures per
// consenting workspace (setting benchmark.share), averages them over all consenting workspaces
// and stores only the averages. Rules against conclusions about single customers:
// - only workspaces that agreed take part, and a figure appears only when at least 5 of them
//   contribute to it;
// - only the rounded mean is stored and shown (no minimum, maximum, median or value per workspace);
// - the number of workspaces is shown rounded down to a multiple of 5;
// - one snapshot per finished quarter, computed once, so figures cannot be compared day by day.

export const MIN_TENANTS = 5;
/** A workspace contributes to a figure only with at least this many cases in the quarter. */
export const MIN_CASES = 3;

export const KPIS = ['deadlineAdherence', 'cycleTimeDays', 'realizationRate', 'aiCorrectionRate'] as const;
export type Kpi = (typeof KPIS)[number];
export type TenantKpis = Record<Kpi, number | null>;

export interface Quarter {
  key: string;
  from: string;
  to: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function quarterOf(iso: string): Quarter {
  const y = Number(iso.slice(0, 4));
  const q = Math.ceil(Number(iso.slice(5, 7)) / 3);
  const m1 = (q - 1) * 3 + 1;
  const last = new Date(Date.UTC(y, m1 + 2, 0)).getUTCDate();
  return { key: `${y}-Q${q}`, from: `${y}-${pad(m1)}-01`, to: `${y}-${pad(m1 + 2)}-${pad(last)}` };
}

/** The last finished quarter before the given day. */
export function previousQuarter(today: string): Quarter {
  const d = new Date(`${quarterOf(today).from}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return quarterOf(d.toISOString().slice(0, 10));
}

const rate = (part: number, total: number) => (total >= MIN_CASES ? part / total : null);

/** The four figures of one workspace for one quarter (runs with the tenant's row-level security). */
export async function tenantKpis(db: Db, q: Quarter): Promise<TenantKpis> {
  // Deadline adherence: deadlines (Gate 1 and elaboration) completed in the quarter, share on time.
  const d = (await db.query<{ total: number; on_time: number }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE completed_at::date <= due_on)::int AS on_time
       FROM deadlines WHERE completed_at IS NOT NULL AND completed_at::date BETWEEN $1 AND $2`,
    [q.from, q.to],
  )).rows[0];
  // Cycle time: days from submission to the first Gate 1 decision, decisions in the quarter (median per workspace).
  const c = (await db.query<{ n: number; median: number | null }>(
    `WITH g1 AS (SELECT DISTINCT ON (idea_id) idea_id, decided_at FROM decisions WHERE gate = 1 ORDER BY idea_id, decided_at)
     SELECT count(*)::int AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM g1.decided_at - i.submitted_at) / 86400)::float AS median
       FROM g1 JOIN ideas i ON i.id = g1.idea_id
      WHERE i.submitted_at IS NOT NULL AND g1.decided_at >= i.submitted_at AND g1.decided_at::date BETWEEN $1 AND $2`,
    [q.from, q.to],
  )).rows[0];
  // Realisation rate: ideas decided at Gate 1 in the four quarters up to the end of this one,
  // share with a finished implementation by the end of the quarter.
  const r = (await db.query<{ total: number; done: number }>(
    `WITH g1 AS (SELECT DISTINCT ON (idea_id) idea_id, decided_at FROM decisions WHERE gate = 1 ORDER BY idea_id, decided_at)
     SELECT count(*)::int AS total,
            count(*) FILTER (WHERE im.status = 'done' AND im.closed_at::date <= $1::date)::int AS done
       FROM g1 LEFT JOIN implementations im ON im.idea_id = g1.idea_id
      WHERE g1.decided_at::date BETWEEN ($1::date - interval '1 year' + interval '1 day')::date AND $1::date`,
    [q.to],
  )).rows[0];
  // AI correction rate: AI results of the quarter in which people corrected or discarded at least one statement.
  const a = (await db.query<{ total: number; corrected: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ai_corrections k WHERE k.result_id = r.id))::int AS corrected
       FROM ai_results r WHERE r.idea_id IS NOT NULL AND r.created_at::date BETWEEN $1 AND $2`,
    [q.from, q.to],
  )).rows[0];
  return {
    deadlineAdherence: rate(d.on_time, d.total),
    cycleTimeDays: c.n >= MIN_CASES ? c.median : null,
    realizationRate: rate(r.done, r.total),
    aiCorrectionRate: rate(a.corrected, a.total),
  };
}

export interface BenchmarkFigure {
  value: number;
  unit: 'percent' | 'days';
  /** Contributing workspaces, rounded down to a multiple of 5. */
  tenants: number;
}

const bucket = (n: number) => Math.floor(n / 5) * 5;

/** Mean over the workspaces, rounded: rates in whole percent, days in whole days. Null below the minimum. */
export function aggregate(perTenant: TenantKpis[]): Record<Kpi, BenchmarkFigure | null> {
  const out = {} as Record<Kpi, BenchmarkFigure | null>;
  for (const k of KPIS) {
    const xs = perTenant.map((t) => t[k]).filter((x): x is number => x != null && Number.isFinite(x));
    if (xs.length < MIN_TENANTS) {
      out[k] = null;
      continue;
    }
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    out[k] = k === 'cycleTimeDays'
      ? { value: Math.round(mean), unit: 'days', tenants: bucket(xs.length) }
      : { value: Math.round(mean * 100), unit: 'percent', tenants: bucket(xs.length) };
  }
  return out;
}

/** Computes and stores the snapshot of the last finished quarter, once. Returns the quarter key when it was computed. */
export async function ensureBenchmarkSnapshot(today: string = todayIn('Europe/Berlin')): Promise<string | null> {
  const q = previousQuarter(today);
  const exists = await withSystem((c) => c.query('SELECT 1 FROM benchmark_snapshots WHERE quarter = $1', [q.key]));
  if (exists.rowCount) return null;
  const tenants = await withSystem((c) => c.query<{ id: string; settings: unknown }>('SELECT id, settings FROM tenants ORDER BY id'));
  const consenting = tenants.rows.filter((t) => resolveSettings(t.settings).benchmark.share);
  const perTenant: TenantKpis[] = [];
  if (consenting.length >= MIN_TENANTS) {
    for (const t of consenting) perTenant.push(await withTenant(t.id, (db) => tenantKpis(db, q)));
  }
  const kpis = consenting.length >= MIN_TENANTS ? aggregate(perTenant) : null;
  await withSystem((c) =>
    c.query(
      `INSERT INTO benchmark_snapshots (quarter, period_from, period_to, tenants_bucket, kpis) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (quarter) DO NOTHING`,
      [q.key, q.from, q.to, consenting.length >= MIN_TENANTS ? bucket(consenting.length) : 0, kpis ? JSON.stringify(kpis) : null],
    ),
  );
  return q.key;
}

/** The public page: the last four snapshots, newest first. Snapshots below the minimum carry no figures. */
export async function publicBenchmark() {
  const r = await withSystem((c) =>
    c.query<{ quarter: string; period_from: string; period_to: string; tenants_bucket: number; kpis: Record<Kpi, BenchmarkFigure | null> | null; computed_at: Date }>(
      'SELECT quarter, period_from, period_to, tenants_bucket, kpis, computed_at FROM benchmark_snapshots ORDER BY quarter DESC LIMIT 4',
    ),
  );
  return {
    minTenants: MIN_TENANTS,
    kpis: KPIS,
    quarters: r.rows.map((row) => ({
      quarter: row.quarter,
      from: row.period_from,
      to: row.period_to,
      tenants: row.kpis ? row.tenants_bucket : null,
      published: !!row.kpis,
      figures: row.kpis,
      computedAt: row.computed_at,
    })),
  };
}
