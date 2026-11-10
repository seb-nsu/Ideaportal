import { createHash } from 'node:crypto';
import { recordAiCall } from '../lib/prometheus.js';
import { z } from 'zod';
import { withTenant } from '../db/pool.js';
import type { Ctx } from '../lib/context.js';
import { HttpError } from '../lib/errors.js';
import { m as msg, tr, type Locale, type Text } from '../i18n/index.js';
import type { Source } from './content.js';
import { createProvider, platformKey, ProviderError } from './providers.js';
import { strictJsonSchema } from './jsonSchema.js';
import { agentPromptVersion } from './promptVersion.js';
import { getSecret } from './secrets.js';
import { AGENT_DEFAULTS, BUILTIN, agentLabel, type AgentName, type AiSettings, type ProviderConfig } from './settings.js';

// The AI gateway (R2-09, R2-10): every model call goes through runAgent. It picks the model
// per agent and per sensitivity, enforces the cost limits, keeps confidential content on
// local models, validates the structured answer and writes the log entry.

export class AiError extends HttpError {
  constructor(message: Text, code = 'AI_UNAVAILABLE', readonly retryable = false) {
    super(409, message, code);
  }
}

export interface ResolvedModel {
  provider: ProviderConfig;
  model: string;
  local: boolean;
}

export function allProviders(ai: AiSettings): ProviderConfig[] {
  return ai.providers.some((p) => p.id === BUILTIN.id) ? ai.providers : [BUILTIN, ...ai.providers];
}

/** Model for an agent; sensitive content (confidential ideas, possible reports) only goes to local models. */
export function resolveModel(ai: AiSettings, agent: AgentName, sensitive: boolean): ResolvedModel {
  const ref = sensitive ? ai.models.confidential : (ai.agents[agent]?.model ?? ai.models[AGENT_DEFAULTS[agent].slot]);
  const provider = allProviders(ai).find((p) => p.id === ref.provider);
  if (!provider) throw new AiError(msg('aigw.err.providerMissing', { provider: ref.provider }), 'AI_CONFIG');
  if (sensitive && provider.hosting !== 'local') {
    throw new AiError(msg('aigw.err.confidentialLocal'), 'AI_CONFIDENTIAL');
  }
  return { provider, model: provider.kind === 'builtin' ? 'regelbasiert' : ref.model, local: provider.hosting === 'local' };
}

export function priceFor(ai: AiSettings, m: ResolvedModel): { inputPerMTok: number; outputPerMTok: number } {
  const listed = ai.prices.find((p) => p.model === m.model);
  if (listed) return listed;
  if (m.provider.kind === 'builtin' || m.local) return { inputPerMTok: 0, outputPerMTok: 0 };
  return ai.fallbackPrice;
}

export function costEur(ai: AiSettings, m: ResolvedModel, inputTokens: number, outputTokens: number): number {
  const p = priceFor(ai, m);
  return Math.round(((inputTokens * p.inputPerMTok + outputTokens * p.outputPerMTok) / 1_000_000) * 10_000) / 10_000;
}

export async function spent(ctx: Ctx, ideaId: string | null): Promise<{ idea: number; month: number }> {
  const r = await withTenant(ctx.tenantId, (db) =>
    db.query<{ idea: number; month: number }>(
      `SELECT coalesce(sum(cost_eur) FILTER (WHERE idea_id = $1), 0)::float AS idea,
              coalesce(sum(cost_eur) FILTER (WHERE created_at >= date_trunc('month', $2::date)), 0)::float AS month
         FROM ai_actions`,
      [ideaId, ctx.today],
    ),
  );
  return r.rows[0];
}

async function providerKey(ctx: Ctx, p: ProviderConfig): Promise<string | null> {
  if (p.keySource === 'none') return null;
  if (p.keySource === 'platform') return platformKey(p);
  return withTenant(ctx.tenantId, async (db) => getSecret({ ...ctx, db }, `provider:${p.id}`));
}

