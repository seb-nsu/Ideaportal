import { m, tr, type Locale, type MessageKey } from '../i18n/index.js';
// Numbers in analyses are computed in code from labelled assumptions, never by the model:
// business case (R2-28), market size (R2-26) and internal lever (R2-27).

export interface Range {
  low: number;
  high: number;
}

export interface Assumption {
  id: string;
  label: string;
  unit: string;
  kind: 'benefit' | 'one_off_cost' | 'running_cost';
  /** null: still to be clarified (builtin provider or a model that could not estimate it). */
  low: number | null;
  base: number | null;
  high: number | null;
  sources: number[];
}

export interface CompleteAssumption extends Assumption {
  low: number;
  base: number;
  high: number;
}

/** A business case is only computed when every value is known (R2-40). */
export function businessCaseComplete(items: Assumption[]): items is CompleteAssumption[] {
  return items.length > 0 && items.every((a) => a.low != null && a.base != null && a.high != null);
}

export interface Scenario {
  name: 'pessimistic' | 'base' | 'optimistic';
  annualBenefit: number;
  oneOffCost: number;
  annualRunningCost: number;
  annualNet: number;
  paybackMonths: number | null;
  netOverHorizon: number;
}

export interface BusinessCase {
  horizonYears: number;
  scenarios: Scenario[];
  sensitivity: { id: string; label: string; minus20: number; plus20: number }[];
}

const round = (n: number) => Math.round(n);

function scenario(name: Scenario['name'], items: CompleteAssumption[], horizonYears: number, pick: (a: CompleteAssumption) => number): Scenario {
  const sum = (kind: Assumption['kind']) => items.filter((a) => a.kind === kind).reduce((s, a) => s + pick(a), 0);
  const annualBenefit = sum('benefit');
  const oneOffCost = sum('one_off_cost');
  const annualRunningCost = sum('running_cost');
  const annualNet = annualBenefit - annualRunningCost;
  return {
    name,
    annualBenefit: round(annualBenefit),
    oneOffCost: round(oneOffCost),
    annualRunningCost: round(annualRunningCost),
    annualNet: round(annualNet),
    paybackMonths: annualNet > 0 ? Math.round((oneOffCost / annualNet) * 12 * 10) / 10 : null,
    netOverHorizon: round(annualNet * horizonYears - oneOffCost),
  };
}

/** Three scenarios and a ±20 % sensitivity of the base case per assumption. */
export function computeBusinessCase(items: CompleteAssumption[], horizonYears: number): BusinessCase {
  const years = Math.min(Math.max(horizonYears, 1), 10);
  // Pessimistic: low benefit, high cost; optimistic: the opposite.
  const pess = (a: CompleteAssumption) => (a.kind === 'benefit' ? a.low : a.high);
  const opt = (a: CompleteAssumption) => (a.kind === 'benefit' ? a.high : a.low);
  const base = scenario('base', items, years, (a) => a.base);
  const sensitivity = items.map((a) => {
    const vary = (f: number) => scenario('base', items, years, (x) => (x.id === a.id ? x.base * f : x.base)).netOverHorizon - base.netOverHorizon;
    return { id: a.id, label: a.label, minus20: round(vary(0.8)), plus20: round(vary(1.2)) };
  });
  sensitivity.sort((x, y) => Math.abs(y.plus20) - Math.abs(x.plus20));
  return { horizonYears: years, scenarios: [scenario('pessimistic', items, years, pess), base, scenario('optimistic', items, years, opt)], sensitivity };
}

