import type { Ctx } from '../lib/context.js';
import { m, tr, type Locale, type MessageKey, type Vars } from '../i18n/index.js';
import { configHash, minScore, releaseState, type ReleaseState } from './eval.js';
import { agentName, type AgentMetric } from './evalReport.js';
import { allProviders, resolveModel } from './gateway.js';
import { agentPromptVersion } from './promptVersion.js';
import { AGENT_DEFAULTS, AGENTS, BUILTIN, MODEL_SLOTS, type AgentName, type AiSettings, type ModelSlot, type ProviderConfig } from './settings.js';

// Transparency about the AI in the portal (R3-22, EU AI Act Art. 13/50 in spirit): which
// building block does what, with which model and hosting, which data it receives, how it did in
// the test set and where people decide. Visible to every signed-in member of the workspace;
// it never shows keys, base URLs or who changed a setting.

/** Data categories a building block receives (besides the instructions). */
export type DataKind =
  'idea' | 'comments' | 'results' | 'web' | 'patents' | 'document' | 'audio' | 'image' | 'portfolio' | 'settings' | 'import' | 'feedback' | 'testset';

const DATA: Record<AgentName, DataKind[]> = {
  coach: ['idea'],
  transcribe: ['audio'],
  describe_image: ['image'],
  boundary: ['idea'],
  short_analysis: ['idea', 'web'],
  triage_suggestion: ['idea', 'results'],
  reply_draft: ['idea', 'results', 'settings'],
  discussion_summary: ['idea', 'comments'],
  competition: ['idea', 'web'],
  patents: ['idea', 'patents'],
  positioning: ['idea', 'results'],
  market_size: ['idea', 'web'],
  internal_market: ['idea', 'web'],
  business_case: ['idea', 'results'],
  risk_check: ['idea', 'results'],
  experiment: ['idea', 'results'],
  dossier_draft: ['idea', 'results'],
  gate2_brief: ['idea', 'results'],
  counterarguments: ['idea', 'results'],
  challenge_suggestions: ['document'],
  success_story: ['idea', 'results'],
  portfolio_query: ['portfolio'],
  translate: ['idea'],
  implementation_package: ['idea', 'results'],
  process_proposal: ['settings'],
  trend_digest: ['web'],
  trend_assign: ['web', 'idea', 'settings'],
  problem_clusters: ['feedback'],
  import_cleanup: ['import'],
  eval_judge: ['testset'],
};

/** Who decides about the result of a building block. */
export type Oversight = 'review' | 'gate' | 'confirm' | 'shown' | 'test';

const OVERSIGHT: Record<AgentName, Oversight> = {
  coach: 'confirm',
  transcribe: 'confirm',
  describe_image: 'confirm',
  boundary: 'shown',
  short_analysis: 'review',
  triage_suggestion: 'gate',
  reply_draft: 'confirm',
  discussion_summary: 'review',
  competition: 'review',
  patents: 'review',
  positioning: 'review',
  market_size: 'review',
  internal_market: 'review',
  business_case: 'review',
  risk_check: 'review',
  experiment: 'review',
  dossier_draft: 'review',
  gate2_brief: 'gate',
  counterarguments: 'gate',
  challenge_suggestions: 'confirm',
  success_story: 'confirm',
  portfolio_query: 'shown',
  translate: 'shown',
  implementation_package: 'confirm',
  process_proposal: 'confirm',
  trend_digest: 'review',
  trend_assign: 'confirm',
  problem_clusters: 'review',
  import_cleanup: 'confirm',
  eval_judge: 'test',
};

export interface ModelInfo {
  providerId: string;
  provider: string;
  kind: ProviderConfig['kind'];
  hosting: ProviderConfig['hosting'];
  model: string;
  local: boolean;
}

export interface ModelChange {
  at: string;
  agent: string;
  from: string | null;
  to: string;
}

export interface AgentTransparency {
  agent: AgentName;
  name: string;
  purpose: string;
  story: string;
  enabled: boolean;
  release: ReleaseState;
  model: ModelInfo | null;
  data: { kinds: DataKind[]; labels: string[]; note: string };
  promptVersion: string;
  evaluation: { at: string; score: number; minScore: number; passed: boolean; n: number; current: boolean; promptVersion: string | null } | null;
  oversight: { kind: Oversight; text: string };
  history: ModelChange[];
}

export interface Transparency {
  enabled: boolean;
  requireEval: boolean;
  fallbackServerSide: boolean;
  confidential: ModelInfo | null;
  models: ModelInfo[];
  agents: AgentTransparency[];
}

const T = (locale: Locale, key: string, vars?: Vars) => tr(locale, m(key as MessageKey, vars));

