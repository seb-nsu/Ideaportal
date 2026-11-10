import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantHandler } from '../http.js';
import { renderPdf } from '../lib/pdf.js';
import { m, tr } from '../i18n/index.js';
import { bearerToken, userFromToken } from '../services/apitokens.js';
import { markdownToBlocks } from '../services/codetermination.js';
import {
  callbackRolesOk,
  callbackSecret,
  connectorForCallback,
  connectorInput,
  connectorUpdate,
  createConnector,
  deleteConnector,
  handover,
  handoverInput,
  handoverView,
  inboundStatus,
  listConnectors,
  pollConnectorNow,
  rotateCallbackSecret,
  setConnectorEnabled,
  testConnector,
  updateConnector,
  verifyCallback,
} from '../services/connectors.js';
import { parseInbound } from '../services/connectorKinds.js';
import { generateInput, generatePackage, getPackage, packageMarkdown, packageUpdate, updatePackage } from '../services/implpackage.js';
import { loadIdea } from '../services/workflow.js';
import { HttpError, notFound } from '../lib/errors.js';

// Connectors (R3-13 to R3-15) and implementation package (R3-18).

const admin = { roles: ['admin' as const] };
const idParam = (params: unknown) => z.object({ id: z.uuid() }).parse(params).id;

export async function connectorRoutes(app: FastifyInstance): Promise<void> {
  // --- Settings › Integrations › Connectors (admins)
  app.get('/api/admin/connectors', tenantHandler(async (ctx) => listConnectors(ctx), admin));
  app.post(
    '/api/admin/connectors',
    tenantHandler(async (ctx, req, reply) => {
      const created = await createConnector(ctx, connectorInput.parse(req.body));
      reply.code(201);
      return created;
    }, admin),
  );
  app.patch(
    '/api/admin/connectors/:id',
    tenantHandler(async (ctx, req) => {
      await updateConnector(ctx, idParam(req.params), connectorUpdate.parse(req.body));
      return { ok: true };
    }, admin),
  );
  app.post(
    '/api/admin/connectors/:id/enable',
    tenantHandler(async (ctx, req) => {
      await setConnectorEnabled(ctx, idParam(req.params), true);
      return { ok: true };
    }, admin),
  );
  app.post(
    '/api/admin/connectors/:id/disable',
    tenantHandler(async (ctx, req) => {
      await setConnectorEnabled(ctx, idParam(req.params), false);
      return { ok: true };
    }, admin),
  );
  app.post('/api/admin/connectors/:id/rotate-secret', tenantHandler(async (ctx, req) => rotateCallbackSecret(ctx, idParam(req.params)), admin));
  app.post('/api/admin/connectors/:id/test', tenantHandler(async (ctx, req) => testConnector(ctx, idParam(req.params)), admin));
  app.post('/api/admin/connectors/:id/poll', tenantHandler(async (ctx, req) => pollConnectorNow(ctx, idParam(req.params)), admin));
  app.delete(
    '/api/admin/connectors/:id',
    tenantHandler(async (ctx, req) => {
      await deleteConnector(ctx, idParam(req.params));
      return { ok: true };
    }, admin),
  );

  // --- Handover of an idea (owner, per click)
  app.get('/api/ideas/:id/handover', tenantHandler(async (ctx, req) => handoverView(ctx, await loadIdea(ctx, idParam(req.params)))));
  app.post(
    '/api/ideas/:id/handover',
    tenantHandler(async (ctx, req) => handover(ctx, await loadIdea(ctx, idParam(req.params), true), handoverInput.parse(req.body))),
  );

  // --- Implementation package (R3-18)
  app.get(
    '/api/ideas/:id/package',
    tenantHandler(async (ctx, req) => {
      const pkg = await getPackage(ctx, await loadIdea(ctx, idParam(req.params)));
      if (!pkg) throw notFound(m('conn.noPackage'));
      return pkg;
    }),
  );
  app.post(
    '/api/ideas/:id/package/generate',
    // No row lock on the idea: the AI log (own transaction) references it.
    tenantHandler(async (ctx, req) => generatePackage(ctx, await loadIdea(ctx, idParam(req.params)), generateInput.parse(req.body ?? {}))),
  );
  app.put(
    '/api/ideas/:id/package',
    tenantHandler(async (ctx, req) => updatePackage(ctx, await loadIdea(ctx, idParam(req.params), true), packageUpdate.parse(req.body))),
  );
  app.get(
    '/api/ideas/:id/package/export',
    tenantHandler(async (ctx, req, reply) => {
      const idea = await loadIdea(ctx, idParam(req.params));
      const { format } = z.object({ format: z.enum(['md', 'pdf']).default('md') }).parse(req.query);
      const pkg = await getPackage(ctx, idea);
      if (!pkg) throw notFound(m('conn.noPackage'));
      const md = packageMarkdown(ctx.locale, idea, pkg);
      const file = `umsetzungspaket-${idea.number}`;
      if (format === 'md') {
        reply.header('content-type', 'text/markdown; charset=utf-8').header('content-disposition', `attachment; filename="${file}.md"`);
        return md;
      }
      const title = tr(ctx.locale, m('conn.pkg.title', { number: idea.number, title: idea.title }));
      reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${file}.pdf"`);
      return renderPdf(markdownToBlocks(md), { title, footer: tr(ctx.locale, m('conn.pkg.pdfFooter', { number: idea.number, date: ctx.today })) });
    }),
  );

  // --- Status callbacks of the target systems: raw body for the signature check.
  await app.register(async (scope) => {
    scope.removeContentTypeParser(['application/json']);
    scope.addContentTypeParser(['application/json'], { parseAs: 'string', bodyLimit: 500_000 }, (_req, body, done) => done(null, body));

    scope.post('/api/integrations/connectors/:id/status', async (req, reply) => {
      const c = await connectorForCallback((req.params as { id: string }).id);
      if (!c) throw notFound();
      const raw = typeof req.body === 'string' ? req.body : '';
      const secret = await callbackSecret(c);
      if (!(await authorized(req, c.tenant_id, () => verifyCallback(secret, req.headers, raw)))) {
        throw new HttpError(401, m('conn.callbackDenied'), 'CALLBACK_DENIED');
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return reply.status(400).send({ error: tr('de', m('common.validation')), code: 'VALIDATION' });
      }
      const status = parseInbound(c.kind, payload);
      // Other events of the target system are acknowledged and ignored.
      if (!status) return { ok: true, matched: false };
      const r = await inboundStatus(c, status.ref, status.status);
      return { ok: true, matched: r.matched, progress: r.progress };
    });
  });
}

/** API token of the same tenant with an implementation role (AP-12), or the connector secret. */
async function authorized(req: FastifyRequest, tenantId: string, secretOk: () => boolean): Promise<boolean> {
  const token = bearerToken(req);
  if (token !== undefined) {
    try {
      const user = await userFromToken(req, token);
      return user.tenantId === tenantId && callbackRolesOk(user.roles);
    } catch {
      return false;
    }
  }
  return secretOk();
}
