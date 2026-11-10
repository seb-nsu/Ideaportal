import { z } from 'zod';
import { m, tr, type Locale, type MessageKey } from '../i18n/index.js';

// AI settings per tenant (R2-09): providers, models per task, prices, budgets, web search
// and the release of agents after the quality check (R2-12). Keys are not part of the
// settings; they live encrypted in tenant_secrets.

export const AGENTS = [
  'coach',
  'transcribe',
  'describe_image',
  'boundary',
  'short_analysis',
  'triage_suggestion',
  'reply_draft',
  'discussion_summary',
  'competition',
  'patents',
  'positioning',
  'market_size',
  'internal_market',
  'business_case',
  'risk_check',
  'experiment',
  'dossier_draft',
  'gate2_brief',
  'counterarguments',
  'challenge_suggestions',
  'success_story',
  'portfolio_query',
  'translate',
  'implementation_package',
  'process_proposal',
  'trend_digest',
  'trend_assign',
  'problem_clusters',
  'import_cleanup',
  'eval_judge',
] as const;
export type AgentName = (typeof AGENTS)[number];

export const MODEL_SLOTS = ['fast', 'deep', 'vision', 'speech', 'confidential'] as const;
export type ModelSlot = (typeof MODEL_SLOTS)[number];

export const providerSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,30}$/),
  name: z.string().min(1).max(80),
  kind: z.enum(['builtin', 'anthropic', 'openai_compatible']),
  baseUrl: z.string().max(300),
  // local = own infrastructure (on-premises or own cloud account); only local providers
  // may see confidential ideas and texts that look like reports.
  hosting: z.enum(['local', 'eu', 'other']),
  keySource: z.enum(['none', 'tenant', 'platform']),
});
export type ProviderConfig = z.infer<typeof providerSchema>;

export const modelRef = z.object({ provider: z.string().min(1).max(30), model: z.string().min(1).max(100) });
export type ModelRef = z.infer<typeof modelRef>;

// Building blocks of the full analysis (R2-22 … R2-31); "market" is market size for product
// ideas and the internal market analysis for internal ideas.
export const FULL_BLOCKS = ['competition', 'patents', 'positioning', 'market', 'business_case', 'risk_check', 'experiment', 'counterarguments', 'dossier_draft'] as const;
export type FullBlock = (typeof FULL_BLOCKS)[number];
export type IdeaType = 'internal' | 'product';

// Web search and building blocks per idea type (R2-45). A block missing in "blocks" runs.
const ideaTypeConfig = z.object({
  shortWebSearch: z.boolean(),
  blocks: z.partialRecord(z.enum(FULL_BLOCKS), z.boolean()),
});

export const DEFAULT_IDEA_TYPES = {
  // Internal small ideas trigger no competitor research in the short analysis.
  internal: { shortWebSearch: false, blocks: { patents: false } },
  // Patents stay off until a patent database is connected (R2-24).
  product: { shortWebSearch: true, blocks: { patents: false } },
};

// Source check with page fetch (R2-46): at most 5 pages per analysis, cut to maxChars.
export const DEFAULT_SOURCE_CHECK = { enabled: true, maxPages: 5, maxChars: 20_000, timeoutSeconds: 10 };

// Alarm on deterioration of the AI quality (R4-08): the last finished period is compared with the
// three periods before it; a drop of the hit rate or a rise of the correction, source error or
// failure rate by at least dropPoints percentage points, or of the cost per call by
// costRisePercent, tells the admins once per period. Periods with fewer than minCases cases are not judged.
export const DEFAULT_QUALITY_ALARM = { enabled: true, period: 'month' as const, dropPoints: 10, costRisePercent: 50, minCases: 5 };

