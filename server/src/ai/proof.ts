import type { Ctx } from '../lib/context.js';
import type { Block } from '../lib/pdf.js';
import { intlLocale, m, tr, type Locale, type MessageKey } from '../i18n/index.js';
import { allProviders } from './gateway.js';
import { agentLabel } from './settings.js';

// Privacy proof per AI analysis (R2-42): for every logged AI action of an idea, which service
// got what, where it runs, which model answered, what it cost and which web queries left the
// house. The proof never contains prompts, answers or idea texts; for confidential ideas not
// even the title.

// Texts for people: in the language of the request (R2-50).
const HOSTING = ['local', 'eu', 'other'];
export const hostingLabel = (locale: Locale, hosting: string) =>
  HOSTING.includes(hosting) ? tr(locale, m(`ai.proof.hosting.${hosting}` as MessageKey)) : hosting;

const SEARCH = ['brave', 'searxng'];
const searchLabel = (locale: Locale, provider: string) =>
  SEARCH.includes(provider) ? tr(locale, m(`ai.proof.search.${provider}` as MessageKey)) : provider;

export interface ProofEntry {
  id: string;
  createdAt: string;
  agent: string;
  label: string;
  status: string;
  provider: string;
  hosting: string | null;
  hostingLabel: string;
  model: string;
  local: boolean;
  dataSent: string;
  searchQueries: string[];
  removedTerms: number;
  sources: number;
  inputTokens: number;
  outputTokens: number;
  costEur: number;
}

export interface Proof {
  idea: { id: string; number: number; title: string | null; confidential: boolean; ideaType: string };
  workspace: string;
  generatedAt: string;
  entries: ProofEntry[];
  totals: { actions: number; external: number; searchQueries: number; costEur: number };
}

function describe(agent: string, local: boolean, confidential: boolean, queries: number): MessageKey {
  if (agent === 'web_search') return queries ? 'ai.proof.sent.queries' : 'ai.proof.sent.noQuery';
  // Source check (R2-46): only the addresses of search hits are requested, no idea text.
  if (agent === 'page_fetch') return 'aiq.proof.sentPageFetch';
  if (local) return 'ai.proof.sent.local';
  if (confidential) return 'ai.proof.sent.confidential';
  return 'ai.proof.sent.ideaText';
}

