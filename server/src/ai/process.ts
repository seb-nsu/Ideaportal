import { z } from 'zod';
import { m, tr, type Locale, type MessageKey, type Vars } from '../i18n/index.js';
import type { Settings } from '../lib/settings.js';
import { SYSTEM, fence } from './agents.js';
import type { AgentCall } from './gateway.js';

// AI proposal for the process (R3-03): an admin describes the process in a few fields and free
// text; the AI proposes lanes, thresholds, deadlines and scorecard weights. The proposal is
// information only: it changes nothing until an admin confirms it, and every value stays
// editable in the settings afterwards. The builtin provider answers with fixed rules.

export const PROCESS_TEMPLATES = ['innovation', 'product'] as const;
export type ProcessTemplate = (typeof PROCESS_TEMPLATES)[number];
const LANES = ['fast_lane', 'elaborate', 'forward', 'reject'] as const;

export const processInput = z.object({
  template: z.enum(PROCESS_TEMPLATES),
  employees: z.number().int().min(1).max(1_000_000).nullable().default(null),
  ideasPerYear: z.number().int().min(0).max(100_000).nullable().default(null),
  /** People who triage ideas at Gate 1. */
  reviewers: z.number().int().min(1).max(100).nullable().default(null),
  /** A committee decides at Gate 2 on fixed dates. */
  committee: z.boolean().default(true),
  /** Budget a department may spend without the committee (fast lane). */
  fastLaneBudgetEur: z.number().min(0).max(1_000_000).nullable().default(null),
  description: z.string().trim().max(3000).default(''),
});
export type ProcessInput = z.infer<typeof processInput>;

export const processProposalSchema = z.object({
  thresholds: z.object({
    fastLaneMaxPersonDays: z.number().min(0).max(250),
    fastLaneMaxEuro: z.number().min(0).max(1_000_000),
    delegationMaxPersonDays: z.number().min(0).max(1000),
    delegationMaxEuro: z.number().min(0).max(5_000_000),
  }),
  deadlines: z.object({
    gate1Workdays: z.number().int().min(1).max(60),
    elaborationWorkdays: z.number().int().min(1).max(120),
  }),
  weights: z.array(z.object({ id: z.string().regex(/^[a-z0-9_]{1,40}$/), weight: z.number().min(0).max(100), reason: z.string().max(300) })).min(1).max(12),
  lanes: z.array(z.object({ lane: z.enum(LANES), rule: z.string().min(1).max(400) })).min(4).max(4),
  rationale: z.array(z.string().min(1).max(400)).min(1).max(8),
});
export type ProcessProposal = z.infer<typeof processProposalSchema>;

const T = (l: Locale, key: MessageKey, vars?: Vars) => tr(l, m(key, vars));

// Preferred weights per template for the known criteria of the default scorecard.
const TEMPLATE_WEIGHTS: Record<ProcessTemplate, Record<string, number>> = {
  innovation: { strategic_fit: 25, user_value: 25, economic_value: 20, feasibility: 15, risk: 15 },
  product: { strategic_fit: 20, user_value: 35, economic_value: 25, feasibility: 10, risk: 10 },
};

/** Spreads weights over the given criteria so they add up to exactly 100 (whole numbers). */
export function normalizeWeights(ids: string[], wanted: Record<string, number>): Record<string, number> {
  const raw = ids.map((id) => Math.max(0, wanted[id] ?? 0));
  const sum = raw.reduce((a, b) => a + b, 0);
  const base = sum > 0 ? raw.map((w) => (w / sum) * 100) : ids.map(() => 100 / ids.length);
  const floor = base.map((w) => Math.floor(w));
  let rest = 100 - floor.reduce((a, b) => a + b, 0);
  // Largest remainders first, so the result is stable and adds up to 100.
  const order = base.map((w, i) => ({ i, r: w - floor[i] })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const o of order) {
    if (rest <= 0) break;
    floor[o.i]++;
    rest--;
  }
  return Object.fromEntries(ids.map((id, i) => [id, floor[i]]));
}

