import { m, trAll, type Text } from '../i18n/index.js';
import type { Ctx, Role } from '../lib/context.js';

// Notifications are written to an outbox: it is the in-app inbox and the e-mail queue
// at the same time (R1-07, R1-36). Work items ("tasks", "reminders") of absent people go
// to their deputy (R1-11); personal messages about one's own ideas never do.

// trends: weekly trend hints for sponsors (R4-02); muting it unsubscribes them completely.
export const CATEGORIES = ['my_ideas', 'community', 'tasks', 'reminders', 'trends'] as const;
export type Category = (typeof CATEGORIES)[number];

async function deliver(ctx: Ctx, recipients: string, params: unknown[], subject: Text, body: Text, ideaId: string | undefined, category: Category) {
  const redirect = category === 'tasks' || category === 'reminders';
  const n = params.length;
  await ctx.db.query(
    // External people (R3-19) never get community messages: they carry internal comments and names.
    `WITH r AS (SELECT u.id, u.display_name FROM users u WHERE u.active AND ${recipients}${category === 'community' ? ` AND NOT ('external' = ANY(u.roles))` : ''}),
     t AS (
       SELECT r.id AS original, coalesce(a.deputy_id, r.id) AS target,
              CASE WHEN a.deputy_id IS NULL THEN NULL ELSE r.display_name END AS for_name
         FROM r LEFT JOIN LATERAL (
           SELECT deputy_id FROM absences a
            WHERE $${n + 6}::boolean AND a.user_id = r.id AND $${n + 5}::date BETWEEN a.starts_on AND a.ends_on
            ORDER BY a.created_at DESC LIMIT 1) a ON true
     )
     INSERT INTO outbox (tenant_id, user_id, to_email, subject, body, idea_id, category, on_behalf_of)
     SELECT DISTINCT ON (t.target) u.tenant_id, u.id, u.email,
            CASE WHEN t.for_name IS NULL THEN '' ELSE replace($${n + 7}::jsonb ->> u.locale, '{name}', t.for_name) END || ($${n + 1}::jsonb ->> u.locale),
            $${n + 2}::jsonb ->> u.locale, $${n + 3}, $${n + 4}, CASE WHEN t.for_name IS NULL THEN NULL ELSE t.original END
       FROM t JOIN users u ON u.id = t.target AND u.active
      ORDER BY t.target, (t.for_name IS NULL) DESC`,
    // Subject and body in every language; each recipient gets theirs (R2-50).
    [...params, JSON.stringify(trAll(subject)), JSON.stringify(trAll(body)), ideaId ?? null, category, ctx.today, redirect, JSON.stringify(trAll(m('mail.deputyPrefix', { name: '{name}' })))],
  );
}

export async function notifyUser(ctx: Ctx, userId: string, subject: Text, body: Text, ideaId?: string, category: Category = 'tasks'): Promise<void> {
  await deliver(ctx, 'u.id = $1', [userId], subject, body, ideaId, category);
}

/** A list of people, e.g. the participants of a challenge (R2-52). */
export async function notifyUsers(ctx: Ctx, userIds: string[], subject: Text, body: Text, ideaId?: string, category: Category = 'tasks'): Promise<void> {
  if (!userIds.length) return;
  await deliver(ctx, 'u.id = ANY($1::uuid[])', [userIds], subject, body, ideaId, category);
}

/**
 * Everyone with one of the roles. Roles with a scope (R3-29) count only when the idea belongs to
 * one of their areas; without an idea every holder of the role is reached.
 */
export async function notifyRoles(ctx: Ctx, roles: Role[], subject: Text, body: Text, ideaId?: string, category: Category = 'tasks'): Promise<void> {
  await deliver(
    ctx,
    `(u.roles && $1::text[] OR EXISTS (SELECT 1 FROM role_assignments ra WHERE ra.user_id = u.id AND ra.role = ANY($1::text[])
        AND ($2::uuid IS NULL OR ra.area_id = ANY(idea_area_ids($2::uuid)))))`,
    [roles, ideaId ?? null],
    subject,
    body,
    ideaId,
    category,
  );
}

/** Author, delegated submitter and co-authors of an idea (R1-15, R1-17). */
export async function notifyAuthors(
  ctx: Ctx,
  idea: { id: string; author_id: string },
  subject: Text,
  body: Text,
  category: Category = 'my_ideas',
  except?: string,
): Promise<void> {
  await deliver(
    ctx,
    `(u.id = $1 OR u.id IN (SELECT c.user_id FROM idea_coauthors c WHERE c.idea_id = $2)) AND u.id IS DISTINCT FROM $3::uuid`,
    [idea.author_id, idea.id, except ?? null],
    subject,
    body,
    idea.id,
    category,
  );
}
