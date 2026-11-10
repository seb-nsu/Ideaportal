import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hasRole } from '../lib/context.js';
import { forbidden } from '../lib/errors.js';
import { tenantHandler } from '../http.js';
import { canManageChallenge } from '../services/recognition.js';
import { loadIdea } from '../services/workflow.js';
import {
  canConfirm,
  confirmBenefit,
  confirmInput,
  confirmationList,
  esgRows,
  loadUseCase,
  problemToChallenge,
  teams,
  toChallengeInput,
  updateUseCases,
  useCaseInput,
  useCaseView,
  vote,
  withdrawVote,
} from '../services/usecases.js';
import { toCsv } from './misc.js';

// Use cases (AP-22): problem exchange (R3-31), sustainability and ESG export (R3-32),
// target value and controlling confirmation (R3-33), hackathon mode (R3-34).

const idParam = (req: { params: unknown }) => z.object({ id: z.uuid() }).parse(req.params).id;

export async function useCaseRoutes(app: FastifyInstance): Promise<void> {
  // R3-31: triage turns a problem into a challenge (Gate 1).
  app.post(
    '/api/ideas/:id/to-challenge',
    tenantHandler(async (ctx, req, reply) => {
      const input = toChallengeInput.parse(req.body);
      const result = await problemToChallenge(ctx, await loadIdea(ctx, idParam(req), true), input);
      reply.code(201);
      return result;
    }, { roles: ['admin', 'triage'] }),
  );

  // Target, impact per benefit kind, confirmations and hackathon of one challenge.
  app.get('/api/challenges/:id/use-cases', tenantHandler(async (ctx, req) => useCaseView(ctx, idParam(req))));

  app.patch(
    '/api/challenges/:id/use-cases',
    tenantHandler(async (ctx, req) => {
      await updateUseCases(ctx, idParam(req), useCaseInput.parse(req.body));
      return { ok: true };
    }),
  );

  // R3-32: ESG export per challenge by benefit kind (no persons).
  app.get(
    '/api/challenges/:id/esg.csv',
    tenantHandler(async (ctx, req, reply) => {
      const id = idParam(req);
      const c = await loadUseCase(ctx, id);
      if (!canManageChallenge(ctx, c) && !canConfirm(ctx, c) && !hasRole(ctx.user, 'admin', 'triage', 'committee', 'lead')) throw forbidden();
      const { rows } = await esgRows(ctx, id, ctx.locale);
      reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="esg-${id.slice(0, 8)}-${ctx.today}.csv"`);
      return '﻿' + toCsv(rows);
    }),
  );

  // R3-33: confirm or correct an actual benefit.
  app.post(
    '/api/ideas/:id/benefit-confirmation',
    tenantHandler(async (ctx, req) => confirmBenefit(ctx, await loadIdea(ctx, idParam(req), true), confirmInput.parse(req.body))),
  );

  app.get(
    '/api/benefit-confirmations',
    tenantHandler(async (ctx) => {
      const confirmer = await ctx.db.query('SELECT 1 FROM challenges WHERE confirmer_id = $1 LIMIT 1', [ctx.user!.id]);
      if (!canConfirm(ctx) && !confirmer.rowCount) throw forbidden();
      return { items: await confirmationList(ctx) };
    }),
  );

  // R3-34: audience voting (one vote per person and challenge) and team page.
  app.put(
    '/api/challenges/:id/vote',
    tenantHandler(async (ctx, req) => {
      const { ideaId } = z.object({ ideaId: z.uuid() }).parse(req.body);
      return vote(ctx, idParam(req), ideaId);
    }),
  );

  app.delete(
    '/api/challenges/:id/vote',
    tenantHandler(async (ctx, req) => {
      await withdrawVote(ctx, idParam(req));
      return { ok: true };
    }),
  );

  app.get('/api/challenges/:id/teams', tenantHandler(async (ctx, req) => teams(ctx, idParam(req))));
}