const round = (n: number, step: number) => Math.max(step, Math.round(n / step) * step);

/** Rule-based proposal (builtin provider and templates). */
export function ruleProposal(input: ProcessInput, criteria: Settings['scorecard']['criteria'], l: Locale): ProcessProposal {
  const product = input.template === 'product';
  const employees = input.employees ?? 1000;
  const ideas = input.ideasPerYear ?? Math.round(employees * (product ? 0.15 : 0.25));
  const reviewers = input.reviewers ?? 2;
  // Ideas per reviewer and working week (46 weeks): more load, longer Gate-1 deadline.
  const load = ideas / 46 / reviewers;
  const gate1 = load > 5 ? 15 : load > 2 ? 10 : 7;
  const elaboration = product ? 20 : 30;
  const fastEuro = input.fastLaneBudgetEur ?? (employees <= 500 ? 2000 : employees <= 2500 ? 5000 : 10000);
  const fastDays = product ? 3 : 5;
  const delegationFactor = input.committee ? 5 : 10;
  const text = input.description.toLowerCase();
  const wanted = { ...TEMPLATE_WEIGHTS[input.template] };
  const notes: string[] = [];
  if (/kosten|effizien|einspar|cost|efficien|saving/.test(text)) {
    wanted.economic_value = (wanted.economic_value ?? 0) + 5;
    wanted.user_value = Math.max(0, (wanted.user_value ?? 0) - 5);
    notes.push(T(l, 'process.rule.cost'));
  }
  if (/risiko|sicherheit|regul|compliance|risk|safety/.test(text)) {
    wanted.risk = (wanted.risk ?? 0) + 5;
    wanted.feasibility = Math.max(0, (wanted.feasibility ?? 0) - 5);
    notes.push(T(l, 'process.rule.risk'));
  }
  const ids = criteria.map((c) => c.id);
  // Criteria the template does not know get the mean weight of the known ones.
  const known = ids.filter((id) => id in wanted);
  const mean = known.length ? known.reduce((s, id) => s + wanted[id], 0) / known.length : 20;
  for (const id of ids) if (!(id in wanted)) wanted[id] = mean;
  const weights = normalizeWeights(ids, wanted);
  const thresholds = {
    fastLaneMaxPersonDays: fastDays,
    fastLaneMaxEuro: round(fastEuro, 500),
    delegationMaxPersonDays: fastDays * delegationFactor,
    delegationMaxEuro: round(fastEuro * delegationFactor, 1000),
  };
  return {
    thresholds,
    deadlines: { gate1Workdays: gate1, elaborationWorkdays: elaboration },
    weights: ids.map((id) => ({ id, weight: weights[id], reason: T(l, product ? 'process.weight.product' : 'process.weight.innovation') })),
    lanes: [
      { lane: 'fast_lane', rule: T(l, 'process.lane.fast_lane', { days: thresholds.fastLaneMaxPersonDays, euro: thresholds.fastLaneMaxEuro }) },
      { lane: 'elaborate', rule: T(l, input.committee ? 'process.lane.elaborateCommittee' : 'process.lane.elaborateLead', { weeks: Math.round(elaboration / 5), days: thresholds.delegationMaxPersonDays, euro: thresholds.delegationMaxEuro }) },
      { lane: 'forward', rule: T(l, 'process.lane.forward') },
      { lane: 'reject', rule: T(l, 'process.lane.reject') },
    ],
    rationale: [
      T(l, 'process.rule.load', { ideas, reviewers, load: Math.round(load * 10) / 10, days: gate1 }),
      T(l, product ? 'process.rule.product' : 'process.rule.innovation', { days: elaboration }),
      T(l, 'process.rule.fastLane', { euro: thresholds.fastLaneMaxEuro, employees }),
      ...notes,
    ],
  };
}

/** Defaults of the two templates (R3-03 "Vorlagen für Innovations- und Produktteams"). */
export const TEMPLATE_INPUTS: Record<ProcessTemplate, ProcessInput> = {
  innovation: { template: 'innovation', employees: 1000, ideasPerYear: 250, reviewers: 3, committee: true, fastLaneBudgetEur: null, description: '' },
  product: { template: 'product', employees: 1000, ideasPerYear: 150, reviewers: 2, committee: true, fastLaneBudgetEur: null, description: '' },
};

