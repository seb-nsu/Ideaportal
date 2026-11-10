import { withTenant } from '../db/pool.js';
import { buildCtx, type Ctx, type SessionUser } from '../lib/context.js';
import {
  businessCaseCall,
  competitionCall,
  counterCall,
  dossierCall,
  experimentCall,
  internalMarketCall,
  marketSizeCall,
  patentsCall,
  positioningCall,
  riskCall,
  shortAnalysisCall,
  triageCall,
  type AnalysisBundle,
  type IdeaFacts,
  type ShortAnalysis,
} from './agents.js';
import { cleanText, diffClaims, findInjections, normalizeSections, setContactContext, setInjectionContext, type ModelSection, type Section, type Source } from './content.js';
import { AiError, logAction, runAgent, type AgentCall, type AgentRun } from './gateway.js';
import { m, refText, tr } from '../i18n/index.js';
import { internalResearch, keywords, webResearch, type ResearchQuery } from './search.js';
import { blockEnabled, type AgentName, type FullBlock } from './settings.js';
import { fetchPages, storedSources, verifyClaims, type Pages } from './sourcecheck.js';

// Orchestration of the analyses (R2-22 … R2-32): research by code, one agent per module,
// labelled results saved as versions with the changes against the previous version.

/** A context for background work: settings and actor, but every query opens its own transaction. */
export async function detachedCtx(tenantId: string, user: SessionUser | null): Promise<Ctx> {
  const ctx = await withTenant(tenantId, (db) => buildCtx(db, tenantId, user));
  return { ...ctx, db: undefined as unknown as Ctx['db'] };
}

export function tx<T>(ctx: Ctx, fn: (c: Ctx) => Promise<T>): Promise<T> {
  return withTenant(ctx.tenantId, (db) => fn({ ...ctx, db }));
}

export async function ideaFacts(c: Ctx, ideaId: string): Promise<(IdeaFacts & { id: string; status: string; number: number; invention: boolean }) | null> {
  const r = await c.db.query<{ id: string; number: number; title: string; problem: string; solution: string; benefit: string; topic: string | null; idea_type: 'internal' | 'product'; idea_kind: 'idea' | 'problem'; confidential: boolean; status: string; invention: boolean }>(
    `SELECT id, number, title, problem, solution, benefit, topic, idea_type, idea_kind, confidential, status, invention_check = 'possible' AS invention
       FROM ideas WHERE id = $1`,
    [ideaId],
  );
  const i = r.rows[0];
  if (!i) return null;
  return { id: i.id, number: i.number, title: i.title, problem: i.problem, solution: i.solution, benefit: i.benefit, topic: i.topic, ideaType: i.idea_type, kind: i.idea_kind, confidential: i.confidential, status: i.status, invention: !!i.invention };
}

export interface StoredContent {
  agent: AgentName;
  data: Record<string, unknown>;
  sections: Section[];
  sources: Source[];
  warnings: string[];
  meta: { model: string; provider: string; local: boolean; generatedAt: string; costEur: number; edited?: boolean; uncheckedModel?: string; promptVersion?: string };
}

const SKIP_CLEAN = new Set(['kind', 'area', 'light', 'lane', 'category', 'recommendation', 'assessment', 'section', 'status', 'confidence', 'asks', 'unit', 'id', 'url', 'number', 'name', 'topic']);

function cleanStrings(value: unknown, injections: string[], warnings: string[], key = ''): unknown {
  if (typeof value === 'string') return SKIP_CLEAN.has(key) ? value : cleanText(value, injections, warnings);
  if (Array.isArray(value)) return value.map((v) => cleanStrings(v, injections, warnings, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanStrings(v, injections, warnings, k)]));
  }
  return value;
}

