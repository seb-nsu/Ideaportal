import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { withSystem, withTenant } from '../db/pool.js';
import { buildCtx, isTriage, type Ctx } from '../lib/context.js';
import { newToken } from '../lib/crypto.js';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { openSecret, sealSecret } from '../lib/secretbox.js';
import { requireFeature } from './billing.js';
import { m, tr, type Locale, type MessageKey } from '../i18n/index.js';
import { BRIEF_FIELDS, type ImplementationPackage } from '../ai/package.js';
import { audit } from './audit.js';
import { requirePerson } from './apitokens.js';
import { notifyUser } from './notify.js';
import { checkWebhookUrl, verifySignature, SIGNATURE_HEADER } from './webhooks.js';
import { actsFor, addEvent, ideaVars, requireStatus, type IdeaRow, type ImplementationRow, type Status } from './workflow.js';
import {
  CONNECTOR_KINDS,
  DEFAULT_CONFIG,
  FIELD_SOURCES,
  ITEM_TYPES,
  authHeader,
  countRequest,
  createRequest,
  mapStatus,
  parseCount,
  parseCreated,
  parseStatus,
  statusRequest,
  testRequest,
  type ConnectorConfig,
  type ConnectorKind,
  type ConnectorTarget,
  type Credentials,
  type ExternalItem,
  type HttpRequest,
  type HttpResponse,
  type ItemInput,
  adoItemsRequest,
  parseTickets,
  parseWiqlIds,
  ticketRequest,
  type TicketQuery,
  type TicketText,
} from './connectorKinds.js';

// Connectors (R3-13 Jira, R3-14 ServiceNow, R3-15 Azure DevOps): per tenant configuration,
// activation per click, handover of an approved idea per click, and the status coming back
// into the implementation (R1-31) by callback (API token or per-connector secret) or polling.
// Every request goes through the injectable HTTP client; target URLs are https only and never
// in the private network (checkPublicUrl, also before each request).

/** Statuses after Gate 2 in which an idea can be handed over. */
export const HANDOVER_STATUSES: Status[] = ['implementing', 'piloting', 'integrated'];
/** Roles a token needs for the status callback. */
const CALLBACK_ROLES = ['implementer', 'triage', 'admin'];
const TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------- input

const identifier = z.string().trim().max(100).regex(/^[A-Za-z0-9_.\- ]*$/);
export const configInput = z.object({
  project: identifier.optional(),
  itemType: identifier.optional(),
  storyType: identifier.optional(),
  parentField: z.string().trim().max(60).regex(/^[A-Za-z0-9_]*$/).optional(),
  fieldMap: z.array(z.object({ source: z.enum(FIELD_SOURCES), target: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_.]+$/) })).max(20).optional(),
  statusMap: z.array(z.object({ external: z.string().trim().min(1).max(80), progress: z.number().int().min(0).max(100) })).max(40).optional(),
  poll: z.boolean().optional(),
});
export const credentialsInput = z.object({
  email: z.string().trim().max(200).optional(),
  apiToken: z.string().trim().max(500).optional(),
  username: z.string().trim().max(200).optional(),
  password: z.string().max(500).optional(),
  pat: z.string().trim().max(500).optional(),
});
export const connectorInput = z.object({
  kind: z.enum(CONNECTOR_KINDS),
  name: z.string().trim().min(2).max(80),
  baseUrl: z.url().max(300),
  config: configInput.default({}),
  credentials: credentialsInput.optional(),
});
export const connectorUpdate = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  baseUrl: z.url().max(300).optional(),
  config: configInput.optional(),
  credentials: credentialsInput.optional(),
});
export const handoverInput = z.object({
  connectorId: z.uuid(),
  withPackage: z.boolean().default(false),
  /** Confidential ideas leave the portal only with this explicit confirmation. */
  confirmConfidential: z.boolean().default(false),
});

