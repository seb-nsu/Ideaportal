import type { FastifyRequest } from 'fastify';
import { withSystem, withTenant, type Db } from '../db/pool.js';
import { resolveModel, setQuotaCheck } from '../ai/gateway.js';
import type { AgentName } from '../ai/settings.js';
import type { Ctx, SessionUser } from '../lib/context.js';
import { HttpError, badRequest, forbidden } from '../lib/errors.js';
import { renderPdf, type Block } from '../lib/pdf.js';
import {
  CHALLENGE_DAYS, FEATURES, INTERNAL_PLAN, PLAN_CATALOGUE, SALEABLE, TRIAL_DAYS, VAT_RATE,
  addDays, daysUntil, monthEnd, monthStart, planPrice, planState, previousMonth,
  type Feature, type OverrideRow, type PlanId, type PlanRow, type PlanState,
} from '../lib/plans.js';
import { todayIn } from '../lib/workdays.js';
import { fmt, m, tr, type Locale } from '../i18n/index.js';
import { audit } from './audit.js';
import { notifyRoles } from './notify.js';
import { enforceTenantStatus } from './tenantLifecycle.js';

// Packages, feature switches, AI quota, trial and invoice drafts (R3-05, R3-06, R3-02, R3-39).
// No payment provider: invoices are drafts for the operator, payment collection is open.

// ---------------------------------------------------------------- feature switches

/** Whether the package of the workspace includes a feature; workspaces without a package have all. */
export function hasFeature(ctx: Pick<Ctx, 'plan'>, feature: Feature): boolean {
  return (ctx.plan ?? INTERNAL_PLAN).features[feature];
}

export function featureError(feature: Feature): HttpError {
  return new HttpError(403, m('billing.featureUnavailable'), 'FEATURE_UNAVAILABLE', { feature });
}

/** For routes of other work packages (connectors, external participation): throws 403 with an upgrade hint. */
export function requireFeature(ctx: Pick<Ctx, 'plan'>, feature: Feature): void {
  if (!hasFeature(ctx, feature)) throw featureError(feature);
}

/** Package state outside a request context (SCIM, company login, request guard). */
export async function loadPlanState(tenantId: string): Promise<PlanState> {
  const row = await withSystem(async (c) => (await c.query<{ plan: PlanRow | null; tz: string | null; overrides: OverrideRow[] | null }>(
    `SELECT (SELECT to_jsonb(p) FROM tenant_plans p WHERE p.tenant_id = t.id) AS plan, t.settings->>'timezone' AS tz,
            (SELECT jsonb_agg(jsonb_build_object('key', o.key, 'kind', o.kind, 'bool_value', o.bool_value, 'int_value', o.int_value))
               FROM tenant_overrides o WHERE o.tenant_id = t.id AND (o.expires_at IS NULL OR o.expires_at > now())) AS overrides
       FROM tenants t WHERE t.id = $1`,
    [tenantId],
  )).rows[0]);
  if (!row) return INTERNAL_PLAN;
  return planState(row.plan, todayIn(row.tz || 'Europe/Berlin'), row.overrides);
}

export async function assertFeature(tenantId: string, feature: Feature): Promise<void> {
  if (!(await loadPlanState(tenantId)).features[feature]) throw featureError(feature);
}

// Endpoints that belong to a feature. "write" = only changing requests, so pages can still
// read their state and show the upgrade hint. Kept in one place for the whole server.
const ROUTE_FEATURES: { prefix: string; feature: Feature; write?: boolean; exact?: boolean }[] = [
  { prefix: '/api/admin/api-tokens', feature: 'api' },
  { prefix: '/api/admin/webhooks', feature: 'webhooks' },
  { prefix: '/api/admin/identity/scim-tokens', feature: 'scim' },
  { prefix: '/api/admin/identity', feature: 'sso', write: true, exact: true },
  { prefix: '/api/admin/chat', feature: 'chat', write: true },
  { prefix: '/api/me/chat', feature: 'chat', write: true },
  // Connectors (R3-13 … R3-15) and external participation (R3-19): no new configuration
  // without the feature; external participation also checks hasFeature in its service.
  { prefix: '/api/admin/connectors', feature: 'connectors', write: true },
  { prefix: '/api/admin/external', feature: 'externalParticipation', write: true },
];