function info(p: ProviderConfig, model: string): ModelInfo {
  return {
    providerId: p.id,
    provider: p.name,
    kind: p.kind,
    hosting: p.hosting,
    model: p.kind === 'builtin' ? 'regelbasiert' : model,
    local: p.hosting === 'local',
  };
}

function modelFor(ai: AiSettings, agent: AgentName): ModelInfo | null {
  try {
    const r = resolveModel(ai, agent, agent === 'boundary');
    return info(r.provider, r.model);
  } catch {
    return null;
  }
}

/** Effective model of every agent in a settings snapshot, as "provider name / model". */
function effectiveModels(ai: Partial<AiSettings> | null | undefined): Map<AgentName, string> {
  const out = new Map<AgentName, string>();
  if (!ai?.models) return out;
  const listed = ai.providers ?? [];
  const providers = listed.some((p) => p.id === BUILTIN.id) ? listed : [BUILTIN, ...listed];
  for (const a of AGENTS) {
    const ref = a === 'boundary' ? ai.models.confidential : (ai.agents?.[a]?.model ?? ai.models[AGENT_DEFAULTS[a].slot as ModelSlot]);
    if (!ref) continue;
    const p = providers.find((x) => x.id === ref.provider);
    const kind = p?.kind ?? null;
    out.set(a, `${p?.name ?? ref.provider} / ${kind === 'builtin' ? 'regelbasiert' : ref.model}`);
  }
  return out;
}

/** Changes of the effective model per agent from the audit log (without the person who changed it). */
export async function modelHistory(c: Ctx, limit = 200): Promise<ModelChange[]> {
  const r = await c.db.query<{ created_at: Date; before: Partial<AiSettings> | null; after: Partial<AiSettings> | null }>(
    `SELECT created_at, before, after FROM audit_log WHERE action = 'settings.ai' ORDER BY created_at DESC, id DESC LIMIT $1`,
    [limit],
  );
  const changes: ModelChange[] = [];
  for (const row of r.rows) {
    const before = effectiveModels(row.before);
    const after = effectiveModels(row.after);
    for (const [agent, to] of after) {
      const from = before.get(agent) ?? null;
      if (from !== to) changes.push({ at: row.created_at.toISOString(), agent, from, to });
    }
  }
  return changes;
}

/** Last finished evaluation per agent; current = run for the configuration in use. */
async function lastEvaluations(c: Ctx, hash: string): Promise<Map<string, { at: string; metric: AgentMetric; current: boolean }>> {
  const r = await c.db.query<{ created_at: Date; config_hash: string; metrics: Record<string, AgentMetric> }>(
    `SELECT created_at, config_hash, metrics FROM ai_eval_runs WHERE status = 'done' ORDER BY created_at DESC LIMIT 20`,
  );
  const out = new Map<string, { at: string; metric: AgentMetric; current: boolean }>();
  for (const row of r.rows) {
    for (const [agent, metric] of Object.entries(row.metrics ?? {})) {
      if (!out.has(agent)) out.set(agent, { at: row.created_at.toISOString(), metric, current: row.config_hash === hash });
    }
  }
  return out;
}

export async function transparency(c: Ctx, locale: Locale): Promise<Transparency> {
  const ai = c.settings.ai;
  const hash = configHash(ai);
  const evals = await lastEvaluations(c, hash);
  const history = await modelHistory(c);
  const agents: AgentTransparency[] = [];
  for (const a of AGENTS) {
    const model = modelFor(ai, a);
    const ev = evals.get(a);
    const kinds = DATA[a];
    const note = !model
      ? ''
      : model.kind === 'builtin'
        ? T(locale, 'aieval.card.dataBuiltin')
        : model.local
          ? T(locale, 'aieval.card.dataLocal')
          : T(locale, 'aieval.card.dataExternal');
    agents.push({
      agent: a,
      name: agentName(locale, a),
      purpose: T(locale, `aieval.purpose.${a}`),
      story: AGENT_DEFAULTS[a].story,
      enabled: ai.enabled && ai.agents[a]?.enabled !== false,
      release: await releaseState(c, a),
      model,
      data: { kinds, labels: kinds.map((k) => T(locale, `aieval.data.${k}`)), note },
      promptVersion: agentPromptVersion(a),
      evaluation: ev
        ? {
            at: ev.at,
            score: ev.metric.score,
            minScore: ev.metric.minScore ?? minScore(ai, a),
            passed: ev.metric.passed,
            n: ev.metric.n,
            current: ev.current,
            promptVersion: ev.metric.promptVersion ?? null,
          }
        : null,
      oversight: { kind: OVERSIGHT[a], text: T(locale, `aieval.oversight.${OVERSIGHT[a]}`) },
      history: history.filter((h) => h.agent === a),
    });
  }
  const conf = allProviders(ai).find((p) => p.id === ai.models.confidential.provider);
  return {
    enabled: ai.enabled,
    requireEval: ai.requireEval,
    fallbackServerSide: ai.fallback?.serverSide !== false,
    confidential: conf ? info(conf, ai.models.confidential.model) : null,
    models: configuredModels(ai),
    agents,
  };
}

