import { withSystem, withTenant } from '../db/pool.js';
import { forwardSiem, type SiemRunResult } from '../services/siem.js';
import { purgeRateLimits } from '../lib/ratelimit.js';
import { recordRun } from '../services/ops.js';
import { buildCtx, type Ctx } from '../lib/context.js';
import { workdaysBetween } from '../lib/workdays.js';
import { m, tr } from '../i18n/index.js';
import { audit } from '../services/audit.js';
import { dispatchMail } from '../services/mailer.js';
import { dispatchChat } from '../services/chat.js';
import { notifyRoles, notifyUser } from '../services/notify.js';
import { runElaborationJobs, type ElaborationJobResult } from '../services/elaboration.js';
import { ensureMonthlySample } from '../ai/quality.js';
import { checkQualityAlarm } from '../ai/qualityDashboard.js';
import { applyRetention, type RetentionResult } from '../services/privacy.js';
import { runChallengePhases } from '../services/challenges.js';
import { checkGuarantee } from '../services/guarantee.js';
import { processWebhookDeliveries, type WebhookRunResult } from '../services/webhooks.js';
import { pollConnectors, type PollResult } from '../services/connectors.js';
import { syncEmbeddings } from '../search/similar.js';
import { generateMonthlyInvoices, runBillingJobs, type BillingJobResult } from '../services/billing.js';
import { todayIn } from '../lib/workdays.js';
import { ensureBenchmarkSnapshot } from '../services/benchmark.js';
import { enqueueWeeklyTrends } from '../services/radar.js';
import { runMetricJobs } from '../services/impactMetrics.js';
import { purgeDueTenants } from '../services/tenantLifecycle.js';
import {
  closeUnanswered,
  ideaVars,
  resubmitParked,
  type DeadlineRow,
  type IdeaRow,
} from '../services/workflow.js';

// Background rules: reminders and escalation (R1-26), closing unanswered questions,
// returning parked ideas (R1-33), overdue implementations (R1-31), response guarantee (R1-46), retention periods (R1-40)
// and mail delivery (R1-07, R1-36).

export interface JobResult {
  reminders: number;
  escalations: number;
  closed: number;
  resubmitted: number;
  overdueImplementations: number;
  mailsSent: number;
  /** Notifications delivered to Slack or Teams (R3-16). */
  chatsSent?: number;
  retention?: RetentionResult;
  /** Timebox, meeting packs, experiments and impact reviews (R2-01, R2-04, R2-06, R2-07). */
  elaboration?: ElaborationJobResult;
  /** Notices to the idea management about a missed response guarantee (R1-46). */
  guaranteeAlerts?: number;
  /** Automatic phase transitions of challenges (R2-52). */
  challengePhases?: number;
  /** Monthly sample of AI results for the mentors (R2-46). */
  aiSamples?: number;
  /** Alarm on deterioration of the AI quality, once per period (R4-08). */
  aiQualityAlarms?: number;
  /** Webhook deliveries (R3-17). */
  webhooks?: WebhookRunResult;
  siem?: SiemRunResult;
  /** Status polling of the connectors (R3-13 to R3-15). */
  connectors?: PollResult;
  /** Ideas embedded for the semantic duplicate check (R3-28); 0 without pgvector. */
  embeddings?: number;
  /** Trial reminders and end, end of the challenge package, AI quota warnings (AP-18). */
  billing?: BillingJobResult;
  /** Weekly trend hints queued for the AI worker (R4-02). */
  trendHints?: boolean;
  /** Metric values measured through connectors (R4-04). */
  metrics?: number;
}

