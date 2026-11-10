import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { isLocale, m, type Locale } from '../i18n/index.js';
import { defaultSettings, type Settings } from '../lib/settings.js';
import { AiError, costEur, sameModel, strictJsonSchema, systemFor, type AgentCall, type AgentRun } from './gateway.js';
import { agentsToEvaluate, runSuites, type Exec } from './evalCore.js';
import { casesOf, compareRuns, metricsOf, reportJson, reportMarkdown, type RunData } from './evalReport.js';
import { allPromptVersions } from './promptVersion.js';
import { createProvider, platformKey, ProviderError } from './providers.js';
import { AGENT_DEFAULTS, AGENTS, BUILTIN, DEFAULT_EVALS, defaultAiSettings, type AgentName, type AiSettings, type ProviderConfig } from './settings.js';
import { loadTestSet } from './testset.js';

// Evaluation from the command line (CI, R2-12): runs the test set against one model without a
// workspace database and exits with 1 when an agent misses its minimum score.
//
//   npm run eval -w server -- --provider builtin --out report.json
//   ANTHROPIC_API_KEY=… npm run eval -w server -- --provider anthropic --model claude-opus-5-5 --agents short_analysis,triage_suggestion
//   OPENAI_COMPATIBLE_API_KEY=… npm run eval -w server -- --provider openai-compatible --base-url https://api.mistral.ai/v1 --model mistral-large-latest
//
// Options: --sample <n> cases per expensive agent (default 15), --concurrency <n> (default 4 for
// models), --hosting local|eu|other (only "local" may see confidential cases), --judge (LLM-as-judge
// with the same model, weight --judge-weight 0.3), --baseline <report.json> (regressions against an
// earlier report), --markdown <file>, --locale de|en (report language), --min-score <0..1> (one
// threshold for all agents instead of the defaults), --no-fallback (no server-side fallback).

const USAGE =
  'Usage: npm run eval -w server -- [--provider builtin|anthropic|openai-compatible] [--model <id>] [--base-url <url>] [--agents a,b] [--sample 15] [--out report.json] [--markdown report.md] [--baseline old.json] [--judge] [--hosting local|eu|other] [--concurrency 4] [--min-score 0.8] [--locale de|en] [--no-fallback]';

export interface CliOptions {
  provider: 'builtin' | 'anthropic' | 'openai-compatible';
  model: string;
  baseUrl: string;
  hosting: 'local' | 'eu' | 'other';
  agents: AgentName[] | undefined;
  sample: number;
  concurrency: number;
  judge: boolean;
  judgeWeight: number;
  out: string | null;
  markdown: string | null;
  baseline: string | null;
  minScore: number | null;
  locale: Locale;
  fallback: boolean;
}

export function parseCli(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      provider: { type: 'string', default: 'builtin' },
      model: { type: 'string' },
      'base-url': { type: 'string', default: '' },
      hosting: { type: 'string' },
      agents: { type: 'string' },
      sample: { type: 'string', default: String(DEFAULT_EVALS.sampleSize) },
      concurrency: { type: 'string' },
      judge: { type: 'boolean', default: false },
      'judge-weight': { type: 'string', default: String(DEFAULT_EVALS.judge.weight) },
      out: { type: 'string' },
      markdown: { type: 'string' },
      baseline: { type: 'string' },
      'min-score': { type: 'string' },
      locale: { type: 'string', default: 'de' },
      'no-fallback': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) throw new UsageError(USAGE);
  const provider = values.provider as CliOptions['provider'];
  if (!['builtin', 'anthropic', 'openai-compatible'].includes(provider)) throw new UsageError(`Unknown provider "${values.provider}".\n${USAGE}`);
  if (provider !== 'builtin' && !values.model) throw new UsageError(`--model is required for provider ${provider}.`);
  if (provider === 'openai-compatible' && !values['base-url']) throw new UsageError('--base-url is required for provider openai-compatible.');
  const agents = values.agents
    ? values.agents
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean)
    : undefined;
  const unknown = agents?.filter((a) => !(AGENTS as readonly string[]).includes(a)) ?? [];
  if (unknown.length) throw new UsageError(`Unknown agents: ${unknown.join(', ')}`);
  const hosting = (values.hosting ?? (provider === 'builtin' ? 'local' : 'other')) as CliOptions['hosting'];
  if (!['local', 'eu', 'other'].includes(hosting)) throw new UsageError('--hosting must be local, eu or other.');
  const num = (v: string | undefined, name: string, min: number, max: number) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new UsageError(`--${name} must be between ${min} and ${max}.`);
    return n;
  };
  if (!isLocale(values.locale)) throw new UsageError('--locale must be de or en.');
  return {
    provider,
    model: provider === 'builtin' ? 'regelbasiert' : values.model!,
    baseUrl: values['base-url'] ?? '',
    hosting,
    agents: agents as AgentName[] | undefined,
    sample: Math.round(num(values.sample, 'sample', 1, 500)),
    concurrency: Math.round(num(values.concurrency ?? (provider === 'builtin' ? '1' : '4'), 'concurrency', 1, 32)),
    judge: values.judge ?? false,
    judgeWeight: num(values['judge-weight'], 'judge-weight', 0, 1),
    out: values.out ?? null,
    markdown: values.markdown ?? null,
    baseline: values.baseline ?? null,
    minScore: values['min-score'] != null ? num(values['min-score'], 'min-score', 0, 1) : null,
    locale: values.locale,
    fallback: !values['no-fallback'],
  };
}

