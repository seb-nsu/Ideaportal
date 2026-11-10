import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { allProviders } from '../ai/gateway.js';
import { secretNames } from '../ai/secrets.js';
import type { AiSettings } from '../ai/settings.js';
import { compliance as op, config } from '../config.js';
import { m, tr, fmt, type Locale, type MessageKey } from '../i18n/index.js';
import type { Ctx } from '../lib/context.js';
import { badRequest, notFound } from '../lib/errors.js';
import { hasSecretKey } from '../lib/secretbox.js';
import { compileTemplate, type Template } from '../lib/template.js';
import type { Settings } from '../lib/settings.js';
import { audit } from './audit.js';
import { aiOverview, markdownToBlocks, retentionOverview } from './codetermination.js';

// Compliance (R3-08, R3-11): legal texts and compliance documents as versioned Markdown templates
// (server/templates/legal), the list of sub-processors built from the platform configuration and
// the AI and search settings of the workspace, the state of encryption in transit and at rest,
// and the acceptance of the current terms by an admin of the workspace.
// Every document is a draft and says so: no legal advice, review by a law firm is open.

// ---------------------------------------------------------------- documents

export const LEGAL_DOCS = ['agb', 'datenschutz', 'tom', 'dsfa', 'avv'] as const;
export type LegalDoc = (typeof LEGAL_DOCS)[number];
export const legalDoc = z.enum(LEGAL_DOCS);
/** Readable without an account at /rechtliches. The others are for admins of a workspace. */
export const PUBLIC_DOCS: readonly LegalDoc[] = ['agb', 'datenschutz'];
/** Documents an admin can accept for the workspace (AVV electronically, Art. 28 (9) GDPR). */
export const ACCEPTABLE_DOCS = ['agb', 'avv'] as const;
export type AcceptableDoc = (typeof ACCEPTABLE_DOCS)[number];

const here = path.dirname(fileURLToPath(import.meta.url));
const templates = new Map<LegalDoc, Template>();

export function loadLegal(name: LegalDoc): Template {
  let tpl = templates.get(name);
  if (!tpl) {
    tpl = compileTemplate(readFileSync(path.resolve(here, `../../templates/legal/${name}.de.md`), 'utf8'));
    templates.set(name, tpl);
  }
  return tpl;
}

/** Version "2026-10-13.1" → date of the version "2026-10-13". */
export const versionDate = (version: string) => version.slice(0, 10);

const t = (l: Locale, key: string, vars?: Record<string, string | number>) => tr(l, m(key as MessageKey, vars));

export function documentList(l: Locale, names: readonly LegalDoc[] = LEGAL_DOCS) {
  return names.map((name) => {
    const v = loadLegal(name).version;
    return { name, title: t(l, `compliance.doc.${name}`), version: v, date: versionDate(v), public: PUBLIC_DOCS.includes(name) };
  });
}

// ---------------------------------------------------------------- sub-processors (R3-08)

type Location = 'eu' | 'other' | 'local';
export interface Subprocessor {
  key: string;
  /** hosting, mail, ai or search */
  kind: 'hosting' | 'mail' | 'ai' | 'search';
  name: string;
  purpose: string;
  data: string;
  location: Location;
  locationText: string;
  /** operator: sub-processor of the operator; customer: the workspace's own contract (own key); none: own infrastructure. */
  contract: 'operator' | 'customer' | 'none';
  contractText: string;
  active: boolean;
}

/**
 * Sub-processors and other recipients: hosting and mail of the platform plus every external AI
 * provider and the search service of the workspace. Built from the configuration, so the list
 * changes when an admin changes Settings › AI.
 */