/** Labelling and safety rules on any agent output (R2-11, R2-13). */
export function finalize<T extends object>(run: AgentRun<T>, sources: Source[], untrusted: string): Omit<StoredContent, 'agent'> & { output: T } {
  // Search results are untrusted as well (indirect prompt injection, R2-13).
  const fromSources = sources.map((s) => `${s.title}\n${s.snippet}${s.excerpt ? `\n${s.excerpt}` : ''}`).join('\n');
  const all = fromSources ? `${untrusted}\n${fromSources}` : untrusted;
  const injections = findInjections(all);
  setInjectionContext(all, injections);
  setContactContext(untrusted);
  const warnings = [...run.warnings];
  if (injections.length) warnings.push(refText('aigw.warn.injection'));
  const raw = run.output as Record<string, unknown>;
  let sections: Section[] = [];
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'sections') {
      const n = normalizeSections(v as ModelSection[], sources, injections);
      sections = n.value;
      warnings.push(...n.warnings);
    } else if (k === 'benchmarks') {
      const n = normalizeSections([{ heading: 'Benchmarks', claims: v as ModelSection['claims'] }], sources, injections, 'b');
      data[k] = n.value[0].claims;
      warnings.push(...n.warnings);
    } else {
      data[k] = cleanStrings(v, injections, warnings, k);
    }
  }
  return {
    data,
    sections,
    sources,
    warnings: [...new Set(warnings)],
    meta: { model: run.model, provider: run.provider, local: run.local, generatedAt: new Date().toISOString(), costEur: run.costEur, ...(run.uncheckedModel ? { uncheckedModel: run.uncheckedModel } : {}), ...(run.promptVersion ? { promptVersion: run.promptVersion } : {}) },
    output: { ...(data as T), ...(sections.length ? { sections } : {}) },
  };
}

export async function saveResult(c: Ctx, ideaId: string | null, kind: string, content: Omit<StoredContent, 'agent'> & { agent: string }, actionId: string | null, subject: string | null = null): Promise<{ id: string; version: number }> {
  const prev = await c.db.query<{ version: number; content: StoredContent }>(
    `SELECT version, content FROM ai_results WHERE idea_id IS NOT DISTINCT FROM $1 AND kind = $2 AND subject IS NOT DISTINCT FROM $3 ORDER BY version DESC LIMIT 1`,
    [ideaId, kind, subject],
  );
  const previous = prev.rows[0];
  const changes = previous ? diffClaims(previous.content.sections, content.sections) : null;
  const r = await c.db.query<{ id: string; version: number }>(
    `INSERT INTO ai_results (tenant_id, idea_id, subject, kind, version, content, changes, action_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, version`,
    [c.tenantId, ideaId, subject, kind, (previous?.version ?? 0) + 1, JSON.stringify(content), changes ? JSON.stringify(changes) : null, actionId, c.user?.id ?? null],
  );
  return r.rows[0];
}

export async function latestContent<T = Record<string, unknown>>(c: Ctx, ideaId: string, kind: string): Promise<(T & { sections?: Section[] }) | null> {
  const r = await c.db.query<{ content: StoredContent }>('SELECT content FROM ai_results WHERE idea_id = $1 AND kind = $2 ORDER BY version DESC LIMIT 1', [ideaId, kind]);
  const content = r.rows[0]?.content;
  return content ? ({ ...(content.data as T), sections: content.sections } as T & { sections?: Section[] }) : null;
}

/** Runs one agent call, applies the rules and stores the result. */
export async function runAndSave<T extends object>(ctx: Ctx, kind: string, call: AgentCall<T>, untrusted: string, subject: string | null = null, pages?: Pages): Promise<{ id: string; output: T; content: StoredContent }> {
  const run = await runAgent(ctx, call);
  const fin = finalize(run, call.sources ?? [], untrusted);
  // Source check (R2-46): facts are compared with the text of the fetched pages.
  if (pages) verifyClaims(fin.sections, fin.sources, pages);
  const content: StoredContent = { agent: call.agent, data: fin.data, sections: fin.sections, sources: storedSources(fin.sources), warnings: fin.warnings, meta: fin.meta };
  const saved = await tx(ctx, (c) => saveResult(c, call.ideaId, kind, content, run.actionId, subject));
  return { id: saved.id, output: fin.output, content };
}

const untrustedOf = (i: IdeaFacts) => `${i.title}\n${i.problem}\n${i.solution}\n${i.benefit}`;

/** Writes a log entry for a step that did not run, with the reason (R2-45). */
async function logSkipped(ctx: Ctx, ideaId: string | null, agent: string, reason: string, input: Record<string, unknown>): Promise<void> {
  await logAction(ctx, { ideaId, agent, provider: '-', model: '-', local: true, status: 'skipped', hosting: 'local', input, error: reason });
}

