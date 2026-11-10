import { config } from '../config.js';
import { m, refText } from '../i18n/index.js';
import type { Ctx } from '../lib/context.js';
import type { Source } from './content.js';
import { assertAllowedUrl, providerFetch, ProviderError } from './providers.js';
import { getSecret } from './secrets.js';

// Research tools for the agents: internal idea search and web search (R2-14, R2-22, R2-24).
// Web queries are built by code from the idea, never by the model, and are anonymised
// before they leave the house.

export interface WebHit {
  title: string;
  url: string;
  snippet: string;
}

const STOPWORDS = new Set(
  ('der die das und oder aber ein eine einer eines einem einen den dem des mit für fuer von vom zu zum zur im in am an auf aus bei ' +
    'nach über ueber unter vor durch ohne gegen um als wie wenn dass daß weil damit so auch noch nur schon sehr mehr weniger ' +
    'wir ihr sie er es ich du man unser unsere unseren unserem jeder jede jedes alle viele wird werden wurde wurden ist sind war ' +
    'hat haben hatte kann können koennen soll sollen muss müssen sich nicht kein keine keinen dann denn doch da hier dort ' +
    'etwa pro tag woche monat jahr bitte idee ideen neue neuen neues neuer besser einfach schnell soll sollte würde wuerde könnte').split(' '),
);

