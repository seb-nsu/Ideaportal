import type { Ctx } from '../lib/context.js';
import { m, tr } from '../i18n/index.js';

// Throughput times per section of the idea flow (R2-41): median and 90th percentile, a monthly
// time series and the baseline measured before the pilot. All figures are aggregated over
// ideas; nothing is shown per person.

export const SECTIONS = ['submission', 'gate1', 'gate2', 'implementation', 'gate3'] as const;
export type Section = (typeof SECTIONS)[number];

/** Section name in the reader's language (R2-50). */
export const sectionLabel = (ctx: Ctx, section: Section) => tr(ctx.locale, m(`misc.section.${section}`));

/** Start and end of every section per idea; a section counts in the period in which it ended. */
const SPANS = `
  WITH g1 AS (SELECT DISTINCT ON (idea_id) idea_id, outcome, decided_at FROM decisions WHERE gate = 1 ORDER BY idea_id, decided_at),
       g2 AS (SELECT DISTINCT ON (idea_id) idea_id, decided_at FROM decisions WHERE gate = 2 ORDER BY idea_id, decided_at),
  spans AS (
    SELECT 'submission' AS section, i.id AS idea_id, i.challenge_id, i.created_at AS started, i.submitted_at AS ended FROM ideas i WHERE i.submitted_at IS NOT NULL
    UNION ALL
    SELECT 'gate1', i.id, i.challenge_id, i.submitted_at, g1.decided_at FROM ideas i JOIN g1 ON g1.idea_id = i.id WHERE i.submitted_at IS NOT NULL
    UNION ALL
    SELECT 'gate2', i.id, i.challenge_id, g1.decided_at, g2.decided_at FROM ideas i JOIN g1 ON g1.idea_id = i.id AND g1.outcome = 'elaborate' JOIN g2 ON g2.idea_id = i.id
    UNION ALL
    SELECT 'implementation', i.id, i.challenge_id, im.created_at, im.closed_at FROM ideas i JOIN implementations im ON im.idea_id = i.id WHERE im.closed_at IS NOT NULL
    UNION ALL
    SELECT 'gate3', i.id, i.challenge_id, im.closed_at, r.done_at FROM ideas i JOIN implementations im ON im.idea_id = i.id JOIN impact_reviews r ON r.idea_id = i.id
     WHERE im.closed_at IS NOT NULL AND r.done_at IS NOT NULL
  ),
  days AS (
    SELECT section, idea_id, challenge_id, ended, greatest(extract(epoch FROM ended - started) / 86400, 0) AS d
      FROM spans WHERE ended >= started
  )`;

export interface SectionStats {
  section: Section;
  label: string;
  count: number;
  medianDays: number | null;
  p90Days: number | null;
  baselineDays: number | null;
  series: { month: string; count: number; medianDays: number }[];
}

const round1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);

/** areas: limit to the ideas of these areas (R3-29); null = all ideas. */
export async function throughput(ctx: Ctx, from: string, to: string, challengeId: string | null = null, areas: string[] | null = null): Promise<SectionStats[]> {
  const params: unknown[] = [from, to];
  let challenge = challengeId ? `AND challenge_id = $${params.push(challengeId)}` : '';
  if (areas) challenge += ` AND idea_id IN (SELECT idea_id FROM ideas_in_areas($${params.push(areas)}::uuid[]))`;
  const stats = await ctx.db.query<{ section: Section; count: number; median: number | null; p90: number | null }>(
    `${SPANS}
     SELECT section, count(*)::int AS count,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY d)::float AS median,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY d)::float AS p90
       FROM days WHERE ended::date BETWEEN $1 AND $2 ${challenge} GROUP BY section`,
    params,
  );
  const series = await ctx.db.query<{ section: Section; month: string; count: number; median: number }>(
    `${SPANS}
     SELECT section, to_char(date_trunc('month', ended), 'YYYY-MM') AS month, count(*)::int AS count,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY d)::float AS median
       FROM days WHERE ended::date BETWEEN $1 AND $2 ${challenge} GROUP BY 1, 2 ORDER BY 2`,
    params,
  );
  const baselines = ctx.settings.baselines;
  return SECTIONS.map((section) => {
    const s = stats.rows.find((r) => r.section === section);
    return {
      section,
      label: sectionLabel(ctx, section),
      count: s?.count ?? 0,
      medianDays: round1(s?.median ?? null),
      p90Days: round1(s?.p90 ?? null),
      baselineDays: baselines[section],
      series: series.rows.filter((r) => r.section === section).map((r) => ({ month: r.month, count: r.count, medianDays: round1(r.median)! })),
    };
  });
}