async function research(ctx: Ctx, idea: IdeaFacts & { invention?: boolean }, queries: ResearchQuery[], purpose: 'short' | 'full'): Promise<{ sources: Source[]; warnings: string[]; pages: Pages }> {
  const internal = await tx(ctx, (c) => internalResearch(c, { ...idea, id: idea.id ?? undefined }, 1));
  // Problems (R3-31): the short analysis asks root-cause questions; no competition research leaves the house.
  if (purpose === 'short' && idea.kind === 'problem') {
    if (ctx.settings.ai.search.kind !== 'none') await logSkipped(ctx, idea.id, 'web_search', tr('de', m('aiout.problem.noWebSearch')), { reason: 'problem', purpose });
    return { sources: internal, warnings: [], pages: new Map() };
  }
  // Possible invention (R3-25): no search query may disclose it before a patent filing.
  if (idea.invention && ctx.settings.ai.search.kind !== 'none') {
    await logSkipped(ctx, idea.id, 'web_search', tr('de', m('compliance.invention.noWebSearch')), { reason: 'invention', purpose });
    return { sources: internal, warnings: [], pages: new Map() };
  }
  // Web search per idea type (R2-45): by default internal ideas get none in the short analysis.
  if (purpose === 'short' && !ctx.settings.ai.ideaTypes[idea.ideaType].shortWebSearch && !idea.confidential && ctx.settings.ai.search.kind !== 'none') {
    await logSkipped(ctx, idea.id, 'web_search', tr('de', m('aiq.skipped.webSearch', { type: tr('de', m(`aiq.ideaType.${idea.ideaType}`)) })), { reason: 'idea_type', ideaType: idea.ideaType, purpose });
    return { sources: internal, warnings: [], pages: new Map() };
  }
  const web = await tx(ctx, (c) => webResearch(c, queries, internal.length + 1, { confidential: idea.confidential }));
  if (web.queries.length) {
    // What left the house is part of the AI log (R2-10, R2-14).
    await logAction(ctx, {
      ideaId: idea.id, agent: 'web_search', provider: ctx.settings.ai.search.kind, model: '-', local: false, status: 'ok',
      hosting: ctx.settings.ai.search.kind === 'searxng' ? 'local' : 'other',
      input: { queries: web.queries, removedTerms: web.removed }, sources: web.sources, tools: ['web_search'], searchQueries: web.queries.length,
      costEur: web.queries.length * ctx.settings.ai.search.costPerQueryEur, warnings: web.warnings,
    });
  }
  // Page fetch for the source check (R2-46); confidential ideas never get here with web hits.
  const pages = await fetchPages(ctx, idea.id, web.sources, { confidential: idea.confidential });
  return { sources: [...internal, ...web.sources], warnings: web.warnings, pages };
}

function queriesFor(ctx: Ctx, idea: IdeaFacts, purpose: 'short' | 'full'): ResearchQuery[] {
  const kw = keywords(`${idea.title} ${idea.title} ${idea.solution}`, 4).join(' ');
  const product = idea.ideaType === 'product';
  const base: ResearchQuery[] = [{ query: `${kw} ${product ? 'Anbieter Wettbewerber' : 'Lösung Software'}`, origin: 'web' }];
  if (purpose === 'short') return base;
  return [
    ...base,
    { query: `${kw} ${product ? 'Alternative Produkt Preis' : 'Open Source'}`, origin: 'web' },
    { query: `${kw} ${product ? 'Marktgröße Studie' : 'Unternehmen Erfahrungen Best Practice'}`, origin: 'web' },
    // No patent query when the patents block is off for this idea type (R2-45).
    ...(blockEnabled(ctx.settings.ai, idea.ideaType, 'patents') ? [{ query: kw, origin: 'patent' as const }] : []),
  ];
}

const OPEN_STATUSES = ['submitted', 'in_question'];

/** Short analysis after submission plus the triage suggestion (R2-22, R2-18). */
export async function runShortAnalysis(ctx: Ctx, ideaId: string): Promise<void> {
  const idea = await tx(ctx, (c) => ideaFacts(c, ideaId));
  if (!idea) return;
  const { sources, warnings, pages } = await research(ctx, idea, queriesFor(ctx, idea, 'short'), 'short');
  const res = await runAndSave(ctx, 'short_analysis', shortAnalysisCall(idea, sources), untrustedOf(idea), null, pages);
  if (warnings.length) await tx(ctx, (c) => c.db.query(`UPDATE ai_results SET content = jsonb_set(content, '{warnings}', (content->'warnings') || $2::jsonb) WHERE id = $1`, [res.id, JSON.stringify(warnings)]));
  if (OPEN_STATUSES.includes(idea.status)) {
    await runAndSave(ctx, 'triage_suggestion', triageCall(idea, res.output as ShortAnalysis, ctx.settings), untrustedOf(idea));
  }
}