export interface LogEntry {
  ideaId: string | null;
  agent: string;
  provider: string;
  model: string;
  local: boolean;
  status: 'ok' | 'error' | 'blocked' | 'budget' | 'refused' | 'skipped';
  input: unknown;
  output?: unknown;
  sources?: Source[];
  tools?: string[];
  /** Hosting of the provider at the time of the call (privacy proof, R2-42). */
  hosting?: 'local' | 'eu' | 'other';
  warnings?: string[];
  inputTokens?: number;
  outputTokens?: number;
  searchQueries?: number;
  costEur?: number;
  durationMs?: number;
  error?: string;
  /** Prompt version of the agent (hash of system text, schema and prompt template, R2-12). */
  promptVersion?: string;
  /** Model that actually answered, when it differs from the requested one (server-side fallback). */
  servedBy?: string;
  /** Whether the answering model passed the test set for this agent; null when no fallback happened. */
  modelChecked?: boolean | null;
}

/** Writes one entry of the AI log in its own transaction, so it survives a failing request. */
export async function logAction(ctx: Ctx, e: LogEntry): Promise<string> {
  // Prometheus counters (no tenant labels), see lib/prometheus.ts.
  recordAiCall(e.agent, e.status, e.local, e.costEur ?? 0);
  return withTenant(ctx.tenantId, async (db) =>
    (await db.query<{ id: string }>(
      `INSERT INTO ai_actions (tenant_id, idea_id, agent, provider, model, local, status, input, output, sources, tools, warnings,
                               input_tokens, output_tokens, search_queries, cost_eur, duration_ms, error, triggered_by, hosting,
                               prompt_version, served_by, model_checked)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23) RETURNING id`,
      [ctx.tenantId, e.ideaId, e.agent, e.provider, e.model, e.local, e.status, JSON.stringify(e.input ?? null),
       e.output === undefined ? null : JSON.stringify(e.output), JSON.stringify(e.sources ?? []), JSON.stringify(e.tools ?? []),
       JSON.stringify(e.warnings ?? []), e.inputTokens ?? 0, e.outputTokens ?? 0, e.searchQueries ?? 0, e.costEur ?? 0,
       e.durationMs ?? 0, e.error ?? null, ctx.user?.id ?? null, e.hosting ?? (e.local ? 'local' : null),
       e.promptVersion ?? null, e.servedBy ?? null, e.modelChecked ?? null],
    )).rows[0].id,
  );
}

export { strictJsonSchema };

export interface AgentCall<T> {
  agent: AgentName;
  ideaId: string | null;
  /** Confidential idea or text that may be a report: only a local model may see it. */
  sensitive: boolean;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxTokens: number;
  images?: { mime: string; base64: string }[];
  /** Rule-based answer of the builtin provider, in the output language of the call. */
  builtin: (locale: Locale) => T;
  /** Output language; by default the person's language for person-facing agents, else the workspace language (R3-22). */
  locale?: Locale;
  /** What the log stores as input; defaults to the prompt. */
  logInput?: unknown;
  sources?: Source[];
  tools?: string[];
  /** Hosting of the provider at the time of the call (privacy proof, R2-42). */
  hosting?: 'local' | 'eu' | 'other';
  /** Skip the release check (evaluation runs). */
  evaluation?: boolean;
}

export interface AgentRun<T> {
  output: T;
  actionId: string;
  model: string;
  provider: string;
  local: boolean;
  costEur: number;
  warnings: string[];
  /** Prompt version of the agent at the time of the call (R2-12). */
  promptVersion?: string;
  /** Set when a fallback model answered that did not pass the test set for this agent. */
  uncheckedModel?: string | null;
}

