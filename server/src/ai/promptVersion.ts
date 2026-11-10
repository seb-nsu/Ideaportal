import { createHash } from 'node:crypto';
import { defaultSettings } from '../lib/settings.js';
import {
  SYSTEM,
  boundaryCall,
  businessCaseCall,
  challengeSuggestionsCall,
  coachCall,
  competitionCall,
  counterCall,
  dossierCall,
  experimentCall,
  gate2Call,
  imageCall,
  internalMarketCall,
  marketSizeCall,
  patentsCall,
  positioningCall,
  replyCall,
  riskCall,
  shortAnalysisCall,
  successStoryCall,
  summaryCall,
  triageCall,
  type IdeaFacts,
} from './agents.js';
import type { Source } from './content.js';
import type { AgentCall } from './gateway.js';
import { strictJsonSchema } from './jsonSchema.js';
import { importCleanupCall } from './importCleanup.js';
import { portfolioQueryCall, translateCall } from './insights.js';
import { judgeCall } from './judge.js';
import { packageCall } from './package.js';
import { processProposalCall, TEMPLATE_INPUTS } from './process.js';
import { problemClustersCall, trendAssignCall, trendDigestCall } from './radar.js';
import { AGENTS, type AgentName } from './settings.js';

// Prompt version per agent (R2-12): a hash of the system text, the answer schema and the task
// prompt rendered for a fixed probe input, plus a manual suffix. Any edit of a prompt, a rule or
// a schema changes the version of exactly the agents it touches; the version is stored with every
// AI action and is part of the configuration hash, so the quality check runs again by itself.

/**
 * Manual suffix per agent: raise it when the behaviour of an agent changes without a change of
 * its prompt text (e.g. new post-processing in the gateway) and the test set must run again.
 */
export const PROMPT_SUFFIX: Partial<Record<AgentName, string>> = {};

const PROBE_IDEA: IdeaFacts = {
  id: null,
  title: 'Probe-Titel',
  problem: 'Probe-Problem mit Ursache.',
  solution: 'Probe-Lösung.',
  benefit: 'Probe-Nutzen 10 Stunden pro Monat.',
  topic: 'Probe-Themenfeld',
  ideaType: 'internal',
  confidential: false,
};
const PROBE_SOURCES: Source[] = [
  { id: 1, title: 'Probe-Quelle', url: 'https://example.org/probe', snippet: 'Probe-Auszug.', origin: 'web', retrievedAt: '2026-01-01' },
];
const product = { ...PROBE_IDEA, ideaType: 'product' as const };
const s = defaultSettings;

/** One or more probe calls per agent; agents with variants (idea type, problem) hash all of them. */
const PROBES: Partial<Record<AgentName, () => AgentCall<object>[]>> = {
  coach: () => [coachCall([{ role: 'user', text: 'Probe' }], { title: '', problem: '', solution: '', benefit: '' }, false)],
  describe_image: () => [imageCall({ mime: 'image/png', base64: '' }, false)],
  boundary: () => [boundaryCall('Probe', s)],
  short_analysis: () => [
    shortAnalysisCall(PROBE_IDEA, PROBE_SOURCES),
    shortAnalysisCall(product, PROBE_SOURCES),
    shortAnalysisCall({ ...PROBE_IDEA, kind: 'problem' }, PROBE_SOURCES),
  ],
  triage_suggestion: () => [triageCall(PROBE_IDEA, null, s)],
  reply_draft: () => [replyCall(PROBE_IDEA, 'elaborate', 'Probe', s)],
  discussion_summary: () => [summaryCall(PROBE_IDEA, [{ n: 1, body: 'Probe' }])],
  competition: () => [competitionCall(PROBE_IDEA, PROBE_SOURCES), competitionCall(product, PROBE_SOURCES)],
  patents: () => [patentsCall(PROBE_IDEA, PROBE_SOURCES)],
  positioning: () => [positioningCall(PROBE_IDEA, null)],
  market_size: () => [marketSizeCall(product, PROBE_SOURCES)],
  internal_market: () => [internalMarketCall(PROBE_IDEA, PROBE_SOURCES)],
  business_case: () => [businessCaseCall(PROBE_IDEA, {}, PROBE_SOURCES)],
  risk_check: () => [riskCall(PROBE_IDEA)],
  experiment: () => [experimentCall(PROBE_IDEA, null)],
  dossier_draft: () => [dossierCall(PROBE_IDEA, {})],
  gate2_brief: () => [gate2Call(PROBE_IDEA, {}, {}, PROBE_SOURCES)],
  counterarguments: () => [counterCall(PROBE_IDEA, {}, PROBE_SOURCES)],
  challenge_suggestions: () => [challengeSuggestionsCall('Probe', s)],
  success_story: () => [successStoryCall(PROBE_IDEA, { dossier: {}, benefit: null, review: null })],
  portfolio_query: () => [portfolioQueryCall('Probe', { today: '2026-01-01', topics: s.topics, challenges: [] })],
  translate: () => [translateCall('00000000-0000-0000-0000-000000000000', ['Probe'], 'en', false)],
  implementation_package: () => [packageCall(PROBE_IDEA, { dossier: {}, targetDate: null, channel: null })],
  process_proposal: () => [processProposalCall(TEMPLATE_INPUTS.innovation, s)],
  trend_digest: () => [trendDigestCall('Probe', PROBE_SOURCES)],
  trend_assign: () => [
    trendAssignCall([{ id: 't1', title: 'Probe', description: 'Probe', topic: 'Probe' }], [{ ref: 'idea:1', title: 'Probe', text: 'Probe' }]),
  ],
  problem_clusters: () => [problemClustersCall([{ ref: '1', text: 'Probe' }], 3)],
  import_cleanup: () => [importCleanupCall([{ row: 2, title: 'Probe', problem: 'Probe', solution: 'Probe', benefit: 'Probe', topic: '' }], s.topics, false)],
  eval_judge: () => [
    judgeCall(
      'short_analysis',
      { title: 'Probe', problem: 'Probe', solution: 'Probe', benefit: 'Probe', ideaType: 'internal', confidential: false },
      {},
      [],
      'de',
    ),
  ],
};

const cache = new Map<AgentName, string>();

function fingerprint(call: AgentCall<object>): unknown {
  return { system: call.system, schema: strictJsonSchema(call.schema), prompt: call.prompt, maxTokens: call.maxTokens, tools: call.tools ?? [] };
}

/** Prompt version of an agent, e.g. "a1b2c3d4e5f6" or "a1b2c3d4e5f6+2" with a manual suffix. */
export function agentPromptVersion(agent: AgentName): string {
  const hit = cache.get(agent);
  if (hit) return hit;
  let payload: unknown;
  try {
    const probe = PROBES[agent];
    // Agents without a model prompt (speech to text) depend on the system text only.
    payload = probe ? probe().map(fingerprint) : { system: SYSTEM };
  } catch {
    payload = { system: SYSTEM, agent };
  }
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 12);
  const suffix = PROMPT_SUFFIX[agent];
  const version = suffix ? `${hash}+${suffix}` : hash;
  cache.set(agent, version);
  return version;
}

/** Versions of all agents, e.g. for the configuration hash and the eval report. */
export function allPromptVersions(): Record<AgentName, string> {
  return Object.fromEntries(AGENTS.map((a) => [a, agentPromptVersion(a)])) as Record<AgentName, string>;
}

/** Tests only: forget cached versions after changing PROMPT_SUFFIX. */
export function resetPromptVersions(): void {
  cache.clear();
}
