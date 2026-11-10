import { assertReviewedForGate2 } from '../ai/quality.js';
import { z } from 'zod';
import { checkBoundary } from '../lib/boundary.js';
import { can, hasRole, isDecider, isTriage, type Ctx, type SessionUser } from '../lib/context.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { cat, fmt, m, tr, type Text } from '../i18n/index.js';
import { addMonths, addWorkdays, trafficLight, workdaysBetween, type TrafficLight } from '../lib/workdays.js';
import { onElaborationStarted, onIdeaSubmitted } from '../ai/hooks.js';
import { audit } from './audit.js';
import { markPatentForward } from './invention.js';
import { narrowToIdea } from './areas.js';
import { notifyAuthors, notifyRoles, notifyUser } from './notify.js';
import { emitIdeaEvent } from './webhooks.js';

// Idea flow with fast lane and gates (product concept, "Status-Logik").

export const STATUSES = [
  'draft',
  'submitted',
  'in_question',
  'fast_lane',
  'elaboration',
  'forwarded',
  'rejected',
  'implementing',
  'piloting',
  'integrated',
  'parked',
  'completed',
  'closed_no_answer',
  'merged',
] as const;
export type Status = (typeof STATUSES)[number];

export interface IdeaRow {
  id: string;
  tenant_id: string;
  number: number;
  title: string;
  problem: string;
  solution: string;
  benefit: string;
  topic: string | null;
  idea_type: 'internal' | 'product';
  /** Idea or problem without a solution (R3-31; migration 025). */
  idea_kind?: 'idea' | 'problem';
  confidential: boolean;
  anonymous: boolean;
  status: Status;
  lane: string | null;
  challenge_id: string | null;
  author_id: string;
  submitted_by_id: string | null;
  author_confirmed: boolean;
  forwarded_to: string | null;
  resubmit_on: string | null;
  created_at: Date;
  submitted_at: Date | null;
  updated_at: Date;
  merged_into: string | null;
  // Release 2 (migration 004/005); optional so that hand-built rows stay valid.
  mentor_id?: string | null;
  timebox_until?: string | null;
  horizon?: number | null;
  effort_person_days?: number | null;
  effort_euro?: number | null;
  plan_benefit_euro?: number | null;
  sponsor_id?: string | null;
  custom_values?: Record<string, string | number>;
  team_name?: string | null;
  // External participation (R3-19, R3-21, migration 024).
  origin?: 'internal' | 'external';
  moderation?: 'pending' | 'approved' | 'hidden' | null;
  /** Loaded by loadIdea; co-authors have the same rights as the author (R1-15). */
  coauthor_ids?: string[];
}

export interface DeadlineRow {
  id: string;
  idea_id: string;
  phase: 'gate1' | 'elaboration';
  started_on: string;
  due_on: string;
  paused_on: string | null;
  completed_at: Date | null;
  reminded_at: Date | null;
  escalated_at: Date | null;
}

export interface DeadlineInfo {
  phase: 'gate1' | 'elaboration';
  dueOn: string;
  remainingWorkdays: number;
  light: TrafficLight;
  paused: boolean;
}

/** Vars {number} and {title} for catalogue texts that name an idea (R2-50). */
export const ideaVars = (idea: Pick<IdeaRow, 'number' | 'title'>) => ({ number: idea.number, title: idea.title });
const label = (idea: Pick<IdeaRow, 'number' | 'title'>): Text => m('workflow.ideaLabel', ideaVars(idea));

// ---------------------------------------------------------------- access

export async function implementationOwner(ctx: Ctx, ideaId: string): Promise<string | null> {
  const r = await ctx.db.query<{ owner_id: string }>('SELECT owner_id FROM implementations WHERE idea_id = $1', [ideaId]);
  return r.rows[0]?.owner_id ?? null;
}

export function isAuthor(user: SessionUser | null, idea: IdeaRow): boolean {
  return !!user && (idea.author_id === user.id || idea.submitted_by_id === user.id || !!idea.coauthor_ids?.includes(user.id));
}

export function canView(user: SessionUser | null, idea: IdeaRow, implOwner: string | null, representing: string[] = []): boolean {
  if (isAuthor(user, idea)) return true;
  if (idea.status === 'draft') return false;
  // Posts awaiting release or hidden by the moderation (R3-21) are treated like confidential ideas.
  if (!idea.confidential && (idea.moderation ?? 'approved') === 'approved') return true;
  // Confidential ideas: triage, the implementation owner (or deputy), the mentor and the sponsor (R2-01, R2-07).
  if (user && (idea.mentor_id === user.id || idea.sponsor_id === user.id)) return true;
  return isTriage(user) || (!!user && !!implOwner && (implOwner === user.id || representing.includes(implOwner)));
}

/** People the current user stands in for today (R1-11). */
export async function deputyOf(ctx: Ctx): Promise<string[]> {
  if (!ctx.user) return [];
  const r = await ctx.db.query<{ user_id: string }>(
    'SELECT DISTINCT user_id FROM absences WHERE deputy_id = $1 AND $2::date BETWEEN starts_on AND ends_on',
    [ctx.user.id, ctx.today],
  );
  return r.rows.map((x) => x.user_id);
}

/** Owner of an implementation or their deputy during an absence. */
export async function actsFor(ctx: Ctx, ownerId: string): Promise<boolean> {
  return ctx.user?.id === ownerId || (await deputyOf(ctx)).includes(ownerId);
}

/**
 * SQL predicate equivalent of canView for list queries. $1 = user id, $2 = triage for the whole
 * tenant (isTriageEverywhere). Triage for some areas only (R3-29) sees confidential ideas of
 * those areas through has_area_role.
 */
export const VISIBLE_SQL = `(
  i.author_id = $1 OR i.submitted_by_id IS NOT DISTINCT FROM $1
  OR EXISTS (SELECT 1 FROM idea_coauthors ca WHERE ca.idea_id = i.id AND ca.user_id = $1)
  OR (i.status <> 'draft' AND ((NOT i.confidential AND coalesce(i.moderation, 'approved') = 'approved') OR $2::boolean
      OR i.mentor_id IS NOT DISTINCT FROM $1 OR i.sponsor_id IS NOT DISTINCT FROM $1
      OR EXISTS (SELECT 1 FROM implementations im WHERE im.idea_id = i.id AND im.owner_id = $1)
      OR has_area_role($1, ARRAY['triage'], i.id)))
)`;

