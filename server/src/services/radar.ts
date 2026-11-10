import { z } from 'zod';
import { config } from '../config.js';
import { logAction, runAgent } from '../ai/gateway.js';
import { tx } from '../ai/pipeline.js';
import { problemClustersCall, trendAssignCall, trendDigestCall, type RadarSignal } from '../ai/radar.js';
import { webResearch } from '../ai/search.js';
import type { Source } from '../ai/content.js';
import { cat, m, relocalizeAll, tr, type MessageKey, type Text } from '../i18n/index.js';
import { hasRole, isTriageEverywhere, type Ctx, type Role } from '../lib/context.js';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { parseCsv } from '../lib/importer.js';
import { settingsSchema } from '../lib/settings.js';
import { audit } from './audit.js';
import { hasFeature, requireFeature } from './billing.js';
import { fetchTickets } from './connectors.js';
import { notifyUser } from './notify.js';
import { VISIBLE_SQL, createIdea, ideaInput, requireActiveUser } from './workflow.js';

// AP-27 "Erkennen": trend and technology radar (R4-11), weekly trend hints for sponsors
// (R4-02), white spots (R4-03) and the problem radar from tickets and feedback (R4-01).
// All AI work runs through the gateway; the results are suggestions a person confirms.
// No signal database: web hits live only in the weekly digest and in open suggestions; raw
// tickets and feedback rows are never stored, only clusters with redacted examples.

export const HORIZONS = ['now', 'next', 'later'] as const;
export const MATURITIES = ['emerging', 'growing', 'established'] as const;
/** Who sees the radar, the white spots and the digests of all topic fields. */
export const RADAR_VIEW: Role[] = ['lead', 'triage', 'committee', 'admin'];
/** Who maintains the radar and the problem radar. */
export const RADAR_MANAGE: Role[] = ['lead', 'triage', 'admin'];

const canManage = (ctx: Ctx) => hasRole(ctx.user, ...RADAR_MANAGE);
const requireManage = (ctx: Ctx) => {
  if (!canManage(ctx)) throw forbidden();
};

// ---------------------------------------------------------------- helpers

/** ISO week of a calendar day, e.g. 2026-W42. */
export function isoWeek(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  const wd = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - wd);
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** 1 = Monday … 7 = Sunday. */
export const isoWeekday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay() || 7;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PLACEHOLDER = '[…]';

/**
 * Removes what points to people from ticket and feedback texts (R4-01): e-mail addresses,
 * phone numbers, links, @mentions, labelled person fields ("Reporter: …", "Gemeldet von …"),
 * salutations with a name and the names of the people in the workspace. Best effort; the
 * clusters additionally never carry a person field.
 */
export function redactPersonal(text: string, names: string[]): string {
  let s = text
    .replace(/\S+@\S+\.\S+/g, PLACEHOLDER)
    .replace(/https?:\/\/\S+/g, PLACEHOLDER)
    .replace(/\+?\d[\d\s/().-]{6,}\d/g, PLACEHOLDER)
    .replace(/(^|\s)@[\p{L}\p{N}._-]{2,}/gu, `$1${PLACEHOLDER}`)
    .replace(/\b(reporter|assignee|assigned to|caller|requester|opened by|created by|contact|melder(?:in)?|gemeldet von|erstellt von|bearbeiter(?:in)?|zugewiesen an|ansprechpartner(?:in)?|kontakt|kunde|kundin|anrufer(?:in)?)\s*[:=-]?\s*[\p{Lu}][\p{L}.'-]*(?:\s+[\p{Lu}][\p{L}.'-]*)?/giu, `$1 ${PLACEHOLDER}`)
    .replace(/\b(Herr|Herrn|Frau|Hr\.|Fr\.|Mr\.?|Mrs\.?|Ms\.?|Dr\.)\s+[\p{Lu}][\p{L}'-]*(?:\s+[\p{Lu}][\p{L}'-]*)?/gu, PLACEHOLDER);
  const terms = names
    .flatMap((n) => [n, ...n.split(/[\s._@-]+/)])
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .sort((a, b) => b.length - a.length);
  for (const t of [...new Set(terms)]) {
    s = s.replace(new RegExp(`(^|[^\\p{L}])${escapeRe(t)}(?![\\p{L}])`, 'giu'), `$1${PLACEHOLDER}`);
  }
  return s.replace(/\s+/g, ' ').trim();
}

/** Names of the people of the workspace (display names and the local part of the e-mail). */
async function peopleNames(ctx: Ctx): Promise<string[]> {
  const r = await ctx.db.query<{ display_name: string; email: string }>('SELECT display_name, email FROM users');
  return r.rows.flatMap((u) => [u.display_name, u.email.split('@')[0]]).filter(Boolean);
}

// ---------------------------------------------------------------- settings and sponsors

export const radarSettingsInput = settingsSchema.shape.radar.unwrap();

export async function setRadarSettings(ctx: Ctx, body: unknown) {
  const next = radarSettingsInput.parse(body);
  await ctx.db.query('UPDATE tenants SET settings = $1 WHERE id = $2', [JSON.stringify({ ...ctx.settings, radar: next }), ctx.tenantId]);
  await audit(ctx, 'settings.radar', 'tenant', ctx.tenantId, { radar: ctx.settings.radar }, { radar: next });
  return next;
}

export const sponsorsInput = z.object({ topic: z.string().trim().min(1).max(80), userIds: z.array(z.uuid()).max(20) });

export async function listSponsors(ctx: Ctx) {
  const r = await ctx.db.query<{ topic: string; id: string; displayName: string }>(
    `SELECT ts.topic, u.id, u.display_name AS "displayName" FROM topic_sponsors ts JOIN users u ON u.id = ts.user_id ORDER BY ts.topic, u.display_name`,
  );
  return ctx.settings.topics.map((topic) => ({ topic, sponsors: r.rows.filter((x) => x.topic === topic).map(({ id, displayName }) => ({ id, displayName })) }));
}

