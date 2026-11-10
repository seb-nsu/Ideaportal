import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listSamples, qualityReport, rate, rateSample, recordUsage, REVIEW_KINDS, setReview } from '../ai/quality.js';
import { qualityDashboard } from '../ai/qualityDashboard.js';
import { AGENTS, aiSettingsSchema } from '../ai/settings.js';
import { tenantHandler } from '../http.js';
import { hasRole, isTriage } from '../lib/context.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { m } from '../i18n/index.js';
import { audit } from '../services/audit.js';
import { canSeeRecommendations, canWorkAi, loadResult, RESTRICTED_KINDS, visibleIdea } from './ai.js';

// AI quality in use (R2-44, R2-46): review status, rating "hilfreich?", expand rate and the
// monthly sample. Reports are aggregated; no endpoint returns ratings per person.

const idParam = (params: unknown) => z.object({ id: z.uuid() }).parse(params).id;

export async function aiQualityRoutes(app: FastifyInstance): Promise<void> {
  // Review status of one building block: ungeprüft, geprüft or korrigiert, with person and date.
  app.put(
    '/api/ai/results/:id/review',
    tenantHandler(async (ctx, req) => {
      const { status } = z.object({ status: z.enum(['unchecked', 'checked', 'corrected']) }).parse(req.body);
      const r = await loadResult(ctx, idParam(req.params));
      if (!r.idea_id || !(REVIEW_KINDS as readonly string[]).includes(r.kind)) throw badRequest(m('aiq.review.notReviewable'));
      const idea = await visibleIdea(ctx, r.idea_id);
      if (!canWorkAi(ctx, idea)) throw forbidden(m('ai.workRights'));
      await setReview(ctx, r.id, status);
      await audit(ctx, 'ai.review', 'ai_result', r.id, null, { kind: r.kind, status });
      return { ok: true };
    }),
  );

  // One-click rating "hilfreich?" by everyone who sees the result.
  app.post(
    '/api/ai/results/:id/rating',
    tenantHandler(async (ctx, req) => {
      const { helpful } = z.object({ helpful: z.boolean() }).parse(req.body);
      const r = await loadResult(ctx, idParam(req.params));
      if (!r.idea_id) throw badRequest(m('aiq.review.notReviewable'));
      const idea = await visibleIdea(ctx, r.idea_id);
      if (RESTRICTED_KINDS.includes(r.kind) && !canSeeRecommendations(ctx, idea)) throw forbidden(m('ai.recommendationRights'));
      await rate(ctx, r.id, r.kind, helpful);
      return { ok: true };
    }),
  );

  // Shown and opened blocks for the expand rate; stored without person and idea.
  app.post(
    '/api/ai/usage',
    tenantHandler(async (ctx, req) => {
      const { events } = z.object({ events: z.array(z.object({ kind: z.enum(AGENTS), event: z.enum(['view', 'open']) })).min(1).max(30) }).parse(req.body);
      await recordUsage(ctx, events);
      return { ok: true };
    }),
  );

  // Quality view (Einstellungen › KI › Qualität).
  app.get(
    '/api/admin/ai/quality',
    tenantHandler(async (ctx) => qualityReport(ctx), { roles: ['admin'] }),
  );

  // Quality dashboard (R4-08): metrics per agent and week or month, history and alarms.
  app.get(
    '/api/admin/ai/quality/dashboard',
    tenantHandler(async (ctx, req) => {
      const { granularity } = z.object({ granularity: z.enum(['week', 'month']).optional() }).parse(req.query);
      return qualityDashboard(ctx, granularity ?? ctx.settings.ai.qualityAlarm.period);
    }, { roles: ['admin'] }),
  );

  // Alarm settings of the dashboard (R4-08); part of the AI settings, so versioned and audited like them.
  app.put(
    '/api/admin/ai/quality/alarm',
    tenantHandler(async (ctx, req) => {
      const alarm = aiSettingsSchema.shape.qualityAlarm.unwrap().parse(req.body);
      const ai = { ...ctx.settings.ai, qualityAlarm: alarm };
      await ctx.db.query('UPDATE tenants SET settings = $1 WHERE id = $2', [JSON.stringify({ ...ctx.settings, ai }), ctx.tenantId]);
      await audit(ctx, 'settings.ai.qualityAlarm', 'tenant', ctx.tenantId, ctx.settings.ai.qualityAlarm, alarm);
      return { ok: true, alarm };
    }, { roles: ['admin'] }),
  );

  // Samples to rate: own ones for mentors, all for triage and admins.
  app.get(
    '/api/ai/samples',
    tenantHandler(async (ctx) => listSamples(ctx, { mine: !isTriage(ctx.user) })),
  );

  app.put(
    '/api/ai/samples/:id',
    tenantHandler(async (ctx, req) => {
      const body = z.object({ verdict: z.enum(['correct', 'minor', 'wrong']), note: z.string().trim().max(1000).nullable().default(null) }).parse(req.body);
      const id = idParam(req.params);
      const row = (await ctx.db.query<{ assignee_id: string | null }>('SELECT assignee_id FROM ai_samples WHERE id = $1', [id])).rows[0];
      if (!row) throw notFound();
      if (row.assignee_id !== ctx.user!.id && !isTriage(ctx.user) && !hasRole(ctx.user, 'admin')) throw forbidden();
      await rateSample(ctx, id, body.verdict, body.note || null);
      return { ok: true };
    }),
  );
}