export async function runTenantJobs(ctx: Ctx): Promise<JobResult> {
  const res: JobResult = { reminders: 0, escalations: 0, closed: 0, resubmitted: 0, overdueImplementations: 0, mailsSent: 0 };
  const { db, settings, holidays, today } = ctx;

  const open = await db.query<DeadlineRow & IdeaRow & { deadline_id: string }>(
    `SELECT d.id AS deadline_id, d.phase, d.due_on, d.reminded_at, d.escalated_at, i.*
       FROM deadlines d JOIN ideas i ON i.id = d.idea_id
      WHERE d.completed_at IS NULL AND d.paused_on IS NULL`,
  );
  for (const row of open.rows) {
    const remaining = workdaysBetween(today, row.due_on, holidays);
    const responsible = row.phase === 'gate1' ? (['triage'] as const) : (['triage', 'committee'] as const);
    if (remaining < 0 && !row.escalated_at) {
      await db.query('UPDATE deadlines SET escalated_at = now() WHERE id = $1', [row.deadline_id]);
      await notifyRoles(ctx, ['admin', ...responsible], m('jobs.overdue.subject', ideaVars(row)),
        m('jobs.overdue.body', { ...ideaVars(row), days: -remaining, date: row.due_on }), row.id, 'reminders');
      await db.query(
        `INSERT INTO idea_events (tenant_id, idea_id, kind, from_status, to_status, message) VALUES ($1, $2, 'escalation', $3, $3, $4)`,
        [ctx.tenantId, row.id, row.status, tr('de', m('jobs.event.escalated', { date: row.due_on }))],
      );
      await audit(ctx, 'deadline.escalate', 'idea', row.id, null, { phase: row.phase, due_on: row.due_on });
      res.escalations++;
    } else if (remaining >= 0 && remaining <= settings.deadlines.reminderWorkdaysBefore && !row.reminded_at) {
      await db.query('UPDATE deadlines SET reminded_at = now() WHERE id = $1', [row.deadline_id]);
      await notifyRoles(ctx, [...responsible], m('jobs.reminder.subject', ideaVars(row)),
        m('jobs.reminder.body', { ...ideaVars(row), days: remaining, date: row.due_on }), row.id, 'reminders');
      res.reminders++;
    }
  }

  const unanswered = await db.query<IdeaRow & { asked_on: string }>(
    `SELECT i.*, q.asked_on FROM ideas i JOIN questions q ON q.idea_id = i.id AND q.answer IS NULL
      WHERE i.status = 'in_question' FOR UPDATE OF i`,
  );
  for (const idea of unanswered.rows) {
    if (workdaysBetween(idea.asked_on, today, holidays) >= settings.deadlines.questionTimeoutWorkdays) {
      await closeUnanswered(ctx, idea);
      res.closed++;
    }
  }

  const parked = await db.query<IdeaRow>(
    `SELECT * FROM ideas WHERE status = 'parked' AND resubmit_on <= $1 FOR UPDATE`,
    [today],
  );
  for (const idea of parked.rows) {
    await resubmitParked(ctx, idea);
    res.resubmitted++;
  }

  const overdue = await db.query<{ id: string; owner_id: string; target_date: string; idea_id: string; number: number; title: string }>(
    `SELECT im.id, im.owner_id, im.target_date, i.id AS idea_id, i.number, i.title
       FROM implementations im JOIN ideas i ON i.id = im.idea_id
      WHERE im.status <> 'done' AND im.target_date < $1 AND im.overdue_reminded_at IS NULL
        AND i.status IN ('fast_lane', 'implementing', 'piloting', 'integrated')`,
    [today],
  );
  for (const impl of overdue.rows) {
    await db.query('UPDATE implementations SET overdue_reminded_at = now() WHERE id = $1', [impl.id]);
    await notifyUser(ctx, impl.owner_id, m('jobs.late.subject', ideaVars(impl)),
      m('jobs.late.body', { ...ideaVars(impl), date: impl.target_date }), impl.idea_id, 'reminders');
    res.overdueImplementations++;
  }

  res.elaboration = await runElaborationJobs(ctx);
  res.aiSamples = await ensureMonthlySample(ctx);
  res.aiQualityAlarms = await checkQualityAlarm(ctx);
  res.challengePhases = await runChallengePhases(ctx);
  res.guaranteeAlerts = await checkGuarantee(ctx);
  res.billing = await runBillingJobs(ctx);
  res.embeddings = await syncEmbeddings(db, ctx.tenantId, 2000);
  res.trendHints = await enqueueWeeklyTrends(ctx);

  const retention = await applyRetention(ctx);
  res.retention = retention;
  res.chatsSent = await dispatchChat(ctx);
  res.webhooks = await processWebhookDeliveries(ctx);
  // SIEM forwarding of the audit log (enterprise security); retries follow the target's backoff.
  res.siem = await forwardSiem(ctx);
  res.connectors = await pollConnectors(ctx);
  res.metrics = await runMetricJobs(ctx);
  res.mailsSent = await dispatchMail(ctx);
  return res;
}

/** Runs all rules for every tenant. An advisory lock prevents parallel runs across instances. */
export async function runAllJobs(today?: string): Promise<Record<string, JobResult> | null> {
  return recordRun('jobs', () => runLocked(today));
}

async function runLocked(today?: string): Promise<Record<string, JobResult> | null> {
  return withSystem(async (sys) => {
    const lock = await sys.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock(4712) AS ok');
    if (!lock.rows[0].ok) return null;
    await sys.query('DELETE FROM sessions WHERE expires_at < now()');
    await purgeRateLimits(sys);
    // Offboarding (enterprise): tenants whose grace period is over are deleted with a proof.
    await purgeDueTenants(sys);
    // Suspended tenants and tenants being deleted get no jobs (no mails, no deadlines).
    const tenants = await sys.query<{ id: string; slug: string }>(`SELECT id, slug FROM tenants WHERE status = 'active' ORDER BY slug`);
    const results: Record<string, JobResult> = {};
    for (const t of tenants.rows) {
      results[t.slug] = await withTenant(t.id, async (db) => runTenantJobs(await buildCtx(db, t.id, null, today)));
    }
    // Invoice drafts of the previous month (R3-05); once per month and workspace.
    await generateMonthlyInvoices(sys, today ?? todayIn('Europe/Berlin'));
    // Public benchmark (R3-40): snapshot of the last finished quarter, computed once.
    await ensureBenchmarkSnapshot(today);
    return results;
  });
}