/** Checks the per-idea and monthly limits (R2-09). */
async function checkBudget(ctx: Ctx, ideaId: string | null): Promise<string | null> {
  const b = ctx.settings.ai.budget;
  const s = await spent(ctx, ideaId);
  if (s.month >= b.perMonthEur) return tr(ctx.locale, msg('aigw.err.budgetMonth', { limit: b.perMonthEur }));
  if (ideaId && s.idea >= b.perIdeaEur) return tr(ctx.locale, msg('aigw.err.budgetIdea', { limit: b.perIdeaEur }));
  return null;
}

/**
 * Cost estimate before a model call (R2-49): input from the prompt length (about four
 * characters per token, an image counts as 1,600 tokens) and output at the token ceiling of
 * the call, priced like the real call. It is an upper bound for the output.
 */
export function estimateCost(ai: AiSettings, m: ResolvedModel, call: { system: string; prompt: string; maxTokens: number; images?: unknown[] }): { inputTokens: number; outputTokens: number; eur: number } {
  const inputTokens = Math.ceil((call.system.length + call.prompt.length) / 4) + (call.images?.length ?? 0) * 1600;
  return { inputTokens, outputTokens: call.maxTokens, eur: costEur(ai, m, inputTokens, call.maxTokens) };
}

/** Message when spent plus estimate would exceed a limit, otherwise null. */
export function overBudget(ctx: Ctx, s: { idea: number; month: number }, ideaId: string | null, estimate: number): string | null {
  const b = ctx.settings.ai.budget;
  const fmt = (n: number) => n.toFixed(2);
  if (s.month + estimate > b.perMonthEur) return tr(ctx.locale, msg('aiq.budget.month', { estimate: fmt(estimate), spent: fmt(s.month), limit: b.perMonthEur }));
  if (ideaId && s.idea + estimate > b.perIdeaEur) return tr(ctx.locale, msg('aiq.budget.idea', { estimate: fmt(estimate), spent: fmt(s.idea), limit: b.perIdeaEur }));
  return null;
}

let releaseCheck: (ctx: Ctx, agent: AgentName) => Promise<void> = async () => undefined;

let quotaCheck: (ctx: Ctx, agent: AgentName, ideaId: string | null) => Promise<string | null> = async () => null;

/**
 * The billing module registers the AI quota of the package here (R3-06): before an external
 * model call it returns a message when the full analyses of the month are used up.
 */
export function setQuotaCheck(fn: typeof quotaCheck): void {
  quotaCheck = fn;
}

/**
 * Whether the answering model is the requested one: providers answer with the dated snapshot of an
 * alias (e.g. "model-20260101" for "model") or with an "org/" prefix; that is no fallback.
 */
export function sameModel(requested: string, served: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/^.*\//, '');
  const a = norm(requested);
  const b = norm(served);
  if (a === b) return true;
  // Only a snapshot suffix counts as the same model: a date or "latest".
  const rest = b.startsWith(a) ? b.slice(a.length) : '';
  return /^[-@:](\d{4}-?\d{2}-?\d{2}|latest)$/.test(rest);
}

let modelCheck: (ctx: Ctx, agent: AgentName, model: string) => Promise<boolean> = async () => false;

/**
 * The evaluation module registers the check for fallback models here (R2-12): whether a model
 * passed the test set for an agent with the current prompt version.
 */
export function setModelCheck(fn: typeof modelCheck): void {
  modelCheck = fn;
}

/** The evaluation module registers the quality gate here (avoids an import cycle). */
export function setReleaseCheck(fn: typeof releaseCheck): void {
  releaseCheck = fn;
}

/**
 * Output language (R3-22). German is the language of the prompts; for any other language the
 * gateway appends this rule to the system text. German calls stay exactly as before.
 */
export const LANGUAGE_RULE: Record<Locale, string> = {
  de: '',
  en: `
- Output language: English. Write every text value of your answer in English (British spelling), including headings, questions and drafts, even though these instructions are in German. This rule replaces "Schreibe auf Deutsch". Keep JSON keys and fixed values (for example "fact", "fast_lane", "low") exactly as specified.`,
};

