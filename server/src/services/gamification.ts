import { z } from 'zod';
import { hasRole, type Ctx } from '../lib/context.js';
import { conflict } from '../lib/errors.js';
import { m } from '../i18n/index.js';
import { audit } from './audit.js';
import { loadChallenge, type ChallengeRow } from './recognition.js';

// Gamification per challenge (R2-53): points for submitting, commenting and rating, badges and a
// leaderboard. Rules that keep it from becoming an evaluation of people:
// - points are computed from the activity of one challenge only, never across challenges;
// - the leaderboard lists only people who agreed for this challenge (opt-in, revocable);
// - nothing appears in the dashboard and there is no export per person;
// - anonymous and confidential ideas earn no points, so the leaderboard reveals nothing about them;
// - the admin switches points and badges, and separately the leaderboard, off per challenge.

export interface Activity {
  ideas: number;
  comments: number;
  ratings: number;
}

/** Badges with their rule; the labels live in the web catalogue (gamification.badge.<id>). */
export const BADGES: { id: string; earned: (a: Activity) => boolean }[] = [
  { id: 'first_idea', earned: (a) => a.ideas >= 1 },
  { id: 'three_ideas', earned: (a) => a.ideas >= 3 },
  { id: 'discussant', earned: (a) => a.comments >= 5 },
  { id: 'rater', earned: (a) => a.ratings >= 10 },
  { id: 'all_rounder', earned: (a) => a.ideas >= 1 && a.comments >= 1 && a.ratings >= 1 },
];

export const badgesOf = (a: Activity) => BADGES.filter((b) => b.earned(a)).map((b) => b.id);

export function pointsOf(ctx: Ctx, a: Activity): number {
  const p = ctx.settings.gamification;
  return a.ideas * p.pointsSubmit + a.comments * p.pointsComment + a.ratings * p.pointsRating;
}

interface GamificationRow extends ChallengeRow {
  gamification: boolean;
  leaderboard: boolean;
}

/** Activity in one challenge for the given people (author or co-author of an idea, comments, crowd ratings). */
export async function activity(ctx: Ctx, challengeId: string, userIds: string[]): Promise<Map<string, Activity>> {
  const out = new Map<string, Activity>(userIds.map((id) => [id, { ideas: 0, comments: 0, ratings: 0 }]));
  if (!userIds.length) return out;
  const r = await ctx.db.query<{ id: string } & Activity>(
    `WITH ic AS (
       SELECT i.id, i.author_id, i.anonymous, i.confidential FROM ideas i
        WHERE i.challenge_id = $1 AND i.status NOT IN ('draft', 'merged')
     ),
     sub AS (
       SELECT p.user_id, count(DISTINCT ic.id)::int AS n FROM ic
         CROSS JOIN LATERAL (SELECT ic.author_id AS user_id UNION SELECT ca.user_id FROM idea_coauthors ca WHERE ca.idea_id = ic.id) p
        WHERE NOT ic.anonymous AND NOT ic.confidential GROUP BY 1
     ),
     com AS (
       SELECT c.author_id AS user_id, count(*)::int AS n FROM comments c JOIN ic ON ic.id = c.idea_id
        WHERE NOT ic.confidential AND NOT (ic.anonymous AND c.author_id = ic.author_id) GROUP BY 1
     ),
     rat AS (
       SELECT r.user_id, count(*)::int AS n FROM challenge_ratings r JOIN ic ON ic.id = r.idea_id WHERE r.challenge_id = $1 GROUP BY 1
     )
     SELECT u.id, coalesce(sub.n, 0) AS ideas, coalesce(com.n, 0) AS comments, coalesce(rat.n, 0) AS ratings
       FROM unnest($2::uuid[]) AS u(id)
       LEFT JOIN sub ON sub.user_id = u.id LEFT JOIN com ON com.user_id = u.id LEFT JOIN rat ON rat.user_id = u.id`,
    [challengeId, userIds],
  );
  for (const row of r.rows) out.set(row.id, { ideas: row.ideas, comments: row.comments, ratings: row.ratings });
  return out;
}