export async function setSponsors(ctx: Ctx, input: z.infer<typeof sponsorsInput>) {
  requireManage(ctx);
  if (!ctx.settings.topics.includes(input.topic)) throw badRequest(m('misc.unknownTopic'));
  const ids = [...new Set(input.userIds)];
  for (const id of ids) await requireActiveUser(ctx, id);
  const before = (await ctx.db.query<{ user_id: string }>('SELECT user_id FROM topic_sponsors WHERE topic = $1', [input.topic])).rows.map((r) => r.user_id);
  await ctx.db.query('DELETE FROM topic_sponsors WHERE topic = $1', [input.topic]);
  if (ids.length) {
    await ctx.db.query('INSERT INTO topic_sponsors (tenant_id, topic, user_id) SELECT $1, $2, unnest($3::uuid[])', [ctx.tenantId, input.topic, ids]);
  }
  await audit(ctx, 'radar.sponsors', 'tenant', ctx.tenantId, { topic: input.topic, userIds: before }, { topic: input.topic, userIds: ids });
  return listSponsors(ctx);
}

/**
 * Recipients of the weekly hints per topic field: the sponsors of the topic field and the
 * sponsors of running challenges in it. People who muted "trends" are not asked at all.
 */
export async function trendRecipients(ctx: Ctx): Promise<Map<string, string[]>> {
  const r = await ctx.db.query<{ topic: string; user_id: string }>(
    `WITH s AS (
       SELECT ts.topic, ts.user_id FROM topic_sponsors ts
       UNION
       SELECT c.topic, c.sponsor_id FROM challenges c WHERE c.topic IS NOT NULL AND c.sponsor_id IS NOT NULL AND c.starts_on <= $1 AND c.ends_on >= $1
     )
     SELECT s.topic, s.user_id FROM s JOIN users u ON u.id = s.user_id
      WHERE u.active AND NOT ('external' = ANY(u.roles)) AND NOT ('trends' = ANY(coalesce(u.notify_muted, '{}')))
      ORDER BY s.topic, s.user_id`,
    [ctx.today],
  );
  const out = new Map<string, string[]>();
  for (const row of r.rows) {
    if (!ctx.settings.topics.includes(row.topic)) continue;
    out.set(row.topic, [...(out.get(row.topic) ?? []), row.user_id]);
  }
  return out;
}

// ---------------------------------------------------------------- weekly trend hints (R4-02)

interface DigestContent {
  topic: string;
  week: string;
  summary: string;
  points: { text: string; sources: number[] }[];
  candidates: { title: string; description: string; sources: number[] }[];
  sources: Pick<Source, 'id' | 'title' | 'url' | 'snippet' | 'retrievedAt'>[];
  queries: string[];
  warnings: string[];
  meta: { provider: string; model: string; builtin: boolean };
  adopted?: number[];
}

/** Search queries built by code from the name of the topic field, never by the model (as ADR 0005). */
export function trendQueries(ctx: Ctx, topic: string): string[] {
  const year = ctx.today.slice(0, 4);
  return [1, 2, 3, 4, 5].slice(0, ctx.settings.radar.queriesPerTopic).map((n) => tr(ctx.settings.locale, m(`radar.query.${n}` as MessageKey, { topic, year })));
}

/** One digest per topic field and week; `ctx` is detached (no transaction while the model answers). */
async function digestFor(ctx: Ctx, topic: string, week: string): Promise<{ id: string; content: DigestContent }> {
  const queries = trendQueries(ctx, topic).map((query) => ({ query, origin: 'web' as const }));
  const web = await tx(ctx, (c) => webResearch(c, queries, 1, { confidential: false }));
  if (web.queries.length) {
    // What left the house is part of the AI log (R2-10, R2-14).
    await logAction(ctx, {
      ideaId: null, agent: 'web_search', provider: ctx.settings.ai.search.kind, model: '-', local: false, status: 'ok',
      hosting: ctx.settings.ai.search.kind === 'searxng' ? 'local' : 'other',
      input: { purpose: 'trend_digest', topic, queries: web.queries, removedTerms: web.removed }, sources: web.sources, tools: ['web_search'],
      searchQueries: web.queries.length, costEur: web.queries.length * ctx.settings.ai.search.costPerQueryEur, warnings: web.warnings,
    });
  }
  const run = await runAgent(ctx, trendDigestCall(topic, web.sources));
  const ids = new Set(web.sources.map((s) => s.id));
  const valid = (list: number[]) => [...new Set(list.filter((n) => ids.has(n)))];
  // A hint without a source is dropped (R4-02 "Quellen").
  const points = run.output.points.map((p) => ({ text: p.text.trim(), sources: valid(p.sources) })).filter((p) => p.text && p.sources.length);
  const candidates = run.output.candidates.map((c) => ({ title: c.title.trim(), description: c.description.trim(), sources: valid(c.sources) })).filter((c) => c.title.length >= 2 && c.sources.length);
  const content: DigestContent = {
    topic, week, summary: run.output.summary.trim(), points, candidates,
    sources: web.sources.map(({ id, title, url, snippet, retrievedAt }) => ({ id, title, url, snippet, retrievedAt })),
    queries: web.queries, warnings: [...web.warnings, ...run.warnings],
    meta: { provider: run.provider, model: run.model, builtin: run.provider === 'builtin' },
  };
  const id = await tx(ctx, async (c) =>
    (await c.db.query<{ id: string }>(
      `INSERT INTO trend_digests (tenant_id, topic, week, content, ai_action_id) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, topic, week) DO UPDATE SET content = EXCLUDED.content, ai_action_id = EXCLUDED.ai_action_id, created_at = now()
       RETURNING id`,
      [ctx.tenantId, topic, week, JSON.stringify(content), run.actionId],
    )).rows[0].id,
  );
  return { id, content };
}

