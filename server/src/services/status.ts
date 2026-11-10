import { config } from '../config.js';
import { withSystem } from '../db/pool.js';
import { evaluate, healthMetrics, type HealthMetrics } from './ops.js';

// Status page (R3-10): current state per component, incidents and maintenance written by the
// operator, availability history from recorded health checks. Public, so it says nothing about
// tenants, counts or internal thresholds.

export const COMPONENTS = ['api', 'jobs', 'ai', 'mail'] as const;
export type Component = (typeof COMPONENTS)[number];
export type ComponentState = 'operational' | 'degraded' | 'outage';
export type PublicState = ComponentState | 'maintenance';

const RANK: Record<PublicState, number> = { operational: 0, maintenance: 1, degraded: 2, outage: 3 };
const worst = <T extends PublicState>(a: T, b: T): T => (RANK[b] > RANK[a] ? b : a);

/** Derives the state per component from the health figures and alerts of /api/health. */
export function componentStates(m: HealthMetrics, alerts: string[] = evaluate(m).map((a) => a.key)): Record<Component, ComponentState> {
  const has = (k: string) => alerts.includes(k);
  const aiStaleSeconds = Math.max(600, 20 * config.aiWorkerSeconds);
  return {
    api: 'operational',
    jobs: has('jobs_stale') ? 'outage' : has('jobs_failed') ? 'degraded' : 'operational',
    ai: (m.aiWorker.lastRunAgeSeconds ?? 0) > aiStaleSeconds ? 'outage' : has('ai_queue') || has('ai_oldest') ? 'degraded' : 'operational',
    mail: has('outbox_backlog') || has('outbox_oldest') ? 'degraded' : 'operational',
  };
}

/**
 * Records one health check for the history; runs on the alert timer. Several instances record
 * only once per interval (advisory lock plus a check for a recent row).
 */
export async function recordStatusCheck(states?: Record<Component, ComponentState>): Promise<boolean> {
  const s = states ?? componentStates(await healthMetrics());
  return withSystem(async (c) => {
    const lock = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock(4715) AS ok');
    if (!lock.rows[0].ok) return false;
    const recent = await c.query('SELECT 1 FROM status_checks WHERE checked_at > now() - make_interval(secs => $1)', [config.alerts.checkMinutes * 30]);
    if (recent.rowCount) return false;
    await c.query('INSERT INTO status_checks (api, jobs, ai, mail) VALUES ($1, $2, $3, $4)', [s.api, s.jobs, s.ai, s.mail]);
    await c.query('DELETE FROM status_checks WHERE checked_at < now() - make_interval(days => $1)', [Math.max(config.statusHistoryDays, 90) + 31]);
    return true;
  });
}

export interface Incident {
  id: string;
  kind: 'incident' | 'maintenance';
  severity: 'minor' | 'major';
  title: string;
  body: string;
  components: Component[];
  startsAt: string;
  endsAt: string | null;
  resolvedAt: string | null;
  updatedAt: string;
}

const INCIDENT_COLUMNS = `id, kind, severity, title, body, components, starts_at AS "startsAt", ends_at AS "endsAt",
  resolved_at AS "resolvedAt", updated_at AS "updatedAt"`;

export async function listIncidents(days = 90): Promise<Incident[]> {
  return withSystem(async (c) =>
    (await c.query<Incident>(
      `SELECT ${INCIDENT_COLUMNS} FROM status_incidents
        WHERE resolved_at IS NULL OR resolved_at > now() - make_interval(days => $1)
        ORDER BY starts_at DESC LIMIT 200`,
      [days],
    )).rows,
  );
}

const isActive = (i: Incident, now: number) =>
  !i.resolvedAt && new Date(i.startsAt).getTime() <= now && (!i.endsAt || new Date(i.endsAt).getTime() > now);

export interface DayAvailability {
  date: string;
  /** Share of the day the API was reachable, in percent; null without recorded checks. */
  uptimePercent: number | null;
  /** Worst recorded state of any component that day. */
  worst: ComponentState | null;
}

/**
 * Availability per day (UTC) from the recorded checks: a check with the API reachable counts
 * as available, a missing check as unavailable. Announced maintenance is not counted, as the
 * contract says (SLA, docs/release-0/business/vertragsgrundlagen.md). Before the first check
 * there is no data.
 */
