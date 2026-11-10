import { z } from 'zod';
import { isTriage, isTriageEverywhere, type Ctx } from '../lib/context.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { m } from '../i18n/index.js';
import { audit } from './audit.js';
import { saveScorecard } from './elaboration.js';
import { notifyAuthors, notifyRoles } from './notify.js';
import { VISIBLE_SQL, addEvent, customFieldSchema, ideaVars, isAuthor, loadIdea, type IdeaRow } from './workflow.js';

// Challenges with own fields, teams, jury and ranking (R2-35), success stories (R2-37) and
// recognition on the success page (R2-38).
// Validation messages below are catalogue keys; the error handler resolves them (R2-50).

// ---------------------------------------------------------------- challenges (R2-35)

export const juryCriterionSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]{1,40}$/),
  label: z.string().trim().min(1).max(80),
  question: z.string().trim().max(300).default(''),
  weight: z.number().min(1).max(100),
  anchors: z.object({ 1: z.string().max(300), 3: z.string().max(300), 5: z.string().max(300) }).default({ 1: '', 3: '', 5: '' }),
});
export type JuryCriterion = z.infer<typeof juryCriterionSchema>;

const uniqueIds = (xs: { id: string }[]) => new Set(xs.map((x) => x.id)).size === xs.length;

export const challengeExtrasInput = z.object({
  customFields: z
    .array(customFieldSchema)
    .max(20)
    .refine(uniqueIds, 'recognition.uniqueFieldIds')
    .refine((fs) => fs.every((f) => f.type !== 'select' || f.options.length > 0), 'recognition.selectNeedsOption')
    .optional(),
  teamsAllowed: z.boolean().optional(),
  juryCriteria: z.array(juryCriterionSchema).max(12).refine(uniqueIds, 'recognition.uniqueCriterionIds').optional(),
});

export interface ChallengeRow {
  id: string;
  title: string;
  sponsor_id: string | null;
  starts_on: string;
  ends_on: string;
  summary: string | null;
  custom_fields: z.infer<typeof customFieldSchema>[];
  teams_allowed: boolean;
  jury_criteria: JuryCriterion[];
  ranking_published_at: Date | null;
  /** Current phase when the challenge has a phase plan (R2-52). */
  phase?: string | null;
}

