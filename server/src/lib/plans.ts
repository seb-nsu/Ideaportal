// Packages and feature switches (R3-05, R3-39). Prices and quotas follow the product concept
// (Teil B, Preismodell) and the finance model version 3. The catalogue is code; which package
// a workspace has, and single overrides of feature switches, are operator data (tenant_plans).
// Pure functions only: no database access here, so the request context can use it.

/** Feature switches that depend on the package. */
export const FEATURES = [
  'api', // API tokens and OpenAPI access with bearer tokens (R3-17)
  'webhooks', // outgoing webhooks (R3-17)
  'sso', // company login with OpenID Connect (R3-26)
  'scim', // user provisioning with SCIM (R3-27)
  'chat', // Slack and Microsoft Teams (R3-16)
  'connectors', // Jira, Azure DevOps, ServiceNow (R3-13 … R3-15)
  'externalParticipation', // external submitters per challenge (R3-19)
  'featureRequests', // feature requests with public status page (R3-20), module for product teams
  'crowdRating', // crowd rating in challenges (R2-51)
  'moduleZ', // module "Vorschlagswesen" (R3-35 ff.): switch only, nothing is built (AP-23)
] as const;
export type Feature = (typeof FEATURES)[number];
export type FeatureSet = Record<Feature, boolean>;

export const PLANS = ['internal', 'trial', 'team', 'business_1000', 'business_2500', 'enterprise', 'challenge'] as const;
export type PlanId = (typeof PLANS)[number];
/** Packages the operator can sell (internal and trial are states, not products). */
export const SALEABLE: readonly PlanId[] = ['team', 'business_1000', 'business_2500', 'enterprise', 'challenge'];

export const PLAN_STATUSES = ['trial', 'active', 'read_only', 'ended'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export interface PlanDef {
  id: PlanId;
  /** Monthly price in euro (net); for the challenge package the fixed price. null = no invoice. */
  priceEur: number | null;
  billing: 'none' | 'monthly' | 'once';
  /** Upper bound of employees for this package; null = no bound. */
  maxEmployees: number | null;
  /** Full analyses per month (R3-06); null = no quota. */
  fullAnalysesPerMonth: number | null;
  /** At most this many challenges while the package runs (R3-39); null = no limit. */
  maxChallenges: number | null;
  /** Fixed duration in days (trial 30, challenge 8 weeks); null = until changed. */
  durationDays: number | null;
  features: FeatureSet;
}

const none: FeatureSet = Object.fromEntries(FEATURES.map((f) => [f, false])) as FeatureSet;
const all: FeatureSet = { ...Object.fromEntries(FEATURES.map((f) => [f, true])), moduleZ: false } as FeatureSet;
const team: FeatureSet = { ...none, sso: true, chat: true };
const business: FeatureSet = { ...all };

// Enterprise is priced from 3,990 € per month; above ENTERPRISE_BASE_EMPLOYEES every further
// started 1,000 employees adds ENTERPRISE_STEP_EUR (assumption: the product concept names a
// step per 1,000 employees without a value).
export const ENTERPRISE_BASE_EMPLOYEES = 5000;
export const ENTERPRISE_STEP_EUR = 500;
/** VAT rate on the invoice drafts (Germany, B2B; reverse charge for customers abroad is open). */
export const VAT_RATE = 0.19;
/** Trial length after self-registration (R3-02). */
export const TRIAL_DAYS = 30;
/** Challenge package: one challenge over 8 weeks (R3-39). */
export const CHALLENGE_DAYS = 56;

export const PLAN_CATALOGUE: Record<PlanId, PlanDef> = {
  internal: { id: 'internal', priceEur: null, billing: 'none', maxEmployees: null, fullAnalysesPerMonth: null, maxChallenges: null, durationDays: null, features: all },
  // The trial shows everything a customer can buy (assumption), with the quota of the Team package.
  trial: { id: 'trial', priceEur: null, billing: 'none', maxEmployees: null, fullAnalysesPerMonth: 5, maxChallenges: null, durationDays: TRIAL_DAYS, features: all },
  team: { id: 'team', priceEur: 590, billing: 'monthly', maxEmployees: 500, fullAnalysesPerMonth: 5, maxChallenges: null, durationDays: null, features: team },
  business_1000: { id: 'business_1000', priceEur: 1490, billing: 'monthly', maxEmployees: 1000, fullAnalysesPerMonth: 20, maxChallenges: null, durationDays: null, features: business },
  business_2500: { id: 'business_2500', priceEur: 2490, billing: 'monthly', maxEmployees: 2500, fullAnalysesPerMonth: 40, maxChallenges: null, durationDays: null, features: business },
  // 80 full analyses per month (assumption; the finance model needs about 240 per year).
  enterprise: { id: 'enterprise', priceEur: 3990, billing: 'monthly', maxEmployees: null, fullAnalysesPerMonth: 80, maxChallenges: null, durationDays: null, features: all },
  // Challenge with phases, jury, crowd rating, result report and export; 10 full analyses (assumption).
  challenge: {
    id: 'challenge', priceEur: 2500, billing: 'once', maxEmployees: null, fullAnalysesPerMonth: 10, maxChallenges: 1, durationDays: CHALLENGE_DAYS,
    features: { ...none, crowdRating: true, externalParticipation: true },
  },
};

/** Package that fits a number of employees (R3-05: billed by employees, not by active users). */
export function planForEmployees(employees: number): PlanId {
  if (employees <= 500) return 'team';
  if (employees <= 1000) return 'business_1000';
  if (employees <= 2500) return 'business_2500';
  return 'enterprise';
}

/** Monthly (or one-time) net price of a package for a number of employees. */
export function planPrice(plan: PlanId, employees: number | null): number | null {
  const def = PLAN_CATALOGUE[plan];
  if (def.priceEur == null) return null;
  if (plan !== 'enterprise' || !employees || employees <= ENTERPRISE_BASE_EMPLOYEES) return def.priceEur;
  return def.priceEur + Math.ceil((employees - ENTERPRISE_BASE_EMPLOYEES) / 1000) * ENTERPRISE_STEP_EUR;
}

/** Feature switches of a package with the operator's overrides. Module Z stays a switch without code. */
export function resolveFeatures(plan: PlanId, overrides: Partial<Record<string, unknown>> | null | undefined): FeatureSet {
  const out = { ...PLAN_CATALOGUE[plan].features };
  for (const f of FEATURES) {
    const v = overrides?.[f];
    if (typeof v === 'boolean') out[f] = v;
  }
  return out;
}

/** Stored package of a workspace, as read with the request context. */
export interface PlanRow {
  plan: PlanId;
  status: PlanStatus;
  employees: number | null;
  starts_on: string;
  trial_ends_on: string | null;
  ends_on: string | null;
  feature_overrides: Record<string, unknown>;
  quota_override: number | null;
}

/** What the rest of the code needs to know about the package. */
export interface PlanState {
  plan: PlanId;
  status: PlanStatus;
  employees: number | null;
  startsOn: string | null;
  trialEndsOn: string | null;
  endsOn: string | null;
  features: FeatureSet;
  /** Full analyses per month without top-ups; null = no quota. */
  quota: number | null;
  maxChallenges: number | null;
  /** Writing is blocked: trial over without a package, challenge package ended. */
  readOnly: boolean;
}

export const INTERNAL_PLAN: PlanState = {
  plan: 'internal', status: 'active', employees: null, startsOn: null, trialEndsOn: null, endsOn: null,
  features: PLAN_CATALOGUE.internal.features, quota: null, maxChallenges: null, readOnly: false,
};

/** Limits the operator can set per tenant on top of the package (enterprise). */
export const LIMIT_KEYS = ['fullAnalysesPerMonth', 'maxChallenges'] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];

