import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AGENT_TOOLS } from '../ai/agents.js';
import { allProviders, resolveModel } from '../ai/gateway.js';
import { AGENTS, AGENT_DEFAULTS, agentLabel, blockEnabled, providerName, type AgentName, type AiSettings, type FullBlock } from '../ai/settings.js';
import { routeRights, type RouteRight } from '../http.js';
import { m, tr, fmt, type Locale, type MessageKey } from '../i18n/index.js';
import { PERMISSIONS, ROLES, can, type Ctx, type Permission, type Role, SCOPABLE_ROLES } from '../lib/context.js';
import { badRequest, errorText } from '../lib/errors.js';
import type { Block } from '../lib/pdf.js';
import { settingsSchema, type Settings } from '../lib/settings.js';
import { compileTemplate, type Template } from '../lib/template.js';
import { audit } from './audit.js';
import { scopedRolesOverview } from './areas.js';

// Co-determination (R3-12): one read-only overview for the works council and data protection
// of roles and rights, reports, AI functions, retention periods and logs, built from the code
// (permission table, route registry, agent list) and the tenant settings. Admins switch AI
// functions here; every change is audited and shown as change history. The model works
// agreement and the pilot toleration agreement are rendered from the same data.

// ---------------------------------------------------------------- registries

// consent: per person, only for people who agreed (leaderboard per challenge, R2-53).
type Aggregation = 'group' | 'idea' | 'person' | 'total' | 'consent';

/** Every report or analysis the product offers, with the endpoint that serves it. */
export const REPORTS: { key: string; method: 'GET' | 'POST'; url: string; aggregation: Aggregation }[] = [
  { key: 'dashboard', method: 'GET', url: '/api/dashboard', aggregation: 'group' },
  { key: 'dashboardCsv', method: 'GET', url: '/api/dashboard.csv', aggregation: 'group' },
  { key: 'challengeReport', method: 'GET', url: '/api/dashboard/challenges', aggregation: 'group' },
  { key: 'challengeReportCsv', method: 'GET', url: '/api/dashboard/challenges.csv', aggregation: 'group' },
  { key: 'crowdRating', method: 'GET', url: '/api/challenges/:id', aggregation: 'group' },
  { key: 'challengeImpact', method: 'GET', url: '/api/challenges/:id/use-cases', aggregation: 'idea' },
  { key: 'esgCsv', method: 'GET', url: '/api/challenges/:id/esg.csv', aggregation: 'idea' },
  { key: 'audienceVotes', method: 'GET', url: '/api/challenges/:id/use-cases', aggregation: 'total' },
  { key: 'aiQuality', method: 'GET', url: '/api/admin/ai/quality', aggregation: 'group' },
  { key: 'guarantee', method: 'GET', url: '/api/guarantee', aggregation: 'total' },
  { key: 'portfolio', method: 'GET', url: '/api/portfolio', aggregation: 'idea' },
  // Questions to the portfolio (R3-23): a list of ideas with read rights, never about people.
  { key: 'portfolioAsk', method: 'POST', url: '/api/portfolio/ask', aggregation: 'idea' },
  // Leaderboard per challenge (R2-53): only people who agreed, never in the dashboard, no export.
  { key: 'leaderboard', method: 'GET', url: '/api/challenges/:id/gamification', aggregation: 'consent' },
  { key: 'aiProofs', method: 'GET', url: '/api/ai/proofs', aggregation: 'idea' },
  { key: 'mentorLoad', method: 'GET', url: '/api/mentors/:userId/load', aggregation: 'person' },
  { key: 'auditLog', method: 'GET', url: '/api/admin/audit', aggregation: 'person' },
  { key: 'aiLog', method: 'GET', url: '/api/admin/ai/log', aggregation: 'person' },
];

type RetentionKey = keyof Settings['retention'];

/** Logs and protocols with the retention rule that applies to them. */
const PROTOCOLS: { key: string; retention: RetentionKey | 'never' | 'withIdea' | 'platform' }[] = [
  { key: 'audit', retention: 'never' },
  { key: 'aiActions', retention: 'aiActionsMonths' },
  { key: 'ideaEvents', retention: 'withIdea' },
  { key: 'dossierHistory', retention: 'withIdea' },
  { key: 'notifications', retention: 'notificationsMonths' },
  { key: 'aiUsage', retention: 'never' },
  { key: 'security', retention: 'platform' },
  { key: 'serverLogs', retention: 'platform' },
];

