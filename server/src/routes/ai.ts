import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { boundaryCall, challengeSuggestionsCall, coachCall, gate2Call, imageCall, replyCall, successStoryCall, summaryCall, type AnalysisBundle, type CoachMessage, type DossierDraft, type ExperimentProposal } from '../ai/agents.js';
import { businessCaseComplete, businessCaseCsv, computeBusinessCase, computeLever, computeMarketSize, type Assumption, type MarketInputs } from '../ai/calc.js';
import { configHash, enqueueEval, latestRun, minScore, qualityInUse, releaseState } from '../ai/eval.js';
import { agentName } from '../ai/evalReport.js';
import { AiError, allProviders, logAction, redactedInput, resolveModel, runAgent, spent } from '../ai/gateway.js';
import { enqueueAiJob } from '../ai/hooks.js';
import type { Source } from '../ai/content.js';
import { detachedCtx, finalize, ideaFacts, latestContent, saveResult, tx, type StoredContent } from '../ai/pipeline.js';
import { createProvider, platformKey, ProviderError } from '../ai/providers.js';
import { getSecret, secretNames, setSecret } from '../ai/secrets.js';
import { proofBlocks, proofForIdea } from '../ai/proof.js';
import { REVIEW_KINDS, reviewStatus } from '../ai/quality.js';
import { renderPdf } from '../lib/pdf.js';
import { AGENT_DEFAULTS, AGENTS, agentLabel, aiSettingsSchema, providerName, providerTemplates, type AgentName } from '../ai/settings.js';
import { markRoles, requireUser, tenantHandler } from '../http.js';
import { checkBoundary } from '../lib/boundary.js';
import { can, hasRole, isDecider, isTriage, type Ctx, type Role } from '../lib/context.js';
import { badRequest, errorText, forbidden, localizeIssues, notFound } from '../lib/errors.js';
import { m, relocalize, relocalizeAll, relocalizeLines, tr, type Locale, type MessageKey } from '../i18n/index.js';
import { audit } from '../services/audit.js';
import { assertQuota } from '../services/billing.js';
import { canEditDossier, createExperiment, saveDossierSection, updateEstimates, upsertSuccessStoryDraft, type DossierSection } from '../services/elaboration.js';
import { implementationOwner, isAuthor, loadIdea, type IdeaRow } from '../services/workflow.js';
import { savingsText } from '../services/usecases.js';

// API of the AI platform (R2-09 … R2-37). The UI and connectors use the same endpoints.

const admin = { roles: ['admin' as const] };

/** Handler for AI calls: no transaction is held open while a model answers. */
function aiHandler<T>(fn: (ctx: Ctx, req: FastifyRequest, reply: FastifyReply) => Promise<T>, opts: { roles?: Role[] } = {}) {
  return markRoles(async (req: FastifyRequest, reply: FastifyReply): Promise<T> => {
    const user = await requireUser(req);
    if (opts.roles && !opts.roles.some((r) => user.roles.includes(r))) throw forbidden();
    return fn(await detachedCtx(user.tenantId, user), req, reply);
  }, opts.roles);
}

const idParam = (req: FastifyRequest) => z.object({ id: z.uuid() }).parse(req.params).id;

/** Who sees AI analyses of an idea: authors, mentor, triage, deciders, area leads, implementation owner. */
async function canSeeAi(c: Ctx, idea: IdeaRow & { mentor_id?: string | null }): Promise<boolean> {
  const u = c.user;
  if (!u) return false;
  if (isAuthor(u, idea) || can(u, 'aiAnalyses')) return true;
  if (idea.mentor_id === u.id) return true;
  return (await implementationOwner(c, idea.id)) === u.id;
}

/**
 * Result kinds that carry a recommendation before the human decision (R2-39): the triage
 * suggestion and the reply draft. Authors, area leads and implementers never see them, so
 * the answer of the triage team stays the first decision.
 */
export const RESTRICTED_KINDS = ['triage_suggestion', 'reply_draft'];

export function canSeeRecommendations(c: Ctx, idea: { mentor_id?: string | null }): boolean {
  return can(c.user, 'aiRecommendations') || (!!c.user && idea.mentor_id === c.user.id);
}

/** True when at least one task uses a real model; otherwise the UI shows the "no model" banner (R2-40). */
export function modelConfigured(ai: Ctx['settings']['ai']): boolean {
  return (['fast', 'deep'] as const).some((slot) => allProviders(ai).find((p) => p.id === ai.models[slot].provider)?.kind !== 'builtin');
}

/** Who may start analyses and correct statements: mentor, triage, admin. */
export function canWorkAi(c: Ctx, idea: IdeaRow & { mentor_id?: string | null }): boolean {
  return isTriage(c.user) || (!!c.user && idea.mentor_id === c.user.id);
}

export async function visibleIdea(c: Ctx, id: string, work = false): Promise<IdeaRow & { mentor_id?: string | null }> {
  const idea = (await loadIdea(c, id)) as IdeaRow & { mentor_id?: string | null };
  if (!(await canSeeAi(c, idea))) throw forbidden(m('ai.seeAnalyses'));
  if (work && !canWorkAi(c, idea)) throw forbidden(m('ai.workRights'));
  return idea;
}

interface ResultRow {
  id: string;
  kind: string;
  version: number;
  subject: string | null;
  content: StoredContent;
  changes: { added: string[]; removed: string[] } | null;
  created_at: Date;
  created_by: string | null;
}

/** A result as the UI shows it: corrections applied and computed figures added. */
async function present(c: Ctx, r: ResultRow) {
  const corr = await c.db.query<{ claim_id: string; action: string; corrected_text: string | null; reason: string; user_name: string | null; created_at: Date }>(
    `SELECT k.claim_id, k.action, k.corrected_text, k.reason, u.display_name AS user_name, k.created_at
       FROM ai_corrections k LEFT JOIN users u ON u.id = k.user_id WHERE k.result_id = $1`,
    [r.id],
  );
  const byClaim = new Map(corr.rows.map((x) => [x.claim_id, x]));
  const sections = r.content.sections.map((s) => ({
    ...s,
    claims: s.claims.map((cl) => {
      const k = byClaim.get(cl.id);
      cl = cl.note ? { ...cl, note: relocalize(c.locale, cl.note) } : cl;
      return k ? { ...cl, correction: { action: k.action, text: k.corrected_text, reason: k.reason, by: k.user_name, at: k.created_at } } : cl;
    }),
  }));
  const data = r.content.data as Record<string, unknown>;
  // Figures are only computed from complete inputs; open values stay "zu klären" (R2-40).
  let computed: unknown = null;
  const assumptions = data.assumptions as Assumption[] | undefined;
  if (r.kind === 'business_case' && assumptions && businessCaseComplete(assumptions)) computed = computeBusinessCase(assumptions, Number(data.horizonYears) || 3);
  if (r.kind === 'market_size' && data.topDown && data.bottomUp) computed = computeMarketSize(data as unknown as MarketInputs);
  if (r.kind === 'internal_market' && data.lever) computed = computeLever(data.lever as Parameters<typeof computeLever>[0]);
  return {
    id: r.id, kind: r.kind, version: r.version, subject: r.subject, createdAt: r.created_at, edited: !!r.content.meta.edited,
    data, sections, sources: r.content.sources, warnings: relocalizeAll(c.locale, r.content.warnings), meta: r.content.meta, changes: r.changes, computed,
  };
}

