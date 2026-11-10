import { z } from 'zod';
import { can, hasRole, isDecider, isTriage, isTriageEverywhere, type Ctx } from '../lib/context.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { cat, fmt, m, tr, type Text } from '../i18n/index.js';
import type { Settings } from '../lib/settings.js';
import { isWorkday, workdaysBetween } from '../lib/workdays.js';
import { audit } from './audit.js';
import { notifyAuthors, notifyRoles, notifyUser } from './notify.js';
import { emitIdeaEvent } from './webhooks.js';
import {
  VISIBLE_SQL,
  actsFor,
  addEvent,
  assignMentor,
  completeDeadlines,
  decideGate2,
  defaultTimebox,
  gate2Authority,
  ideaVars,
  implementationOwner,
  isAuthor,
  loadIdea,
  mentorLoad,
  mentorWarning,
  requireStatus,
  setStatus,
  startDeadline,
  type DecisionInput,
  type IdeaRow,
  type TriageResult,
} from './workflow.js';

// Elaboration and decision (epic J): mentor and timebox (R2-01), dossier (R2-02), weighted
// scorecard (R2-03), committee meetings (R2-04), delegation (R2-05, see workflow.ts),
// experiments (R2-06), impact review (R2-07) and portfolio board (R2-08).

export { upsertSuccessStoryDraft } from './recognition.js';

// ---------------------------------------------------------------- mentor (R2-01)

export async function reassignMentor(ctx: Ctx, idea: IdeaRow, mentorId: string | null, timeboxUntil?: string): Promise<TriageResult> {
  if (!isTriage(ctx.user)) throw forbidden();
  requireStatus(idea, 'elaboration');
  return assignMentor(ctx, idea, mentorId, timeboxUntil);
}

/** Active elaboration ideas per person, for the warning in the triage form. */
export async function mentorLoadInfo(ctx: Ctx, userId: string) {
  const active = (await mentorLoad(ctx, [userId])).get(userId) ?? 0;
  const warnAt = ctx.settings.elaboration.mentorWarnActive;
  return { userId, active, warnAt, warning: mentorWarning(ctx, active) ?? null };
}

// ---------------------------------------------------------------- dossier (R2-02)

export const DOSSIER_SECTIONS = ['summary', 'benefit', 'effort', 'risks', 'affected', 'path', 'analyses'] as const;
export type DossierSection = (typeof DOSSIER_SECTIONS)[number];
export const isDossierSection = (s: string): s is DossierSection => (DOSSIER_SECTIONS as readonly string[]).includes(s);
const MAX_SECTION_CHARS = 20_000;

interface SectionRow {
  section: DossierSection;
  content: string;
  open_points: string[];
  version: number;
  locked_by: string | null;
  locked_until: Date | null;
  locked: boolean;
  locked_name: string | null;
  updated_by: string | null;
  updated_at: Date;
}

/** Mentor, authors and co-authors, and the triage team edit the dossier while the idea is in elaboration. */
export function canEditDossier(ctx: Ctx, idea: IdeaRow): boolean {
  const u = ctx.user;
  if (!u || idea.status !== 'elaboration') return false;
  return isTriage(u) || idea.mentor_id === u.id || isAuthor(u, idea);
}

async function sectionForUpdate(ctx: Ctx, ideaId: string, section: DossierSection): Promise<SectionRow> {
  await ctx.db.query('INSERT INTO dossier_sections (tenant_id, idea_id, section) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [
    ctx.tenantId, ideaId, section,
  ]);
  const r = await ctx.db.query<SectionRow>(
    `SELECT s.*, (s.locked_by IS NOT NULL AND s.locked_until > now()) AS locked, NULL::text AS locked_name
       FROM dossier_sections s WHERE s.idea_id = $1 AND s.section = $2 FOR UPDATE`,
    [ideaId, section],
  );
  const row = r.rows[0];
  if (row.locked && row.locked_by) {
    row.locked_name = (await ctx.db.query<{ n: string }>('SELECT display_name AS n FROM users WHERE id = $1', [row.locked_by])).rows[0]?.n ?? null;
  }
  return row;
}

function lockedError(row: SectionRow) {
  return conflict(
    row.locked_name ? m('elaboration.sectionLocked', { name: row.locked_name }) : m('elaboration.sectionLockedOther'),
    'SECTION_LOCKED',
    { lockedBy: row.locked_name, lockedUntil: row.locked_until },
  );
}

/**
 * Saves one dossier section as a new version and records it in the history.
 * Human edits need edit rights and must not collide with someone else's lock; AI writes
 * only when nobody holds the lock. expectedVersion enables optimistic concurrency.
 */
export async function saveDossierSection(
  ctx: Ctx,
  idea: IdeaRow,
  section: DossierSection,
  content: string,
  opts: { source: 'human' | 'ai'; openPoints?: string[]; expectedVersion?: number },
): Promise<{ version: number }> {
  if (!isDossierSection(section)) throw badRequest(m('elaboration.unknownSection'));
  if (content.length > MAX_SECTION_CHARS) throw badRequest(m('elaboration.sectionTooLong', { max: MAX_SECTION_CHARS }));
  if (opts.source === 'human' && !canEditDossier(ctx, idea)) throw forbidden(m('elaboration.dossierEditors'));
  const me = ctx.user?.id ?? null;
  const row = await sectionForUpdate(ctx, idea.id, section);
  if (row.locked && (opts.source === 'ai' || row.locked_by !== me)) throw lockedError(row);
  if (opts.expectedVersion !== undefined && opts.expectedVersion !== row.version) {
    throw conflict(m('elaboration.versionConflict'), 'VERSION_CONFLICT', {
      version: row.version,
    });
  }
  const version = row.version + 1;
  const openPoints = opts.openPoints?.map((p) => p.trim()).filter(Boolean).slice(0, 50);
  await ctx.db.query(
    `UPDATE dossier_sections SET content = $3, open_points = coalesce($4::text[], open_points), version = $5,
       updated_by = $6, updated_at = now(),
       locked_by = CASE WHEN locked_by IS NOT DISTINCT FROM $6 THEN NULL ELSE locked_by END,
       locked_until = CASE WHEN locked_by IS NOT DISTINCT FROM $6 THEN NULL ELSE locked_until END
     WHERE idea_id = $1 AND section = $2`,
    [idea.id, section, content, openPoints ?? null, version, me],
  );
  await ctx.db.query(
    'INSERT INTO dossier_history (tenant_id, idea_id, section, version, content, source, changed_by) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [ctx.tenantId, idea.id, section, version, content, opts.source, me],
  );
  return { version };
}

