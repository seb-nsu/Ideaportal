import { z } from 'zod';
import type { Ctx } from '../lib/context.js';
import { badRequest, conflict, forbidden } from '../lib/errors.js';
import { m, tr, type MessageKey } from '../i18n/index.js';
import { audit } from './audit.js';
import { notifyUsers } from './notify.js';
import { emitWebhook } from './webhooks.js';
import { isAuthor, type CustomField, type IdeaRow } from './workflow.js';
import { canManageChallenge, challengeEnded, type ChallengeRow } from './recognition.js';

// Challenge phases with templates (R2-52) and crowd rating by fixed criteria (R2-51).
// Validation messages below are catalogue keys; the error handler resolves them (R2-50).

// ---------------------------------------------------------------- phases (R2-52)

export const PHASES = ['collect', 'rate', 'elaborate', 'jury', 'result'] as const;
export type Phase = (typeof PHASES)[number];

const date = z.iso.date();
export const phasePlanSchema = z
  .object({ collect: date, rate: date, elaborate: date, jury: date, result: date })
  .refine((p) => PHASES.every((ph, i) => i === 0 || p[PHASES[i - 1]] <= p[ph]), 'challenges.phaseOrder');
export type PhasePlan = z.infer<typeof phasePlanSchema>;

export const ratingCriterionSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]{1,40}$/),
  label: z.string().trim().min(1).max(80),
});
export type RatingCriterion = z.infer<typeof ratingCriterionSchema>;

/** Fields of the challenge input for phases and crowd rating (create and update). */
export const challengePhaseInput = z.object({
  phasePlan: phasePlanSchema.nullable().optional(),
  ratingCriteria: z
    .array(ratingCriterionSchema)
    .max(6)
    .refine((xs) => new Set(xs.map((x) => x.id)).size === xs.length, 'recognition.uniqueCriterionIds')
    .optional(),
  template: z.enum(['idea_contest', 'sustainability', 'cost_reduction', 'hackathon']).nullable().optional(),
});
export type ChallengePhaseInput = z.infer<typeof challengePhaseInput>;

export interface ChallengePhaseRow extends ChallengeRow {
  phase_plan: PhasePlan | null;
  phase: Phase | null;
  rating_criteria: RatingCriterion[];
  template: string | null;
}

/** The phase a challenge is in on the given day: the last phase whose start has passed. */
export function phaseOn(plan: PhasePlan | null, today: string, closed = false): Phase | null {
  if (!plan) return null;
  if (closed) return 'result';
  let current: Phase | null = null;
  for (const p of PHASES) if (plan[p] <= today) current = p;
  return current;
}

/** Start, end and phase plan must fit together: the plan starts the challenge and ends before its end. */
export function checkPlan(plan: PhasePlan, endsOn: string): void {
  if (plan.result > endsOn) throw badRequest(m('challenges.phaseAfterEnd'));
}

/** Challenges with a phase plan take ideas only in the collect phase; others as before. */
export function acceptsIdeas(c: Pick<ChallengePhaseRow, 'phase_plan' | 'phase'>): boolean {
  return !c.phase_plan || c.phase === 'collect';
}

/** Saves phase plan, crowd-rating criteria and template; the phase follows the plan at once. */
export async function updateChallengePhases(ctx: Ctx, c: ChallengePhaseRow, input: ChallengePhaseInput): Promise<void> {
  if (!canManageChallenge(ctx, c)) throw forbidden();
  if (input.ratingCriteria !== undefined) {
    await ctx.db.query('UPDATE challenges SET rating_criteria = $2 WHERE id = $1', [c.id, JSON.stringify(input.ratingCriteria)]);
  }
  if (input.template !== undefined) {
    await ctx.db.query('UPDATE challenges SET template = $2 WHERE id = $1', [c.id, input.template]);
  }
  if (input.phasePlan !== undefined) {
    const plan = input.phasePlan;
    if (plan) {
      // A plan may extend the challenge, never shorten it below the result phase.
      await ctx.db.query('UPDATE challenges SET phase_plan = $2, starts_on = $3, ends_on = GREATEST(ends_on, $4::date) WHERE id = $1', [
        c.id, JSON.stringify(plan), plan.collect, plan.result,
      ]);
    } else {
      await ctx.db.query('UPDATE challenges SET phase_plan = NULL, phase = NULL, phase_changed_at = NULL WHERE id = $1', [c.id]);
    }
    await advanceChallenge(ctx, { ...c, phase_plan: plan, phase: plan ? c.phase : null });
  }
  if (input.ratingCriteria !== undefined || input.template !== undefined || input.phasePlan !== undefined) {
    await audit(ctx, 'challenge.phases', 'challenge', c.id, null, input);
  }
}