// Evaluation against the test set (R2-12): sample size of the expensive agents, tolerance for
// regressions against the previous run and the optional LLM-as-judge (off by default). The judge
// runs on the "deep" model through the gateway, is logged like every AI action and stops at its
// own cost limit per run; its score is mixed with the deterministic score by weight.
export const DEFAULT_EVALS = {
  sampleSize: 15,
  regressionTolerance: 0.05,
  judge: { enabled: false, weight: 0.3, maxCostEurPerRun: 2, maxCasesPerAgent: 5 },
};

// Server-side fallback of the model provider (Anthropic): a refused request is answered by
// another model. Answers from a model that did not pass the test set for the agent are marked
// "unchecked model". serverSide false switches the fallback off.
export const DEFAULT_FALLBACK = { serverSide: true };

const agentConfig = z.object({
  enabled: z.boolean(),
  model: modelRef.optional(),
  // Minimum quality score (0-1) on the test set before the agent goes live.
  minScore: z.number().min(0).max(1).optional(),
});

export const aiSettingsSchema = z.object({
  enabled: z.boolean(),
  providers: z.array(providerSchema).min(1).max(10),
  models: z.object({
    fast: modelRef,
    deep: modelRef,
    vision: modelRef,
    speech: modelRef,
    confidential: modelRef,
  }),
  agents: z.partialRecord(z.enum(AGENTS), agentConfig),
  // Prices in euro per million tokens; models without a price count with fallbackPrice.
  prices: z.array(z.object({ model: z.string().min(1).max(100), inputPerMTok: z.number().min(0), outputPerMTok: z.number().min(0) })).max(50),
  fallbackPrice: z.object({ inputPerMTok: z.number().min(0), outputPerMTok: z.number().min(0) }),
  budget: z.object({ perIdeaEur: z.number().min(0), perMonthEur: z.number().min(0) }),
  search: z.object({
    kind: z.enum(['none', 'brave', 'searxng']),
    baseUrl: z.string().max(300),
    costPerQueryEur: z.number().min(0),
    perMonthEur: z.number().min(0),
    maxQueriesPerRun: z.number().int().min(0).max(20),
  }),
  autoShortAnalysis: z.boolean(),
  autoFullAnalysis: z.boolean(),
  // Tone for drafts to submitters (R2-19).
  tone: z.string().max(500),
  // Company names, product names and internal terms removed before a web search (R2-14).
  internalTerms: z.array(z.string().min(2).max(80)).max(300),
  // Agents go live only after passing the test set (R2-12).
  requireEval: z.boolean(),
  releaseOverrides: z
    .partialRecord(z.enum(AGENTS), z.object({ configHash: z.string(), reason: z.string().min(10).max(500), by: z.string(), at: z.string() }))
    .default({}),
  ideaTypes: z.object({ internal: ideaTypeConfig, product: ideaTypeConfig }).default(DEFAULT_IDEA_TYPES),
  // Review status per building block (R2-44): all blocks "geprüft" or "korrigiert" before Gate 2.
  review: z.object({ requireBeforeGate2: z.boolean() }).default({ requireBeforeGate2: false }),
  sourceCheck: z
    .object({
      enabled: z.boolean(),
      maxPages: z.number().int().min(0).max(5),
      maxChars: z.number().int().min(1000).max(20_000),
      timeoutSeconds: z.number().int().min(1).max(30),
    })
    .default(DEFAULT_SOURCE_CHECK),
  qualityAlarm: z
    .object({
      enabled: z.boolean(),
      period: z.enum(['week', 'month']),
      dropPoints: z.number().int().min(1).max(100),
      costRisePercent: z.number().int().min(1).max(1000),
      minCases: z.number().int().min(1).max(1000),
    })
    .default(DEFAULT_QUALITY_ALARM),
  evals: z
    .object({
      sampleSize: z.number().int().min(3).max(100),
      regressionTolerance: z.number().min(0).max(1),
      judge: z.object({
        enabled: z.boolean(),
        weight: z.number().min(0).max(1),
        maxCostEurPerRun: z.number().min(0).max(1000),
        maxCasesPerAgent: z.number().int().min(1).max(100),
      }),
    })
    .default(DEFAULT_EVALS),
  fallback: z.object({ serverSide: z.boolean() }).default(DEFAULT_FALLBACK),
});
export type AiSettings = z.infer<typeof aiSettingsSchema>;