export function subprocessorList(l: Locale, ai: AiSettings | null, tenantSecrets: string[] = []): Subprocessor[] {
  const loc = (x: Location) => t(l, `compliance.location.${x}`);
  const con = (x: Subprocessor['contract']) => t(l, `compliance.contract.${x}`);
  const out: Subprocessor[] = [];
  out.push({
    key: 'hosting', kind: 'hosting', name: op.hostingProvider || t(l, 'compliance.placeholder.hosting'),
    purpose: t(l, 'compliance.sub.hosting.purpose', { region: op.hostingRegion || t(l, 'compliance.placeholder.region') }),
    data: t(l, 'compliance.sub.hosting.data'), location: op.hostingLocation, locationText: loc(op.hostingLocation),
    contract: op.hostingLocation === 'local' ? 'none' : 'operator', contractText: con(op.hostingLocation === 'local' ? 'none' : 'operator'), active: true,
  });
  if (config.mailTransport === 'smtp') {
    out.push({
      key: 'mail', kind: 'mail', name: op.mailProvider || t(l, 'compliance.placeholder.mail'),
      purpose: t(l, 'compliance.sub.mail.purpose'), data: t(l, 'compliance.sub.mail.data'),
      location: op.mailLocation, locationText: loc(op.mailLocation), contract: op.mailLocation === 'local' ? 'none' : 'operator', contractText: con(op.mailLocation === 'local' ? 'none' : 'operator'), active: true,
    });
  }
  if (!ai) return out;
  const overview = aiOverview(l, ai);
  for (const p of allProviders(ai)) {
    if (p.kind === 'builtin') continue;
    const uses = overview.functions.filter((f) => f.active && !('error' in f.model) && f.model.provider === p.name);
    const confidential = !('error' in overview.confidential) && overview.confidential.provider === p.name;
    const contract: Subprocessor['contract'] = p.hosting === 'local' ? 'none' : p.keySource === 'platform' ? 'operator' : 'customer';
    out.push({
      key: `ai:${p.id}`, kind: 'ai', name: p.name,
      purpose: uses.length ? t(l, 'compliance.sub.ai.purpose', { functions: uses.map((f) => f.label).join(', ') }) : t(l, 'compliance.sub.ai.unused'),
      data: t(l, confidential ? 'compliance.sub.ai.dataConfidential' : 'compliance.sub.ai.data'),
      location: p.hosting, locationText: loc(p.hosting), contract, contractText: con(contract), active: ai.enabled && (uses.length > 0 || confidential),
    });
  }
  if (ai.search.kind !== 'none') {
    const self = ai.search.kind === 'searxng';
    const contract: Subprocessor['contract'] = self ? 'none' : tenantSecrets.includes('search') ? 'customer' : 'operator';
    const location: Location = self ? 'local' : 'other';
    out.push({
      key: `search:${ai.search.kind}`, kind: 'search', name: t(l, `codet.search.${ai.search.kind}`),
      purpose: t(l, 'compliance.sub.search.purpose'), data: t(l, 'compliance.sub.search.data'),
      location, locationText: loc(location), contract, contractText: con(contract), active: ai.enabled,
    });
  }
  return out;
}

export async function tenantSubprocessors(ctx: Ctx, l: Locale = ctx.locale): Promise<Subprocessor[]> {
  return subprocessorList(l, ctx.settings.ai, await secretNames(ctx));
}