/** Sets the phase to the one the plan says for today and notifies on every step forward. */
export async function advanceChallenge(ctx: Ctx, c: ChallengePhaseRow): Promise<boolean> {
  const target = phaseOn(c.phase_plan, ctx.today, c.summary !== null);
  if (target === c.phase) return false;
  await ctx.db.query('UPDATE challenges SET phase = $2, phase_changed_at = now() WHERE id = $1', [c.id, target]);
  const forward = target !== null && (c.phase === null || PHASES.indexOf(target) > PHASES.indexOf(c.phase));
  await audit(ctx, 'challenge.phase', 'challenge', c.id, { phase: c.phase }, { phase: target });
  await emitWebhook(ctx, 'challenge.phase_changed', { challenge: { id: c.id, title: c.title, phase: target, previousPhase: c.phase } });
  if (forward) await notifyPhase(ctx, c, target);
  return forward;
}

/**
 * Notification per transition (N42–N46 in the notification matrix): the sponsor always,
 * people with an idea in the challenge from the rating phase on, the jury when the jury phase starts.
 */
async function notifyPhase(ctx: Ctx, c: ChallengePhaseRow, phase: Phase): Promise<void> {
  const vars = { title: c.title, date: phaseEnd(c.phase_plan!, phase, c.ends_on) };
  const subject = m(`challenges.phase.${phase}.subject` as MessageKey, vars);
  const jury = phase === 'jury'
    ? (await ctx.db.query<{ user_id: string }>('SELECT user_id FROM challenge_jury WHERE challenge_id = $1', [c.id])).rows.map((r) => r.user_id)
    : [];
  const participants = phase === 'collect'
    ? []
    : (await ctx.db.query<{ id: string }>(
        `SELECT DISTINCT p.id FROM ideas i
           CROSS JOIN LATERAL (SELECT i.author_id AS id UNION SELECT ca.user_id FROM idea_coauthors ca WHERE ca.idea_id = i.id) p
          WHERE i.challenge_id = $1 AND i.status NOT IN ('draft', 'merged')`,
        [c.id],
      )).rows.map((r) => r.id);
  const sponsor = c.sponsor_id ? [c.sponsor_id] : [];
  await notifyUsers(ctx, sponsor, subject, m(`challenges.phase.${phase}.sponsor` as MessageKey, vars), undefined, 'tasks');
  const juryOnly = jury.filter((id) => !sponsor.includes(id));
  await notifyUsers(ctx, juryOnly, subject, m('challenges.phase.jury.jury', vars), undefined, 'tasks');
  const rest = participants.filter((id) => !sponsor.includes(id) && !juryOnly.includes(id));
  await notifyUsers(ctx, rest, subject, m(`challenges.phase.${phase}.participants` as MessageKey, vars), undefined, 'my_ideas');
}

