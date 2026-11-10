import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { existsSync } from 'node:fs';
import { ZodError } from 'zod';
import { HttpError, localizeIssues } from './lib/errors.js';
import { RateLimitError } from './lib/ratelimit.js';
import { SESSION_COOKIE, registerRoute, requestLocale } from './http.js';
import { guardBearer } from './services/apitokens.js';
import { m, tr } from './i18n/index.js';
import { config } from './config.js';
import { hashIp, requestIdFrom, runWithContext, shortUserAgent, type RequestContext } from './lib/requestContext.js';
import { httpDuration } from './lib/prometheus.js';
import { securityRoutes } from './routes/security.js';
import { adminRoutes } from './routes/admin.js';
import { aiRoutes, proofRoutes } from './routes/ai.js';
import { aiQualityRoutes } from './routes/aiquality.js';
import { aiEvalRoutes } from './routes/aiEvals.js';
import { importAssistRoutes } from './routes/importAssist.js';
import { authRoutes } from './routes/auth.js';
import { codeterminationRoutes } from './routes/codetermination.js';
import { elaborationRoutes } from './routes/elaboration.js';
import { ideaRoutes } from './routes/ideas.js';
import { miscRoutes } from './routes/misc.js';
import { pilotRoutes } from './routes/pilot.js';
import { selfServiceRoutes } from './routes/selfservice.js';
import { usabilityRoutes } from './routes/usability.js';
import { identityRoutes } from './routes/identity.js';
import { samlRoutes } from './routes/saml.js';
import { scimRoutes } from './routes/scim.js';
import { chatRoutes } from './routes/chat.js';
import { integrationRoutes } from './routes/integrations.js';
import { externalRoutes } from './routes/external.js';
import { moderationRoutes } from './routes/moderation.js';
import { featureRequestRoutes } from './routes/featureRequests.js';
import { saasRoutes } from './routes/saas.js';
import { useCaseRoutes } from './routes/usecases.js';
import { connectorRoutes } from './routes/connectors.js';
import { complianceRoutes } from './routes/compliance.js';
import { insightRoutes } from './routes/insights.js';
import { billingRoutes } from './routes/billing.js';
import { radarRoutes } from './routes/radar.js';
import { learningRoutes } from './routes/learning.js';
import { tenantAdminRoutes } from './routes/tenantAdmin.js';
import { lifecycleDbError } from './services/tenantLifecycle.js';

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Log settings (R1-05): no idea content in logs. Request lines carry the path without the
 * query string (search terms), errors only type, code and a message without quoted values.
 */
export const LOG_SERIALIZERS = {
  req: (req: { method: string; url: string; ip?: string }) => ({ method: req.method, url: req.url.split('?')[0] }),
  err: (err: Error & { code?: string; statusCode?: number }) => ({
    type: err.name,
    code: err.code,
    statusCode: err.statusCode,
    message: String(err.message ?? '').replace(/"[^"]*"/g, '"…"').replace(/\(.*?\)=\(.*?\)/g, '(…)=(…)').slice(0, 300),
    stack: (err.stack ?? '').split('\n').slice(1, 8).join('\n'),
  }),
};

