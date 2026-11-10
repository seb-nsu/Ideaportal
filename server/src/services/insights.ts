import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AiError, resolveModel, runAgent } from '../ai/gateway.js';
import {
  QUERY_STATUSES,
  TRANSLATION_LANGUAGES,
  portfolioQueryCall,
  translateCall,
  type PortfolioFilter,
  type TranslationLanguage,
} from '../ai/insights.js';
import { tx } from '../ai/pipeline.js';
import { fmt, m, tr, type MessageKey } from '../i18n/index.js';
import { isTriageEverywhere, type Ctx } from '../lib/context.js';
import { conflict, notFound } from '../lib/errors.js';
import { VISIBLE_SQL, loadIdea } from './workflow.js';

// Questions to the portfolio in everyday language (R3-23) and translations of ideas and
// comments on demand (R3-30). Both run through the AI gateway; the portfolio answer is built
// by code from a checked filter with the person's read rights, never from free SQL.

// ---------------------------------------------------------------- portfolio question (R3-23)

export const askInput = z.object({ question: z.string().trim().min(3).max(500) });

/** Keeps only what the whitelist allows: known statuses and topics, valid dates and amounts. */
export function normalizeFilter(ctx: Ctx, f: PortfolioFilter): PortfolioFilter {
  const topics = new Map(ctx.settings.topics.map((t) => [t.toLowerCase(), t]));
  const date = (d: string | null) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) ? d : null);
  const amount = (n: number | null) => (n == null || !Number.isFinite(n) || n < 0 ? null : n);
  return {
    ...f,
    statuses: [...new Set(f.statuses.filter((s) => (QUERY_STATUSES as readonly string[]).includes(s)))],
    topics: [...new Set(f.topics.map((t) => topics.get(t.trim().toLowerCase())).filter((t): t is string => !!t))],
    challenge: f.challenge?.trim() || null,
    submittedFrom: date(f.submittedFrom),
    submittedTo: date(f.submittedTo),
    planBenefitMin: amount(f.planBenefitMin),
    planBenefitMax: amount(f.planBenefitMax),
    actualBenefitMin: amount(f.actualBenefitMin),
    actualBenefitMax: amount(f.actualBenefitMax),
    text: f.text?.trim() || null,
    limit: Math.min(50, Math.max(1, Math.round(f.limit || 20))),
  };
}

const ACTUAL = `CASE WHEN im.status = 'done' AND im.benefit_kind IN ('euro', 'revenue') THEN im.benefit_value END`;
const ORDER: Record<PortfolioFilter['sort'], string> = {
  newest: 'coalesce(i.submitted_at, i.created_at) DESC',
  oldest: 'coalesce(i.submitted_at, i.created_at) ASC',
  updated: 'i.updated_at DESC',
  plan_benefit: 'i.plan_benefit_euro DESC NULLS LAST',
  actual_benefit: `${ACTUAL} DESC NULLS LAST`,
};

export interface PortfolioAnswerItem {
  id: string;
  number: number;
  title: string;
  status: string;
  topic: string | null;
  ideaType: string;
  confidential: boolean;
  challenge: string | null;
  submittedAt: string | null;
  planBenefitEuro: number | null;
  actualBenefitEuro: number | null;
  url: string;
}

/**
 * Runs a checked filter with the read rights of the asking person (VISIBLE_SQL, row-level
 * security). Selects no people: no author, mentor or unit, and nothing is grouped by person.
 */
