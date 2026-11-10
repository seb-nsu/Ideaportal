import { config } from '../config.js';
import type { Ctx } from '../lib/context.js';
import type { Section, Source, SourceCheck } from './content.js';
import { stripInjections } from './content.js';
import { logAction } from './gateway.js';
import { checkPublicUrl, publicFetch } from './providers.js';

// Source check with page fetch (R2-46). For at most five web hits per analysis the page is
// fetched (only http(s), never the private network, with timeout and length limit). The check
// answers two questions: is the page reachable, and does the quoted text really stand there?
// Page text is untrusted: it only reaches a model inside an <untrusted_input> block (ADR 0004).
// Confidential ideas never fetch anything.

export interface FetchedPage {
  status: number;
  contentType: string;
  body: string;
}

export type PageFetcher = (url: URL, opts: { timeoutMs: number; maxBytes: number }) => Promise<FetchedPage>;

const MAX_REDIRECTS = 3;

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.byteLength;
    if (total >= maxBytes) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks).subarray(0, maxBytes));
}

/** Fetches a page; every redirect target passes the URL guard again. */
const defaultFetcher: PageFetcher = async (start, opts) => {
  let url = start;
  for (let hop = 0; ; hop++) {
    const guard = await checkPublicUrl(url.href);
    if ('refused' in guard) throw new Error(`refused: ${guard.refused}`);
    // Pinned to the checked address (DNS rebinding); publicFetch checks the URL once more itself.
    const res = await publicFetch(guard.url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs),
      headers: { accept: 'text/html, text/plain;q=0.9', 'user-agent': 'Ideenportal-Quellenpruefung/1.0' },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location') && hop < MAX_REDIRECTS) {
      url = new URL(res.headers.get('location')!, guard.url);
      await res.body?.cancel().catch(() => undefined);
      continue;
    }
    const contentType = res.headers.get('content-type') ?? '';
    const textual = /text\/html|text\/plain|application\/xhtml/i.test(contentType);
    return { status: res.status, contentType, body: textual ? await readLimited(res, opts.maxBytes) : '' };
  }
};

let fetcher: PageFetcher = defaultFetcher;

/** Tests replace the fetcher; there is no real network in tests. */
export function setPageFetcher(f: PageFetcher | null): void {
  fetcher = f ?? defaultFetcher;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '' };

/** Visible text of an HTML page: no scripts, styles or tags; entities decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 31 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[e.toLowerCase()] ?? all;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lower case, digits without thousands separators, only letters and digits. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/(\d)[.,'  ](?=\d{3}\b)/g, '$1')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** True when a fragment of the quote (at least four words) stands in the page; null when nothing is checkable. */
export function quoteInPage(quote: string, pageText: string): boolean | null {
  const page = ` ${normalize(pageText)} `;
  const fragments = quote
    .split(/\s*(?:\.\.\.|…|[.!?;](?=\s|$))\s*/u)
    .map((f) => normalize(f))
    .filter((f) => f.split(' ').length >= 4);
  if (!fragments.length) return null;
  return fragments.some((f) => page.includes(` ${f} `));
}

const NUMBER = /\d+(?:[.,]\d+)*/g;

/** A statement counts as confirmed when all its numbers and most of its longer words stand in the page. */
export function claimInPage(claim: string, pageText: string): boolean {
  const page = ` ${normalize(pageText)} `;
  const numbers = (claim.match(NUMBER) ?? []).map((n) => normalize(n));
  if (numbers.some((n) => !page.includes(` ${n} `) && !page.includes(` ${n.replace(' ', '')} `))) return false;
  const words = [...new Set(normalize(claim).split(' ').filter((w) => w.length >= 5 && !/^\d+$/.test(w)))];
  if (!words.length) return numbers.length > 0;
  return words.filter((w) => page.includes(w)).length / words.length >= 0.5;
}

export interface Page {
  text: string;
  check: SourceCheck;
}
export type Pages = Map<string, Page>;

/**
 * Fetches the pages of the first web hits within the limits of the workspace and marks each
 * source with the result. Logs one entry "page_fetch" with the fetched addresses.
 */