export async function availability(days = config.statusHistoryDays, now = new Date()): Promise<{ days: DayAvailability[]; uptimePercent: number | null; monthPercent: number | null }> {
  const interval = config.alerts.checkMinutes * 60_000;
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (days - 1) * 86_400_000);
  const { rows, first, maintenance } = await withSystem(async (c) => {
    const rows = (await c.query<{ day: string; checks: number; up: number; api: number; jobs: number; ai: number; mail: number }>(
      `SELECT to_char(checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS checks,
              count(*) FILTER (WHERE api <> 'outage')::int AS up,
              max(CASE api WHEN 'outage' THEN 2 WHEN 'degraded' THEN 1 ELSE 0 END)::int AS api,
              max(CASE jobs WHEN 'outage' THEN 2 WHEN 'degraded' THEN 1 ELSE 0 END)::int AS jobs,
              max(CASE ai WHEN 'outage' THEN 2 WHEN 'degraded' THEN 1 ELSE 0 END)::int AS ai,
              max(CASE mail WHEN 'outage' THEN 2 WHEN 'degraded' THEN 1 ELSE 0 END)::int AS mail
         FROM status_checks WHERE checked_at >= $1 GROUP BY 1`,
      [from],
    )).rows;
    const first = (await c.query<{ t: Date | null }>('SELECT min(checked_at) AS t FROM status_checks')).rows[0].t;
    const maintenance = (await c.query<{ s: Date; e: Date }>(
      `SELECT starts_at AS s, coalesce(resolved_at, ends_at, now()) AS e FROM status_incidents
        WHERE kind = 'maintenance' AND coalesce(resolved_at, ends_at, now()) > $1 AND starts_at < now()`,
      [from],
    )).rows;
    return { rows, first, maintenance };
  });
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const levels: ComponentState[] = ['operational', 'degraded', 'outage'];
  const out: DayAvailability[] = [];
  let totalUp = 0;
  let totalExpected = 0;
  let monthUp = 0;
  let monthExpected = 0;
  const month = now.toISOString().slice(0, 7);
  for (let i = 0; i < days; i++) {
    const start = from.getTime() + i * 86_400_000;
    const date = new Date(start).toISOString().slice(0, 10);
    const begin = Math.max(start, first ? first.getTime() : Infinity);
    const end = Math.min(start + 86_400_000, now.getTime());
    const r = byDay.get(date);
    if (!first || begin >= end) {
      out.push({ date, uptimePercent: null, worst: null });
      continue;
    }
    // Announced maintenance inside this day is taken out of the measured time.
    let maint = 0;
    for (const w of maintenance) maint += Math.max(0, Math.min(end, w.e.getTime()) - Math.max(begin, w.s.getTime()));
    const expected = Math.max(1, Math.floor((end - begin - maint) / interval));
    const up = Math.min(r?.up ?? 0, expected);
    out.push({
      date,
      uptimePercent: Math.round((up / expected) * 10_000) / 100,
      worst: r ? levels[Math.max(r.api, r.jobs, r.ai, r.mail)] : 'outage',
    });
    totalUp += up;
    totalExpected += expected;
    if (date.startsWith(month)) {
      monthUp += up;
      monthExpected += expected;
    }
  }
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 10_000) / 100 : null);
  return { days: out, uptimePercent: pct(totalUp, totalExpected), monthPercent: pct(monthUp, monthExpected) };
}

let liveCache: { at: number; states: Record<Component, ComponentState> } | null = null;

/** Current state; cached for 30 seconds so the public page cannot load the database. */
async function liveStates(): Promise<Record<Component, ComponentState>> {
  if (liveCache && Date.now() - liveCache.at < 30_000) return liveCache.states;
  const states = componentStates(await healthMetrics());
  liveCache = { at: Date.now(), states };
  return states;
}

export function resetStatusCache(): void {
  liveCache = null;
}

/** Everything the public status page shows. */
export async function publicStatus() {
  const now = Date.now();
  const live = await liveStates();
  const incidents = await listIncidents(14);
  const active = incidents.filter((i) => isActive(i, now));
  const components = COMPONENTS.map((id) => {
    let state: PublicState = live[id];
    for (const i of active.filter((x) => x.components.includes(id))) {
      state = worst(state, i.kind === 'maintenance' ? 'maintenance' : i.severity === 'major' ? 'outage' : 'degraded');
    }
    return { id, status: state };
  });
  const history = await availability();
  const strip = (i: Incident) => ({ id: i.id, kind: i.kind, severity: i.severity, title: i.title, body: i.body, components: i.components, startsAt: i.startsAt, endsAt: i.endsAt, resolvedAt: i.resolvedAt, updatedAt: i.updatedAt });
  return {
    status: components.reduce<PublicState>((acc, c) => worst(acc, c.status), 'operational'),
    updatedAt: new Date(now).toISOString(),
    components,
    active: active.map(strip),
    upcoming: incidents.filter((i) => i.kind === 'maintenance' && !i.resolvedAt && new Date(i.startsAt).getTime() > now).map(strip),
    recent: incidents.filter((i) => !isActive(i, now) && (i.resolvedAt || (i.endsAt && new Date(i.endsAt).getTime() <= now))).map(strip),
    history: { days: history.days, uptimePercent: history.uptimePercent, monthPercent: history.monthPercent, checkMinutes: config.alerts.checkMinutes },
  };
}