export function keywords(text: string, max = 6): string[] {
  const counts = new Map<string, number>();
  for (const w of text.toLowerCase().match(/\p{L}[\p{L}-]{3,}/gu) ?? []) {
    if (STOPWORDS.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, max).map(([w]) => w);
}

/**
 * Removes personal and company references from a search query (R2-14): e-mail addresses,
 * URLs, phone numbers, names of people in the workspace, the workspace name and the
 * configured internal terms.
 */
export function anonymizeQuery(query: string, blocked: string[]): string {
  return anonymizeQueryCounted(query, blocked).query;
}

/** Like anonymizeQuery, and counts what was removed (e-mail, link, phone number, name or internal term). */
export function anonymizeQueryCounted(query: string, blocked: string[]): { query: string; removed: number } {
  let removed = 0;
  const count = (re: RegExp) => (s: string) => s.replace(re, () => (removed++, ' '));
  let q = [count(/\S+@\S+/g), count(/https?:\/\/\S+/g), count(/\+?\d[\d\s/-]{6,}\d/g)].reduce((s, f) => f(s), query);
  const terms = blocked
    // Parts of names too: "erika.mustermann" also blocks "erika" and "mustermann".
    .flatMap((t) => [t, ...t.split(/[\s._@-]+/)])
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .sort((a, b) => b.length - a.length);
  for (const t of terms) {
    q = q.replace(new RegExp(`(^|[^\\p{L}])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'giu'), (_m, pre: string) => (removed++, `${pre} `));
  }
  return { query: q.replace(/\s+/g, ' ').trim(), removed };
}

/** Names that must never appear in a web query for this tenant. */
export async function blockedTerms(ctx: Ctx): Promise<string[]> {
  const people = await ctx.db.query<{ display_name: string; email: string }>('SELECT display_name, email FROM users');
  const tenant = await ctx.db.query<{ name: string; slug: string }>('SELECT name, slug FROM tenants WHERE id = $1', [ctx.tenantId]);
  const names = people.rows.flatMap((p) => [p.display_name, p.email.split('@')[0], p.email.split('@')[1]?.split('.')[0] ?? '']);
  return [...names, tenant.rows[0]?.name ?? '', tenant.rows[0]?.slug ?? '', ...ctx.settings.ai.internalTerms].filter(Boolean);
}

async function searchKey(ctx: Ctx): Promise<string | null> {
  return (await getSecret(ctx, 'search')) ?? config.braveApiKey ?? null;
}

async function braveSearch(apiKey: string, q: string, count: number): Promise<WebHit[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', q);
  url.searchParams.set('count', String(count));
  url.searchParams.set('search_lang', 'de');
  const res = await fetch(url, { headers: { accept: 'application/json', 'x-subscription-token': apiKey }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new ProviderError(m('aigw.err.searchError', { status: res.status }), res.status >= 500 || res.status === 429);
  const data = (await res.json()) as { web?: { results?: { title: string; url: string; description?: string }[] } };
  return (data.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: (r.description ?? '').replace(/<[^>]+>/g, '') }));
}

async function searxngSearch(baseUrl: string, q: string, count: number): Promise<WebHit[]> {
  const url = await assertAllowedUrl(`${baseUrl.replace(/\/+$/, '')}/search`);
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'json');
  url.searchParams.set('language', 'de');
  // Pinned to the checked address (DNS rebinding).
  const res = await providerFetch(url, { signal: AbortSignal.timeout(20_000), redirect: 'error' });
  if (!res.ok) throw new ProviderError(m('aigw.err.searchError', { status: res.status }), res.status >= 500);
  const data = (await res.json()) as { results?: { title: string; url: string; content?: string }[] };
  return (data.results ?? []).slice(0, count).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? '' }));
}

export type WebSearchFn = (ctx: Ctx, query: string, count: number) => Promise<WebHit[]>;

const defaultWebSearch: WebSearchFn = async (ctx, query, count) => {
  const s = ctx.settings.ai.search;
  if (s.kind === 'brave') {
    const key = await searchKey(ctx);
    if (!key) throw new ProviderError(m('aigw.err.searchNoKey'));
    return braveSearch(key, query, count);
  }
  if (s.kind === 'searxng') return searxngSearch(s.baseUrl, query, count);
  return [];
};

let webSearchImpl: WebSearchFn = defaultWebSearch;

/** Tests replace the search backend; production always uses the configured provider. */
export function setWebSearch(fn: WebSearchFn | null): void {
  webSearchImpl = fn ?? defaultWebSearch;
}

export async function monthlySearchCost(ctx: Ctx): Promise<number> {
  const r = await ctx.db.query<{ n: number }>(
    `SELECT coalesce(sum(search_queries), 0)::int AS n FROM ai_actions WHERE created_at >= date_trunc('month', $1::date)`,
    [ctx.today],
  );
  return r.rows[0].n * ctx.settings.ai.search.costPerQueryEur;
}

export interface ResearchQuery {
  query: string;
  origin: 'web' | 'patent';
}

export interface ResearchResult {
  sources: Source[];
  queries: string[];
  /** Number of removed terms per sent query (privacy proof, R2-42). */
  removed: number[];
  warnings: string[];
}

/** Runs the web queries of one analysis within the search budget. */
export async function webResearch(ctx: Ctx, queries: ResearchQuery[], firstId: number, opts: { confidential: boolean }): Promise<ResearchResult> {
  const s = ctx.settings.ai.search;
  const warnings: string[] = [];
  if (opts.confidential) return { sources: [], queries: [], removed: [], warnings: [refText('aigw.warn.confidentialNoSearch')] };
  if (s.kind === 'none') return { sources: [], queries: [], removed: [], warnings: [refText('aigw.warn.noSearch')] };
  const blocked = await blockedTerms(ctx);
  let budgetLeft = s.perMonthEur - (await monthlySearchCost(ctx));
  const sources: Source[] = [];
  const used: string[] = [];
  const removed: number[] = [];
  const seen = new Set<string>();
  let id = firstId;
  for (const q of queries.slice(0, s.maxQueriesPerRun)) {
    if (budgetLeft < s.costPerQueryEur) {
      warnings.push(refText('aigw.warn.searchBudget'));
      break;
    }
    const { query: base, removed: n } = anonymizeQueryCounted(q.query, blocked);
    if (base.split(' ').length < 2) continue;
    const query = q.origin === 'patent' ? `${base} site:patents.google.com` : base;
    try {
      const hits = await webSearchImpl(ctx, query, 5);
      used.push(query);
      removed.push(n);
      budgetLeft -= s.costPerQueryEur;
      for (const h of hits) {
        if (seen.has(h.url)) continue;
        seen.add(h.url);
        sources.push({ id: id++, title: h.title.slice(0, 200), url: h.url, snippet: h.snippet.slice(0, 500), origin: q.origin, retrievedAt: ctx.today });
      }
    } catch (err) {
      warnings.push(err instanceof ProviderError ? err.message : refText('aigw.warn.searchFailed'));
      break;
    }
  }
  return { sources, queries: used, removed, warnings };
}

/** Similar ideas in the same workspace (internal research, duplicates). Confidential ideas stay out. */
export async function internalResearch(ctx: Ctx, idea: { id?: string; title: string; problem: string; solution: string }, firstId: number, limit = 5): Promise<Source[]> {
  const text = `${idea.title} ${idea.problem} ${idea.solution}`.slice(0, 2000);
  const r = await ctx.db.query<{ id: string; number: number; title: string; problem: string; status: string }>(
    `SELECT id, number, title, problem, status FROM ideas
      WHERE status NOT IN ('draft', 'merged') AND NOT confidential AND id IS DISTINCT FROM $2::uuid
        AND similarity(title || ' ' || problem || ' ' || solution, $1) > 0.08
      ORDER BY similarity(title || ' ' || problem || ' ' || solution, $1) DESC LIMIT $3`,
    [text, idea.id ?? null, limit],
  );
  return r.rows.map((x, i) => ({
    id: firstId + i,
    title: `Idee #${x.number}: ${x.title}`,
    url: `/ideen/${x.id}`,
    snippet: x.problem.slice(0, 300),
    origin: 'internal' as const,
    retrievedAt: ctx.today,
  }));
}