async function latestResults(c: Ctx, ideaId: string, recommendations: boolean) {
  const r = await c.db.query<ResultRow>(
    `SELECT DISTINCT ON (kind) id, kind, version, subject, content, changes, created_at, created_by
       FROM ai_results WHERE idea_id = $1 AND subject IS NULL AND ($2 OR NOT kind = ANY($3)) ORDER BY kind, version DESC`,
    [ideaId, recommendations, RESTRICTED_KINDS],
  );
  // One connection: queries run one after another.
  const out = [];
  for (const x of r.rows) out.push(await present(c, x));
  return out;
}

export /**
 * Review status, the reader's own rating and an open sample per result (R2-44, R2-46).
 * Ratings of other people are never returned.
 */
async function withQuality<T extends { id: string; kind: string }>(c: Ctx, results: T[]) {
  const ids = results.map((r) => r.id);
  if (!ids.length) return [];
  const reviews = await c.db.query<{ result_id: string; status: string; by: string | null; at: Date }>(
    'SELECT v.result_id, v.status, u.display_name AS by, v.created_at AS at FROM ai_reviews v LEFT JOIN users u ON u.id = v.user_id WHERE v.result_id = ANY($1)',
    [ids],
  );
  const mine = await c.db.query<{ result_id: string; helpful: boolean }>('SELECT result_id, helpful FROM ai_ratings WHERE result_id = ANY($1) AND user_id = $2', [ids, c.user?.id ?? null]);
  const samples = await c.db.query<{ id: string; month: string; result_id: string; verdict: string | null; note: string | null }>(
    'SELECT id, month, result_id, verdict, note FROM ai_samples WHERE result_id = ANY($1) AND (assignee_id = $2 OR $3)',
    [ids, c.user?.id ?? null, isTriage(c.user)],
  );
  return results.map((r) => {
    const v = reviews.rows.find((x) => x.result_id === r.id);
    const sm = samples.rows.find((x) => x.result_id === r.id);
    return {
      ...r,
      review: (REVIEW_KINDS as readonly string[]).includes(r.kind) ? (v ? { status: v.status, by: v.by, at: v.at } : { status: 'unchecked', by: null, at: null }) : null,
      myRating: mine.rows.find((x) => x.result_id === r.id)?.helpful ?? null,
      sample: sm ? { id: sm.id, month: sm.month, verdict: sm.verdict, note: sm.note } : null,
    };
  });
}

export async function loadResult(c: Ctx, id: string): Promise<ResultRow & { idea_id: string | null }> {
  const r = await c.db.query<ResultRow & { idea_id: string | null }>('SELECT * FROM ai_results WHERE id = $1', [id]);
  if (!r.rows[0]) throw notFound(m('ai.resultNotFound'));
  return r.rows[0];
}

/** Sources of the analyses an idea already has, renumbered for the Gate 2 brief. */
async function briefSources(c: Ctx, ideaId: string): Promise<Source[]> {
  const r = await c.db.query<{ content: StoredContent }>(
    `SELECT DISTINCT ON (kind) content FROM ai_results
      WHERE idea_id = $1 AND subject IS NULL AND kind IN ('short_analysis', 'competition', 'market_size', 'internal_market', 'business_case', 'counterarguments')
      ORDER BY kind, version DESC`,
    [ideaId],
  );
  const byUrl = new Map<string, Source>();
  for (const row of r.rows) for (const s of row.content.sources ?? []) if (!byUrl.has(s.url)) byUrl.set(s.url, s);
  return [...byUrl.values()].slice(0, 20).map((s, n) => ({ ...s, id: n + 1 }));
}

function briefWords(r: { sections: { claims: { text: string }[] }[]; data: Record<string, unknown> }): number {
  const text = r.sections.length ? r.sections.flatMap((s) => s.claims.map((c) => c.text)).join(' ') : String(r.data.onePager ?? '');
  return text.split(/\s+/).filter(Boolean).length;
}

type Figure = { label: string; value: number | null; unit: string; basis: 'source' | 'calculation' | 'estimate' | 'rating'; confidence: 'low' | 'medium' | 'high' | null; note: string; sources: { title: string; url: string }[]; href: string };

/** Key figures of the brief; each one names its basis and links to it. */
function briefFigures(
  locale: Locale,
  it: { idea_id: string; effort_person_days: number | null; effort_euro: number | null; plan_benefit_euro: number | null; mentor_name: string | null },
  bc: Awaited<ReturnType<typeof present>> | null,
  score: { avg: number | null; n: number },
): Figure[] {
  const t = (key: MessageKey, vars?: Record<string, string | number>) => tr(locale, m(key, vars));
  // Links lead to the right tab of the Steckbrief page (R2-47).
  const idea = `/ideen/${it.idea_id}/steckbrief`;
  const dossierNote = it.mentor_name ? t('ai.figure.dossierNoteMentor', { name: it.mentor_name }) : t('ai.figure.dossierNote');
  const figures: Figure[] = [
    { label: t('ai.figure.effort'), value: it.effort_person_days, unit: t('ai.figure.personDays'), basis: 'estimate', confidence: 'medium', note: dossierNote, sources: [], href: `${idea}/zusammenfassung#h-dossier` },
    { label: t('ai.figure.effort'), value: it.effort_euro, unit: '€', basis: 'estimate', confidence: 'medium', note: dossierNote, sources: [], href: `${idea}/zusammenfassung#h-dossier` },
    { label: t('ai.figure.planBenefit'), value: it.plan_benefit_euro, unit: '€', basis: 'estimate', confidence: 'low', note: dossierNote, sources: [], href: `${idea}/zusammenfassung#h-dossier` },
  ];
  const computed = bc?.computed as ReturnType<typeof computeBusinessCase> | null;
  const base = computed?.scenarios.find((s) => s.name === 'base');
  if (bc && base) {
    const assumptions = (bc.data.assumptions as Assumption[]) ?? [];
    const cited = [...new Set(assumptions.flatMap((a) => a.sources))].map((n) => bc.sources.find((s) => s.id === n)).filter((s): s is Source => !!s);
    const allSourced = assumptions.every((a) => a.sources.length > 0);
    const basis = allSourced ? 'source' : 'calculation';
    const note = t(allSourced ? 'ai.figure.computedSourced' : 'ai.figure.computedPartly');
    const conf = allSourced ? 'medium' : 'low';
    figures.push(
      { label: t('ai.figure.payback'), value: base.paybackMonths, unit: t('ai.figure.months'), basis, confidence: conf, note, sources: cited.map((s) => ({ title: s.title, url: s.url })), href: `${idea}/analysen#ai-business_case` },
      { label: t('ai.figure.net', { years: computed!.horizonYears }), value: base.netOverHorizon, unit: '€', basis, confidence: conf, note, sources: cited.map((s) => ({ title: s.title, url: s.url })), href: `${idea}/analysen#ai-business_case` },
    );
  }
  if (score.n) figures.push({ label: 'Scorecard', value: Math.round(score.avg! * 100) / 100, unit: '/ 5', basis: 'rating', confidence: null, note: t('ai.figure.scoreNote', { n: score.n }), sources: [], href: `${idea}/scorecard#h-score` });
  return figures.filter((f) => f.value != null);
}