export async function runPortfolioFilter(ctx: Ctx, f: PortfolioFilter) {
  const params: unknown[] = [ctx.user!.id, isTriageEverywhere(ctx.user)];
  const p = (v: unknown) => `$${params.push(v)}`;
  const where = [VISIBLE_SQL, "i.status NOT IN ('draft', 'merged')"];
  if (f.statuses.length) where.push(`i.status = ANY(${p(f.statuses)}::text[])`);
  if (f.topics.length) where.push(`i.topic = ANY(${p(f.topics)}::text[])`);
  if (f.ideaType) where.push(`i.idea_type = ${p(f.ideaType)}`);
  if (f.challenge) where.push(`i.challenge_id IN (SELECT c.id FROM challenges c WHERE c.title ILIKE ${p(`%${escapeLike(f.challenge)}%`)})`);
  if (f.submittedFrom) where.push(`coalesce(i.submitted_at, i.created_at)::date >= ${p(f.submittedFrom)}::date`);
  if (f.submittedTo) where.push(`coalesce(i.submitted_at, i.created_at)::date <= ${p(f.submittedTo)}::date`);
  if (f.planBenefitMin != null) where.push(`i.plan_benefit_euro >= ${p(f.planBenefitMin)}`);
  if (f.planBenefitMax != null) where.push(`i.plan_benefit_euro <= ${p(f.planBenefitMax)}`);
  if (f.actualBenefitMin != null) where.push(`${ACTUAL} >= ${p(f.actualBenefitMin)}`);
  if (f.actualBenefitMax != null) where.push(`${ACTUAL} <= ${p(f.actualBenefitMax)}`);
  if (f.text) {
    const like = p(`%${escapeLike(f.text)}%`);
    where.push(`(i.title ILIKE ${like} OR i.problem ILIKE ${like} OR i.solution ILIKE ${like} OR i.benefit ILIKE ${like})`);
  }
  const from = `FROM ideas i LEFT JOIN implementations im ON im.idea_id = i.id LEFT JOIN challenges ch ON ch.id = i.challenge_id WHERE ${where.join(' AND ')}`;
  const rows = await ctx.db.query<Omit<PortfolioAnswerItem, 'url'>>(
    `SELECT i.id, i.number, i.title, i.status, i.topic, i.idea_type AS "ideaType", i.confidential, ch.title AS challenge,
            i.submitted_at AS "submittedAt", i.plan_benefit_euro AS "planBenefitEuro", ${ACTUAL} AS "actualBenefitEuro"
       ${from} ORDER BY ${ORDER[f.sort]}, i.id LIMIT ${f.limit}`,
    params,
  );
  const totals = await ctx.db.query<{ status: string; n: number; plan: number; actual: number }>(
    `SELECT i.status, count(*)::int AS n, coalesce(sum(i.plan_benefit_euro), 0)::float AS plan, coalesce(sum(${ACTUAL}), 0)::float AS actual
       ${from} GROUP BY i.status ORDER BY 2 DESC, 1`,
    params,
  );
  return { items: rows.rows.map((r) => ({ ...r, url: `/ideen/${r.id}` })), byStatus: totals.rows };
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (x) => '\\' + x);
}

/** Short summary written by code from the result (no second model call, no invented numbers). */
export function summarize(ctx: Ctx, shown: number, byStatus: { status: string; n: number; plan: number; actual: number }[], personIgnored: boolean): string {
  const l = ctx.locale;
  const total = byStatus.reduce((n, r) => n + r.n, 0);
  const parts: string[] = [];
  if (!total) parts.push(tr(l, m('insights.ask.none')));
  else {
    parts.push(tr(l, m(total === 1 ? 'insights.ask.found.one' : 'insights.ask.found.other', { n: fmt.number(l, total) })));
    if (shown < total) parts.push(tr(l, m('insights.ask.shown', { n: shown })));
    const status = (s: string) => tr(l, m(`misc.status.${s}` as MessageKey));
    parts.push(tr(l, m('insights.ask.byStatus', { list: byStatus.map((r) => `${fmt.number(l, r.n)} ${status(r.status)}`).join(', ') })));
    const plan = byStatus.reduce((n, r) => n + r.plan, 0);
    const actual = byStatus.reduce((n, r) => n + r.actual, 0);
    if (plan > 0) parts.push(tr(l, m('insights.ask.plan', { sum: fmt.number(l, Math.round(plan)) })));
    if (actual > 0) parts.push(tr(l, m('insights.ask.actual', { sum: fmt.number(l, Math.round(actual)) })));
  }
  if (personIgnored) parts.push(tr(l, m('insights.ask.personIgnored')));
  return parts.join(' ');
}

/** The whole answer: filter from the gateway, checked, run with read rights, summarised. `ctx` is detached. */
export async function askPortfolio(ctx: Ctx, question: string) {
  const challenges = await tx(ctx, async (c) =>
    (await c.db.query<{ title: string }>('SELECT title FROM challenges ORDER BY ends_on DESC LIMIT 50')).rows.map((r) => r.title),
  );
  const run = await runAgent(ctx, portfolioQueryCall(question, { today: ctx.today, topics: ctx.settings.topics, challenges }));
  const filter = normalizeFilter(ctx, run.output);
  const result = await tx(ctx, (c) => runPortfolioFilter(c, filter));
  return {
    question,
    filter,
    items: result.items,
    total: result.byStatus.reduce((n, r) => n + r.n, 0),
    summary: summarize(ctx, result.items.length, result.byStatus, filter.personFilterIgnored),
    personFilterIgnored: filter.personFilterIgnored,
    ai: { provider: run.provider, model: run.model, builtin: run.provider === 'builtin', actionId: run.actionId },
  };
}

// ---------------------------------------------------------------- translation (R3-30)