export function processProposalCall(input: ProcessInput, settings: Settings): AgentCall<ProcessProposal> {
  const criteria = settings.scorecard.criteria;
  const current = {
    thresholds: settings.thresholds,
    deadlines: { gate1Workdays: settings.deadlines.gate1Workdays, elaborationWorkdays: settings.deadlines.elaborationWorkdays },
    scorecard: criteria.map((c) => ({ id: c.id, label: c.label, weight: c.weight })),
  };
  const facts = [
    `Vorlage: ${input.template === 'product' ? 'Produktteam (Kunden- und Produktideen)' : 'Innovationsteam (interne und strategische Ideen)'}`,
    `Mitarbeitende: ${input.employees ?? 'unbekannt'}`,
    `Erwartete Ideen pro Jahr: ${input.ideasPerYear ?? 'unbekannt'}`,
    `Personen in der Triage: ${input.reviewers ?? 'unbekannt'}`,
    `Gremium entscheidet an Gate 2: ${input.committee ? 'ja' : 'nein, die Bereichsleitung entscheidet'}`,
    `Budget der Fachbereiche ohne Gremium (Euro): ${input.fastLaneBudgetEur ?? 'unbekannt'}`,
  ].join('\n');
  return {
    agent: 'process_proposal',
    ideaId: null,
    sensitive: false,
    system: SYSTEM,
    maxTokens: 2000,
    tools: [],
    schema: processProposalSchema,
    prompt: `Schlage für das Ideenportal eines Unternehmens die Einstellungen des Ideenflusses vor. Der Ablauf: Gate 1 (Triage) wählt eine von vier Spuren – Schnellspur (kleine Ideen direkt umsetzen), Ausarbeiten (danach Entscheidung an Gate 2), Weiterleiten (an einen anderen Kanal), Ablehnen mit Begründung.
Liefere:
- thresholds: Obergrenzen der Schnellspur (Personentage, Euro) und der Delegation an die Bereichsleitung an Gate 2 (Personentage, Euro).
- deadlines: Frist für Gate 1 und für die Ausarbeitung in Arbeitstagen.
- weights: Gewichte in Prozent für genau diese Scorecard-Kriterien (IDs unverändert), zusammen 100, je mit kurzer Begründung.
- lanes: für jede der vier Spuren eine Regel in einem Satz, wann sie gewählt wird.
- rationale: 2 bis 5 kurze Begründungen. Alle Zahlen sind Schätzungen für den Start und später änderbar; bewerte keine Personen.

Angaben der Admin:
${fence('angaben', facts)}

Beschreibung des Prozesses in eigenen Worten:
${fence('beschreibung', input.description || '(keine)')}

Aktuelle Einstellungen:
${fence('einstellungen', JSON.stringify(current))}`,
    builtin: (l) => ruleProposal(input, criteria, l),
    logInput: { input, criteria: criteria.map((c) => c.id) },
  };
}

/**
 * Applies a confirmed proposal to the settings: thresholds, the two deadlines and the weights
 * of the existing criteria (unknown IDs are ignored, the rest is scaled to 100).
 */
export function applyProposal(settings: Settings, p: ProcessProposal): Settings {
  const ids = settings.scorecard.criteria.map((c) => c.id);
  const proposed = Object.fromEntries(p.weights.filter((w) => ids.includes(w.id)).map((w) => [w.id, w.weight]));
  const weights = Object.keys(proposed).length ? normalizeWeights(ids, proposed) : null;
  return {
    ...settings,
    thresholds: { ...p.thresholds },
    deadlines: { ...settings.deadlines, gate1Workdays: p.deadlines.gate1Workdays, elaborationWorkdays: p.deadlines.elaborationWorkdays },
    scorecard: { criteria: settings.scorecard.criteria.map((c) => (weights ? { ...c, weight: weights[c.id] } : c)) },
  };
}
