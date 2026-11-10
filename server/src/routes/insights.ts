import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { TRANSLATION_LANGUAGES } from '../ai/insights.js';
import { detachedCtx } from '../ai/pipeline.js';
import { markRoles, requireUser, tenantHandler } from '../http.js';
import { forbidden } from '../lib/errors.js';
import type { Ctx, Role } from '../lib/context.js';
import { publicBenchmark } from '../services/benchmark.js';
import { consentInput, gamificationView, setConsent, setSwitches, switchesInput } from '../services/gamification.js';
import { askInput, askPortfolio, translateContent, translateInput, translationAvailable } from '../services/insights.js';

// AP-24: questions to the portfolio (R3-23), translations (R3-30), gamification per challenge
// (R2-53) and the public benchmark (R3-40).

/** Handler for AI calls: no transaction is held open while a model answers. */
function aiHandler<T>(fn: (ctx: Ctx, req: FastifyRequest, reply: FastifyReply) => Promise<T>, opts: { roles?: Role[] } = {}) {
  return markRoles(async (req: FastifyRequest, reply: FastifyReply): Promise<T> => {
    const user = await requireUser(req);
    if (opts.roles && !opts.roles.some((r) => user.roles.includes(r))) throw forbidden();
    return fn(await detachedCtx(user.tenantId, user), req, reply);
  }, opts.roles);
}

const idParam = (req: FastifyRequest) => z.object({ id: z.uuid() }).parse(req.params).id;

export async function insightRoutes(app: FastifyInstance): Promise<void> {
  // Questions to the portfolio in everyday language (R3-23): the same roles as the portfolio.
  app.post(
    '/api/portfolio/ask',
    aiHandler(async (ctx, req) => askPortfolio(ctx, askInput.parse(req.body).question), { roles: ['triage', 'committee', 'lead', 'admin'] }),
  );

  // Translations (R3-30)
  app.get(
    '/api/translate/languages',
    tenantHandler(async (ctx) => ({
      languages: TRANSLATION_LANGUAGES,
      available: translationAvailable(ctx, false),
      availableConfidential: translationAvailable(ctx, true),
    })),
  );

  app.post(
    '/api/ideas/:id/translate',
    aiHandler(async (ctx, req) => {
      const body = translateInput.parse(req.body);
      return translateContent(ctx, idParam(req), body.target, body.commentId);
    }),
  );

  // Gamification per challenge (R2-53)
  app.get('/api/challenges/:id/gamification', tenantHandler(async (ctx, req) => gamificationView(ctx, idParam(req))));

  app.put(
    '/api/challenges/:id/gamification/consent',
    tenantHandler(async (ctx, req) => setConsent(ctx, idParam(req), consentInput.parse(req.body).consent)),
  );

  app.patch(
    '/api/challenges/:id/gamification',
    tenantHandler(async (ctx, req) => setSwitches(ctx, idParam(req), switchesInput.parse(req.body)), { roles: ['admin'] }),
  );

  // Public benchmark (R3-40): no session, platform data only.
  app.get('/api/benchmark', async () => publicBenchmark());
}
