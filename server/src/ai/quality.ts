import type { Ctx } from '../lib/context.js';
import { badRequest } from '../lib/errors.js';
import { m, type Locale } from '../i18n/index.js';
import { notifyRoles, notifyUser } from '../services/notify.js';
import type { Section, Source } from './content.js';
import { agentLabel } from './settings.js';
import { sourceMetrics, type BlockSourceMetric } from './sourcecheck.js';

// AI quality in use (R2-44, R2-46): review status per building block, the one-click rating
// "hilfreich?", the expand rate and the monthly sample rated by a mentor. Ratings are only
// ever reported aggregated and from the minimum group size on, never per person.

/** Building blocks of the analyses that get a review status. */
export const REVIEW_KINDS = [
  'short_analysis', 'competition', 'patents', 'positioning', 'market_size', 'internal_market',
  'business_case', 'risk_check', 'experiment', 'counterarguments', 'dossier_draft',
] as const;

export type ReviewStatus = 'unchecked' | 'checked' | 'corrected';

export interface BlockReview {
  kind: string;
  label: string;
  resultId: string;
  version: number;
  status: ReviewStatus;
  by: string | null;
  at: string | null;
}

export const kindLabel = (locale: Locale, kind: string) => agentLabel(locale, kind);

/** Review status of the latest version of every building block of an idea. */
export async function reviewStatus(c: Ctx, ideaId: string): Promise<BlockReview[]> {
  const r = await c.db.query<{ id: string; kind: string; version: number; status: 'checked' | 'corrected' | null; by: string | null; at: Date | null }>(
    `SELECT x.id, x.kind, x.version, v.status, u.display_name AS by, v.created_at AS at
       FROM (SELECT DISTINCT ON (kind) id, kind, version FROM ai_results
              WHERE idea_id = $1 AND subject IS NULL AND kind = ANY($2) ORDER BY kind, version DESC) x
       LEFT JOIN ai_reviews v ON v.result_id = x.id LEFT JOIN users u ON u.id = v.user_id
      ORDER BY array_position($2::text[], x.kind)`,
    [ideaId, REVIEW_KINDS],
  );
  return r.rows.map((x) => ({
    kind: x.kind, label: kindLabel(c.locale, x.kind), resultId: x.id, version: x.version,
    status: x.status ?? 'unchecked', by: x.by, at: x.at ? x.at.toISOString() : null,
  }));
}

/** Setting "alle geprüft vor Gate 2" (R2-44): blocks without review stop the decision. */
export async function assertReviewedForGate2(ctx: Ctx, ideaId: string): Promise<void> {
  if (!ctx.settings.ai.review.requireBeforeGate2) return;
  const open = (await reviewStatus(ctx, ideaId)).filter((b) => b.status === 'unchecked');
  if (open.length) throw badRequest(m('aiq.gate2.unreviewed', { list: open.map((b) => b.label).join(', ') }));
}

export async function setReview(c: Ctx, resultId: string, status: ReviewStatus): Promise<void> {
  if (status === 'unchecked') {
    await c.db.query('DELETE FROM ai_reviews WHERE result_id = $1', [resultId]);
    return;
  }
  await c.db.query(
    `INSERT INTO ai_reviews (tenant_id, result_id, status, user_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (result_id) DO UPDATE SET status = EXCLUDED.status, user_id = EXCLUDED.user_id, created_at = now()`,
    [c.tenantId, resultId, status, c.user!.id],
  );
}

export async function rate(c: Ctx, resultId: string, kind: string, helpful: boolean): Promise<void> {
  await c.db.query(
    `INSERT INTO ai_ratings (tenant_id, result_id, kind, user_id, helpful) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (result_id, user_id) DO UPDATE SET helpful = EXCLUDED.helpful, created_at = now()`,
    [c.tenantId, resultId, kind, c.user!.id, helpful],
  );
}

/** Shown and opened blocks, stored without person and idea. */
export async function recordUsage(c: Ctx, events: { kind: string; event: 'view' | 'open' }[]): Promise<void> {
  for (const e of events) {
    await c.db.query('INSERT INTO ai_usage_events (tenant_id, kind, event) VALUES ($1, $2, $3)', [c.tenantId, e.kind, e.event]);
  }
}