export const BUILTIN: ProviderConfig = {
  id: 'builtin',
  name: tr('de', m('aigw.provider.builtin')),
  kind: 'builtin',
  baseUrl: '',
  hosting: 'local',
  keySource: 'none',
};

const builtinModel = { provider: 'builtin', model: 'regelbasiert' };

/** Default tier and minimum score per agent. */
export const AGENT_DEFAULTS: Record<AgentName, { slot: ModelSlot; minScore: number; story: string }> = {
  coach: { slot: 'fast', minScore: 0.8, story: 'R2-16' },
  transcribe: { slot: 'speech', minScore: 0, story: 'R2-17' },
  describe_image: { slot: 'vision', minScore: 0, story: 'R2-17' },
  boundary: { slot: 'confidential', minScore: 0.9, story: 'R2-20' },
  short_analysis: { slot: 'fast', minScore: 0.7, story: 'R2-22' },
  triage_suggestion: { slot: 'fast', minScore: 0.6, story: 'R2-18' },
  reply_draft: { slot: 'fast', minScore: 0.8, story: 'R2-19' },
  discussion_summary: { slot: 'fast', minScore: 0.8, story: 'R2-21' },
  competition: { slot: 'deep', minScore: 0.8, story: 'R2-23' },
  patents: { slot: 'deep', minScore: 0.8, story: 'R2-24' },
  positioning: { slot: 'deep', minScore: 0.8, story: 'R2-25' },
  market_size: { slot: 'deep', minScore: 0.8, story: 'R2-26' },
  internal_market: { slot: 'deep', minScore: 0.8, story: 'R2-27' },
  business_case: { slot: 'deep', minScore: 0.8, story: 'R2-28' },
  risk_check: { slot: 'deep', minScore: 0.8, story: 'R2-29' },
  experiment: { slot: 'deep', minScore: 0.8, story: 'R2-30' },
  dossier_draft: { slot: 'deep', minScore: 0.8, story: 'R2-31' },
  gate2_brief: { slot: 'deep', minScore: 0.8, story: 'R2-33' },
  counterarguments: { slot: 'deep', minScore: 0.8, story: 'R2-34' },
  challenge_suggestions: { slot: 'deep', minScore: 0.8, story: 'R2-36' },
  success_story: { slot: 'fast', minScore: 0.8, story: 'R2-37' },
  // Released without the test set: the answer is a filter checked by code (R3-23) or a translation shown next to the original (R3-30).
  portfolio_query: { slot: 'fast', minScore: 0, story: 'R3-23' },
  translate: { slot: 'fast', minScore: 0, story: 'R3-30' },
  implementation_package: { slot: 'deep', minScore: 0.8, story: 'R3-18' },
  // Released without the test set: a proposal for the process settings that an admin confirms (R3-03).
  process_proposal: { slot: 'fast', minScore: 0, story: 'R3-03' },
  // Released without the test set: the results are suggestions that a person adopts, links or
  // dismisses (R4-02, R4-11), and clusters that only count and summarise (R4-01).
  trend_digest: { slot: 'fast', minScore: 0, story: 'R4-02' },
  trend_assign: { slot: 'fast', minScore: 0, story: 'R4-11' },
  problem_clusters: { slot: 'fast', minScore: 0, story: 'R4-01' },
  // Released without the test set: every cleaned row is shown next to the original and a person confirms the import (R4-12).
  import_cleanup: { slot: 'fast', minScore: 0, story: 'R4-12' },
  // Only in evaluation runs, when the LLM-as-judge is switched on (R2-12); never sees real ideas.
  eval_judge: { slot: 'deep', minScore: 0, story: 'R2-12' },
};