const RETENTION_KEYS: RetentionKey[] = ['closedIdeasMonths', 'notificationsMonths', 'anonymizeDeactivatedAfterDays', 'aiActionsMonths'];

/** Building block of the full analysis behind an agent and the idea types it serves (R2-45). */
const AGENT_BLOCK: Partial<Record<AgentName, { block: FullBlock; types: ('internal' | 'product')[] }>> = {
  competition: { block: 'competition', types: ['internal', 'product'] },
  patents: { block: 'patents', types: ['internal', 'product'] },
  positioning: { block: 'positioning', types: ['internal', 'product'] },
  market_size: { block: 'market', types: ['product'] },
  internal_market: { block: 'market', types: ['internal'] },
  business_case: { block: 'business_case', types: ['internal', 'product'] },
  risk_check: { block: 'risk_check', types: ['internal', 'product'] },
  experiment: { block: 'experiment', types: ['internal', 'product'] },
  counterarguments: { block: 'counterarguments', types: ['internal', 'product'] },
  dossier_draft: { block: 'dossier_draft', types: ['internal', 'product'] },
};

/** Audit actions shown as change history of the co-determination relevant settings. */
export const HISTORY_ACTIONS = ['settings.update', 'settings.ai', 'codetermination.ai_function', 'codetermination.settings', 'ai.release_override',
  'area.create', 'area.update', 'area.delete'] as const;

// ---------------------------------------------------------------- overview

const t = (l: Locale, key: string, vars?: Record<string, string | number>) => tr(l, m(key as MessageKey, vars));

function retentionText(l: Locale, s: Settings, rule: RetentionKey | 'never' | 'withIdea' | 'platform'): string {
  if (rule === 'never') return t(l, 'codet.retention.never');
  if (rule === 'platform') return t(l, 'codet.retention.platform');
  if (rule === 'withIdea') return s.retention.closedIdeasMonths > 0 ? t(l, 'codet.retention.withIdea', { n: s.retention.closedIdeasMonths }) : t(l, 'codet.retention.never');
  const n = s.retention[rule];
  if (rule === 'anonymizeDeactivatedAfterDays') return t(l, 'codet.retention.days', { n });
  if (rule === 'closedIdeasMonths' && n === 0) return t(l, 'codet.retention.never');
  return t(l, 'codet.retention.months', { n });
}

export function rolesOverview(l: Locale) {
  const routes = routeRights();
  const restricted = routes.filter((r) => r.roles);
  return {
    roles: ROLES.map((role) => ({
      role,
      label: t(l, `codet.role.${role}`),
      permissions: (Object.keys(PERMISSIONS) as Permission[])
        .filter((p) => (PERMISSIONS[p] as readonly Role[]).includes(role))
        .map((p) => ({ key: p, label: t(l, `codet.perm.${p}`) })),
      endpoints: restricted.filter((r) => r.roles!.includes(role)).map((r) => `${r.method} ${r.url}`),
    })),
    permissions: (Object.keys(PERMISSIONS) as Permission[]).map((p) => ({ key: p, label: t(l, `codet.perm.${p}`), roles: [...PERMISSIONS[p]] })),
    relations: ['author', 'mentor', 'implementer', 'sponsor', 'deputy'].map((k) => t(l, `codet.relation.${k}`)),
    endpoints: { total: routes.length, restricted: restricted.length, signedIn: routes.length - restricted.length },
  };
}

export function reportsOverview(l: Locale, s: Settings) {
  const routes = new Map<string, RouteRight>(routeRights().map((r) => [`${r.method} ${r.url}`, r]));
  return REPORTS.map((r) => {
    const route = routes.get(`${r.method} ${r.url}`);
    const roles = route?.roles ?? null;
    return {
      key: r.key,
      label: t(l, `codet.report.${r.key}`),
      purpose: t(l, `codet.report.${r.key}.purpose`),
      endpoint: `${r.method} ${r.url}`,
      aggregation: r.aggregation,
      aggregationText: t(l, `codet.aggregation.${r.aggregation}`, { n: s.minGroupSize }),
      minGroupSize: r.aggregation === 'group' ? s.minGroupSize : null,
      roles,
      roleLabels: roles ? roles.map((role) => t(l, `codet.role.${role}`)) : [t(l, 'codet.allSignedIn')],
    };
  });
}

