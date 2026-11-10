import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checkBoundary } from '../lib/boundary.js';
import { isTriage, isTriageEverywhere, type Ctx, type Role } from '../lib/context.js';
import { areaFilter } from '../services/areas.js';
import { badRequest, notFound } from '../lib/errors.js';
import { m } from '../i18n/index.js';
import { tenantHandler } from '../http.js';
import { decodeCursor, encodeCursor, pageQuery, type Page } from '../lib/cursor.js';
import { findSimilar } from '../search/similar.js';
import { MAX_ATTACHMENT_BYTES, detectType, sanitizeFilename, scanForViruses } from '../lib/attachments.js';
import { audit } from '../services/audit.js';
import { notifyAuthors } from '../services/notify.js';
import { release2Tasks } from '../services/tasks.js';
import {
  VISIBLE_SQL,
  acceptImplementation,
  answerQuestion,
  askQuestion,
  closeImplementation,
  closeInput,
  confirmAuthorship,
  createIdea,
  deadlineInfo,
  decideGate2,
  decisionInput,
  gate2Authority,
  ideaInput,
  ideaVars,
  implementationUpdate,
  isAuthor,
  loadIdea,
  pendingFeedbackPhase,
  rateFeedback,
  submitIdea,
  triageIdea,
  triageInput,
  updateDraft,
  updateImplementation,
  actsFor,
  addCoauthor,
  deputyOf,
  mergeIdeas,
  removeCoauthor,
  type DeadlineRow,
  type IdeaRow,
  type ImplementationRow,
} from '../services/workflow.js';

const idParam = (req: { params: unknown }) => (req.params as { id: string }).id;

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => '\\' + m);
}

// Exported for the OpenAPI description (R3-17).
export const listQuery = z.object({
  scope: z.enum(['mine', 'feed', 'all']).default('feed'),
  topic: z.string().optional(),
  status: z.string().optional(),
  q: z.string().max(200).optional(),
  challengeId: z.uuid().optional(),
  // Problem exchange (R3-31): only problems or only ideas.
  kind: z.enum(['idea', 'problem']).optional(),
  // Without sort: relevance when searching, newest first otherwise.
  sort: z.enum(['new', 'updated', 'supporters', 'relevance']).optional(),
  ...pageQuery,
});

export const submitInput = z.object({ confirmNotReport: z.boolean(), boundaryAcknowledged: z.boolean().optional() });
// kind "solution": a solution proposed by the community for a problem (R3-31).
export const commentInput = z.object({ body: z.string().trim().min(1).max(3000), parentId: z.uuid().optional(), kind: z.enum(['comment', 'solution']).default('comment') });

type ListQuery = z.infer<typeof listQuery>;
type ListSort = NonNullable<ListQuery['sort']>;

// Sort keys for keyset pagination (R3-28); every order ends with the id as tie-breaker, all descending.
const SORT_KEYS: Record<ListSort, { expr: string; type: string }[]> = {
  new: [{ expr: 'coalesce(i.submitted_at, i.created_at)', type: 'timestamptz' }],
  updated: [{ expr: 'i.updated_at', type: 'timestamptz' }],
  supporters: [{ expr: 'sp.n', type: 'int' }, { expr: 'i.updated_at', type: 'timestamptz' }],
  relevance: [{ expr: 's.rank', type: 'float8' }],
};

export interface IdeaListRow {
  id: string;
  number: number;
  title: string;
  status: string;
  [key: string]: unknown;
}

/**
 * Idea list with full-text search and keyset pagination (R1-22, R3-28).
 * Without limit and cursor it returns the first 200 entries as an array (behaviour of Release 1);
 * with limit or cursor it returns { items, nextCursor }.
 */
export async function listIdeas(ctx: Ctx, query: Omit<ListQuery, 'scope'> & { scope?: ListQuery['scope'] }) {
  return (await listIdeasPage(ctx, { scope: 'feed', ...query }, query.limit ?? 200)).items;
}

async function listRoute(ctx: Ctx, query: ListQuery) {
  const paged = query.limit !== undefined || query.cursor !== undefined;
  const page = await listIdeasPage(ctx, query, paged ? query.limit ?? 50 : 200);
  return paged ? page : page.items;
}