export class UsageError extends Error {}

/** AI settings for one model in all slots; confidential content stays on the builtin provider unless the model is local. */
export function cliAiSettings(o: CliOptions): AiSettings {
  if (o.provider === 'builtin') return defaultAiSettings;
  const p: ProviderConfig = {
    id: 'cli',
    name: o.provider === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible',
    kind: o.provider === 'anthropic' ? 'anthropic' : 'openai_compatible',
    baseUrl: o.baseUrl,
    hosting: o.hosting,
    keySource: 'platform',
  }; // texts-ok: provider names
  const ref = { provider: 'cli', model: o.model };
  const confidential = o.hosting === 'local' ? ref : { provider: BUILTIN.id, model: 'regelbasiert' };
  return {
    ...defaultAiSettings,
    providers: [BUILTIN, p],
    models: { fast: ref, deep: ref, vision: ref, speech: ref, confidential },
    fallback: { serverSide: o.fallback },
  };
}

/** Direct model call without database: language rule, structured output, one retry, confidentiality. */
export function directExec(ai: AiSettings): Exec {
  const provider = ai.providers.find((p) => p.id === 'cli') ?? BUILTIN;
  const model = provider.kind === 'builtin' ? 'regelbasiert' : ai.models.fast.model;
  const local = provider.hosting === 'local';
  const resolved = { provider, model, local };
  return async <T extends object>(call: AgentCall<T>): Promise<AgentRun<T> & { servedBy?: string | null }> => {
    const locale = call.locale ?? 'de';
    const base = { actionId: '-', provider: provider.id, local, promptVersion: undefined };
    // Confidential ideas and possible reports never go to an external model (guardrail 5).
    if (call.sensitive && !local) throw new AiError(m('aigw.err.confidentialLocal'), 'AI_CONFIDENTIAL');
    if (provider.kind === 'builtin') return { ...base, output: call.schema.parse(call.builtin(locale)), model, costEur: 0, warnings: [], uncheckedModel: null };
    const client = createProvider(provider, platformKey(provider));
    const system = systemFor(call.system, locale);
    const schema = strictJsonSchema(call.schema);
    let prompt = call.prompt;
    let input = 0;
    let output = 0;
    try {
      for (let attempt = 1; ; attempt++) {
        const res = await client.generate({
          model,
          system,
          prompt,
          schema,
          maxTokens: call.maxTokens,
          images: call.images,
          deep: AGENT_DEFAULTS[call.agent].slot === 'deep',
          allowFallback: ai.fallback.serverSide,
        });
        input += res.inputTokens;
        output += res.outputTokens;
        if (res.refused) throw new AiError(m('aigw.err.refused'), 'AI_REFUSED');
        const parsed = call.schema.safeParse(res.json);
        const unchecked = res.servedBy && !sameModel(model, res.servedBy) ? res.servedBy : null;
        if (parsed.success) {
          return {
            ...base,
            output: parsed.data,
            model,
            costEur: costEur(ai, resolved, input, output),
            warnings: unchecked ? [`unchecked fallback model ${unchecked}`] : [],
            uncheckedModel: unchecked,
            servedBy: res.servedBy ?? null,
          };
        }
        if (attempt >= 2) throw new AiError(m('aigw.err.formatTwice'), 'AI_PROVIDER');
        prompt = `${call.prompt}\n\nDeine letzte Antwort passte nicht zum Schema (${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}). Antworte erneut, nur mit gültigem JSON.`;
      }
    } catch (err) {
      if (err instanceof AiError) throw err;
      throw new AiError(
        err instanceof ProviderError ? err.message : (err as Error).message,
        'AI_PROVIDER',
        err instanceof ProviderError ? err.retryable : true,
      );
    }
  };
}