/** Full configuration with the defaults of the kind; checks what the kind needs. */
export function normalizeConfig(kind: ConnectorKind, input: z.infer<typeof configInput>, before?: ConnectorConfig): ConnectorConfig {
  const d = DEFAULT_CONFIG[kind];
  const c: ConnectorConfig = {
    project: input.project ?? before?.project ?? '',
    itemType: input.itemType || before?.itemType || d.itemType,
    storyType: input.storyType || before?.storyType || d.storyType,
    parentField: input.parentField || before?.parentField || d.parentField,
    fieldMap: input.fieldMap ?? before?.fieldMap ?? [],
    statusMap: input.statusMap ?? before?.statusMap ?? d.statusMap,
    poll: input.poll ?? before?.poll ?? false,
  };
  if (kind === 'jira' && !/^[A-Z][A-Z0-9_]{0,19}$/.test(c.project)) throw new HttpError(400, m('conn.config.jiraProject'), 'CONNECTOR_CONFIG');
  if (kind === 'azure_devops' && !c.project.trim()) throw new HttpError(400, m('conn.config.adoProject'), 'CONNECTOR_CONFIG');
  if (!ITEM_TYPES[kind].includes(c.itemType)) throw new HttpError(400, m('conn.config.itemType', { allowed: ITEM_TYPES[kind].join(', ') }), 'CONNECTOR_CONFIG');
  if (kind === 'servicenow' && !/^[a-z][a-z0-9_]{1,79}$/.test(c.storyType)) throw new HttpError(400, m('conn.config.table'), 'CONNECTOR_CONFIG');
  return c;
}

function normalizeCredentials(kind: ConnectorKind, input: z.infer<typeof credentialsInput>): Credentials {
  if (kind === 'jira' && input.email && input.apiToken) return { kind, email: input.email, apiToken: input.apiToken };
  if (kind === 'servicenow' && input.username && input.password) return { kind, username: input.username, password: input.password };
  if (kind === 'azure_devops' && input.pat) return { kind, pat: input.pat };
  throw new HttpError(400, m(`conn.credentials.${kind}` as MessageKey), 'CONNECTOR_CREDENTIALS');
}

// ---------------------------------------------------------------- HTTP client (injectable)

export type ConnectorHttp = (req: HttpRequest) => Promise<HttpResponse>;

/** Real client: no redirects (they could lead into the private network), short timeout. */
const fetchHttp: ConnectorHttp = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text().catch(() => '');
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
};

let http: ConnectorHttp = fetchHttp;
/** Tests replace the client with a fake API; no network. Without argument the real client is restored. */
export function setConnectorHttp(h?: ConnectorHttp): void {
  http = h ?? fetchHttp;
}

export class ConnectorCallError extends Error {
  constructor(readonly reason: string, readonly status: number | null = null) {
    super(reason);
  }
}

async function assertUrl(raw: string): Promise<void> {
  const r = await checkWebhookUrl(raw);
  if (!r.ok) throw new HttpError(400, m(`conn.url.${r.reason}` as MessageKey), 'CONNECTOR_URL', { reason: r.reason });
}

// ---------------------------------------------------------------- rows

export interface ConnectorRow {
  id: string;
  tenant_id: string;
  kind: ConnectorKind;
  name: string;
  base_url: string;
  config: ConnectorConfig;
  credentials_enc: string | null;
  callback_secret_enc: string;
  enabled: boolean;
  last_poll_at: Date | null;
  last_error: string | null;
}

const target = (c: ConnectorRow): ConnectorTarget => {
  const defaults: ConnectorConfig = { ...DEFAULT_CONFIG[c.kind], project: '', fieldMap: [], poll: false };
  return { kind: c.kind, baseUrl: c.base_url, config: { ...defaults, ...c.config } };
};

/** One authenticated request to the target system; URL check before each call. */
async function call(db: Ctx['db'], c: ConnectorRow, req: HttpRequest): Promise<HttpResponse> {
  const guard = await checkWebhookUrl(req.url);
  if (!guard.ok) throw new ConnectorCallError(`url_refused:${guard.reason}`);
  if (!c.credentials_enc) throw new ConnectorCallError('no_credentials');
  const creds = JSON.parse(await openSecret(db, c.tenant_id, c.credentials_enc)) as Credentials;
  let res: HttpResponse;
  try {
    res = await http({ ...req, headers: { ...req.headers, authorization: authHeader(creds), 'user-agent': 'Ideenportal-Connector/1' } });
  } catch (err) {
    throw new ConnectorCallError((err as Error).name === 'TimeoutError' ? 'timeout' : 'network');
  }
  if (res.status < 200 || res.status >= 300) throw new ConnectorCallError(`http_${res.status}`, res.status);
  return res;
}

