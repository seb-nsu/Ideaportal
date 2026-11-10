import { z } from 'zod';
import { can, isTriage, isTriageEverywhere, type Ctx } from '../lib/context.js';
import { badRequest, conflict, forbidden } from '../lib/errors.js';
import { cat, m, tr, type Locale, type MessageKey } from '../i18n/index.js';
import { audit } from './audit.js';
import { notifyAuthors, notifyUser } from './notify.js';
import { canManageChallenge, canSeeRanking, challengeEnded, isJury, loadChallenge, type ChallengeRow } from './recognition.js';
import { emitIdeaEvent } from './webhooks.js';
import {
  VISIBLE_SQL,
  actsFor,
  addEvent,
  completeDeadlines,
  ideaVars,
  isAuthor,
  requireActiveUser,
  requireStatus,
  setStatus,
  submissionWindowOpen,
  type IdeaRow,
} from './workflow.js';

// Use cases (AP-22): problem exchange (R3-31), sustainability challenge with kWh and ESG export
// (R3-32), challenge with target value and controlling confirmation (R3-33), hackathon mode (R3-34).
// Validation messages are catalogue keys; the error handler resolves them (R2-50).

export const BENEFIT_KINDS = ['euro', 'hours', 'quality', 'revenue', 'co2', 'kwh'] as const;
export const TARGET_KINDS = ['euro', 'hours', 'revenue', 'co2', 'kwh'] as const;
type TargetKind = (typeof TARGET_KINDS)[number];

export interface UseCaseRow extends ChallengeRow {
  source_idea_id: string | null;
  target_kind: TargetKind | null;
  target_value: string | null;
  target_from: string | null;
  target_until: string | null;
  confirmer_id: string | null;
  hackathon: boolean;
  submission_opens_at: Date | null;
  submission_closes_at: Date | null;
  pitch_order: string[];
  pitch_minutes: number;
  audience_voting: boolean;
  audience_weight: number;
}

const loadUseCase = (ctx: Ctx, id: string, forUpdate = false) => loadChallenge(ctx, id, forUpdate) as Promise<UseCaseRow>;

// ---------------------------------------------------------------- problem exchange (R3-31)

export const toChallengeInput = z.object({
  title: z.string().trim().min(3).max(140),
  question: z.string().trim().min(10).max(3000),
  startsOn: z.iso.date().optional(),
  endsOn: z.iso.date(),
  reason: z.string().trim().max(3000).optional(),
});

/**
 * Gate 1 for a problem: triage turns it into a challenge. The problem counts as answered
 * (status "forwarded" to the challenge), its author is told where the search for solutions goes on.
 */