export async function fetchPages(ctx: Ctx, ideaId: string | null, sources: Source[], opts: { confidential: boolean }): Promise<Pages> {
  const cfg = ctx.settings.ai.sourceCheck;
  const pages: Pages = new Map();
  if (opts.confidential || !cfg.enabled || cfg.maxPages <= 0) return pages;
  // The operator can switch the page fetch off for the instance (tests run without network).
  if (fetcher === defaultFetcher && !config.aiPageFetch) return pages;
  const candidates = sources.filter((s) => s.origin !== 'internal' && /^https?:\/\//i.test(s.url)).slice(0, Math.min(5, cfg.maxPages));
  if (!candidates.length) return pages;
  const started = Date.now();
  const checks: { url: string; reachable: boolean; status: number | null; quoteFound: boolean | null; chars: number; error?: string }[] = [];
  for (const s of candidates) {
    let check: SourceCheck = { reachable: false, status: null, quoteFound: null, checkedAt: ctx.today };
    let text = '';
    let error: string | undefined;
    try {
      const res = await fetcher(new URL(s.url), { timeoutMs: cfg.timeoutSeconds * 1000, maxBytes: cfg.maxChars * 4 });
      const raw = /html|xml/i.test(res.contentType) ? htmlToText(res.body) : res.body.replace(/\s+/g, ' ').trim();
      text = raw.slice(0, cfg.maxChars);
      const ok = res.status >= 200 && res.status < 400;
      check = { reachable: ok, status: res.status, quoteFound: ok && text ? quoteInPage(s.snippet, text) : null, checkedAt: ctx.today };
    } catch (err) {
      error = (err as Error).message.startsWith('refused') ? (err as Error).message : 'unreachable';
    }
    s.check = check;
    if (check.reachable && text) {
      pages.set(s.url, { text, check });
      // A short, cleaned excerpt goes to the model inside the fenced source list.
      s.excerpt = stripInjections(text.slice(0, 1500));
    }
    checks.push({ url: s.url, reachable: check.reachable, status: check.status, quoteFound: check.quoteFound, chars: text.length, ...(error ? { error } : {}) });
  }
  await logAction(ctx, {
    ideaId, agent: 'page_fetch', provider: 'web', model: '-', local: false, status: 'ok', hosting: 'other',
    input: { urls: candidates.map((s) => s.url), maxChars: cfg.maxChars }, output: { checks }, tools: ['page_fetch'], durationMs: Date.now() - started,
  });
  return pages;
}

/** Marks every fact with a fetched source as confirmed or not found in the page text. */
export function verifyClaims(sections: Section[], sources: Source[], pages: Pages): void {
  if (!pages.size) return;
  const byId = new Map(sources.map((s) => [s.id, s]));
  for (const sec of sections) {
    for (const c of sec.claims) {
      if (c.kind !== 'fact' || !c.sources.length) continue;
      const texts = c.sources.map((id) => pages.get(byId.get(id)?.url ?? '')?.text).filter((t): t is string => !!t);
      if (!texts.length) continue;
      c.check = texts.some((t) => claimInPage(c.text, t)) ? 'confirmed' : 'not_found';
    }
  }
}

/** Sources as stored: the page excerpt is only for the prompt. */
export function storedSources(sources: Source[]): Source[] {
  return sources.map(({ excerpt: _e, ...s }) => s);
}

export interface BlockSourceMetric {
  kind: string;
  results: number;
  numbers: number;
  numbersSourced: number;
  share: number | null;
  sourcesChecked: number;
  reachable: number;
  quoteFound: number;
  claimsChecked: number;
  claimsConfirmed: number;
}

/** Share of numbers with a source and results of the source check, per building block (R2-46). */
export function sourceMetrics(rows: { kind: string; content: { sections?: Section[]; sources?: Source[] } }[]): BlockSourceMetric[] {
  const by = new Map<string, BlockSourceMetric>();
  for (const r of rows) {
    const e = by.get(r.kind) ?? { kind: r.kind, results: 0, numbers: 0, numbersSourced: 0, share: null, sourcesChecked: 0, reachable: 0, quoteFound: 0, claimsChecked: 0, claimsConfirmed: 0 };
    e.results++;
    for (const sec of r.content.sections ?? []) {
      for (const c of sec.claims) {
        if (/\d/.test(c.text)) {
          e.numbers++;
          if (c.sources.length) e.numbersSourced++;
        }
        if (c.check) {
          e.claimsChecked++;
          if (c.check === 'confirmed') e.claimsConfirmed++;
        }
      }
    }
    for (const s of r.content.sources ?? []) {
      if (!s.check) continue;
      e.sourcesChecked++;
      if (s.check.reachable) e.reachable++;
      if (s.check.quoteFound) e.quoteFound++;
    }
    by.set(r.kind, e);
  }
  return [...by.values()].map((e) => ({ ...e, share: e.numbers ? Math.round((e.numbersSourced / e.numbers) * 100) / 100 : null }));
}