const csvCell = (v: string) => (/[";\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function subprocessorsCsv(l: Locale, list: Subprocessor[]): string {
  const head = ['name', 'kind', 'purpose', 'data', 'location', 'contract', 'active'].map((k) => t(l, `compliance.csv.${k}`));
  const rows = list.map((s) => [s.name, t(l, `compliance.kind.${s.kind}`), s.purpose, s.data, s.locationText, s.contractText, t(l, s.active ? 'compliance.yes' : 'compliance.no')]);
  // BOM so that spreadsheet programs read the umlauts correctly.
  return '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- encryption and hosting (R3-08)

export function securityStatus() {
  const https = config.cookieSecure || config.publicUrl.startsWith('https://');
  const dbUrlSsl = /[?&]sslmode=(require|verify-ca|verify-full)/.test(config.databaseUrl);
  return {
    https,
    hsts: https,
    cookieSecure: config.cookieSecure,
    databaseTls: config.databaseSsl !== 'off' ? config.databaseSsl : dbUrlSsl ? 'url' : 'off',
    secretKey: hasSecretKey(),
    hostingProvider: op.hostingProvider,
    hostingRegion: op.hostingRegion,
    hostingLocation: op.hostingLocation,
  };
}

// ---------------------------------------------------------------- rendering

interface RenderInput {
  l: Locale;
  workspace: string;
  settings: Settings | null;
  subprocessors: Subprocessor[];
  generatedOn: string;
}

function docVars(name: LegalDoc, input: RenderInput) {
  const tpl = loadLegal(name);
  const s = input.settings;
  const sec = securityStatus();
  const ai = s ? aiOverview('de', s.ai) : null;
  return {
    template: { name, version: tpl.version, date: fmt.date('de', versionDate(tpl.version)) },
    generatedOn: input.generatedOn,
    workspace: input.workspace,
    operator: { name: op.operatorName, address: op.operatorAddress, email: op.operatorEmail, privacyContact: op.privacyContact },
    hosting: { provider: op.hostingProvider, region: op.hostingRegion, eu: op.hostingLocation === 'eu' },
    security: { ...sec, databaseTlsOn: sec.databaseTls !== 'off' },
    subprocessors: input.subprocessors.map((x) => ({ ...x, activeText: x.active ? 'ja' : 'nein' })),
    operatorSubprocessors: input.subprocessors.filter((x) => x.contract === 'operator'),
    customerRecipients: input.subprocessors.filter((x) => x.contract === 'customer'),
    minGroupSize: s?.minGroupSize ?? 5,
    retention: s ? { ...s.retention, periodsText: retentionOverview('de', s).periods.map((p) => `${p.label}: ${p.text}`).join('; ') } : null,
    ai: ai
      ? {
          enabled: ai.enabled,
          activeText: ai.functions.filter((f) => f.active).map((f) => f.label).join(', '),
          confidential: 'error' in ai.confidential ? { provider: ai.confidential.error, hosting: '' } : ai.confidential,
          search: s!.ai.search.kind !== 'none',
        }
      : null,
    invention: s?.invention ?? null,
  };
}

export function renderLegal(name: LegalDoc, input: RenderInput) {
  const tpl = loadLegal(name);
  const markdown = tpl.render(docVars(name, input));
  return { name, title: tr('de', m(`compliance.doc.${name}`)), version: tpl.version, date: versionDate(tpl.version), generatedOn: input.generatedOn, markdown };
}

/** Public documents: platform data only, no workspace data. */
export function renderPublic(name: string, l: Locale) {
  const doc = legalDoc.safeParse(name);
  if (!doc.success || !PUBLIC_DOCS.includes(doc.data)) throw notFound();
  const today = new Date().toISOString().slice(0, 10);
  const r = renderLegal(doc.data, { l, workspace: '', settings: null, subprocessors: subprocessorList('de', null), generatedOn: fmt.date('de', today) });
  return { ...r, blocks: markdownToBlocks(r.markdown) };
}

/** Documents filled with the workspace (name, settings, AI providers as sub-processors). */
export async function renderForTenant(ctx: Ctx, name: LegalDoc) {
  const tenant = (await ctx.db.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [ctx.tenantId])).rows[0];
  const r = renderLegal(name, {
    l: 'de', workspace: tenant?.name ?? '', settings: ctx.settings, subprocessors: await tenantSubprocessors(ctx, 'de'), generatedOn: fmt.date('de', ctx.today),
  });
  return { ...r, workspace: tenant?.name ?? '', blocks: markdownToBlocks(r.markdown) };
}

// ---------------------------------------------------------------- acceptance (R3-11)

export async function acceptances(ctx: Ctx) {
  return (await ctx.db.query<{ document: AcceptableDoc; version: string; acceptedAt: string; acceptedBy: string | null }>(
    `SELECT a.document, a.version, a.accepted_at AS "acceptedAt", u.display_name AS "acceptedBy"
       FROM legal_acceptances a LEFT JOIN users u ON u.id = a.accepted_by ORDER BY a.accepted_at DESC`,
  )).rows;
}

export const acceptInput = z.object({ document: z.enum(ACCEPTABLE_DOCS), version: z.string().min(1).max(40) });

export async function accept(ctx: Ctx, body: unknown) {
  const { document, version } = acceptInput.parse(body);
  const current = loadLegal(document).version;
  // Only the version the admin has in front of them counts; an outdated page must reload.
  if (version !== current) throw badRequest(m('compliance.versionOutdated', { version: current }));
  const r = await ctx.db.query(
    `INSERT INTO legal_acceptances (tenant_id, document, version, accepted_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, document, version) DO NOTHING`,
    [ctx.tenantId, document, version, ctx.user!.id],
  );
  if (r.rowCount) await audit(ctx, 'legal.accept', 'tenant', ctx.tenantId, null, { document, version });
  return { document, version, accepted: true };
}

export async function complianceOverview(ctx: Ctx) {
  const done = await acceptances(ctx);
  return {
    documents: documentList(ctx.locale).map((d) => ({
      ...d,
      acceptable: (ACCEPTABLE_DOCS as readonly string[]).includes(d.name),
      accepted: done.find((a) => a.document === d.name && a.version === d.version) ?? null,
    })),
    acceptances: done,
    subprocessors: await tenantSubprocessors(ctx),
    security: securityStatus(),
  };
}