export interface KindQuality {
  kind: string;
  label: string;
  /** Latest versions per idea: review status counts. */
  reviews: { unchecked: number; checked: number; corrected: number };
  /** Ratings "hilfreich?": counts and rate only from the minimum group size. */
  ratings: { n: number; helpful: number | null; rate: number | null; belowMinimum: boolean };
  expand: { views: number; opens: number; rate: number | null };
  sources: BlockSourceMetric | null;
}

export interface SampleRow {
  id: string;
  month: string;
  resultId: string;
  kind: string;
  label: string;
  ideaId: string | null;
  ideaNumber: number | null;
  ideaTitle: string | null;
  assignedToMe: boolean;
  verdict: 'correct' | 'minor' | 'wrong' | null;
  note: string | null;
  ratedAt: string | null;
}

export async function listSamples(c: Ctx, opts: { mine?: boolean; month?: string } = {}): Promise<SampleRow[]> {
  const r = await c.db.query<{ id: string; month: string; result_id: string; kind: string; idea_id: string | null; number: number | null; title: string | null; confidential: boolean | null; assignee_id: string | null; verdict: SampleRow['verdict']; note: string | null; rated_at: Date | null }>(
    `SELECT s.id, s.month, s.result_id, r.kind, r.idea_id, i.number, i.title, i.confidential, s.assignee_id, s.verdict, s.note, s.rated_at
       FROM ai_samples s JOIN ai_results r ON r.id = s.result_id LEFT JOIN ideas i ON i.id = r.idea_id
      WHERE ($1::text IS NULL OR s.month = $1) AND (NOT $2 OR s.assignee_id = $3)
      ORDER BY s.month DESC, i.number`,
    [opts.month ?? null, !!opts.mine, c.user?.id ?? null],
  );
  return r.rows.map((x) => ({
    id: x.id, month: x.month, resultId: x.result_id, kind: x.kind, label: kindLabel(c.locale, x.kind), ideaId: x.idea_id, ideaNumber: x.number,
    ideaTitle: x.confidential ? null : x.title, assignedToMe: !!c.user && x.assignee_id === c.user.id,
    verdict: x.verdict, note: x.note, ratedAt: x.rated_at ? x.rated_at.toISOString() : null,
  }));
}

/** Quality view (Einstellungen › KI › Qualität): aggregated per building block. */
export async function qualityReport(c: Ctx): Promise<{ minGroupSize: number; kinds: KindQuality[]; samples: SampleRow[]; samplesRated: { n: number; correct: number; minor: number; wrong: number } }> {
  const min = c.settings.minGroupSize;
  const reviews = await c.db.query<{ kind: string; checked: number; corrected: number; total: number }>(
    `SELECT x.kind, count(*)::int AS total,
            count(*) FILTER (WHERE v.status = 'checked')::int AS checked, count(*) FILTER (WHERE v.status = 'corrected')::int AS corrected
       FROM (SELECT DISTINCT ON (idea_id, kind) id, kind FROM ai_results
              WHERE idea_id IS NOT NULL AND subject IS NULL AND kind = ANY($1) AND created_at > now() - interval '365 days'
              ORDER BY idea_id, kind, version DESC) x
       LEFT JOIN ai_reviews v ON v.result_id = x.id GROUP BY x.kind`,
    [REVIEW_KINDS],
  );
  const ratings = await c.db.query<{ kind: string; n: number; helpful: number }>(
    `SELECT kind, count(*)::int AS n, count(*) FILTER (WHERE helpful)::int AS helpful FROM ai_ratings
      WHERE created_at > now() - interval '365 days' GROUP BY kind`,
  );
  const usage = await c.db.query<{ kind: string; views: number; opens: number }>(
    `SELECT kind, count(*) FILTER (WHERE event = 'view')::int AS views, count(*) FILTER (WHERE event = 'open')::int AS opens
       FROM ai_usage_events WHERE created_at > now() - interval '365 days' GROUP BY kind`,
  );
  const latest = await c.db.query<{ kind: string; content: { sections?: Section[]; sources?: Source[] } }>(
    `SELECT DISTINCT ON (idea_id, kind) kind, content FROM ai_results
      WHERE idea_id IS NOT NULL AND subject IS NULL AND kind = ANY($1) AND created_at > now() - interval '180 days'
      ORDER BY idea_id, kind, version DESC`,
    [REVIEW_KINDS],
  );
  const src = sourceMetrics(latest.rows);
  const kinds = new Set<string>([...REVIEW_KINDS.filter((k) => reviews.rows.some((r) => r.kind === k) || ratings.rows.some((r) => r.kind === k) || usage.rows.some((r) => r.kind === k)), ...ratings.rows.map((r) => r.kind), ...usage.rows.map((r) => r.kind)]);
  const out: KindQuality[] = [...kinds].map((kind) => {
    const rv = reviews.rows.find((r) => r.kind === kind);
    const rt = ratings.rows.find((r) => r.kind === kind);
    const us = usage.rows.find((r) => r.kind === kind);
    const n = rt?.n ?? 0;
    const enough = n >= min;
    return {
      kind,
      label: kindLabel(c.locale, kind),
      reviews: { unchecked: rv ? rv.total - rv.checked - rv.corrected : 0, checked: rv?.checked ?? 0, corrected: rv?.corrected ?? 0 },
      ratings: { n, helpful: enough ? rt!.helpful : null, rate: enough ? Math.round((rt!.helpful / n) * 100) / 100 : null, belowMinimum: n > 0 && !enough },
      expand: { views: us?.views ?? 0, opens: us?.opens ?? 0, rate: us && us.views >= min ? Math.min(1, Math.round((us.opens / us.views) * 100) / 100) : null },
      sources: src.find((s) => s.kind === kind) ?? null,
    };
  });
  const samples = await listSamples(c);
  const rated = samples.filter((s) => s.verdict);
  return {
    minGroupSize: min,
    kinds: out,
    samples: samples.slice(0, 20),
    samplesRated: { n: rated.length, correct: rated.filter((s) => s.verdict === 'correct').length, minor: rated.filter((s) => s.verdict === 'minor').length, wrong: rated.filter((s) => s.verdict === 'wrong').length },
  };
}