/** The weekly mail of one person: every topic field with hints, its sources and the way to unsubscribe. */
export function digestMail(week: string, digests: DigestContent[]): { subject: Text; body: Text } {
  const parts: Text[] = [m('radar.mail.intro', { week })];
  for (const d of digests) {
    const cited = new Set(d.points.flatMap((p) => p.sources));
    parts.push('\n\n', m('radar.mail.topic', { topic: d.topic }), '\n', d.summary);
    for (const p of d.points) parts.push(`\n• ${p.text} [${p.sources.join(', ')}]`);
    parts.push('\n', m('radar.mail.sources'));
    for (const s of d.sources.filter((x) => cited.has(x.id))) parts.push(`\n[${s.id}] ${s.title} – ${s.url}`);
  }
  parts.push('\n\n', m('radar.mail.radar', { url: `${config.publicUrl}/radar` }), '\n', m('radar.mail.unsubscribe', { url: `${config.publicUrl}/konto` }));
  return { subject: m('radar.mail.subject', { week }), body: cat(parts) };
}

export interface TrendRunResult {
  week: string;
  digests: number;
  mails: number;
  suggestions: number;
}

/**
 * Weekly trend hints (R4-02): one digest per topic field with recipients (or the given topic
 * fields), one mail per person with all of their topic fields, then new suggestions for the
 * radar (R4-11). With notify = false (manual run by the innovation lead) no mail is sent.
 */
export async function runTrendDigests(ctx: Ctx, opts: { notify: boolean; topics?: string[] }): Promise<TrendRunResult> {
  const week = isoWeek(ctx.today);
  const recipients = await tx(ctx, (c) => trendRecipients(c));
  const topics = (opts.topics ?? [...recipients.keys()]).filter((t) => ctx.settings.topics.includes(t));
  const done = new Map<string, { id: string; content: DigestContent }>();
  for (const topic of topics) done.set(topic, await digestFor(ctx, topic, week));
  let mails = 0;
  if (opts.notify) {
    const perPerson = new Map<string, DigestContent[]>();
    for (const [topic, users] of recipients) {
      const d = done.get(topic);
      if (!d || !d.content.points.length) continue;
      for (const u of users) perPerson.set(u, [...(perPerson.get(u) ?? []), d.content]);
    }
    await tx(ctx, async (c) => {
      for (const [userId, list] of perPerson) {
        const mail = digestMail(week, list);
        await notifyUser(c, userId, mail.subject, mail.body, undefined, 'trends');
        mails++;
      }
      await audit(c, 'radar.trend_digest', 'tenant', c.tenantId, null, { week, topics, mails });
    });
  }
  const suggestions = done.size ? await runTrendAssignments(ctx, { digestIds: [...done.values()].map((d) => d.id) }) : 0;
  return { week, digests: done.size, mails, suggestions };
}

/** Whether the weekly run is due today and not yet queued for this week. Called by the daily job. */
export async function enqueueWeeklyTrends(ctx: Ctx): Promise<boolean> {
  const r = ctx.settings.radar;
  // Without a web search there is nothing to report: the hints need sources (ADR 0005).
  if (!r.trendHints || !ctx.settings.ai.enabled || ctx.settings.ai.search.kind === 'none' || ctx.settings.ai.agents.trend_digest?.enabled === false) return false;
  if (isoWeekday(ctx.today) < r.weekday) return false;
  const week = isoWeek(ctx.today);
  const queued = await ctx.db.query(`SELECT 1 FROM ai_jobs WHERE kind = 'trend_digest' AND params->>'week' = $1`, [week]);
  if (queued.rowCount) return false;
  if (!(await trendRecipients(ctx)).size) return false;
  const ins = await ctx.db.query(
    `INSERT INTO ai_jobs (tenant_id, kind, params) VALUES ($1, 'trend_digest', $2) ON CONFLICT DO NOTHING`,
    [ctx.tenantId, JSON.stringify({ week })],
  );
  return !!ins.rowCount;
}

/** Digests of the last weeks; the radar roles see all topic fields, sponsors their own. */
export async function listDigests(ctx: Ctx, limit = 20) {
  const all = hasRole(ctx.user, ...RADAR_VIEW);
  const r = await ctx.db.query<{ id: string; topic: string; week: string; content: DigestContent; created_at: Date }>(
    `SELECT d.id, d.topic, d.week, d.content, d.created_at FROM trend_digests d
      WHERE $1::boolean OR d.topic IN (SELECT ts.topic FROM topic_sponsors ts WHERE ts.user_id = $2)
         OR d.topic IN (SELECT c.topic FROM challenges c WHERE c.sponsor_id = $2 AND c.topic IS NOT NULL)
      ORDER BY d.week DESC, d.topic LIMIT $3`,
    [all, ctx.user!.id, limit],
  );
  return r.rows.map((d) => ({ ...d.content, warnings: relocalizeAll(ctx.locale, d.content.warnings), id: d.id, topic: d.topic, week: d.week, createdAt: d.created_at }));
}

// ---------------------------------------------------------------- radar (R4-11)

