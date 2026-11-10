import type { Ctx } from '../lib/context.js';
import { audit } from './audit.js';

// Data protection (R1-40): access request per person, anonymization, retention periods.

export async function personalData(ctx: Ctx, userId: string) {
  const q = async (sql: string) => (await ctx.db.query(sql, [userId])).rows;
  return {
    exportedAt: new Date().toISOString(),
    person: (await q(
      `SELECT id, email, display_name, org_unit, roles, active, mfa_enabled, notify_email, notify_muted, intros_seen, first_week_done, created_at,
              idp_managed, external_id, idp_groups, scim_name FROM users WHERE id = $1`,
    ))[0] ?? null,
    // Roles for one area only (R3-29).
    scopedRoles: await q('SELECT ra.role, a.name AS area, ra.source, ra.created_at FROM role_assignments ra JOIN areas a ON a.id = ra.area_id WHERE ra.user_id = $1'),
    ideas: await q(`SELECT id, number, title, problem, solution, benefit, topic, status, confidential, anonymous, created_at, submitted_at
                      FROM ideas WHERE author_id = $1 OR submitted_by_id = $1 ORDER BY number`),
    coauthorships: await q('SELECT idea_id, created_at FROM idea_coauthors WHERE user_id = $1'),
    comments: await q('SELECT idea_id, body, created_at FROM comments WHERE author_id = $1 ORDER BY created_at'),
    supports: await q('SELECT idea_id, created_at FROM supports WHERE user_id = $1'),
    // Own crowd ratings in challenges (R2-51); only the person sees them.
    challengeRatings: await q('SELECT challenge_id, idea_id, scores, updated_at FROM challenge_ratings WHERE user_id = $1'),
    feedback: await q('SELECT idea_id, phase, score, comment, created_at FROM feedback WHERE user_id = $1'),
    implementations: await q('SELECT idea_id, channel, target_date, progress, status FROM implementations WHERE owner_id = $1'),
    absences: await q('SELECT starts_on, ends_on, deputy_id, note FROM absences WHERE user_id = $1'),
    notifications: await q('SELECT subject, body, created_at, read_at FROM outbox WHERE user_id = $1 ORDER BY id'),
    // External participation and feature requests (R3-19, R3-20, R3-21).
    consents: await q(`SELECT t.kind, t.version, t.challenge_id, c.accepted_at FROM consents c JOIN consent_texts t ON t.id = c.consent_text_id
                        WHERE c.user_id = $1 ORDER BY c.accepted_at`),
    externalAccess: await q('SELECT challenge_id, via, created_at FROM external_access WHERE user_id = $1'),
    featureVotes: await q('SELECT request_id, created_at FROM feature_votes WHERE user_id = $1'),
    reports: await q('SELECT idea_id, comment_id, reason, note, status, created_at FROM content_reports WHERE reporter_id = $1'),
    chat: await q('SELECT channel, muted, slack_user_id, teams_aad_id, (webhook_url_enc IS NOT NULL) AS personal_webhook FROM chat_subscriptions WHERE user_id = $1'),
  };
}

/** Removes everything that identifies the person; ideas and decisions stay as history. */
export async function anonymizeUser(ctx: Ctx, userId: string): Promise<void> {
  await ctx.db.query(
    `UPDATE users SET display_name = 'Ehemalige Person', email = 'anonym-' || id || '@invalid', org_unit = NULL,
            password_hash = NULL, mfa_secret = NULL, mfa_enabled = false, reset_token_hash = NULL, reset_expires_at = NULL,
            active = false, deactivated_at = coalesce(deactivated_at, now()), anonymized_at = now(), notify_email = 'off',
            oidc_subject = NULL, external_id = NULL, idp_groups = '{}', scim_name = NULL
      WHERE id = $1 AND anonymized_at IS NULL`,
    [userId],
  );
  await ctx.db.query('DELETE FROM absences WHERE user_id = $1 OR deputy_id = $1', [userId]);
  await ctx.db.query('DELETE FROM outbox WHERE user_id = $1', [userId]);
  await ctx.db.query('DELETE FROM scim_group_members WHERE user_id = $1', [userId]); // R3-27
  await ctx.db.query('DELETE FROM chat_subscriptions WHERE user_id = $1', [userId]); // R3-16
  await ctx.db.query('DELETE FROM role_assignments WHERE user_id = $1', [userId]); // R3-29
  await audit(ctx, 'user.anonymize', 'user', userId, null, { anonymized: true });
}

export interface RetentionResult {
  ideasDeleted: number;
  notificationsDeleted: number;
  usersAnonymized: number;
  aiActionsDeleted: number;
}

export async function applyRetention(ctx: Ctx): Promise<RetentionResult> {
  const r = ctx.settings.retention;
  let ideasDeleted = 0;
  if (r.closedIdeasMonths > 0) {
    const del = await ctx.db.query(
      `DELETE FROM ideas WHERE status IN ('rejected', 'forwarded', 'closed_no_answer', 'merged')
          AND updated_at < ($1::date - make_interval(months => $2))`,
      [ctx.today, r.closedIdeasMonths],
    );
    ideasDeleted = del.rowCount ?? 0;
  }
  const notes = await ctx.db.query(
    `DELETE FROM outbox WHERE sent_at IS NOT NULL AND created_at < ($1::date - make_interval(months => $2))`,
    [ctx.today, r.notificationsMonths],
  );
  const users = await ctx.db.query<{ id: string }>(
    `SELECT id FROM users WHERE NOT active AND anonymized_at IS NULL AND deactivated_at IS NOT NULL
        AND deactivated_at < ($1::date - make_interval(days => $2))`,
    [ctx.today, r.anonymizeDeactivatedAfterDays],
  );
  for (const u of users.rows) await anonymizeUser(ctx, u.id);
  // AI log and results are subject to their own retention period (R2-10).
  const ai = await ctx.db.query(
    `DELETE FROM ai_actions WHERE created_at < ($1::date - make_interval(months => $2))`,
    [ctx.today, r.aiActionsMonths],
  );
  await ctx.db.query(
    `DELETE FROM ai_results WHERE created_at < ($1::date - make_interval(months => $2))`,
    [ctx.today, r.aiActionsMonths],
  );
  await ctx.db.query(
    `DELETE FROM ai_jobs WHERE status IN ('done', 'failed', 'skipped') AND created_at < ($1::date - make_interval(months => 1))`,
    [ctx.today],
  );
  if (ideasDeleted) await audit(ctx, 'retention.delete_ideas', 'tenant', ctx.tenantId, null, { count: ideasDeleted });
  return { ideasDeleted, notificationsDeleted: notes.rowCount ?? 0, usersAnonymized: users.rowCount ?? 0, aiActionsDeleted: ai.rowCount ?? 0 };
}