async function hasConsent(ctx: Ctx, challengeId: string): Promise<boolean> {
  const r = await ctx.db.query('SELECT 1 FROM gamification_consents WHERE challenge_id = $1 AND user_id = $2', [challengeId, ctx.user!.id]);
  return !!r.rowCount;
}

/** Leaderboard of one challenge: only people with consent, ranked by points (equal points, equal rank). */
export async function leaderboard(ctx: Ctx, c: GamificationRow) {
  const consenting = await ctx.db.query<{ user_id: string; name: string }>(
    `SELECT g.user_id, u.display_name AS name FROM gamification_consents g JOIN users u ON u.id = g.user_id
      WHERE g.challenge_id = $1 AND u.active`,
    [c.id],
  );
  const acts = await activity(ctx, c.id, consenting.rows.map((r) => r.user_id));
  const rows = consenting.rows
    .map((r) => {
      const a = acts.get(r.user_id)!;
      return { name: r.name, points: pointsOf(ctx, a), badges: badgesOf(a), me: r.user_id === ctx.user!.id };
    })
    .filter((r) => r.points > 0)
    .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  let rank = 0;
  let last = -1;
  return rows.map((r, i) => {
    if (r.points !== last) rank = i + 1;
    last = r.points;
    return { rank, ...r };
  });
}

/** What the challenge page shows: own points and badges, consent, leaderboard, switches. */
export async function gamificationView(ctx: Ctx, challengeId: string) {
  const c = (await loadChallenge(ctx, challengeId)) as GamificationRow;
  const canManage = hasRole(ctx.user, 'admin');
  const points = ctx.settings.gamification;
  if (!c.gamification) return { enabled: false, leaderboardEnabled: false, canManage, points, me: null, leaderboard: null };
  const a = (await activity(ctx, c.id, [ctx.user!.id])).get(ctx.user!.id)!;
  return {
    enabled: true,
    leaderboardEnabled: c.leaderboard,
    canManage,
    points,
    me: { ...a, points: pointsOf(ctx, a), badges: badgesOf(a), consent: c.leaderboard && (await hasConsent(ctx, c.id)) },
    leaderboard: c.leaderboard ? await leaderboard(ctx, c) : null,
  };
}

export const consentInput = z.object({ consent: z.boolean() });

/** Opt-in or opt-out of the leaderboard of one challenge. */
export async function setConsent(ctx: Ctx, challengeId: string, consent: boolean) {
  const c = (await loadChallenge(ctx, challengeId)) as GamificationRow;
  if (!c.gamification || !c.leaderboard) throw conflict(m('insights.gamification.off'), 'GAMIFICATION_OFF');
  if (consent) {
    await ctx.db.query(
      'INSERT INTO gamification_consents (tenant_id, challenge_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [ctx.tenantId, c.id, ctx.user!.id],
    );
  } else {
    await ctx.db.query('DELETE FROM gamification_consents WHERE challenge_id = $1 AND user_id = $2', [c.id, ctx.user!.id]);
  }
  await audit(ctx, consent ? 'gamification.consent' : 'gamification.revoke', 'challenge', c.id, null, null);
  return gamificationView(ctx, c.id);
}

export const switchesInput = z.object({ enabled: z.boolean().optional(), leaderboard: z.boolean().optional() });

/**
 * Admin switches per challenge. Switching the leaderboard (or everything) off also deletes the
 * consents, so a later switch-on starts without anyone listed.
 */
export async function setSwitches(ctx: Ctx, challengeId: string, input: z.infer<typeof switchesInput>) {
  const c = (await loadChallenge(ctx, challengeId, true)) as GamificationRow;
  const next = { gamification: input.enabled ?? c.gamification, leaderboard: input.leaderboard ?? c.leaderboard };
  await ctx.db.query('UPDATE challenges SET gamification = $2, leaderboard = $3 WHERE id = $1', [c.id, next.gamification, next.leaderboard]);
  if (!next.gamification || !next.leaderboard) await ctx.db.query('DELETE FROM gamification_consents WHERE challenge_id = $1', [c.id]);
  await audit(ctx, 'gamification.switch', 'challenge', c.id, { gamification: c.gamification, leaderboard: c.leaderboard }, next);
  return gamificationView(ctx, c.id);
}
