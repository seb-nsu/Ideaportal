import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requestLocale, tenantHandler } from '../http.js';
import { m, tr } from '../i18n/index.js';
import { PERMISSIONS } from '../lib/context.js';
import { renderPdf } from '../lib/pdf.js';
import {
  PUBLIC_DOCS,
  accept,
  complianceOverview,
  documentList,
  legalDoc,
  renderForTenant,
  renderPublic,
  subprocessorsCsv,
  tenantSubprocessors,
} from '../services/compliance.js';
import { markdownToBlocks } from '../services/codetermination.js';
import { inventionView, setInventionCheck } from '../services/invention.js';

// Legal texts and compliance documents (R3-08, R3-11) and the invention disclosure check (R3-25).
// Terms and privacy policy are public (/rechtliches); TOM, DSFA template, AVV and the list of
// sub-processors are for admins of a workspace, filled with its settings.

const admins = { roles: PERMISSIONS.configure };
const triage = { roles: PERMISSIONS.triage };

const formatQuery = z.object({ format: z.enum(['json', 'md', 'pdf']).default('json') });

type Rendered = { name: string; title: string; version: string; generatedOn: string; markdown: string; workspace?: string };

function send(reply: FastifyReply, doc: Rendered & { blocks: unknown }, format: 'json' | 'md' | 'pdf') {
  const file = `${doc.name}-${doc.version}`;
  if (format === 'md') {
    reply.header('content-type', 'text/markdown; charset=utf-8').header('content-disposition', `attachment; filename="${file}.md"`);
    return doc.markdown;
  }
  if (format === 'pdf') {
    reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${file}.pdf"`);
    return renderPdf(markdownToBlocks(doc.markdown), {
      title: doc.title,
      footer: tr('de', m('compliance.pdfFooter', { title: doc.title, version: doc.version, date: doc.generatedOn })),
    });
  }
  return doc;
}

export async function complianceRoutes(app: FastifyInstance): Promise<void> {
  // Public: list and text of the terms and the privacy policy, no session needed.
  app.get('/api/legal', async (req) => ({ documents: documentList(requestLocale(req), PUBLIC_DOCS) }));
  app.get('/api/legal/:name', async (req, reply) => {
    const { name } = z.object({ name: z.string().max(40) }).parse(req.params);
    const { format } = formatQuery.parse(req.query);
    return send(reply, renderPublic(name, requestLocale(req)), format);
  });

  // Admins: all documents filled with the workspace, acceptance, sub-processors, encryption state.
  app.get('/api/admin/compliance', tenantHandler(async (ctx) => complianceOverview(ctx), admins));
  app.get(
    '/api/admin/compliance/documents/:name',
    tenantHandler(async (ctx, req, reply) => {
      const { name } = z.object({ name: legalDoc }).parse(req.params);
      const { format } = formatQuery.parse(req.query);
      return send(reply, await renderForTenant(ctx, name), format);
    }, admins),
  );
  app.post('/api/admin/compliance/accept', tenantHandler(async (ctx, req) => accept(ctx, req.body), admins));
  app.get(
    '/api/admin/compliance/subprocessors',
    tenantHandler(async (ctx, req, reply) => {
      const { format } = z.object({ format: z.enum(['json', 'csv']).default('json') }).parse(req.query);
      const list = await tenantSubprocessors(ctx);
      if (format === 'json') return { subprocessors: list };
      reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="unterauftragnehmer-${ctx.today}.csv"`);
      return subprocessorsCsv(ctx.locale, list);
    }, admins),
  );

  // Invention disclosure check at triage (R3-25).
  app.get('/api/ideas/:id/invention', tenantHandler(async (ctx, req) => inventionView(ctx, z.object({ id: z.uuid() }).parse(req.params).id), triage));
  app.put('/api/ideas/:id/invention', tenantHandler(async (ctx, req) => setInventionCheck(ctx, z.object({ id: z.uuid() }).parse(req.params).id, req.body), triage));
}