export interface ChallengeReport {
  id: string;
  title: string;
  startsOn: string;
  endsOn: string;
  ideas: number;
  participants: number | null;
  decided: number;
  implemented: number;
  /** total = reported (estimated); confirmed = confirmed by controlling (R3-33). */
  benefit: { kind: string; total: number; confirmed: number }[];
  /** Target value of the challenge with progress (R3-33), null without a target. */
  target: { kind: string; value: number; estimated: number; confirmed: number } | null;
  medianDaysToGate1: number | null;
}

/** One line per challenge in the period: submissions, decisions, implementations and benefit (R2-41). */
export async function challengeReport(ctx: Ctx, from: string, to: string, areas: string[] | null = null): Promise<ChallengeReport[]> {
  // Roles with a scope (R3-29): only ideas of the areas count.
  const inAreas = (col: string, n: number) => (areas ? `AND ${col} IN (SELECT idea_id FROM ideas_in_areas($${n}::uuid[]))` : '');
  const min = ctx.settings.minGroupSize;
  const rows = await ctx.db.query<{
    id: string; title: string; starts_on: string; ends_on: string; ideas: number; people: number; decided: number; implemented: number;
  }>(
    `SELECT c.id, c.title, c.starts_on::text, c.ends_on::text,
            count(i.id) FILTER (WHERE i.status <> 'draft')::int AS ideas,
            count(DISTINCT i.author_id) FILTER (WHERE i.status <> 'draft')::int AS people,
            count(DISTINCT d.idea_id)::int AS decided,
            count(DISTINCT im.idea_id) FILTER (WHERE im.status = 'done')::int AS implemented
       FROM challenges c
       LEFT JOIN ideas i ON i.challenge_id = c.id ${inAreas('i.id', 3)}
       LEFT JOIN decisions d ON d.idea_id = i.id AND d.gate = 1
       LEFT JOIN implementations im ON im.idea_id = i.id
      WHERE c.starts_on <= $2 AND c.ends_on >= $1
      GROUP BY c.id ORDER BY c.starts_on DESC`,
    areas ? [from, to, areas] : [from, to],
  );
  const out: ChallengeReport[] = [];
  for (const r of rows.rows) {
    const benefit = await ctx.db.query<{ kind: string; total: number; confirmed: number }>(
      `SELECT im.benefit_kind AS kind, coalesce(sum(im.benefit_value), 0)::float AS total, coalesce(sum(bc.confirmed_value), 0)::float AS confirmed
         FROM implementations im JOIN ideas i ON i.id = im.idea_id LEFT JOIN benefit_confirmations bc ON bc.idea_id = i.id
        WHERE i.challenge_id = $1 AND im.status = 'done' AND im.benefit_kind IS NOT NULL ${inAreas('i.id', 2)} GROUP BY 1 ORDER BY 1`,
      areas ? [r.id, areas] : [r.id],
    );
    const t = await throughput(ctx, '1900-01-01', '2999-12-31', r.id, areas);
    const target = (await ctx.db.query<{ target_kind: string | null; target_value: string | null }>('SELECT target_kind, target_value FROM challenges WHERE id = $1', [r.id])).rows[0];
    const own = benefit.rows.find((b) => b.kind === target?.target_kind);
    out.push({
      id: r.id,
      title: r.title,
      startsOn: r.starts_on,
      endsOn: r.ends_on,
      ideas: r.ideas,
      // Participation is a count of people: shown only from the minimum group size on.
      participants: r.people >= min ? r.people : null,
      decided: r.decided,
      implemented: r.implemented,
      benefit: benefit.rows,
      target: target?.target_kind && target.target_value != null
        ? { kind: target.target_kind, value: Number(target.target_value), estimated: own?.total ?? 0, confirmed: own?.confirmed ?? 0 }
        : null,
      medianDaysToGate1: t.find((s) => s.section === 'gate1')!.medianDays,
    });
  }
  return out;
}