export function aiOverview(l: Locale, ai: AiSettings) {
  const hosting = (h: string) => t(l, `codet.hosting.${h}`);
  let confidential: { provider: string; model: string; hosting: string } | { error: string };
  try {
    const cm = resolveModel(ai, 'boundary', true);
    confidential = { provider: cm.provider.name, model: cm.model, hosting: hosting(cm.provider.hosting) };
  } catch (err) {
    confidential = { error: (err as Error).message };
  }
  const functions = AGENTS.map((agent) => {
    const switchedOn = ai.agents[agent]?.enabled !== false;
    const block = AGENT_BLOCK[agent];
    const ideaTypes = block ? Object.fromEntries(block.types.map((type) => [type, blockEnabled(ai, type, block.block)])) as Partial<Record<'internal' | 'product', boolean>> : null;
    const byType = !ideaTypes || Object.values(ideaTypes).some(Boolean);
    let model: { provider: string; model: string; hosting: string; hostingKey: string } | { error: string };
    try {
      const rm = resolveModel(ai, agent, agent === 'boundary');
      model = { provider: providerName(l, rm.provider), model: rm.model, hosting: hosting(rm.provider.hosting), hostingKey: rm.provider.hosting };
    } catch (err) {
      model = { error: errorText(l, err) };
    }
    return {
      agent,
      label: agentLabel(l, agent),
      story: AGENT_DEFAULTS[agent].story,
      switchedOn,
      active: ai.enabled && switchedOn && byType,
      ideaTypes,
      model,
      data: t(l, `codet.agentData.${agent}`),
      webSearch: (AGENT_TOOLS[agent] ?? []).includes('web_search') && ai.search.kind !== 'none',
    };
  });
  const providers = allProviders(ai);
  return {
    enabled: ai.enabled,
    functions,
    providers: providers.map((p) => ({ id: p.id, name: p.name, hosting: hosting(p.hosting), hostingKey: p.hosting })),
    confidential,
    search: {
      kind: ai.search.kind,
      label: t(l, `codet.search.${ai.search.kind}`),
      internalShort: ai.ideaTypes.internal.shortWebSearch,
      productShort: ai.ideaTypes.product.shortWebSearch,
    },
    budget: ai.budget,
  };
}

export function retentionOverview(l: Locale, s: Settings) {
  return {
    periods: RETENTION_KEYS.map((key) => ({ key, label: t(l, `codet.retention.${key}`), value: s.retention[key], text: retentionText(l, s, key) })),
    protocols: PROTOCOLS.map((p) => ({ key: p.key, label: t(l, `codet.protocol.${p.key}`), content: t(l, `codet.protocol.${p.key}.content`), retention: retentionText(l, s, p.retention) })),
  };
}

/** Leaf paths that differ between two settings objects (values cut to 80 characters). */
export function diffPaths(before: unknown, after: unknown, prefix = '', out: { path: string; before: string; after: string }[] = []) {
  if (out.length >= 30) return out;
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (isObj(before) && isObj(after)) {
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) diffPaths(before[k], after[k], prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  const a = JSON.stringify(before ?? null);
  const b = JSON.stringify(after ?? null);
  if (a !== b) out.push({ path: prefix, before: a.length > 80 ? `${a.slice(0, 79)}…` : a, after: b.length > 80 ? `${b.slice(0, 79)}…` : b });
  return out;
}

export async function changeHistory(ctx: Ctx, limit = 100) {
  const r = await ctx.db.query<{ id: string; createdAt: string; actorName: string | null; action: string; before: unknown; after: unknown }>(
    `SELECT a.id, a.created_at AS "createdAt", u.display_name AS "actorName", a.action, a.before, a.after
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.action = ANY($1::text[]) ORDER BY a.id DESC LIMIT $2`,
    [HISTORY_ACTIONS, limit],
  );
  return r.rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    actorName: row.actorName,
    action: row.action,
    label: t(ctx.locale, `codet.history.${row.action}`),
    changes: diffPaths(row.before, row.after),
  }));
}