const base64Payload = (maxBytes: number) => z.string().max(Math.ceil((maxBytes * 4) / 3) + 4).regex(/^[A-Za-z0-9+/=]+$/);

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------- idea analyses

  app.get(
    '/api/ideas/:id/ai',
    tenantHandler(async (ctx, req) => {
      const idea = await visibleIdea(ctx, idParam(req));
      const jobs = await ctx.db.query(
        `SELECT kind, status, error, created_at AS "createdAt", finished_at AS "finishedAt" FROM ai_jobs
          WHERE idea_id = $1 AND (status IN ('queued', 'running') OR finished_at > now() - interval '1 day') ORDER BY created_at DESC LIMIT 10`,
        [idea.id],
      );
      const cost = await ctx.db.query<{ s: number }>('SELECT coalesce(sum(cost_eur), 0)::float AS s FROM ai_actions WHERE idea_id = $1', [idea.id]);
      return {
        enabled: ctx.settings.ai.enabled,
        canWork: canWorkAi(ctx, idea),
        modelConfigured: modelConfigured(ctx.settings.ai),
        canConfigure: hasRole(ctx.user, 'admin'),
        results: await withQuality(ctx, await latestResults(ctx, idea.id, canSeeRecommendations(ctx, idea))),
        reviewRequired: ctx.settings.ai.review.requireBeforeGate2,
        jobs: jobs.rows.map((j) => ({ ...j, error: relocalizeLines(ctx.locale, j.error) })),
        budget: { spentEur: cost.rows[0].s, limitEur: ctx.settings.ai.budget.perIdeaEur },
      };
    }),
  );

  app.get(
    '/api/ai/results/:id/versions',
    tenantHandler(async (ctx, req) => {
      const r = await loadResult(ctx, idParam(req));
      if (r.idea_id) {
        const idea = await visibleIdea(ctx, r.idea_id);
        if (RESTRICTED_KINDS.includes(r.kind) && !canSeeRecommendations(ctx, idea)) throw forbidden(m('ai.recommendationRights'));
      } else if (!isTriage(ctx.user) && !isDecider(ctx.user)) throw forbidden();
      const v = await ctx.db.query<ResultRow>(
        'SELECT * FROM ai_results WHERE idea_id IS NOT DISTINCT FROM $1 AND kind = $2 AND subject IS NOT DISTINCT FROM $3 ORDER BY version DESC LIMIT 20',
        [r.idea_id, r.kind, r.subject],
      );
      const out = [];
      for (const x of v.rows) out.push(await present(ctx, x));
      return out;
    }),
  );

  // Start or refresh analyses (R2-22, R2-32).
  app.post(
    '/api/ideas/:id/ai/run',
    tenantHandler(async (ctx, req, reply) => {
      const idea = await visibleIdea(ctx, idParam(req), true);
      const { kind } = z.object({ kind: z.enum(['short', 'full']) }).parse(req.body);
      if (!ctx.settings.ai.enabled) throw new AiError(tr(ctx.locale, m('ai.disabled')), 'AI_DISABLED');
      // AI quota of the package (R3-06): a clear message instead of a skipped job.
      if (kind === 'full') await assertQuota(ctx);
      await enqueueAiJob(ctx, kind === 'short' ? 'short_analysis' : 'full_analysis', idea.id);
      reply.code(202);
      return { queued: true };
    }),
  );

  // Draft of the reply to the submitter (R2-19).
  app.post(
    '/api/ideas/:id/ai/reply-draft',
    aiHandler(async (ctx, req) => {
      const body = z.object({ lane: z.enum(['fast_lane', 'elaborate', 'forward', 'reject']), reason: z.string().max(3000).default('') }).parse(req.body);
      if (!isTriage(ctx.user)) throw forbidden();
      const idea = await tx(ctx, async (c) => {
        await loadIdea(c, idParam(req));
        return ideaFacts(c, idParam(req));
      });
      const run = await runAgent(ctx, replyCall(idea!, body.lane, body.reason, ctx.settings));
      const fin = finalize(run, [], `${idea!.title}\n${idea!.problem}\n${idea!.solution}\n${idea!.benefit}\n${body.reason}`);
      return { ...fin.output, warnings: relocalizeAll(ctx.locale, fin.warnings), model: run.model };
    }),
  );

  // Summary of the discussion (R2-21).
  app.post(
    '/api/ideas/:id/ai/discussion-summary',
    aiHandler(async (ctx, req) => {
      const { idea, comments } = await tx(ctx, async (c) => {
        await loadIdea(c, idParam(req));
        const rows = await c.db.query<{ id: string; body: string }>('SELECT id, body FROM comments WHERE idea_id = $1 ORDER BY created_at LIMIT 200', [idParam(req)]);
        return { idea: await ideaFacts(c, idParam(req)), comments: rows.rows };
      });
      if (comments.length < 3) throw badRequest(m('ai.summaryMin'));
      const numbered = comments.map((x, n) => ({ n: n + 1, id: x.id, body: x.body }));
      const run = await runAgent(ctx, summaryCall(idea!, numbered));
      const fin = finalize(run, [], numbered.map((x) => x.body).join('\n'));
      const points = (fin.data.points as { kind: string; text: string; comments: number[] }[]).map((p) => ({
        ...p,
        commentIds: p.comments.map((n) => numbered[n - 1]?.id).filter(Boolean),
      }));
      const { output: _o, ...rest } = fin;
      const content = { ...rest, data: { ...fin.data, points }, agent: 'discussion_summary' as const };
      const saved = await tx(ctx, (c) => saveResult(c, idea!.id, 'discussion_summary', content, run.actionId));
      return { id: saved.id, summary: fin.data.summary, points, warnings: relocalizeAll(ctx.locale, fin.warnings) };
    }),
  );

  // Correct or discard a single AI statement (R2-15).
  app.post(
    '/api/ai/results/:id/corrections',
    tenantHandler(async (ctx, req) => {
      const body = z.object({ claimId: z.string().min(1).max(20), action: z.enum(['correct', 'discard']), correctedText: z.string().trim().max(2000).optional(), reason: z.string().trim().min(5).max(1000) }).parse(req.body);
      const r = await loadResult(ctx, idParam(req));
      if (!r.idea_id) throw badRequest(m('ai.notCorrectable'));
      await visibleIdea(ctx, r.idea_id, true);
      const claim = r.content.sections.flatMap((s) => s.claims).find((c) => c.id === body.claimId);
      if (!claim) throw notFound(m('ai.claimNotFound'));
      if (body.action === 'correct' && !body.correctedText) throw badRequest(m('ai.correctedMissing'));
      await ctx.db.query(
        `INSERT INTO ai_corrections (tenant_id, result_id, claim_id, action, original_text, corrected_text, reason, user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (result_id, claim_id) DO UPDATE SET action = EXCLUDED.action, corrected_text = EXCLUDED.corrected_text,
           reason = EXCLUDED.reason, user_id = EXCLUDED.user_id, created_at = now()`,
        [ctx.tenantId, r.id, body.claimId, body.action, claim.text, body.correctedText ?? null, body.reason, ctx.user!.id],
      );
      await audit(ctx, 'ai.correction', 'ai_result', r.id, { claim: claim.text }, body);
      return { ok: true };
    }),
  );

  // Recalculate the business case with changed assumptions (R2-28).
  app.put(
    '/api/ai/results/:id/business-case',
    tenantHandler(async (ctx, req) => {
      const body = z
        .object({
          horizonYears: z.number().int().min(1).max(10),
          assumptions: z.array(z.object({ id: z.string().regex(/^[a-z0-9_]{1,40}$/), label: z.string().min(1).max(120), unit: z.string().max(40), kind: z.enum(['benefit', 'one_off_cost', 'running_cost']), low: z.number().nullable(), base: z.number().nullable(), high: z.number().nullable(), sources: z.array(z.number().int()).default([]) })).min(1).max(30),
        })
        .parse(req.body);
      const r = await loadResult(ctx, idParam(req));
      if (r.kind !== 'business_case' || !r.idea_id) throw badRequest(m('ai.notBusinessCase'));
      await visibleIdea(ctx, r.idea_id, true);
      // Open values may stay empty ("zu klären"); figures are computed once all are filled (R2-40).
      const bad = body.assumptions.find((a) => a.low != null && a.base != null && a.high != null && !(a.low <= a.base && a.base <= a.high));
      if (bad) throw badRequest(m('ai.rangeOrder', { label: bad.label }));
      const content: StoredContent = { ...r.content, data: { ...r.content.data, ...body }, meta: { ...r.content.meta, edited: true, generatedAt: new Date().toISOString() } };
      const saved = await saveResult(ctx, r.idea_id, 'business_case', content, null);
      const computed = businessCaseComplete(body.assumptions) ? computeBusinessCase(body.assumptions, body.horizonYears) : null;
      return { id: saved.id, version: saved.version, computed };
    }),
  );

  app.get(
    '/api/ai/results/:id/business-case.csv',
    tenantHandler(async (ctx, req, reply) => {
      const r = await loadResult(ctx, idParam(req));
      if (r.kind !== 'business_case' || !r.idea_id) throw badRequest(m('ai.notBusinessCase'));
      await visibleIdea(ctx, r.idea_id);
      const data = r.content.data as { assumptions: Assumption[]; horizonYears: number };
      if (!businessCaseComplete(data.assumptions)) throw badRequest(m('ai.openValues'));
      reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="business-case.csv"');
      return '﻿' + businessCaseCsv(data.assumptions, computeBusinessCase(data.assumptions, data.horizonYears), ctx.locale);
    }),
  );

  // Editable axes of the positioning map (R2-25).
  app.put(
    '/api/ai/results/:id/positioning',
    tenantHandler(async (ctx, req) => {
      const axis = z.object({ label: z.string().trim().min(1).max(60), low: z.string().max(40), high: z.string().max(40) });
      const body = z
        .object({ axisX: axis, axisY: axis, items: z.array(z.object({ name: z.string().min(1).max(120), x: z.number().min(0).max(10), y: z.number().min(0).max(10), isIdea: z.boolean(), priceOnRequest: z.boolean() })).max(15) })
        .parse(req.body);
      const r = await loadResult(ctx, idParam(req));
      if (r.kind !== 'positioning' || !r.idea_id) throw badRequest(m('ai.notPositioning'));
      await visibleIdea(ctx, r.idea_id, true);
      const content: StoredContent = { ...r.content, data: { ...r.content.data, ...body }, meta: { ...r.content.meta, edited: true, generatedAt: new Date().toISOString() } };
      const saved = await saveResult(ctx, r.idea_id, 'positioning', content, null);
      return { id: saved.id, version: saved.version };
    }),
  );

  // ---------------------------------------------------------------- before an idea exists (R2-16, R2-17, R2-20)

  app.post(
    '/api/ai/coach',
    aiHandler(async (ctx, req) => {
      const body = z
        .object({
          messages: z.array(z.object({ role: z.enum(['coach', 'user']), text: z.string().max(5000), asks: z.enum(['title', 'problem', 'solution', 'benefit']).nullable().optional() })).max(40),
          fields: z.object({ title: z.string().max(140).default(''), problem: z.string().max(5000).default(''), solution: z.string().max(5000).default(''), benefit: z.string().max(3000).default('') }),
          confidential: z.boolean().default(false),
        })
        .parse(req.body);
      const userText = body.messages.filter((m) => m.role === 'user').map((m) => m.text).join('\n');
      // A text that looks like a report never goes to a model (R2-20).
      const boundary = checkBoundary(userText, ctx.settings);
      const run = await runAgent(ctx, { ...coachCall(body.messages as CoachMessage[], body.fields, body.confidential || boundary.length > 0), logInput: redactedInput(userText) });
      const fin = finalize(run, [], userText);
      return { ...fin.output, boundary, warnings: relocalizeAll(ctx.locale, fin.warnings) };
    }),
  );

  app.post(
    '/api/ai/boundary',
    aiHandler(async (ctx, req) => {
      const { text } = z.object({ text: z.string().max(15000) }).parse(req.body);
      const rules = checkBoundary(text, ctx.settings);
      if (rules.length) return { category: rules[0].category, matches: rules, source: 'rules' };
      // The model check only runs on a local model; nothing is stored (only length and hash are logged).
      const local = (() => {
        try {
          return resolveModel(ctx.settings.ai, 'boundary', true).provider.kind !== 'builtin';
        } catch {
          return false;
        }
      })();
      if (!local || !ctx.settings.ai.enabled) return { category: 'none', matches: [], source: 'rules' };
      try {
        const run = await runAgent(ctx, { ...boundaryCall(text, ctx.settings), logInput: redactedInput(text) });
        const cat = run.output.category;
        const channel = ctx.settings.targetChannels.find((c) => c.kind === ({ report: 'whistleblowing', incident: 'service_desk', complaint: 'complaints', safety: 'safety' } as const)[cat as 'report']);
        return {
          category: cat,
          matches: cat === 'none' ? [] : [{ category: cat, label: run.output.reason, keywords: [], channel: channel ? { name: channel.name, contact: channel.contact, url: channel.url } : null }],
          source: 'model',
        };
      } catch (err) {
        if (err instanceof AiError) return { category: 'none', matches: [], source: 'rules', note: errorText(ctx.locale, err) };
        throw err;
      }
    }),
  );

  app.post(
    '/api/ai/transcribe',
    { bodyLimit: 12_000_000 },
    aiHandler(async (ctx, req) => {
      const body = z.object({ audio: base64Payload(8_000_000), mime: z.string().regex(/^audio\/[a-z0-9.+-]+(;.*)?$/), confidential: z.boolean().default(false) }).parse(req.body);
      const ai = ctx.settings.ai;
      if (!ai.enabled) throw new AiError(tr(ctx.locale, m('ai.disabled')), 'AI_DISABLED');
      const rm = resolveModel(ai, 'transcribe', body.confidential);
      if (rm.provider.kind !== 'openai_compatible') {
        throw new AiError(tr(ctx.locale, m('ai.noSpeech')), 'AI_NO_SPEECH');
      }
      const key = rm.provider.keySource === 'tenant' ? await tx(ctx, (c) => getSecret(c, `provider:${rm.provider.id}`)) : rm.provider.keySource === 'platform' ? platformKey(rm.provider) : null;
      const provider = createProvider(rm.provider, key);
      const started = Date.now();
      try {
        const out = await provider.transcribe!({ mime: body.mime.split(';')[0], base64: body.audio, filename: 'aufnahme.webm' }, rm.model, ctx.locale);
        // Speech is billed per minute by most providers; the price list counts one "token" per second here.
        const cost = Math.round(out.seconds * ((ai.prices.find((p) => p.model === rm.model)?.inputPerMTok ?? 0) / 1_000_000) * 10_000) / 10_000;
        await logAction(ctx, { ideaId: null, agent: 'transcribe', provider: rm.provider.id, model: rm.model, local: rm.local, status: 'ok', input: { audioBytes: Math.round((body.audio.length * 3) / 4) }, output: { chars: out.text.length }, costEur: cost, durationMs: Date.now() - started });
        return { text: out.text };
      } catch (err) {
        const text = err instanceof ProviderError ? err.text : m('ai.speechFailed');
        await logAction(ctx, { ideaId: null, agent: 'transcribe', provider: rm.provider.id, model: rm.model, local: rm.local, status: 'error', input: { audioBytes: body.audio.length }, error: tr('de', text), durationMs: Date.now() - started });
        throw new AiError(text, 'AI_PROVIDER', true);
      }
    }),
  );

  app.post(
    '/api/ai/describe-image',
    { bodyLimit: 8_000_000 },
    aiHandler(async (ctx, req) => {
      const body = z.object({ image: base64Payload(5_000_000), mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']), confidential: z.boolean().default(false) }).parse(req.body);
      const run = await runAgent(ctx, imageCall({ mime: body.mime, base64: body.image }, body.confidential));
      const fin = finalize(run, [], '');
      return { ...fin.output, warnings: relocalizeAll(ctx.locale, fin.warnings), builtin: run.provider === 'builtin' };
    }),
  );

  // Challenge suggestions from strategy documents (R2-36).
  app.post(
    '/api/ai/challenge-suggestions',
    { bodyLimit: 3_000_000 },
    aiHandler(async (ctx, req) => {
      if (!isTriage(ctx.user) && !isDecider(ctx.user)) throw forbidden();
      const body = z.object({ text: z.string().max(100_000).optional(), file: z.object({ name: z.string().max(200), data: base64Payload(2_000_000) }).optional() }).parse(req.body);
      let text = body.text ?? '';
      if (body.file) {
        if (!/\.(txt|md|csv)$/i.test(body.file.name)) throw badRequest(m('ai.textFile'));
        text += `\n${Buffer.from(body.file.data, 'base64').toString('utf8')}`;
      }
      if (text.trim().length < 100) throw badRequest(m('ai.strategyMin'));
      const run = await runAgent(ctx, { ...challengeSuggestionsCall(text, ctx.settings), logInput: { chars: text.length, excerpt: text.slice(0, 2000) } });
      const fin = finalize(run, [], text);
      const { output: _o, ...rest } = fin;
      await tx(ctx, (c) => saveResult(c, null, 'challenge_suggestions', { ...rest, agent: 'challenge_suggestions' }, run.actionId));
      return { ...fin.output, warnings: relocalizeAll(ctx.locale, fin.warnings) };
    }),
  );

  // ---------------------------------------------------------------- Gate-2 brief per meeting (R2-33, R2-34, R2-43)

  app.post(
    '/api/meetings/:id/ai/brief',
    aiHandler(async (ctx, req) => {
      if (!isTriage(ctx.user) && !isDecider(ctx.user)) throw forbidden();
      const meetingId = idParam(req);
      const ideas = await tx(ctx, async (c) => {
        const r = await c.db.query<{ idea_id: string }>('SELECT idea_id FROM meeting_items WHERE meeting_id = $1 ORDER BY position', [meetingId]);
        if (!r.rowCount) throw badRequest(m('elaboration.meetingEmpty'));
        const out = [];
        for (const { idea_id } of r.rows) {
          const facts = await ideaFacts(c, idea_id);
          const dossier = Object.fromEntries(
            (await c.db.query<{ section: string; content: string }>('SELECT section, content FROM dossier_sections WHERE idea_id = $1', [idea_id])).rows.map((x) => [x.section, x.content]),
          );
          const bundle: AnalysisBundle = {
            businessCase: await latestContent(c, idea_id, 'business_case') as AnalysisBundle['businessCase'],
            risks: await latestContent(c, idea_id, 'risk_check') as AnalysisBundle['risks'],
          };
          out.push({ facts: facts!, dossier, bundle, sources: await briefSources(c, idea_id) });
        }
        return out;
      });
      const errors: string[] = [];
      for (const i of ideas) {
        try {
          const call = gate2Call(i.facts, i.dossier, i.bundle, i.sources);
          const run = await runAgent(ctx, call);
          const fin = finalize(run, i.sources, `${i.facts.title}\n${i.facts.problem}\n${i.facts.solution}\n${Object.values(i.dossier).join('\n')}`);
          const { output: _o, ...rest } = fin;
          await tx(ctx, (c) => saveResult(c, i.facts.id, 'gate2_brief', { ...rest, agent: 'gate2_brief' }, run.actionId, meetingId));
        } catch (err) {
          if (!(err instanceof AiError)) throw err;
          errors.push(`#${(i.facts as { number?: number }).number ?? ''} ${i.facts.title}: ${errorText(ctx.locale, err)}`);
        }
      }
      return { ok: errors.length === 0, errors };
    }),
  );

  app.get(
    '/api/meetings/:id/ai/brief',
    tenantHandler(async (ctx, req) => {
      if (!isTriage(ctx.user) && !isDecider(ctx.user) && !hasRole(ctx.user, 'lead')) throw forbidden();
      const meetingId = idParam(req);
      const items = await ctx.db.query<{ idea_id: string; number: number; title: string; effort_person_days: number | null; effort_euro: number | null; plan_benefit_euro: number | null; horizon: number | null; mentor_name: string | null }>(
        `SELECT i.id AS idea_id, i.number, i.title, i.effort_person_days, i.effort_euro, i.plan_benefit_euro, i.horizon, u.display_name AS mentor_name
           FROM meeting_items m JOIN ideas i ON i.id = m.idea_id LEFT JOIN users u ON u.id = i.mentor_id WHERE m.meeting_id = $1 ORDER BY m.position`,
        [meetingId],
      );
      const out = [];
      for (const it of items.rows) {
        const brief = await ctx.db.query<ResultRow>(`SELECT * FROM ai_results WHERE idea_id = $1 AND kind = 'gate2_brief' AND subject = $2 ORDER BY version DESC LIMIT 1`, [it.idea_id, meetingId]);
        const latest = async (kind: string) => {
          const r = await ctx.db.query<ResultRow>('SELECT * FROM ai_results WHERE idea_id = $1 AND kind = $2 AND subject IS NULL ORDER BY version DESC LIMIT 1', [it.idea_id, kind]);
          return r.rows[0] ? present(ctx, r.rows[0]) : null;
        };
        const bc = await latest('business_case');
        const risk = await latest('risk_check');
        const score = await ctx.db.query<{ avg: number | null; n: number }>(`SELECT avg(total)::float AS avg, count(*)::int AS n FROM scorecards WHERE idea_id = $1 AND context = 'gate2'`, [it.idea_id]);
        const base = (bc?.computed as ReturnType<typeof computeBusinessCase> | null)?.scenarios.find((s) => s.name === 'base');
        const counter = await latest('counterarguments');
        const sources = new Map<string, { title: string; url: string }>();
        for (const r of [bc, risk, counter, await latest('competition'), await latest('short_analysis')]) for (const s of r?.sources ?? []) sources.set(s.url, { title: s.title, url: s.url });
        const presented = brief.rows[0] ? await present(ctx, brief.rows[0]) : null;
        out.push({
          ideaId: it.idea_id,
          number: it.number,
          title: it.title,
          brief: presented,
          words: presented ? briefWords(presented) : 0,
          readingMinutes: presented ? Math.max(1, Math.ceil(briefWords(presented) / 200)) : 0,
          counterarguments: counter,
          comparison: {
            score: score.rows[0].n ? Math.round(score.rows[0].avg! * 100) / 100 : null,
            raters: score.rows[0].n,
            effortPersonDays: it.effort_person_days,
            effortEuro: it.effort_euro,
            planBenefitEuro: it.plan_benefit_euro,
            horizon: it.horizon,
            paybackMonths: base?.paybackMonths ?? null,
            netOverHorizon: base?.netOverHorizon ?? null,
            risks: (risk?.data.areas as { area: string; light: string }[] | undefined)?.map((a) => ({ area: a.area, light: a.light })) ?? [],
          },
          // Every key figure with where it comes from and how sure it is (R2-43).
          figures: briefFigures(ctx.locale, it, bc, score.rows[0]),
          // Review status per building block (R2-44).
          reviews: await reviewStatus(ctx, it.idea_id),
          reviewRequired: ctx.settings.ai.review.requireBeforeGate2,
          sources: [...sources.values()].slice(0, 15),
        });
      }
      return out;
    }),
  );

  // Reading time of the brief, measured in the pilot (R2-43). Stored without the reader.
  app.post(
    '/api/meetings/:id/ai/brief/read',
    tenantHandler(async (ctx, req) => {
      if (!isTriage(ctx.user) && !isDecider(ctx.user) && !hasRole(ctx.user, 'lead')) throw forbidden();
      const body = z.object({ ideaId: z.uuid(), seconds: z.number().int().min(1).max(3600) }).parse(req.body);
      const meetingId = idParam(req);
      const ok = await ctx.db.query('SELECT 1 FROM meeting_items WHERE meeting_id = $1 AND idea_id = $2', [meetingId, body.ideaId]);
      if (!ok.rowCount) throw notFound();
      await ctx.db.query('INSERT INTO brief_reads (tenant_id, meeting_id, idea_id, seconds) VALUES ($1, $2, $3, $4)', [ctx.tenantId, meetingId, body.ideaId, body.seconds]);
      return { ok: true };
    }),
  );

  // ---------------------------------------------------------------- adopt AI drafts into the domain (R2-30, R2-31, R2-37)

  // The dossier draft fills empty or unchanged sections; human text is never overwritten.
  app.post(
    '/api/ideas/:id/ai/adopt-dossier',
    tenantHandler(async (ctx, req) => {
      const idea = await visibleIdea(ctx, idParam(req));
      if (!canEditDossier(ctx, idea)) throw forbidden(m('ai.dossierEditors'));
      const { resultId } = z.object({ resultId: z.uuid() }).parse(req.body);
      const result = await loadResult(ctx, resultId);
      if (result.idea_id !== idea.id || result.kind !== 'dossier_draft') throw badRequest(m('ai.notDossierDraft'));
      const draft = result.content.data as unknown as DossierDraft;
      const current = new Map(
        (await ctx.db.query<{ section: string; content: string; source: string | null }>(
          `SELECT s.section, s.content, (SELECT h.source FROM dossier_history h WHERE h.idea_id = s.idea_id AND h.section = s.section ORDER BY h.version DESC LIMIT 1) AS source
             FROM dossier_sections s WHERE s.idea_id = $1`,
          [idea.id],
        )).rows.map((r) => [r.section, r]),
      );
      const parts: { section: DossierSection; content: string; openPoints: string[] }[] = [
        { section: 'summary', content: draft.summary, openPoints: [] },
        ...draft.parts.map((p) => ({ section: p.section as DossierSection, content: p.content, openPoints: p.openQuestions })),
      ];
      const adopted: string[] = [];
      const skipped: string[] = [];
      for (const p of parts) {
        const cur = current.get(p.section);
        if (cur && cur.content.trim() && cur.source !== 'ai') {
          skipped.push(p.section);
          continue;
        }
        if (!p.content.trim() && !p.openPoints.length) continue;
        await saveDossierSection(ctx, idea, p.section, p.content, { source: 'ai', openPoints: p.openPoints });
        adopted.push(p.section);
      }
      const mid = (r: { low: number; high: number } | null) => (r ? Math.round((r.low + r.high) / 2) : undefined);
      const est = draft.estimates;
      const fill = {
        effortPersonDays: idea.effort_person_days == null ? mid(est.effortPersonDays) : undefined,
        effortEuro: idea.effort_euro == null ? mid(est.effortEuro) : undefined,
        planBenefitEuro: idea.plan_benefit_euro == null ? mid(est.planBenefitEuro) : undefined,
      };
      if (Object.values(fill).some((v) => v !== undefined)) await updateEstimates(ctx, idea, fill);
      await audit(ctx, 'ai.adopt_dossier', 'idea', idea.id, null, { resultId, adopted, skipped });
      return { adopted, skipped };
    }),
  );

  app.post(
    '/api/ideas/:id/ai/adopt-experiment',
    tenantHandler(async (ctx, req) => {
      const idea = await visibleIdea(ctx, idParam(req));
      const { resultId } = z.object({ resultId: z.uuid() }).parse(req.body);
      const result = await loadResult(ctx, resultId);
      if (result.idea_id !== idea.id || result.kind !== 'experiment') throw badRequest(m('ai.notExperiment'));
      const x = result.content.data as unknown as ExperimentProposal;
      const weeks = Math.min(26, Math.max(1, Math.round(Number(x.durationWeeks) || 4)));
      const end = new Date(`${ctx.today}T00:00:00Z`);
      end.setUTCDate(end.getUTCDate() + weeks * 7);
      return createExperiment(ctx, idea, {
        hypothesis: x.hypothesis, smallestTest: x.smallestTest, metric: x.metric, successCriteria: x.successCriteria,
        startsOn: ctx.today, endsOn: end.toISOString().slice(0, 10), aiResultId: resultId,
      });
    }),
  );

  // Draft of the success story from dossier and impact review; triage edits and sends it.
  app.post(
    '/api/ideas/:id/ai/success-story',
    aiHandler(async (ctx, req) => {
      if (!isTriage(ctx.user)) throw forbidden(m('ai.storyWriters'));
      const ideaId = idParam(req);
      const facts = await tx(ctx, async (c) => {
        await visibleIdea(c, ideaId);
        const idea = await ideaFacts(c, ideaId);
        const dossier = Object.fromEntries(
          (await c.db.query<{ section: string; content: string }>('SELECT section, content FROM dossier_sections WHERE idea_id = $1', [ideaId])).rows.map((x) => [x.section, x.content]),
        );
        const r = await c.db.query<{ plan_value: string | null; actual_value: string | null; notes: string | null; done_at: Date | null }>(
          'SELECT plan_value, actual_value, notes, done_at FROM impact_reviews WHERE idea_id = $1',
          [ideaId],
        );
        const ir = r.rows[0];
        const benefit = ir?.actual_value != null ? `Ist-Nutzen ${ir.actual_value} € pro Jahr (Plan ${ir.plan_value ?? 'nicht angegeben'} €), bestätigt im Wirkungsreview` : null;
        // Savings with unit, CO₂ from kWh and the controlling confirmation (R3-32, R3-33).
        const savings = await savingsText(c, ideaId, c.settings.locale);
        return { idea: idea!, dossier, benefit, review: ir?.done_at ? ir.notes : null, savings };
      });
      const run = await runAgent(ctx, successStoryCall(facts.idea, { dossier: facts.dossier, benefit: facts.benefit, review: facts.review, savings: facts.savings }));
      const fin = finalize(run, [], `${facts.idea.title}\n${facts.idea.problem}\n${facts.idea.solution}\n${Object.values(facts.dossier).join('\n')}`);
      const { output, ...rest } = fin;
      return tx(ctx, async (c) => {
        const saved = await saveResult(c, ideaId, 'success_story', { ...rest, agent: 'success_story' }, run.actionId);
        const story = await upsertSuccessStoryDraft(c, ideaId, output.title, output.body, saved.id);
        return { ...story, title: output.title, body: output.body, warnings: relocalizeAll(ctx.locale, fin.warnings) };
      });
    }),
  );

  // ---------------------------------------------------------------- administration (R2-09, R2-10, R2-12)

  app.get(
    '/api/admin/ai',
    tenantHandler(async (ctx) => {
      const ai = ctx.settings.ai;
      const hash = configHash(ai);
      const run = await latestRun(ctx, hash);
      const agents = [];
      for (const a of AGENTS) {
        const state = await releaseState(ctx, a);
        let model: { provider: string; model: string; local: boolean } | { error: string };
        try {
          const m = resolveModel(ai, a, a === 'boundary');
          model = { provider: providerName(ctx.locale, m.provider), model: m.model, local: m.local };
        } catch (err) {
          model = { error: errorText(ctx.locale, err) };
        }
        agents.push({ agent: a, ...AGENT_DEFAULTS[a], label: agentLabel(ctx.locale, a), minScore: minScore(ai, a), enabled: ai.agents[a]?.enabled !== false, release: state, metric: run?.metrics[a] ?? null, model });
      }
      const usage = await ctx.db.query(
        `SELECT agent, count(*)::int AS calls, coalesce(sum(cost_eur), 0)::float AS "costEur", coalesce(sum(input_tokens + output_tokens), 0)::int AS tokens
           FROM ai_actions WHERE created_at >= date_trunc('month', $1::date) GROUP BY agent ORDER BY 3 DESC`,
        [ctx.today],
      );
      return {
        settings: ai,
        templates: providerTemplates(ctx.locale),
        secrets: await secretNames(ctx),
        platform: { anthropic: !!config.anthropicApiKey, openaiCompatible: !!config.openaiCompatibleApiKey, brave: !!config.braveApiKey, secretKey: !!config.secretKey, privateUrls: config.aiAllowPrivateUrls },
        configHash: hash,
        evaluation: run ? { id: run.id, status: run.status, createdAt: run.created_at } : null,
        agents,
        spent: await spent(ctx, null),
        usage: usage.rows,
        quality: await qualityInUse(ctx),
      };
    }, admin),
  );

  app.put(
    '/api/admin/ai',
    tenantHandler(async (ctx, req) => {
      const parsed = aiSettingsSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(m('ai.settingsInvalid'), localizeIssues(ctx.locale, parsed.error.issues));
      const ai = parsed.data;
      const ids = new Set(allProviders(ai).map((p) => p.id));
      for (const [slot, ref] of Object.entries(ai.models)) {
        if (!ids.has(ref.provider)) throw badRequest(m('ai.unknownProviderSlot', { slot }));
      }
      const conf = allProviders(ai).find((p) => p.id === ai.models.confidential.provider);
      if (conf && conf.hosting !== 'local') throw badRequest(m('ai.confidentialLocal'));
      const before = configHash(ctx.settings.ai);
      const settings = { ...ctx.settings, ai };
      await ctx.db.query('UPDATE tenants SET settings = $1 WHERE id = $2', [JSON.stringify(settings), ctx.tenantId]);
      await audit(ctx, 'settings.ai', 'tenant', ctx.tenantId, ctx.settings.ai, ai);
      // A changed model or prompt triggers the quality check automatically (R2-12).
      const changed = configHash(ai) !== before;
      if (changed && ai.enabled) await enqueueEval({ ...ctx, settings }, 'config_change');
      return { ok: true, evaluationQueued: changed };
    }, admin),
  );

  app.put(
    '/api/admin/ai/keys',
    tenantHandler(async (ctx, req) => {
      const body = z.object({ name: z.string().regex(/^(provider:[a-z0-9-]{1,30}|search)$/), value: z.string().trim().max(500).nullable() }).parse(req.body);
      await setSecret(ctx, body.name, body.value);
      await audit(ctx, body.value ? 'ai.key.set' : 'ai.key.delete', 'tenant', ctx.tenantId, null, { name: body.name });
      return { ok: true };
    }, admin),
  );

  // Connection test of a provider and model.
  app.post(
    '/api/admin/ai/test',
    aiHandler(async (ctx, req) => {
      const body = z.object({ provider: z.string(), model: z.string().min(1).max(100) }).parse(req.body);
      const p = allProviders(ctx.settings.ai).find((x) => x.id === body.provider);
      if (!p) throw badRequest(m('ai.unknownProvider'));
      if (p.kind === 'builtin') return { ok: true, model: 'regelbasiert', ms: 0 };
      const key = p.keySource === 'tenant' ? await tx(ctx, (c) => getSecret(c, `provider:${p.id}`)) : p.keySource === 'platform' ? platformKey(p) : null;
      const started = Date.now();
      try {
        const res = await createProvider(p, key).generate({
          model: body.model, system: 'Antworte nur mit dem verlangten JSON.', prompt: 'Gib {"ok": true} zurück.',
          schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, maxTokens: 200, deep: false,
        });
        await logAction(ctx, { ideaId: null, agent: 'connection_test', provider: p.id, model: body.model, local: p.hosting === 'local', status: 'ok', input: { test: true }, output: res.json, inputTokens: res.inputTokens, outputTokens: res.outputTokens, durationMs: Date.now() - started });
        return { ok: true, model: res.servedBy, ms: Date.now() - started };
      } catch (err) {
        await logAction(ctx, { ideaId: null, agent: 'connection_test', provider: p.id, model: body.model, local: p.hosting === 'local', status: 'error', input: { test: true }, error: (err as Error).message, durationMs: Date.now() - started });
        return { ok: false, error: errorText(ctx.locale, err) };
      }
    }, admin),
  );

  app.post(
    '/api/admin/ai/eval',
    tenantHandler(async (ctx, _req, reply) => {
      await enqueueEval(ctx, 'manual');
      reply.code(202);
      return { queued: true };
    }, admin),
  );

  app.get(
    '/api/admin/ai/evals',
    tenantHandler(async (ctx) => {
      const r = await ctx.db.query(
        `SELECT id, config_hash AS "configHash", trigger, status, metrics, details, cost_eur AS "costEur", error, created_at AS "createdAt", finished_at AS "finishedAt",
                testset_version AS "testsetVersion", comparison, previous_run_id AS "previousRunId"
           FROM ai_eval_runs ORDER BY created_at DESC LIMIT 20`,
      );
      // Localised names of the agents for the report view.
      return r.rows.map((row) => ({ ...row, names: Object.fromEntries(Object.keys(row.metrics ?? {}).map((a) => [a, agentName(ctx.locale, a)])) }));
    }, admin),
  );

  // Release an agent despite a missed minimum score, with a written reason (audited).
  app.post(
    '/api/admin/ai/release',
    tenantHandler(async (ctx, req) => {
      const body = z.object({ agent: z.enum(AGENTS), reason: z.string().trim().min(10).max(500) }).parse(req.body);
      const ai = ctx.settings.ai;
      const override = { configHash: configHash(ai), reason: body.reason, by: ctx.user!.displayName, at: new Date().toISOString() };
      const next = { ...ctx.settings, ai: { ...ai, releaseOverrides: { ...ai.releaseOverrides, [body.agent]: override } } };
      await ctx.db.query('UPDATE tenants SET settings = $1 WHERE id = $2', [JSON.stringify(next), ctx.tenantId]);
      await audit(ctx, 'ai.release_override', 'tenant', ctx.tenantId, null, { agent: body.agent, ...override });
      return { ok: true };
    }, admin),
  );

  // AI log for data protection (R2-10).
  app.get(
    '/api/admin/ai/log',
    tenantHandler(async (ctx, req) => {
      const q = z.object({ agent: z.string().max(40).optional(), ideaId: z.uuid().optional(), status: z.string().max(20).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
      const r = await ctx.db.query(
        `SELECT a.id, a.agent, a.provider, a.model, a.local, a.status, a.input, a.output, a.sources, a.tools, a.warnings,
                a.input_tokens AS "inputTokens", a.output_tokens AS "outputTokens", a.search_queries AS "searchQueries",
                a.cost_eur AS "costEur", a.duration_ms AS "durationMs", a.error, a.created_at AS "createdAt",
                i.number AS "ideaNumber", a.idea_id AS "ideaId", u.display_name AS "triggeredBy"
           FROM ai_actions a LEFT JOIN ideas i ON i.id = a.idea_id LEFT JOIN users u ON u.id = a.triggered_by
          WHERE ($1::text IS NULL OR a.agent = $1) AND ($2::uuid IS NULL OR a.idea_id = $2) AND ($3::text IS NULL OR a.status = $3)
          ORDER BY a.created_at DESC LIMIT $4`,
        [q.agent ?? null, q.ideaId ?? null, q.status ?? null, q.limit],
      );
      return r.rows.map((row) => ({ ...row, error: row.error && relocalize(ctx.locale, row.error), warnings: relocalizeAll(ctx.locale, row.warnings) }));
    }, admin),
  );
}


// ---------------------------------------------------------------- privacy proof (R2-42)

/** Works council (read-only), triage, admin, deciders and everyone who may see the idea. */
async function proofAccess(ctx: Ctx, ideaId: string): Promise<void> {
  if (can(ctx.user, 'aiProofs')) return;
  await visibleIdea(ctx, ideaId);
}

export async function proofRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/ideas/:id/ai/proof',
    tenantHandler(async (ctx, req) => {
      await proofAccess(ctx, idParam(req));
      const proof = await proofForIdea(ctx, idParam(req));
      if (!proof) throw notFound();
      return proof;
    }),
  );

  app.get(
    '/api/ideas/:id/ai/proof.pdf',
    tenantHandler(async (ctx, req, reply) => {
      await proofAccess(ctx, idParam(req));
      const proof = await proofForIdea(ctx, idParam(req));
      if (!proof) throw notFound();
      reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="ki-nachweis-idee-${proof.idea.number}.pdf"`);
      return renderPdf(proofBlocks(proof, ctx.locale), {
        title: tr(ctx.locale, m('ai.proof.pdfTitle', { number: proof.idea.number })),
        footer: tr(ctx.locale, m('ai.proof.pdfFooter', { workspace: proof.workspace, number: proof.idea.number })),
      });
    }),
  );

  // Overview for the works council and admins: ideas with AI actions in a period, no texts.
  app.get(
    '/api/ai/proofs',
    tenantHandler(async (ctx, req) => {
      const q = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() }).parse(req.query);
      const to = q.to ?? ctx.today;
      const from = q.from ?? `${Number(to.slice(0, 4)) - 1}${to.slice(4)}`;
      const r = await ctx.db.query(
        `SELECT i.id AS "ideaId", i.number, CASE WHEN i.confidential THEN NULL ELSE i.title END AS title, i.confidential,
                count(*)::int AS actions, count(*) FILTER (WHERE NOT a.local)::int AS external,
                coalesce(sum(a.search_queries), 0)::int AS "searchQueries", round(coalesce(sum(a.cost_eur), 0), 4)::float AS "costEur",
                max(a.created_at) AS "lastAction"
           FROM ai_actions a JOIN ideas i ON i.id = a.idea_id
          WHERE a.created_at::date BETWEEN $1 AND $2
          GROUP BY i.id ORDER BY max(a.created_at) DESC LIMIT 500`,
        [from, to],
      );
      return { from, to, items: r.rows };
    }, { roles: ['works_council', 'admin'] }),
  );
}

export { AGENT_DEFAULTS, type AgentName };