export interface CliResult {
  exitCode: number;
  json: Record<string, unknown>;
  markdown: string;
}

/** Runs the evaluation for the options; used by main() and by tests. */
export async function runCli(o: CliOptions, exec?: Exec): Promise<CliResult> {
  const ai = cliAiSettings(o);
  const settings: Settings = { ...defaultSettings, ai };
  const set = loadTestSet();
  const min = (a: AgentName) => o.minScore ?? AGENT_DEFAULTS[a].minScore;
  const agents = agentsToEvaluate({ agents: o.agents, minScore: min, settings });
  if (!agents.length) throw new UsageError('No agent to evaluate (agents need a test suite and a minimum score above 0).');
  const started = new Date().toISOString();
  const results = await runSuites(set, {
    settings,
    exec: exec ?? directExec(ai),
    agents,
    sampleSize: o.sample,
    minScore: min,
    modelLabel: () => `${o.provider} / ${o.model}`,
    judge:
      o.judge && o.provider !== 'builtin'
        ? { enabled: true, weight: o.judgeWeight, maxCostEurPerRun: Number.POSITIVE_INFINITY, maxCasesPerAgent: o.sample }
        : null,
    concurrency: o.concurrency,
  });
  const metrics = metricsOf(results);
  const cases = casesOf(results);
  const run: RunData = {
    id: `cli-${started}`,
    createdAt: started,
    finishedAt: new Date().toISOString(),
    trigger: 'ci',
    status: 'done',
    configHash: '-',
    testsetVersion: set.version,
    costEur: Math.round(Object.values(results).reduce((s, r) => s + r.cases.reduce((x, c) => x + c.costEur, 0), 0) * 10_000) / 10_000,
    config: {
      provider: o.provider,
      model: o.model,
      hosting: o.hosting,
      sampleSize: o.sample,
      judge: o.judge,
      fallback: o.fallback,
      promptVersions: allPromptVersions(),
    },
    metrics,
    cases,
  };
  let comparison = null;
  if (o.baseline) {
    const prev = JSON.parse(readFileSync(o.baseline, 'utf8')) as {
      run: { id: string; createdAt: string };
      metrics: RunData['metrics'];
      cases: RunData['cases'];
    };
    comparison = compareRuns(
      { metrics, cases },
      { id: prev.run.id, createdAt: prev.run.createdAt, metrics: prev.metrics, cases: prev.cases },
      DEFAULT_EVALS.regressionTolerance,
    );
  }
  const failed = Object.values(metrics).filter((x) => !x.passed).length;
  return { exitCode: failed ? 1 : 0, json: reportJson(run, comparison), markdown: reportMarkdown(run, comparison, o.locale) };
}

async function main(): Promise<void> {
  let o: CliOptions;
  try {
    o = parseCli(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(err instanceof UsageError ? 2 : 1);
  }
  try {
    const res = await runCli(o);
    if (o.out) writeFileSync(o.out, `${JSON.stringify(res.json, null, 2)}\n`);
    if (o.markdown) writeFileSync(o.markdown, res.markdown);
    console.log(res.markdown);
    process.exit(res.exitCode);
  } catch (err) {
    console.error(`Evaluation failed: ${(err as Error).message}`);
    process.exit(err instanceof UsageError ? 2 : 1);
  }
}

if (process.argv[1] && /eval-cli\.(ts|js)$/.test(process.argv[1])) void main();
