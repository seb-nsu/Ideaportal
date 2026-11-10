import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { detachedCtx } from '../ai/pipeline.js';
import { markRoles, requireUser, tenantHandler } from '../http.js';
import { forbidden } from '../lib/errors.js';
import type { Ctx, Role } from '../lib/context.js';
import {
  RADAR_MANAGE,
  RADAR_VIEW,
  adoptCandidate,
  adoptInput,
  clusterChallengeInput,
  clusterProblemInput,
  clusterToChallenge,
  clusterToProblem,
  createProblemSource,
  createTrend,
  csvInput,
  decideSuggestion,
  deleteProblemSource,
  deleteTrend,
  dismissCluster,
  linkIdea,
  listDigests,
  listSponsors,
  problemRadarView,
  problemSourceInput,
  radarView,
  runConnectorSource,
  runCsv,
  runTrendAssignments,
  runTrendDigests,
  setRadarSettings,
  setSponsors,
  sponsorsInput,
  trendInput,
  trendUpdate,
  trendsOfIdea,
  unlinkIdea,
  updateTrend,
  whiteSpots,
} from '../services/radar.js';

// AP-27 "Erkennen": trend radar (R4-11), trend hints (R4-02), white spots (R4-03) and the
// problem radar from tickets and feedback (R4-01).

/** Handler for AI calls: no transaction is held open while a model answers. */
function aiHandler<T>(fn: (ctx: Ctx, req: FastifyRequest, reply: FastifyReply) => Promise<T>, roles: Role[]) {
  return markRoles(async (req: FastifyRequest, reply: FastifyReply): Promise<T> => {
    const user = await requireUser(req);
    if (!roles.some((r) => user.roles.includes(r))) throw forbidden();
    return fn(await detachedCtx(user.tenantId, user), req, reply);
  }, roles);
}

const id = (req: FastifyRequest, key = 'id') => z.object({ [key]: z.uuid() }).parse(req.params)[key] as string;
const view = { roles: RADAR_VIEW };
const manage = { roles: RADAR_MANAGE };
const ok = { ok: true };

export async function radarRoutes(app: FastifyInstance): Promise<void> {
  // --- radar (R4-11)
  app.get('/api/radar', tenantHandler(async (ctx) => radarView(ctx), view));
  app.post(
    '/api/radar/items',
    tenantHandler(async (ctx, req, reply) => {
      const created = await createTrend(ctx, trendInput.parse(req.body));
      reply.code(201);
      return created;
    }, manage),
  );
  app.patch('/api/radar/items/:id', tenantHandler(async (ctx, req) => (await updateTrend(ctx, id(req), trendUpdate.parse(req.body)), ok), manage));
  app.delete('/api/radar/items/:id', tenantHandler(async (ctx, req) => (await deleteTrend(ctx, id(req)), ok), manage));
  app.post(
    '/api/radar/items/:id/ideas',
    tenantHandler(async (ctx, req) => (await linkIdea(ctx, id(req), z.object({ ideaId: z.uuid() }).parse(req.body).ideaId), ok), manage),
  );
  app.delete('/api/radar/items/:id/ideas/:ideaId', tenantHandler(async (ctx, req) => (await unlinkIdea(ctx, id(req), id(req, 'ideaId')), ok), manage));
  app.post('/api/radar/suggestions/:id/accept', tenantHandler(async (ctx, req) => (await decideSuggestion(ctx, id(req), true), ok), manage));
  app.post('/api/radar/suggestions/:id/dismiss', tenantHandler(async (ctx, req) => (await decideSuggestion(ctx, id(req), false), ok), manage));
  // AI: assign signals from the digests and own ideas to the trends (suggestions only).
  app.post('/api/radar/assign', aiHandler(async (ctx) => ({ suggestions: await runTrendAssignments(ctx) }), RADAR_MANAGE));
  // Trends of one idea, for everyone who sees the idea.
  app.get('/api/ideas/:id/trends', tenantHandler(async (ctx, req) => trendsOfIdea(ctx, id(req))));

  // --- trend hints (R4-02)
  app.get('/api/radar/digests', tenantHandler(async (ctx) => listDigests(ctx)));
  app.post(
    '/api/radar/digests/run',
    aiHandler(async (ctx, req) => {
      const body = z.object({ topics: z.array(z.string().max(80)).max(50).optional() }).parse(req.body ?? {});
      // Manual run: digests and suggestions, no mail (the weekly job sends the mails).
      return runTrendDigests(ctx, { notify: false, topics: body.topics ?? ctx.settings.topics });
    }, RADAR_MANAGE),
  );
  app.post(
    '/api/radar/digests/:id/adopt',
    tenantHandler(async (ctx, req, reply) => {
      const created = await adoptCandidate(ctx, id(req), adoptInput.parse(req.body));
      reply.code(201);
      return created;
    }, manage),
  );
  app.get('/api/radar/sponsors', tenantHandler(async (ctx) => listSponsors(ctx), view));
  app.put('/api/radar/sponsors', tenantHandler(async (ctx, req) => setSponsors(ctx, sponsorsInput.parse(req.body)), manage));
  app.get('/api/radar/settings', tenantHandler(async (ctx) => ctx.settings.radar, view));
  app.put('/api/radar/settings', tenantHandler(async (ctx, req) => setRadarSettings(ctx, req.body), { roles: ['admin'] }));

  // --- white spots (R4-03)
  app.get('/api/radar/white-spots', tenantHandler(async (ctx) => whiteSpots(ctx), view));

  // --- problem radar (R4-01)
  app.get('/api/radar/problems', tenantHandler(async (ctx) => problemRadarView(ctx), manage));
  app.post(
    '/api/radar/problems/sources',
    tenantHandler(async (ctx, req, reply) => {
      const created = await createProblemSource(ctx, problemSourceInput.parse(req.body));
      reply.code(201);
      return created;
    }, { roles: ['lead', 'admin'] }),
  );
  app.delete('/api/radar/problems/sources/:id', tenantHandler(async (ctx, req) => (await deleteProblemSource(ctx, id(req)), ok), { roles: ['lead', 'admin'] }));
  app.post('/api/radar/problems/sources/:id/run', aiHandler(async (ctx, req) => runConnectorSource(ctx, id(req)), RADAR_MANAGE));
  app.post('/api/radar/problems/csv', aiHandler(async (ctx, req) => runCsv(ctx, csvInput.parse(req.body)), RADAR_MANAGE));
  app.post(
    '/api/radar/problems/clusters/:id/problem',
    tenantHandler(async (ctx, req, reply) => {
      const r = await clusterToProblem(ctx, id(req), clusterProblemInput.parse(req.body ?? {}));
      reply.code(201);
      return r;
    }, manage),
  );
  app.post(
    '/api/radar/problems/clusters/:id/challenge',
    tenantHandler(async (ctx, req, reply) => {
      const r = await clusterToChallenge(ctx, id(req), clusterChallengeInput.parse(req.body));
      reply.code(201);
      return r;
    }, manage),
  );
  app.post('/api/radar/problems/clusters/:id/dismiss', tenantHandler(async (ctx, req) => (await dismissCluster(ctx, id(req)), ok), manage));
}