/** Operator override of one feature switch or limit (table tenant_overrides, not expired). */
export interface OverrideRow {
  key: string;
  kind: 'feature' | 'limit';
  bool_value: boolean | null;
  int_value: number | null;
}

/** Applies the operator's overrides on top of the package state (they win over the package). */
export function applyOverrides(state: PlanState, overrides: readonly OverrideRow[] | null | undefined): PlanState {
  if (!overrides?.length) return state;
  const out: PlanState = { ...state, features: { ...state.features } };
  for (const o of overrides) {
    if (o.kind === 'feature' && (FEATURES as readonly string[]).includes(o.key) && typeof o.bool_value === 'boolean') out.features[o.key as Feature] = o.bool_value;
    if (o.kind === 'limit' && typeof o.int_value === 'number') {
      if (o.key === 'fullAnalysesPerMonth') out.quota = o.int_value;
      if (o.key === 'maxChallenges') out.maxChallenges = o.int_value;
    }
  }
  return out;
}

/** Package state on a calendar day; no row means internal workspace. */
export function planState(row: PlanRow | null | undefined, today: string, overrides?: readonly OverrideRow[] | null): PlanState {
  return applyOverrides(basePlanState(row, today), overrides);
}

function basePlanState(row: PlanRow | null | undefined, today: string): PlanState {
  if (!row) return INTERNAL_PLAN;
  const def = PLAN_CATALOGUE[row.plan];
  const trialOver = row.plan === 'trial' && !!row.trial_ends_on && row.trial_ends_on < today;
  const challengeOver = row.plan === 'challenge' && !!row.ends_on && row.ends_on < today;
  return {
    plan: row.plan,
    status: row.status,
    employees: row.employees,
    startsOn: row.starts_on,
    trialEndsOn: row.trial_ends_on,
    endsOn: row.ends_on,
    features: resolveFeatures(row.plan, row.feature_overrides),
    quota: row.quota_override ?? def.fullAnalysesPerMonth,
    maxChallenges: def.maxChallenges,
    readOnly: row.status === 'read_only' || row.status === 'ended' || trialOver || challengeOver,
  };
}

/** Whole days from today until the given day (negative when it lies in the past). */
export function daysUntil(today: string, day: string): number {
  return Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export const monthStart = (day: string) => `${day.slice(0, 7)}-01`;

/** Last day of the month of the given day. */
export function monthEnd(day: string): string {
  const d = new Date(Date.parse(`${monthStart(day)}T00:00:00Z`));
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

export const previousMonth = (day: string) => monthStart(addDays(monthStart(day), -1));
