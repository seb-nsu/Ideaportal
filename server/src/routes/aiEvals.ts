import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { loadRunData } from '../ai/eval.js';
import { reportJson, reportMarkdown } from '../ai/evalReport.js';
import { modelCard, transparency } from '../ai/transparency.js';
import { aiSettingsSchema, DEFAULT_EVALS, DEFAULT_FALLBACK } from '../ai/settings.js';
import { tenantHandler } from '../http.js';
import { badRequest, localizeIssues, notFound } from '../lib/errors.js';
import { m } from '../i18n/index.js';
import { audit } from '../services/audit.js';

// Eval reports, quality settings and the transparency page about the AI (R2-12, R3-22).

const admin = { roles: ['admin' as const] };

const runParam = (params: unknown) => z.object({ id: z.uuid() }).parse(params).id;

const qualitySettings = z.object({
  evals: aiSettingsSchema.shape.evals.unwrap(),
  fallback: aiSettingsSchema.shape.fallback.unwrap(),
});

export async function aiEvalRoutes(app: FastifyInstance): Promise<void> {
  // Report of one evaluation run as JSON (machines, audits) and Markdown (people).
  app.get(
    '/api/admin/ai/evals/:id/report.json',
    tenantHandler(async (ctx, req, reply) => {
      const id = runParam(req.params);
      const data = await loadRunData(ctx, id);
      if (!data) throw notFound(m('aieval.runNotFound'));
      reply.header('content-disposition', `attachment; filename="ki-qualitaet-${id.slice(0, 8)}.json"`);
      return reportJson(data.run, data.comparison);
    }, admin),
  );

  app.get(
    '/api/admin/ai/evals/:id/report.md',
    tenantHandler(async (ctx, req, reply) => {
      const id = runParam(req.params);
      const data = await loadRunData(ctx, id);
      if (!data) throw notFound(m('aieval.runNotFound'));
      reply.header('content-type', 'text/markdown; charset=utf-8').header('content-disposition', `attachment; filename="ki-qualitaet-${id.slice(0, 8)}.md"`);
      return reportMarkdown(data.run, data.comparison, ctx.locale);
    }, admin),
  );

  // Sample size, regression tolerance, judge model and server-side fallback (audited).
  app.get(
    '/api/admin/ai/quality-settings',
    tenantHandler(async (ctx) => ({ evals: ctx.settings.ai.evals ?? DEFAULT_EVALS, fallback: ctx.settings.ai.fallback ?? DEFAULT_FALLBACK }), admin),
  );

  app.put(
    '/api/admin/ai/quality-settings',
    tenantHandler(async (ctx, req) => {
      const parsed = qualitySettings.safeParse(req.body);
      if (!parsed.success) throw badRequest(m('aieval.settingsInvalid'), localizeIssues(ctx.locale, parsed.error.issues));
      const ai = { ...ctx.settings.ai, evals: parsed.data.evals, fallback: parsed.data.fallback };
      await ctx.db.query('UPDATE tenants SET settings = $1 WHERE id = $2', [JSON.stringify({ ...ctx.settings, ai }), ctx.tenantId]);
      await audit(ctx, 'settings.ai', 'tenant', ctx.tenantId, ctx.settings.ai, ai);
      return { ok: true, ...parsed.data };
    }, admin),
  );

  // "KI im Portal": every signed-in member of the workspace (not external guests).
  app.get(
    '/api/ai/transparency',
    tenantHandler(async (ctx) => transparency(ctx, ctx.locale)),
  );

  app.get(
    '/api/ai/transparency/model-card.md',
    tenantHandler(async (ctx, req, reply) => {
      const q = z.object({ provider: z.string().min(1).max(30), model: z.string().min(1).max(100) }).parse(req.query);
      const name = (await ctx.db.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [ctx.tenantId])).rows[0]?.name ?? '';
      const card = await modelCard(ctx, ctx.locale, q.provider, q.model, name);
      if (!card) throw notFound(m('aieval.cardNotFound'));
      const file = `${q.provider}-${q.model}`.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);
      reply.header('content-type', 'text/markdown; charset=utf-8').header('content-disposition', `attachment; filename="modellkarte-${file}.md"`);
      return card;
    }),
  );
}