export const defaultAiSettings: AiSettings = {
  enabled: true,
  providers: [BUILTIN],
  models: { fast: builtinModel, deep: builtinModel, vision: builtinModel, speech: builtinModel, confidential: builtinModel },
  agents: {},
  // List prices of the vendors converted 1:1; please check against your own contract.
  prices: [
    { model: 'regelbasiert', inputPerMTok: 0, outputPerMTok: 0 },
    { model: 'claude-opus-5-5', inputPerMTok: 4, outputPerMTok: 20 },
    { model: 'claude-sonnet-5-5', inputPerMTok: 2, outputPerMTok: 10 },
    { model: 'claude-haiku-5-5', inputPerMTok: 0.1, outputPerMTok: 0.5 },
    { model: 'claude-fable-5-1', inputPerMTok: 10, outputPerMTok: 50 },
  ],
  fallbackPrice: { inputPerMTok: 5, outputPerMTok: 25 },
  budget: { perIdeaEur: 5, perMonthEur: 200 },
  search: { kind: 'none', baseUrl: '', costPerQueryEur: 0.005, perMonthEur: 20, maxQueriesPerRun: 6 },
  autoShortAnalysis: true,
  autoFullAnalysis: true,
  tone: tr('de', m('aigw.defaultTone')),
  internalTerms: [],
  requireEval: true,
  releaseOverrides: {},
  ideaTypes: DEFAULT_IDEA_TYPES,
  review: { requireBeforeGate2: false },
  sourceCheck: DEFAULT_SOURCE_CHECK,
  qualityAlarm: DEFAULT_QUALITY_ALARM,
  evals: DEFAULT_EVALS,
  fallback: DEFAULT_FALLBACK,
};

/** Whether a building block of the full analysis runs for this idea type (R2-45). */
export function blockEnabled(ai: AiSettings, type: IdeaType, block: FullBlock): boolean {
  return ai.ideaTypes[type].blocks[block] !== false;
}

/** Templates offered in the admin UI when adding a provider, in the reader's language. */
export function providerTemplates(locale: Locale): (ProviderConfig & { models: string[]; note: string })[] {
  const t = (key: MessageKey) => tr(locale, m(key));
  return [
    {
      id: 'anthropic', name: 'Anthropic Claude', kind: 'anthropic', baseUrl: '', hosting: 'other', keySource: 'tenant',
      models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
      note: t('aigw.template.anthropic.note'),
    },
    {
      id: 'mistral', name: 'Mistral (EU)', kind: 'openai_compatible', baseUrl: 'https://api.mistral.ai/v1', hosting: 'eu', keySource: 'tenant',
      models: ['mistral-large-latest', 'mistral-small-latest'],
      note: t('aigw.template.mistral.note'),
    },
    {
      id: 'ollama', name: t('aigw.template.ollama.name'), kind: 'openai_compatible', baseUrl: 'http://localhost:11434/v1', hosting: 'local', keySource: 'none',
      models: ['llama3.3', 'mistral-small3.2', 'qwen3'],
      note: t('aigw.template.ollama.note'),
    },
    {
      id: 'own', name: t('aigw.template.own.name'), kind: 'openai_compatible', baseUrl: 'https://', hosting: 'eu', keySource: 'tenant',
      models: [],
      note: t('aigw.template.own.note'),
    },
  ];
}

/** Name of an AI building block in the reader's language. */
export const agentLabel = (locale: Locale, agent: string): string =>
  (AGENTS as readonly string[]).includes(agent) ? tr(locale, m(`aigw.agent.${agent}` as MessageKey)) : agent;

/** Provider name for display; the built-in provider is named in the reader's language. */
export const providerName = (locale: Locale, p: Pick<ProviderConfig, 'kind' | 'name'>): string =>
  p.kind === 'builtin' ? tr(locale, m('aigw.provider.builtin')) : p.name;