// Agents whose answer goes straight back to the person who asked (R3-22). The other agents write
// results that are stored at the idea and read by several people: they use the workspace language.
const PERSON_FACING: ReadonlySet<AgentName> = new Set<AgentName>(['coach', 'reply_draft', 'discussion_summary', 'describe_image', 'transcribe', 'boundary', 'challenge_suggestions']);

/** Output language of a call (R3-22). */
export function outputLocale(ctx: Ctx, call: Pick<AgentCall<unknown>, 'agent' | 'locale'>): Locale {
  if (call.locale) return call.locale;
  return PERSON_FACING.has(call.agent) && ctx.user ? ctx.locale : ctx.settings.locale;
}

/** System text with the language rule; German calls keep the system text unchanged. */
export function systemFor(system: string, locale: Locale): string {
  return system + LANGUAGE_RULE[locale];
}

export async function runAgent<T>(ctx: Ctx, original: AgentCall<T>): Promise<AgentRun<T>> {
  const locale = outputLocale(ctx, original);
  const call: AgentCall<T> = { ...original, locale, system: systemFor(original.system, locale) };
  const ai = ctx.settings.ai;
  if (!ai.enabled) throw new AiError(msg('ai.disabled'), 'AI_DISABLED');
  if (ai.agents[call.agent]?.enabled === false) throw new AiError(msg('aigw.err.agentOff', { label: agentLabel(ctx.locale, call.agent) }), 'AI_DISABLED');
  const promptVersion = agentPromptVersion(call.agent);
  const logged = call.logInput ?? { prompt: call.prompt, images: call.images?.length ?? 0, promptVersion };
  // The log shows when an answer was requested in another language than German.
  const input = locale !== 'de' && logged && typeof logged === 'object' && !Array.isArray(logged) ? { ...logged, locale } : logged;
  let m: ResolvedModel;
  try {
    m = resolveModel(ai, call.agent, call.sensitive);
  } catch (err) {
    await logAction(ctx, { ideaId: call.ideaId, agent: call.agent, provider: '-', model: '-', local: false, status: 'blocked', input: { redacted: true }, error: (err as Error).message });
    throw err;
  }
  if (!call.evaluation) await releaseCheck(ctx, call.agent);
  const base = { ideaId: call.ideaId, agent: call.agent, provider: m.provider.id, model: m.model, local: m.local, hosting: m.provider.hosting, input, sources: call.sources, tools: call.tools, promptVersion };

  // AI quota of the package (R3-06): only external models count; builtin and own models cost no tokens.
  if (m.provider.kind !== 'builtin' && !m.local && !call.evaluation) {
    const quota = await quotaCheck(ctx, call.agent, call.ideaId);
    if (quota) {
      await logAction(ctx, { ...base, status: 'budget', error: quota });
      throw new AiError(quota, 'AI_QUOTA');
    }
  }

  if (m.provider.kind !== 'builtin') {
    const over = await checkBudget(ctx, call.ideaId);
    if (over) {
      await logAction(ctx, { ...base, status: 'budget', error: over });
      throw new AiError(over, 'AI_BUDGET');
    }
  }

  const started = Date.now();
  if (m.provider.kind === 'builtin') {
    const output = call.schema.parse(call.builtin(locale));
    const actionId = await logAction(ctx, { ...base, status: 'ok', output, durationMs: Date.now() - started });
    return { output, actionId, model: m.model, provider: m.provider.id, local: true, costEur: 0, warnings: [], promptVersion, uncheckedModel: null };
  }

  let inputTokens = 0;
  let outputTokens = 0;
  const warnings: string[] = [];
  // Server-side fallback (R2-12): an answer of another model is checked against the test set.
  const allowFallback = ai.fallback?.serverSide !== false;
  let servedBy: string | undefined;
  let modelChecked: boolean | null = null;
  let uncheckedModel: string | null = null;
  // Spent so far; each attempt is estimated before it is sent (R2-49).
  const already = await spent(ctx, call.ideaId);
  try {
    const provider = createProvider(m.provider, await providerKey(ctx, m.provider));
    const jsonSchema = strictJsonSchema(call.schema);
    const deep = AGENT_DEFAULTS[call.agent].slot === 'deep';
    let prompt = call.prompt;
    for (let attempt = 1; ; attempt++) {
      const est = estimateCost(ai, m, { ...call, prompt });
      const used = costEur(ai, m, inputTokens, outputTokens);
      const over = overBudget(ctx, { idea: already.idea + used, month: already.month + used }, call.ideaId, est.eur);
      if (over) {
        await logAction(ctx, { ...base, status: 'budget', inputTokens, outputTokens, costEur: used, durationMs: Date.now() - started, error: over, warnings: [...warnings, tr(ctx.locale, msg('aiq.budget.estimateNote', { eur: est.eur.toFixed(4), input: est.inputTokens, output: est.outputTokens }))] });
        throw new AiError(over, 'AI_BUDGET');
      }
      const res = await provider.generate({ model: m.model, system: call.system, prompt, schema: jsonSchema, maxTokens: call.maxTokens, images: call.images, deep, allowFallback });
      inputTokens += res.inputTokens;
      outputTokens += res.outputTokens;
      if (res.servedBy && !sameModel(m.model, res.servedBy) && servedBy !== res.servedBy) {
        servedBy = res.servedBy;
        modelChecked = await modelCheck(ctx, call.agent, res.servedBy).catch(() => false);
        if (modelChecked) {
          warnings.push(tr(locale, msg('aieval.fallback.checked', { model: res.servedBy })));
        } else {
          uncheckedModel = res.servedBy;
          warnings.unshift(tr(locale, msg('aieval.fallback.unchecked', { model: res.servedBy })));
        }
      }
      const fallbackLog = { servedBy, modelChecked };
      if (res.refused) {
        const cost = costEur(ai, m, inputTokens, outputTokens);
        await logAction(ctx, { ...base, ...fallbackLog, status: 'refused', inputTokens, outputTokens, costEur: cost, durationMs: Date.now() - started, warnings });
        throw new AiError(msg('aigw.err.refused'), 'AI_REFUSED');
      }
      const parsed = call.schema.safeParse(res.json);
      if (parsed.success) {
        const cost = costEur(ai, m, inputTokens, outputTokens);
        const actionId = await logAction(ctx, { ...base, ...fallbackLog, status: 'ok', output: parsed.data, inputTokens, outputTokens, costEur: cost, durationMs: Date.now() - started, warnings });
        return { output: parsed.data, actionId, model: m.model, provider: m.provider.id, local: m.local, costEur: cost, warnings, promptVersion, uncheckedModel };
      }
      if (attempt >= 2) throw new ProviderError(msg('aigw.err.formatTwice'));
      prompt = `${call.prompt}\n\nDeine letzte Antwort passte nicht zum Schema (${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}). Antworte erneut, nur mit gültigem JSON.`;
    }
  } catch (err) {
    if (err instanceof AiError) throw err;
    const text = err instanceof ProviderError ? err.text : msg('aigw.err.unreachable');
    await logAction(ctx, { ...base, servedBy, modelChecked, status: 'error', inputTokens, outputTokens, costEur: costEur(ai, m, inputTokens, outputTokens), durationMs: Date.now() - started, error: tr('de', text) });
    throw new AiError(text, 'AI_PROVIDER', err instanceof ProviderError ? err.retryable : true);
  }
}

/** Log input for texts that must not be stored (boundary check before saving, R2-20). */
export function redactedInput(text: string): { redacted: true; chars: number; sha256: string } {
  return { redacted: true, chars: text.length, sha256: createHash('sha256').update(text).digest('hex') };
}