export async function loadChallenge(ctx: Ctx, id: string, forUpdate = false): Promise<ChallengeRow> {
  if (!z.uuid().safeParse(id).success) throw notFound(m('recognition.challengeNotFound'));
  const r = await ctx.db.query<ChallengeRow>(`SELECT * FROM challenges WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  if (!r.rows[0]) throw notFound(m('recognition.challengeNotFound'));
  return r.rows[0];
}

/** Ended after the end date, when closed, or in the result phase of a phase plan (R2-52). */
export const challengeEnded = (ctx: Ctx, c: ChallengeRow) => c.ends_on < ctx.today || c.summary !== null || c.phase === 'result';

/** The challenge's own jury criteria, or the tenant scorecard as fallback. */
export function juryCriteria(ctx: Ctx, c: ChallengeRow): JuryCriterion[] {
  return c.jury_criteria?.length ? c.jury_criteria : ctx.settings.scorecard.criteria;
}

export async function isJury(ctx: Ctx, challengeId: string): Promise<boolean> {
  if (!ctx.user) return false;
  const r = await ctx.db.query('SELECT 1 FROM challenge_jury WHERE challenge_id = $1 AND user_id = $2', [challengeId, ctx.user.id]);
  return !!r.rowCount;
}

export const canManageChallenge = (ctx: Ctx, c: ChallengeRow) => isTriage(ctx.user) || (!!ctx.user && c.sponsor_id === ctx.user.id);

export async function updateChallengeExtras(ctx: Ctx, c: ChallengeRow, input: z.infer<typeof challengeExtrasInput>): Promise<void> {
  if (!canManageChallenge(ctx, c)) throw forbidden();
  const sets: string[] = [];
  const params: unknown[] = [c.id];
  if (input.customFields !== undefined) {
    params.push(JSON.stringify(input.customFields));
    sets.push(`custom_fields = $${params.length}`);
  }
  if (input.teamsAllowed !== undefined) {
    params.push(input.teamsAllowed);
    sets.push(`teams_allowed = $${params.length}`);
  }
  if (input.juryCriteria !== undefined) {
    params.push(JSON.stringify(input.juryCriteria));
    sets.push(`jury_criteria = $${params.length}`);
  }
  if (!sets.length) return;
  await ctx.db.query(`UPDATE challenges SET ${sets.join(', ')} WHERE id = $1`, params);
  await audit(ctx, 'challenge.update', 'challenge', c.id, null, input);
}

export async function setJury(ctx: Ctx, c: ChallengeRow, userIds: string[]): Promise<void> {
  if (!canManageChallenge(ctx, c)) throw forbidden();
  const ids = [...new Set(userIds)];
  const found = await ctx.db.query<{ id: string }>('SELECT id FROM users WHERE id = ANY($1::uuid[]) AND active', [ids]);
  if (found.rowCount !== ids.length) throw badRequest(m('recognition.personMissing'));
  await ctx.db.query('DELETE FROM challenge_jury WHERE challenge_id = $1 AND NOT (user_id = ANY($2::uuid[]))', [c.id, ids]);
  for (const id of ids) {
    await ctx.db.query('INSERT INTO challenge_jury (tenant_id, challenge_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [ctx.tenantId, c.id, id]);
  }
  await audit(ctx, 'challenge.jury', 'challenge', c.id, null, { userIds: ids });
}

export async function rateAsJury(ctx: Ctx, c: ChallengeRow, idea: IdeaRow, scores: Record<string, number>, comment: string | null): Promise<{ total: number }> {
  if (!(await isJury(ctx, c.id))) throw forbidden(m('recognition.juryOnly'));
  if (idea.challenge_id !== c.id || ['draft', 'merged'].includes(idea.status)) throw badRequest(m('recognition.notInChallenge'));
  return saveScorecard(ctx, idea, 'jury', juryCriteria(ctx, c), { scores, comment });
}

/** Jury, sponsor and triage see the ranking anytime; everyone else after the end, once the sponsor published it. */
export async function canSeeRanking(ctx: Ctx, c: ChallengeRow): Promise<boolean> {
  if (canManageChallenge(ctx, c) || (await isJury(ctx, c.id))) return true;
  return challengeEnded(ctx, c) && !!c.ranking_published_at;
}

export async function ranking(ctx: Ctx, c: ChallengeRow) {
  const r = await ctx.db.query<{ id: string; number: number; title: string; status: string; teamName: string | null; total: number | null; ratings: number }>(
    `SELECT i.id, i.number, i.title, i.status, i.team_name AS "teamName",
            (SELECT round(avg(s.total)::numeric, 2)::float FROM scorecards s WHERE s.idea_id = i.id AND s.context = 'jury') AS total,
            (SELECT count(*) FROM scorecards s WHERE s.idea_id = i.id AND s.context = 'jury')::int AS ratings
       FROM ideas i
      WHERE i.challenge_id = $3 AND i.status NOT IN ('draft', 'merged') AND ${VISIBLE_SQL}
      ORDER BY total DESC NULLS LAST, i.number`,
    [ctx.user!.id, isTriageEverywhere(ctx.user), c.id],
  );
  let rank = 0;
  return r.rows.map((x) => ({ ...x, rank: x.total == null ? null : ++rank }));
}

export async function myJuryScores(ctx: Ctx, c: ChallengeRow) {
  const r = await ctx.db.query<{ idea_id: string; scores: Record<string, number>; total: number; comment: string | null }>(
    `SELECT s.idea_id, s.scores, s.total, s.comment FROM scorecards s JOIN ideas i ON i.id = s.idea_id
      WHERE i.challenge_id = $1 AND s.user_id = $2 AND s.context = 'jury'`,
    [c.id, ctx.user!.id],
  );
  return Object.fromEntries(r.rows.map((x) => [x.idea_id, { scores: x.scores, total: x.total, comment: x.comment }]));
}

export async function publishRanking(ctx: Ctx, c: ChallengeRow): Promise<void> {
  if (!(ctx.user && (c.sponsor_id === ctx.user.id || ctx.user.roles.includes('admin')))) throw forbidden(m('recognition.rankingSponsor'));
  if (!challengeEnded(ctx, c)) throw conflict(m('recognition.rankingAfterEnd'));
  await ctx.db.query('UPDATE challenges SET ranking_published_at = coalesce(ranking_published_at, now()) WHERE id = $1', [c.id]);
  await audit(ctx, 'challenge.ranking_published', 'challenge', c.id, null, null);
}

// ---------------------------------------------------------------- success stories (R2-37)

interface StoryRow {
  id: string;
  idea_id: string;
  title: string;
  body: string;
  status: 'draft' | 'pending_author' | 'published' | 'declined';
  name_authors: boolean;
  ai_result_id: string | null;
  published_at: Date | null;
  updated_at: Date;
}

export const storyInput = z.object({
  title: z.string().trim().min(3).max(140),
  body: z.string().trim().min(20).max(10_000),
});

/**
 * Creates or updates the draft success story of a completed idea (Ideenmanagement, or AI on
 * behalf of it). Only possible while the story is a draft.
 */
export async function upsertSuccessStoryDraft(ctx: Ctx, ideaId: string, title: string, body: string, aiResultId: string | null): Promise<{ id: string }> {
  if (ctx.user && !isTriage(ctx.user)) throw forbidden(m('recognition.storyWriters'));
  const idea = await loadIdea(ctx, ideaId, true);
  if (idea.status !== 'completed') throw conflict(m('recognition.storyOnlyCompleted'), 'INVALID_STATUS');
  const existing = await ctx.db.query<StoryRow>('SELECT * FROM success_stories WHERE idea_id = $1 FOR UPDATE', [idea.id]);
  const story = existing.rows[0];
  if (story && story.status !== 'draft') throw conflict(m('recognition.storyNotDraft'), 'INVALID_STATUS');
  if (story) {
    await ctx.db.query('UPDATE success_stories SET title = $2, body = $3, ai_result_id = coalesce($4, ai_result_id), updated_at = now() WHERE id = $1', [
      story.id, title, body, aiResultId,
    ]);
    return { id: story.id };
  }
  const r = await ctx.db.query<{ id: string }>(
    'INSERT INTO success_stories (tenant_id, idea_id, title, body, ai_result_id, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [ctx.tenantId, idea.id, title, body, aiResultId, ctx.user?.id ?? null],
  );
  return { id: r.rows[0].id };
}

async function storyFor(ctx: Ctx, idea: IdeaRow, forUpdate = false): Promise<StoryRow> {
  const r = await ctx.db.query<StoryRow>(`SELECT * FROM success_stories WHERE idea_id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [idea.id]);
  if (!r.rows[0]) throw notFound(m('recognition.noStory'));
  return r.rows[0];
}