// While the workspace is read-only, people can still sign out, manage their own account and
// ask for a package.
const READ_ONLY_OPEN = ['/api/auth/', '/api/billing/', '/api/me'];
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export function routeFeature(method: string, path: string, technical = false): Feature | null {
  // API tokens act only while the package includes the API (R3-17).
  if (technical) return 'api';
  const write = !SAFE.has(method);
  for (const r of ROUTE_FEATURES) {
    const hit = r.exact ? path === r.prefix : path === r.prefix || path.startsWith(`${r.prefix}/`);
    if (hit && (!r.write || write)) return r.feature;
  }
  return null;
}

/**
 * Request guard (called by requireUser): feature switches of the package, read-only mode after
 * the trial or the challenge package, and the challenge limit of the challenge package.
 */
export async function enforcePlan(req: FastifyRequest, user: SessionUser): Promise<void> {
  // Suspended or deleted tenant (enterprise): refused before anything else.
  await enforceTenantStatus(req, user);
  const path = req.url.split('?')[0];
  const write = !SAFE.has(req.method);
  const feature = routeFeature(req.method, path, user.technical);
  if (!write && !feature) return;
  const state = await loadPlanState(user.tenantId);
  if (feature && !state.features[feature]) throw featureError(feature);
  if (write && state.readOnly && !READ_ONLY_OPEN.some((p) => path.startsWith(p))) {
    throw new HttpError(403, m(state.plan === 'challenge' ? 'billing.readOnlyChallenge' : 'billing.readOnly'), 'READ_ONLY');
  }
  if (req.method === 'POST' && path === '/api/challenges' && state.maxChallenges != null) {
    const n = await withTenant(user.tenantId, async (db) => (await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM challenges WHERE created_at >= $1::date', [state.startsOn ?? '1970-01-01'],
    )).rows[0].n);
    if (n >= state.maxChallenges) throw new HttpError(403, m('billing.challengeLimit', { max: state.maxChallenges }), 'PLAN_LIMIT');
  }
}

// ---------------------------------------------------------------- AI quota (R3-06)

// Building blocks of the full analysis; the quota counts full analyses, so only these agents
// are stopped at 100 %. Coach, short analysis and triage help keep working.
const QUOTA_AGENTS: ReadonlySet<AgentName> = new Set<AgentName>([
  'competition', 'patents', 'positioning', 'market_size', 'internal_market', 'business_case', 'risk_check', 'experiment', 'counterarguments', 'dossier_draft',
]);

/**
 * Full analyses of the month that used an external model: jobs that started this month and
 * produced at least one answer of a non-local model. Builtin and own (local) models cost no
 * tokens and are not counted. The running job of `runningIdea` is left out, so a started
 * analysis can finish.
 */
