import { config } from '../config.js';
import { withSystem } from '../db/pool.js';
import { refText } from '../i18n/index.js';
import type { Role, SessionUser } from '../lib/context.js';
import { runEvaluation } from './eval.js';
import { AiError } from './gateway.js';
import { withScopes } from '../services/areas.js';
import { detachedCtx, runFullAnalysis, runShortAnalysis } from './pipeline.js';
import { runTrendDigests } from '../services/radar.js';

// Background worker for AI jobs (R2-22): picks queued jobs with FOR UPDATE SKIP LOCKED, so
// several instances can run side by side. Analyses never block the idea flow.

export interface JobRow {
  id: string;
  tenant_id: string;
  idea_id: string | null;
  kind: string;
  params: Record<string, unknown>;
  attempts: number;
  created_by: string | null;
}

const MAX_ATTEMPTS = 3;

async function actor(tenantId: string, userId: string | null): Promise<SessionUser | null> {
  if (!userId) return null;
  return withSystem(async (c) => {
    const u = (await c.query<{ id: string; email: string; display_name: string; org_unit: string | null; roles: Role[]; mfa_enabled: boolean }>(
      'SELECT id, email, display_name, org_unit, roles, mfa_enabled FROM users WHERE id = $1 AND tenant_id = $2', [userId, tenantId],
    )).rows[0];
    return u ? withScopes(c, { id: u.id, tenantId, email: u.email, displayName: u.display_name, orgUnit: u.org_unit, roles: u.roles, mfaEnabled: u.mfa_enabled }) : null;
  });
}

async function finish(job: JobRow, status: 'done' | 'failed' | 'skipped' | 'queued', error: string | null, delaySeconds = 0): Promise<void> {
  await withSystem((c) =>
    c.query(
      `UPDATE ai_jobs SET status = $2, error = $3, locked_at = NULL,
              run_after = CASE WHEN $2 = 'queued' THEN now() + make_interval(secs => $4) ELSE run_after END,
              finished_at = CASE WHEN $2 = 'queued' THEN NULL ELSE now() END
        WHERE id = $1`,
      [job.id, status, error, delaySeconds],
    ),
  );
}

export async function runJob(job: JobRow): Promise<void> {
  const ctx = await detachedCtx(job.tenant_id, await actor(job.tenant_id, job.created_by));
  try {
    switch (job.kind) {
      case 'short_analysis':
        await runShortAnalysis(ctx, job.idea_id!);
        break;
      case 'full_analysis': {
        const res = await runFullAnalysis(ctx, job.idea_id!);
        if (res.failed.length) {
          await finish(job, 'done', res.failed.map((f) => `${f.step}: ${f.error}`).join('\n'));
          return;
        }
        break;
      }
      case 'trend_digest':
        // Weekly trend hints for sponsors (R4-02), queued by the daily job.
        await runTrendDigests(ctx, { notify: true });
        break;
      case 'eval_run':
        await runEvaluation(ctx, (job.params.trigger as 'manual' | 'config_change' | 'initial') ?? 'manual');
        break;
      default:
        await finish(job, 'failed', refText('aigw.err.unknownJob', { kind: job.kind }));
        return;
    }
    await finish(job, 'done', null);
  } catch (err) {
    const message = (err as Error).message;
    if (err instanceof AiError && err.code === 'AI_EVAL_PENDING') {
      // The quality check for this configuration runs first; try again afterwards.
      await finish(job, 'queued', message, 20);
    } else if (err instanceof AiError && !err.retryable) {
      await finish(job, 'skipped', message);
    } else if (job.attempts < MAX_ATTEMPTS) {
      await finish(job, 'queued', message, 30 * 2 ** job.attempts);
    } else {
      await finish(job, 'failed', message);
    }
  }
}

/**
 * Takes the next due job. Fairness between workspaces (R2-49): evaluation runs first, then the
 * workspace whose last job started longest ago (round robin); a workspace never has more than
 * `tenantLimit` jobs running, so one busy workspace cannot block the others.
 */
export async function claimJob(tenantLimit: number): Promise<JobRow | undefined> {
  return withSystem(async (c) => {
    // Claims are serialised briefly so the per-workspace limit holds across parallel lanes.
    await c.query('SELECT pg_advisory_xact_lock(4714)');
    return (await c.query<JobRow>(
      `UPDATE ai_jobs SET status = 'running', locked_at = now(), started_at = clock_timestamp(), attempts = attempts + 1
        WHERE id = (
          SELECT q.id FROM ai_jobs q
           WHERE q.status = 'queued' AND q.run_after <= now()
             -- Suspended tenants and tenants being deleted (enterprise) get no AI work.
             AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = q.tenant_id AND t.status = 'active')
             AND (SELECT count(*) FROM ai_jobs r WHERE r.tenant_id = q.tenant_id AND r.status = 'running') < $1
           ORDER BY (q.kind = 'eval_run') DESC,
                    (SELECT max(r.started_at) FROM ai_jobs r WHERE r.tenant_id = q.tenant_id) ASC NULLS FIRST,
                    q.run_after
           FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING id, tenant_id, idea_id, kind, params, attempts, created_by`,
      [tenantLimit],
    )).rows[0];
  });
}

/** Processes up to `max` due jobs with up to `concurrency` at a time; returns how many ran. */
export async function processAiJobs(max = 10, concurrency = config.aiConcurrency, tenantLimit = config.aiTenantConcurrency): Promise<number> {
  // Jobs of a crashed worker are released again after 30 minutes.
  await withSystem((c) => c.query(`UPDATE ai_jobs SET status = 'queued', locked_at = NULL WHERE status = 'running' AND locked_at < now() - interval '30 minutes'`));
  let n = 0;
  const lane = async () => {
    // The slot is reserved before the claim, so parallel lanes never run more than `max` jobs.
    while (n < max) {
      n++;
      const job = await claimJob(tenantLimit);
      if (!job) {
        n--;
        return;
      }
      await runJob(job);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane));
  return n;
}

/** Runs queued jobs until none are left, ignoring retry delays (tests, demo seeding). */
export async function drainAiJobs(limit = 100): Promise<number> {
  let total = 0;
  for (;;) {
    await withSystem((c) => c.query(`UPDATE ai_jobs SET run_after = now() WHERE status = 'queued' AND run_after > now()`));
    const n = await processAiJobs(10, 1, 1000);
    total += n;
    if (n === 0 || total >= limit) return total;
  }
}