/** Every distinct provider and model the workspace uses in a slot or as an agent override. */
export function configuredModels(ai: AiSettings): ModelInfo[] {
  const providers = allProviders(ai);
  const seen = new Map<string, ModelInfo>();
  const refs = [...MODEL_SLOTS.map((s) => ai.models[s]), ...Object.values(ai.agents).flatMap((x) => (x?.model ? [x.model] : []))];
  for (const ref of refs) {
    const p = providers.find((x) => x.id === ref.provider);
    if (!p) continue;
    const i = info(p, ref.model);
    seen.set(`${i.providerId}/${i.model}`, i);
  }
  return [...seen.values()];
}

/** Model card in Markdown for one configured model (R3-22). */
export async function modelCard(c: Ctx, locale: Locale, providerId: string, model: string, workspace: string): Promise<string | null> {
  const ai = c.settings.ai;
  const target = configuredModels(ai).find((x) => x.providerId === providerId && x.model === model);
  if (!target) return null;
  const data = await transparency(c, locale);
  const using = data.agents.filter((a) => a.model?.providerId === providerId && a.model.model === target.model);
  const slots = MODEL_SLOTS.filter((s) => ai.models[s].provider === providerId && (target.kind === 'builtin' || ai.models[s].model === target.model));
  const X = (key: string, vars?: Vars) => T(locale, key, vars);
  const pct = (v: number) => `${Math.round(v * 100)} %`;
  const day = (iso: string) => iso.slice(0, 10);
  const L: string[] = [];
  L.push(`# ${X('aieval.card.title', { model: `${target.provider} / ${target.model}` })}`, '');
  L.push(X('aieval.card.generated', { date: day(new Date().toISOString()), workspace }), '');
  L.push(`## ${X('aieval.card.overview')}`, '');
  L.push(`- ${X('aieval.card.provider')}: ${target.provider}`);
  L.push(`- ${X('aieval.card.kind')}: ${X(`aieval.kind.${target.kind}`)}`);
  L.push(`- ${X('aieval.card.hosting')}: ${X(`aieval.hosting.${target.hosting}`)}`);
  L.push(`- ${X('aieval.card.slots')}: ${slots.length ? slots.map((s) => X(`aieval.slot.${s}`)).join(', ') : X('aieval.card.none')}`, '');
  L.push(`## ${X('aieval.card.use')}`, '');
  if (!using.length) L.push(X('aieval.card.none'));
  for (const a of using) L.push(`- **${a.name}** (\`${a.agent}\`): ${a.purpose}`);
  L.push('', `## ${X('aieval.card.data')}`, '');
  L.push(target.kind === 'builtin' ? X('aieval.card.dataBuiltin') : target.local ? X('aieval.card.dataLocal') : X('aieval.card.dataExternal'), '');
  L.push(`## ${X('aieval.card.guardrails')}`, '', X('aieval.card.guardrailsText'), '');
  L.push(`## ${X('aieval.card.evaluation')}`, '');
  const evaluated = using.filter((a) => a.evaluation);
  if (!evaluated.length) L.push(X('aieval.card.noEval'));
  for (const a of evaluated) {
    const e = a.evaluation!;
    L.push(
      `- ${X('aieval.card.evalLine', { agent: a.name, score: pct(e.score), min: pct(e.minScore), n: e.n, prompt: e.promptVersion ?? '–', status: X(e.passed ? 'aieval.report.passed' : 'aieval.report.failed'), date: day(e.at) })}`,
    );
  }
  L.push('', `## ${X('aieval.card.fallback')}`, '', data.fallbackServerSide ? X('aieval.card.fallbackOn') : X('aieval.card.fallbackOff'), '');
  L.push(`## ${X('aieval.card.history')}`, '');
  const label = `${target.provider} / ${target.model}`;
  const changes = data.agents.flatMap((a) => a.history.filter((h) => h.to === label || h.from === label).map((h) => ({ ...h, name: a.name })));
  if (!changes.length) L.push(X('aieval.card.noHistory'));
  for (const h of changes) L.push(`- ${day(h.at)}: ${h.name}: ${h.from ?? '–'} → ${h.to}`);
  L.push('', `## ${X('aieval.card.oversight')}`, '', X('aieval.card.oversightText'), '');
  L.push(`## ${X('aieval.card.limits')}`, '', X('aieval.card.limitsText'), '');
  return L.join('\n');
}