export async function fullAnalysesUsed(db: Db, month: string, runningIdea: string | null = null): Promise<number> {
  const r = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ai_jobs j
      WHERE j.kind = 'full_analysis' AND j.status IN ('done', 'running') AND j.started_at >= $1::date
        AND NOT (j.status = 'running' AND j.idea_id IS NOT DISTINCT FROM $2::uuid)
        AND EXISTS (SELECT 1 FROM ai_actions a WHERE a.idea_id = j.idea_id AND NOT a.local AND a.status = 'ok'
                      AND a.created_at >= j.started_at AND (j.finished_at IS NULL OR a.created_at <= j.finished_at))`,
    [month, runningIdea],
  );
  return r.rows[0].n;
}

export interface QuotaUsage {
  month: string;
  /** null = no quota (internal workspace). */
  limit: number | null;
  included: number | null;
  topups: number;
  used: number;
  percent: number | null;
  /** Cost of all AI actions this month from the AI log (R2-49). */
  costEur: number;
}

export async function quotaUsage(db: Db, plan: PlanState, today: string, runningIdea: string | null = null): Promise<QuotaUsage> {
  const month = monthStart(today);
  const extra = await db.query<{ n: number; cost: number }>(
    `SELECT (SELECT coalesce(sum(analyses), 0)::int FROM ai_topups WHERE period = $1::date) AS n,
            (SELECT coalesce(sum(cost_eur), 0)::float FROM ai_actions WHERE created_at >= $1::date) AS cost`,
    [month],
  );
  const used = await fullAnalysesUsed(db, month, runningIdea);
  const limit = plan.quota == null ? null : plan.quota + extra.rows[0].n;
  return {
    month,
    limit,
    included: plan.quota,
    topups: extra.rows[0].n,
    used,
    percent: limit == null ? null : limit === 0 ? 100 : Math.round((used / limit) * 100),
    costEur: Math.round(extra.rows[0].cost * 100) / 100,
  };
}

/** Message when the quota is used up, else null. */
export async function quotaBlocked(ctx: Ctx, runningIdea: string | null = null): Promise<string | null> {
  const plan = ctx.plan ?? INTERNAL_PLAN;
  if (plan.quota == null) return null;
  const u = await withTenant(ctx.tenantId, (db) => quotaUsage(db, plan, ctx.today, runningIdea));
  if (u.limit == null || u.used < u.limit) return null;
  return tr(ctx.locale, m('billing.quotaExhausted', { limit: u.limit }));
}

/** Whether a full analysis would run on an external model (only those count). */
function fullAnalysisExternal(ctx: Ctx): boolean {
  try {
    const r = resolveModel(ctx.settings.ai, 'competition', false);
    return r.provider.kind !== 'builtin' && !r.local;
  } catch {
    return false;
  }
}

/** Check before queueing a full analysis by hand: a clear message instead of a silent skip. */
export async function assertQuota(ctx: Ctx): Promise<void> {
  if (!fullAnalysisExternal(ctx)) return;
  const msg = await quotaBlocked(ctx);
  if (msg) throw new HttpError(409, msg, 'AI_QUOTA');
}

// The gateway asks before every external model call of a full analysis block (R2-49 logic).
setQuotaCheck(async (ctx, agent, ideaId) => (QUOTA_AGENTS.has(agent) ? quotaBlocked(ctx, ideaId) : null));

// ---------------------------------------------------------------- trial (R3-02)

/** Starts the 30-day trial of a new workspace (owner connection, inside the sign-up). */
export async function startTrial(c: Db, tenantId: string, today: string): Promise<void> {
  await c.query(
    `INSERT INTO tenant_plans (tenant_id, plan, status, starts_on, trial_ends_on, updated_by) VALUES ($1, 'trial', 'trial', $2, $3, 'signup')`,
    [tenantId, today, addDays(today, TRIAL_DAYS)],
  );
  await c.query(`INSERT INTO plan_changes (tenant_id, from_plan, to_plan, changed_by) VALUES ($1, NULL, 'trial', 'signup')`, [tenantId]);
}

async function noticeOnce(ctx: Ctx, key: string): Promise<boolean> {
  const r = await ctx.db.query('INSERT INTO billing_notices (tenant_id, key) VALUES ($1, $2) ON CONFLICT DO NOTHING', [ctx.tenantId, key]);
  return (r.rowCount ?? 0) > 0;
}

export interface BillingJobResult {
  notices: number;
  statusChanges: number;
}

/** Daily rules per workspace: trial reminders and end, end of the challenge package, quota warnings. */
export async function runBillingJobs(ctx: Ctx): Promise<BillingJobResult> {
  const res: BillingJobResult = { notices: 0, statusChanges: 0 };
  const p = ctx.plan;
  if (!p || p.plan === 'internal') return res;
  const notify = async (key: string, subject: Parameters<typeof m>, body: Parameters<typeof m>) => {
    if (!(await noticeOnce(ctx, key))) return;
    await notifyRoles(ctx, ['admin'], m(...subject), m(...body), undefined, 'tasks');
    res.notices++;
  };

  if (p.plan === 'trial' && p.trialEndsOn) {
    const left = daysUntil(ctx.today, p.trialEndsOn);
    if (left < 0) {
      if (p.status !== 'read_only') {
        await ctx.db.query(`UPDATE tenant_plans SET status = 'read_only' WHERE tenant_id = $1`, [ctx.tenantId]);
        await audit(ctx, 'plan.trial_ended', 'tenant', ctx.tenantId, { status: p.status }, { status: 'read_only' });
        res.statusChanges++;
      }
      await notify('trial:ended', ['billing.mail.trialEndedSubject'], ['billing.mail.trialEndedBody']);
    } else if (left <= 1) {
      await notify('trial:1', ['billing.mail.trialLastSubject'], ['billing.mail.trialBody', { days: left, date: p.trialEndsOn }]);
    } else if (left <= 7) {
      await notify('trial:7', ['billing.mail.trialSubject', { days: left }], ['billing.mail.trialBody', { days: left, date: p.trialEndsOn }]);
    }
  }

  // Challenge package (R3-39): ends automatically after 8 weeks with export and offer.
  if (p.plan === 'challenge' && p.endsOn && daysUntil(ctx.today, p.endsOn) < 0 && p.status !== 'ended') {
    await ctx.db.query(`UPDATE tenant_plans SET status = 'ended', offer_sent_at = now() WHERE tenant_id = $1`, [ctx.tenantId]);
    await audit(ctx, 'plan.challenge_ended', 'tenant', ctx.tenantId, { status: p.status }, { status: 'ended' });
    res.statusChanges++;
    await notify(`challenge:ended:${p.endsOn}`, ['billing.mail.challengeEndedSubject'], ['billing.mail.challengeEndedBody']);
  }

  if (p.quota != null && !p.readOnly) {
    const u = await quotaUsage(ctx.db, p, ctx.today);
    if (u.limit != null && u.limit > 0) {
      const month = u.month.slice(0, 7);
      if (u.used >= u.limit) {
        await notify(`quota100:${month}`, ['billing.mail.quotaFullSubject'], ['billing.mail.quotaFullBody', { used: u.used, limit: u.limit }]);
      } else if (u.used >= Math.ceil(u.limit * 0.8)) {
        await notify(`quota80:${month}`, ['billing.mail.quota80Subject'], ['billing.mail.quota80Body', { used: u.used, limit: u.limit }]);
      }
    }
  }
  return res;
}

// ---------------------------------------------------------------- package view for the workspace

export interface PlanView {
  plan: PlanId;
  status: PlanState['status'];
  readOnly: boolean;
  features: PlanState['features'];
  trialEndsOn: string | null;
  trialDaysLeft: number | null;
  endsOn: string | null;
  daysLeft: number | null;
}

export function planView(ctx: Ctx): PlanView {
  const p = ctx.plan ?? INTERNAL_PLAN;
  return {
    plan: p.plan,
    status: p.status,
    readOnly: p.readOnly,
    features: p.features,
    trialEndsOn: p.trialEndsOn,
    trialDaysLeft: p.plan === 'trial' && p.trialEndsOn ? Math.max(0, daysUntil(ctx.today, p.trialEndsOn)) : null,
    endsOn: p.endsOn,
    daysLeft: p.plan === 'challenge' && p.endsOn ? Math.max(0, daysUntil(ctx.today, p.endsOn)) : null,
  };
}

/** Catalogue for the price sheet on the package page. */
export function catalogue() {
  return SALEABLE.map((id) => {
    const d = PLAN_CATALOGUE[id];
    return { id, priceEur: d.priceEur, billing: d.billing, maxEmployees: d.maxEmployees, fullAnalysesPerMonth: d.fullAnalysesPerMonth, durationDays: d.durationDays, features: d.features };
  });
}

// ---------------------------------------------------------------- operator: package, top-up, invoices

export interface PlanInput {
  plan: PlanId;
  employees?: number | null;
  startsOn?: string;
  featureOverrides?: Partial<Record<Feature, boolean>>;
  quotaOverride?: number | null;
  note?: string;
}

/** Writes an audit entry of an operator action into the workspace's audit log. */
async function operatorAudit(c: Db, tenantId: string, action: string, before: unknown, after: unknown) {
  await c.query('INSERT INTO audit_log (tenant_id, actor_id, action, entity, entity_id, before, after) VALUES ($1, NULL, $2, $3, $4, $5, $6)', [
    tenantId, action, 'tenant', tenantId, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after),
  ]);
}

/** Sets the package of a workspace (operator). Ends trial or read-only mode. */
export async function setPlan(c: Db, tenantId: string, input: PlanInput, operator: string, today: string): Promise<void> {
  const def = PLAN_CATALOGUE[input.plan];
  const employees = input.employees ?? null;
  if (def.billing === 'monthly' && !employees) throw badRequest(m('billing.employeesRequired'));
  if (def.maxEmployees != null && employees != null && employees > def.maxEmployees) {
    throw badRequest(m('billing.employeesTooMany', { max: def.maxEmployees }));
  }
  const before = (await c.query<PlanRow & { plan: PlanId }>('SELECT * FROM tenant_plans WHERE tenant_id = $1 FOR UPDATE', [tenantId])).rows[0] ?? null;
  const startsOn = input.startsOn ?? (before && before.plan === input.plan ? before.starts_on : today);
  const status = input.plan === 'trial' ? 'trial' : 'active';
  const trialEnds = input.plan === 'trial' ? (before?.plan === 'trial' ? before.trial_ends_on : addDays(startsOn, TRIAL_DAYS)) : null;
  const endsOn = input.plan === 'challenge' ? addDays(startsOn, CHALLENGE_DAYS - 1) : null;
  const overrides = Object.fromEntries(Object.entries(input.featureOverrides ?? {}).filter(([k, v]) => (FEATURES as readonly string[]).includes(k) && typeof v === 'boolean'));
  await c.query(
    `INSERT INTO tenant_plans (tenant_id, plan, status, employees, starts_on, trial_ends_on, ends_on, feature_overrides, quota_override, note, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
     ON CONFLICT (tenant_id) DO UPDATE SET plan = $2, status = $3, employees = $4, starts_on = $5, trial_ends_on = $6, ends_on = $7,
       feature_overrides = $8, quota_override = $9, note = $10, updated_by = $11, updated_at = now(),
       requested_plan = NULL, requested_employees = NULL, requested_at = NULL`,
    [tenantId, input.plan, status, employees, startsOn, trialEnds, endsOn, JSON.stringify(overrides), input.quotaOverride ?? null, input.note ?? (before as { note?: string } | null)?.note ?? '', operator],
  );
  if (before?.plan !== input.plan) {
    await c.query('INSERT INTO plan_changes (tenant_id, from_plan, to_plan, changed_by) VALUES ($1, $2, $3, $4)', [tenantId, before?.plan ?? null, input.plan, operator]);
  }
  await operatorAudit(c, tenantId, 'plan.set', before && { plan: before.plan, status: before.status, employees: before.employees }, { plan: input.plan, status, employees, startsOn, overrides, quotaOverride: input.quotaOverride ?? null });
  // The fixed price of the challenge package is invoiced once at the start (R3-39).
  if (input.plan === 'challenge' && before?.plan !== 'challenge') await createInvoice(c, tenantId, 'challenge', startsOn);
}

export async function bookTopup(c: Db, tenantId: string, input: { analyses: number; priceEur: number; note?: string; month?: string }, operator: string, today: string): Promise<string> {
  const period = monthStart(input.month ? `${input.month}-01` : today);
  const id = (await c.query<{ id: string }>(
    'INSERT INTO ai_topups (tenant_id, period, analyses, price_eur, note, booked_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [tenantId, period, input.analyses, input.priceEur, input.note ?? '', operator],
  )).rows[0].id;
  await operatorAudit(c, tenantId, 'ai.topup', null, { analyses: input.analyses, priceEur: input.priceEur, period });
  return id;
}

export interface InvoiceLine {
  key: 'license' | 'challenge' | 'topup';
  plan?: PlanId;
  quantity: number;
  amountEur: number;
  note?: string;
}

export interface InvoiceRow {
  id: string;
  tenant_id: string;
  number: string;
  kind: 'monthly' | 'challenge';
  period_start: string;
  period_end: string;
  plan: PlanId;
  quantity: number | null;
  lines: InvoiceLine[];
  net_eur: number;
  vat_rate: number;
  vat_eur: number;
  gross_eur: number;
  status: 'draft';
  created_at: Date;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Creates the invoice draft of a period (owner connection). Monthly: licence of the package
 * (full month, no proration) plus AI top-ups of the month. Challenge: the fixed price once.
 * Returns null when there is nothing to invoice; an existing draft is updated in place.
 */
export async function createInvoice(c: Db, tenantId: string, kind: 'monthly' | 'challenge', period: string): Promise<InvoiceRow | null> {
  const p = (await c.query<PlanRow>('SELECT * FROM tenant_plans WHERE tenant_id = $1', [tenantId])).rows[0];
  if (!p) return null;
  const start = kind === 'monthly' ? monthStart(period) : period;
  const end = kind === 'monthly' ? monthEnd(period) : addDays(period, CHALLENGE_DAYS - 1);
  const lines: InvoiceLine[] = [];
  if (kind === 'challenge') {
    lines.push({ key: 'challenge', plan: 'challenge', quantity: 1, amountEur: PLAN_CATALOGUE.challenge.priceEur! });
  } else {
    const def = PLAN_CATALOGUE[p.plan];
    if (def.billing === 'monthly' && p.starts_on <= end) {
      lines.push({ key: 'license', plan: p.plan, quantity: p.employees ?? 0, amountEur: planPrice(p.plan, p.employees)! });
    }
    const topups = await c.query<{ analyses: number; price_eur: number; note: string }>(
      'SELECT analyses, price_eur, note FROM ai_topups WHERE tenant_id = $1 AND period = $2 ORDER BY created_at', [tenantId, start],
    );
    for (const t of topups.rows) lines.push({ key: 'topup', quantity: t.analyses, amountEur: Number(t.price_eur), note: t.note || undefined });
  }
  if (!lines.length) return null;
  const net = round2(lines.reduce((s, l) => s + l.amountEur, 0));
  const vat = round2(net * VAT_RATE);
  const existing = (await c.query<{ id: string }>('SELECT id FROM invoices WHERE tenant_id = $1 AND kind = $2 AND period_start = $3', [tenantId, kind, start])).rows[0];
  const values = [JSON.stringify(lines), net, VAT_RATE, vat, round2(net + vat), kind === 'challenge' ? 'challenge' : p.plan, p.employees];
  if (existing) {
    return (await c.query<InvoiceRow>(
      'UPDATE invoices SET lines = $2, net_eur = $3, vat_rate = $4, vat_eur = $5, gross_eur = $6, plan = $7, quantity = $8 WHERE id = $1 RETURNING *',
      [existing.id, ...values],
    )).rows[0];
  }
  const seq = (await c.query<{ n: number }>(`SELECT nextval('invoice_number_seq')::int AS n`)).rows[0].n;
  const number = `IP-${start.slice(0, 4)}-${String(seq).padStart(5, '0')}`;
  return (await c.query<InvoiceRow>(
    `INSERT INTO invoices (tenant_id, number, kind, period_start, period_end, lines, net_eur, vat_rate, vat_eur, gross_eur, plan, quantity)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [tenantId, number, kind, start, end, ...values],
  )).rows[0];
}

