import { PERMISSIONS, isDecider, type Ctx } from '../lib/context.js';
import { areaFilter } from './areas.js';
import { deputyOf } from './workflow.js';

// Release 2 work items for "Meine Aufgaben": mentoring (R2-01), experiments (R2-06),
// impact reviews (R2-07), committee meetings (R2-04), jury (R2-35) and success stories (R2-37).

export async function release2Tasks(ctx: Ctx) {
  const me = ctx.user!;
  const people = [me.id, ...(await deputyOf(ctx))];
  const mentoring = await ctx.db.query(
    `SELECT i.id, i.number, i.title, i.status, i.timebox_until AS "timeboxUntil" FROM ideas i
      WHERE i.mentor_id = $1 AND i.status = 'elaboration' ORDER BY i.timebox_until NULLS LAST, i.number`,
    [me.id],
  );
  const experiments = await ctx.db.query(
    `SELECT i.id, i.number, i.title, i.status, e.ends_on AS "endsOn", e.hypothesis
       FROM experiments e JOIN ideas i ON i.id = e.idea_id LEFT JOIN implementations im ON im.idea_id = i.id
      WHERE e.status = 'running' AND (e.created_by = $1 OR im.owner_id = ANY($2::uuid[])) ORDER BY e.ends_on`,
    [me.id, people],
  );
  const impactReviews = await ctx.db.query(
    `SELECT i.id, i.number, i.title, i.status, ir.due_on AS "dueOn", (ir.due_on <= $2) AS due
       FROM impact_reviews ir JOIN ideas i ON i.id = ir.idea_id
      WHERE ir.reviewer_id = ANY($1::uuid[]) AND ir.done_at IS NULL ORDER BY ir.due_on`,
    [people, ctx.today],
  );
  // Without a sponsor the deciders confirm; a committee role with a scope only for its areas (R3-29).
  const confirmParams: unknown[] = [people, isDecider(me)];
  const confirmScope = areaFilter(ctx, PERMISSIONS.decide, 'i.id', confirmParams);
  const impactConfirmations = await ctx.db.query(
    `SELECT i.id, i.number, i.title, i.status FROM impact_reviews ir JOIN ideas i ON i.id = ir.idea_id
      WHERE ir.done_at IS NOT NULL AND ir.confirmed_at IS NULL
        AND (i.sponsor_id = ANY($1::uuid[]) OR (i.sponsor_id IS NULL AND $2::boolean ${confirmScope})) ORDER BY ir.done_at`,
    confirmParams,
  );
  const stories = await ctx.db.query(
    `SELECT i.id, i.number, i.title, i.status, s.title AS "storyTitle" FROM success_stories s JOIN ideas i ON i.id = s.idea_id
      WHERE s.status = 'pending_author'
        AND (i.author_id = $1 OR i.submitted_by_id IS NOT DISTINCT FROM $1 OR EXISTS (SELECT 1 FROM idea_coauthors c WHERE c.idea_id = i.id AND c.user_id = $1))`,
    [me.id],
  );
  const jury = await ctx.db.query(
    `SELECT c.id, c.title, c.ends_on AS "endsOn",
            (SELECT count(*) FROM ideas i WHERE i.challenge_id = c.id AND i.status NOT IN ('draft', 'merged')
               AND NOT EXISTS (SELECT 1 FROM scorecards s WHERE s.idea_id = i.id AND s.user_id = $1 AND s.context = 'jury'))::int AS open
       FROM challenge_jury j JOIN challenges c ON c.id = j.challenge_id WHERE j.user_id = $1 ORDER BY c.ends_on DESC`,
    [me.id],
  );
  // Committee members with a scope see meetings with at least one idea of their areas (R3-29).
  const meetingParams: unknown[] = [ctx.today];
  const meetingScope = areaFilter(ctx, ['committee'], 'mi.idea_id', meetingParams);
  const meetings = me.roles.includes('committee')
    ? await ctx.db.query(
        `SELECT m.id, m.title, m.meets_on AS "meetsOn" FROM meetings m
          WHERE m.status = 'sent' AND m.meets_on >= $1
            ${meetingScope ? `AND EXISTS (SELECT 1 FROM meeting_items mi WHERE mi.meeting_id = m.id ${meetingScope})` : ''}
          ORDER BY m.meets_on`,
        meetingParams,
      )
    : { rows: [] };
  return {
    mentoring: mentoring.rows,
    experiments: experiments.rows,
    impactReviews: impactReviews.rows,
    impactConfirmations: impactConfirmations.rows,
    stories: stories.rows,
    jury: jury.rows.filter((j: { open: number }) => j.open > 0),
    meetings: meetings.rows,
  };
}