async function loadConnector(ctx: Ctx, id: string, forUpdate = false): Promise<ConnectorRow> {
  if (!z.uuid().safeParse(id).success) throw notFound(m('conn.notFound'));
  const r = await ctx.db.query<ConnectorRow>(`SELECT * FROM connectors WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  if (!r.rows[0]) throw notFound(m('conn.notFound'));
  return r.rows[0];
}

export const callbackUrl = (id: string) => `${config.publicUrl}/api/integrations/connectors/${id}/status`;
const newSecret = () => `cbsec_${newToken()}`;

// ---------------------------------------------------------------- management (admins)

export async function listConnectors(ctx: Ctx) {
  const r = await ctx.db.query<ConnectorRow & { links: number; created_at: Date }>(
    `SELECT c.*, (SELECT count(*)::int FROM connector_links l WHERE l.connector_id = c.id AND l.role = 'main') AS links
       FROM connectors c ORDER BY c.created_at`,
  );
  return r.rows.map((c) => ({
    id: c.id,
    kind: c.kind,
    name: c.name,
    baseUrl: c.base_url,
    config: target(c).config,
    enabled: c.enabled,
    hasCredentials: !!c.credentials_enc,
    callbackUrl: callbackUrl(c.id),
    lastPollAt: c.last_poll_at,
    lastError: c.last_error,
    links: c.links,
    createdAt: c.created_at,
  }));
}

export async function createConnector(ctx: Ctx, input: z.infer<typeof connectorInput>) {
  requirePerson(ctx);
  await assertUrl(input.baseUrl);
  const cfg = normalizeConfig(input.kind, input.config);
  const creds = input.credentials ? normalizeCredentials(input.kind, input.credentials) : null;
  const secret = newSecret();
  const r = await ctx.db.query<{ id: string }>(
    `INSERT INTO connectors (tenant_id, kind, name, base_url, config, credentials_enc, callback_secret_enc, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [ctx.tenantId, input.kind, input.name, input.baseUrl, JSON.stringify(cfg), creds ? await sealSecret(ctx.db, ctx.tenantId, JSON.stringify(creds)) : null, await sealSecret(ctx.db, ctx.tenantId, secret), ctx.user!.id],
  );
  const id = r.rows[0].id;
  await audit(ctx, 'connector.create', 'connector', id, null, { kind: input.kind, name: input.name, baseUrl: input.baseUrl, config: cfg, credentials: !!creds });
  return { id, callbackSecret: secret, callbackUrl: callbackUrl(id) };
}

export async function updateConnector(ctx: Ctx, id: string, input: z.infer<typeof connectorUpdate>): Promise<void> {
  requirePerson(ctx);
  const c = await loadConnector(ctx, id, true);
  if (input.baseUrl) await assertUrl(input.baseUrl);
  const cfg = input.config ? normalizeConfig(c.kind, input.config, target(c).config) : target(c).config;
  const creds = input.credentials && Object.values(input.credentials).some(Boolean) ? normalizeCredentials(c.kind, input.credentials) : null;
  await ctx.db.query(
    `UPDATE connectors SET name = $2, base_url = $3, config = $4, credentials_enc = coalesce($5, credentials_enc), updated_at = now() WHERE id = $1`,
    [id, input.name ?? c.name, input.baseUrl ?? c.base_url, JSON.stringify(cfg), creds ? await sealSecret(ctx.db, ctx.tenantId, JSON.stringify(creds)) : null],
  );
  await audit(ctx, 'connector.update', 'connector', id, { name: c.name, baseUrl: c.base_url, config: c.config },
    { name: input.name ?? c.name, baseUrl: input.baseUrl ?? c.base_url, config: cfg, credentialsChanged: !!creds });
}

/** Activation per click (R3-13); only with credentials and an allowed address. */
export async function setConnectorEnabled(ctx: Ctx, id: string, enabled: boolean): Promise<void> {
  requirePerson(ctx);
  const c = await loadConnector(ctx, id, true);
  if (enabled) {
    if (!c.credentials_enc) throw new HttpError(400, m('conn.needsCredentials'), 'CONNECTOR_CREDENTIALS');
    await assertUrl(c.base_url);
  }
  await ctx.db.query('UPDATE connectors SET enabled = $2, updated_at = now() WHERE id = $1', [id, enabled]);
  await audit(ctx, enabled ? 'connector.enable' : 'connector.disable', 'connector', id, { enabled: c.enabled }, { enabled });
}

export async function rotateCallbackSecret(ctx: Ctx, id: string): Promise<{ callbackSecret: string }> {
  requirePerson(ctx);
  await loadConnector(ctx, id, true);
  const secret = newSecret();
  await ctx.db.query('UPDATE connectors SET callback_secret_enc = $2, updated_at = now() WHERE id = $1', [id, await sealSecret(ctx.db, ctx.tenantId, secret)]);
  await audit(ctx, 'connector.rotate_secret', 'connector', id, null, null);
  return { callbackSecret: secret };
}

export async function deleteConnector(ctx: Ctx, id: string): Promise<void> {
  requirePerson(ctx);
  const c = await loadConnector(ctx, id, true);
  await ctx.db.query('DELETE FROM connectors WHERE id = $1', [id]);
  await audit(ctx, 'connector.delete', 'connector', id, { kind: c.kind, name: c.name, baseUrl: c.base_url }, null);
}

/** Connection check with the stored credentials (no change in the target system). */
export async function testConnector(ctx: Ctx, id: string): Promise<{ ok: boolean; reason?: string }> {
  requirePerson(ctx);
  const c = await loadConnector(ctx, id);
  try {
    await call(ctx.db, c, testRequest(target(c)));
    return { ok: true };
  } catch (err) {
    if (err instanceof ConnectorCallError) return { ok: false, reason: err.reason };
    throw err;
  }
}

/**
 * Number of items matching a query in the target system (metrics, R4-04). Throws
 * ConnectorCallError when the connector is switched off, unreachable or answers unexpectedly.
 */
export async function countWithConnector(ctx: Ctx, connectorId: string, query: string, table?: string | null): Promise<number> {
  const r = await ctx.db.query<ConnectorRow>('SELECT * FROM connectors WHERE id = $1', [connectorId]);
  const c = r.rows[0];
  if (!c) throw new ConnectorCallError('not_found');
  if (!c.enabled) throw new ConnectorCallError('disabled');
  const t = target(c);
  const n = parseCount(t, await call(ctx.db, c, countRequest(t, query, table)));
  if (n == null) throw new ConnectorCallError('unexpected_answer');
  return n;
}

// ---------------------------------------------------------------- content sent to the target system

const num = (v: unknown) => (v == null || v === '' ? null : Number(v));
export const ideaUrl = (ideaId: string) => `${config.publicUrl}/ideen/${ideaId}`;

function fieldValues(c: ConnectorConfig, idea: IdeaRow, impl: ImplementationRow | null): Record<string, string | number> {
  const values: Record<string, string | number | null> = {
    number: idea.number,
    url: ideaUrl(idea.id),
    topic: idea.topic,
    targetDate: impl?.target_date ? String(impl.target_date) : null,
    benefit: idea.benefit,
    effortPersonDays: num(idea.effort_person_days),
    effortEuro: num(idea.effort_euro),
    planBenefitEuro: num(idea.plan_benefit_euro),
    channel: impl?.channel ?? null,
  };
  const out: Record<string, string | number> = {};
  for (const f of c.fieldMap) {
    const v = values[f.source];
    if (v != null && v !== '') out[f.target] = v;
  }
  return out;
}

const L = (l: Locale, key: MessageKey, vars?: Record<string, string | number>) => tr(l, m(key, vars));

/** Description of the main item: the brief of the package, else problem, solution and benefit. */
export function mainDescription(l: Locale, idea: IdeaRow, impl: ImplementationRow | null, pkg: ImplementationPackage | null): string {
  const parts: string[] = [];
  if (pkg) {
    for (const f of BRIEF_FIELDS) {
      const v = pkg.brief[f].trim();
      if (v) parts.push(`${L(l, `conn.pkg.h.${f}` as MessageKey)}\n${v}`);
    }
  } else {
    parts.push(`${L(l, 'conn.ext.problem')}\n${idea.problem}`, `${L(l, 'conn.ext.solution')}\n${idea.solution}`, `${L(l, 'conn.ext.benefit')}\n${idea.benefit}`);
  }
  if (impl?.target_date) parts.push(L(l, 'conn.ext.target', { date: String(impl.target_date) }));
  parts.push(L(l, 'conn.ext.link', { number: idea.number, url: ideaUrl(idea.id) }));
  return parts.join('\n\n');
}

export function storyDescription(l: Locale, story: ImplementationPackage['stories'][number], idea: IdeaRow): string {
  const parts = [story.description.trim()];
  if (story.acceptance.length) parts.push(`${L(l, 'conn.pkg.acceptance')}\n${story.acceptance.map((a) => `- ${a}`).join('\n')}`);
  parts.push(L(l, 'conn.ext.link', { number: idea.number, url: ideaUrl(idea.id) }));
  return parts.filter(Boolean).join('\n\n');
}

// ---------------------------------------------------------------- handover (owner, per click)

/** The implementation owner (or deputy) and the triage team may hand over and edit the package. */
export async function canManageHandover(ctx: Ctx, idea: IdeaRow): Promise<boolean> {
  if (isTriage(ctx.user)) return true;
  const r = await ctx.db.query<{ owner_id: string }>('SELECT owner_id FROM implementations WHERE idea_id = $1', [idea.id]);
  return !!r.rows[0] && (await actsFor(ctx, r.rows[0].owner_id));
}

export async function requireManager(ctx: Ctx, idea: IdeaRow): Promise<void> {
  if (!(await canManageHandover(ctx, idea))) throw forbidden(m('conn.ownerOnly'));
}

interface LinkRow {
  id: string;
  connector_id: string;
  idea_id: string;
  role: 'main' | 'story';
  story_index: number;
  external_id: string;
  external_key: string | null;
  external_url: string | null;
  external_status: string | null;
  mapped_progress: number | null;
}

export async function handoverView(ctx: Ctx, idea: IdeaRow) {
  const canManage = await canManageHandover(ctx, idea);
  const links = await ctx.db.query(
    `SELECT l.id, l.role, l.story_index AS "storyIndex", l.external_key AS "externalKey", l.external_url AS "externalUrl",
            l.external_status AS "externalStatus", l.mapped_progress AS "mappedProgress", l.created_at AS "createdAt",
            l.last_synced_at AS "lastSyncedAt", c.id AS "connectorId", c.name AS "connectorName", c.kind
       FROM connector_links l JOIN connectors c ON c.id = l.connector_id
      WHERE l.idea_id = $1 ORDER BY c.name, l.role, l.story_index`,
    [idea.id],
  );
  const connectors = canManage
    ? (await ctx.db.query('SELECT id, name, kind FROM connectors WHERE enabled ORDER BY name')).rows
    : [];
  const pkg = await ctx.db.query('SELECT 1 FROM implementation_packages WHERE idea_id = $1', [idea.id]);
  return {
    canManage,
    allowed: HANDOVER_STATUSES.includes(idea.status),
    confidential: idea.confidential,
    hasPackage: !!pkg.rowCount,
    connectors,
    links: links.rows,
  };
}

async function auditSeparately(ctx: Ctx, action: string, entityId: string, after: unknown): Promise<void> {
  // A failed handover rolls the request back; the audit entry must stay.
  await withTenant(ctx.tenantId, async (db) => audit({ ...ctx, db }, action, 'idea', entityId, null, after));
}

export async function handover(ctx: Ctx, idea: IdeaRow, input: z.infer<typeof handoverInput>) {
  requireFeature(ctx, 'connectors');
  await requireManager(ctx, idea);
  requireStatus(idea, ...HANDOVER_STATUSES);
  if (idea.confidential && !input.confirmConfidential) {
    throw conflict(m('conn.confidentialConfirm'), 'CONFIDENTIAL_CONFIRM');
  }
  const c = await loadConnector(ctx, input.connectorId);
  if (!c.enabled) throw new HttpError(400, m('conn.disabled', { name: c.name }), 'CONNECTOR_DISABLED');
  const t = target(c);
  const impl = (await ctx.db.query<ImplementationRow>('SELECT * FROM implementations WHERE idea_id = $1 FOR UPDATE', [idea.id])).rows[0] ?? null;
  let pkg: ImplementationPackage | null = null;
  if (input.withPackage) {
    const p = await ctx.db.query<ImplementationPackage>('SELECT brief, stories FROM implementation_packages WHERE idea_id = $1', [idea.id]);
    if (!p.rows[0]) throw new HttpError(400, m('conn.noPackage'), 'NO_PACKAGE');
    pkg = p.rows[0];
  }
  const links = (await ctx.db.query<LinkRow>('SELECT * FROM connector_links WHERE connector_id = $1 AND idea_id = $2', [c.id, idea.id])).rows;
  let main: ExternalItem | null = null;
  const existing = links.find((x) => x.role === 'main');
  if (existing) main = { id: existing.external_id, key: existing.external_key, url: existing.external_url };
  const openStories = (pkg?.stories ?? []).map((s, i) => ({ s, i })).filter(({ i }) => !links.some((x) => x.role === 'story' && x.story_index === i));
  if (main && !openStories.length) throw conflict(m('conn.alreadyHandedOver', { name: c.name }), 'ALREADY_HANDED_OVER');

  const l = ctx.settings.locale;
  const fields = fieldValues(t.config, idea, impl);
  const base = { portalUrl: ideaUrl(idea.id), ideaId: idea.id, ideaNumber: idea.number };
  const auditBase = { connectorId: c.id, connector: c.name, kind: c.kind, confidential: idea.confidential, confirmedConfidential: idea.confidential && input.confirmConfidential, withPackage: input.withPackage };
  const createdMain = !main;
  if (!main) {
    const item: ItemInput = { ...base, role: 'main', title: idea.title, description: mainDescription(l, idea, impl, pkg), fields };
    try {
      const res = await call(ctx.db, c, createRequest(t, item, null));
      main = parseCreated(t, res, 'main');
      if (!main) throw new ConnectorCallError('unexpected_answer', res.status);
    } catch (err) {
      if (!(err instanceof ConnectorCallError)) throw err;
      await auditSeparately(ctx, 'connector.handover_failed', idea.id, { ...auditBase, reason: err.reason });
      throw new HttpError(502, m('conn.failed', { name: c.name, reason: err.reason }), 'CONNECTOR_FAILED');
    }
    await ctx.db.query(
      `INSERT INTO connector_links (tenant_id, connector_id, idea_id, role, story_index, external_id, external_key, external_url, created_by)
       VALUES ($1, $2, $3, 'main', -1, $4, $5, $6, $7)`,
      [ctx.tenantId, c.id, idea.id, main.id, main.key, main.url, ctx.user?.id ?? null],
    );
  }
  let stories = 0;
  const failed: { index: number; reason: string }[] = [];
  for (const { s, i } of openStories) {
    const item: ItemInput = { ...base, role: 'story', title: s.title, description: storyDescription(l, s, idea), fields: {} };
    try {
      const res = await call(ctx.db, c, createRequest(t, item, main));
      const created = parseCreated(t, res, 'story');
      if (!created) throw new ConnectorCallError('unexpected_answer', res.status);
      await ctx.db.query(
        `INSERT INTO connector_links (tenant_id, connector_id, idea_id, role, story_index, external_id, external_key, external_url, created_by)
         VALUES ($1, $2, $3, 'story', $4, $5, $6, $7, $8)`,
        [ctx.tenantId, c.id, idea.id, i, created.id, created.key, created.url, ctx.user?.id ?? null],
      );
      stories++;
    } catch (err) {
      if (!(err instanceof ConnectorCallError)) throw err;
      failed.push({ index: i, reason: err.reason });
    }
  }
  const ref = main.key ?? main.id;
  if (impl && !impl.external_ref) {
    await ctx.db.query('UPDATE implementations SET external_ref = $2 WHERE id = $1', [impl.id, `${c.name}: ${ref}`.slice(0, 300)]);
  }
  await addEvent(ctx, idea, 'handover', m(createdMain ? 'conn.event.handover' : 'conn.event.stories', { name: c.name, ref, n: stories }));
  await audit(ctx, 'connector.handover', 'idea', idea.id, null, { ...auditBase, externalId: main.id, externalKey: main.key, createdMain, stories, failedStories: failed });
  return { main: { id: main.id, key: main.key, url: main.url }, createdMain, stories, failed };
}

// ---------------------------------------------------------------- status back into the implementation (R1-31)

/** Applies an external status to the link and, for the main item, to the progress of the implementation. */
export async function applyExternalStatus(ctx: Ctx, c: ConnectorRow, ref: string, names: string[], source: 'callback' | 'poll'): Promise<{ matched: boolean; progress: number | null; changed: boolean }> {
  const link = (await ctx.db.query<LinkRow>(
    `SELECT * FROM connector_links WHERE connector_id = $1 AND (external_id = $2 OR external_key = $2) ORDER BY (role = 'main') DESC LIMIT 1 FOR UPDATE`,
    [c.id, ref],
  )).rows[0];
  if (!link) return { matched: false, progress: null, changed: false };
  const progress = mapStatus(target(c).config.statusMap, names);
  const status = names[0]?.slice(0, 120) ?? null;
  await ctx.db.query('UPDATE connector_links SET external_status = $2, mapped_progress = $3, last_synced_at = now() WHERE id = $1', [link.id, status, progress]);
  if (link.role !== 'main' || progress === null) return { matched: true, progress, changed: false };
  const impl = (await ctx.db.query<ImplementationRow>('SELECT * FROM implementations WHERE idea_id = $1 FOR UPDATE', [link.idea_id])).rows[0];
  // Only an ongoing implementation follows the external status; closing needs the actual benefit (R1-32).
  if (!impl || impl.status !== 'active' || impl.progress === progress) return { matched: true, progress, changed: false };
  await ctx.db.query('UPDATE implementations SET progress = $2 WHERE id = $1', [impl.id, progress]);
  const idea = (await ctx.db.query<IdeaRow>('SELECT * FROM ideas WHERE id = $1', [link.idea_id])).rows[0];
  await addEvent(ctx, idea, 'external_status', m('conn.event.status', { name: c.name, status: status ?? '', progress }));
  await audit(ctx, 'connector.status', 'idea', idea.id, { progress: impl.progress }, { progress, status, connectorId: c.id, source });
  if (progress === 100) {
    await notifyUser(ctx, impl.owner_id, m('conn.done.subject', ideaVars(idea)), m('conn.done.body', { ...ideaVars(idea), name: c.name, status: status ?? '' }), idea.id);
  }
  return { matched: true, progress, changed: true };
}

/** Constant-time check of a callback against the connector secret. */
export function verifyCallback(secret: string, headers: Record<string, string | string[] | undefined>, raw: string): boolean {
  const h = (name: string) => {
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const same = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
  const ours = h(SIGNATURE_HEADER);
  if (ours) return verifySignature(secret, ours, raw);
  // Jira Cloud webhooks with secret (and GitHub style): X-Hub-Signature: sha256=<hex HMAC of the body>.
  const hub = h('x-hub-signature');
  if (hub) return same(hub.trim(), `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`);
  // Azure DevOps service hooks: basic authentication; the password is the secret.
  const auth = h('authorization');
  const basic = auth && /^Basic\s+(.+)$/i.exec(auth.trim());
  if (basic) {
    const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
    const password = decoded.slice(decoded.indexOf(':') + 1);
    return decoded.includes(':') && same(password, secret);
  }
  return false;
}

/** Connector of an inbound callback, without tenant context (the id is the public lookup key). */
export async function connectorForCallback(id: string): Promise<ConnectorRow | null> {
  if (!z.uuid().safeParse(id).success) return null;
  const c = await withSystem(async (db) => (await db.query<ConnectorRow>('SELECT * FROM connectors WHERE id = $1', [id])).rows[0]);
  return c && c.enabled ? c : null;
}

export const callbackRolesOk = (roles: string[]) => roles.some((r) => CALLBACK_ROLES.includes(r));
export const callbackSecret = (c: ConnectorRow) => openSecret(null, c.tenant_id, c.callback_secret_enc);

// ---------------------------------------------------------------- polling

export interface PollResult {
  checked: number;
  updated: number;
  errors: number;
}

/** Asks the target system for the status of every ongoing implementation handed over by this connector. */
export async function pollConnector(ctx: Ctx, c: ConnectorRow): Promise<PollResult> {
  const res: PollResult = { checked: 0, updated: 0, errors: 0 };
  const t = target(c);
  const links = await ctx.db.query<LinkRow>(
    `SELECT l.* FROM connector_links l JOIN implementations im ON im.idea_id = l.idea_id
      WHERE l.connector_id = $1 AND l.role = 'main' AND im.status = 'active' ORDER BY l.created_at LIMIT 200`,
    [c.id],
  );
  let lastError: string | null = null;
  for (const l of links.rows) {
    try {
      const answer = await call(ctx.db, c, statusRequest(t, { id: l.external_id, key: l.external_key, role: 'main' }));
      const names = parseStatus(t, answer);
      res.checked++;
      if (names.length && (await applyExternalStatus(ctx, c, l.external_id, names, 'poll')).changed) res.updated++;
    } catch (err) {
      if (!(err instanceof ConnectorCallError)) throw err;
      res.errors++;
      lastError = err.reason;
    }
  }
  await ctx.db.query('UPDATE connectors SET last_poll_at = now(), last_error = $2 WHERE id = $1', [c.id, lastError]);
  return res;
}

export async function pollConnectorNow(ctx: Ctx, id: string): Promise<PollResult> {
  const c = await loadConnector(ctx, id);
  if (!c.enabled) throw new HttpError(400, m('conn.disabled', { name: c.name }), 'CONNECTOR_DISABLED');
  return pollConnector(ctx, c);
}

/** Background job: every enabled connector with polling switched on. */
export async function pollConnectors(ctx: Ctx): Promise<PollResult> {
  const total: PollResult = { checked: 0, updated: 0, errors: 0 };
  const rows = await ctx.db.query<ConnectorRow>(`SELECT * FROM connectors WHERE enabled AND (config->>'poll')::boolean IS TRUE`);
  for (const c of rows.rows) {
    const r = await pollConnector(ctx, c);
    total.checked += r.checked;
    total.updated += r.updated;
    total.errors += r.errors;
  }
  return total;
}

/** Inbound callback: runs in the tenant of the connector with the system as actor. */
export async function inboundStatus(c: ConnectorRow, ref: string, names: string[]) {
  return withTenant(c.tenant_id, async (db) => applyExternalStatus(await buildCtx(db, c.tenant_id, null), c, ref, names, 'callback'));
}

// ---------------------------------------------------------------- tickets for the problem radar (R4-01)

/**
 * Reads title and description of the recent tickets of an enabled connector (problem radar,
 * R4-01). Same HTTP client, URL check and credentials as the handover; no write in the target system.
 */
export async function fetchTickets(ctx: Ctx, connectorId: string, q: TicketQuery): Promise<TicketText[]> {
  requireFeature(ctx, 'connectors');
  const c = await loadConnector(ctx, connectorId);
  if (!c.enabled) throw new HttpError(400, m('conn.disabled', { name: c.name }), 'CONNECTOR_DISABLED');
  const t = target(c);
  try {
    const first = await call(ctx.db, c, ticketRequest(t, q));
    if (c.kind !== 'azure_devops') return parseTickets(c.kind, first).slice(0, q.max);
    const ids = parseWiqlIds(first, q.max);
    const out: TicketText[] = [];
    for (let i = 0; i < ids.length; i += 200) out.push(...parseTickets(c.kind, await call(ctx.db, c, adoItemsRequest(t, ids.slice(i, i + 200)))));
    return out;
  } catch (err) {
    if (!(err instanceof ConnectorCallError)) throw err;
    throw new HttpError(502, m('conn.failed', { name: c.name, reason: err.reason }), 'CONNECTOR_FAILED');
  }
}