/** Monthly invoice drafts of the previous month for every workspace with a package (job). */
export async function generateMonthlyInvoices(c: Db, today: string): Promise<number> {
  const month = previousMonth(today);
  const tenants = await c.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM tenant_plans p
      WHERE NOT EXISTS (SELECT 1 FROM invoices i WHERE i.tenant_id = p.tenant_id AND i.kind = 'monthly' AND i.period_start = $1)`,
    [month],
  );
  let n = 0;
  for (const t of tenants.rows) if (await createInvoice(c, t.tenant_id, 'monthly', month)) n++;
  return n;
}

const eur = (l: Locale, n: number) => `${n.toLocaleString(l === 'en' ? 'en-GB' : 'de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

/** Invoice draft as PDF (lib/pdf.ts), in the reader's language. */
export function invoicePdf(inv: InvoiceRow, tenantName: string, l: Locale): Buffer {
  const t = (key: Parameters<typeof m>[0], vars?: Parameters<typeof m>[1]) => tr(l, m(key, vars));
  const blocks: Block[] = [
    { kind: 'title', text: t('billing.pdf.title', { number: inv.number }) },
    { kind: 'text', text: t('billing.pdf.draftNote'), small: true },
    { kind: 'space' },
    { kind: 'row', label: t('billing.pdf.customer'), value: tenantName },
    { kind: 'row', label: t('billing.pdf.number'), value: inv.number },
    { kind: 'row', label: t('billing.pdf.date'), value: fmt.date(l, inv.created_at) },
    { kind: 'row', label: t('billing.pdf.period'), value: `${fmt.date(l, inv.period_start)} – ${fmt.date(l, inv.period_end)}` },
    { kind: 'row', label: t('billing.pdf.plan'), value: t(`billing.plan.${inv.plan}`) },
    ...(inv.quantity ? [{ kind: 'row' as const, label: t('billing.pdf.employees'), value: fmt.number(l, inv.quantity) }] : []),
    { kind: 'heading', text: t('billing.pdf.items') },
    ...inv.lines.map((line): Block => ({
      kind: 'row',
      label: eur(l, line.amountEur),
      value: line.key === 'topup'
        ? t('billing.pdf.lineTopup', { n: line.quantity }) + (line.note ? ` (${line.note})` : '')
        : line.key === 'challenge'
          ? t('billing.pdf.lineChallenge')
          : t('billing.pdf.lineLicense', { plan: t(`billing.plan.${line.plan ?? inv.plan}`), n: fmt.number(l, line.quantity) }),
    })),
    { kind: 'space' },
    { kind: 'row', label: t('billing.pdf.net'), value: eur(l, Number(inv.net_eur)) },
    { kind: 'row', label: t('billing.pdf.vat', { rate: Math.round(Number(inv.vat_rate) * 100) }), value: eur(l, Number(inv.vat_eur)) },
    { kind: 'row', label: t('billing.pdf.gross'), value: eur(l, Number(inv.gross_eur)) },
    { kind: 'space' },
    { kind: 'text', text: t('billing.pdf.payment'), small: true },
  ];
  return renderPdf(blocks, { title: t('billing.pdf.title', { number: inv.number }), footer: `Ideenportal · ${inv.number}` });
}

export const invoiceView = (i: InvoiceRow) => ({
  id: i.id, number: i.number, kind: i.kind, periodStart: i.period_start, periodEnd: i.period_end, plan: i.plan, quantity: i.quantity,
  lines: i.lines, netEur: Number(i.net_eur), vatRate: Number(i.vat_rate), vatEur: Number(i.vat_eur), grossEur: Number(i.gross_eur), status: i.status, createdAt: i.created_at,
});

/** Conversion rates for the operator (R3-39): challenge package and trial into an annual licence. */
export async function conversionKpis(c: Db) {
  const annual = ['team', 'business_1000', 'business_2500', 'enterprise'];
  const rate = async (from: PlanId) => {
    const r = (await c.query<{ started: number; converted: number; ended: number }>(
      `SELECT (SELECT count(DISTINCT tenant_id) FROM plan_changes WHERE to_plan = $1)::int AS started,
              (SELECT count(DISTINCT tenant_id) FROM plan_changes WHERE from_plan = $1 AND to_plan = ANY($2::text[]))::int AS converted,
              (SELECT count(*) FROM tenant_plans WHERE plan = $1 AND status IN ('ended', 'read_only'))::int AS ended`,
      [from, annual],
    )).rows[0];
    return { ...r, rate: r.started ? Math.round((r.converted / r.started) * 1000) / 10 : null };
  };
  return { challenge: await rate('challenge'), trial: await rate('trial') };
}

// ---------------------------------------------------------------- package request by the workspace

export async function requestPlan(ctx: Ctx, plan: PlanId, employees: number | null): Promise<void> {
  if (!SALEABLE.includes(plan)) throw badRequest(m('billing.unknownPlan'));
  if (!ctx.plan || ctx.plan.plan === 'internal') throw forbidden(m('billing.internal'));
  await ctx.db.query('UPDATE tenant_plans SET requested_plan = $2, requested_employees = $3, requested_at = now() WHERE tenant_id = $1', [ctx.tenantId, plan, employees]);
  await audit(ctx, 'plan.request', 'tenant', ctx.tenantId, null, { plan, employees });
}

// ---------------------------------------------------------------- challenge export (R3-39)

export interface ExportRow {
  challenge: string;
  number: number;
  title: string;
  status: string;
  submittedAt: string | null;
  crowdCount: number;
  crowdMean: number | null;
  juryCount: number;
  juryMean: number | null;
}

/**
 * Ideas and results of the challenges of the package (all challenges for other packages).
 * Crowd values only from the minimum group size; confidential ideas only with their number.
 */
export async function challengeExport(ctx: Ctx): Promise<ExportRow[]> {
  const since = ctx.plan?.plan === 'challenge' ? ctx.plan.startsOn : null;
  const r = await ctx.db.query<{ challenge: string; number: number; title: string; confidential: boolean; status: string; submitted_at: Date | null; crowd_n: number; crowd_mean: number | null; jury_n: number; jury_mean: number | null }>(
    `SELECT c.title AS challenge, i.number, i.title, i.confidential, i.status, i.submitted_at,
            (SELECT count(*)::int FROM challenge_ratings r WHERE r.idea_id = i.id) AS crowd_n,
            (SELECT round(avg(s.value::numeric), 2)::float FROM challenge_ratings r CROSS JOIN LATERAL jsonb_each_text(r.scores) s WHERE r.idea_id = i.id) AS crowd_mean,
            (SELECT count(*)::int FROM scorecards s WHERE s.idea_id = i.id AND s.context = 'jury') AS jury_n,
            (SELECT round(avg(s.total), 2)::float FROM scorecards s WHERE s.idea_id = i.id AND s.context = 'jury') AS jury_mean
       FROM challenges c JOIN ideas i ON i.challenge_id = c.id
      WHERE i.status <> 'draft' AND ($1::date IS NULL OR c.created_at >= $1::date)
      ORDER BY c.starts_on, jury_mean DESC NULLS LAST, i.number`,
    [since],
  );
  const min = ctx.settings.minGroupSize;
  return r.rows.map((x) => ({
    challenge: x.challenge,
    number: x.number,
    title: x.confidential ? tr(ctx.locale, m('billing.export.confidential', { number: x.number })) : x.title,
    status: tr(ctx.locale, m(`misc.status.${x.status}` as Parameters<typeof m>[0])),
    submittedAt: x.submitted_at ? new Date(x.submitted_at).toISOString().slice(0, 10) : null,
    crowdCount: x.crowd_n,
    crowdMean: x.crowd_n >= min ? x.crowd_mean : null,
    juryCount: x.jury_n,
    juryMean: x.jury_mean,
  }));
}

export function exportHeader(l: Locale): string[] {
  return ['challenge', 'number', 'title', 'status', 'submitted', 'crowdCount', 'crowdMean', 'juryCount', 'juryMean'].map((k) => tr(l, m(`billing.export.col.${k}` as Parameters<typeof m>[0])));
}

export function exportPdf(rows: ExportRow[], tenantName: string, l: Locale, minGroup: number): Buffer {
  const t = (key: Parameters<typeof m>[0], vars?: Parameters<typeof m>[1]) => tr(l, m(key, vars));
  const blocks: Block[] = [
    { kind: 'title', text: t('billing.export.title') },
    { kind: 'text', text: t('billing.export.intro', { name: tenantName, n: rows.length, min: minGroup }), small: true },
  ];
  let current = '';
  for (const r of rows) {
    if (r.challenge !== current) {
      current = r.challenge;
      blocks.push({ kind: 'heading', text: r.challenge });
    }
    blocks.push({
      kind: 'row',
      label: `#${r.number}`,
      value: t('billing.export.line', {
        title: r.title, status: r.status,
        crowd: r.crowdMean == null ? t('billing.export.crowdHidden', { n: r.crowdCount }) : `${r.crowdMean} (${r.crowdCount})`,
        jury: r.juryMean == null ? '–' : `${r.juryMean} (${r.juryCount})`,
      }),
    });
  }
  if (!rows.length) blocks.push({ kind: 'text', text: t('billing.export.empty') });
  return renderPdf(blocks, { title: t('billing.export.title'), footer: `Ideenportal · ${tenantName}` });
}