export async function successStoryView(ctx: Ctx, idea: IdeaRow) {
  const r = await ctx.db.query<StoryRow>('SELECT * FROM success_stories WHERE idea_id = $1', [idea.id]);
  const s = r.rows[0];
  const triage = isTriage(ctx.user);
  const author = isAuthor(ctx.user, idea);
  const visible = !!s && (triage || s.status === 'published' || (author && s.status !== 'draft'));
  return {
    story: visible
      ? { id: s.id, title: s.title, body: s.body, status: s.status, nameAuthors: s.name_authors, aiResultId: s.ai_result_id, publishedAt: s.published_at, updatedAt: s.updated_at }
      : null,
    can: {
      edit: triage && idea.status === 'completed' && (!s || s.status === 'draft'),
      send: triage && s?.status === 'draft',
      approve: author && s?.status === 'pending_author',
    },
  };
}

export async function sendStoryToAuthor(ctx: Ctx, idea: IdeaRow): Promise<void> {
  if (!isTriage(ctx.user)) throw forbidden();
  const s = await storyFor(ctx, idea, true);
  if (s.status !== 'draft') throw conflict(m('recognition.storyNotDraft'));
  await ctx.db.query("UPDATE success_stories SET status = 'pending_author', updated_at = now() WHERE id = $1", [s.id]);
  await notifyAuthors(ctx, idea, m('recognition.story.authorSubject', ideaVars(idea)), m('recognition.story.authorBody', { story: s.title }), 'my_ideas');
}

