import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { withSystem, withTenant } from '../db/pool.js';
import { tenantHandler } from '../http.js';
import { cat, m, type MessageKey } from '../i18n/index.js';
import { PERMISSIONS, buildCtx, can, type Ctx } from '../lib/context.js';
import { HttpError, notFound } from '../lib/errors.js';
import { clientIp, enforce } from '../lib/ratelimit.js';
import { audit } from '../services/audit.js';
import { spamCheck } from '../services/external.js';
import { FEATURE_STATUSES, featureRequestsOn } from '../services/featureRequests.js';
import { notifyUsers } from '../services/notify.js';

// Feature requests with voting and a public status page per tenant (R3-20). One vote per person;
// the public page shows title, description, status and the number of votes, never people.
// Customers with an external account (R3-19) may submit and vote as well.

const ext = { external: true };
const idParam = (req: { params: unknown }) => z.object({ id: z.uuid() }).parse(req.params).id;

function requireOn(ctx: Ctx): void {
  if (!featureRequestsOn(ctx)) throw new HttpError(404, m('external.feature.off'), 'FEATURE_OFF');
}

/** A request the person may see: reviewed ones, own new ones, all for the product team. */
async function visibleRequest(ctx: Ctx, id: string) {
  const r = await ctx.db.query<{ id: string; number: number; title: string; status: string; created_by: string | null }>(
    `SELECT id, number, title, status, created_by FROM feature_requests WHERE id = $1 AND (status <> 'new' OR created_by = $2 OR $3::boolean)`,
    [id, ctx.user!.id, can(ctx.user, 'featureRequests')],
  );
  if (!r.rows[0]) throw notFound(m('external.feature.notFound'));
  return r.rows[0];
}