export async function problemToChallenge(ctx: Ctx, idea: IdeaRow, input: z.infer<typeof toChallengeInput>): Promise<{ challengeId: string }> {
  if (!isTriage(ctx.user)) throw forbidden();
  if (idea.idea_kind !== 'problem') throw badRequest(m('usecases.notProblem'));
  requireStatus(idea, 'submitted', 'in_question');
  const startsOn = input.startsOn ?? ctx.today;
  if (input.endsOn < startsOn) throw badRequest(m('misc.endBeforeStart'));
  const topic = idea.topic && ctx.settings.topics.includes(idea.topic) ? idea.topic : null;
  const r = await ctx.db.query<{ id: string }>(
    `INSERT INTO challenges (tenant_id, title, question, topic, contact, sponsor_id, starts_on, ends_on, source_idea_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [ctx.tenantId, input.title, input.question, topic, ctx.user!.displayName, ctx.user!.id, startsOn, input.endsOn, idea.id],
  );
  const challengeId = r.rows[0].id;
  const reason = input.reason || null;
  await ctx.db.query(
    'INSERT INTO decisions (tenant_id, idea_id, gate, outcome, reason, decided_by) VALUES ($1, $2, 1, $3, $4, $5)',
    [ctx.tenantId, idea.id, 'forward', reason, ctx.user!.id],
  );
  await audit(ctx, 'gate1.decision', 'idea', idea.id, { status: idea.status }, { lane: 'challenge', challengeId, reason });
  await audit(ctx, 'challenge.create', 'challenge', challengeId, null, { fromProblem: idea.id, title: input.title });
  await completeDeadlines(ctx, idea);
  const text = cat([m('usecases.toChallenge.body', { challenge: input.title }), ...(reason ? ['\n\n', m('workflow.reasonLine', { reason })] : [])]);
  await setStatus(ctx, idea, 'forwarded', 'gate1', text, { lane: 'forward', forwarded_to: input.title });
  await emitIdeaEvent(ctx, 'idea.gate_decided', idea, { gate: 1, outcome: 'forward', challengeId });
  await notifyAuthors(ctx, idea, m('usecases.toChallenge.subject', ideaVars(idea)), text);
  return { challengeId };
}

// ---------------------------------------------------------------- settings of a challenge (R3-32 … R3-34)

const dateTime = z.iso.datetime({ offset: true });

export const useCaseInput = z.object({
  targetKind: z.enum(TARGET_KINDS).nullable().optional(),
  targetValue: z.number().positive().max(1e12).nullable().optional(),
  targetFrom: z.iso.date().nullable().optional(),
  targetUntil: z.iso.date().nullable().optional(),
  confirmerId: z.uuid().nullable().optional(),
  hackathon: z.boolean().optional(),
  submissionOpensAt: dateTime.nullable().optional(),
  submissionClosesAt: dateTime.nullable().optional(),
  pitchOrder: z.array(z.uuid()).max(300).optional(),
  pitchMinutes: z.number().int().min(1).max(60).optional(),
  audienceVoting: z.boolean().optional(),
  audienceWeight: z.number().int().min(0).max(100).optional(),
});
export type UseCaseInput = z.infer<typeof useCaseInput>;

const COLUMNS: Record<keyof UseCaseInput, string> = {
  targetKind: 'target_kind', targetValue: 'target_value', targetFrom: 'target_from', targetUntil: 'target_until', confirmerId: 'confirmer_id',
  hackathon: 'hackathon', submissionOpensAt: 'submission_opens_at', submissionClosesAt: 'submission_closes_at', pitchOrder: 'pitch_order',
  pitchMinutes: 'pitch_minutes', audienceVoting: 'audience_voting', audienceWeight: 'audience_weight',
};

/** Saves target value, confirmer and hackathon settings; only the sponsor and triage. */
export async function updateUseCases(ctx: Ctx, challengeId: string, input: UseCaseInput): Promise<void> {
  const c = await loadUseCase(ctx, challengeId, true);
  if (!canManageChallenge(ctx, c)) throw forbidden();
  const entries = (Object.keys(COLUMNS) as (keyof UseCaseInput)[]).filter((k) => input[k] !== undefined);
  if (!entries.length) return;
  const next = {
    targetValue: input.targetValue !== undefined ? input.targetValue : c.target_value,
    targetKind: input.targetKind !== undefined ? input.targetKind : c.target_kind,
    from: input.targetFrom !== undefined ? input.targetFrom : c.target_from,
    until: input.targetUntil !== undefined ? input.targetUntil : c.target_until,
    opens: input.submissionOpensAt !== undefined ? input.submissionOpensAt : c.submission_opens_at,
    closes: input.submissionClosesAt !== undefined ? input.submissionClosesAt : c.submission_closes_at,
  };
  if ((next.targetValue == null) !== (next.targetKind == null)) throw badRequest(m('usecases.targetIncomplete'));
  if (next.from && next.until && next.until < next.from) throw badRequest(m('misc.endBeforeStart'));
  if (next.opens && next.closes && new Date(next.closes) <= new Date(next.opens)) throw badRequest(m('usecases.windowOrder'));
  if (input.confirmerId) await requireActiveUser(ctx, input.confirmerId);
  const values = entries.map((k) => {
    if (k === 'pitchOrder') return [...new Set(input.pitchOrder)];
    return input[k];
  });
  await ctx.db.query(`UPDATE challenges SET ${entries.map((k, i) => `${COLUMNS[k]} = $${i + 2}`).join(', ')} WHERE id = $1`, [c.id, ...values]);
  await audit(ctx, 'challenge.use_cases', 'challenge', c.id, null, input);
}

// ---------------------------------------------------------------- impact, target and confirmation (R3-32, R3-33)

/** Controlling, or the person the challenge names as confirmer. */
export const canConfirm = (ctx: Ctx, c?: Pick<UseCaseRow, 'confirmer_id'> | null) =>
  can(ctx.user, 'confirmBenefit') || (!!ctx.user && !!c?.confirmer_id && c.confirmer_id === ctx.user.id);

interface KindRow { kind: string; ideas: number; estimated: number; confirmed: number; confirmedIdeas: number }

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

/** Benefit per kind of the implemented ideas of a challenge, reported (estimated) and confirmed. */
export async function benefitByKind(ctx: Ctx, challengeId: string, from?: string | null, until?: string | null): Promise<KindRow[]> {
  const r = await ctx.db.query<KindRow>(
    `SELECT im.benefit_kind AS kind, count(*)::int AS ideas, coalesce(sum(im.benefit_value), 0)::float AS estimated,
            coalesce(sum(bc.confirmed_value), 0)::float AS confirmed, count(bc.id)::int AS "confirmedIdeas"
       FROM implementations im JOIN ideas i ON i.id = im.idea_id LEFT JOIN benefit_confirmations bc ON bc.idea_id = i.id
      WHERE i.challenge_id = $1 AND im.status = 'done' AND im.benefit_kind IS NOT NULL
        AND ($2::date IS NULL OR im.closed_at::date >= $2) AND ($3::date IS NULL OR im.closed_at::date <= $3)
      GROUP BY 1 ORDER BY 1`,
    [challengeId, from ?? null, until ?? null],
  );
  return r.rows;
}

/**
 * Converts the kWh into CO₂ (tonnes) and euro with the workspace factors (R3-32). Every
 * implementation has one benefit kind, so a converted value never counts twice.
 */
export function converted(ctx: Ctx, kinds: KindRow[]) {
  const kwh = kinds.find((k) => k.kind === 'kwh');
  const f = ctx.settings.challenges;
  return {
    kgCo2PerKwh: f.kgCo2PerKwh,
    eurPerKwh: f.eurPerKwh,
    co2FromKwh: kwh ? { estimated: round((kwh.estimated * f.kgCo2PerKwh) / 1000, 3), confirmed: round((kwh.confirmed * f.kgCo2PerKwh) / 1000, 3) } : null,
    eurFromKwh: kwh ? { estimated: round(kwh.estimated * f.eurPerKwh), confirmed: round(kwh.confirmed * f.eurPerKwh) } : null,
  };
}

/** Progress towards the target: confirmed against estimated, CO₂ and euro including converted kWh. */
export function targetProgress(ctx: Ctx, c: UseCaseRow, kinds: KindRow[]) {
  if (!c.target_kind || c.target_value == null) return null;
  const target = Number(c.target_value);
  const own = kinds.find((k) => k.kind === c.target_kind);
  const conv = converted(ctx, kinds);
  const extra = c.target_kind === 'co2' ? conv.co2FromKwh : c.target_kind === 'euro' ? conv.eurFromKwh : null;
  const estimated = round((own?.estimated ?? 0) + (extra?.estimated ?? 0), 3);
  const confirmed = round((own?.confirmed ?? 0) + (extra?.confirmed ?? 0), 3);
  return {
    kind: c.target_kind,
    value: target,
    from: c.target_from,
    until: c.target_until,
    estimated,
    confirmed,
    estimatedPercent: Math.round((estimated / target) * 100),
    confirmedPercent: Math.round((confirmed / target) * 100),
    includesConvertedKwh: !!extra,
  };
}

export const confirmInput = z.object({
  outcome: z.enum(['confirmed', 'corrected']),
  value: z.number().min(0).max(1e12).optional(),
  comment: z.string().trim().min(5).max(3000),
});

/**
 * Confirmation step for an actual benefit (R3-33): controlling or the challenge's confirmer
 * confirms the reported value or corrects it, always with a comment. The person responsible for
 * the implementation cannot confirm their own benefit (four-eyes principle).
 */
export async function confirmBenefit(ctx: Ctx, idea: IdeaRow, input: z.infer<typeof confirmInput>): Promise<{ confirmedValue: number }> {
  const c = idea.challenge_id ? await loadUseCase(ctx, idea.challenge_id) : null;
  if (!canConfirm(ctx, c)) throw forbidden(m('usecases.confirmRole'));
  const r = await ctx.db.query<{ id: string; owner_id: string; status: string; benefit_kind: string | null; benefit_value: string | null }>(
    'SELECT id, owner_id, status, benefit_kind, benefit_value FROM implementations WHERE idea_id = $1 FOR UPDATE',
    [idea.id],
  );
  const im = r.rows[0];
  if (!im || im.status !== 'done' || !im.benefit_kind) throw conflict(m('usecases.noActualBenefit'), 'INVALID_STATUS');
  if (await actsFor(ctx, im.owner_id)) throw forbidden(m('usecases.confirmOwn'));
  if (isAuthor(ctx.user, idea)) throw forbidden(m('usecases.confirmOwn'));
  const estimated = im.benefit_value == null ? null : Number(im.benefit_value);
  let value: number;
  if (input.outcome === 'confirmed') {
    if (estimated == null) throw badRequest(m('usecases.confirmNeedsValue'));
    value = estimated;
  } else {
    if (input.value === undefined) throw badRequest(m('usecases.correctNeedsValue'));
    value = input.value;
  }
  await ctx.db.query(
    `INSERT INTO benefit_confirmations (tenant_id, idea_id, implementation_id, outcome, benefit_kind, estimated_value, confirmed_value, comment, confirmed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (idea_id) DO UPDATE SET outcome = EXCLUDED.outcome, benefit_kind = EXCLUDED.benefit_kind, estimated_value = EXCLUDED.estimated_value,
       confirmed_value = EXCLUDED.confirmed_value, comment = EXCLUDED.comment, confirmed_by = EXCLUDED.confirmed_by, confirmed_at = now()`,
    [ctx.tenantId, idea.id, im.id, input.outcome, im.benefit_kind, estimated, value, input.comment, ctx.user!.id],
  );
  await audit(ctx, 'benefit.confirm', 'idea', idea.id, { value: estimated }, { outcome: input.outcome, value, comment: input.comment });
  const unit = m(`workflow.benefit.${im.benefit_kind}` as MessageKey);
  const text = input.outcome === 'confirmed'
    ? cat([m('usecases.confirmed.event', { value }), ' ', unit, '. ', m('usecases.commentLine', { comment: input.comment })])
    : cat([m('usecases.corrected.event', { from: estimated ?? '–', value }), ' ', unit, '. ', m('usecases.commentLine', { comment: input.comment })]);
  await addEvent(ctx, idea, 'benefit_confirmed', text);
  await notifyUser(ctx, im.owner_id, m('usecases.confirmed.subject', ideaVars(idea)), text, idea.id);
  return { confirmedValue: value };
}

/** Actual benefits to confirm and confirmed ones: all for controlling, the own challenges for a confirmer. */
export async function confirmationList(ctx: Ctx, challengeId?: string, wholeChallenge = false) {
  // On the challenge page, the people who manage or confirm see every benefit of that challenge.
  const all = can(ctx.user, 'confirmBenefit') || (!!challengeId && wholeChallenge);
  const r = await ctx.db.query<{
    ideaId: string; number: number; title: string; confidential: boolean; challengeId: string | null; challengeTitle: string | null;
    benefitKind: string; reported: number | null; evidence: string | null; closedAt: Date; ownerId: string;
    outcome: string | null; confirmedValue: number | null; comment: string | null; confirmedAt: Date | null; confirmedBy: string | null;
  }>(
    `SELECT i.id AS "ideaId", i.number, i.title, i.confidential, c.id AS "challengeId", c.title AS "challengeTitle",
            im.benefit_kind AS "benefitKind", im.benefit_value::float AS reported, im.benefit_evidence AS evidence, im.closed_at AS "closedAt", im.owner_id AS "ownerId",
            bc.outcome, bc.confirmed_value::float AS "confirmedValue", bc.comment, bc.confirmed_at AS "confirmedAt", u.display_name AS "confirmedBy"
       FROM implementations im JOIN ideas i ON i.id = im.idea_id
       LEFT JOIN challenges c ON c.id = i.challenge_id
       LEFT JOIN benefit_confirmations bc ON bc.idea_id = i.id
       LEFT JOIN users u ON u.id = bc.confirmed_by
      WHERE im.status = 'done' AND im.benefit_kind IS NOT NULL
        AND ($1::uuid IS NULL OR i.challenge_id = $1)
        AND ($2::boolean OR c.confirmer_id = $3)
      ORDER BY (bc.id IS NULL) DESC, im.closed_at DESC LIMIT 300`,
    [challengeId ?? null, all, ctx.user!.id],
  );
  const triage = isTriage(ctx.user);
  return r.rows.map(({ ownerId, confidential, ...x }) => ({
    ...x,
    // Confidential ideas keep their title hidden from people outside the idea management.
    title: confidential && !triage ? null : x.title,
    evidence: confidential && !triage ? null : x.evidence,
    own: ownerId === ctx.user!.id,
  }));
}

// ---------------------------------------------------------------- hackathon (R3-34)

const now = () => new Date();

/** Audience voting is open after the submission window closed and until the challenge ends. */
export function votingOpen(ctx: Ctx, c: UseCaseRow): boolean {
  if (!c.hackathon || !c.audience_voting || challengeEnded(ctx, c)) return false;
  return !c.submission_closes_at || now() >= new Date(c.submission_closes_at);
}

async function ideaIn(ctx: Ctx, c: UseCaseRow, ideaId: string): Promise<IdeaRow & { coauthor_ids: string[] }> {
  const r = await ctx.db.query<IdeaRow & { coauthor_ids: string[] }>(
    `SELECT i.*, coalesce((SELECT array_agg(ca.user_id) FROM idea_coauthors ca WHERE ca.idea_id = i.id), '{}') AS coauthor_ids
       FROM ideas i WHERE i.id = $1 AND i.challenge_id = $2 AND i.status NOT IN ('draft', 'merged')`,
    [ideaId, c.id],
  );
  if (!r.rows[0]) throw badRequest(m('recognition.notInChallenge'));
  return r.rows[0];
}

/** One click per person: a new vote replaces the earlier one. Jury members vote as jury, not as audience. */
export async function vote(ctx: Ctx, challengeId: string, ideaId: string): Promise<{ ok: true }> {
  const c = await loadUseCase(ctx, challengeId);
  if (!c.hackathon || !c.audience_voting) throw conflict(m('usecases.votingOff'), 'VOTING');
  if (!votingOpen(ctx, c)) throw conflict(m('usecases.votingClosed'), 'VOTING');
  if (await isJury(ctx, c.id)) throw forbidden(m('usecases.juryNoAudience'));
  const idea = await ideaIn(ctx, c, ideaId);
  if (isAuthor(ctx.user, idea)) throw forbidden(m('usecases.notOwnTeam'));
  await ctx.db.query(
    `INSERT INTO challenge_audience_votes (tenant_id, challenge_id, user_id, idea_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (challenge_id, user_id) DO UPDATE SET idea_id = EXCLUDED.idea_id, created_at = now()`,
    [ctx.tenantId, c.id, ctx.user!.id, idea.id],
  );
  // No audit entry with the choice: it would show who voted for what.
  return { ok: true };
}

export async function withdrawVote(ctx: Ctx, challengeId: string): Promise<void> {
  const c = await loadUseCase(ctx, challengeId);
  if (!votingOpen(ctx, c)) throw conflict(m('usecases.votingClosed'), 'VOTING');
  await ctx.db.query('DELETE FROM challenge_audience_votes WHERE challenge_id = $1 AND user_id = $2', [c.id, ctx.user!.id]);
}

interface RankRow { id: string; number: number; title: string; teamName: string | null; jury: number | null; juryRatings: number; votes: number }

/**
 * Ranking combined by the challenge's setting (R3-34): jury score (mean of the weighted jury
 * totals, scale 1–5, as share of 5) and audience (votes as share of the most voted idea),
 * weighted with audience_weight and 100 − audience_weight. Without audience voting the jury counts alone.
 */
export async function combinedRanking(ctx: Ctx, c: UseCaseRow) {
  const r = await ctx.db.query<RankRow>(
    `SELECT i.id, i.number, i.title, i.team_name AS "teamName",
            (SELECT round(avg(s.total)::numeric, 2)::float FROM scorecards s WHERE s.idea_id = i.id AND s.context = 'jury') AS jury,
            (SELECT count(*) FROM scorecards s WHERE s.idea_id = i.id AND s.context = 'jury')::int AS "juryRatings",
            (SELECT count(*) FROM challenge_audience_votes v WHERE v.idea_id = i.id AND v.challenge_id = $3)::int AS votes
       FROM ideas i
      WHERE i.challenge_id = $3 AND i.status NOT IN ('draft', 'merged') AND ${VISIBLE_SQL}`,
    [ctx.user!.id, isTriageEverywhere(ctx.user), c.id],
  );
  const audienceWeight = c.audience_voting ? c.audience_weight : 0;
  const maxVotes = Math.max(0, ...r.rows.map((x) => x.votes));
  const rows = r.rows.map((x) => {
    const juryScore = x.jury == null ? null : round((x.jury / 5) * 100, 1);
    const audienceScore = c.audience_voting ? (maxVotes ? round((x.votes / maxVotes) * 100, 1) : 0) : null;
    const anything = juryScore != null || (audienceScore != null && x.votes > 0);
    const score = anything ? round(((100 - audienceWeight) * (juryScore ?? 0) + audienceWeight * (audienceScore ?? 0)) / 100, 1) : null;
    return { ...x, votes: c.audience_voting ? x.votes : null, juryScore, audienceScore, score };
  });
  rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.number - b.number);
  let rank = 0;
  return { juryWeight: 100 - audienceWeight, audienceWeight, rows: rows.map((x) => ({ ...x, rank: x.score == null ? null : ++rank })) };
}

/** Team page: every submitted idea with its team name and members; anonymous authors stay hidden. */
export async function teams(ctx: Ctx, challengeId: string) {
  const c = await loadUseCase(ctx, challengeId);
  const triage = isTriage(ctx.user);
  const r = await ctx.db.query<{ id: string; number: number; title: string; teamName: string | null; anonymous: boolean; author_id: string; members: { id: string; name: string; author: boolean }[] }>(
    `SELECT i.id, i.number, i.title, i.team_name AS "teamName", i.anonymous, i.author_id,
            coalesce((SELECT json_agg(json_build_object('id', u.id, 'name', u.display_name, 'author', u.id = i.author_id) ORDER BY (u.id = i.author_id) DESC, u.display_name)
               FROM users u WHERE (u.id = i.author_id OR u.id IN (SELECT ca.user_id FROM idea_coauthors ca WHERE ca.idea_id = i.id)) AND u.anonymized_at IS NULL), '[]') AS members
       FROM ideas i
      WHERE i.challenge_id = $3 AND i.status NOT IN ('draft', 'merged') AND ${VISIBLE_SQL}
      ORDER BY coalesce(i.team_name, i.title), i.number`,
    [ctx.user!.id, isTriageEverywhere(ctx.user), c.id],
  );
  return {
    challenge: { id: c.id, title: c.title },
    locked: !!c.hackathon && !!c.submission_closes_at && now() >= new Date(c.submission_closes_at),
    teams: r.rows.map((x) => {
      const own = x.members.some((p) => p.id === ctx.user!.id);
      const hidden = x.anonymous && !triage && !own;
      return { id: x.id, number: x.number, title: x.title, teamName: x.teamName, members: hidden ? null : x.members.map((p) => ({ name: p.name, author: p.author })), size: x.members.length };
    }),
  };
}

// ---------------------------------------------------------------- view of the challenge page

export async function useCaseView(ctx: Ctx, challengeId: string) {
  const c = await loadUseCase(ctx, challengeId);
  const manage = canManageChallenge(ctx, c);
  const confirm = canConfirm(ctx, c);
  const source = c.source_idea_id
    ? (await ctx.db.query<{ id: string; number: number; title: string }>(
        `SELECT i.id, i.number, i.title FROM ideas i WHERE i.id = $3 AND ${VISIBLE_SQL}`,
        [ctx.user!.id, isTriageEverywhere(ctx.user), c.source_idea_id],
      )).rows[0] ?? null
    : null;
  const confirmer = c.confirmer_id
    ? (await ctx.db.query<{ id: string; displayName: string }>('SELECT id, display_name AS "displayName" FROM users WHERE id = $1', [c.confirmer_id])).rows[0] ?? null
    : null;
  const kinds = await benefitByKind(ctx, c.id);
  const periodKinds = c.target_from || c.target_until ? await benefitByKind(ctx, c.id, c.target_from, c.target_until) : kinds;
  let hackathon = null;
  if (c.hackathon) {
    const ideas = await ctx.db.query<{ id: string; number: number; title: string; teamName: string | null }>(
      `SELECT i.id, i.number, i.title, i.team_name AS "teamName" FROM ideas i
        WHERE i.challenge_id = $3 AND i.status NOT IN ('draft', 'merged') AND ${VISIBLE_SQL} ORDER BY i.number`,
      [ctx.user!.id, isTriageEverywhere(ctx.user), c.id],
    );
    const byId = new Map(ideas.rows.map((i) => [i.id, i]));
    const ordered = c.pitch_order.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
    const myVote = (await ctx.db.query<{ idea_id: string }>('SELECT idea_id FROM challenge_audience_votes WHERE challenge_id = $1 AND user_id = $2', [c.id, ctx.user!.id])).rows[0]?.idea_id ?? null;
    const showRanking = await canSeeRanking(ctx, c);
    const ownIdeas = (await ctx.db.query<{ id: string }>(
      `SELECT i.id FROM ideas i WHERE i.challenge_id = $1 AND (i.author_id = $2 OR EXISTS (SELECT 1 FROM idea_coauthors ca WHERE ca.idea_id = i.id AND ca.user_id = $2))`,
      [c.id, ctx.user!.id],
    )).rows.map((r) => r.id);
    hackathon = {
      submissionOpensAt: c.submission_opens_at,
      submissionClosesAt: c.submission_closes_at,
      submissionOpen: submissionWindowOpen(c) && !challengeEnded(ctx, c),
      locked: !!c.submission_closes_at && now() >= new Date(c.submission_closes_at),
      pitchMinutes: c.pitch_minutes,
      pitch: ordered.map((i, n) => ({ ...i, position: n + 1, startsAfterMinutes: n * c.pitch_minutes })),
      // Ideas without a place in the pitch list; only the people who manage the challenge order them.
      unordered: manage ? ideas.rows.filter((i) => !c.pitch_order.includes(i.id)) : [],
      audienceVoting: c.audience_voting,
      audienceWeight: c.audience_weight,
      votingOpen: votingOpen(ctx, c),
      isJury: await isJury(ctx, c.id),
      myVote,
      ownIdeas,
      ranking: showRanking ? await combinedRanking(ctx, c) : null,
    };
  }
  return {
    sourceIdea: source,
    target: targetProgress(ctx, c, periodKinds),
    targetSettings: { kind: c.target_kind, value: c.target_value == null ? null : Number(c.target_value), from: c.target_from, until: c.target_until },
    confirmer,
    impact: { kinds, ...converted(ctx, kinds) },
    confirmations: manage || confirm ? await confirmationList(ctx, c.id, true) : null,
    hackathon,
    hackathonSettings: manage
      ? { hackathon: c.hackathon, submissionOpensAt: c.submission_opens_at, submissionClosesAt: c.submission_closes_at, pitchMinutes: c.pitch_minutes,
          pitchOrder: c.pitch_order, audienceVoting: c.audience_voting, audienceWeight: c.audience_weight }
      : null,
    can: { manage, confirm },
  };
}

// ---------------------------------------------------------------- ESG export (R3-32)

/** CSV rows of the ESG export: totals per benefit kind, converted kWh, then one line per idea. */
export async function esgRows(ctx: Ctx, challengeId: string, locale: Locale): Promise<{ title: string; rows: unknown[][] }> {
  const c = await loadUseCase(ctx, challengeId);
  const t = (key: string, vars?: Record<string, string | number>) => tr(locale, m(key as MessageKey, vars));
  const kinds = await benefitByKind(ctx, c.id);
  const conv = converted(ctx, kinds);
  const unit = (k: string) => t(`workflow.benefit.${k}`);
  const rows: unknown[][] = [
    [t('usecases.csv.challenge'), c.title],
    [t('usecases.csv.period'), `${c.starts_on} – ${c.ends_on}`],
    [t('usecases.csv.factorCo2'), conv.kgCo2PerKwh],
    [t('usecases.csv.factorEur'), conv.eurPerKwh],
    [],
    [t('usecases.csv.kind'), t('usecases.csv.unit'), t('usecases.csv.ideas'), t('usecases.csv.estimated'), t('usecases.csv.confirmed'), t('usecases.csv.confirmedIdeas')],
  ];
  for (const k of kinds) rows.push([k.kind, unit(k.kind), k.ideas, k.estimated, k.confirmed, k.confirmedIdeas]);
  if (conv.co2FromKwh) rows.push([t('usecases.csv.co2FromKwh'), unit('co2'), '', conv.co2FromKwh.estimated, conv.co2FromKwh.confirmed, '']);
  if (conv.eurFromKwh) rows.push([t('usecases.csv.eurFromKwh'), unit('euro'), '', conv.eurFromKwh.estimated, conv.eurFromKwh.confirmed, '']);
  const target = targetProgress(ctx, c, c.target_from || c.target_until ? await benefitByKind(ctx, c.id, c.target_from, c.target_until) : kinds);
  if (target) {
    rows.push([], [t('usecases.csv.target'), unit(target.kind), target.value, target.estimated, target.confirmed, `${target.confirmedPercent} %`]);
  }
  rows.push([], [t('usecases.csv.idea'), t('usecases.csv.title'), t('usecases.csv.kind'), t('usecases.csv.estimated'), t('usecases.csv.confirmed'), t('usecases.csv.status'), t('usecases.csv.closedOn')]);
  const ideas = await ctx.db.query<{ number: number; title: string; confidential: boolean; kind: string; value: number | null; confirmed: number | null; outcome: string | null; closed: string }>(
    `SELECT i.number, i.title, i.confidential, im.benefit_kind AS kind, im.benefit_value::float AS value, bc.confirmed_value::float AS confirmed, bc.outcome,
            im.closed_at::date::text AS closed
       FROM implementations im JOIN ideas i ON i.id = im.idea_id LEFT JOIN benefit_confirmations bc ON bc.idea_id = i.id
      WHERE i.challenge_id = $1 AND im.status = 'done' AND im.benefit_kind IS NOT NULL ORDER BY i.number`,
    [c.id],
  );
  const triage = isTriage(ctx.user);
  for (const i of ideas.rows) {
    rows.push([`#${i.number}`, i.confidential && !triage ? t('usecases.csv.confidential') : i.title, i.kind, i.value ?? '', i.confirmed ?? '',
      t(`usecases.csv.outcome.${i.outcome ?? 'open'}`), i.closed]);
  }
  return { title: c.title, rows };
}

