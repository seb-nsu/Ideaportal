import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locale } from '../i18n/index.js';
import type { IdeaFacts } from './agents.js';
import type { Source } from './content.js';

// The AI test set (R2-12, docs/release-0/ki/testsatz.md): ideas with expected results for
// boundary check, lane, topic, key points, forbidden content and prompt injection.

export type TestTag =
  'duplicate' | 'vague' | 'short' | 'long' | 'confidential' | 'boundary' | 'whistleblower' | 'personal_data' | 'injection' | 'indirect_injection' | 'english';

export interface TestSearchResult {
  title: string;
  url: string;
  snippet: string;
  origin?: 'web' | 'patent';
}

export interface TestIdea {
  id: string;
  ideaType: 'internal' | 'product';
  confidential: boolean;
  title: string;
  problem: string;
  solution: string;
  benefit: string;
  topic: string;
  /** Language of the idea text; the evaluation asks for answers in this language (R3-22). Default German. */
  language?: Locale;
  /** Edge-case categories of the case. */
  tags?: TestTag[];
  /** Search results handed to the research agents; may contain an indirect injection. */
  searchResults?: TestSearchResult[];
  expected: {
    boundary: null | 'report' | 'incident' | 'complaint' | 'safety';
    lane: 'fast_lane' | 'elaborate' | 'forward' | 'reject';
    topic: string;
    keyPoints: string[];
    /** Must-not: phrases that may appear in no AI output for this idea (case-insensitive). */
    forbidden: string[];
    injection: boolean;
    /** Personal data in the idea text (names, contact data) that drafts must not repeat. */
    personalData?: string[];
  };
  notes?: string;
}

export interface TestSet {
  version: number;
  description?: string;
  ideas: TestIdea[];
}

const here = path.dirname(fileURLToPath(import.meta.url));
let cached: TestSet | null = null;

export function loadTestSet(): TestSet {
  cached ??= JSON.parse(readFileSync(path.resolve(here, '../../testset/ki-testsatz.json'), 'utf8')) as TestSet;
  return cached;
}

export const factsOf = (t: TestIdea): IdeaFacts => ({
  id: null,
  title: t.title,
  problem: t.problem,
  solution: t.solution,
  benefit: t.benefit,
  topic: t.topic,
  ideaType: t.ideaType,
  confidential: t.confidential,
});
export const untrustedOf = (t: TestIdea): string => `${t.title}\n${t.problem}\n${t.solution}\n${t.benefit}`;
export const localeOf = (t: TestIdea): Locale => t.language ?? 'de';
export const hasTag = (t: TestIdea, tag: TestTag): boolean => !!t.tags?.includes(tag);

/** Search results of a case as numbered sources, like the research step would hand them over. */
export function sourcesOf(t: TestIdea, firstId = 1): Source[] {
  return (t.searchResults ?? []).map((r, i) => ({
    id: firstId + i,
    title: r.title,
    url: r.url,
    snippet: r.snippet,
    origin: r.origin ?? 'web',
    retrievedAt: '2026-10-01',
  }));
}

/**
 * Sample for the expensive agents (R2-12): up to a third of the slots for injection cases
 * (direct and indirect), the rest alternating internal and product ideas without boundary
 * cases, so both idea types, both languages and the edge cases are covered. Deterministic, so
 * two runs of the same configuration evaluate the same cases.
 */
export function sampleCases(ideas: TestIdea[], size: number): TestIdea[] {
  const n = Math.max(1, Math.min(size, ideas.length));
  const injections = ideas.filter((t) => t.expected.injection);
  const regular = ideas.filter((t) => !t.expected.injection && !t.expected.boundary);
  const internal = regular.filter((t) => t.ideaType === 'internal');
  const product = regular.filter((t) => t.ideaType === 'product');
  const pick: TestIdea[] = [];
  const injectionSlots = Math.min(injections.length, Math.ceil(n / 3));
  // Spread the injection picks over the list, so direct and indirect variants are both included.
  for (let i = 0; i < injectionSlots; i++) pick.push(injections[Math.floor((i * injections.length) / injectionSlots)]);
  for (let i = 0; pick.length < n && (i < internal.length || i < product.length); i++) {
    if (i < internal.length && pick.length < n) pick.push(internal[i]);
    if (i < product.length && pick.length < n) pick.push(product[i]);
  }
  return [...new Map(pick.map((t) => [t.id, t])).values()];
}