export async function listIdeasPage(ctx: Ctx, query: ListQuery, limit: number): Promise<Page<IdeaListRow>> {
  const term = query.q?.trim() ?? '';
  const sort: ListSort = query.sort ?? (term ? 'relevance' : 'new');
  const params: unknown[] = [ctx.user!.id, isTriageEverywhere(ctx.user)];
  const where = [VISIBLE_SQL];
  if (query.scope === 'mine') {
    where.push('(i.author_id = $1 OR i.submitted_by_id IS NOT DISTINCT FROM $1 OR EXISTS (SELECT 1 FROM idea_coauthors ca WHERE ca.idea_id = i.id AND ca.user_id = $1))');
  }
  if (query.scope !== 'mine') where.push("i.status <> 'merged'");
  if (query.scope === 'feed') where.push("i.status <> 'draft' AND NOT i.confidential");
  if (query.topic) {
    params.push(query.topic);
    where.push(`i.topic = $${params.length}`);
  }
  if (query.kind) {
    params.push(query.kind);
    where.push(`i.idea_kind = $${params.length}`);
  }
  if (query.status) {
    params.push(query.status.split(','));
    where.push(`i.status = ANY($${params.length}::text[])`);
  }
  if (query.challengeId) {
    params.push(query.challengeId);
    where.push(`i.challenge_id = $${params.length}`);
  }
  // Full-text query (German stemming plus 'simple'); the substring match of Release 1 stays as
  // fallback for short terms and word parts. Both run in search_idea_ids (migration 017).
  let join = '';
  if (term) {
    params.push(term, `%${escapeLike(term)}%`);
    join = `JOIN search_idea_ids($${params.length - 1}, $${params.length}) s ON s.idea_id = i.id`;
  }
  const keys = SORT_KEYS[sort === 'relevance' && !term ? 'new' : sort];
  const outer: string[] = [];
  if (query.cursor) {
    const key = decodeCursor(query.cursor, sort);
    if (key.length !== keys.length + 1) throw badRequest(m('ideas.invalidCursor'));
    const placeholders = key.map((v, n) => {
      params.push(v);
      return `$${params.length}::${n < keys.length ? keys[n].type : 'uuid'}`;
    });
    outer.push(`(${keys.map((_, n) => `x._k${n}`).join(', ')}, x.id) < (${placeholders.join(', ')})`);
  }
  let rows = await runList(ctx, join, where, keys, outer, params, limit);
  // Typo fallback: no hit on the first page → trigram word similarity (single page, no cursor).
  if (!rows.length && term.length >= 3 && !query.cursor) {
    const p2 = params.slice(0, params.length - 2);
    p2.push(term);
    const fuzzyJoin = `JOIN similar_idea_ids($${p2.length}, 0.5) s ON s.idea_id = i.id`;
    rows = (await runList(ctx, fuzzyJoin, where, [{ expr: 's.score' }], [], p2, limit)).slice(0, limit);
    return { items: rows.map(strip), nextCursor: null };
  }
  const more = rows.length > limit;
  if (more) rows = rows.slice(0, limit);
  const last = rows[rows.length - 1];
  const nextCursor = more && last ? encodeCursor(sort, [...keys.map((_, n) => last[`_c${n}`] as string), last.id as string]) : null;
  return { items: rows.map(strip), nextCursor };
}

function strip(row: Record<string, unknown>): IdeaListRow {
  const out = {} as IdeaListRow;
  for (const [k, v] of Object.entries(row)) if (!k.startsWith('_')) out[k] = v;
  return out;
}