export async function loadIdea(ctx: Ctx, id: string, forUpdate = false): Promise<IdeaRow> {
  if (!z.uuid().safeParse(id).success) throw notFound(m('workflow.ideaNotFound'));
  const r = await ctx.db.query<IdeaRow>(`SELECT * FROM ideas WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  const idea = r.rows[0];
  if (!idea) throw notFound(m('workflow.ideaNotFound'));
  idea.coauthor_ids = (await ctx.db.query<{ user_id: string }>('SELECT user_id FROM idea_coauthors WHERE idea_id = $1', [id])).rows.map((x) => x.user_id);
  // Roles with a scope (R3-29): from here on only the roles valid for this idea count.
  await narrowToIdea(ctx, id);
  if (!canView(ctx.user, idea, await implementationOwner(ctx, id), await deputyOf(ctx))) throw notFound(m('workflow.ideaNotFound'));
  return idea;
}

export function requireStatus(idea: IdeaRow, ...allowed: Status[]): void {
  if (!allowed.includes(idea.status)) {
    throw conflict(m('workflow.invalidStatus', { status: idea.status }), 'INVALID_STATUS');
  }
}

export async function setStatus(ctx: Ctx, idea: IdeaRow, to: Status, kind: string, message: Text | null, extra: Record<string, unknown> = {}): Promise<void> {
  const cols = Object.keys(extra);
  const sets = cols.map((c, i) => `${c} = $${i + 3}`);
  await ctx.db.query(
    `UPDATE ideas SET status = $2, updated_at = now()${sets.length ? ', ' + sets.join(', ') : ''} WHERE id = $1`,
    [idea.id, to, ...cols.map((c) => extra[c])],
  );
  await ctx.db.query(
    'INSERT INTO idea_events (tenant_id, idea_id, actor_id, kind, from_status, to_status, message) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    // History is kept in the workspace language (German).
    [ctx.tenantId, idea.id, ctx.user?.id ?? null, kind, idea.status, to, message === null ? null : tr('de', message)],
  );
  const from = idea.status;
  idea.status = to;
  // Webhook (R3-17): every status change, in the same transaction.
  if (from !== to) await emitIdeaEvent(ctx, 'idea.status_changed', idea, { from, to, kind });
}

export async function addEvent(ctx: Ctx, idea: IdeaRow, kind: string, message: Text | null): Promise<void> {
  await ctx.db.query(
    'INSERT INTO idea_events (tenant_id, idea_id, actor_id, kind, from_status, to_status, message) VALUES ($1, $2, $3, $4, $5, $5, $6)',
    [ctx.tenantId, idea.id, ctx.user?.id ?? null, kind, idea.status, message === null ? null : tr('de', message)],
  );
}

// ---------------------------------------------------------------- deadlines (R1-25)

export async function startDeadline(ctx: Ctx, idea: IdeaRow, phase: DeadlineRow['phase'], workdays: number): Promise<void> {
  const due = addWorkdays(ctx.today, workdays, ctx.holidays);
  await ctx.db.query(
    'INSERT INTO deadlines (tenant_id, idea_id, phase, started_on, due_on) VALUES ($1, $2, $3, $4, $5)',
    [ctx.tenantId, idea.id, phase, ctx.today, due],
  );
  await audit(ctx, 'deadline.start', 'idea', idea.id, null, { phase, started_on: ctx.today, due_on: due });
}

export async function completeDeadlines(ctx: Ctx, idea: IdeaRow): Promise<void> {
  await ctx.db.query('UPDATE deadlines SET completed_at = now() WHERE idea_id = $1 AND completed_at IS NULL', [idea.id]);
}

async function pauseDeadline(ctx: Ctx, idea: IdeaRow): Promise<void> {
  await ctx.db.query(
    'UPDATE deadlines SET paused_on = $2 WHERE idea_id = $1 AND completed_at IS NULL AND paused_on IS NULL',
    [idea.id, ctx.today],
  );
  await audit(ctx, 'deadline.pause', 'idea', idea.id, null, { paused_on: ctx.today });
}

async function resumeDeadline(ctx: Ctx, idea: IdeaRow): Promise<void> {
  const r = await ctx.db.query<DeadlineRow>(
    'SELECT * FROM deadlines WHERE idea_id = $1 AND completed_at IS NULL AND paused_on IS NOT NULL',
    [idea.id],
  );
  for (const d of r.rows) {
    const pausedDays = Math.max(0, workdaysBetween(d.paused_on!, ctx.today, ctx.holidays));
    const due = addWorkdays(d.due_on, pausedDays, ctx.holidays);
    await ctx.db.query('UPDATE deadlines SET paused_on = NULL, due_on = $2, reminded_at = NULL WHERE id = $1', [d.id, due]);
    await audit(ctx, 'deadline.resume', 'idea', idea.id, { due_on: d.due_on }, { due_on: due, paused_workdays: pausedDays });
  }
}

export function deadlineInfo(ctx: Ctx, d: DeadlineRow): DeadlineInfo {
  const paused = d.paused_on !== null;
  const remaining = workdaysBetween(paused ? d.paused_on! : ctx.today, d.due_on, ctx.holidays);
  return {
    phase: d.phase,
    dueOn: d.due_on,
    remainingWorkdays: remaining,
    light: trafficLight(remaining, ctx.settings.deadlines.reminderWorkdaysBefore, paused),
    paused,
  };
}

// ---------------------------------------------------------------- submit (R1-12, R1-14, R1-17, R1-18)

export const ideaInput = z.object({
  title: z.string().trim().min(3).max(140),
  problem: z.string().trim().max(5000).default(''),
  solution: z.string().trim().max(5000).default(''),
  benefit: z.string().trim().max(3000).default(''),
  topic: z.string().trim().max(80).nullable().default(null),
  ideaType: z.enum(['internal', 'product']).default('internal'),
  // Problem exchange (R3-31): a problem needs no solution.
  ideaKind: z.enum(['idea', 'problem']).optional(),
  confidential: z.boolean().default(false),
  anonymous: z.boolean().default(false),
  challengeId: z.uuid().nullable().default(null),
  // Challenge fields (R2-35): values for the challenge's own fields and an optional team name.
  customValues: z.record(z.string().max(40), z.union([z.string().max(2000), z.number()])).optional(),
  teamName: z.string().trim().max(120).nullable().optional(),
  // Coach dialog or transcript kept as the original wording (R2-16, R2-17).
  originalText: z.string().max(20_000).nullable().optional(),
});
export type IdeaInput = z.infer<typeof ideaInput>;

// ---------------------------------------------------------------- challenge fields (R2-35)

export const customFieldSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]{1,40}$/),
  label: z.string().trim().min(1).max(120),
  type: z.enum(['text', 'number', 'select']),
  options: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  required: z.boolean().default(false),
});
export type CustomField = z.infer<typeof customFieldSchema>;

interface ChallengeFields {
  custom_fields: CustomField[];
  teams_allowed: boolean;
  /** Phase plan and current phase (R2-52): with a plan, ideas are taken only in the collect phase. */
  phase_plan: unknown;
  phase: string | null;
  /** Hackathon mode (R3-34): submissions only inside the window, locked afterwards. */
  hackathon: boolean;
  submission_opens_at: Date | null;
  submission_closes_at: Date | null;
}

async function challengeFields(ctx: Ctx, challengeId: string | null | undefined): Promise<ChallengeFields | null> {
  if (!challengeId) return null;
  const r = await ctx.db.query<ChallengeFields>('SELECT custom_fields, teams_allowed, phase_plan, phase, hackathon, submission_opens_at, submission_closes_at FROM challenges WHERE id = $1', [challengeId]);
  if (!r.rows[0]) throw badRequest(m('workflow.challengeNotFound'));
  return r.rows[0];
}

/**
 * Checks values against the challenge's fields. Unknown keys and empty values are dropped;
 * with requireAll, missing required fields are an error (at submission).
 */
export function cleanCustomValues(fields: CustomField[], values: Record<string, unknown>, requireAll: boolean): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  const missing: string[] = [];
  for (const f of fields) {
    const raw = values[f.id];
    const empty = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
    if (empty) {
      if (requireAll && f.required) missing.push(f.label);
      continue;
    }
    if (f.type === 'number') {
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(',', '.'));
      if (!Number.isFinite(n)) throw badRequest(m('workflow.fieldNumber', { label: f.label }));
      out[f.id] = n;
    } else if (f.type === 'select') {
      if (!f.options.includes(String(raw))) throw badRequest(m('workflow.fieldOption', { label: f.label }));
      out[f.id] = String(raw);
    } else {
      out[f.id] = String(raw).trim().slice(0, 2000);
    }
  }
  if (missing.length) throw badRequest(m('workflow.fieldsMissing', { fields: missing.join(', ') }), { missing });
  return out;
}

async function challengeExtras(ctx: Ctx, challengeId: string | null | undefined, input: Pick<IdeaInput, 'customValues' | 'teamName'>) {
  const fields = await challengeFields(ctx, challengeId);
  const values = input.customValues === undefined ? undefined : cleanCustomValues(fields?.custom_fields ?? [], input.customValues, false);
  if (input.teamName && !fields?.teams_allowed) throw badRequest(m('workflow.noTeams'));
  return { values, teamName: input.teamName === undefined ? undefined : input.teamName || null };
}

export async function createIdea(ctx: Ctx, input: IdeaInput, onBehalfOfUserId?: string): Promise<IdeaRow> {
  const user = ctx.user!;
  let authorId = user.id;
  let submittedBy: string | null = null;
  if (onBehalfOfUserId && onBehalfOfUserId !== user.id) {
    const other = await ctx.db.query('SELECT id FROM users WHERE id = $1 AND active', [onBehalfOfUserId]);
    if (!other.rowCount) throw badRequest(m('workflow.personNotFound'));
    authorId = onBehalfOfUserId;
    submittedBy = user.id;
  }
  const extras = await challengeExtras(ctx, input.challengeId, input);
  await ctx.db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ctx.tenantId]);
  const r = await ctx.db.query<IdeaRow>(
    `INSERT INTO ideas (tenant_id, number, title, problem, solution, benefit, topic, idea_type, confidential, anonymous,
                        challenge_id, author_id, submitted_by_id, author_confirmed, custom_values, team_name, original_text, idea_kind)
     VALUES ($1, (SELECT coalesce(max(number), 0) + 1 FROM ideas WHERE tenant_id = $1), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     RETURNING *`,
    [ctx.tenantId, input.title, input.problem, input.solution, input.benefit, input.topic, input.ideaType,
     input.confidential, input.anonymous, input.challengeId, authorId, submittedBy, submittedBy === null,
     JSON.stringify(extras.values ?? {}), extras.teamName ?? null, input.originalText ?? null, input.ideaKind ?? 'idea'],
  );
  const idea = r.rows[0];
  await ctx.db.query(
    'INSERT INTO idea_events (tenant_id, idea_id, actor_id, kind, to_status, message) VALUES ($1, $2, $3, $4, $5, $6)',
    [ctx.tenantId, idea.id, user.id, 'created', 'draft', submittedBy ? tr('de', m('workflow.event.onBehalf')) : null],
  );
  return idea;
}

export async function updateDraft(ctx: Ctx, idea: IdeaRow, input: Partial<IdeaInput>): Promise<void> {
  if (!isAuthor(ctx.user, idea)) throw forbidden();
  requireStatus(idea, 'draft');
  const map: Record<string, string> = {
    title: 'title', problem: 'problem', solution: 'solution', benefit: 'benefit', topic: 'topic',
    ideaType: 'idea_type', confidential: 'confidential', anonymous: 'anonymous', challengeId: 'challenge_id',
    originalText: 'original_text', ideaKind: 'idea_kind',
  };
  const entries: [string, unknown][] = Object.entries(input).filter(([k, v]) => k in map && v !== undefined);
  if (input.customValues !== undefined || input.teamName !== undefined) {
    const extras = await challengeExtras(ctx, input.challengeId === undefined ? idea.challenge_id : input.challengeId, input);
    if (extras.values !== undefined) {
      map.customValues = 'custom_values';
      entries.push(['customValues', JSON.stringify(extras.values)]);
    }
    if (extras.teamName !== undefined) {
      map.teamName = 'team_name';
      entries.push(['teamName', extras.teamName]);
    }
  }
  if (!entries.length) return;
  await ctx.db.query(
    `UPDATE ideas SET ${entries.map(([k], i) => `${map[k]} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
    [idea.id, ...entries.map(([, v]) => v)],
  );
}

export async function submitIdea(ctx: Ctx, idea: IdeaRow, opts: { confirmNotReport: boolean; boundaryAcknowledged?: boolean }): Promise<void> {
  if (!isAuthor(ctx.user, idea)) throw forbidden();
  requireStatus(idea, 'draft');
  if (!opts.confirmNotReport) {
    throw badRequest(m('workflow.confirmNotReport'));
  }
  // A problem (R3-31) needs no solution; the community and challenges look for it.
  const required = idea.idea_kind === 'problem' ? (['problem', 'benefit'] as const) : (['problem', 'solution', 'benefit'] as const);
  const missing = required.filter((f) => idea[f].trim().length < 10);
  if (missing.length) throw badRequest(m('workflow.describeMin'), { missing });
  if (!idea.topic) throw badRequest(m('workflow.chooseTopic'));
  const fields = await challengeFields(ctx, idea.challenge_id);
  const customValues = cleanCustomValues(fields?.custom_fields ?? [], idea.custom_values ?? {}, true);
  if (idea.team_name && !fields?.teams_allowed) throw badRequest(m('workflow.noTeams'));
  if (fields?.phase_plan && fields.phase !== 'collect') throw conflict(m('challenges.submitOnlyCollect'), 'CHALLENGE_PHASE');
  if (fields?.hackathon && !submissionWindowOpen(fields)) throw conflict(m('usecases.windowClosed'), 'SUBMISSION_WINDOW');
  const matches = checkBoundary(`${idea.title} ${idea.problem} ${idea.solution} ${idea.benefit}`, ctx.settings);
  if (matches.length && !opts.boundaryAcknowledged) {
    throw conflict(m('workflow.boundary'), 'BOUNDARY_CHECK', { matches });
  }
  await setStatus(ctx, idea, 'submitted', 'submitted', null, { submitted_at: new Date(), custom_values: JSON.stringify(customValues) });
  await startDeadline(ctx, idea, 'gate1', ctx.settings.deadlines.gate1Workdays);
  await emitIdeaEvent(ctx, 'idea.submitted', idea);
  await onIdeaSubmitted(ctx, idea.id);
  await notifyRoles(ctx, ['triage'], m('workflow.newIdea.subject', ideaVars(idea)), m('workflow.newIdea.body', ideaVars(idea)), idea.id);
  if (idea.submitted_by_id) {
    await notifyUser(ctx, idea.author_id, m('workflow.onBehalf.subject', ideaVars(idea)),
      m('workflow.onBehalf.body', { ...ideaVars(idea), name: ctx.user!.displayName }), idea.id, 'my_ideas');
  }
}

export async function confirmAuthorship(ctx: Ctx, idea: IdeaRow): Promise<void> {
  if (ctx.user?.id !== idea.author_id) throw forbidden();
  await ctx.db.query('UPDATE ideas SET author_confirmed = true WHERE id = $1', [idea.id]);
  await addEvent(ctx, idea, 'authorship_confirmed', null);
}

// ---------------------------------------------------------------- questions (R1-27)

export async function askQuestion(ctx: Ctx, idea: IdeaRow, question: string): Promise<void> {
  if (!isTriage(ctx.user)) throw forbidden();
  requireStatus(idea, 'submitted');
  const rounds = Number((await ctx.db.query('SELECT count(*) FROM questions WHERE idea_id = $1', [idea.id])).rows[0].count);
  if (rounds >= ctx.settings.deadlines.maxQuestionRounds) {
    throw conflict(m('workflow.maxQuestions', { max: ctx.settings.deadlines.maxQuestionRounds }), 'MAX_QUESTIONS');
  }
  await ctx.db.query(
    'INSERT INTO questions (tenant_id, idea_id, round, question, asked_by, asked_on) VALUES ($1, $2, $3, $4, $5, $6)',
    [ctx.tenantId, idea.id, rounds + 1, question, ctx.user!.id, ctx.today],
  );
  await setStatus(ctx, idea, 'in_question', 'question', question);
  await pauseDeadline(ctx, idea);
  await notifyAuthors(ctx, idea, m('workflow.question.subject', ideaVars(idea)), m('workflow.question.body', { question }));
}

export async function answerQuestion(ctx: Ctx, idea: IdeaRow, answer: string): Promise<void> {
  if (!isAuthor(ctx.user, idea)) throw forbidden();
  requireStatus(idea, 'in_question');
  await ctx.db.query(
    'UPDATE questions SET answer = $2, answered_at = now() WHERE idea_id = $1 AND answer IS NULL',
    [idea.id, answer],
  );
  await setStatus(ctx, idea, 'submitted', 'answer', answer);
  await resumeDeadline(ctx, idea);
  await notifyRoles(ctx, ['triage'], m('workflow.answer.subject', ideaVars(idea)), answer, idea.id);
}

// ---------------------------------------------------------------- Gate 1: triage (R1-24, R1-28, R1-29)

export const triageInput = z.discriminatedUnion('lane', [
  z.object({
    lane: z.literal('fast_lane'),
    reason: z.string().trim().max(3000).optional(),
    message: z.string().trim().max(3000).optional(),
    ownerId: z.uuid(),
    orgUnit: z.string().trim().min(1).max(120),
    targetDate: z.iso.date(),
  }),
  z.object({
    lane: z.literal('elaborate'),
    reason: z.string().trim().max(3000).optional(),
    message: z.string().trim().max(3000).optional(),
    // Mentor and timebox (R2-01). Optional in the API; the UI asks for the mentor.
    mentorId: z.uuid().optional(),
    timeboxUntil: z.iso.date().optional(),
  }),
  z.object({
    lane: z.literal('forward'),
    reason: z.string().trim().min(10).max(3000),
    message: z.string().trim().max(3000).optional(),
    channelId: z.string().min(1),
    deleteContent: z.boolean().default(false),
  }),
  z.object({
    lane: z.literal('reject'),
    reason: z.string().trim().min(10).max(3000),
    message: z.string().trim().max(3000).optional(),
  }),
]);
export type TriageInput = z.infer<typeof triageInput>;

export async function requireActiveUser(ctx: Ctx, userId: string): Promise<void> {
  const r = await ctx.db.query('SELECT 1 FROM users WHERE id = $1 AND active', [userId]);
  if (!r.rowCount) throw badRequest(m('workflow.ownerNotFound'));
}

export interface TriageResult {
  /** Set when the chosen mentor already has many active ideas (R2-01). */
  warning?: string;
}

// ---------------------------------------------------------------- mentor and timebox (R2-01)

/** Number of ideas in elaboration per mentor. */
export async function mentorLoad(ctx: Ctx, userIds: string[], exceptIdeaId?: string): Promise<Map<string, number>> {
  const r = await ctx.db.query<{ mentor_id: string; n: number }>(
    `SELECT mentor_id, count(*)::int AS n FROM ideas
      WHERE status = 'elaboration' AND mentor_id = ANY($1::uuid[]) AND id IS DISTINCT FROM $2::uuid GROUP BY mentor_id`,
    [userIds, exceptIdeaId ?? null],
  );
  return new Map(r.rows.map((x) => [x.mentor_id, x.n]));
}

export function mentorWarning(ctx: Ctx, active: number): string | undefined {
  const max = ctx.settings.elaboration.mentorWarnActive;
  return active >= max ? tr(ctx.locale, m('workflow.mentorWarning', { active, max })) : undefined;
}

export function defaultTimebox(ctx: Ctx): string {
  const d = new Date(`${ctx.today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + ctx.settings.elaboration.timeboxWeeks * 7);
  return d.toISOString().slice(0, 10);
}

/** Sets mentor and timebox of an idea in elaboration and gives the mentor a task. */
export async function assignMentor(ctx: Ctx, idea: IdeaRow, mentorId: string | null, timeboxUntil?: string): Promise<TriageResult> {
  const until = timeboxUntil ?? idea.timebox_until ?? defaultTimebox(ctx);
  if (until < ctx.today) throw badRequest(m('workflow.timeboxPast'));
  let warning: string | undefined;
  if (mentorId) {
    await requireActiveUser(ctx, mentorId);
    warning = mentorWarning(ctx, (await mentorLoad(ctx, [mentorId], idea.id)).get(mentorId) ?? 0);
  }
  const changedMentor = mentorId !== (idea.mentor_id ?? null);
  await ctx.db.query(
    `UPDATE ideas SET mentor_id = $2, timebox_until = $3, updated_at = now(),
       timebox_reminded_at = CASE WHEN timebox_until IS DISTINCT FROM $3::date THEN NULL ELSE timebox_reminded_at END,
       timebox_exceeded_at = CASE WHEN timebox_until IS DISTINCT FROM $3::date THEN NULL ELSE timebox_exceeded_at END
     WHERE id = $1`,
    [idea.id, mentorId, until],
  );
  await audit(ctx, 'idea.mentor', 'idea', idea.id, { mentor_id: idea.mentor_id ?? null, timebox_until: idea.timebox_until ?? null }, { mentor_id: mentorId, timebox_until: until });
  idea.mentor_id = mentorId;
  idea.timebox_until = until;
  if (mentorId && changedMentor) {
    await addEvent(ctx, idea, 'mentor_assigned', m('workflow.event.mentorAssigned', { until }));
    await notifyUser(ctx, mentorId, m('workflow.mentor.subject', ideaVars(idea)), m('workflow.mentor.body', { ...ideaVars(idea), until }), idea.id);
  }
  return { warning };
}

export async function triageIdea(ctx: Ctx, idea: IdeaRow, input: TriageInput): Promise<TriageResult> {
  if (!isTriage(ctx.user)) throw forbidden();
  requireStatus(idea, 'submitted');
  const t = ctx.settings.texts;
  const reason = input.reason ?? null;
  let toStatus: Status;
  // Tenant text (or the triage team's own message) followed by catalogue lines.
  const authorParts: Text[] = [input.message ?? t[input.lane]];
  const extra: Record<string, unknown> = { lane: input.lane };
  let ownerId: string | null = null;
  let patentClaim: { claimUntil: string; months: number } | null = null;

  switch (input.lane) {
    case 'fast_lane': {
      if (input.targetDate < ctx.today) throw badRequest(m('workflow.targetDatePast'));
      await requireActiveUser(ctx, input.ownerId);
      ownerId = input.ownerId;
      toStatus = 'fast_lane';
      await ctx.db.query(
        `INSERT INTO implementations (tenant_id, idea_id, owner_id, channel, org_unit, target_date, status)
         VALUES ($1, $2, $3, 'line', $4, $5, 'proposed')`,
        [ctx.tenantId, idea.id, input.ownerId, input.orgUnit, input.targetDate],
      );
      await notifyUser(ctx, input.ownerId, m('workflow.handover.subject', ideaVars(idea)),
        m('workflow.handover.body', { ...ideaVars(idea), date: input.targetDate }), idea.id);
      break;
    }
    case 'elaborate':
      toStatus = 'elaboration';
      if (input.mentorId) await requireActiveUser(ctx, input.mentorId);
      if (input.timeboxUntil && input.timeboxUntil < ctx.today) throw badRequest(m('workflow.timeboxPast'));
      break;
    case 'forward': {
      const channel = ctx.settings.targetChannels.find((c) => c.id === input.channelId);
      if (!channel) throw badRequest(m('workflow.unknownChannel'));
      toStatus = 'forwarded';
      extra.forwarded_to = channel.name;
      authorParts.push('\n\n', m('workflow.forwarded', { name: channel.name, contact: channel.contact }));
      if (channel.url) authorParts.push('\n', m('workflow.forwardedLink', { url: channel.url }));
      if (input.deleteContent) {
        const removed = tr('de', m('workflow.contentRemoved'));
        Object.assign(extra, { problem: removed, solution: removed, benefit: removed });
      }
      // Possible invention (R3-25): confidential from now on, claim period noted.
      if (channel.kind === 'patent') {
        patentClaim = await markPatentForward(ctx, idea.id);
        idea.confidential = true;
        authorParts.push('\n\n', m('compliance.invention.authorLine'));
      }
      break;
    }
    case 'reject':
      toStatus = 'rejected';
      break;
  }
  if (reason) authorParts.push('\n\n', m('workflow.reasonLine', { reason }));
  const authorText = cat(authorParts);

  await ctx.db.query(
    'INSERT INTO decisions (tenant_id, idea_id, gate, outcome, reason, owner_id, decided_by) VALUES ($1, $2, 1, $3, $4, $5, $6)',
    [ctx.tenantId, idea.id, input.lane, reason, ownerId, ctx.user!.id],
  );
  await audit(ctx, 'gate1.decision', 'idea', idea.id, { status: idea.status }, { lane: input.lane, reason, ownerId });
  await completeDeadlines(ctx, idea);
  await setStatus(ctx, idea, toStatus, 'gate1', authorText, extra);
  if (patentClaim) await addEvent(ctx, idea, 'invention_forwarded', m('compliance.invention.deadline', { months: patentClaim.months, date: patentClaim.claimUntil }));
  await emitIdeaEvent(ctx, 'idea.gate_decided', idea, { gate: 1, outcome: input.lane });
  let result: TriageResult = {};
  if (toStatus === 'elaboration' && input.lane === 'elaborate') {
    await startDeadline(ctx, idea, 'elaboration', ctx.settings.deadlines.elaborationWorkdays);
    result = await assignMentor(ctx, idea, input.mentorId ?? null, input.timeboxUntil);
    await onElaborationStarted(ctx, idea.id);
  }
  await notifyAuthors(ctx, idea, m('workflow.feedback.subject', ideaVars(idea)), authorText);
  return result;
}

// ---------------------------------------------------------------- Gate 2: decision (R1-30)

export const decisionInput = z.object({
  outcome: z.enum(['implement', 'pilot', 'integrate', 'park', 'reject']),
  reason: z.string().trim().min(10).max(3000),
  ownerId: z.uuid().optional(),
  targetDate: z.iso.date().optional(),
  channel: z.enum(['line', 'project', 'backlog', 'experiment']).optional(),
  resubmitOn: z.iso.date().optional(),
  // Sponsor who confirms the impact review at Gate 3 (R2-07).
  sponsorId: z.uuid().optional(),
});
export type DecisionInput = z.infer<typeof decisionInput>;

// ---------------------------------------------------------------- delegation (R2-05)

export interface DelegationCheck {
  allowed: boolean;
  reason?: Text;
}

/**
 * A head of department (role "lead") may decide Gate 2 alone when both effort estimates are set,
 * both are within the tenant thresholds, and the idea comes from the lead's own org unit.
 */
export async function delegationCheck(ctx: Ctx, idea: IdeaRow): Promise<DelegationCheck> {
  const u = ctx.user;
  if (!can(u, 'gate2Delegated')) return { allowed: false, reason: m('workflow.delegation.leadOnly') };
  const t = ctx.settings.thresholds;
  if (idea.effort_person_days == null || idea.effort_euro == null) {
    return { allowed: false, reason: m('workflow.delegation.noEffort') };
  }
  if (Number(idea.effort_person_days) > t.delegationMaxPersonDays || Number(idea.effort_euro) > t.delegationMaxEuro) {
    return {
      allowed: false,
      reason: m('workflow.delegation.overThreshold', { days: t.delegationMaxPersonDays, euro: fmt.number(ctx.locale, t.delegationMaxEuro) }),
    };
  }
  const author = await ctx.db.query<{ org_unit: string | null }>('SELECT org_unit FROM users WHERE id = $1', [idea.author_id]);
  const unit = author.rows[0]?.org_unit ?? null;
  if (!u!.orgUnit || !unit || unit !== u!.orgUnit) return { allowed: false, reason: m('workflow.delegation.otherUnit') };
  return { allowed: true };
}

/** Whether the current user may decide Gate 2 for this idea, and whether that is a delegated decision. */
export async function gate2Authority(ctx: Ctx, idea: IdeaRow): Promise<{ allowed: boolean; delegated: boolean; reason?: Text }> {
  if (isDecider(ctx.user)) return { allowed: true, delegated: false };
  const d = await delegationCheck(ctx, idea);
  return { allowed: d.allowed, delegated: d.allowed, reason: d.reason };
}

const OUTCOME_STATUS: Record<DecisionInput['outcome'], Status> = {
  implement: 'implementing',
  pilot: 'piloting',
  integrate: 'integrated',
  park: 'parked',
  reject: 'rejected',
};

const OUTCOME_LABEL = (o: DecisionInput['outcome']): Text => m(`workflow.outcome.${o}`);

export async function decideGate2(ctx: Ctx, idea: IdeaRow, input: DecisionInput, opts: { meetingId?: string } = {}): Promise<void> {
  const authority = await gate2Authority(ctx, idea);
  if (!authority.allowed) throw forbidden(hasRole(ctx.user, 'lead') && authority.reason ? cat([m('workflow.delegation.forbidden'), ': ', authority.reason]) : undefined);
  requireStatus(idea, 'elaboration');
  // Setting "alle KI-Bausteine geprüft vor Gate 2" (R2-44).
  await assertReviewedForGate2(ctx, idea.id);
  const extra: Record<string, unknown> = {};
  if (input.sponsorId) {
    await requireActiveUser(ctx, input.sponsorId);
    extra.sponsor_id = input.sponsorId;
  }
  const needsOwner = ['implement', 'pilot', 'integrate'].includes(input.outcome);
  if (needsOwner) {
    if (!input.ownerId || !input.targetDate) throw badRequest(m('workflow.ownerAndDateRequired'));
    if (input.targetDate < ctx.today) throw badRequest(m('workflow.targetDatePast'));
    await requireActiveUser(ctx, input.ownerId);
  }
  if (input.outcome === 'park') {
    const max = addMonths(ctx.today, ctx.settings.deadlines.maxParkMonths);
    if (!input.resubmitOn || input.resubmitOn <= ctx.today || input.resubmitOn > max) {
      throw badRequest(m('workflow.parkUntil', { max }));
    }
    extra.resubmit_on = input.resubmitOn;
  }
  await ctx.db.query(
    `INSERT INTO decisions (tenant_id, idea_id, gate, outcome, reason, owner_id, resubmit_on, decided_by, delegated, meeting_id)
     VALUES ($1, $2, 2, $3, $4, $5, $6, $7, $8, $9)`,
    [ctx.tenantId, idea.id, input.outcome, input.reason, input.ownerId ?? null, input.resubmitOn ?? null, ctx.user!.id,
     authority.delegated, opts.meetingId ?? null],
  );
  await audit(ctx, 'gate2.decision', 'idea', idea.id, { status: idea.status }, { ...input, delegated: authority.delegated, meetingId: opts.meetingId ?? null });
  await completeDeadlines(ctx, idea);
  if (needsOwner) {
    const channel = input.channel ?? (input.outcome === 'pilot' ? 'experiment' : input.outcome === 'integrate' ? 'project' : 'project');
    // An idea can come back to Gate 2 after an experiment (R2-06); then the implementation is replaced.
    await ctx.db.query(
      `INSERT INTO implementations (tenant_id, idea_id, owner_id, channel, target_date, status, accepted_at)
       VALUES ($1, $2, $3, $4, $5, 'active', now())
       ON CONFLICT (idea_id) DO UPDATE SET owner_id = EXCLUDED.owner_id, channel = EXCLUDED.channel, target_date = EXCLUDED.target_date,
         status = 'active', accepted_at = now(), progress = 0, external_ref = NULL, benefit_kind = NULL, benefit_value = NULL,
         benefit_evidence = NULL, closed_at = NULL, overdue_reminded_at = NULL`,
      [ctx.tenantId, idea.id, input.ownerId, channel, input.targetDate],
    );
    await notifyUser(ctx, input.ownerId!, m('workflow.owner.subject', ideaVars(idea)),
      cat([m('workflow.gate2.decision'), ': ', OUTCOME_LABEL(input.outcome), '. ', m('workflow.owner.body', { date: input.targetDate })]), idea.id);
  }
  const parts: Text[] = [m(authority.delegated ? 'workflow.gate2.decisionDelegated' : 'workflow.gate2.decision'), ': ', OUTCOME_LABEL(input.outcome), '.\n\n', m('workflow.reasonLine', { reason: input.reason })];
  if (input.outcome === 'park') parts.push('\n\n', m('workflow.gate2.resubmitOn', { date: input.resubmitOn }));
  const text = cat(parts);
  await setStatus(ctx, idea, OUTCOME_STATUS[input.outcome], 'gate2', text, extra);
  await emitIdeaEvent(ctx, 'idea.gate_decided', idea, { gate: 2, outcome: input.outcome, delegated: authority.delegated });
  await notifyAuthors(ctx, idea, m('workflow.decision.subject', ideaVars(idea)), text);
}

// ---------------------------------------------------------------- implementation and benefit (R1-29, R1-31, R1-32)

export interface ImplementationRow {
  id: string;
  idea_id: string;
  owner_id: string;
  channel: string;
  org_unit: string | null;
  external_ref: string | null;
  target_date: string;
  progress: number;
  status: 'proposed' | 'active' | 'done';
  accepted_at: Date | null;
  benefit_kind: string | null;
  benefit_value: number | null;
  benefit_evidence: string | null;
  closed_at: Date | null;
}

async function loadImplementation(ctx: Ctx, idea: IdeaRow): Promise<ImplementationRow> {
  const r = await ctx.db.query<ImplementationRow>('SELECT * FROM implementations WHERE idea_id = $1 FOR UPDATE', [idea.id]);
  if (!r.rows[0]) throw notFound(m('workflow.noImplementation'));
  return r.rows[0];
}

async function requireOwnerOrTriage(ctx: Ctx, impl: ImplementationRow): Promise<void> {
  if (!isTriage(ctx.user) && !(await actsFor(ctx, impl.owner_id))) throw forbidden();
}

export async function acceptImplementation(ctx: Ctx, idea: IdeaRow): Promise<void> {
  const impl = await loadImplementation(ctx, idea);
  if (!(await actsFor(ctx, impl.owner_id))) throw forbidden(m('workflow.acceptOwnerOnly'));
  if (impl.status !== 'proposed') throw conflict(m('workflow.alreadyAccepted'));
  await ctx.db.query("UPDATE implementations SET status = 'active', accepted_at = now() WHERE id = $1", [impl.id]);
  await addEvent(ctx, idea, 'implementation_accepted', m('workflow.event.accepted', { name: ctx.user!.displayName }));
  await notifyAuthors(ctx, idea, m('workflow.started.subject', ideaVars(idea)), m('workflow.started.body', { name: ctx.user!.displayName }));
}

export const implementationUpdate = z.object({
  progress: z.number().int().min(0).max(100).optional(),
  externalRef: z.string().trim().max(300).nullable().optional(),
  targetDate: z.iso.date().optional(),
  channel: z.enum(['line', 'project', 'backlog', 'experiment']).optional(),
});

export async function updateImplementation(ctx: Ctx, idea: IdeaRow, input: z.infer<typeof implementationUpdate>): Promise<void> {
  const impl = await loadImplementation(ctx, idea);
  await requireOwnerOrTriage(ctx, impl);
  if (impl.status === 'done') throw conflict(m('workflow.implementationDone'));
  const next = {
    progress: input.progress ?? impl.progress,
    external_ref: input.externalRef === undefined ? impl.external_ref : input.externalRef,
    target_date: input.targetDate ?? impl.target_date,
    channel: input.channel ?? impl.channel,
  };
  await ctx.db.query(
    `UPDATE implementations SET progress = $2, external_ref = $3, target_date = $4, channel = $5,
       overdue_reminded_at = CASE WHEN $4 <> target_date THEN NULL ELSE overdue_reminded_at END
     WHERE id = $1`,
    [impl.id, next.progress, next.external_ref, next.target_date, next.channel],
  );
  if (next.target_date !== impl.target_date) {
    await audit(ctx, 'implementation.target_date', 'idea', idea.id, { target_date: impl.target_date }, { target_date: next.target_date });
  }
  await addEvent(ctx, idea, 'implementation_progress', m('workflow.event.progress', { progress: next.progress, date: next.target_date }));
}

export const closeInput = z.object({
  benefitKind: z.enum(['euro', 'hours', 'quality', 'revenue', 'co2', 'kwh']),
  benefitValue: z.number().min(0).nullable(),
  benefitEvidence: z.string().trim().min(10).max(3000),
  // Actual effort, optional; it feeds the effort estimate and the calibration (R4-06, R4-07).
  actualEffortPersonDays: z.number().min(0).max(1_000_000).nullable().optional(),
  actualEffortEuro: z.number().min(0).max(1_000_000_000).nullable().optional(),
});

const BENEFIT_LABEL = (kind: z.infer<typeof closeInput>['benefitKind']): Text => m(`workflow.benefit.${kind}`);

export async function closeImplementation(ctx: Ctx, idea: IdeaRow, input: z.infer<typeof closeInput>): Promise<void> {
  const impl = await loadImplementation(ctx, idea);
  await requireOwnerOrTriage(ctx, impl);
  if (impl.status !== 'active') throw conflict(m('workflow.onlyActiveClose'));
  await ctx.db.query(
    `UPDATE implementations SET status = 'done', progress = 100, benefit_kind = $2, benefit_value = $3,
       benefit_evidence = $4, closed_at = now(), actual_effort_person_days = $5, actual_effort_euro = $6 WHERE id = $1`,
    [impl.id, input.benefitKind, input.benefitValue, input.benefitEvidence, input.actualEffortPersonDays ?? null, input.actualEffortEuro ?? null],
  );
  await audit(ctx, 'implementation.close', 'idea', idea.id, null, input);
  // Gate 3: impact review after a configurable number of months (R2-07).
  const dueOn = addMonths(ctx.today, ctx.settings.elaboration.impactReviewMonths);
  const reviewer = idea.mentor_id ?? impl.owner_id;
  await ctx.db.query(
    `INSERT INTO impact_reviews (tenant_id, idea_id, reviewer_id, due_on, plan_value) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (idea_id) DO NOTHING`,
    [ctx.tenantId, idea.id, reviewer, dueOn, idea.plan_benefit_euro ?? null],
  );
  const value = input.benefitValue != null ? cat([`${input.benefitValue} `, BENEFIT_LABEL(input.benefitKind)]) : BENEFIT_LABEL(input.benefitKind);
  const text = cat([m('workflow.completed.benefit'), ': ', value, '.\n', m('workflow.completed.evidence', { evidence: input.benefitEvidence }), '\n\n', m('workflow.completed.thanks')]);
  await setStatus(ctx, idea, 'completed', 'completed', text);
  await notifyAuthors(ctx, idea, m('workflow.completed.subject', ideaVars(idea)), text);
}

// ---------------------------------------------------------------- satisfaction (R1-35)

const FEEDBACK_PHASES: Record<string, string> = {
  gate1: 'gate1', gate2: 'gate2', completed: 'completed', closed: 'closed',
};

/** The latest answered phase for which the author has not yet rated the feedback. */
export async function pendingFeedbackPhase(ctx: Ctx, idea: IdeaRow): Promise<string | null> {
  if (ctx.user?.id !== idea.author_id) return null;
  const r = await ctx.db.query<{ kind: string }>(
    `SELECT e.kind FROM idea_events e WHERE e.idea_id = $1 AND e.kind = ANY($2::text[]) ORDER BY e.id DESC LIMIT 1`,
    [idea.id, Object.keys(FEEDBACK_PHASES)],
  );
  const phase = r.rows[0]?.kind;
  if (!phase) return null;
  const done = await ctx.db.query('SELECT 1 FROM feedback WHERE idea_id = $1 AND user_id = $2 AND phase = $3', [idea.id, ctx.user.id, phase]);
  return done.rowCount ? null : phase;
}

export async function rateFeedback(ctx: Ctx, idea: IdeaRow, score: number, comment: string | null): Promise<void> {
  const phase = await pendingFeedbackPhase(ctx, idea);
  if (!phase) throw conflict(m('workflow.noRatingOpen'));
  await ctx.db.query(
    'INSERT INTO feedback (tenant_id, idea_id, user_id, phase, score, comment) VALUES ($1, $2, $3, $4, $5, $6)',
    [ctx.tenantId, idea.id, ctx.user!.id, phase, score, comment],
  );
}

// ---------------------------------------------------------------- background rules (R1-26, R1-33, R1-31)

export async function closeUnanswered(ctx: Ctx, idea: IdeaRow): Promise<void> {
  const text = m('workflow.closedUnanswered', { days: ctx.settings.deadlines.questionTimeoutWorkdays });
  await completeDeadlines(ctx, idea);
  await setStatus(ctx, idea, 'closed_no_answer', 'closed', text);
  await notifyAuthors(ctx, idea, m('workflow.closed.subject', ideaVars(idea)), text);
}

export async function resubmitParked(ctx: Ctx, idea: IdeaRow): Promise<void> {
  await setStatus(ctx, idea, 'elaboration', 'resubmission', m('workflow.event.resubmission', { date: idea.resubmit_on }), { resubmit_on: null });
  await startDeadline(ctx, idea, 'elaboration', ctx.settings.deadlines.gate1Workdays);
  await notifyRoles(ctx, ['triage', 'committee'], m('workflow.resubmission.subject', ideaVars(idea)), m('workflow.resubmission.body', ideaVars(idea)), idea.id);
  // R2-32: analyses are refreshed so the committee sees current figures.
  await onElaborationStarted(ctx, idea.id);
}

// ---------------------------------------------------------------- merge (R1-20)

export async function mergeIdeas(ctx: Ctx, source: IdeaRow, target: IdeaRow, reason: string): Promise<void> {
  if (!isTriage(ctx.user)) throw forbidden();
  if (source.id === target.id) throw badRequest(m('workflow.mergeSelf'));
  requireStatus(source, 'submitted', 'in_question');
  if (['draft', 'merged', 'rejected', 'closed_no_answer', 'forwarded'].includes(target.status)) {
    throw conflict(m('workflow.mergeTargetInvalid'), 'INVALID_STATUS');
  }
  await ctx.db.query('UPDATE comments SET idea_id = $2 WHERE idea_id = $1', [source.id, target.id]);
  await ctx.db.query(
    `INSERT INTO supports (tenant_id, idea_id, user_id)
     SELECT tenant_id, $2::uuid, user_id FROM supports WHERE idea_id = $1
     UNION SELECT tenant_id, $2::uuid, author_id FROM ideas WHERE id = $1
     ON CONFLICT DO NOTHING`,
    [source.id, target.id],
  );
  // The supporter of the merged idea who wrote the target idea itself is not a supporter.
  await ctx.db.query('DELETE FROM supports WHERE idea_id = $1 AND user_id = $2', [target.id, target.author_id]);
  await ctx.db.query('DELETE FROM supports WHERE idea_id = $1', [source.id]);
  await ctx.db.query(
    `INSERT INTO idea_coauthors (tenant_id, idea_id, user_id, added_by)
     SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid UNION SELECT $1::uuid, $2::uuid, user_id, $4::uuid FROM idea_coauthors WHERE idea_id = $5
     ON CONFLICT DO NOTHING`,
    [ctx.tenantId, target.id, source.author_id, ctx.user!.id, source.id],
  );
  await ctx.db.query('DELETE FROM idea_coauthors WHERE idea_id = $1 AND user_id = $2', [target.id, target.author_id]);
  await completeDeadlines(ctx, source);
  await audit(ctx, 'idea.merge', 'idea', source.id, null, { into: target.id, reason });
  const text = cat([m('workflow.merged.body', ideaVars(target)), '\n\n', m('workflow.reasonLine', { reason })]);
  await setStatus(ctx, source, 'merged', 'merged', text, { merged_into: target.id });
  await addEvent(ctx, target, 'merged_in', m('workflow.event.mergedIn', ideaVars(source)));
  await notifyAuthors(ctx, source, m('workflow.merged.subject', ideaVars(source)), text);
  await notifyAuthors(ctx, target, m('workflow.mergedTarget.subject', ideaVars(target)), m('workflow.mergedTarget.body', ideaVars(source)));
}

// ---------------------------------------------------------------- co-authors (R1-15)

/** Hackathon (R3-34): inside the submission window, or always when no window is set. */
export function submissionWindowOpen(c: { submission_opens_at: Date | null; submission_closes_at: Date | null }, now = new Date()): boolean {
  return (!c.submission_opens_at || now >= new Date(c.submission_opens_at)) && (!c.submission_closes_at || now < new Date(c.submission_closes_at));
}

/** After the submission window of a hackathon, the team of a submitted idea is locked; triage may still change it. */
async function assertTeamOpen(ctx: Ctx, idea: IdeaRow): Promise<void> {
  if (!idea.challenge_id || isTriage(ctx.user) || idea.status === 'draft') return;
  const r = await ctx.db.query<{ closed: boolean }>(
    'SELECT hackathon AND submission_closes_at IS NOT NULL AND submission_closes_at <= now() AS closed FROM challenges WHERE id = $1',
    [idea.challenge_id],
  );
  if (r.rows[0]?.closed) throw conflict(m('usecases.teamLocked'), 'SUBMISSION_WINDOW');
}

export async function addCoauthor(ctx: Ctx, idea: IdeaRow, userId: string): Promise<void> {
  if (!isAuthor(ctx.user, idea) && !isTriage(ctx.user)) throw forbidden();
  if (userId === idea.author_id) throw badRequest(m('workflow.alreadyAuthor'));
  await assertTeamOpen(ctx, idea);
  await requireActiveUser(ctx, userId);
  const r = await ctx.db.query(
    'INSERT INTO idea_coauthors (tenant_id, idea_id, user_id, added_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
    [ctx.tenantId, idea.id, userId, ctx.user!.id],
  );
  if (!r.rowCount) return;
  await addEvent(ctx, idea, 'coauthor_added', null);
  await notifyUser(ctx, userId, m('workflow.coauthor.subject', ideaVars(idea)),
    m('workflow.coauthor.body', { ...ideaVars(idea), name: ctx.user!.displayName }), idea.id, 'my_ideas');
}

export async function removeCoauthor(ctx: Ctx, idea: IdeaRow, userId: string): Promise<void> {
  if (!isAuthor(ctx.user, idea) && !isTriage(ctx.user)) throw forbidden();
  await assertTeamOpen(ctx, idea);
  await ctx.db.query('DELETE FROM idea_coauthors WHERE idea_id = $1 AND user_id = $2', [idea.id, userId]);
}

export { label as ideaLabel };