export const translateInput = z.object({
  target: z.enum(TRANSLATION_LANGUAGES),
  commentId: z.uuid().optional(),
});

const IDEA_FIELDS = ['title', 'problem', 'solution', 'benefit'] as const;

interface TranslationRow {
  content: Record<string, string>;
  source_language: string | null;
  provider: string;
  model: string;
  local: boolean;
  created_at: Date;
}

const view = (target: string, r: TranslationRow, cached: boolean) => ({
  target,
  sourceLanguage: r.source_language,
  fields: r.content,
  cached,
  provider: r.provider,
  model: r.model,
  local: r.local,
  createdAt: r.created_at,
});

/** Whether a translation can run at all (a real model; confidential ideas need a local one). */
export function translationAvailable(ctx: Ctx, sensitive: boolean): boolean {
  const ai = ctx.settings.ai;
  if (!ai.enabled || ai.agents.translate?.enabled === false) return false;
  try {
    return resolveModel(ai, 'translate', sensitive).provider.kind !== 'builtin';
  } catch {
    return false;
  }
}

/**
 * Translates an idea (title, problem, solution, benefit) or one of its comments into the target
 * language. Read rights as for the idea itself; the original stays unchanged. The result is
 * cached per text and target language. `ctx` is detached: no transaction is open while the model answers.
 */
export async function translateContent(ctx: Ctx, ideaId: string, target: TranslationLanguage, commentId?: string) {
  const src = await tx(ctx, async (c) => {
    const idea = await loadIdea(c, ideaId);
    let keys: string[] = [...IDEA_FIELDS];
    let texts = IDEA_FIELDS.map((k) => idea[k] ?? '');
    if (commentId) {
      const r = await c.db.query<{ body: string }>('SELECT body FROM comments WHERE id = $1 AND idea_id = $2', [commentId, idea.id]);
      if (!r.rows[0]) throw notFound(m('insights.translate.commentNotFound'));
      keys = ['body'];
      texts = [r.rows[0].body];
    }
    const hash = createHash('sha256').update(JSON.stringify(texts)).digest('hex');
    const cached = await c.db.query<TranslationRow>(
      `SELECT content, source_language, provider, model, local, created_at FROM translations
        WHERE idea_id = $1 AND comment_id IS NOT DISTINCT FROM $2 AND target_locale = $3 AND source_hash = $4`,
      [idea.id, commentId ?? null, target, hash],
    );
    return { idea, keys, texts, hash, cached: cached.rows[0] ?? null };
  });
  if (src.cached) return view(target, src.cached, true);

  const sensitive = src.idea.confidential;
  const ai = ctx.settings.ai;
  if (ai.enabled && ai.agents.translate?.enabled !== false) {
    let builtin = false;
    try {
      builtin = resolveModel(ai, 'translate', sensitive).provider.kind === 'builtin';
    } catch (err) {
      if (err instanceof AiError && err.code === 'AI_CONFIDENTIAL') throw conflict(m('insights.translate.confidential'), 'AI_CONFIDENTIAL');
      throw err;
    }
    // The builtin provider cannot translate; say so instead of returning the original.
    if (builtin) throw conflict(m(sensitive ? 'insights.translate.confidential' : 'insights.translate.noModel'), 'AI_NO_TRANSLATION');
  }
  const run = await runAgent(ctx, translateCall(src.idea.id, src.texts, target, sensitive));
  if (run.output.texts.length !== src.texts.length) throw conflict(m('insights.translate.failed'), 'AI_PROVIDER');
  const content = Object.fromEntries(src.keys.map((k, i) => [k, run.output.texts[i]]));
  const row = await tx(ctx, async (c) => {
    await c.db.query(
      'DELETE FROM translations WHERE idea_id = $1 AND comment_id IS NOT DISTINCT FROM $2 AND target_locale = $3 AND source_hash <> $4',
      [src.idea.id, commentId ?? null, target, src.hash],
    );
    const r = await c.db.query<TranslationRow>(
      `INSERT INTO translations (tenant_id, idea_id, comment_id, target_locale, source_hash, source_language, content, provider, model, local, ai_action_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (idea_id, coalesce(comment_id, '00000000-0000-0000-0000-000000000000'::uuid), target_locale, source_hash)
       DO UPDATE SET content = EXCLUDED.content
       RETURNING content, source_language, provider, model, local, created_at`,
      [ctx.tenantId, src.idea.id, commentId ?? null, target, src.hash, run.output.sourceLanguage.slice(0, 10) || null, JSON.stringify(content),
       run.provider, run.model, run.local, run.actionId],
    );
    return r.rows[0];
  });
  return view(target, row, false);
}