async function runList(ctx: Ctx, join: string, where: string[], keys: { expr: string }[], outer: string[], params: unknown[], limit: number) {
  const r = await ctx.db.query<Record<string, unknown>>(
    `SELECT * FROM (
       SELECT i.id, i.number, i.title, i.topic, i.status, i.idea_type AS "ideaType", i.idea_kind AS "ideaKind", i.confidential, i.anonymous,
              i.challenge_id AS "challengeId", i.created_at AS "createdAt", i.submitted_at AS "submittedAt", i.updated_at AS "updatedAt",
              CASE WHEN i.anonymous AND NOT ($2::boolean OR i.author_id = $1 OR i.submitted_by_id IS NOT DISTINCT FROM $1) THEN NULL ELSE u.display_name END AS "authorName",
              sp.n AS supporters,
              (SELECT count(*) FROM comments c WHERE c.idea_id = i.id)::int AS comments,
              -- Open answer deadline, so lists can show what happens next (usability review 10/2026).
              (SELECT d.due_on FROM deadlines d WHERE d.idea_id = i.id AND d.completed_at IS NULL AND d.paused_on IS NULL ORDER BY d.due_on LIMIT 1) AS "dueOn",
              ${keys.map((k, n) => `${k.expr} AS _k${n}, (${k.expr})::text AS _c${n}`).join(', ')}
         FROM ideas i JOIN users u ON u.id = i.author_id
         ${join}
         ${keys.some((k) => k.expr === 'sp.n')
           // Sorting by support needs the count of every row: one aggregate beats a lookup per row.
           ? 'LEFT JOIN (SELECT idea_id, count(*)::int AS n FROM supports GROUP BY idea_id) spc ON spc.idea_id = i.id CROSS JOIN LATERAL (SELECT coalesce(spc.n, 0) AS n) sp'
           : 'CROSS JOIN LATERAL (SELECT count(*)::int AS n FROM supports s WHERE s.idea_id = i.id) sp'}
        WHERE ${where.join(' AND ')}
     ) x
     ${outer.length ? `WHERE ${outer.join(' AND ')}` : ''}
     ORDER BY ${keys.map((_, n) => `x._k${n} DESC`).join(', ')}, x.id DESC
     LIMIT ${limit + 1}`,
    params,
  );
  return r.rows;
}