export async function lockSection(ctx: Ctx, idea: IdeaRow, section: DossierSection) {
  if (!canEditDossier(ctx, idea)) throw forbidden(m('elaboration.cannotEditDossier'));
  const row = await sectionForUpdate(ctx, idea.id, section);
  if (row.locked && row.locked_by !== ctx.user!.id) throw lockedError(row);
  const r = await ctx.db.query<{ locked_until: Date }>(
    `UPDATE dossier_sections SET locked_by = $3, locked_until = now() + make_interval(mins => $4)
      WHERE idea_id = $1 AND section = $2 RETURNING locked_until`,
    [idea.id, section, ctx.user!.id, ctx.settings.elaboration.lockMinutes],
  );
  return { section, version: row.version, content: row.content, openPoints: row.open_points, lockedUntil: r.rows[0].locked_until };
}

export async function releaseSection(ctx: Ctx, idea: IdeaRow, section: DossierSection): Promise<void> {
  await ctx.db.query(
    'UPDATE dossier_sections SET locked_by = NULL, locked_until = NULL WHERE idea_id = $1 AND section = $2 AND locked_by = $3',
    [idea.id, section, ctx.user!.id],
  );
}

export async function dossierSections(ctx: Ctx, idea: IdeaRow) {
  const r = await ctx.db.query<SectionRow & { updated_name: string | null }>(
    `SELECT s.*, (s.locked_by IS NOT NULL AND s.locked_until > now()) AS locked, l.display_name AS locked_name, u.display_name AS updated_name
       FROM dossier_sections s LEFT JOIN users l ON l.id = s.locked_by LEFT JOIN users u ON u.id = s.updated_by
      WHERE s.idea_id = $1`,
    [idea.id],
  );
  const me = ctx.user?.id;
  return DOSSIER_SECTIONS.map((section) => {
    const s = r.rows.find((x) => x.section === section);
    return {
      section,
      content: s?.content ?? '',
      openPoints: s?.open_points ?? [],
      version: s?.version ?? 0,
      updatedAt: s && s.version > 0 ? s.updated_at : null,
      updatedBy: s?.updated_name ?? null,
      lock: s?.locked ? { by: s.locked_name, until: s.locked_until, mine: s.locked_by === me } : null,
    };
  });
}

export async function dossierHistory(ctx: Ctx, idea: IdeaRow, section: DossierSection) {
  const r = await ctx.db.query(
    `SELECT h.version, h.content, h.source, h.changed_at AS "changedAt", u.display_name AS "changedBy"
       FROM dossier_history h LEFT JOIN users u ON u.id = h.changed_by
      WHERE h.idea_id = $1 AND h.section = $2 ORDER BY h.version DESC LIMIT 100`,
    [idea.id, section],
  );
  return r.rows;
}

export const estimatesInput = z.object({
  horizon: z.number().int().min(1).max(3).nullable().optional(),
  effortPersonDays: z.number().min(0).max(1_000_000).nullable().optional(),
  effortEuro: z.number().min(0).max(1_000_000_000).nullable().optional(),
  planBenefitEuro: z.number().min(0).max(1_000_000_000).nullable().optional(),
});

/** Structured numbers of the dossier; they drive delegation (R2-05) and the portfolio sums (R2-08). */
export async function updateEstimates(ctx: Ctx, idea: IdeaRow, input: z.infer<typeof estimatesInput>): Promise<void> {
  if (!canEditDossier(ctx, idea)) throw forbidden(m('elaboration.cannotEditEstimates'));
  const map = { horizon: 'horizon', effortPersonDays: 'effort_person_days', effortEuro: 'effort_euro', planBenefitEuro: 'plan_benefit_euro' } as const;
  const entries = (Object.keys(map) as (keyof typeof map)[]).filter((k) => input[k] !== undefined);
  if (!entries.length) return;
  await ctx.db.query(
    `UPDATE ideas SET ${entries.map((k, i) => `${map[k]} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
    [idea.id, ...entries.map((k) => input[k])],
  );
  const before = Object.fromEntries(entries.map((k) => [k, idea[map[k]] ?? null]));
  await audit(ctx, 'idea.estimates', 'idea', idea.id, before, Object.fromEntries(entries.map((k) => [k, input[k]])));
}

// ---------------------------------------------------------------- weighted scorecard (R2-03) and jury (R2-35)

export type Criterion = Settings['scorecard']['criteria'][number];

export const scoresInput = z.object({
  scores: z.record(z.string().max(40), z.number().int().min(1).max(5)),
  comment: z.string().trim().max(2000).nullable().optional(),
});

/** Weighted average on the 1-5 scale; every criterion must be rated. */
export function weightedTotal(criteria: Pick<Criterion, 'id' | 'label' | 'weight'>[], scores: Record<string, number>): number {
  const unknown = Object.keys(scores).filter((k) => !criteria.some((c) => c.id === k));
  if (unknown.length) throw badRequest(m('elaboration.unknownCriterion'), { unknown });
  const missing = criteria.filter((c) => scores[c.id] === undefined).map((c) => c.label);
  if (missing.length) throw badRequest(m('elaboration.rateAll', { criteria: missing.join(', ') }), { missing });
  const weight = criteria.reduce((n, c) => n + c.weight, 0);
  if (weight <= 0) throw badRequest(m('elaboration.noWeight'));
  const total = criteria.reduce((n, c) => n + c.weight * scores[c.id], 0) / weight;
  return Math.round(total * 100) / 100;
}

