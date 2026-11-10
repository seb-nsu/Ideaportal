import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantHandler } from '../http.js';
import { isTriage } from '../lib/context.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { m } from '../i18n/index.js';
import {
  addMeetingItem,
  confirmImpactReview,
  createExperiment,
  createMeeting,
  decideInMeeting,
  deleteMeeting,
  dossierHistory,
  elaborationOverview,
  estimatesInput,
  experimentInput,
  experimentResultInput,
  impactInput,
  impactReviewView,
  isDossierSection,
  listExperiments,
  listMeetings,
  lockSection,
  markMeetingHeld,
  meetingDetail,
  meetingInput,
  mentorLoadInfo,
  portfolio,
  portfolioQuery,
  rateGate2,
  reassignMentor,
  recordExperimentResult,
  recordImpactReview,
  releaseSection,
  removeMeetingItem,
  saveDossierSection,
  scorecardView,
  scoresInput,
  sendMeetingPack,
  updateEstimates,
  type DossierSection,
} from '../services/elaboration.js';
import {
  approveStory,
  declineStory,
  publishedStories,
  recognition,
  sendStoryToAuthor,
  setShowOnSuccessPage,
  storyInput,
  successStoryView,
  upsertSuccessStoryDraft,
} from '../services/recognition.js';
import { decisionInput, loadIdea } from '../services/workflow.js';
import { withCalibrationBand } from '../services/learning.js';

// API for Release 2 elaboration, decision, impact and recognition (epic J and O).

const ideaParam = z.object({ id: z.uuid() });
const sectionParam = z.object({ id: z.uuid(), section: z.string() });

function section(req: { params: unknown }): { id: string; section: DossierSection } {
  const p = sectionParam.parse(req.params);
  if (!isDossierSection(p.section)) throw badRequest(m('elaboration.unknownSection'));
  return { id: p.id, section: p.section };
}