async function ideaDetail(ctx: Ctx, idea: IdeaRow) {
  const me = ctx.user!;
  const triage = isTriage(me);
  const showAuthor = !idea.anonymous || triage || isAuthor(me, idea);
  const people = await ctx.db.query<{ id: string; display_name: string; org_unit: string | null }>(
    'SELECT id, display_name, org_unit FROM users WHERE id = ANY($1::uuid[])',
    [[idea.author_id, idea.submitted_by_id].filter(Boolean)],
  );
  const person = (id: string | null) => people.rows.find((p) => p.id === id);
  // One connection per transaction: queries run one after another.
  const events = await ctx.db.query(
    `SELECT e.id, e.kind, e.from_status AS "fromStatus", e.to_status AS "toStatus", e.message, e.created_at AS "createdAt",
            CASE WHEN e.actor_id = $2 AND $3::boolean = false THEN NULL ELSE u.display_name END AS "actorName"
       FROM idea_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.idea_id = $1 ORDER BY e.id`,
    [idea.id, idea.author_id, showAuthor],
  );
  const comments = await ctx.db.query(
    `SELECT c.id, c.parent_id AS "parentId", c.body, c.created_at AS "createdAt", c.kind,
            CASE WHEN c.author_id = $2 AND $3::boolean = false THEN 'Ideengeber:in' ELSE u.display_name END AS "authorName"
       FROM comments c JOIN users u ON u.id = c.author_id
      WHERE c.idea_id = $1 AND (c.hidden_at IS NULL OR $4::boolean) ORDER BY c.created_at`,
    // Comments hidden by the moderation (R3-21) stay visible to triage only.
    [idea.id, idea.author_id, showAuthor, triage],
  );
  const support = await ctx.db.query<{ count: number; mine: boolean }>(
    'SELECT count(*)::int AS count, coalesce(bool_or(user_id = $2), false) AS mine FROM supports WHERE idea_id = $1',
    [idea.id, me.id],
  );
  const questions = await ctx.db.query(
    `SELECT round, question, answer, asked_on AS "askedOn", answered_at AS "answeredAt" FROM questions WHERE idea_id = $1 ORDER BY round`,
    [idea.id],
  );
  const decisions = await ctx.db.query(
    `SELECT d.gate, d.outcome, d.reason, d.resubmit_on AS "resubmitOn", d.decided_at AS "decidedAt", o.display_name AS "ownerName",
            d.delegated, d.meeting_id AS "meetingId"
       FROM decisions d LEFT JOIN users o ON o.id = d.owner_id WHERE d.idea_id = $1 ORDER BY d.decided_at`,
    [idea.id],
  );
  const impl = await ctx.db.query<ImplementationRow & { owner_name: string }>(
    'SELECT im.*, u.display_name AS owner_name FROM implementations im JOIN users u ON u.id = im.owner_id WHERE im.idea_id = $1',
    [idea.id],
  );
  const deadline = await ctx.db.query<DeadlineRow>('SELECT * FROM deadlines WHERE idea_id = $1 AND completed_at IS NULL ORDER BY created_at DESC LIMIT 1', [idea.id]);
  const challenge = idea.challenge_id ? await ctx.db.query('SELECT id, title FROM challenges WHERE id = $1', [idea.challenge_id]) : null;
  const coauthors = await ctx.db.query<{ id: string; name: string }>(
    `SELECT u.id, u.display_name AS name FROM idea_coauthors c JOIN users u ON u.id = c.user_id WHERE c.idea_id = $1 ORDER BY u.display_name`,
    [idea.id],
  );
  const attachments = await ctx.db.query(
    `SELECT a.id, a.filename, a.mime, a.size, a.scan_status AS "scanStatus", a.created_at AS "createdAt", a.uploaded_by AS "uploadedBy"
       FROM attachments a WHERE a.idea_id = $1 ORDER BY a.created_at`,
    [idea.id],
  );
  const merged = idea.merged_into
    ? (await ctx.db.query('SELECT id, number, title FROM ideas WHERE id = $1', [idea.merged_into])).rows[0] ?? null
    : null;
  const challengeFields = idea.challenge_id
    ? (await ctx.db.query<{ custom_fields: { id: string; label: string }[] }>('SELECT custom_fields FROM challenges WHERE id = $1', [idea.challenge_id])).rows[0]?.custom_fields ?? []
    : [];
  const mentor = idea.mentor_id
    ? (await ctx.db.query<{ id: string; name: string }>('SELECT id, display_name AS name FROM users WHERE id = $1', [idea.mentor_id])).rows[0] ?? null
    : null;
  const gate2 = idea.status === 'elaboration' ? await gate2Authority(ctx, idea) : { allowed: false, delegated: false };
  const im = impl.rows[0];
  const isOwner = !!im && (await actsFor(ctx, im.owner_id));
  const open = !['merged', 'rejected', 'forwarded', 'closed_no_answer', 'completed'].includes(idea.status);
  const author = person(idea.author_id);
  const maxRounds = ctx.settings.deadlines.maxQuestionRounds;
  return {
    id: idea.id,
    number: idea.number,
    title: idea.title,
    problem: idea.problem,
    solution: idea.solution,
    benefit: idea.benefit,
    topic: idea.topic,
    ideaType: idea.idea_type,
    ideaKind: idea.idea_kind ?? 'idea',
    confidential: idea.confidential,
    // External participation and moderation (R3-19, R3-21).
    origin: idea.origin ?? 'internal',
    moderation: idea.moderation ?? null,
    anonymous: idea.anonymous,
    status: idea.status,
    lane: idea.lane,
    forwardedTo: idea.forwarded_to,
    resubmitOn: idea.resubmit_on,
    createdAt: idea.created_at,
    submittedAt: idea.submitted_at,
    challenge: challenge?.rows[0] ?? null,
    author: showAuthor && author ? { id: author.id, name: author.display_name, orgUnit: author.org_unit } : null,
    submittedBy: idea.submitted_by_id ? { name: person(idea.submitted_by_id)?.display_name ?? null } : null,
    authorConfirmed: idea.author_confirmed,
    deadline: deadline.rows[0] ? deadlineInfo(ctx, deadline.rows[0]) : null,
    events: events.rows,
    comments: comments.rows,
    supporters: support.rows[0].count,
    supportedByMe: support.rows[0].mine,
    questions: questions.rows,
    decisions: decisions.rows,
    implementation: im
      ? {
          ownerId: im.owner_id,
          ownerName: im.owner_name,
          channel: im.channel,
          orgUnit: im.org_unit,
          externalRef: im.external_ref,
          targetDate: im.target_date,
          progress: im.progress,
          status: im.status,
          benefitKind: im.benefit_kind,
          benefitValue: im.benefit_value,
          benefitEvidence: im.benefit_evidence,
          closedAt: im.closed_at,
        }
      : null,
    feedbackPending: await pendingFeedbackPhase(ctx, idea),
    coauthors: showAuthor ? coauthors.rows : [],
    attachments: attachments.rows,
    mergedInto: merged,
    // Release 2: mentor and timebox (R2-01), challenge fields and team (R2-35).
    mentor,
    timeboxUntil: idea.timebox_until ?? null,
    teamName: idea.team_name ?? null,
    originalText: (idea as { original_text?: string | null }).original_text ?? null,
    challengeValues: challengeFields
      .filter((f) => idea.custom_values?.[f.id] !== undefined)
      .map((f) => ({ id: f.id, label: f.label, value: idea.custom_values![f.id] })),
    can: {
      edit: isAuthor(me, idea) && idea.status === 'draft',
      submit: isAuthor(me, idea) && idea.status === 'draft',
      confirmAuthorship: me.id === idea.author_id && !idea.author_confirmed,
      answer: isAuthor(me, idea) && idea.status === 'in_question',
      ask: triage && idea.status === 'submitted' && questions.rows.length < maxRounds,
      triage: triage && idea.status === 'submitted',
      decide: gate2.allowed,
      decideDelegated: gate2.delegated,
      acceptImplementation: isOwner && im?.status === 'proposed',
      manageImplementation: (isOwner || triage) && !!im && im.status !== 'done',
      closeImplementation: (isOwner || triage) && im?.status === 'active',
      comment: idea.status !== 'draft' && idea.status !== 'merged',
      support: idea.status !== 'draft' && idea.status !== 'merged' && !isAuthor(me, idea),
      merge: triage && ['submitted', 'in_question'].includes(idea.status),
      manageCoauthors: (isAuthor(me, idea) || triage) && open,
      attach: (isAuthor(me, idea) || triage) && open,
      deleteAttachments: isAuthor(me, idea) || triage,
      report: idea.status !== 'draft' && !isAuthor(me, idea),
    },
  };
}