/** Last day of a phase: the day before the next phase starts, or the end of the challenge. */
function phaseEnd(plan: PhasePlan, phase: Phase, endsOn: string): string {
  const next = PHASES[PHASES.indexOf(phase) + 1];
  if (!next) return endsOn;
  const d = new Date(`${plan[next]}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  const end = d.toISOString().slice(0, 10);
  return end < plan[phase] ? plan[phase] : end;
}

/** Deadline job (R2-52): automatic transitions of all challenges with a phase plan. */
export async function runChallengePhases(ctx: Ctx): Promise<number> {
  const r = await ctx.db.query<ChallengePhaseRow>('SELECT * FROM challenges WHERE phase_plan IS NOT NULL FOR UPDATE');
  let n = 0;
  for (const c of r.rows) if (await advanceChallenge(ctx, c)) n++;
  return n;
}

// ---------------------------------------------------------------- templates (R2-52)

interface Template {
  id: 'idea_contest' | 'sustainability' | 'cost_reduction' | 'hackathon';
  /** Suggests the workspace topic named in the catalogue, when the workspace has it. */
  topic: boolean;
  teamsAllowed: boolean;
  criteria: string[];
  fields: { id: string; type: 'number' | 'text' }[];
  /** Length of each phase in days; the result phase lasts until the end. */
  days: Record<Phase, number>;
  /** Benefit kind of the target value the template suggests (R3-32, R3-33). */
  targetKind?: 'co2' | 'euro';
  /** Hackathon mode with submission window and pitches (R3-34). */
  hackathon?: boolean;
}

const TEMPLATES: Template[] = [
  { id: 'idea_contest', topic: false, teamsAllowed: true, criteria: ['benefit', 'feasibility', 'novelty'], fields: [],
    days: { collect: 28, rate: 10, elaborate: 21, jury: 10, result: 14 } },
  // R3-32: estimated kWh next to CO₂; the impact is reported per benefit kind and converted with the workspace factors.
  { id: 'sustainability', topic: true, teamsAllowed: true, criteria: ['environment', 'feasibility', 'benefit'], fields: [{ id: 'co2', type: 'number' }, { id: 'kwh', type: 'number' }],
    days: { collect: 35, rate: 10, elaborate: 21, jury: 10, result: 14 }, targetKind: 'co2' },
  { id: 'cost_reduction', topic: false, teamsAllowed: false, criteria: ['savings', 'feasibility', 'low_risk'], fields: [{ id: 'savings_eur', type: 'number' }],
    days: { collect: 28, rate: 7, elaborate: 21, jury: 7, result: 14 }, targetKind: 'euro' },
  // R3-34: short phases, teams, jury and pitches.
  { id: 'hackathon', topic: false, teamsAllowed: true, criteria: ['novelty', 'feasibility', 'benefit'], fields: [],
    days: { collect: 2, rate: 1, elaborate: 1, jury: 1, result: 7 }, hackathon: true },
];

/** Templates in the reader's language; the topic only when the workspace has it. */
export function challengeTemplates(ctx: Ctx) {
  const t = (key: string) => tr(ctx.locale, m(key as MessageKey));
  return TEMPLATES.map((x) => {
    const topic = x.topic ? tr('de', m(`challenges.template.${x.id}.topic` as MessageKey)) : null;
    return {
    id: x.id,
    name: t(`challenges.template.${x.id}.name`),
    title: t(`challenges.template.${x.id}.title`),
    question: t(`challenges.template.${x.id}.question`),
    topic: topic && ctx.settings.topics.includes(topic) ? topic : null,
    teamsAllowed: x.teamsAllowed,
    ratingCriteria: x.criteria.map((id) => ({ id, label: t(`challenges.criterion.${id}`) })),
    customFields: x.fields.map((f): CustomField => ({ id: f.id, label: t(`challenges.template.field.${f.id}`), type: f.type, options: [], required: false })),
    phaseDays: x.days,
    targetKind: x.targetKind ?? null,
    hackathon: x.hackathon ?? false,
    };
  });
}

// ---------------------------------------------------------------- crowd rating (R2-51)

const DEFAULT_CRITERIA = ['benefit', 'feasibility'];

/** The challenge's own criteria or the default "Nutzen" and "Machbarkeit" in the reader's language. */
export function ratingCriteria(ctx: Ctx, c: ChallengePhaseRow): RatingCriterion[] {
  if (c.rating_criteria?.length) return c.rating_criteria;
  return DEFAULT_CRITERIA.map((id) => ({ id, label: tr(ctx.locale, m(`challenges.criterion.${id}` as MessageKey)) }));
}

// Switched on in the settings and included in the package (R3-05).
export const crowdRatingEnabled = (ctx: Ctx) => ctx.settings.challenges.crowdRating && (ctx.plan?.features.crowdRating ?? true);

/** Rating is open in the rating phase, or while a challenge without phases runs. */
export function ratingOpen(ctx: Ctx, c: ChallengePhaseRow): boolean {
  if (c.phase_plan) return c.phase === 'rate';
  return c.starts_on <= ctx.today && !challengeEnded(ctx, c);
}

export const ratingInput = z.object({ scores: z.record(z.string(), z.number().int().min(1).max(5)) });

export async function rateIdea(ctx: Ctx, c: ChallengePhaseRow, idea: IdeaRow, scores: Record<string, number>) {
  if (!crowdRatingEnabled(ctx)) throw forbidden(m('challenges.crowdRatingOff'));
  if (idea.challenge_id !== c.id || ['draft', 'merged'].includes(idea.status)) throw badRequest(m('recognition.notInChallenge'));
  if (isAuthor(ctx.user, idea)) throw forbidden(m('challenges.notOwnIdea'));
  if (!ratingOpen(ctx, c)) throw conflict(m('challenges.ratingClosed'), 'CHALLENGE_PHASE');
  const criteria = ratingCriteria(ctx, c);
  const missing = criteria.filter((x) => scores[x.id] === undefined);
  if (missing.length) throw badRequest(m('challenges.rateAll'), { missing: missing.map((x) => x.id) });
  const clean = Object.fromEntries(criteria.map((x) => [x.id, scores[x.id]]));
  await ctx.db.query(
    `INSERT INTO challenge_ratings (tenant_id, challenge_id, idea_id, user_id, scores) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (idea_id, user_id) DO UPDATE SET scores = EXCLUDED.scores, updated_at = now()`,
    [ctx.tenantId, c.id, idea.id, ctx.user!.id, JSON.stringify(clean)],
  );
  // No audit entry with the scores: it would show who rated what.
  return (await crowdAggregates(ctx, c, [idea.id]))[idea.id];
}

export interface CrowdAggregate {
  count: number;
  /** Mean and standard deviation per criterion, only from the minimum group size on. */
  criteria: { id: string; mean: number; sd: number }[] | null;
}

/**
 * Aggregates per idea. Below the minimum group size (settings, default 5) only the number of
 * ratings is shown, so no single rating can be read off. Never per rating person.
 */
export async function crowdAggregates(ctx: Ctx, c: ChallengePhaseRow, ideaIds: string[]): Promise<Record<string, CrowdAggregate>> {
  const ids = ratingCriteria(ctx, c).map((x) => x.id);
  const counts = await ctx.db.query<{ idea_id: string; n: number }>(
    'SELECT idea_id, count(*)::int AS n FROM challenge_ratings WHERE challenge_id = $1 AND idea_id = ANY($2::uuid[]) GROUP BY idea_id',
    [c.id, ideaIds],
  );
  const stats = await ctx.db.query<{ idea_id: string; id: string; mean: number; sd: number }>(
    `SELECT r.idea_id, s.key AS id, round(avg(s.value::numeric), 1)::float AS mean, round(stddev_pop(s.value::numeric), 1)::float AS sd
       FROM challenge_ratings r CROSS JOIN LATERAL jsonb_each_text(r.scores) s
      WHERE r.challenge_id = $1 AND r.idea_id = ANY($2::uuid[]) AND s.key = ANY($3::text[])
      GROUP BY r.idea_id, s.key HAVING count(*) >= $4`,
    [c.id, ideaIds, ids, ctx.settings.minGroupSize],
  );
  const out: Record<string, CrowdAggregate> = {};
  for (const id of ideaIds) out[id] = { count: 0, criteria: null };
  for (const r of counts.rows) out[r.idea_id].count = r.n;
  for (const id of ideaIds) {
    if (out[id].count < ctx.settings.minGroupSize) continue;
    const rows = stats.rows.filter((s) => s.idea_id === id);
    out[id].criteria = ids.flatMap((k) => rows.filter((s) => s.id === k).map((s) => ({ id: k, mean: s.mean, sd: s.sd })));
  }
  return out;
}

/** The own ratings of the asking person, never anyone else's. */
export async function myRatings(ctx: Ctx, c: ChallengePhaseRow): Promise<Record<string, Record<string, number>>> {
  const r = await ctx.db.query<{ idea_id: string; scores: Record<string, number> }>(
    'SELECT idea_id, scores FROM challenge_ratings WHERE challenge_id = $1 AND user_id = $2',
    [c.id, ctx.user!.id],
  );
  return Object.fromEntries(r.rows.map((x) => [x.idea_id, x.scores]));
}

/** Everything the challenge page shows about the crowd rating; null when switched off. */
export async function crowdRatingView(ctx: Ctx, c: ChallengePhaseRow, ideaIds: string[]) {
  if (!crowdRatingEnabled(ctx)) return null;
  return {
    criteria: ratingCriteria(ctx, c),
    open: ratingOpen(ctx, c),
    minRatings: ctx.settings.minGroupSize,
    aggregates: await crowdAggregates(ctx, c, ideaIds),
    mine: await myRatings(ctx, c),
    // Own ideas are not rated by their authors; the page hides the form for them.
    ownIdeas: (await ctx.db.query<{ id: string }>(
      `SELECT i.id FROM ideas i WHERE i.challenge_id = $1 AND (i.author_id = $2 OR i.submitted_by_id IS NOT DISTINCT FROM $2
          OR EXISTS (SELECT 1 FROM idea_coauthors ca WHERE ca.idea_id = i.id AND ca.user_id = $2))`,
      [c.id, ctx.user!.id],
    )).rows.map((r) => r.id),
  };
}