export async function canRateGate2(ctx: Ctx, idea: IdeaRow): Promise<boolean> {
  const u = ctx.user;
  if (!u || idea.status !== 'elaboration') return false;
  if (isDecider(u) || isTriage(u) || idea.mentor_id === u.id) return true;
  return hasRole(u, 'lead') && (await gate2Authority(ctx, idea)).allowed;
}

export async function saveScorecard(
  ctx: Ctx,
  idea: IdeaRow,
  context: 'gate2' | 'jury',
  criteria: Pick<Criterion, 'id' | 'label' | 'weight'>[],
  input: z.infer<typeof scoresInput>,
): Promise<{ total: number }> {
  const total = weightedTotal(criteria, input.scores);
  await ctx.db.query(
    `INSERT INTO scorecards (tenant_id, idea_id, user_id, context, scores, total, comment, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (idea_id, user_id, context) DO UPDATE SET scores = EXCLUDED.scores, total = EXCLUDED.total, comment = EXCLUDED.comment, updated_at = now()`,
    [ctx.tenantId, idea.id, ctx.user!.id, context, JSON.stringify(input.scores), total, input.comment ?? null],
  );
  return { total };
}

export async function rateGate2(ctx: Ctx, idea: IdeaRow, input: z.infer<typeof scoresInput>) {
  if (!(await canRateGate2(ctx, idea))) throw forbidden(m('elaboration.raters'));
  return saveScorecard(ctx, idea, 'gate2', ctx.settings.scorecard.criteria, input);
}

interface ScoreRow {
  user_id: string;
  name: string;
  scores: Record<string, number>;
  total: number;
  comment: string | null;
}

/** Average per idea; single ratings only for deciders and triage, never ranked by person. */
export async function scorecardView(ctx: Ctx, idea: IdeaRow) {
  const criteria = ctx.settings.scorecard.criteria;
  const r = await ctx.db.query<ScoreRow>(
    `SELECT s.user_id, u.display_name AS name, s.scores, s.total, s.comment FROM scorecards s JOIN users u ON u.id = s.user_id
      WHERE s.idea_id = $1 AND s.context = 'gate2' ORDER BY u.display_name`,
    [idea.id],
  );
  const rows = r.rows;
  const mine = rows.find((x) => x.user_id === ctx.user?.id);
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);
  return {
    criteria,
    mine: mine ? { scores: mine.scores, total: mine.total, comment: mine.comment } : null,
    average: rows.length
      ? {
          total: avg(rows.map((x) => Number(x.total))),
          count: rows.length,
          perCriterion: Object.fromEntries(criteria.map((c) => [c.id, avg(rows.map((x) => x.scores[c.id]).filter((v) => typeof v === 'number'))])),
        }
      : null,
    ratings: isDecider(ctx.user) || isTriage(ctx.user) ? rows.map((x) => ({ name: x.name, total: x.total, scores: x.scores, comment: x.comment })) : null,
    can: { rate: await canRateGate2(ctx, idea) },
  };
}

// ---------------------------------------------------------------- committee meetings (R2-04)

/** Date that lies n working days before the given date. */
export function subtractWorkdays(date: string, n: number, holidays: ReadonlySet<string>): string {
  const d = new Date(`${date}T00:00:00Z`);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() - 1);
    if (isWorkday(d.toISOString().slice(0, 10), holidays)) left--;
  }
  return d.toISOString().slice(0, 10);
}

export const meetingInput = z.object({
  title: z.string().trim().min(3).max(140),
  meetsOn: z.iso.date(),
});

interface MeetingRow {
  id: string;
  title: string;
  meets_on: string;
  pack_due_on: string;
  pack_sent_at: Date | null;
  status: 'planned' | 'sent' | 'held';
}

export const canSeeMeetings = (ctx: Ctx) => can(ctx.user, 'meetings');

export async function createMeeting(ctx: Ctx, input: z.infer<typeof meetingInput>): Promise<{ id: string; packDueOn: string }> {
  if (!isTriage(ctx.user)) throw forbidden();
  if (input.meetsOn < ctx.today) throw badRequest(m('elaboration.meetingPast'));
  const packDueOn = subtractWorkdays(input.meetsOn, ctx.settings.elaboration.meetingPackWorkdays, ctx.holidays);
  const r = await ctx.db.query<{ id: string }>(
    'INSERT INTO meetings (tenant_id, title, meets_on, pack_due_on, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [ctx.tenantId, input.title, input.meetsOn, packDueOn, ctx.user!.id],
  );
  await audit(ctx, 'meeting.create', 'meeting', r.rows[0].id, null, { ...input, packDueOn });
  return { id: r.rows[0].id, packDueOn };
}

