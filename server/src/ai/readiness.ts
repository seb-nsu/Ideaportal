import type { BusinessCase } from './calc.js';

// Readiness of a committee brief before Gate 2 (after founder-skill "plan": the verdict is
// computed from checks, never written by a model). It says how well a brief is backed up, not
// whether the idea is good: the committee decides.

export type ReadinessCheckId = 'business_case' | 'payback' | 'red_risks' | 'experiment' | 'reviews';

export interface ReadinessCheck {
  id: ReadinessCheckId;
  /** true: met, false: open, null: does not apply (e.g. no review required). */
  ok: boolean | null;
  /** Numbers for the text of the check (months, count). */
  vars: Record<string, number>;
}

export interface Readiness {
  ready: boolean;
  checks: ReadinessCheck[];
}

export interface ReadinessInput {
  /** Latest business case: null when none exists, computed null while values are open. */
  businessCase: { computed: BusinessCase | null } | null;
  riskLights: ('green' | 'yellow' | 'red')[];
  experiments: { done: number; running: number };
  reviews: { unchecked: number; required: boolean };
}

export function readiness(i: ReadinessInput): Readiness {
  const bc = i.businessCase?.computed ?? null;
  const base = bc?.scenarios.find((s) => s.name === 'base');
  const red = i.riskLights.filter((l) => l === 'red').length;
  const checks: ReadinessCheck[] = [
    { id: 'business_case', ok: !!bc, vars: {} },
    {
      id: 'payback',
      ok: base ? base.paybackMonths != null && base.paybackMonths <= bc!.horizonYears * 12 : null,
      vars: { months: base?.paybackMonths ?? 0, horizon: (bc?.horizonYears ?? 0) * 12 },
    },
    { id: 'red_risks', ok: i.riskLights.length ? red === 0 : null, vars: { n: red } },
    { id: 'experiment', ok: i.experiments.done > 0, vars: { done: i.experiments.done, running: i.experiments.running } },
    { id: 'reviews', ok: i.reviews.required ? i.reviews.unchecked === 0 : null, vars: { n: i.reviews.unchecked } },
  ];
  return { ready: checks.every((c) => c.ok !== false), checks };
}