/** Builds the proof for one idea. The caller checks who may see it. */
export async function proofForIdea(ctx: Ctx, ideaId: string): Promise<Proof | null> {
  const idea = (
    await ctx.db.query<{ id: string; number: number; title: string; confidential: boolean; idea_type: string }>(
      'SELECT id, number, title, confidential, idea_type FROM ideas WHERE id = $1',
      [ideaId],
    )
  ).rows[0];
  if (!idea) return null;
  const tenant = (await ctx.db.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [ctx.tenantId])).rows[0];
  const rows = await ctx.db.query<{
    id: string; created_at: Date; agent: string; status: string; provider: string; hosting: string | null; model: string; local: boolean;
    input: { queries?: string[]; removedTerms?: number[] } | null; sources: unknown[]; input_tokens: number; output_tokens: number; cost_eur: string;
  }>(
    `SELECT id, created_at, agent, status, provider, hosting, model, local, input, sources, input_tokens, output_tokens, cost_eur
       FROM ai_actions WHERE idea_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [ideaId],
  );
  const providers = allProviders(ctx.settings.ai);
  const entries: ProofEntry[] = rows.rows.map((r) => {
    const isSearch = r.agent === 'web_search';
    const provider = isSearch ? searchLabel(ctx.locale, r.provider) : (providers.find((p) => p.id === r.provider)?.name ?? r.provider);
    const hosting = r.hosting ?? (r.local ? 'local' : (providers.find((p) => p.id === r.provider)?.hosting ?? null));
    const queries = isSearch && Array.isArray(r.input?.queries) ? r.input!.queries! : [];
    return {
      id: r.id,
      createdAt: r.created_at.toISOString(),
      agent: r.agent,
      label: isSearch ? tr(ctx.locale, m('ai.proof.webSearch')) : r.agent === 'page_fetch' ? tr(ctx.locale, m('aiq.proof.pageFetch')) : agentLabel(ctx.locale, r.agent),
      status: r.status,
      provider,
      hosting,
      hostingLabel: hosting ? hostingLabel(ctx.locale, hosting) : tr(ctx.locale, m('ai.proof.notLogged')),
      model: r.model,
      local: r.local,
      dataSent: tr(ctx.locale, m(describe(r.agent, r.local, idea.confidential, queries.length))),
      searchQueries: queries,
      removedTerms: (r.input?.removedTerms ?? []).reduce((a, b) => a + b, 0),
      sources: Array.isArray(r.sources) ? r.sources.length : 0,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      costEur: Number(r.cost_eur),
    };
  });
  return {
    idea: { id: idea.id, number: idea.number, title: idea.confidential ? null : idea.title, confidential: idea.confidential, ideaType: idea.idea_type },
    workspace: tenant?.name ?? '',
    generatedAt: new Date().toISOString(),
    entries,
    totals: {
      actions: entries.length,
      external: entries.filter((e) => !e.local).length,
      searchQueries: entries.reduce((n, e) => n + e.searchQueries.length, 0),
      costEur: Math.round(entries.reduce((n, e) => n + e.costEur, 0) * 10000) / 10000,
    },
  };
}

/** Text blocks for the PDF export, in the language of the request. */
export function proofBlocks(p: Proof, locale: Locale = 'de'): Block[] {
  const t = (key: MessageKey, vars?: Record<string, string | number>) => tr(locale, m(key, vars));
  const date = (iso: string) => new Date(iso).toLocaleString(intlLocale(locale), { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' });
  const eur = (n: number) => `${n.toLocaleString(intlLocale(locale), { minimumFractionDigits: 2, maximumFractionDigits: 4 })} €`;
  const name = p.idea.title ? t('ai.proof.ideaName', { number: p.idea.number, title: p.idea.title }) : t('ai.proof.ideaConfidential', { number: p.idea.number });
  const blocks: Block[] = [
    { kind: 'title', text: t('ai.proof.title') },
    { kind: 'space' },
    { kind: 'row', label: t('ai.proof.workspace'), value: p.workspace },
    { kind: 'row', label: t('ai.proof.idea'), value: name },
    { kind: 'row', label: t('ai.proof.createdAt'), value: date(p.generatedAt) },
    { kind: 'row', label: t('ai.proof.actions'), value: t('ai.proof.actionsValue', { actions: p.totals.actions, external: p.totals.external }) },
    { kind: 'row', label: t('ai.proof.queries'), value: String(p.totals.searchQueries) },
    { kind: 'row', label: t('ai.proof.totalCost'), value: eur(p.totals.costEur) },
    { kind: 'space' },
    { kind: 'text', text: t('ai.proof.intro'), small: true },
  ];
  for (const e of p.entries) {
    blocks.push(
      { kind: 'heading', text: `${e.label} · ${date(e.createdAt)}` },
      { kind: 'row', label: t('ai.proof.result'), value: e.status === 'ok' ? t('ai.proof.done') : t('ai.proof.notDone', { status: e.status }) },
      { kind: 'row', label: t('ai.proof.service'), value: e.provider },
      { kind: 'row', label: t('ai.proof.region'), value: e.hostingLabel },
      { kind: 'row', label: t('ai.proof.model'), value: e.model === '-' ? '–' : e.model },
      { kind: 'row', label: t('ai.proof.dataSent'), value: e.dataSent },
    );
    if (e.searchQueries.length) {
      blocks.push({ kind: 'row', label: t('ai.proof.queries'), value: t('ai.proof.queriesValue', { count: e.searchQueries.length, removed: e.removedTerms }) });
      for (const q of e.searchQueries) blocks.push({ kind: 'bullet', text: t('ai.proof.quoted', { query: q }) });
    }
    blocks.push({ kind: 'row', label: t('ai.proof.volume'), value: t('ai.proof.volumeValue', { input: e.inputTokens, output: e.outputTokens, cost: eur(e.costEur) }) });
  }
  if (!p.entries.length) blocks.push({ kind: 'text', text: t('ai.proof.none') });
  return blocks;
}