const sourceInput = z.object({ title: z.string().trim().min(1).max(200), url: z.url().max(500).refine((u) => /^https?:\/\//.test(u)) });
export const trendInput = z.object({
  title: z.string().trim().min(2).max(140),
  description: z.string().trim().max(2000).default(''),
  topic: z.string().trim().min(1).max(80),
  horizon: z.enum(HORIZONS),
  maturity: z.enum(MATURITIES),
  sources: z.array(sourceInput).max(20).default([]),
});
export const trendUpdate = trendInput.partial();
export const adoptInput = z.object({ index: z.number().int().min(0).max(10), horizon: z.enum(HORIZONS), maturity: z.enum(MATURITIES) });

interface TrendRow {
  id: string;
  title: string;
  description: string;
  topic: string;
  horizon: string;
  maturity: string;
  origin: string;
  sources: { title: string; url: string }[];
}

async function loadTrend(ctx: Ctx, id: string, forUpdate = false): Promise<TrendRow> {
  if (!z.uuid().safeParse(id).success) throw notFound(m('radar.trendNotFound'));
  const r = await ctx.db.query<TrendRow>(`SELECT * FROM trend_items WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  if (!r.rows[0]) throw notFound(m('radar.trendNotFound'));
  return r.rows[0];
}

const checkTopic = (ctx: Ctx, topic: string) => {
  if (!ctx.settings.topics.includes(topic)) throw badRequest(m('misc.unknownTopic'));
};

/** The radar with its elements, the visible linked ideas and the open suggestions. */
export async function radarView(ctx: Ctx) {
  const params = [ctx.user!.id, isTriageEverywhere(ctx.user)];
  const items = await ctx.db.query<TrendRow & { created_at: Date; updated_at: Date }>('SELECT * FROM trend_items ORDER BY topic, horizon, title');
  const links = await ctx.db.query<{ trend_id: string; id: string; number: number; title: string; status: string }>(
    `SELECT l.trend_id, i.id, i.number, i.title, i.status FROM trend_links l JOIN ideas i ON i.id = l.idea_id
      WHERE ${VISIBLE_SQL} ORDER BY i.number`,
    params,
  );
  const suggestions = canManage(ctx)
    ? (await ctx.db.query<{ id: string; trend_id: string; kind: string; reason: string; source: { title: string; url: string; snippet: string } | null; idea_id: string | null; number: number | null; title: string | null }>(
      `SELECT s.id, s.trend_id, s.kind, s.reason, s.source, s.idea_id, i.number, i.title FROM trend_suggestions s
         LEFT JOIN ideas i ON i.id = s.idea_id
        WHERE s.status = 'open' AND (s.kind = 'web' OR ${VISIBLE_SQL})
        ORDER BY s.created_at`,
      params,
    )).rows
    : [];
  return {
    topics: ctx.settings.topics,
    horizons: HORIZONS,
    maturities: MATURITIES,
    canManage: canManage(ctx),
    items: items.rows.map((t) => ({
      id: t.id, title: t.title, description: t.description, topic: t.topic, horizon: t.horizon, maturity: t.maturity, origin: t.origin,
      sources: t.sources, updatedAt: t.updated_at,
      ideas: links.rows.filter((l) => l.trend_id === t.id).map(({ id, number, title, status }) => ({ id, number, title, status })),
      suggestions: suggestions.filter((s) => s.trend_id === t.id).map((s) => ({
        id: s.id, kind: s.kind, reason: s.reason,
        idea: s.kind === 'idea' ? { id: s.idea_id, number: s.number, title: s.title } : null,
        source: s.kind === 'web' ? s.source : null,
      })),
    })),
  };
}

export async function createTrend(ctx: Ctx, input: z.infer<typeof trendInput>, origin: { digestId: string } | null = null): Promise<{ id: string }> {
  requireManage(ctx);
  checkTopic(ctx, input.topic);
  const r = await ctx.db.query<{ id: string }>(
    `INSERT INTO trend_items (tenant_id, title, description, topic, horizon, maturity, origin, digest_id, sources, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [ctx.tenantId, input.title, input.description, input.topic, input.horizon, input.maturity, origin ? 'digest' : 'manual', origin?.digestId ?? null,
     JSON.stringify(input.sources), ctx.user!.id],
  );
  await audit(ctx, 'radar.trend_create', 'trend', r.rows[0].id, null, { ...input, origin: origin ? 'digest' : 'manual' });
  return { id: r.rows[0].id };
}

export async function updateTrend(ctx: Ctx, id: string, input: z.infer<typeof trendUpdate>): Promise<void> {
  requireManage(ctx);
  const t = await loadTrend(ctx, id, true);
  if (input.topic) checkTopic(ctx, input.topic);
  const next = {
    title: input.title ?? t.title, description: input.description ?? t.description, topic: input.topic ?? t.topic,
    horizon: input.horizon ?? t.horizon, maturity: input.maturity ?? t.maturity, sources: input.sources ?? t.sources,
  };
  await ctx.db.query(
    'UPDATE trend_items SET title = $2, description = $3, topic = $4, horizon = $5, maturity = $6, sources = $7, updated_at = now() WHERE id = $1',
    [id, next.title, next.description, next.topic, next.horizon, next.maturity, JSON.stringify(next.sources)],
  );
  await audit(ctx, 'radar.trend_update', 'trend', id, t, next);
}

export async function deleteTrend(ctx: Ctx, id: string): Promise<void> {
  requireManage(ctx);
  const t = await loadTrend(ctx, id, true);
  await ctx.db.query('DELETE FROM trend_items WHERE id = $1', [id]);
  await audit(ctx, 'radar.trend_delete', 'trend', id, { title: t.title, topic: t.topic }, null);
}

/** A trend from a candidate of a weekly digest ("Elemente aus R4-02"). */
export async function adoptCandidate(ctx: Ctx, digestId: string, input: z.infer<typeof adoptInput>) {
  requireManage(ctx);
  if (!z.uuid().safeParse(digestId).success) throw notFound(m('radar.digestNotFound'));
  const d = (await ctx.db.query<{ id: string; topic: string; content: DigestContent }>('SELECT id, topic, content FROM trend_digests WHERE id = $1 FOR UPDATE', [digestId])).rows[0];
  if (!d) throw notFound(m('radar.digestNotFound'));
  const cand = d.content.candidates[input.index];
  if (!cand) throw notFound(m('radar.candidateNotFound'));
  if (d.content.adopted?.includes(input.index)) throw conflict(m('radar.candidateAdopted'));
  const sources = d.content.sources.filter((s) => cand.sources.includes(s.id)).map((s) => ({ title: s.title.slice(0, 200), url: s.url }));
  const created = await createTrend(ctx, trendInput.parse({ title: cand.title, description: cand.description, topic: d.topic, horizon: input.horizon, maturity: input.maturity, sources }), { digestId: d.id });
  await ctx.db.query('UPDATE trend_digests SET content = $2 WHERE id = $1', [d.id, JSON.stringify({ ...d.content, adopted: [...(d.content.adopted ?? []), input.index] })]);
  return created;
}

async function requireVisibleIdea(ctx: Ctx, ideaId: string): Promise<{ id: string }> {
  if (!z.uuid().safeParse(ideaId).success) throw notFound(m('workflow.ideaNotFound'));
  const r = await ctx.db.query<{ id: string }>(
    `SELECT i.id FROM ideas i WHERE i.id = $3 AND i.status NOT IN ('draft', 'merged') AND ${VISIBLE_SQL}`,
    [ctx.user!.id, isTriageEverywhere(ctx.user), ideaId],
  );
  if (!r.rows[0]) throw notFound(m('workflow.ideaNotFound'));
  return r.rows[0];
}

export async function linkIdea(ctx: Ctx, trendId: string, ideaId: string): Promise<void> {
  requireManage(ctx);
  const t = await loadTrend(ctx, trendId);
  const idea = await requireVisibleIdea(ctx, ideaId);
  await ctx.db.query('INSERT INTO trend_links (tenant_id, trend_id, idea_id, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [ctx.tenantId, t.id, idea.id, ctx.user!.id]);
  await ctx.db.query(`UPDATE trend_suggestions SET status = 'accepted', decided_by = $3, decided_at = now() WHERE trend_id = $1 AND idea_id = $2 AND status = 'open'`, [t.id, idea.id, ctx.user!.id]);
  await audit(ctx, 'radar.link', 'trend', t.id, null, { ideaId: idea.id });
}

export async function unlinkIdea(ctx: Ctx, trendId: string, ideaId: string): Promise<void> {
  requireManage(ctx);
  const t = await loadTrend(ctx, trendId);
  await ctx.db.query('DELETE FROM trend_links WHERE trend_id = $1 AND idea_id = $2', [t.id, ideaId]);
  await audit(ctx, 'radar.unlink', 'trend', t.id, { ideaId }, null);
}

/** Trends linked to one idea (for the idea page); only for people who see the idea. */
export async function trendsOfIdea(ctx: Ctx, ideaId: string) {
  await requireVisibleIdea(ctx, ideaId);
  const r = await ctx.db.query(
    `SELECT t.id, t.title, t.topic, t.horizon, t.maturity FROM trend_links l JOIN trend_items t ON t.id = l.trend_id WHERE l.idea_id = $1 ORDER BY t.title`,
    [ideaId],
  );
  return r.rows;
}

export async function decideSuggestion(ctx: Ctx, id: string, accept: boolean): Promise<void> {
  requireManage(ctx);
  if (!z.uuid().safeParse(id).success) throw notFound(m('radar.suggestionNotFound'));
  const s = (await ctx.db.query<{ id: string; trend_id: string; kind: string; idea_id: string | null; source: { title: string; url: string } | null; status: string }>(
    'SELECT id, trend_id, kind, idea_id, source, status FROM trend_suggestions WHERE id = $1 FOR UPDATE', [id],
  )).rows[0];
  if (!s) throw notFound(m('radar.suggestionNotFound'));
  if (s.status !== 'open') throw conflict(m('radar.suggestionDecided'));
  if (accept && s.kind === 'idea') {
    await linkIdea(ctx, s.trend_id, s.idea_id!);
  } else if (accept && s.source) {
    const t = await loadTrend(ctx, s.trend_id, true);
    if (!t.sources.some((x) => x.url === s.source!.url)) {
      await ctx.db.query('UPDATE trend_items SET sources = $2, updated_at = now() WHERE id = $1', [t.id, JSON.stringify([...t.sources, { title: s.source.title.slice(0, 200), url: s.source.url }].slice(-20))]);
    }
  }
  await ctx.db.query('UPDATE trend_suggestions SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1', [id, accept ? 'accepted' : 'dismissed', ctx.user!.id]);
  await audit(ctx, accept ? 'radar.suggestion_accept' : 'radar.suggestion_dismiss', 'trend', s.trend_id, null, { suggestion: id, kind: s.kind, ideaId: s.idea_id, url: s.source?.url ?? null });
}

/**
 * AI suggestions which signals belong to which trend (R4-11). Signals are the web hits of the
 * given (or the last two weeks') digests and recent non-confidential ideas; no other signal
 * source exists. `ctx` is detached.
 */
export async function runTrendAssignments(ctx: Ctx, opts: { digestIds?: string[] } = {}): Promise<number> {
  const data = await tx(ctx, async (c) => {
    const trends = (await c.db.query<{ id: string; title: string; description: string; topic: string }>(
      'SELECT id, title, description, topic FROM trend_items ORDER BY updated_at DESC LIMIT 100',
    )).rows;
    if (!trends.length) return null;
    const digests = (await c.db.query<{ id: string; content: DigestContent }>(
      opts.digestIds?.length
        ? 'SELECT id, content FROM trend_digests WHERE id = ANY($1::uuid[])'
        : `SELECT id, content FROM trend_digests WHERE created_at > now() - interval '14 days' AND $1::uuid[] IS NOT NULL`,
      [opts.digestIds ?? []],
    )).rows;
    // Confidential ideas, drafts and possible inventions never become signals.
    const ideas = (await c.db.query<{ id: string; title: string; problem: string }>(
      `SELECT id, title, problem FROM ideas
        WHERE status NOT IN ('draft', 'merged') AND NOT confidential AND coalesce(invention_check, '') <> 'possible'
        ORDER BY coalesce(submitted_at, created_at) DESC LIMIT 60`,
    )).rows;
    return { trends, digests, ideas };
  });
  if (!data) return 0;
  const signals: RadarSignal[] = [
    ...data.ideas.map((i) => ({ ref: `idea:${i.id}`, title: i.title, text: i.problem })),
    ...data.digests.flatMap((d) => d.content.sources.slice(0, 15).map((s) => ({ ref: `web:${d.id}:${s.id}`, title: s.title, text: s.snippet }))),
  ].slice(0, 120);
  if (!signals.length) return 0;
  const run = await runAgent(ctx, trendAssignCall(data.trends, signals));
  const trendIds = new Set(data.trends.map((t) => t.id));
  const digestById = new Map(data.digests.map((d) => [d.id, d]));
  const ideaIds = new Set(data.ideas.map((i) => i.id));
  return tx(ctx, async (c) => {
    let n = 0;
    for (const a of run.output.assignments) {
      if (!trendIds.has(a.trend)) continue;
      const reason = a.reason.slice(0, 300);
      if (a.signal.startsWith('idea:')) {
        const ideaId = a.signal.slice(5);
        if (!ideaIds.has(ideaId)) continue;
        const r = await c.db.query(
          `INSERT INTO trend_suggestions (tenant_id, trend_id, kind, idea_id, reason, ai_action_id)
           SELECT $1, $2, 'idea', $3, $4, $5 WHERE NOT EXISTS (SELECT 1 FROM trend_links l WHERE l.trend_id = $2 AND l.idea_id = $3)
           ON CONFLICT DO NOTHING`,
          [c.tenantId, a.trend, ideaId, reason, run.actionId],
        );
        n += r.rowCount ?? 0;
      } else if (a.signal.startsWith('web:')) {
        const [, digestId, sourceId] = a.signal.split(':');
        const d = digestById.get(digestId);
        const s = d?.content.sources.find((x) => String(x.id) === sourceId);
        if (!d || !s) continue;
        const r = await c.db.query(
          `INSERT INTO trend_suggestions (tenant_id, trend_id, kind, digest_id, source, reason, ai_action_id)
           VALUES ($1, $2, 'web', $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
          [c.tenantId, a.trend, d.id, JSON.stringify({ title: s.title, url: s.url, snippet: s.snippet.slice(0, 300) }), reason, run.actionId],
        );
        n += r.rowCount ?? 0;
      }
    }
    return n;
  });
}

// ---------------------------------------------------------------- white spots (R4-03)

/** Topic fields compared against ideas: a white spot has no idea in the last n months. Counts only. */
export async function whiteSpots(ctx: Ctx) {
  const months = ctx.settings.radar.whiteSpotMonths;
  const since = new Date(`${ctx.today}T12:00:00Z`);
  since.setUTCMonth(since.getUTCMonth() - months);
  const from = since.toISOString().slice(0, 10);
  const ideas = await ctx.db.query<{ topic: string | null; total: number; recent: number }>(
    `SELECT topic, count(*)::int AS total, count(*) FILTER (WHERE coalesce(submitted_at, created_at)::date >= $1::date)::int AS recent
       FROM ideas WHERE status NOT IN ('draft', 'merged') GROUP BY topic`,
    [from],
  );
  const challenges = await ctx.db.query<{ topic: string; n: number }>(
    'SELECT topic, count(*)::int AS n FROM challenges WHERE topic IS NOT NULL AND starts_on <= $1 AND ends_on >= $1 GROUP BY topic',
    [ctx.today],
  );
  const trends = await ctx.db.query<{ topic: string; n: number }>('SELECT topic, count(*)::int AS n FROM trend_items GROUP BY topic');
  const get = <T extends { topic: string | null }>(rows: T[], topic: string) => rows.find((r) => r.topic === topic);
  const topics = ctx.settings.topics.map((topic) => {
    const i = get(ideas.rows, topic);
    const recent = i?.recent ?? 0;
    return {
      topic,
      ideas: i?.total ?? 0,
      recentIdeas: recent,
      activeChallenges: get(challenges.rows, topic)?.n ?? 0,
      trends: get(trends.rows, topic)?.n ?? 0,
      whiteSpot: recent === 0,
    };
  });
  const other = ideas.rows.filter((r) => !r.topic || !ctx.settings.topics.includes(r.topic)).reduce((s, r) => s + r.recent, 0);
  return { months, since: from, topics, withoutTopic: other, whiteSpots: topics.filter((t) => t.whiteSpot).length };
}

// ---------------------------------------------------------------- problem radar (R4-01)

const identifier = z.string().trim().max(500);
export const problemSourceInput = z.object({
  connectorId: z.uuid(),
  name: z.string().trim().min(2).max(80),
  query: identifier.default(''),
  tableName: z.string().trim().max(80).regex(/^([a-z][a-z0-9_]{1,79})?$/).default(''),
});
export const csvInput = z.object({ name: z.string().trim().min(2).max(80), csv: z.string().min(1).max(2_000_000) });
export const clusterChallengeInput = z.object({
  title: z.string().trim().min(3).max(140),
  question: z.string().trim().min(10).max(3000),
  topic: z.string().trim().max(80).nullable().optional(),
  endsOn: z.iso.date(),
});
export const clusterProblemInput = z.object({
  title: z.string().trim().min(3).max(140).optional(),
  topic: z.string().trim().max(80).nullable().optional(),
});

export async function problemRadarView(ctx: Ctx) {
  const connectors = hasFeature(ctx, 'connectors')
    ? (await ctx.db.query('SELECT id, name, kind FROM connectors WHERE enabled ORDER BY name')).rows
    : [];
  const sources = (await ctx.db.query(
    `SELECT s.id, s.name, s.query, s.table_name AS "tableName", c.id AS "connectorId", c.name AS "connectorName", c.kind, c.enabled
       FROM problem_sources s JOIN connectors c ON c.id = s.connector_id ORDER BY s.name`,
  )).rows;
  const runs = (await ctx.db.query<{ id: string; source_kind: string; source_name: string; items: number; min_cluster_size: number; created_at: Date }>(
    'SELECT id, source_kind, source_name, items, min_cluster_size, created_at FROM problem_runs ORDER BY created_at DESC LIMIT 10',
  )).rows;
  const clusters = runs.length
    ? (await ctx.db.query<{ id: string; run_id: string; label: string; summary: string; frequency: number; examples: string[]; idea_id: string | null; challenge_id: string | null; dismissed: boolean }>(
      'SELECT id, run_id, label, summary, frequency, examples, idea_id, challenge_id, dismissed FROM problem_clusters WHERE run_id = ANY($1::uuid[]) ORDER BY frequency DESC, label',
      [runs.map((r) => r.id)],
    )).rows
    : [];
  return {
    feature: hasFeature(ctx, 'connectors'),
    minClusterSize: ctx.settings.radar.minClusterSize,
    maxTickets: ctx.settings.radar.maxTickets,
    ticketDays: ctx.settings.radar.ticketDays,
    connectors,
    sources,
    runs: runs.map((r) => ({
      id: r.id, sourceKind: r.source_kind, sourceName: r.source_name, items: r.items, minClusterSize: r.min_cluster_size, createdAt: r.created_at,
      clusters: clusters.filter((c) => c.run_id === r.id).map((c) => ({
        id: c.id, label: c.label, summary: c.summary, frequency: c.frequency, examples: c.examples, ideaId: c.idea_id, challengeId: c.challenge_id, dismissed: c.dismissed,
      })),
    })),
  };
}

export async function createProblemSource(ctx: Ctx, input: z.infer<typeof problemSourceInput>): Promise<{ id: string }> {
  requireFeature(ctx, 'connectors');
  const c = (await ctx.db.query<{ id: string; kind: string }>('SELECT id, kind FROM connectors WHERE id = $1', [input.connectorId])).rows[0];
  if (!c) throw notFound(m('conn.notFound'));
  if (c.kind === 'azure_devops' && input.query && !/^[A-Za-z0-9 _.-]{1,80}$/.test(input.query)) throw badRequest(m('radar.source.adoType'));
  const r = await ctx.db.query<{ id: string }>(
    'INSERT INTO problem_sources (tenant_id, connector_id, name, query, table_name, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [ctx.tenantId, c.id, input.name, input.query, c.kind === 'servicenow' ? input.tableName || 'incident' : '', ctx.user!.id],
  );
  await audit(ctx, 'radar.source_create', 'problem_source', r.rows[0].id, null, input);
  return { id: r.rows[0].id };
}

export async function deleteProblemSource(ctx: Ctx, id: string): Promise<void> {
  if (!z.uuid().safeParse(id).success) throw notFound(m('radar.sourceNotFound'));
  const r = await ctx.db.query<{ name: string }>('DELETE FROM problem_sources WHERE id = $1 RETURNING name', [id]);
  if (!r.rows[0]) throw notFound(m('radar.sourceNotFound'));
  await audit(ctx, 'radar.source_delete', 'problem_source', id, { name: r.rows[0].name }, null);
}

interface RawItem {
  title: string;
  description: string;
}

/**
 * Clusters tickets or feedback (R4-01): person fields never arrive here, names and contact data
 * are removed before the model (local only) sees the text, groups smaller than the minimum
 * size are dropped and the stored examples are redacted again. `ctx` is detached.
 */
async function clusterItems(ctx: Ctx, raw: RawItem[], source: { kind: 'connector' | 'csv'; id: string | null; name: string }) {
  const minSize = ctx.settings.radar.minClusterSize;
  const names = await tx(ctx, (c) => peopleNames(c));
  const items = raw
    .slice(0, ctx.settings.radar.maxTickets)
    .map((r) => redactPersonal(`${r.title.trim()}${r.title.trim() && r.description.trim() ? '. ' : ''}${r.description.trim()}`, names).slice(0, 1000))
    .filter((t) => t.replaceAll(PLACEHOLDER, '').trim().length >= 3)
    .map((text, i) => ({ ref: String(i + 1), text }));
  let clusters: { label: string; summary: string; frequency: number; examples: string[] }[] = [];
  let actionId: string | null = null;
  if (items.length >= minSize) {
    const run = await runAgent(ctx, problemClustersCall(items, minSize));
    actionId = run.actionId;
    const byRef = new Map(items.map((i) => [i.ref, i]));
    const used = new Set<string>();
    for (const c of run.output.clusters) {
      const members = [...new Set(c.items)].filter((r) => byRef.has(r) && !used.has(r));
      if (members.length < minSize) continue;
      members.forEach((r) => used.add(r));
      clusters.push({
        label: redactPersonal(c.label, names).slice(0, 120) || '–',
        summary: redactPersonal(c.summary, names).slice(0, 600),
        frequency: members.length,
        examples: members.slice(0, 3).map((r) => redactPersonal(byRef.get(r)!.text, names).slice(0, 240)),
      });
    }
    clusters = clusters.sort((a, b) => b.frequency - a.frequency);
  }
  return tx(ctx, async (c) => {
    const runId = (await c.db.query<{ id: string }>(
      `INSERT INTO problem_runs (tenant_id, source_id, source_kind, source_name, items, min_cluster_size, ai_action_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [c.tenantId, source.id, source.kind, source.name, items.length, minSize, actionId, c.user?.id ?? null],
    )).rows[0].id;
    for (const cl of clusters) {
      await c.db.query(
        'INSERT INTO problem_clusters (tenant_id, run_id, label, summary, frequency, examples) VALUES ($1, $2, $3, $4, $5, $6)',
        [c.tenantId, runId, cl.label, cl.summary, cl.frequency, JSON.stringify(cl.examples)],
      );
    }
    await audit(c, 'radar.problem_run', 'problem_run', runId, null, { source: source.name, kind: source.kind, items: items.length, clusters: clusters.length });
    return { id: runId, items: items.length, clusters: clusters.length };
  });
}

/** Tickets of a connector source (needs the connectors feature of the package). `ctx` is detached. */
export async function runConnectorSource(ctx: Ctx, sourceId: string) {
  requireFeature(ctx, 'connectors');
  if (!z.uuid().safeParse(sourceId).success) throw notFound(m('radar.sourceNotFound'));
  const r = ctx.settings.radar;
  const { src, tickets } = await tx(ctx, async (c) => {
    const s = (await c.db.query<{ id: string; name: string; connector_id: string; query: string; table_name: string }>('SELECT * FROM problem_sources WHERE id = $1', [sourceId])).rows[0];
    if (!s) throw notFound(m('radar.sourceNotFound'));
    return { src: s, tickets: await fetchTickets(c, s.connector_id, { query: s.query, table: s.table_name, days: r.ticketDays, max: r.maxTickets }) };
  });
  return clusterItems(ctx, tickets, { kind: 'connector', id: src.id, name: src.name });
}

const TITLE_HEADERS = ['title', 'titel', 'subject', 'betreff', 'summary', 'kurzbeschreibung', 'short_description', 'überschrift'];
const TEXT_HEADERS = ['text', 'description', 'beschreibung', 'feedback', 'kommentar', 'comment', 'nachricht', 'message', 'inhalt', 'body', 'problem', 'beschwerde', 'complaint'];

/** Title and text columns of an uploaded CSV; every other column (names, e-mail, customer number) is ignored. */
export function feedbackRows(csv: string): RawItem[] {
  const rows = parseCsv(csv).filter((r) => r.some((c) => c.trim()));
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const titleCol = head.findIndex((h) => TITLE_HEADERS.includes(h));
  const textCol = head.findIndex((h) => TEXT_HEADERS.includes(h));
  if (titleCol < 0 && textCol < 0) {
    // Without a known header only a file with a single column is read (as text).
    if (rows.every((r) => r.length === 1)) return rows.map((r) => ({ title: '', description: r[0] }));
    throw badRequest(m('radar.csv.columns'));
  }
  return rows.slice(1).map((r) => ({ title: titleCol >= 0 ? r[titleCol] ?? '' : '', description: textCol >= 0 ? r[textCol] ?? '' : '' }));
}

export async function runCsv(ctx: Ctx, input: z.infer<typeof csvInput>) {
  const rows = feedbackRows(input.csv);
  if (!rows.length) throw badRequest(m('radar.csv.empty'));
  return clusterItems(ctx, rows, { kind: 'csv', id: null, name: input.name });
}

interface ClusterRow {
  id: string;
  label: string;
  summary: string;
  frequency: number;
  examples: string[];
  idea_id: string | null;
  challenge_id: string | null;
}

async function loadCluster(ctx: Ctx, id: string): Promise<ClusterRow> {
  if (!z.uuid().safeParse(id).success) throw notFound(m('radar.clusterNotFound'));
  const r = await ctx.db.query<ClusterRow>('SELECT * FROM problem_clusters WHERE id = $1 FOR UPDATE', [id]);
  if (!r.rows[0]) throw notFound(m('radar.clusterNotFound'));
  return r.rows[0];
}

/** A cluster becomes a problem (R3-31) as a draft of the person; they check and submit it. */
export async function clusterToProblem(ctx: Ctx, id: string, input: z.infer<typeof clusterProblemInput>): Promise<{ ideaId: string }> {
  requireManage(ctx);
  const c = await loadCluster(ctx, id);
  if (c.idea_id || c.challenge_id) throw conflict(m('radar.clusterUsed'));
  if (input.topic) checkTopic(ctx, input.topic);
  const l = ctx.locale;
  const problem = [c.summary, tr(l, m('radar.cluster.frequency', { n: c.frequency })), ...c.examples.map((e) => `• ${e}`)].filter(Boolean).join('\n').slice(0, 5000);
  const title = (input.title ?? c.label).slice(0, 140);
  const idea = await createIdea(ctx, ideaInput.parse({ title: title.length >= 3 ? title : tr(l, m('radar.cluster.untitled')), problem, topic: input.topic ?? null, ideaKind: 'problem' }));
  await ctx.db.query('UPDATE problem_clusters SET idea_id = $2 WHERE id = $1', [c.id, idea.id]);
  await audit(ctx, 'radar.cluster_problem', 'problem_cluster', c.id, null, { ideaId: idea.id });
  return { ideaId: idea.id };
}

/** A cluster becomes a challenge; the person is its sponsor. */
export async function clusterToChallenge(ctx: Ctx, id: string, input: z.infer<typeof clusterChallengeInput>): Promise<{ challengeId: string }> {
  requireManage(ctx);
  const c = await loadCluster(ctx, id);
  if (c.idea_id || c.challenge_id) throw conflict(m('radar.clusterUsed'));
  if (input.topic) checkTopic(ctx, input.topic);
  if (input.endsOn < ctx.today) throw badRequest(m('misc.endBeforeStart'));
  // Challenge package (R3-39): the limit of POST /api/challenges applies here too.
  const max = ctx.plan?.maxChallenges;
  if (max != null) {
    const n = (await ctx.db.query<{ n: number }>('SELECT count(*)::int AS n FROM challenges WHERE created_at >= $1::date', [ctx.plan?.startsOn ?? '1970-01-01'])).rows[0].n;
    if (n >= max) throw new HttpError(403, m('billing.challengeLimit', { max }), 'PLAN_LIMIT');
  }
  const r = await ctx.db.query<{ id: string }>(
    `INSERT INTO challenges (tenant_id, title, question, topic, contact, sponsor_id, starts_on, ends_on)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [ctx.tenantId, input.title, input.question, input.topic ?? null, ctx.user!.displayName, ctx.user!.id, ctx.today, input.endsOn],
  );
  await ctx.db.query('UPDATE problem_clusters SET challenge_id = $2 WHERE id = $1', [c.id, r.rows[0].id]);
  await audit(ctx, 'challenge.create', 'challenge', r.rows[0].id, null, { fromCluster: c.id, title: input.title });
  return { challengeId: r.rows[0].id };
}

export async function dismissCluster(ctx: Ctx, id: string): Promise<void> {
  requireManage(ctx);
  const c = await loadCluster(ctx, id);
  await ctx.db.query('UPDATE problem_clusters SET dismissed = true WHERE id = $1', [c.id]);
  await audit(ctx, 'radar.cluster_dismiss', 'problem_cluster', c.id, null, null);
}
