import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool, withSystem } from '../db/pool.js';
import { m, tr } from '../i18n/index.js';
import { requestLocale, tenantHandler } from '../http.js';
import { hasMetricsToken, renderMetrics, setScrapeSource } from '../lib/prometheus.js';
import { audit } from '../services/audit.js';
import { auditFilterSchema, exportAudit, verifyAudit } from '../services/auditLog.js';
import { evaluate, healthMetrics } from '../services/ops.js';
import { deleteSiem, getSiem, rotateSiemSecret, saveSiem, siemInput, siemUpdate, updateSiem } from '../services/siem.js';

// Health checks, Prometheus metrics, audit verification and export, SIEM forwarding
// (docs/enterprise/sicherheit-und-beobachtbarkeit.md).

const admin = { roles: ['admin' as const] };

setScrapeSource(async () => {
  const h = await healthMetrics();
  const webhookPending = await withSystem(
    async (c) => (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE status = 'pending'`)).rows[0].n,
  );
  return {
    aiQueued: h.aiQueue.queued,
    aiRunning: h.aiQueue.running,
    outboxPending: h.outbox.pending,
    webhookPending,
    loopAge: { jobs: h.jobs.lastRunAgeSeconds, ai: h.aiWorker.lastRunAgeSeconds },
  };
});

async function databaseReachable(): Promise<boolean> {
  try {
    await getPool().query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function securityRoutes(app: FastifyInstance): Promise<void> {
  // Liveness: the process answers; no database (a database outage must not restart the app).
  app.get('/api/health/live', async () => ({ status: 'ok' }));

  // Readiness: the database is reachable. For load balancers and the container health check.
  app.get('/api/health/ready', async (_req, reply) => {
    if (!(await databaseReachable())) return reply.status(503).send({ status: 'unavailable' });
    return { status: 'ok' };
  });

  // Health check (R1-01, R1-05): 503 only without a database. Publicly only the status
  // (ok, degraded, unavailable); figures and alert keys only with the METRICS_TOKEN.
  app.get('/api/health', async (req, reply) => {
    if (!(await databaseReachable())) return reply.status(503).send({ status: 'unavailable' });
    const metrics = await healthMetrics();
    const alerts = evaluate(metrics);
    const status = alerts.length ? 'degraded' : 'ok';
    if (!hasMetricsToken(req.headers.authorization)) return { status };
    return { status, alerts: alerts.map((a) => a.key), ...metrics };
  });

  // Prometheus (text format). Without METRICS_TOKEN the endpoint does not exist.
  app.get('/api/metrics', async (req, reply) => {
    const notFound = () => reply.status(404).send({ error: tr(requestLocale(req), m('common.notFound')), code: 'NOT_FOUND' });
    if (!hasMetricsToken(req.headers.authorization)) return notFound();
    const { contentType, body } = await renderMetrics();
    return reply.header('content-type', contentType).send(body);
  });

  // ---------------------------------------------------------------- audit log

  app.get(
    '/api/admin/audit/verify',
    tenantHandler(async (ctx) => {
      const result = await verifyAudit(ctx);
      await audit(ctx, 'audit.verify', 'tenant', ctx.tenantId, null, { ok: result.ok, checked: result.checked, broken: result.broken });
      return result;
    }, admin),
  );

  // Streaming export of the whole filtered log, without a row limit.
  app.get(
    '/api/admin/audit/export',
    tenantHandler(async (ctx, req, reply) => {
      const q = auditFilterSchema.extend({ format: z.enum(['csv', 'jsonl']).default('csv') }).parse(req.query);
      const { format, ...filter } = q;
      await audit(ctx, 'audit.export', 'tenant', ctx.tenantId, null, { format, filter });
      const stamp = new Date().toISOString().slice(0, 10);
      reply
        .header('content-type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8')
        .header('content-disposition', `attachment; filename="audit-${stamp}.${format}"`);
      return exportAudit(ctx.tenantId, ctx.locale, ctx.settings.timezone, filter, format);
    }, admin),
  );

  // ---------------------------------------------------------------- SIEM forwarding

  app.get(
    '/api/admin/audit/siem',
    tenantHandler(async (ctx) => ({ siem: await getSiem(ctx) }), admin),
  );
  app.put(
    '/api/admin/audit/siem',
    tenantHandler(async (ctx, req) => saveSiem(ctx, siemInput.parse(req.body)), admin),
  );
  app.patch(
    '/api/admin/audit/siem',
    tenantHandler(async (ctx, req) => {
      await updateSiem(ctx, siemUpdate.parse(req.body));
      return { ok: true };
    }, admin),
  );
  app.post(
    '/api/admin/audit/siem/rotate',
    tenantHandler(async (ctx) => rotateSiemSecret(ctx), admin),
  );
  app.delete(
    '/api/admin/audit/siem',
    tenantHandler(async (ctx) => {
      await deleteSiem(ctx);
      return { ok: true };
    }, admin),
  );
}