export async function elaborationRoutes(app: FastifyInstance): Promise<void> {
  // ---- mentor and timebox (R2-01)
  app.get(
    '/api/mentors/:userId/load',
    tenantHandler(async (ctx, req) => mentorLoadInfo(ctx, z.object({ userId: z.uuid() }).parse(req.params).userId), { roles: ['triage', 'admin'] }),
  );

  app.post(
    '/api/ideas/:id/mentor',
    tenantHandler(async (ctx, req) => {
      const { id } = ideaParam.parse(req.params);
      const body = z.object({ mentorId: z.uuid().nullable(), timeboxUntil: z.iso.date().optional() }).parse(req.body);
      const r = await reassignMentor(ctx, await loadIdea(ctx, id, true), body.mentorId, body.timeboxUntil);
      return { ok: true, warning: r.warning ?? null };
    }),
  );

  // ---- overview and dossier (R2-02)
  app.get(
    '/api/ideas/:id/elaboration',
    tenantHandler(async (ctx, req) => elaborationOverview(ctx, await loadIdea(ctx, ideaParam.parse(req.params).id))),
  );

  app.post(
    '/api/ideas/:id/dossier/:section/lock',
    tenantHandler(async (ctx, req) => {
      const p = section(req);
      return lockSection(ctx, await loadIdea(ctx, p.id), p.section);
    }),
  );

  app.delete(
    '/api/ideas/:id/dossier/:section/lock',
    tenantHandler(async (ctx, req) => {
      const p = section(req);
      await releaseSection(ctx, await loadIdea(ctx, p.id), p.section);
      return { ok: true };
    }),
  );

  app.put(
    '/api/ideas/:id/dossier/:section',
    tenantHandler(async (ctx, req) => {
      const p = section(req);
      const body = z
        .object({
          content: z.string().max(20_000),
          expectedVersion: z.number().int().min(0),
          openPoints: z.array(z.string().trim().max(300)).max(50).optional(),
        })
        .parse(req.body);
      return saveDossierSection(ctx, await loadIdea(ctx, p.id, true), p.section, body.content, {
        source: 'human', expectedVersion: body.expectedVersion, openPoints: body.openPoints,
      });
    }),
  );

  app.get(
    '/api/ideas/:id/dossier/:section/history',
    tenantHandler(async (ctx, req) => {
      const p = section(req);
      return dossierHistory(ctx, await loadIdea(ctx, p.id), p.section);
    }),
  );

  app.patch(
    '/api/ideas/:id/estimates',
    tenantHandler(async (ctx, req) => {
      await updateEstimates(ctx, await loadIdea(ctx, ideaParam.parse(req.params).id, true), estimatesInput.parse(req.body));
      return { ok: true };
    }),
  );

  // ---- scorecard (R2-03)
  app.get(
    '/api/ideas/:id/scorecard',
    tenantHandler(async (ctx, req) => scorecardView(ctx, await loadIdea(ctx, ideaParam.parse(req.params).id))),
  );

  app.put(
    '/api/ideas/:id/scorecard',
    tenantHandler(async (ctx, req) => rateGate2(ctx, await loadIdea(ctx, ideaParam.parse(req.params).id), scoresInput.parse(req.body))),
  );

  // ---- committee meetings (R2-04)
  app.get('/api/meetings', tenantHandler(async (ctx) => listMeetings(ctx)));

  app.post(
    '/api/meetings',
    tenantHandler(async (ctx, req, reply) => {
      const r = await createMeeting(ctx, meetingInput.parse(req.body));
      reply.code(201);
      return r;
    }),
  );

  // Committee pack with the hit band of earlier forecasts per idea type (R4-07).
  app.get('/api/meetings/:id', tenantHandler(async (ctx, req) => withCalibrationBand(ctx, await meetingDetail(ctx, ideaParam.parse(req.params).id))));

  app.delete(
    '/api/meetings/:id',
    tenantHandler(async (ctx, req) => {
      await deleteMeeting(ctx, ideaParam.parse(req.params).id);
      return { ok: true };
    }),
  );

  app.post(
    '/api/meetings/:id/items',
    tenantHandler(async (ctx, req) => {
      const { ideaId } = z.object({ ideaId: z.uuid() }).parse(req.body);
      await addMeetingItem(ctx, ideaParam.parse(req.params).id, ideaId);
      return { ok: true };
    }),
  );

  app.delete(
    '/api/meetings/:id/items/:ideaId',
    tenantHandler(async (ctx, req) => {
      const p = z.object({ id: z.uuid(), ideaId: z.uuid() }).parse(req.params);
      await removeMeetingItem(ctx, p.id, p.ideaId);
      return { ok: true };
    }),
  );

  app.post(
    '/api/meetings/:id/send',
    tenantHandler(async (ctx, req) => {
      if (!isTriage(ctx.user)) throw forbidden();
      return { ok: true, ideas: await sendMeetingPack(ctx, ideaParam.parse(req.params).id) };
    }),
  );

  app.post(
    '/api/meetings/:id/held',
    tenantHandler(async (ctx, req) => {
      await markMeetingHeld(ctx, ideaParam.parse(req.params).id);
      return { ok: true };
    }),
  );

  app.post(
    '/api/meetings/:id/decisions/:ideaId',
    tenantHandler(async (ctx, req) => {
      const p = z.object({ id: z.uuid(), ideaId: z.uuid() }).parse(req.params);
      await decideInMeeting(ctx, p.id, p.ideaId, decisionInput.parse(req.body));
      return { ok: true };
    }),
  );

  // ---- experiments (R2-06)
  app.get(
    '/api/ideas/:id/experiments',
    tenantHandler(async (ctx, req) => listExperiments(ctx, await loadIdea(ctx, ideaParam.parse(req.params).id))),
  );

  app.post(
    '/api/ideas/:id/experiments',
    tenantHandler(async (ctx, req, reply) => {
      const r = await createExperiment(ctx, await loadIdea(ctx, ideaParam.parse(req.params).id, true), experimentInput.parse(req.body));
      reply.code(201);
      return r;
    }),
  );

  app.post(
    '/api/ideas/:id/experiments/:experimentId/result',
    tenantHandler(async (ctx, req) => {
      const p = z.object({ id: z.uuid(), experimentId: z.uuid() }).parse(req.params);
      await recordExperimentResult(ctx, await loadIdea(ctx, p.id, true), p.experimentId, experimentResultInput.parse(req.body));
      return { ok: true };
    }),
  );

  // ---- impact review (R2-07)
  app.get(
    '/api/ideas/:id/impact-review',
    tenantHandler(async (ctx, req) => ({ review: await impactReviewView(ctx, await loadIdea(ctx, ideaParam.parse(req.params).id)) })),
  );

  app.put(
    '/api/ideas/:id/impact-review',
    tenantHandler(async (ctx, req) => {
      await recordImpactReview(ctx, await loadIdea(ctx, ideaParam.parse(req.params).id, true), impactInput.parse(req.body));
      return { ok: true };
    }),
  );

  app.post(
    '/api/ideas/:id/impact-review/confirm',
    tenantHandler(async (ctx, req) => {
      await confirmImpactReview(ctx, await loadIdea(ctx, ideaParam.parse(req.params).id, true));
      return { ok: true };
    }),
  );

  // ---- portfolio (R2-08)
  app.get(
    '/api/portfolio',
    tenantHandler(async (ctx, req) => portfolio(ctx, portfolioQuery.parse(req.query)), { roles: ['triage', 'committee', 'lead', 'admin'] }),
  );

  // ---- success stories (R2-37) and success page (R2-38)
  app.get(
    '/api/ideas/:id/success-story',
    tenantHandler(async (ctx, req) => successStoryView(ctx, await loadIdea(ctx, ideaParam.parse(req.params).id))),
  );

  app.put(
    '/api/ideas/:id/success-story',
    tenantHandler(async (ctx, req) => {
      const body = storyInput.extend({ aiResultId: z.uuid().nullable().optional() }).parse(req.body);
      return upsertSuccessStoryDraft(ctx, ideaParam.parse(req.params).id, body.title, body.body, body.aiResultId ?? null);
    }),
  );

  app.post(
    '/api/ideas/:id/success-story/send',
    tenantHandler(async (ctx, req) => {
      await sendStoryToAuthor(ctx, await loadIdea(ctx, ideaParam.parse(req.params).id, true));
      return { ok: true };
    }),
  );

  app.post(
    '/api/ideas/:id/success-story/approve',
    tenantHandler(async (ctx, req) => {
      const { nameAuthors } = z.object({ nameAuthors: z.boolean() }).parse(req.body);
      await approveStory(ctx, await loadIdea(ctx, ideaParam.parse(req.params).id, true), nameAuthors);
      return { ok: true };
    }),
  );

  app.post(
    '/api/ideas/:id/success-story/decline',
    tenantHandler(async (ctx, req) => {
      await declineStory(ctx, await loadIdea(ctx, ideaParam.parse(req.params).id, true));
      return { ok: true };
    }),
  );

  app.get('/api/success-stories', tenantHandler(async (ctx) => publishedStories(ctx)));

  app.get(
    '/api/success-stories/:id',
    tenantHandler(async (ctx, req) => {
      const [story] = await publishedStories(ctx, ideaParam.parse(req.params).id);
      if (!story) throw notFound(m('elaboration.storyNotFound'));
      return story;
    }),
  );

  app.get('/api/me/recognition', tenantHandler(async (ctx) => recognition(ctx)));

  app.put(
    '/api/me/recognition',
    tenantHandler(async (ctx, req) => {
      const { showOnSuccessPage } = z.object({ showOnSuccessPage: z.boolean() }).parse(req.body);
      await setShowOnSuccessPage(ctx, showOnSuccessPage);
      return recognition(ctx);
    }),
  );
}