export async function buildApp(opts: { logger?: boolean; logStream?: NodeJS.WritableStream; webDist?: string } = {}): Promise<FastifyInstance> {
  const level = config.logLevel;
  const logger = opts.logStream ? { level, serializers: LOG_SERIALIZERS, stream: opts.logStream } : opts.logger ? { level, serializers: LOG_SERIALIZERS } : false;
  const app = Fastify({
    logger,
    trustProxy: (_addr: string, hop: number) => hop < config.trustProxyHops,
    bodyLimit: 1_000_000,
    // Request ids: a sane incoming X-Request-Id is kept (correlation across proxies), else a UUID.
    // It is part of every log line (reqId), returned as X-Request-Id and stored in audit rows.
    requestIdHeader: false,
    genReqId: (req) => requestIdFrom(req.headers['x-request-id']),
  });
  await app.register(cookie);

  // Request context for the database layer (request id, hashed address, user agent; migration 031).
  // Entered again before the handler: the body is read in socket callbacks, which do not keep
  // the async context of onRequest.
  const contexts = new WeakMap<object, RequestContext>();
  const enter = (req: FastifyRequest, _reply: unknown, done: () => void) => {
    let ctx = contexts.get(req);
    if (!ctx) {
      ctx = { requestId: req.id, ipHash: hashIp(req.ip), userAgent: shortUserAgent(req.headers['user-agent']) };
      contexts.set(req, ctx);
    }
    runWithContext(ctx, done);
  };
  app.addHook('onRequest', enter);
  app.addHook('preHandler', enter);

  // Request duration by route pattern (never the concrete path with ids) for /api/metrics.
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? (reply.statusCode === 404 ? 'not_found' : 'unknown');
    httpDuration.observe({ method: req.method, route, status: String(reply.statusCode) }, reply.elapsedTime / 1000);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof RateLimitError) reply.header('retry-after', String(err.retryAfter));
    const locale = requestLocale(req);
    // Sign-in into a suspended tenant or a tenant being deleted (trigger on sessions, enterprise).
    const lifecycle = lifecycleDbError(err);
    if (lifecycle) return reply.status(lifecycle.status).send({ error: tr(locale, lifecycle.text), code: lifecycle.code });
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: tr(locale, err.text), code: err.code, details: err.details });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: tr(locale, m('common.validation')), code: 'VALIDATION', details: localizeIssues(locale, err.issues) });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).message, code: 'BAD_REQUEST' });
    // Unexpected errors: error level with the stack (serializer) and the request id, which the
    // answer carries as well, so a support case can be matched with the log line.
    req.log.error({ err, requestId: req.id }, 'request failed');
    return reply.status(500).send({ error: tr(locale, m('common.internal')), code: 'INTERNAL', requestId: req.id });
  });

  // Simple CSRF protection: state-changing API calls must carry a JSON content type or the
  // X-Requested-With header (a cross-site HTML form can set neither), on top of SameSite cookies.
  // API tokens (R3-17): a bearer request carries no ambient cookie (mixing is refused), so the
  // CSRF rule does not apply to it.
  app.addHook('onRequest', async (req) => {
    if (guardBearer(req, SESSION_COOKIE)) return;
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !req.url.startsWith('/api/')) return;
    // Slack and Teams post forms without cookies; their requests are signed (R3-16).
    if (req.url.startsWith('/api/integrations/')) return;
    // SAML assertion consumer service (R3-26): the identity provider posts a form; the signed
    // assertion, InResponseTo and the browser binding protect it.
    if (/^\/api\/auth\/saml\/[^/]+\/acs(?:\?|$)/.test(req.url)) return;
    const ct = req.headers['content-type'] ?? '';
    if (!ct.startsWith('application/json') && req.headers['x-requested-with'] !== 'fetch') {
      throw new HttpError(415, m('common.sendJson'), 'UNSUPPORTED_MEDIA_TYPE');
    }
  });

  // Security headers (R1-45). The web app is a built bundle without inline scripts or style
  // blocks, so the content security policy needs no 'unsafe-inline'.
  const https = config.cookieSecure || config.publicUrl.startsWith('https://');
  app.addHook('onSend', async (req, reply, payload) => {
    // API answers carry personal data: no caching in browsers or proxies (ASVS V8.2.1, R3-09),
    // unless a route sets its own rule (e.g. the public status page).
    if ((req.url.startsWith('/api/') || req.url.startsWith('/scim/')) && !reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    reply.header('x-request-id', req.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', CSP);
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    if (https) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    return payload;
  });

  // Route registry for the co-determination overview (R3-12).
  app.addHook('onRoute', (route) => registerRoute(route.method, route.url, route.handler));

  // Health checks, metrics, audit verification and export, SIEM (enterprise security).
  await app.register(securityRoutes);
  await app.register(authRoutes);
  await app.register(ideaRoutes);
  await app.register(miscRoutes);
  await app.register(adminRoutes);
  await app.register(selfServiceRoutes);
  await app.register(pilotRoutes);
  await app.register(aiRoutes);
  await app.register(proofRoutes);
  await app.register(aiQualityRoutes);
  await app.register(aiEvalRoutes);
  await app.register(importAssistRoutes);
  await app.register(elaborationRoutes);
  await app.register(usabilityRoutes);
  // Company login (R3-26) and SCIM provisioning (R3-27).
  await app.register(identityRoutes);
  await app.register(samlRoutes);
  await app.register(scimRoutes, { prefix: '/scim/v2' });
  await app.register(chatRoutes);
  await app.register(codeterminationRoutes);
  await app.register(integrationRoutes);
  // External participation, moderation and feature requests (R3-19, R3-21, R3-20).
  await app.register(externalRoutes);
  await app.register(moderationRoutes);
  await app.register(featureRequestRoutes);
  // Operator console, support access and status page (AP-17: R3-01, R3-07, R3-10).
  await app.register(saasRoutes);
  await app.register(useCaseRoutes);
  // Connectors to Jira, ServiceNow, Azure DevOps and the implementation package (R3-13 to R3-18).
  await app.register(connectorRoutes);
  // Legal texts, sub-processors and the invention check (R3-08, R3-11, R3-25).
  await app.register(complianceRoutes);
  // Portfolio questions, translations, gamification and the public benchmark (AP-24).
  await app.register(insightRoutes);
  // Packages, AI quota, trial, invoice drafts, challenge package and process proposal (AP-18).
  await app.register(billingRoutes);
  // Trend radar, trend hints, white spots and problem radar (AP-27: R4-11, R4-02, R4-03, R4-01).
  await app.register(radarRoutes);
  // Metrics before and after, effort estimate and calibration (AP-28: R4-04, R4-06, R4-07).
  await app.register(learningRoutes);
  // Tenant lifecycle, export as ZIP, people administration, operator accounts (enterprise).
  await app.register(tenantAdminRoutes);

  const webDist = opts.webDist;
  if (webDist && existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    // Single-page app: every non-API path serves index.html.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: tr(requestLocale(req), m('common.notFound')), code: 'NOT_FOUND' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