export const SAMPLE_SIZE = 5;

/**
 * Monthly sample (R2-46): once per month five results of the last 60 days are drawn at random
 * and assigned to the mentor of the idea (triage when there is none), who rates them.
 * Called from the daily deadline job; returns how many samples were created.
 */
export async function ensureMonthlySample(ctx: Ctx): Promise<number> {
  if (!ctx.settings.ai.enabled) return 0;
  const month = ctx.today.slice(0, 7);
  const exists = await ctx.db.query('SELECT 1 FROM ai_samples WHERE month = $1 LIMIT 1', [month]);
  if (exists.rowCount) return 0;
  const picks = await ctx.db.query<{ id: string; idea_id: string; kind: string; mentor_id: string | null; number: number }>(
    `SELECT r.id, r.idea_id, r.kind, i.mentor_id, i.number
       FROM (SELECT DISTINCT ON (idea_id, kind) id, idea_id, kind, created_at FROM ai_results
              WHERE idea_id IS NOT NULL AND subject IS NULL AND kind = ANY($1)
                AND created_at >= $2::date - 60 AND created_at < $2::date + 1
              ORDER BY idea_id, kind, version DESC) r
       JOIN ideas i ON i.id = r.idea_id
      ORDER BY random() LIMIT $3`,
    [REVIEW_KINDS, ctx.today, SAMPLE_SIZE],
  );
  if (!picks.rowCount) return 0;
  for (const p of picks.rows) {
    await ctx.db.query('INSERT INTO ai_samples (tenant_id, month, result_id, assignee_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [ctx.tenantId, month, p.id, p.mentor_id]);
  }
  // One notification per sample, linked to the idea; the rating form is in its AI section.
  for (const p of picks.rows) {
    const subject = m('aiq.sample.subject', { month });
    const body = m('aiq.sample.body', { kind: kindLabel(ctx.locale, p.kind), number: p.number });
    if (p.mentor_id) await notifyUser(ctx, p.mentor_id, subject, body, p.idea_id, 'tasks');
    else await notifyRoles(ctx, ['triage'], subject, body, p.idea_id, 'tasks');
  }
  // Usage counts carry no person; they are kept two years like the AI log.
  await ctx.db.query(`DELETE FROM ai_usage_events WHERE created_at < $1::date - interval '24 months'`, [ctx.today]);
  return picks.rowCount;
}

export async function rateSample(c: Ctx, id: string, verdict: 'correct' | 'minor' | 'wrong', note: string | null): Promise<boolean> {
  const r = await c.db.query('UPDATE ai_samples SET verdict = $2, note = $3, rated_at = now() WHERE id = $1', [id, verdict, note]);
  return (r.rowCount ?? 0) > 0;
}