const BOARD_ROLES: Role[] = ['triage', 'admin', 'committee'];

export async function ideaRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/ideas', tenantHandler(async (ctx, req) => listRoute(ctx, listQuery.parse(req.query))));

  app.get(
    '/api/ideas/similar',
    tenantHandler(async (ctx, req) => {
      const q = z.object({ text: z.string().max(5000), exclude: z.uuid().optional() }).parse(req.query);
      if (q.text.trim().length < 8) return [];
      // Semantic similarity with the local embedding model when pgvector is enabled, otherwise
      // trigram similarity; both within the tenant (R1-19, R3-28).
      return (await findSimilar(ctx, q.text, { exclude: q.exclude })).items;
    }),
  );

  app.post(
    '/api/boundary-check',
    tenantHandler(async (ctx, req) => {
      const { text } = z.object({ text: z.string().max(20000) }).parse(req.body);
      return { matches: checkBoundary(text, ctx.settings) };
    }),
  );

  app.post(
    '/api/ideas',
    tenantHandler(async (ctx, req, reply) => {
      const body = ideaInput.extend({ onBehalfOf: z.uuid().optional() }).parse(req.body);
      if (body.topic && !ctx.settings.topics.includes(body.topic)) throw badRequest(m('misc.unknownTopic'));
      const idea = await createIdea(ctx, body, body.onBehalfOf);
      reply.code(201);
      return { id: idea.id, number: idea.number };
    }),
  );

  app.get('/api/ideas/:id', tenantHandler(async (ctx, req) => ideaDetail(ctx, await loadIdea(ctx, idParam(req)))));

  app.patch(
    '/api/ideas/:id',
    tenantHandler(async (ctx, req) => {
      const idea = await loadIdea(ctx, idParam(req), true);
      const parsed = ideaInput.partial().parse(req.body);
      // Defaults of the full schema must not overwrite fields that were not sent.
      const sent = new Set(Object.keys((req.body ?? {}) as object));
      const body = Object.fromEntries(Object.entries(parsed).filter(([k]) => sent.has(k))) as typeof parsed;
      if (body.topic && !ctx.settings.topics.includes(body.topic)) throw badRequest(m('misc.unknownTopic'));
      await updateDraft(ctx, idea, body);
      return { ok: true };
    }),
  );

  app.delete(
    '/api/ideas/:id',
    tenantHandler(async (ctx, req) => {
      const idea = await loadIdea(ctx, idParam(req), true);
      if (!isAuthor(ctx.user, idea) || idea.status !== 'draft') throw badRequest(m('ideas.deleteOwnDrafts'));
      await ctx.db.query('DELETE FROM ideas WHERE id = $1', [idea.id]);
      return { ok: true };
    }),
  );

  app.post(
    '/api/ideas/:id/submit',
    tenantHandler(async (ctx, req) => {
      const body = submitInput.parse(req.body);
      await submitIdea(ctx, await loadIdea(ctx, idParam(req), true), body);
      return { ok: true };
    }),
  );

  app.post(
    '/api/ideas/:id/confirm-authorship',
    tenantHandler(async (ctx, req) => {
      await confirmAuthorship(ctx, await loadIdea(ctx, idParam(req), true));
      return { ok: true };
    }),
  );

  app.post(
    '/api/ideas/:id/comments',
    tenantHandler(async (ctx, req, reply) => {
      const idea = await loadIdea(ctx, idParam(req));
      if (idea.status === 'draft') throw badRequest(m('ideas.noDraftComments'));
      const body = commentInput.parse(req.body);
      if (body.parentId) {
        const parent = await ctx.db.query('SELECT 1 FROM comments WHERE id = $1 AND idea_id = $2', [body.parentId, idea.id]);
        if (!parent.rowCount) throw notFound(m('ideas.commentNotFound'));
      }
      if (body.kind === 'solution' && idea.idea_kind !== 'problem') throw badRequest(m('usecases.solutionOnlyProblem'));
      await ctx.db.query('INSERT INTO comments (tenant_id, idea_id, parent_id, author_id, body, kind) VALUES ($1, $2, $3, $4, $5, $6)', [
        ctx.tenantId, idea.id, body.parentId ?? null, ctx.user!.id, body.body, body.kind,
      ]);
      await notifyAuthors(ctx, idea, m('ideas.comment.subject', ideaVars(idea)), `${ctx.user!.displayName}: ${body.body}`, 'community', ctx.user!.id);
      reply.code(201);
      return { ok: true };
    }),
  );

  app.post(
    '/api/ideas/:id/support',
    tenantHandler(async (ctx, req) => {
      const idea = await loadIdea(ctx, idParam(req));
      if (idea.status === 'draft' || isAuthor(ctx.user, idea)) throw badRequest(m('ideas.cannotSupport'));
      const r = await ctx.db.query('INSERT INTO supports (tenant_id, idea_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [
        ctx.tenantId, idea.id, ctx.user!.id,
      ]);
      if (r.rowCount) {
        await notifyAuthors(ctx, idea, m('ideas.support.subject', ideaVars(idea)), m('ideas.support.body', { name: ctx.user!.displayName }), 'community', ctx.user!.id);
      }
      return { ok: true };
    }),
  );

  app.delete(
    '/api/ideas/:id/support',
    tenantHandler(async (ctx, req) => {
      const idea = await loadIdea(ctx, idParam(req));
      await ctx.db.query('DELETE FROM supports WHERE idea_id = $1 AND user_id = $2', [idea.id, ctx.user!.id]);
      return { ok: true };
    }),
  );

  app.post(
    '/api/ideas/:id/feedback',
    tenantHandler(async (ctx, req) => {
      const body = z.object({ score: z.number().int().min(1).max(5), comment: z.string().trim().max(1000).nullable().default(null) }).parse(req.body);
      await rateFeedback(ctx, await loadIdea(ctx, idParam(req)), body.score, body.comment);
      return { ok: true };
    }),
  );

  app.post(
    '/api/ideas/:id/question',
    tenantHandler(async (ctx, req) => {
      const { question } = z.object({ question: z.string().trim().min(5).max(2000) }).parse(req.body);
      await askQuestion(ctx, await loadIdea(ctx, idParam(req), true), question);
      return { ok: true };
    }),
  );

  app.post(
    '/api/ideas/:id/answer',
    tenantHandler(async (ctx, req) => {
      const { answer } = z.object({ answer: z.string().trim().min(2).max(5000) }).parse(req.body);
      await answerQuestion(ctx, await loadIdea(ctx, idParam(req), true), answer);
      return { ok: true };
    }),
  );

  app.post(
    '/api/ideas/:id/triage',
    tenantHandler(async (ctx, req) => {
      const r = await triageIdea(ctx, await loadIdea(ctx, idParam(req), true), triageInput.parse(req.body));
      return { ok: true, warning: r.warning ?? null };
    }),
  );

  app.post(
    '/api/ideas/:id/decision',
    tenantHandler(async (ctx, req) => {
      await decideGate2(ctx, await loadIdea(ctx, idParam(req), true), decisionInput.parse(req.body));
      return { ok: true };
    }),
  );

  app.post(
    '/api/ideas/:id/implementation/accept',
    tenantHandler(async (ctx, req) => {
      await acceptImplementation(ctx, await loadIdea(ctx, idParam(req), true));
      return { ok: true };
    }),
  );

  app.patch(
    '/api/ideas/:id/implementation',
    tenantHandler(async (ctx, req) => {
      await updateImplementation(ctx, await loadIdea(ctx, idParam(req), true), implementationUpdate.parse(req.body));
      return { ok: true };
    }),
  );

  app.post(
    '/api/ideas/:id/implementation/close',
    tenantHandler(async (ctx, req) => {
      await closeImplementation(ctx, await loadIdea(ctx, idParam(req), true), closeInput.parse(req.body));
      return { ok: true };
    }),
  );

  app.post(
    '/api/ideas/:id/merge',
    tenantHandler(async (ctx, req) => {
      const body = z.object({ targetId: z.uuid(), reason: z.string().trim().min(10).max(2000) }).parse(req.body);
      const source = await loadIdea(ctx, idParam(req), true);
      const target = await loadIdea(ctx, body.targetId, true);
      await mergeIdeas(ctx, source, target, body.reason);
      return { ok: true };
    }),
  );

  app.post(
    '/api/ideas/:id/coauthors',
    tenantHandler(async (ctx, req) => {
      const { userId } = z.object({ userId: z.uuid() }).parse(req.body);
      await addCoauthor(ctx, await loadIdea(ctx, idParam(req), true), userId);
      return { ok: true };
    }),
  );

  app.delete(
    '/api/ideas/:id/coauthors/:userId',
    tenantHandler(async (ctx, req) => {
      const { userId } = z.object({ userId: z.uuid() }).parse(req.params);
      await removeCoauthor(ctx, await loadIdea(ctx, idParam(req), true), userId);
      return { ok: true };
    }),
  );

  // Attachments (R1-13)
  app.post(
    '/api/ideas/:id/attachments',
    { bodyLimit: Math.ceil(MAX_ATTACHMENT_BYTES * 1.4) + 10_000 },
    tenantHandler(async (ctx, req, reply) => {
      const idea = await loadIdea(ctx, idParam(req));
      if (!isAuthor(ctx.user, idea) && !isTriage(ctx.user)) throw badRequest(m('ideas.attachRights'));
      const body = z.object({ filename: z.string().min(1).max(200), data: z.base64() }).parse(req.body);
      const data = Buffer.from(body.data, 'base64');
      if (data.length === 0) throw badRequest(m('ideas.fileEmpty'));
      if (data.length > MAX_ATTACHMENT_BYTES) throw badRequest(m('ideas.fileTooLarge'));
      const filename = sanitizeFilename(body.filename);
      const mime = detectType(filename, data);
      const scanned = await scanForViruses(data);
      const r = await ctx.db.query<{ id: string }>(
        `INSERT INTO attachments (tenant_id, idea_id, filename, mime, size, data, scan_status, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [ctx.tenantId, idea.id, filename, mime, data.length, data, scanned ? 'clean' : 'type_checked', ctx.user!.id],
      );
      reply.code(201);
      return { id: r.rows[0].id };
    }),
  );

  app.get(
    '/api/ideas/:id/attachments/:attachmentId',
    tenantHandler(async (ctx, req, reply) => {
      const idea = await loadIdea(ctx, idParam(req));
      const { attachmentId } = z.object({ attachmentId: z.uuid() }).parse(req.params);
      const a = (await ctx.db.query<{ filename: string; mime: string; data: Buffer }>(
        'SELECT filename, mime, data FROM attachments WHERE id = $1 AND idea_id = $2', [attachmentId, idea.id],
      )).rows[0];
      if (!a) throw notFound(m('ideas.fileNotFound'));
      reply
        .header('content-type', a.mime)
        .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`)
        .header('content-security-policy', "default-src 'none'; sandbox");
      return a.data;
    }),
  );

  app.delete(
    '/api/ideas/:id/attachments/:attachmentId',
    tenantHandler(async (ctx, req) => {
      const idea = await loadIdea(ctx, idParam(req));
      const { attachmentId } = z.object({ attachmentId: z.uuid() }).parse(req.params);
      if (!isAuthor(ctx.user, idea) && !isTriage(ctx.user)) throw badRequest(m('ideas.cannotDeleteFile'));
      await ctx.db.query('DELETE FROM attachments WHERE id = $1 AND idea_id = $2', [attachmentId, idea.id]);
      await audit(ctx, 'attachment.delete', 'idea', idea.id, { attachmentId }, null);
      return { ok: true };
    }),
  );

  // Work lists: triage board (R1-23) and "my tasks".
  app.get(
    '/api/triage/board',
    tenantHandler(
      async (ctx, req) => {
        const q = z.object(pageQuery).parse(req.query);
        const paged = q.limit !== undefined || q.cursor !== undefined;
        const params: unknown[] = [];
        // Keyset on (due date, nulls last; number); cursor key [dueOn | null, number].
        let after = '';
        if (q.cursor) {
          const [due, num] = decodeCursor(q.cursor, 'board');
          if (typeof num !== 'number' || (due !== null && typeof due !== 'string')) throw badRequest(m('ideas.invalidCursor'));
          params.push(due, num);
          after = due === null
            ? 'AND d.due_on IS NULL AND i.number > $2'
            : 'AND (d.due_on > $1::date OR (d.due_on = $1::date AND i.number > $2) OR d.due_on IS NULL)';
        }
        const limit = paged ? q.limit ?? 100 : 10000;
        // Roles with a scope (R3-29): only the ideas of the person's areas.
        const scope = areaFilter(ctx, BOARD_ROLES, 'i.id', params);
        const r = await ctx.db.query<IdeaRow & DeadlineRow & { supporters: number; author_name: string | null }>(
          `SELECT i.id, i.number, i.title, i.topic, i.status, i.confidential, i.resubmit_on,
                  d.phase, d.started_on, d.due_on, d.paused_on, d.completed_at, d.reminded_at, d.escalated_at,
                  u.display_name AS author_name, (SELECT count(*) FROM supports s WHERE s.idea_id = i.id)::int AS supporters
             FROM ideas i
             JOIN users u ON u.id = i.author_id
             LEFT JOIN LATERAL (SELECT * FROM deadlines d WHERE d.idea_id = i.id AND d.completed_at IS NULL ORDER BY d.created_at DESC LIMIT 1) d ON true
            WHERE i.status IN ('submitted', 'in_question', 'elaboration', 'fast_lane', 'implementing', 'piloting', 'integrated', 'parked')
              ${after} ${scope}
            ORDER BY d.due_on NULLS LAST, i.number
            LIMIT ${limit + 1}`,
          params,
        );
        const rows = r.rows.slice(0, limit);
        const items = rows.map((row) => ({
          id: row.id,
          number: row.number,
          title: row.title,
          topic: row.topic,
          status: row.status,
          confidential: row.confidential,
          authorName: row.author_name,
          supporters: row.supporters,
          resubmitOn: row.resubmit_on,
          deadline: row.due_on ? deadlineInfo(ctx, row) : null,
        }));
        if (!paged) return items;
        const last = rows[rows.length - 1];
        const nextCursor = r.rows.length > limit && last ? encodeCursor('board', [last.due_on ?? null, last.number]) : null;
        // Column counts over the whole board, so the badges are right before all pages are loaded.
        const countParams: unknown[] = [];
        const countScope = areaFilter(ctx, BOARD_ROLES, 'i.id', countParams);
        const counts = (await ctx.db.query<{ status: string; n: number }>(
          `SELECT status, count(*)::int AS n FROM ideas i
            WHERE status IN ('submitted', 'in_question', 'elaboration', 'fast_lane', 'implementing', 'piloting', 'integrated', 'parked')
              ${countScope}
            GROUP BY status`,
          countParams,
        )).rows;
        return { items, nextCursor, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) };
      },
      { roles: BOARD_ROLES },
    ),
  );

  app.get(
    '/api/tasks',
    tenantHandler(async (ctx) => {
      const me = ctx.user!;
      const implementations = await ctx.db.query(
        `SELECT i.id, i.number, i.title, i.status, im.status AS "implementationStatus", im.target_date AS "targetDate", im.progress
           FROM implementations im JOIN ideas i ON i.id = im.idea_id
          WHERE im.owner_id = ANY($1::uuid[]) AND im.status <> 'done'
            AND i.status IN ('fast_lane', 'implementing', 'piloting', 'integrated') ORDER BY im.target_date`,
        [[me.id, ...(await deputyOf(ctx))]],
      );
      const releaseTwo = await release2Tasks(ctx);
      const questions = await ctx.db.query(
        `SELECT i.id, i.number, i.title, i.status FROM ideas i
          WHERE (i.author_id = $1 OR i.submitted_by_id IS NOT DISTINCT FROM $1) AND i.status = 'in_question' ORDER BY i.number`,
        [me.id],
      );
      const confirmations = await ctx.db.query(
        `SELECT i.id, i.number, i.title, i.status FROM ideas i WHERE i.author_id = $1 AND NOT i.author_confirmed ORDER BY i.number`,
        [me.id],
      );
      return { implementations: implementations.rows, questions: questions.rows, confirmations: confirmations.rows, ...releaseTwo };
    }),
  );

}