async function loadMeeting(ctx: Ctx, id: string, forUpdate = false): Promise<MeetingRow> {
  if (!z.uuid().safeParse(id).success) throw notFound(m('elaboration.meetingNotFound'));
  const r = await ctx.db.query<MeetingRow>(`SELECT * FROM meetings WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  if (!r.rows[0]) throw notFound(m('elaboration.meetingNotFound'));
  return r.rows[0];
}

export async function listMeetings(ctx: Ctx) {
  if (!canSeeMeetings(ctx)) throw forbidden();
  const r = await ctx.db.query(
    `SELECT m.id, m.title, m.meets_on AS "meetsOn", m.pack_due_on AS "packDueOn", m.pack_sent_at AS "packSentAt", m.status,
            (SELECT count(*) FROM meeting_items mi WHERE mi.meeting_id = m.id)::int AS items
       FROM meetings m ORDER BY (m.meets_on >= $1) DESC, CASE WHEN m.meets_on >= $1 THEN m.meets_on END ASC, m.meets_on DESC LIMIT 100`,
    [ctx.today],
  );
  return { items: r.rows, maxIdeas: ctx.settings.elaboration.meetingMaxIdeas, packWorkdays: ctx.settings.elaboration.meetingPackWorkdays };
}

export async function meetingDetail(ctx: Ctx, id: string) {
  if (!canSeeMeetings(ctx)) throw forbidden();
  const mt = await loadMeeting(ctx, id);
  const all = await ctx.db.query<{ n: number }>('SELECT count(*)::int AS n FROM meeting_items WHERE meeting_id = $1', [id]);
  const items = await ctx.db.query(
    `SELECT i.id, i.number, i.title, i.status, i.topic, i.horizon, i.effort_person_days AS "effortPersonDays", i.effort_euro AS "effortEuro",
            i.plan_benefit_euro AS "planBenefitEuro", i.confidential, mi.position, mu.display_name AS "mentorName",
            (SELECT round(avg(s.total)::numeric, 2)::float FROM scorecards s WHERE s.idea_id = i.id AND s.context = 'gate2') AS score,
            (SELECT count(*) FROM scorecards s WHERE s.idea_id = i.id AND s.context = 'gate2')::int AS raters,
            (SELECT left(ds.content, 400) FROM dossier_sections ds WHERE ds.idea_id = i.id AND ds.section = 'risks') AS risks,
            (SELECT left(ds.content, 400) FROM dossier_sections ds WHERE ds.idea_id = i.id AND ds.section = 'summary') AS summary,
            (SELECT json_build_object('outcome', d.outcome, 'reason', d.reason, 'decidedAt', d.decided_at)
               FROM decisions d WHERE d.idea_id = i.id AND d.meeting_id = mi.meeting_id ORDER BY d.decided_at DESC LIMIT 1) AS decision
       FROM meeting_items mi JOIN ideas i ON i.id = mi.idea_id LEFT JOIN users mu ON mu.id = i.mentor_id
      WHERE mi.meeting_id = $3 AND ${VISIBLE_SQL}
      ORDER BY mi.position`,
    [ctx.user!.id, isTriageEverywhere(ctx.user), id],
  );
  const manage = isTriage(ctx.user) && mt.status !== 'held';
  return {
    id: mt.id,
    title: mt.title,
    meetsOn: mt.meets_on,
    packDueOn: mt.pack_due_on,
    packSentAt: mt.pack_sent_at,
    status: mt.status,
    maxIdeas: ctx.settings.elaboration.meetingMaxIdeas,
    items: items.rows,
    hiddenItems: all.rows[0].n - items.rowCount!,
    can: { manage, decide: isDecider(ctx.user) && mt.status !== 'held', sendPack: manage && all.rows[0].n > 0, delete: isTriage(ctx.user) && mt.status === 'planned' },
  };
}

export async function addMeetingItem(ctx: Ctx, meetingId: string, ideaId: string): Promise<void> {
  if (!isTriage(ctx.user)) throw forbidden();
  const mt = await loadMeeting(ctx, meetingId, true);
  if (mt.status === 'held') throw conflict(m('elaboration.meetingHeld'));
  const idea = await loadIdea(ctx, ideaId);
  if (idea.status !== 'elaboration') throw conflict(m('elaboration.agendaOnlyElaboration'), 'INVALID_STATUS');
  const count = (await ctx.db.query<{ n: number; pos: number }>(
    'SELECT count(*)::int AS n, coalesce(max(position), 0)::int AS pos FROM meeting_items WHERE meeting_id = $1',
    [meetingId],
  )).rows[0];
  const max = ctx.settings.elaboration.meetingMaxIdeas;
  if (count.n >= max) throw conflict(m('elaboration.meetingFull', { max }), 'MEETING_FULL');
  const r = await ctx.db.query(
    'INSERT INTO meeting_items (tenant_id, meeting_id, idea_id, position) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
    [ctx.tenantId, meetingId, ideaId, count.pos + 1],
  );
  if (r.rowCount) await addEvent(ctx, idea, 'meeting_scheduled', m('elaboration.event.scheduled', { date: mt.meets_on }));
}

export async function removeMeetingItem(ctx: Ctx, meetingId: string, ideaId: string): Promise<void> {
  if (!isTriage(ctx.user)) throw forbidden();
  const mt = await loadMeeting(ctx, meetingId, true);
  if (mt.status === 'held') throw conflict(m('elaboration.meetingHeld'));
  await ctx.db.query('DELETE FROM meeting_items WHERE meeting_id = $1 AND idea_id = $2', [meetingId, ideaId]);
}

export async function deleteMeeting(ctx: Ctx, meetingId: string): Promise<void> {
  if (!isTriage(ctx.user)) throw forbidden();
  const mt = await loadMeeting(ctx, meetingId, true);
  if (mt.status !== 'planned') throw conflict(m('elaboration.meetingDeleteOnlyPlanned'));
  await ctx.db.query('DELETE FROM meetings WHERE id = $1', [meetingId]);
  await audit(ctx, 'meeting.delete', 'meeting', meetingId, { title: mt.title, meets_on: mt.meets_on }, null);
}

/** Sends the meeting pack to all committee members (job on pack_due_on, or manually). */
export async function sendMeetingPack(ctx: Ctx, meetingId: string): Promise<number> {
  const mt = await loadMeeting(ctx, meetingId, true);
  const items = await ctx.db.query<{ id: string; number: number; title: string }>(
    'SELECT i.id, i.number, i.title FROM meeting_items mi JOIN ideas i ON i.id = mi.idea_id WHERE mi.meeting_id = $1 ORDER BY mi.position',
    [meetingId],
  );
  if (!items.rowCount) throw conflict(m('elaboration.meetingEmpty'));
  const list = cat(items.rows.map((i) => cat(['- ', m('workflow.ideaLabel', ideaVars(i)), `: /ideen/${i.id}`])), '\n');
  await notifyRoles(ctx, ['committee'], m('elaboration.pack.subject', { date: mt.meets_on }),
    cat([m('elaboration.pack.body', { title: mt.title, date: mt.meets_on, count: items.rowCount }), '\n', list, '\n\n', m('elaboration.pack.link', { id: mt.id })]), undefined, 'tasks');
  await ctx.db.query("UPDATE meetings SET pack_sent_at = now(), status = CASE WHEN status = 'planned' THEN 'sent' ELSE status END WHERE id = $1", [meetingId]);
  await audit(ctx, 'meeting.pack_sent', 'meeting', meetingId, null, { ideas: items.rows.map((i) => i.id) });
  return items.rowCount!;
}

export async function markMeetingHeld(ctx: Ctx, meetingId: string): Promise<void> {
  if (!isTriage(ctx.user)) throw forbidden();
  await loadMeeting(ctx, meetingId, true);
  await ctx.db.query("UPDATE meetings SET status = 'held' WHERE id = $1", [meetingId]);
}

/** Decision from the meeting view: the same Gate 2 decision (R1-30), linked to the meeting. */
export async function decideInMeeting(ctx: Ctx, meetingId: string, ideaId: string, input: DecisionInput): Promise<void> {
  const mt = await loadMeeting(ctx, meetingId);
  if (mt.status === 'held') throw conflict(m('elaboration.meetingHeld'));
  const item = await ctx.db.query('SELECT 1 FROM meeting_items WHERE meeting_id = $1 AND idea_id = $2', [meetingId, ideaId]);
  if (!item.rowCount) throw notFound(m('elaboration.notOnAgenda'));
  await decideGate2(ctx, await loadIdea(ctx, ideaId, true), input, { meetingId });
}

// ---------------------------------------------------------------- experiments (R2-06)

export const experimentInput = z.object({
  hypothesis: z.string().trim().min(5).max(2000),
  smallestTest: z.string().trim().max(2000).default(''),
  metric: z.string().trim().min(2).max(500),
  successCriteria: z.string().trim().max(1000).default(''),
  startsOn: z.iso.date(),
  endsOn: z.iso.date(),
  aiResultId: z.uuid().optional(),
});

export const experimentResultInput = z.object({
  outcome: z.enum(['confirmed', 'refuted', 'inconclusive']),
  result: z.string().trim().min(10).max(3000),
});


/** Owner of a piloting idea (or deputy), the mentor during elaboration, or the triage team. */
export async function canManageExperiments(ctx: Ctx, idea: IdeaRow): Promise<boolean> {
  const u = ctx.user;
  if (!u || !['elaboration', 'piloting'].includes(idea.status)) return false;
  if (isTriage(u)) return true;
  if (idea.status === 'elaboration') return idea.mentor_id === u.id;
  const owner = await implementationOwner(ctx, idea.id);
  return !!owner && (await actsFor(ctx, owner));
}

export async function createExperiment(
  ctx: Ctx,
  idea: IdeaRow,
  input: { hypothesis: string; smallestTest: string; metric: string; successCriteria: string; startsOn: string; endsOn: string; aiResultId?: string },
): Promise<{ id: string }> {
  if (!(await canManageExperiments(ctx, idea))) throw forbidden(m('elaboration.experimentManagers'));
  if (input.endsOn < input.startsOn) throw badRequest(m('elaboration.endBeforeStart'));
  const r = await ctx.db.query<{ id: string }>(
    `INSERT INTO experiments (tenant_id, idea_id, hypothesis, smallest_test, metric, success_criteria, starts_on, ends_on, ai_result_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [ctx.tenantId, idea.id, input.hypothesis, input.smallestTest, input.metric, input.successCriteria, input.startsOn, input.endsOn,
     input.aiResultId ?? null, ctx.user!.id],
  );
  await addEvent(ctx, idea, 'experiment_started', m('elaboration.event.experimentStarted', { date: input.endsOn, hypothesis: input.hypothesis }));
  await audit(ctx, 'experiment.create', 'idea', idea.id, null, { ...input, id: r.rows[0].id });
  return { id: r.rows[0].id };
}

export async function listExperiments(ctx: Ctx, idea: IdeaRow) {
  const r = await ctx.db.query(
    `SELECT e.id, e.hypothesis, e.smallest_test AS "smallestTest", e.metric, e.success_criteria AS "successCriteria",
            e.starts_on AS "startsOn", e.ends_on AS "endsOn", e.status, e.outcome, e.result, e.ai_result_id AS "aiResultId",
            e.finished_at AS "finishedAt", u.display_name AS "createdBy"
       FROM experiments e LEFT JOIN users u ON u.id = e.created_by WHERE e.idea_id = $1 ORDER BY e.created_at DESC`,
    [idea.id],
  );
  return { items: r.rows, can: { manage: await canManageExperiments(ctx, idea) } };
}

/** Records the result. For a piloting idea, the result leads back to Gate 2. */
export async function recordExperimentResult(ctx: Ctx, idea: IdeaRow, experimentId: string, input: z.infer<typeof experimentResultInput>): Promise<void> {
  if (!(await canManageExperiments(ctx, idea))) throw forbidden();
  const r = await ctx.db.query<{ status: string; hypothesis: string }>(
    'SELECT status, hypothesis FROM experiments WHERE id = $1 AND idea_id = $2 FOR UPDATE',
    [experimentId, idea.id],
  );
  if (!r.rows[0]) throw notFound(m('elaboration.experimentNotFound'));
  if (r.rows[0].status !== 'running') throw conflict(m('elaboration.experimentDone'));
  await ctx.db.query("UPDATE experiments SET status = 'done', outcome = $2, result = $3, finished_at = now() WHERE id = $1", [
    experimentId, input.outcome, input.result,
  ]);
  const text = cat([m(`elaboration.experiment.result.${input.outcome}`, { hypothesis: r.rows[0].hypothesis }), '\n', input.result]);
  await audit(ctx, 'experiment.result', 'idea', idea.id, null, { experimentId, ...input });
  if (idea.status === 'piloting') {
    await completeDeadlines(ctx, idea);
    await setStatus(ctx, idea, 'elaboration', 'experiment_result', cat([text, '\n\n', m('elaboration.experiment.backToGate2')]));
    await startDeadline(ctx, idea, 'elaboration', ctx.settings.deadlines.elaborationWorkdays);
    // A fresh timebox for the second round at Gate 2 (R2-01).
    await ctx.db.query('UPDATE ideas SET timebox_until = $2, timebox_reminded_at = NULL, timebox_exceeded_at = NULL WHERE id = $1', [idea.id, defaultTimebox(ctx)]);
    await notifyRoles(ctx, ['committee'], m('elaboration.experiment.doneSubject', ideaVars(idea)),
      cat([text, '\n\n', m('elaboration.experiment.waitsGate2')]), idea.id);
    await notifyAuthors(ctx, idea, m('elaboration.experiment.doneAuthorSubject', ideaVars(idea)), cat([text, '\n\n', m('elaboration.experiment.gate2Next')]));
  } else {
    await addEvent(ctx, idea, 'experiment_result', text);
  }
}

// ---------------------------------------------------------------- impact review at Gate 3 (R2-07)

interface ImpactRow {
  id: string;
  idea_id: string;
  reviewer_id: string | null;
  due_on: string;
  plan_value: number | null;
  actual_value: number | null;
  outcome: 'close' | 'scale' | 'adjust' | 'stop' | null;
  notes: string | null;
  done_at: Date | null;
  confirmed_by: string | null;
  confirmed_at: Date | null;
}

export const impactInput = z.object({
  planValue: z.number().min(0).nullable(),
  actualValue: z.number().min(0).nullable(),
  outcome: z.enum(['close', 'scale', 'adjust', 'stop']),
  notes: z.string().trim().min(10).max(3000),
});

const IMPACT_OUTCOME = (o: NonNullable<ImpactRow['outcome']>): Text => m(`elaboration.impact.outcome.${o}`);

async function canConfirmImpact(ctx: Ctx, idea: IdeaRow): Promise<boolean> {
  if (!ctx.user) return false;
  return idea.sponsor_id ? actsFor(ctx, idea.sponsor_id) : isDecider(ctx.user);
}

async function loadImpact(ctx: Ctx, idea: IdeaRow, forUpdate = false): Promise<ImpactRow> {
  const r = await ctx.db.query<ImpactRow>(`SELECT * FROM impact_reviews WHERE idea_id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [idea.id]);
  if (!r.rows[0]) throw notFound(m('elaboration.impact.none'));
  return r.rows[0];
}

export async function impactReviewView(ctx: Ctx, idea: IdeaRow) {
  const r = await ctx.db.query<ImpactRow & { reviewer_name: string | null; confirmer_name: string | null; sponsor_name: string | null }>(
    `SELECT ir.*, rv.display_name AS reviewer_name, cf.display_name AS confirmer_name, sp.display_name AS sponsor_name
       FROM impact_reviews ir LEFT JOIN users rv ON rv.id = ir.reviewer_id LEFT JOIN users cf ON cf.id = ir.confirmed_by
       LEFT JOIN ideas i ON i.id = ir.idea_id LEFT JOIN users sp ON sp.id = i.sponsor_id
      WHERE ir.idea_id = $1`,
    [idea.id],
  );
  const ir = r.rows[0];
  if (!ir) return null;
  const isReviewer = !!ir.reviewer_id && (await actsFor(ctx, ir.reviewer_id));
  return {
    dueOn: ir.due_on,
    due: ir.due_on <= ctx.today,
    reviewerName: ir.reviewer_name,
    sponsorName: ir.sponsor_name,
    planValue: ir.plan_value,
    actualValue: ir.actual_value,
    outcome: ir.outcome,
    notes: ir.notes,
    doneAt: ir.done_at,
    confirmedAt: ir.confirmed_at,
    confirmedBy: ir.confirmer_name,
    can: {
      record: !ir.confirmed_at && (isReviewer || isTriage(ctx.user)),
      confirm: !!ir.done_at && !ir.confirmed_at && (await canConfirmImpact(ctx, idea)),
    },
  };
}

export async function recordImpactReview(ctx: Ctx, idea: IdeaRow, input: z.infer<typeof impactInput>): Promise<void> {
  const ir = await loadImpact(ctx, idea, true);
  const isReviewer = !!ir.reviewer_id && (await actsFor(ctx, ir.reviewer_id));
  if (!isReviewer && !isTriage(ctx.user)) throw forbidden(m('elaboration.impact.recorder'));
  if (ir.confirmed_at) throw conflict(m('elaboration.impact.alreadyConfirmed'));
  await ctx.db.query(
    'UPDATE impact_reviews SET plan_value = $2, actual_value = $3, outcome = $4, notes = $5, done_at = now() WHERE id = $1',
    [ir.id, input.planValue, input.actualValue, input.outcome, input.notes],
  );
  await audit(ctx, 'impact_review.record', 'idea', idea.id, null, input);
  const text = m(`elaboration.impact.recorded.${input.outcome}`, ideaVars(idea));
  const subject = m('elaboration.impact.confirmSubject', ideaVars(idea));
  if (idea.sponsor_id) await notifyUser(ctx, idea.sponsor_id, subject, text, idea.id);
  else await notifyRoles(ctx, ['committee'], subject, text, idea.id);
}

export async function confirmImpactReview(ctx: Ctx, idea: IdeaRow): Promise<void> {
  const ir = await loadImpact(ctx, idea, true);
  if (!(await canConfirmImpact(ctx, idea))) throw forbidden(m('elaboration.impact.confirmer'));
  if (!ir.done_at) throw conflict(m('elaboration.impact.notRecorded'));
  if (ir.confirmed_at) throw conflict(m('elaboration.impact.alreadyConfirmed'));
  await ctx.db.query('UPDATE impact_reviews SET confirmed_by = $2, confirmed_at = now() WHERE id = $1', [ir.id, ctx.user!.id]);
  // Numbers in German format: the text is also kept in the (German) history.
  const values: Text[] = [];
  if (ir.plan_value != null) values.push(m('elaboration.impact.plan', { value: fmt.number('de', ir.plan_value) }));
  if (ir.actual_value != null) values.push(m('elaboration.impact.actual', { value: fmt.number('de', ir.actual_value) }));
  const text = cat([m('elaboration.impact.confirmed'), ': ', IMPACT_OUTCOME(ir.outcome!), values.length ? cat([' (', cat(values, ', '), ')']) : '', '.\n', ir.notes ?? '']);
  await addEvent(ctx, idea, 'impact_review', text);
  await audit(ctx, 'impact_review.confirm', 'idea', idea.id, null, { outcome: ir.outcome });
  await emitIdeaEvent(ctx, 'idea.gate_decided', idea, { gate: 3, outcome: ir.outcome });
  await notifyAuthors(ctx, idea, m('elaboration.impact.authorSubject', ideaVars(idea)), text);
}

// ---------------------------------------------------------------- portfolio board (R2-08)

export const PORTFOLIO_COLUMNS = [
  { key: 'submit', statuses: ['submitted', 'in_question'] },
  { key: 'elaborate', statuses: ['elaboration'] },
  { key: 'implement', statuses: ['fast_lane', 'implementing', 'piloting', 'integrated'] },
  { key: 'impact', statuses: ['completed'] },
  { key: 'parked', statuses: ['parked'] },
] as const;

export const portfolioQuery = z.object({
  horizon: z.coerce.number().int().min(1).max(3).optional(),
  topic: z.string().max(80).optional(),
});

export async function portfolio(ctx: Ctx, q: z.infer<typeof portfolioQuery>) {
  const params: unknown[] = [ctx.user!.id, isTriageEverywhere(ctx.user), PORTFOLIO_COLUMNS.flatMap((c) => c.statuses)];
  const where = [VISIBLE_SQL, 'i.status = ANY($3::text[])'];
  if (q.horizon) {
    params.push(q.horizon);
    where.push(`i.horizon = $${params.length}`);
  }
  if (q.topic) {
    params.push(q.topic);
    where.push(`i.topic = $${params.length}`);
  }
  const r = await ctx.db.query<{
    id: string; number: number; title: string; status: string; topic: string | null; horizon: number | null; confidential: boolean;
    planBenefitEuro: number | null; actualBenefitEuro: number | null; mentorName: string | null;
  }>(
    `SELECT i.id, i.number, i.title, i.status, i.topic, i.horizon, i.confidential, i.plan_benefit_euro AS "planBenefitEuro",
            CASE WHEN im.status = 'done' AND im.benefit_kind IN ('euro', 'revenue') THEN im.benefit_value END AS "actualBenefitEuro",
            mu.display_name AS "mentorName"
       FROM ideas i LEFT JOIN implementations im ON im.idea_id = i.id LEFT JOIN users mu ON mu.id = i.mentor_id
      WHERE ${where.join(' AND ')}
      ORDER BY i.updated_at DESC LIMIT 1000`,
    params,
  );
  const sum = (xs: (number | null)[]) => xs.reduce<number>((n, x) => n + (x == null ? 0 : Number(x)), 0);
  const columns = PORTFOLIO_COLUMNS.map((c) => {
    const items = r.rows.filter((i) => (c.statuses as readonly string[]).includes(i.status));
    return {
      key: c.key,
      title: tr(ctx.locale, m(`elaboration.column.${c.key}`)),
      items,
      sums: { planBenefitEuro: sum(items.map((i) => i.planBenefitEuro)), actualBenefitEuro: sum(items.map((i) => i.actualBenefitEuro)) },
    };
  });
  return {
    columns,
    totals: { planBenefitEuro: sum(r.rows.map((i) => i.planBenefitEuro)), actualBenefitEuro: sum(r.rows.map((i) => i.actualBenefitEuro)) },
    topics: ctx.settings.topics,
  };
}

// ---------------------------------------------------------------- overview for the idea page

export async function elaborationOverview(ctx: Ctx, idea: IdeaRow) {
  const mentor = idea.mentor_id
    ? (await ctx.db.query<{ id: string; name: string }>('SELECT id, display_name AS name FROM users WHERE id = $1', [idea.mentor_id])).rows[0] ?? null
    : null;
  const sponsor = idea.sponsor_id
    ? (await ctx.db.query<{ id: string; name: string }>('SELECT id, display_name AS name FROM users WHERE id = $1', [idea.sponsor_id])).rows[0] ?? null
    : null;
  const authority = idea.status === 'elaboration' ? await gate2Authority(ctx, idea) : { allowed: false, delegated: false };
  const t = ctx.settings.thresholds;
  return {
    status: idea.status,
    mentor,
    sponsor,
    timeboxUntil: idea.timebox_until ?? null,
    timeboxRemainingWorkdays: idea.timebox_until ? workdaysBetween(ctx.today, idea.timebox_until, ctx.holidays) : null,
    estimates: {
      horizon: idea.horizon ?? null,
      effortPersonDays: idea.effort_person_days ?? null,
      effortEuro: idea.effort_euro ?? null,
      planBenefitEuro: idea.plan_benefit_euro ?? null,
    },
    delegation: {
      maxPersonDays: t.delegationMaxPersonDays,
      maxEuro: t.delegationMaxEuro,
      eligible: idea.effort_person_days != null && idea.effort_euro != null
        && Number(idea.effort_person_days) <= t.delegationMaxPersonDays && Number(idea.effort_euro) <= t.delegationMaxEuro,
    },
    sections: idea.status !== 'draft' ? await dossierSections(ctx, idea) : [],
    lockMinutes: ctx.settings.elaboration.lockMinutes,
    can: {
      editDossier: canEditDossier(ctx, idea),
      assignMentor: isTriage(ctx.user) && idea.status === 'elaboration',
      decide: authority.allowed,
      decideDelegated: authority.delegated,
    },
  };
}

// ---------------------------------------------------------------- background rules

export interface ElaborationJobResult {
  timeboxReminders: number;
  timeboxExceeded: number;
  meetingPacks: number;
  experimentReminders: number;
  impactReviewsDue: number;
}

export async function runElaborationJobs(ctx: Ctx): Promise<ElaborationJobResult> {
  const res: ElaborationJobResult = { timeboxReminders: 0, timeboxExceeded: 0, meetingPacks: 0, experimentReminders: 0, impactReviewsDue: 0 };
  const { db, today, holidays, settings } = ctx;

  // Timebox of the elaboration (R2-01): reminder before the end and notice when exceeded.
  const boxed = await db.query<IdeaRow & { timebox_reminded_at: Date | null; timebox_exceeded_at: Date | null }>(
    `SELECT * FROM ideas WHERE status = 'elaboration' AND timebox_until IS NOT NULL AND timebox_exceeded_at IS NULL`,
  );
  for (const idea of boxed.rows) {
    const remaining = workdaysBetween(today, idea.timebox_until!, holidays);
    if (idea.timebox_until! < today) {
      await db.query('UPDATE ideas SET timebox_exceeded_at = now(), timebox_reminded_at = coalesce(timebox_reminded_at, now()) WHERE id = $1', [idea.id]);
      const text = m('elaboration.timebox.exceededBody', { ...ideaVars(idea), date: idea.timebox_until });
      const subject = m('elaboration.timebox.exceededSubject', ideaVars(idea));
      if (idea.mentor_id) await notifyUser(ctx, idea.mentor_id, subject, text, idea.id, 'reminders');
      await notifyRoles(ctx, ['triage'], subject, text, idea.id, 'reminders');
      await addEvent(ctx, idea, 'timebox_exceeded', m('elaboration.event.timeboxExceeded', { date: idea.timebox_until }));
      res.timeboxExceeded++;
    } else if (remaining <= settings.deadlines.reminderWorkdaysBefore && !idea.timebox_reminded_at) {
      await db.query('UPDATE ideas SET timebox_reminded_at = now() WHERE id = $1', [idea.id]);
      const text = m('elaboration.timebox.reminderBody', { ...ideaVars(idea), remaining, date: idea.timebox_until });
      const subject = m('elaboration.timebox.reminderSubject', ideaVars(idea));
      if (idea.mentor_id) await notifyUser(ctx, idea.mentor_id, subject, text, idea.id, 'reminders');
      else await notifyRoles(ctx, ['triage'], subject, text, idea.id, 'reminders');
      res.timeboxReminders++;
    }
  }

  // Meeting packs (R2-04): sent on the configured working day before the meeting.
  const packs = await db.query<{ id: string }>(
    `SELECT m.id FROM meetings m WHERE m.status = 'planned' AND m.pack_sent_at IS NULL AND m.pack_due_on <= $1 AND m.meets_on >= $1
        AND EXISTS (SELECT 1 FROM meeting_items mi WHERE mi.meeting_id = m.id)`,
    [today],
  );
  for (const mt of packs.rows) {
    await sendMeetingPack(ctx, mt.id);
    res.meetingPacks++;
  }

  // Experiments (R2-06): reminder before the end.
  const experiments = await db.query<{ id: string; ends_on: string; hypothesis: string; created_by: string | null; idea_id: string; number: number; title: string; owner_id: string | null }>(
    `SELECT e.id, e.ends_on, e.hypothesis, e.created_by, i.id AS idea_id, i.number, i.title, im.owner_id
       FROM experiments e JOIN ideas i ON i.id = e.idea_id LEFT JOIN implementations im ON im.idea_id = i.id
      WHERE e.status = 'running' AND e.reminded_at IS NULL`,
  );
  for (const e of experiments.rows) {
    const remaining = workdaysBetween(today, e.ends_on, holidays);
    if (remaining > settings.elaboration.experimentReminderWorkdays) continue;
    await db.query('UPDATE experiments SET reminded_at = now() WHERE id = $1', [e.id]);
    const text = m('elaboration.experiment.reminderBody', { ...ideaVars(e), hypothesis: e.hypothesis, date: e.ends_on });
    for (const userId of new Set([e.created_by, e.owner_id].filter((x): x is string => !!x))) {
      await notifyUser(ctx, userId, m('elaboration.experiment.reminderSubject', ideaVars(e)), text, e.idea_id, 'reminders');
    }
    res.experimentReminders++;
  }

  // Impact reviews (R2-07): task for the reviewer on the due date.
  const reviews = await db.query<{ id: string; reviewer_id: string | null; due_on: string; idea_id: string; number: number; title: string }>(
    `SELECT ir.id, ir.reviewer_id, ir.due_on, i.id AS idea_id, i.number, i.title
       FROM impact_reviews ir JOIN ideas i ON i.id = ir.idea_id
      WHERE ir.due_on <= $1 AND ir.notified_at IS NULL AND ir.done_at IS NULL`,
    [today],
  );
  for (const ir of reviews.rows) {
    await db.query('UPDATE impact_reviews SET notified_at = now() WHERE id = $1', [ir.id]);
    const text = m('elaboration.impact.dueBody', ideaVars(ir));
    const subject = m('elaboration.impact.dueSubject', ideaVars(ir));
    if (ir.reviewer_id) await notifyUser(ctx, ir.reviewer_id, subject, text, ir.idea_id, 'tasks');
    else await notifyRoles(ctx, ['triage'], subject, text, ir.idea_id, 'tasks');
    res.impactReviewsDue++;
  }
  return res;
}
