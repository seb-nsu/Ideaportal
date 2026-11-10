import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requestLocale, tenantHandler } from '../http.js';
import { createToken, listTokens, revokeToken, tokenInput } from '../services/apitokens.js';
import { DOCS_CSS, buildOpenApi, docsHtml } from '../services/openapi.js';
import {
  createWebhook,
  deleteWebhook,
  listDeliveries,
  listWebhooks,
  rotateWebhookSecret,
  testWebhook,
  updateWebhook,
  webhookInput,
  webhookUpdate,
} from '../services/webhooks.js';
import { loadIdea } from '../services/workflow.js';

// Public API (R3-17): token and webhook management under Einstellungen › Integrationen,
// the status endpoint for connectors and the OpenAPI description.

const admin = { roles: ['admin' as const] };
const idParam = (params: unknown) => z.object({ id: z.uuid() }).parse(params).id;

export async function integrationRoutes(app: FastifyInstance): Promise<void> {
  // OpenAPI and the readable page need no login: they describe the API, they hold no data.
  app.get('/api/openapi.json', async (req) => buildOpenApi(requestLocale(req)));
  app.get('/api/docs', async (req, reply) => reply.type('text/html; charset=utf-8').send(docsHtml(requestLocale(req))));
  app.get('/api/docs.css', async (_req, reply) => reply.type('text/css; charset=utf-8').send(DOCS_CSS));

  // Status and history of an idea for connectors; visibility as in the detail view.
  app.get(
    '/api/ideas/:id/status',
    tenantHandler(async (ctx, req) => {
      const idea = await loadIdea(ctx, idParam(req.params));
      const history = await ctx.db.query(
        `SELECT kind, from_status AS "from", to_status AS "to", created_at AS at FROM idea_events
          WHERE idea_id = $1 AND to_status IS DISTINCT FROM from_status ORDER BY id`,
        [idea.id],
      );
      return { id: idea.id, number: idea.number, status: idea.status, lane: idea.lane, updatedAt: idea.updated_at, history: history.rows };
    }),
  );

  app.get('/api/admin/api-tokens', tenantHandler(async (ctx) => listTokens(ctx), admin));
  app.post(
    '/api/admin/api-tokens',
    tenantHandler(async (ctx, req, reply) => {
      const created = await createToken(ctx, tokenInput.parse(req.body));
      reply.code(201);
      return created;
    }, admin),
  );
  app.post(
    '/api/admin/api-tokens/:id/revoke',
    tenantHandler(async (ctx, req) => {
      await revokeToken(ctx, idParam(req.params));
      return { ok: true };
    }, admin),
  );

  app.get('/api/admin/webhooks', tenantHandler(async (ctx) => listWebhooks(ctx), admin));
  app.post(
    '/api/admin/webhooks',
    tenantHandler(async (ctx, req, reply) => {
      const created = await createWebhook(ctx, webhookInput.parse(req.body));
      reply.code(201);
      return created;
    }, admin),
  );
  app.patch(
    '/api/admin/webhooks/:id',
    tenantHandler(async (ctx, req) => {
      await updateWebhook(ctx, idParam(req.params), webhookUpdate.parse(req.body));
      return { ok: true };
    }, admin),
  );
  app.delete(
    '/api/admin/webhooks/:id',
    tenantHandler(async (ctx, req) => {
      await deleteWebhook(ctx, idParam(req.params));
      return { ok: true };
    }, admin),
  );
  app.post(
    '/api/admin/webhooks/:id/rotate-secret',
    tenantHandler(async (ctx, req) => rotateWebhookSecret(ctx, idParam(req.params)), admin),
  );
  app.post(
    '/api/admin/webhooks/:id/test',
    tenantHandler(async (ctx, req) => {
      await testWebhook(ctx, idParam(req.params));
      return { ok: true };
    }, admin),
  );
  app.get('/api/admin/webhooks/:id/deliveries', tenantHandler(async (ctx, req) => listDeliveries(ctx, idParam(req.params)), admin));
}
