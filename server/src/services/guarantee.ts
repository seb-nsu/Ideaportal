import type { Ctx } from '../lib/context.js';
import { addWorkdays } from '../lib/workdays.js';
import { m } from '../i18n/index.js';
import { audit } from './audit.js';
import { notifyRoles } from './notify.js';

// Visible response guarantee per tenant (R1-46): "every idea gets a first response within n
// working days". The quota covers the ideas submitted in the last 90 days whose guarantee period
// has ended or that already got their response; ideas still within the period are not counted yet.
// A first response is the triage decision at Gate 1 (any lane), a question to the author or a merge.

export const GUARANTEE_WINDOW_DAYS = 90;
const RESPONSE_KINDS = ['gate1', 'question', 'merged'];

export interface GuaranteeQuota {
  enabled: boolean;
  workdays: number;
  alertBelowPercent: number;
  windowDays: number;
  /** Ideas whose guarantee period has ended or that got a response. */
  counted: number;
  /** Of those, answered in time. */
  met: number;
  /** Ideas still within the period without a response (not counted yet). */
  pending: number;
  /** Fulfilment in percent (0–100, one decimal), null without counted ideas. */
  quota: number | null;
}

export async function guaranteeQuota(ctx: Ctx): Promise<GuaranteeQuota> {
  const g = ctx.settings.guarantee;
  const rows = await ctx.db.query<{ started_on: string; responded_on: string | null }>(
    `SELECT d.started_on::text AS started_on,
            (SELECT min((e.created_at AT TIME ZONE $2)::date)::text FROM idea_events e
              WHERE e.idea_id = d.idea_id AND e.kind = ANY($3::text[])
                AND (e.created_at AT TIME ZONE $2)::date BETWEEN d.started_on AND $1::date) AS responded_on
       FROM deadlines d
      WHERE d.phase = 'gate1' AND d.started_on > $1::date - $4::int AND d.started_on <= $1::date`,
    [ctx.today, ctx.settings.timezone, RESPONSE_KINDS, GUARANTEE_WINDOW_DAYS],
  );
  let counted = 0;
  let met = 0;
  let pending = 0;
  for (const r of rows.rows) {
    const due = addWorkdays(r.started_on, g.workdays, ctx.holidays);
    if (r.responded_on) {
      counted++;
      if (r.responded_on <= due) met++;
    } else if (ctx.today > due) {
      counted++;
    } else {
      pending++;
    }
  }
  return {
    enabled: g.enabled,
    workdays: g.workdays,
    alertBelowPercent: g.alertBelowPercent,
    windowDays: GUARANTEE_WINDOW_DAYS,
    counted,
    met,
    pending,
    quota: counted ? Math.round((met / counted) * 1000) / 10 : null,
  };
}

/**
 * Daily check from the deadline job: tells the idea management (triage and admin) once when the
 * quota drops below the threshold. The notice is re-armed only after the quota has recovered.
 * Returns the number of notices sent (0 or 1).
 */
export async function checkGuarantee(ctx: Ctx): Promise<number> {
  const q = await guaranteeQuota(ctx);
  if (!q.enabled || q.quota === null) return 0;
  const state = (await ctx.db.query<{ below: boolean }>('SELECT below FROM guarantee_alerts WHERE tenant_id = $1', [ctx.tenantId])).rows[0];
  const below = q.quota < q.alertBelowPercent;
  const notify = below && !state?.below;
  await ctx.db.query(
    `INSERT INTO guarantee_alerts (tenant_id, below, quota, checked_on, alerted_at) VALUES ($1, $2, $3, $4, CASE WHEN $5::boolean THEN now() END)
     ON CONFLICT (tenant_id) DO UPDATE SET below = EXCLUDED.below, quota = EXCLUDED.quota, checked_on = EXCLUDED.checked_on,
       alerted_at = coalesce(EXCLUDED.alerted_at, guarantee_alerts.alerted_at)`,
    [ctx.tenantId, below, q.quota, ctx.today, notify],
  );
  if (!notify) return 0;
  const vars = { quota: Math.floor(q.quota), threshold: q.alertBelowPercent, met: q.met, due: q.counted, workdays: q.workdays };
  await notifyRoles(ctx, ['triage', 'admin'], m('jobs.guarantee.subject', vars), m('jobs.guarantee.body', vars), undefined, 'reminders');
  await audit(ctx, 'guarantee.alert', 'tenant', ctx.tenantId, null, vars);
  return 1;
}
