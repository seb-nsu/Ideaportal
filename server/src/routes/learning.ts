import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantHandler } from '../http.js';
import {
  createMetric,
  deleteMetric,
  impactReport,
  listMetrics,
  measureNow,
  metricInput,
  metricUpdate,
  recordValue,
  updateMetric,
  valueInput,
} from '../services/impactMetrics.js';
import { calibrationReport, effortEstimate } from '../services/learning.js';
import { loadIdea } from '../services/workflow.js';

// Wirkung und Lernen (AP-28): metrics before and after (R4-04), effort estimate from similar
// implemented ideas (R4-06) and calibration of forecasts (R4-07).

const ideaParam = z.object({ id: z.uuid() });
const metricParam = z.object({ id: z.uuid(), metricId: z.uuid() });

export async function learningRoutes(app: FastifyInstance): Promise<void> {
  // --- metrics of an idea (R4-04)
  app.get(
    '/api/ideas/:id/impact-metrics',
    tenantHandler(async (ctx, req) => listMetrics(ctx, await loadIdea(ctx, ideaParam.parse(req.params).id))),
  );
  app.post(
    '/api/ideas/:id/impact-metrics',
    tenantHandler(async (ctx, req, reply) => {
      const created = await createMetric(ctx, await loadIdea(ctx, ideaParam.parse(req.params).id, true), metricInput.parse(req.body));
      reply.code(201);
      return created;
    }),
  );
  app.patch(
    '/api/ideas/:id/impact-metrics/:metricId',
    tenantHandler(async (ctx, req) => {
      const p = metricParam.parse(req.params);
      await updateMetric(ctx, await loadIdea(ctx, p.id, true), p.metricId, metricUpdate.parse(req.body));
      return { ok: true };
    }),
  );
  app.delete(
    '/api/ideas/:id/impact-metrics/:metricId',
    tenantHandler(async (ctx, req) => {
      const p = metricParam.parse(req.params);
      await deleteMetric(ctx, await loadIdea(ctx, p.id, true), p.metricId);
      return { ok: true };
    }),
  );
  app.post(
    '/api/ideas/:id/impact-metrics/:metricId/measure',
    tenantHandler(async (ctx, req) => {
      const p = metricParam.parse(req.params);
      return measureNow(ctx, await loadIdea(ctx, p.id), p.metricId);
    }),
  );
  // Inbound value: manual entry and other systems with an API token (AP-12).
  app.post(
    '/api/impact-metrics/:metricId/values',
    tenantHandler(async (ctx, req, reply) => {
      const created = await recordValue(ctx, z.object({ metricId: z.uuid() }).parse(req.params).metricId, valueInput.parse(req.body));
      reply.code(201);
      return created;
    }),
  );
  // Report draft for Gate 3 (R4-04).
  app.get(
    '/api/ideas/:id/impact-report',
    tenantHandler(async (ctx, req) => impactReport(ctx, await loadIdea(ctx, ideaParam.parse(req.params).id))),
  );

  // --- effort estimate from similar implemented ideas (R4-06)
  app.get(
    '/api/ideas/:id/effort-estimate',
    tenantHandler(async (ctx, req) => effortEstimate(ctx, await loadIdea(ctx, ideaParam.parse(req.params).id))),
  );

  // --- calibration of forecasts (R4-07)
  app.get('/api/calibration', tenantHandler(async (ctx) => calibrationReport(ctx), { roles: ['triage', 'committee', 'lead', 'admin', 'controlling'] }));
}
