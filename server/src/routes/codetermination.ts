import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantHandler } from '../http.js';
import { m, tr } from '../i18n/index.js';
import { PERMISSIONS } from '../lib/context.js';
import { renderPdf } from '../lib/pdf.js';
import { markdownToBlocks, overview, renderAgreement, setAgreementSettings, setAiFunction, templateName } from '../services/codetermination.js';

// Co-determination (R3-12): read-only for the works council, AI switches and agreement details
// for admins. The UI and connectors use the same endpoints.

const readers = { roles: PERMISSIONS.codetermination };
const admins = { roles: PERMISSIONS.configure };

export async function codeterminationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/codetermination', tenantHandler(async (ctx) => overview(ctx), readers));

  app.put(
    '/api/codetermination/ai-functions/:agent',
    tenantHandler(async (ctx, req) => {
      const { agent } = z.object({ agent: z.string().max(40) }).parse(req.params);
      const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
      return setAiFunction(ctx, agent, enabled);
    }, admins),
  );

  app.put('/api/codetermination/agreement-settings', tenantHandler(async (ctx, req) => setAgreementSettings(ctx, req.body), admins));

  // Generated agreements as Markdown or PDF, versioned by template version and date.
  app.get(
    '/api/codetermination/agreements/:name',
    tenantHandler(async (ctx, req, reply) => {
      const { name } = z.object({ name: templateName }).parse(req.params);
      const { format } = z.object({ format: z.enum(['md', 'pdf']).default('md') }).parse(req.query);
      const doc = await renderAgreement(ctx, name);
      const file = `${name}-${ctx.today}`;
      if (format === 'md') {
        reply.header('content-type', 'text/markdown; charset=utf-8').header('content-disposition', `attachment; filename="${file}.md"`);
        return doc.markdown;
      }
      const workspace = (await ctx.db.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [ctx.tenantId])).rows[0]?.name ?? '';
      reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${file}.pdf"`);
      return renderPdf(markdownToBlocks(doc.markdown), {
        title: doc.title,
        footer: tr('de', m('codet.pdfFooter', { workspace, title: doc.title, version: doc.version, date: doc.generatedOn })),
      });
    }, readers),
  );
}