/** Savings sentence for the success story (R3-32): value, unit, CO₂ from kWh and whether controlling confirmed it. */
export async function savingsText(ctx: Ctx, ideaId: string, locale: Locale): Promise<string | null> {
  const r = await ctx.db.query<{ kind: string | null; value: number | null; confirmed: number | null }>(
    `SELECT im.benefit_kind AS kind, im.benefit_value::float AS value, bc.confirmed_value::float AS confirmed
       FROM implementations im LEFT JOIN benefit_confirmations bc ON bc.idea_id = im.idea_id WHERE im.idea_id = $1 AND im.status = 'done'`,
    [ideaId],
  );
  const x = r.rows[0];
  if (!x?.kind) return null;
  const value = x.confirmed ?? x.value;
  if (value == null) return null;
  const t = (key: string, vars?: Record<string, string | number>) => tr(locale, m(key as MessageKey, vars));
  const fmtN = (n: number) => n.toLocaleString(locale === 'en' ? 'en-GB' : 'de-DE', { maximumFractionDigits: 2 });
  let text = `${fmtN(value)} ${t(`workflow.benefit.${x.kind}`)}`;
  if (x.kind === 'kwh') {
    const co2 = (value * ctx.settings.challenges.kgCo2PerKwh) / 1000;
    text += ` ${t('usecases.story.co2', { value: fmtN(round(co2, 2)), factor: fmtN(ctx.settings.challenges.kgCo2PerKwh) })}`;
  }
  return t(x.confirmed != null ? 'usecases.story.confirmed' : 'usecases.story.reported', { text });
}

export { loadUseCase };