export async function overview(ctx: Ctx) {
  const s = ctx.settings;
  return {
    canEdit: can(ctx.user, 'configure'),
    minGroupSize: s.minGroupSize,
    ...rolesOverview(ctx.locale),
    // Roles with a scope (R3-29): areas, their membership rule and the number of people per role.
    scopedRoles: {
      roles: SCOPABLE_ROLES.map((role) => ({ role, label: t(ctx.locale, `codet.role.${role}`) })),
      areas: await scopedRolesOverview(ctx),
    },
    reports: reportsOverview(ctx.locale, s),
    ai: aiOverview(ctx.locale, s.ai),
    retention: retentionOverview(ctx.locale, s),
    history: await changeHistory(ctx),
    agreement: {
      settings: s.codetermination,
      templates: TEMPLATE_NAMES.map((name) => ({ name, title: t(ctx.locale, `codet.doc.${name}`), version: loadTemplate(name).version })),
    },
  };
}

// ---------------------------------------------------------------- changes (admin)

export async function setAiFunction(ctx: Ctx, agent: string, enabled: boolean) {
  if (!(AGENTS as readonly string[]).includes(agent)) throw badRequest(m('codet.unknownAgent'));
  const name = agent as AgentName;
  const before = ctx.settings.ai.agents[name]?.enabled !== false;
  const ai: AiSettings = { ...ctx.settings.ai, agents: { ...ctx.settings.ai.agents, [name]: { ...ctx.settings.ai.agents[name], enabled } } };
  await ctx.db.query('UPDATE tenants SET settings = $1 WHERE id = $2', [JSON.stringify({ ...ctx.settings, ai }), ctx.tenantId]);
  await audit(ctx, 'codetermination.ai_function', 'tenant', ctx.tenantId, { ai: { agents: { [name]: { enabled: before } } } }, { ai: { agents: { [name]: { enabled } } } });
  return { agent: name, enabled };
}

export const agreementSettingsInput = settingsSchema.shape.codetermination;

export async function setAgreementSettings(ctx: Ctx, body: unknown) {
  const next = agreementSettingsInput.parse(body);
  await ctx.db.query('UPDATE tenants SET settings = $1 WHERE id = $2', [JSON.stringify({ ...ctx.settings, codetermination: next }), ctx.tenantId]);
  await audit(ctx, 'codetermination.settings', 'tenant', ctx.tenantId, { codetermination: ctx.settings.codetermination }, { codetermination: next });
  return next;
}

// ---------------------------------------------------------------- generated agreements

export const TEMPLATE_NAMES = ['betriebsvereinbarung', 'duldungsvereinbarung'] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];
export const templateName = z.enum(TEMPLATE_NAMES);

const here = path.dirname(fileURLToPath(import.meta.url));
const templates = new Map<TemplateName, Template>();

/** Templates live in server/templates/codetermination (German; the agreements are German documents). */
export function loadTemplate(name: TemplateName): Template {
  let tpl = templates.get(name);
  if (!tpl) {
    tpl = compileTemplate(readFileSync(path.resolve(here, `../../templates/codetermination/${name}.de.md`), 'utf8'));
    templates.set(name, tpl);
  }
  return tpl;
}