export function businessCaseCsv(items: Assumption[], bc: BusinessCase, l: Locale = 'de'): string {
  const t = (key: string, vars?: Record<string, number>) => tr(l, m(key as MessageKey, vars));
  const esc = (v: string | number | null) => {
    const s = v === null ? '' : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // Headings in the reader's language (R3-22); numbers stay plain so spreadsheets can read them.
  const lines = [
    ['aiout.csv.assumption', 'aiout.csv.kind', 'aiout.csv.unit', 'aiout.csv.low', 'aiout.csv.base', 'aiout.csv.high'].map((k) => t(k)).join(';'),
    ...items.map((a) => [a.label, t(`aiout.csv.kind.${a.kind}`), a.unit, a.low, a.base, a.high].map(esc).join(';')),
    '',
    [t('aiout.csv.scenario'), t('aiout.csv.kind.benefit'), t('aiout.csv.kind.one_off_cost'), t('aiout.csv.kind.running_cost'), t('aiout.csv.netPerYear'), t('aiout.csv.payback'), t('aiout.csv.netOver', { years: bc.horizonYears })].join(';'),
    ...bc.scenarios.map((s) => [t(`aiout.csv.scenario.${s.name}`), s.annualBenefit, s.oneOffCost, s.annualRunningCost, s.annualNet, s.paybackMonths, s.netOverHorizon].map(esc).join(';')),
    '',
    [t('aiout.csv.sensitivity'), t('aiout.csv.minus20'), t('aiout.csv.plus20')].join(';'),
    ...bc.sensitivity.map((s) => [s.label, s.minus20, s.plus20].map(esc).join(';')),
    '',
    t('aiout.csv.note'),
  ];
  return lines.join('\n');
}

export interface MarketInputs {
  topDown: { totalMarketEur: Range; samShare: Range; somShare: Range };
  bottomUp: { customers: Range; revenuePerCustomerEur: Range; samShare: Range; somShare: Range };
}

export interface MarketSize {
  topDown: { tam: Range; sam: Range; som: Range };
  bottomUp: { tam: Range; sam: Range; som: Range };
  /** Relative gap between the midpoints of both SOM estimates (0.5 = 50 %). */
  somDeviation: number;
}

const mul = (a: Range, b: Range): Range => ({ low: a.low * b.low, high: a.high * b.high });
const pct = (r: Range): Range => ({ low: r.low / 100, high: r.high / 100 });
const roundRange = (r: Range): Range => ({ low: round(Math.min(r.low, r.high)), high: round(Math.max(r.low, r.high)) });
const mid = (r: Range) => (r.low + r.high) / 2;

/** TAM, SAM and SOM top-down and bottom-up as ranges, with the deviation of both methods. */
export function computeMarketSize(m: MarketInputs): MarketSize {
  const tdTam = m.topDown.totalMarketEur;
  const tdSam = mul(tdTam, pct(m.topDown.samShare));
  const tdSom = mul(tdSam, pct(m.topDown.somShare));
  const buTam = mul(m.bottomUp.customers, m.bottomUp.revenuePerCustomerEur);
  const buSam = mul(buTam, pct(m.bottomUp.samShare));
  const buSom = mul(buSam, pct(m.bottomUp.somShare));
  const a = mid(tdSom);
  const b = mid(buSom);
  const somDeviation = Math.max(a, b) > 0 ? Math.round((Math.abs(a - b) / Math.max(a, b)) * 100) / 100 : 0;
  return {
    topDown: { tam: roundRange(tdTam), sam: roundRange(tdSam), som: roundRange(tdSom) },
    bottomUp: { tam: roundRange(buTam), sam: roundRange(buSam), som: roundRange(buSom) },
    somDeviation,
  };
}

export interface LeverInputs {
  people: Range;
  minutesPerOccurrence: Range;
  occurrencesPerYear: Range;
  hourlyRateEur: number;
}

/** Internal lever: affected people × time × frequency (R2-27). */
export function computeLever(l: LeverInputs): { hoursPerYear: Range; eurPerYear: Range } {
  const hours = { low: (l.people.low * l.minutesPerOccurrence.low * l.occurrencesPerYear.low) / 60, high: (l.people.high * l.minutesPerOccurrence.high * l.occurrencesPerYear.high) / 60 };
  return { hoursPerYear: roundRange(hours), eurPerYear: roundRange({ low: hours.low * l.hourlyRateEur, high: hours.high * l.hourlyRateEur }) };
}