export async function approveStory(ctx: Ctx, idea: IdeaRow, nameAuthors: boolean): Promise<void> {
  if (!isAuthor(ctx.user, idea)) throw forbidden(m('recognition.storyApprovers'));
  const s = await storyFor(ctx, idea, true);
  if (s.status !== 'pending_author') throw conflict(m('recognition.storyNotPending'));
  await ctx.db.query(
    `UPDATE success_stories SET status = 'published', name_authors = $2, approved_by = $3, approved_at = now(), published_at = now(), updated_at = now()
      WHERE id = $1`,
    [s.id, nameAuthors, ctx.user!.id],
  );
  await addEvent(ctx, idea, 'success_story', m('recognition.event.published', { story: s.title }));
  await audit(ctx, 'success_story.publish', 'idea', idea.id, null, { storyId: s.id, nameAuthors });
  await notifyRoles(ctx, ['triage'], m('recognition.story.approvedSubject', ideaVars(idea)), m('recognition.story.approvedBody', { story: s.title }), idea.id);
}

export async function declineStory(ctx: Ctx, idea: IdeaRow): Promise<void> {
  if (!isAuthor(ctx.user, idea)) throw forbidden();
  const s = await storyFor(ctx, idea, true);
  if (s.status !== 'pending_author') throw conflict(m('recognition.storyNotPending'));
  await ctx.db.query("UPDATE success_stories SET status = 'declined', updated_at = now() WHERE id = $1", [s.id]);
  await audit(ctx, 'success_story.decline', 'idea', idea.id, null, { storyId: s.id });
  await notifyRoles(ctx, ['triage'], m('recognition.story.declinedSubject', ideaVars(idea)), m('recognition.story.declinedBody', { story: s.title }), idea.id);
}

// ---------------------------------------------------------------- success page and recognition (R2-38)

/**
 * Published stories. Authors and co-authors are named only when the story allows it, the idea is
 * not anonymous and the person has not switched off the naming in "Mein Konto".
 */
export async function publishedStories(ctx: Ctx, storyId?: string) {
  const r = await ctx.db.query<{
    id: string; title: string; body: string; publishedAt: Date; ideaId: string; number: number; ideaTitle: string; topic: string | null;
    names: string[]; benefitKind: string | null; benefitValue: number | null;
  }>(
    `SELECT s.id, s.title, s.body, s.published_at AS "publishedAt", i.id AS "ideaId", i.number, i.title AS "ideaTitle", i.topic,
            im.benefit_kind AS "benefitKind", im.benefit_value AS "benefitValue",
            CASE WHEN s.name_authors AND NOT i.anonymous THEN coalesce((
              SELECT array_agg(u.display_name ORDER BY (u.id = i.author_id) DESC, u.display_name)
                FROM users u
               WHERE (u.id = i.author_id OR u.id IN (SELECT c.user_id FROM idea_coauthors c WHERE c.idea_id = i.id))
                 AND u.show_on_success_page AND u.anonymized_at IS NULL), '{}') ELSE '{}' END AS names
       FROM success_stories s JOIN ideas i ON i.id = s.idea_id LEFT JOIN implementations im ON im.idea_id = i.id
      WHERE s.status = 'published' AND ($1::uuid IS NULL OR s.id = $1) AND NOT i.confidential
      ORDER BY s.published_at DESC LIMIT 200`,
    [storyId ?? null],
  );
  return r.rows;
}

export async function recognition(ctx: Ctx) {
  const me = ctx.user!;
  const u = await ctx.db.query<{ show: boolean }>('SELECT show_on_success_page AS show FROM users WHERE id = $1', [me.id]);
  const n = await ctx.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ideas i
      WHERE i.status = 'completed' AND (i.author_id = $1 OR EXISTS (SELECT 1 FROM idea_coauthors c WHERE c.idea_id = i.id AND c.user_id = $1))`,
    [me.id],
  );
  const stories = await ctx.db.query<{ id: string; title: string }>(
    `SELECT s.id, s.title FROM success_stories s JOIN ideas i ON i.id = s.idea_id
      WHERE s.status = 'published' AND (i.author_id = $1 OR EXISTS (SELECT 1 FROM idea_coauthors c WHERE c.idea_id = i.id AND c.user_id = $1))
      ORDER BY s.published_at DESC`,
    [me.id],
  );
  return { showOnSuccessPage: u.rows[0]?.show ?? true, implementedIdeas: n.rows[0].n, stories: stories.rows };
}

export async function setShowOnSuccessPage(ctx: Ctx, show: boolean): Promise<void> {
  await ctx.db.query('UPDATE users SET show_on_success_page = $2 WHERE id = $1', [ctx.user!.id, show]);
}