const FULL_STEPS = ['competition', 'patents', 'positioning', 'market', 'business_case', 'risk_check', 'experiment', 'counterarguments', 'dossier_draft'] as const;

/** Full analysis when the lane is "elaborate" and on refresh (R2-22 … R2-32). */
export async function runFullAnalysis(ctx: Ctx, ideaId: string): Promise<{ done: string[]; failed: { step: string; error: string }[]; skipped?: string[] }> {
  const idea = await tx(ctx, (c) => ideaFacts(c, ideaId));
  if (!idea) return { done: [], failed: [] };
  const { sources, warnings, pages } = await research(ctx, idea, queriesFor(ctx, idea, 'full'), 'full');
  const text = untrustedOf(idea);
  const bundle: AnalysisBundle = { short: await tx(ctx, (c) => latestContent<ShortAnalysis>(c, ideaId, 'short_analysis')) };
  const done: string[] = [];
  const failed: { step: string; error: string }[] = [];
  const product = idea.ideaType === 'product';

  const skipped: string[] = [];
  for (const step of FULL_STEPS) {
    // Building blocks per idea type (R2-45): a switched-off block is logged as skipped.
    if (!blockEnabled(ctx.settings.ai, idea.ideaType, step as FullBlock)) {
      const agent = step === 'market' ? (product ? 'market_size' : 'internal_market') : step;
      await logSkipped(ctx, idea.id, agent, tr('de', m('aiq.skipped.block', { type: tr('de', m(`aiq.ideaType.${idea.ideaType}`)) })), { reason: 'idea_type', ideaType: idea.ideaType, block: step });
      skipped.push(step);
      continue;
    }
    try {
      switch (step) {
        case 'competition':
          bundle.competition = (await runAndSave(ctx, 'competition', competitionCall(idea, sources), text, null, pages)).output;
          break;
        case 'patents':
          await runAndSave(ctx, 'patents', patentsCall(idea, sources), text, null, pages);
          break;
        case 'positioning':
          bundle.positioning = (await runAndSave(ctx, 'positioning', positioningCall(idea, bundle.competition ?? null), text)).output;
          break;
        case 'market':
          if (product) bundle.marketSize = (await runAndSave(ctx, 'market_size', marketSizeCall(idea, sources), text, null, pages)).output;
          else bundle.internalMarket = (await runAndSave(ctx, 'internal_market', internalMarketCall(idea, sources), text, null, pages)).output;
          break;
        case 'business_case':
          bundle.businessCase = (await runAndSave(ctx, 'business_case', businessCaseCall(idea, { lever: bundle.internalMarket?.lever ?? null, market: bundle.marketSize ?? null }, sources), text, null, pages)).output;
          break;
        case 'risk_check':
          bundle.risks = (await runAndSave(ctx, 'risk_check', riskCall(idea), text)).output;
          break;
        case 'experiment':
          bundle.experiment = (await runAndSave(ctx, 'experiment', experimentCall(idea, bundle.risks ?? null), text)).output;
          break;
        case 'counterarguments':
          await runAndSave(ctx, 'counterarguments', counterCall(idea, bundle, sources), text, null, pages);
          break;
        case 'dossier_draft':
          await runAndSave(ctx, 'dossier_draft', dossierCall(idea, bundle), text);
          break;
      }
      done.push(step);
    } catch (err) {
      if (!(err instanceof AiError)) throw err;
      failed.push({ step, error: err.message });
      // Budget, configuration and release problems stop the run; a single failing module does not.
      if (['AI_BUDGET', 'AI_DISABLED', 'AI_CONFIDENTIAL', 'AI_CONFIG', 'AI_EVAL_PENDING'].includes(err.code ?? '')) throw err;
    }
  }
  if (warnings.length) {
    await tx(ctx, (c) => c.db.query(
      `UPDATE ai_results SET content = jsonb_set(content, '{warnings}', (content->'warnings') || $2::jsonb)
        WHERE id = (SELECT id FROM ai_results WHERE idea_id = $1 AND kind = 'competition' ORDER BY version DESC LIMIT 1)`,
      [ideaId, JSON.stringify(warnings)],
    ));
  }
  return { done, failed, skipped };
}
