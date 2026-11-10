import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantHandler } from '../http.js';
import { m } from '../i18n/index.js';
import { PERMISSIONS, isExternal } from '../lib/context.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { enforce } from '../lib/ratelimit.js';
import { audit } from '../services/audit.js';
import { EXTERNAL_VISIBLE_SQL } from '../services/external.js';
import { isAuthor, loadIdea } from '../services/workflow.js';

// Moderation (R3-21): release of external posts before publication (per challenge or tenant),
// the report function ("Melden") for ideas and comments, and the queue of the moderation.
// Reporters stay anonymous towards the moderation; the queue shows content and reason only.

const moderators = { roles: PERMISSIONS.moderate };
const idParam = (req: { params: unknown }) => z.object({ id: z.uuid() }).parse(req.params).id;

export const reportInput = z.object({
  reason: z.enum(['spam', 'offensive', 'confidential', 'other']),
  note: z.string().trim().max(1000).optional(),
  commentId: z.uuid().optional(),
});

export async function moderationRoutes(app: FastifyInstance): Promise<void> {
  // Report an idea or a comment. External people report only ideas they can see.
  app.post(
    '/api/ideas/:id/report',
    tenantHandler(async (ctx, req, reply) => {
      const body = reportInput.parse(req.body);
      const id = idParam(req);
      await enforce([['reportAccount', ctx.user!.id]]);
      const me = ctx.user!.id;
      if (isExternal(ctx.user)) {
        if (body.commentId) throw badRequest(m('ideas.commentNotFound'));
        const r = await ctx.db.query<{ author_id: string }>(`SELECT i.author_id FROM ideas i WHERE i.id = $2 AND ${EXTERNAL_VISIBLE_SQL}`, [me, id]);
        if (!r.rows[0]) throw notFound(m('workflow.ideaNotFound'));
        if (r.rows[0].author_id === me) throw badRequest(m('external.reportOwn'));
      } else {
        const idea = await loadIdea(ctx, id);
        if (idea.status === 'draft') throw notFound(m('workflow.ideaNotFound'));
        if (body.commentId) {
          const c = (await ctx.db.query<{ author_id: string }>('SELECT author_id FROM comments WHERE id = $1 AND idea_id = $2 AND hidden_at IS NULL', [body.commentId, id])).rows[0];
          if (!c) throw notFound(m('ideas.commentNotFound'));
          if (c.author_id === me) throw badRequest(m('external.reportOwn'));
        } else if (isAuthor(ctx.user, idea)) {
          throw badRequest(m('external.reportOwn'));
        }
      }
      const r = await ctx.db.query(
        `INSERT INTO content_reports (tenant_id, idea_id, comment_id, reporter_id, reason, note) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [ctx.tenantId, id, body.commentId ?? null, me, body.reason, body.note || null],
      );
      if (!r.rowCount) throw conflict(m('external.reportExists'), 'ALREADY_REPORTED');
      reply.code(201);
      return { ok: true };
    }, { external: true }),
  );

  // Queue: external posts waiting for release and open reports.
  app.get(
    '/api/moderation',
    tenantHandler(async (ctx) => {
      const pending = await ctx.db.query(
        `SELECT i.id, i.number, i.title, left(i.problem, 400) AS excerpt, i.status, i.origin, i.submitted_at AS "submittedAt",
                c.title AS "challengeTitle"
           FROM ideas i LEFT JOIN challenges c ON c.id = i.challenge_id
          WHERE i.moderation = 'pending' AND i.status <> 'draft' ORDER BY i.submitted_at NULLS LAST, i.number`,
      );
      const reports = await ctx.db.query(
        `SELECT r.id, r.reason, r.note, r.created_at AS "createdAt", r.idea_id AS "ideaId", i.number, i.title, i.moderation, i.origin,
                r.comment_id AS "commentId", left(cm.body, 400) AS "commentBody"
           FROM content_reports r JOIN ideas i ON i.id = r.idea_id LEFT JOIN comments cm ON cm.id = r.comment_id
          WHERE r.status = 'open' ORDER BY r.created_at`,
      );
      return { pending: pending.rows, reports: reports.rows };
    }, moderators),
  );

  app.post(
    '/api/moderation/ideas/:id',
    tenantHandler(async (ctx, req) => {
      const { action } = z.object({ action: z.enum(['approve', 'hide']) }).parse(req.body);
      const id = idParam(req);
      const idea = (await ctx.db.query<{ moderation: string | null; status: string }>('SELECT moderation, status FROM ideas WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!idea || idea.status === 'draft') throw notFound(m('workflow.ideaNotFound'));
      if (action === 'approve' && idea.moderation !== 'pending' && idea.moderation !== 'hidden') throw conflict(m('external.notPending'), 'NOT_PENDING');
      const to = action === 'approve' ? 'approved' : 'hidden';
      await ctx.db.query('UPDATE ideas SET moderation = $2 WHERE id = $1', [id, to]);
      await ctx.db.query(
        `UPDATE content_reports SET status = $2, resolved_by = $3, resolved_at = now() WHERE idea_id = $1 AND comment_id IS NULL AND status = 'open'`,
        [id, action === 'approve' ? 'dismissed' : 'hidden', ctx.user!.id],
      );
      await audit(ctx, `moderation.${action}`, 'idea', id, { moderation: idea.moderation }, { moderation: to });
      return { moderation: to };
    }, moderators),
  );

  app.post(
    '/api/moderation/reports/:id',
    tenantHandler(async (ctx, req) => {
      const { action } = z.object({ action: z.enum(['dismiss', 'hide']) }).parse(req.body);
      const report = (await ctx.db.query<{ idea_id: string; comment_id: string | null; status: string }>(
        'SELECT idea_id, comment_id, status FROM content_reports WHERE id = $1 FOR UPDATE', [idParam(req)],
      )).rows[0];
      if (!report) throw notFound();
      if (report.status !== 'open') throw conflict(m('external.reportClosed'), 'REPORT_CLOSED');
      if (action === 'hide') {
        if (report.comment_id) await ctx.db.query('UPDATE comments SET hidden_at = now() WHERE id = $1', [report.comment_id]);
        else await ctx.db.query(`UPDATE ideas SET moderation = 'hidden' WHERE id = $1`, [report.idea_id]);
      }
      // All open reports on the same post are settled together.
      await ctx.db.query(
        `UPDATE content_reports SET status = $3, resolved_by = $4, resolved_at = now()
          WHERE idea_id = $1 AND comment_id IS NOT DISTINCT FROM $2 AND status = 'open'`,
        [report.idea_id, report.comment_id, action === 'hide' ? 'hidden' : 'dismissed', ctx.user!.id],
      );
      await audit(ctx, `moderation.report_${action}`, report.comment_id ? 'comment' : 'idea', report.comment_id ?? report.idea_id, null, { action });
      return { ok: true };
    }, moderators),
  );
}