/** Values the templates are filled with (mapping documented in Anlage 6 of the Muster-BV). */
export async function agreementVars(ctx: Ctx, name: TemplateName) {
  const s = ctx.settings;
  const l: Locale = 'de';
  const tenant = (await ctx.db.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [ctx.tenantId])).rows[0];
  const ai = aiOverview(l, s.ai);
  const roles = rolesOverview(l);
  const describe = (f: (typeof ai.functions)[number]) => ({
    ...f,
    providerText: 'error' in f.model ? f.model.error : `${f.model.provider}, ${f.model.model}`,
    hostingText: 'error' in f.model ? '' : f.model.hosting,
    typesText: f.ideaTypes ? Object.entries(f.ideaTypes).filter(([, on]) => on).map(([type]) => t(l, `aiq.ideaType.${type}`)).join(', ') : '',
  });
  return {
    template: { name, version: loadTemplate(name).version },
    generatedOn: fmt.date(l, ctx.today),
    workspace: tenant?.name ?? '',
    ...s.codetermination,
    minGroupSize: s.minGroupSize,
    gate1Workdays: s.deadlines.gate1Workdays,
    crowdRating: s.challenges.crowdRating,
    guarantee: s.guarantee,
    retention: {
      ...s.retention,
      closedIdeasDelete: s.retention.closedIdeasMonths > 0,
      periods: retentionOverview(l, s).periods,
      periodsText: retentionOverview(l, s).periods.map((p) => `${p.label}: ${p.text}`).join('; '),
    },
    protocols: retentionOverview(l, s).protocols,
    reports: reportsOverview(l, s).map((r) => ({ ...r, rolesText: r.roleLabels.join(', ') })),
    roles: roles.roles.map((r) => ({ ...r, rightsText: r.permissions.map((p) => p.label).join('; '), endpointCount: r.endpoints.length })),
    relations: roles.relations,
    // Roles with an area (R3-29).
    scopedAreas: (await scopedRolesOverview(ctx)).map((a) => ({
      name: a.name,
      rule: [a.topics.length ? t(l, 'codet.area.topics', { list: a.topics.join(', ') }) : '', a.orgUnits.length ? t(l, 'codet.area.units', { list: a.orgUnits.join(', ') }) : '']
        .filter(Boolean).join('; ') || '–',
      rolesText: a.roles.map((r) => `${t(l, `codet.role.${r.role}`)}: ${r.people}`).join(', '),
    })),
    ai: {
      enabled: ai.enabled,
      active: ai.functions.filter((f) => f.active).map(describe),
      inactive: ai.functions.filter((f) => !f.active).map(describe),
      inactiveText: ai.functions.filter((f) => !f.active).map((f) => f.label).join(', '),
      providers: ai.providers,
      external: ai.providers.filter((p) => p.hostingKey !== 'local' && ai.functions.some((f) => f.active && !('error' in f.model) && f.model.provider === p.name)),
      confidential: 'error' in ai.confidential ? { provider: ai.confidential.error, model: '', hosting: '' } : ai.confidential,
      search: { ...ai.search, enabled: ai.search.kind !== 'none' },
      budget: ai.budget,
    },
  };
}

export async function renderAgreement(ctx: Ctx, name: TemplateName): Promise<{ markdown: string; version: string; title: string; generatedOn: string }> {
  const tpl = loadTemplate(name);
  const vars = await agreementVars(ctx, name);
  return { markdown: tpl.render(vars), version: tpl.version, title: tr('de', m(`codet.doc.${name}`)), generatedOn: vars.generatedOn };
}

const plain = (s: string) => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1');

/** Markdown subset of the templates to PDF blocks: headings, lists, tables, quotes, paragraphs. */
export function markdownToBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  let header: string[] | null = null;
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: 'text', text: plain(para.join(' ')) });
    para = [];
  };
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|')) header = null;
    if (!line) { flush(); continue; }
    if (line.startsWith('<!--')) continue;
    if (line === '---') { flush(); blocks.push({ kind: 'space' }); continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { flush(); blocks.push({ kind: h[1].length === 1 ? 'title' : 'heading', text: plain(h[2]) }); continue; }
    if (line.startsWith('|')) {
      flush();
      const cells = line.replace(/^\||\|$/g, '').split('|').map((c) => plain(c.trim()));
      if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue;
      if (!header) { header = cells; continue; }
      blocks.push({ kind: 'row', label: cells[0], value: cells.slice(1).map((c, i) => (header![i + 1] ? `${header![i + 1]}: ${c}` : c)).join(' · ') });
      continue;
    }
    const li = /^[-*]\s+(.*)$/.exec(line);
    if (li) { flush(); blocks.push({ kind: 'bullet', text: plain(li[1]) }); continue; }
    if (/^\d+\.\s/.test(line)) { flush(); blocks.push({ kind: 'text', text: plain(line) }); continue; }
    if (line.startsWith('>')) { flush(); blocks.push({ kind: 'text', text: plain(line.replace(/^>\s*/, '')), small: true }); continue; }
    para.push(line);
  }
  flush();
  return blocks;
}
