import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { withSystem } from '../db/pool.js';
import { sendPlatformMail } from './mailer.js';
import { m as msg, tr, type MessageKey, type Vars } from '../i18n/index.js';

// Operations (R1-05): heartbeats of the background loops, health figures and alerts by mail
// or webhook. Everything here is aggregated over all workspaces and holds no idea content.

export type LoopKind = 'jobs' | 'ai';

/** Records the start and the end of a background loop, so a silent stop shows in the health check. */
export async function recordRun<T>(kind: LoopKind, fn: () => Promise<T>): Promise<T> {
  await withSystem((c) =>
    c.query(
      `INSERT INTO job_heartbeats (kind, started_at) VALUES ($1, now())
       ON CONFLICT (kind) DO UPDATE SET started_at = now()`,
      [kind],
    ),
  );
  try {
    const result = await fn();
    await withSystem((c) => c.query('UPDATE job_heartbeats SET finished_at = now(), ok = true, runs = runs + 1 WHERE kind = $1', [kind]));
    return result;
  } catch (err) {
    await withSystem((c) => c.query('UPDATE job_heartbeats SET finished_at = now(), ok = false, runs = runs + 1, failures = failures + 1 WHERE kind = $1', [kind]));
    throw err;
  }
}

export interface HealthMetrics {
  jobs: { lastRunAgeSeconds: number | null; lastRunOk: boolean | null; failures: number };
  aiWorker: { lastRunAgeSeconds: number | null; lastRunOk: boolean | null };
  aiQueue: {
    queued: number;
    running: number;
    oldestQueuedAgeSeconds: number | null;
    failedLastHour: number;
    /** Fairness (R2-49): workspaces with waiting jobs and the longest queue of a single workspace. */
    tenantsQueued: number;
    maxQueuedPerTenant: number;
    /** Configured parallelism of this instance and per workspace. */
    concurrency: { instance: number; perTenant: number };
  };
  outbox: { pending: number; oldestPendingAgeSeconds: number | null };
}

export async function healthMetrics(): Promise<HealthMetrics> {
  return withSystem(async (c) => {
    const beats = await c.query<{ kind: string; age: number | null; ok: boolean; failures: number }>(
      `SELECT kind, extract(epoch FROM now() - finished_at)::int AS age, ok, failures::int AS failures FROM job_heartbeats`,
    );
    const beat = (k: LoopKind) => beats.rows.find((b) => b.kind === k);
    const q = (
      await c.query<{ queued: number; running: number; oldest: number | null; failed: number }>(
        `SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
                count(*) FILTER (WHERE status = 'running')::int AS running,
                extract(epoch FROM now() - min(created_at) FILTER (WHERE status = 'queued' AND run_after <= now()))::int AS oldest,
                count(*) FILTER (WHERE status = 'failed' AND finished_at > now() - interval '1 hour')::int AS failed
           FROM ai_jobs`,
      )
    ).rows[0];
    const per = (
      await c.query<{ tenants: number; max: number | null }>(
        `SELECT count(*)::int AS tenants, max(n)::int AS max
           FROM (SELECT count(*) AS n FROM ai_jobs WHERE status = 'queued' GROUP BY tenant_id) t`,
      )
    ).rows[0];
    // Mails waiting for immediate delivery; daily digests and muted categories are not a backlog.
    const o = (
      await c.query<{ pending: number; oldest: number | null }>(
        `SELECT count(*)::int AS pending, extract(epoch FROM now() - min(o.created_at))::int AS oldest
           FROM outbox o LEFT JOIN users u ON u.id = o.user_id
          WHERE o.sent_at IS NULL AND (o.user_id IS NULL OR (u.notify_email = 'immediate' AND NOT (o.category = ANY (coalesce(u.notify_muted, '{}')))))`,
      )
    ).rows[0];
    return {
      jobs: { lastRunAgeSeconds: beat('jobs')?.age ?? null, lastRunOk: beat('jobs')?.ok ?? null, failures: beat('jobs')?.failures ?? 0 },
      aiWorker: { lastRunAgeSeconds: beat('ai')?.age ?? null, lastRunOk: beat('ai')?.ok ?? null },
      aiQueue: {
        queued: q.queued, running: q.running, oldestQueuedAgeSeconds: q.oldest, failedLastHour: q.failed,
        tenantsQueued: per.tenants, maxQueuedPerTenant: per.max ?? 0,
        concurrency: { instance: config.aiConcurrency, perTenant: config.aiTenantConcurrency },
      },
      outbox: { pending: o.pending, oldestPendingAgeSeconds: o.oldest },
    };
  });
}

export interface Thresholds {
  jobMaxAgeMinutes: number;
  aiQueueMax: number;
  aiOldestMinutes: number;
  outboxMax: number;
  outboxOldestMinutes: number;
}

export const thresholds = (): Thresholds => ({
  jobMaxAgeMinutes: config.alerts.jobMaxAgeMinutes,
  aiQueueMax: config.alerts.aiQueueMax,
  aiOldestMinutes: config.alerts.aiOldestMinutes,
  outboxMax: config.alerts.outboxMax,
  outboxOldestMinutes: config.alerts.outboxOldestMinutes,
});

export interface Alert {
  key: string;
  message: string;
}