export async function featureRequestRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/feature-requests',
    tenantHandler(async (ctx) => {
      requireOn(ctx);
      const manage = can(ctx.user, 'featureRequests');
      const r = await ctx.db.query(
        `SELECT f.id, f.number, f.title, f.description, f.status, f.status_note AS "statusNote", f.created_at AS "createdAt", f.updated_at AS "updatedAt",
                (SELECT count(*) FROM feature_votes v WHERE v.request_id = f.id)::int AS votes,
                EXISTS (SELECT 1 FROM feature_votes v WHERE v.request_id = f.id AND v.user_id = $1) AS "votedByMe",
                (f.created_by IS NOT DISTINCT FROM $1) AS mine
           FROM feature_requests f
          WHERE f.status <> 'new' OR f.created_by = $1 OR $2::boolean
          ORDER BY votes DESC, f.number DESC LIMIT 500`,
        [ctx.user!.id, manage],
      );
      const slug = (await ctx.db.query<{ slug: string }>('SELECT slug FROM tenants WHERE id = $1', [ctx.tenantId])).rows[0].slug;
      return {
        items: r.rows,
        canManage: manage,
        publicUrl: ctx.settings.featureRequests.publicPage ? `${config.publicUrl}/statusseite/${slug}` : null,
      };
    }, ext),
  );

  app.post(
    '/api/feature-requests',
    tenantHandler(async (ctx, req, reply) => {
      requireOn(ctx);
      const body = z
        .object({ title: z.string().trim().min(3).max(140), description: z.string().trim().max(3000).default(''), website: z.string().max(500).optional() })
        .parse(req.body);
      // Spam protection as for external posts (R3-21).
      spamCheck(ctx, [body.title, body.description], body.website);
      await enforce([['externalPostAccount', ctx.user!.id]]);
      await ctx.db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`feature:${ctx.tenantId}`]);
      const r = await ctx.db.query<{ id: string; number: number }>(
        `INSERT INTO feature_requests (tenant_id, number, title, description, created_by)
         VALUES ($1, (SELECT coalesce(max(number), 0) + 1 FROM feature_requests), $2, $3, $4) RETURNING id, number`,
        [ctx.tenantId, body.title, body.description, ctx.user!.id],
      );
      // The person who asks for a feature votes for it.
      await ctx.db.query('INSERT INTO feature_votes (tenant_id, request_id, user_id) VALUES ($1, $2, $3)', [ctx.tenantId, r.rows[0].id, ctx.user!.id]);
      reply.code(201);
      return r.rows[0];
    }, ext),
  );

  app.post(
    '/api/feature-requests/:id/vote',
    tenantHandler(async (ctx, req) => {
      requireOn(ctx);
      const f = await visibleRequest(ctx, idParam(req));
      await ctx.db.query('INSERT INTO feature_votes (tenant_id, request_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [ctx.tenantId, f.id, ctx.user!.id]);
      return { votes: (await ctx.db.query<{ n: number }>('SELECT count(*)::int AS n FROM feature_votes WHERE request_id = $1', [f.id])).rows[0].n };
    }, ext),
  );

  app.delete(
    '/api/feature-requests/:id/vote',
    tenantHandler(async (ctx, req) => {
      requireOn(ctx);
      const f = await visibleRequest(ctx, idParam(req));
      await ctx.db.query('DELETE FROM feature_votes WHERE request_id = $1 AND user_id = $2', [f.id, ctx.user!.id]);
      return { votes: (await ctx.db.query<{ n: number }>('SELECT count(*)::int AS n FROM feature_votes WHERE request_id = $1', [f.id])).rows[0].n };
    }, ext),
  );

  // Status change by the product team; everybody who voted gets a notification.
  app.patch(
    '/api/feature-requests/:id',
    tenantHandler(async (ctx, req) => {
      requireOn(ctx);
      const body = z.object({ status: z.enum(FEATURE_STATUSES), note: z.string().trim().max(1000).nullable().optional() }).parse(req.body);
      const f = await visibleRequest(ctx, idParam(req));
      const note = body.note === undefined ? undefined : body.note || null;
      await ctx.db.query(
        `UPDATE feature_requests SET status = $2, status_note = CASE WHEN $4::boolean THEN $3 ELSE status_note END, updated_at = now() WHERE id = $1`,
        [f.id, body.status, note ?? null, note !== undefined],
      );
      await audit(ctx, 'feature_request.status', 'feature_request', f.id, { status: f.status }, { status: body.status, note });
      if (body.status !== f.status) {
        const voters = (await ctx.db.query<{ user_id: string }>('SELECT user_id FROM feature_votes WHERE request_id = $1', [f.id])).rows.map((v) => v.user_id);
        const recipients = [...new Set([...voters, ...(f.created_by ? [f.created_by] : [])])].filter((id) => id !== ctx.user!.id);
        const status = m(`external.feature.status.${body.status}` as MessageKey);
        await notifyUsers(
          ctx,
          recipients,
          cat([m('external.feature.statusSubject', { number: f.number }), status]),
          cat([m('external.feature.statusBody', { title: f.title }), status, '.', ...(note ? ['\n', m('external.feature.statusNote', { note })] : [])]),
          undefined,
          'my_ideas',
        );
      }
      return { ok: true };
    }, { roles: PERMISSIONS.featureRequests }),
  );

  // Module switch per tenant (admin); the package must include the feature as well.
  app.put(
    '/api/admin/feature-requests',
    tenantHandler(async (ctx, req) => {
      const body = z.object({ enabled: z.boolean(), publicPage: z.boolean() }).parse(req.body);
      await ctx.db.query(`UPDATE tenants SET settings = settings || jsonb_build_object('featureRequests', $2::jsonb) WHERE id = $1`, [ctx.tenantId, JSON.stringify(body)]);
      await audit(ctx, 'settings.feature_requests', 'tenant', ctx.tenantId, ctx.settings.featureRequests, body);
      return body;
    }, { roles: ['admin'] }),
  );

  // Public status page per tenant (no sign-in): no names, no e-mail addresses, no comments.
  app.get('/api/public/feature-requests/:slug', async (req) => {
    const { slug } = z.object({ slug: z.string().min(2).max(40) }).parse(req.params);
    await enforce([['publicPageIp', clientIp(req)]]);
    const t = await withSystem(async (c) => (await c.query<{ id: string; name: string }>('SELECT id, name FROM tenants WHERE slug = $1', [slug])).rows[0]);
    if (!t) throw notFound(m('external.feature.publicOff'));
    const items = await withTenant(t.id, async (db) => {
      const ctx = await buildCtx(db, t.id, null);
      if (!featureRequestsOn(ctx) || !ctx.settings.featureRequests.publicPage) throw notFound(m('external.feature.publicOff'));
      return (await db.query(
        `SELECT f.number, f.title, f.description, f.status, f.status_note AS "statusNote", f.updated_at AS "updatedAt",
                (SELECT count(*) FROM feature_votes v WHERE v.request_id = f.id)::int AS votes
           FROM feature_requests f WHERE f.status <> 'new' ORDER BY votes DESC, f.number DESC LIMIT 500`,
      )).rows;
    });
    return { workspace: t.name, items };
  });
}