/** Compares the figures with the thresholds. Before the first run nothing counts as overdue. */
export function evaluate(m: HealthMetrics, t: Thresholds = thresholds()): Alert[] {
  const out: Alert[] = [];
  const min = (s: number | null) => (s == null ? 0 : Math.round(s / 60));
  // Operator alerts have no reader with a stored language: they are written in German.
  const text = (key: MessageKey, vars?: Vars) => tr('de', msg(key, vars));
  if (m.jobs.lastRunAgeSeconds != null && m.jobs.lastRunAgeSeconds > t.jobMaxAgeMinutes * 60) {
    out.push({ key: 'jobs_stale', message: text('ops.jobsStale', { minutes: min(m.jobs.lastRunAgeSeconds) }) });
  }
  if (m.jobs.lastRunOk === false) out.push({ key: 'jobs_failed', message: text('ops.jobsFailed') });
  if (m.aiQueue.queued > t.aiQueueMax) out.push({ key: 'ai_queue', message: text('ops.aiQueue', { count: m.aiQueue.queued, max: t.aiQueueMax }) });
  if ((m.aiQueue.oldestQueuedAgeSeconds ?? 0) > t.aiOldestMinutes * 60) {
    out.push({ key: 'ai_oldest', message: text('ops.aiOldest', { minutes: min(m.aiQueue.oldestQueuedAgeSeconds) }) });
  }
  if (m.outbox.pending > t.outboxMax) out.push({ key: 'outbox_backlog', message: text('ops.outboxBacklog', { count: m.outbox.pending, max: t.outboxMax }) });
  if ((m.outbox.oldestPendingAgeSeconds ?? 0) > t.outboxOldestMinutes * 60) {
    out.push({ key: 'outbox_oldest', message: text('ops.outboxOldest', { minutes: min(m.outbox.oldestPendingAgeSeconds) }) });
  }
  return out;
}

export interface AlertMessage {
  kind: 'raised' | 'cleared';
  alerts: Alert[];
  text: string;
}

export type AlertSender = (msg: AlertMessage) => Promise<void>;

/** Sends to every configured channel: mail to ALERT_EMAIL and JSON to ALERT_WEBHOOK_URL. */
const defaultSender: AlertSender = async (m) => {
  const tasks: Promise<unknown>[] = [];
  if (config.alerts.email) {
    tasks.push(sendPlatformMail({ to: config.alerts.email, subject: tr('de', msg(m.kind === 'raised' ? 'ops.subjectRaised' : 'ops.subjectCleared')), body: m.text }));
  }
  if (config.alerts.webhookUrl) {
    tasks.push(
      fetch(config.alerts.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // "text" works for Slack and Teams incoming webhooks; "alerts" for own tools.
        body: JSON.stringify({ text: m.text, kind: m.kind, alerts: m.alerts, instance: instanceId() }),
        signal: AbortSignal.timeout(10_000),
      }).then((r) => {
        if (!r.ok) throw new Error(`alert webhook answered ${r.status}`);
      }),
    );
  }
  const results = await Promise.allSettled(tasks);
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) throw (failed as PromiseRejectedResult).reason;
};

let sender: AlertSender = defaultSender;
/** Tests replace the channels. */
export function setAlertSender(s: AlertSender | null): void {
  sender = s ?? defaultSender;
}

const instanceId = () => createHash('sha256').update(config.publicUrl).digest('hex').slice(0, 8);

/**
 * Raises new alerts once, repeats open ones after ALERT_REPEAT_HOURS and sends an all-clear
 * when they are gone. A database lock keeps several instances from sending twice.
 */
export async function checkAlerts(metrics?: HealthMetrics): Promise<{ raised: string[]; cleared: string[]; active: string[] }> {
  const m = metrics ?? (await healthMetrics());
  const now = evaluate(m);
  const outcome = await withSystem(async (c) => {
    const lock = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock(4713) AS ok');
    if (!lock.rows[0].ok) return null;
    const open = (await c.query<{ key: string; notified_at: Date | null }>('SELECT key, notified_at FROM ops_alerts WHERE active')).rows;
    const raise: Alert[] = [];
    for (const a of now) {
      const existing = open.find((o) => o.key === a.key);
      const repeat = existing?.notified_at && Date.now() - existing.notified_at.getTime() > config.alerts.repeatHours * 3600_000;
      if (!existing || !existing.notified_at || repeat) raise.push(a);
      await c.query(
        `INSERT INTO ops_alerts (key, message, active, raised_at, cleared_at) VALUES ($1, $2, true, now(), NULL)
         ON CONFLICT (key) DO UPDATE SET message = EXCLUDED.message, active = true, cleared_at = NULL,
           raised_at = CASE WHEN ops_alerts.active THEN ops_alerts.raised_at ELSE now() END`,
        [a.key, a.message],
      );
    }
    const clear = open.filter((o) => !now.some((a) => a.key === o.key)).map((o) => o.key);
    if (clear.length) await c.query('UPDATE ops_alerts SET active = false, cleared_at = now() WHERE key = ANY ($1)', [clear]);
    return { raise, clear };
  });
  if (!outcome) return { raised: [], cleared: [], active: now.map((a) => a.key) };
  const configured = !!(config.alerts.email || config.alerts.webhookUrl) || sender !== defaultSender;
  if (configured && outcome.raise.length) {
    await sender({ kind: 'raised', alerts: outcome.raise, text: tr('de', msg('ops.raisedText', { alerts: outcome.raise.map((a) => a.message).join(' '), url: `${config.publicUrl}/api/health` })) });
    await withSystem((c) => c.query('UPDATE ops_alerts SET notified_at = now() WHERE key = ANY ($1)', [outcome.raise.map((a) => a.key)]));
  }
  if (configured && outcome.clear.length) {
    await sender({ kind: 'cleared', alerts: outcome.clear.map((key) => ({ key, message: '' })), text: tr('de', msg('ops.clearedText', { keys: outcome.clear.join(', ') })) });
  }
  return { raised: outcome.raise.map((a) => a.key), cleared: outcome.clear, active: now.map((a) => a.key) };
}
