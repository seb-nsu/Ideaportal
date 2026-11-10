import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { withSystem, withTenant } from '../db/pool.js';
import { buildCtx, type Ctx } from '../lib/context.js';
import { sha256 } from '../lib/crypto.js';
import { HttpError } from '../lib/errors.js';
import { RateLimitError, clientIp, enforce } from '../lib/ratelimit.js';
import { m, tr } from '../i18n/index.js';
import { requestLocale } from '../http.js';
import { audit } from '../services/audit.js';
import { domainAllowed, loadIdentity, syncRoles, type IdentityConfig } from '../services/identity.js';
import {
  SCHEMA, ScimError, UUID, accountEmail, displayNameOf, groupDocFromBody, invalidValue, paging, parseFilter, patchGroup, patchUser,
  userDocFromBody, type GroupDoc, type UserDoc,
} from '../services/scim.js';
import { scimBaseUrl } from './identity.js';
import { assertFeature } from '../services/billing.js';
import { tenantUsable } from '../services/tenantLifecycle.js';

// SCIM 2.0 provisioning (R3-27) under /scim/v2 for Entra ID and Okta. Authenticated with a
// SCIM bearer token per tenant (Settings › Anmeldung); the token decides the tenant, every
// operation runs in that tenant's context (row-level security). Deactivation locks the
// account, ends its sessions and starts the anonymisation period (retention job).

const CONTENT_TYPE = 'application/scim+json; charset=utf-8';

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  org_unit: string | null;
  active: boolean;
  external_id: string | null;
  scim_name: { givenName?: string | null; familyName?: string | null; formatted?: string | null; displayName?: string | null; userName?: string | null } | null;
  anonymized_at: Date | null;
  scim_deleted_at: Date | null;
  created_at: Date;
}

const USER_COLUMNS = 'id, email, display_name, org_unit, active, external_id, scim_name, anonymized_at, scim_deleted_at, created_at';

interface Scope {
  ctx: Ctx;
  cfg: IdentityConfig;
}

async function authenticate(req: FastifyRequest): Promise<{ tenantId: string; tokenId: string }> {
  await enforce([['scimIp', clientIp(req)]]);
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
  const row = match
    ? await withSystem(async (c) => (await c.query<{ id: string; tenant_id: string }>(
      'UPDATE scim_tokens SET last_used_at = now() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id, tenant_id',
      [sha256(match[1])],
    )).rows[0])
    : undefined;
  if (!row) {
    // Failed attempts are limited per address; the 429 replaces the 401 once exceeded.
    await enforce([['scimAuthIp', clientIp(req)]]);
    throw new ScimError(401, undefined, m('identity.scim.unauthorized'));
  }
  await enforce([['scimToken', row.id]]);
  return { tenantId: row.tenant_id, tokenId: row.id };
}

/** Runs fn in the tenant of the SCIM token. */
function scim<T>(fn: (s: Scope, req: FastifyRequest, reply: FastifyReply) => Promise<T>) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const { tenantId } = await authenticate(req);
    // Suspended tenants and tenants being deleted (enterprise) accept no provisioning.
    if (!(await tenantUsable(tenantId))) throw new ScimError(403, undefined, m('tenantlc.suspended'));
    // SCIM belongs to the package (R3-05).
    await assertFeature(tenantId, 'scim');
    const result = await withTenant(tenantId, async (db) => {
      const ctx = await buildCtx(db, tenantId, null);
      return fn({ ctx, cfg: await loadIdentity(db, tenantId) }, req, reply);
    });
    reply.type(CONTENT_TYPE);
    return result;
  };
}

const iso = (d: Date) => new Date(d).toISOString();

function userResource(u: UserRow, groups: { id: string; display_name: string }[]) {
  const n = u.scim_name ?? {};
  return {
    schemas: [SCHEMA.user, SCHEMA.enterprise],
    id: u.id,
    externalId: u.external_id ?? undefined,
    userName: n.userName ?? u.email,
    name: { formatted: n.formatted ?? u.display_name, givenName: n.givenName ?? undefined, familyName: n.familyName ?? undefined },
    displayName: u.display_name,
    active: u.active,
    emails: [{ value: u.email, type: 'work', primary: true }],
    groups: groups.map((g) => ({ value: g.id, display: g.display_name, $ref: `${scimBaseUrl()}/Groups/${g.id}` })),
    [SCHEMA.enterprise]: { department: u.org_unit ?? undefined },
    meta: { resourceType: 'User', created: iso(u.created_at), lastModified: iso(u.created_at), location: `${scimBaseUrl()}/Users/${u.id}` },
  };
}

function docOf(u: UserRow): UserDoc {
  const n = u.scim_name ?? {};
  return {
    userName: n.userName ?? u.email,
    email: u.email,
    externalId: u.external_id,
    active: u.active,
    displayName: n.displayName ?? null,
    name: { givenName: n.givenName ?? null, familyName: n.familyName ?? null, formatted: n.formatted ?? null },
    department: u.org_unit,
  };
}

async function userGroups(s: Scope, userIds: string[]) {
  const r = await s.ctx.db.query<{ user_id: string; id: string; display_name: string }>(
    `SELECT m.user_id, g.id, g.display_name FROM scim_group_members m JOIN scim_groups g ON g.id = m.group_id
      WHERE m.user_id = ANY($1::uuid[]) ORDER BY g.display_name`,
    [userIds],
  );
  const by = new Map<string, { id: string; display_name: string }[]>();
  for (const row of r.rows) by.set(row.user_id, [...(by.get(row.user_id) ?? []), { id: row.id, display_name: row.display_name }]);
  return by;
}

async function loadUser(s: Scope, id: string): Promise<UserRow> {
  const u = UUID.test(id)
    ? (await s.ctx.db.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1 AND scim_deleted_at IS NULL AND anonymized_at IS NULL`, [id])).rows[0]
    : undefined;
  if (!u) throw new ScimError(404, undefined, m('identity.scim.notFound'));
  return u;
}

async function endSessions(userId: string): Promise<void> {
  await withSystem((c) => c.query('DELETE FROM sessions WHERE user_id = $1', [userId]));
}

/** Writes a user document; handles activation, deactivation and the unique address. */
async function saveUser(s: Scope, doc: UserDoc, existing: UserRow | null): Promise<string> {
  const email = accountEmail(doc);
  if (!domainAllowed(s.cfg, email)) throw new ScimError(400, 'invalidValue', m('identity.scim.domain'));
  const clash = await s.ctx.db.query<{ id: string; scim_deleted_at: Date | null }>(
    'SELECT id, scim_deleted_at FROM users WHERE lower(email) = lower($1) AND anonymized_at IS NULL AND id <> $2',
    [email, existing?.id ?? '00000000-0000-0000-0000-000000000000'],
  );
  if (clash.rowCount) throw new ScimError(409, 'uniqueness', m('identity.scim.uniqueness'));
  const active = doc.active ?? true;
  if (existing?.anonymized_at && active) throw new ScimError(400, 'mutability', m('identity.scim.anonymized'));
  const scimName = { userName: doc.userName ?? null, givenName: doc.name?.givenName ?? null, familyName: doc.name?.familyName ?? null, formatted: doc.name?.formatted ?? null, displayName: doc.displayName ?? null };
  const values = [email, displayNameOf({ ...doc, userName: email }), doc.department ?? null, doc.externalId ?? null, JSON.stringify(scimName), active];
  let id: string;
  if (existing) {
    await s.ctx.db.query(
      `UPDATE users SET email = $2, display_name = $3, org_unit = $4, external_id = $5, scim_name = $6, active = $7, idp_managed = true,
              scim_deleted_at = NULL, deactivated_at = CASE WHEN $7 THEN NULL ELSE coalesce(deactivated_at, now()) END
        WHERE id = $1`,
      [existing.id, ...values],
    );
    id = existing.id;
    if (existing.active !== active) await audit(s.ctx, active ? 'scim.user.activate' : 'scim.user.deactivate', 'user', id, { active: existing.active }, { active });
    else await audit(s.ctx, 'scim.user.update', 'user', id, null, { email });
  } else {
    id = (await s.ctx.db.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, display_name, org_unit, external_id, scim_name, active, roles, idp_managed, deactivated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, ARRAY['submitter'], true, CASE WHEN $7 THEN NULL ELSE now() END) RETURNING id`,
      [s.ctx.tenantId, ...values],
    )).rows[0].id;
    await audit(s.ctx, 'scim.user.create', 'user', id, null, { email, active });
  }
  if (!active) await endSessions(id);
  await syncRoles(s.ctx.db, s.cfg, id);
  return id;
}

async function sendUser(s: Scope, id: string) {
  const u = (await s.ctx.db.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id])).rows[0];
  return userResource(u, (await userGroups(s, [id])).get(id) ?? []);
}

// ---------------------------------------------------------------- groups

interface GroupRow {
  id: string;
  display_name: string;
  external_id: string | null;
  created_at: Date;
  updated_at: Date;
}

async function loadGroup(s: Scope, id: string): Promise<GroupRow> {
  const g = UUID.test(id) ? (await s.ctx.db.query<GroupRow>('SELECT id, display_name, external_id, created_at, updated_at FROM scim_groups WHERE id = $1', [id])).rows[0] : undefined;
  if (!g) throw new ScimError(404, undefined, m('identity.scim.notFound'));
  return g;
}

async function groupMembers(s: Scope, groupIds: string[]) {
  const r = await s.ctx.db.query<{ group_id: string; user_id: string; display_name: string }>(
    `SELECT m.group_id, m.user_id, u.display_name FROM scim_group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ANY($1::uuid[])`,
    [groupIds],
  );
  const by = new Map<string, { user_id: string; display_name: string }[]>();
  for (const row of r.rows) by.set(row.group_id, [...(by.get(row.group_id) ?? []), row]);
  return by;
}

function groupResource(g: GroupRow, members: { user_id: string; display_name: string }[] | null) {
  return {
    schemas: [SCHEMA.group],
    id: g.id,
    externalId: g.external_id ?? undefined,
    displayName: g.display_name,
    ...(members ? { members: members.map((mb) => ({ value: mb.user_id, display: mb.display_name, $ref: `${scimBaseUrl()}/Users/${mb.user_id}` })) } : {}),
    meta: { resourceType: 'Group', created: iso(g.created_at), lastModified: iso(g.updated_at), location: `${scimBaseUrl()}/Groups/${g.id}` },
  };
}

const excludesMembers = (req: FastifyRequest) =>
  String((req.query as Record<string, unknown>).excludedAttributes ?? '').toLowerCase().split(',').map((x) => x.trim()).includes('members');

/** Stores name and members; members must be accounts of this tenant (others are ignored). */
async function saveGroup(s: Scope, doc: GroupDoc, existing: GroupRow | null): Promise<string> {
  let id: string;
  if (existing) {
    await s.ctx.db.query('UPDATE scim_groups SET display_name = $2, external_id = $3, updated_at = now() WHERE id = $1', [existing.id, doc.displayName, doc.externalId ?? null]);
    id = existing.id;
  } else {
    id = (await s.ctx.db.query<{ id: string }>('INSERT INTO scim_groups (tenant_id, display_name, external_id) VALUES ($1, $2, $3) RETURNING id', [
      s.ctx.tenantId, doc.displayName, doc.externalId ?? null,
    ])).rows[0].id;
  }
  // Foreign keys ignore row-level security, so member IDs are checked in the tenant's context first.
  const wanted = doc.members.filter((x) => UUID.test(x));
  const valid = wanted.length
    ? (await s.ctx.db.query<{ id: string }>('SELECT id FROM users WHERE id = ANY($1::uuid[]) AND scim_deleted_at IS NULL AND anonymized_at IS NULL', [wanted])).rows.map((r) => r.id)
    : [];
  const before = (await s.ctx.db.query<{ user_id: string }>('SELECT user_id FROM scim_group_members WHERE group_id = $1', [id])).rows.map((r) => r.user_id);
  const removed = before.filter((u) => !valid.includes(u));
  const added = valid.filter((u) => !before.includes(u));
  if (removed.length) await s.ctx.db.query('DELETE FROM scim_group_members WHERE group_id = $1 AND user_id = ANY($2::uuid[])', [id, removed]);
  for (const u of added) await s.ctx.db.query('INSERT INTO scim_group_members (tenant_id, group_id, user_id) VALUES ($1, $2, $3)', [s.ctx.tenantId, id, u]);
  // Name changes can change the mapping, so every member is recomputed.
  for (const u of new Set([...before, ...valid])) await syncRoles(s.ctx.db, s.cfg, u);
  await audit(s.ctx, existing ? 'scim.group.update' : 'scim.group.create', 'scim_group', id, null, { displayName: doc.displayName, added: added.length, removed: removed.length });
  return id;
}

async function sendGroup(s: Scope, id: string, withMembers = true) {
  const g = await loadGroup(s, id);
  return groupResource(g, withMembers ? (await groupMembers(s, [id])).get(id) ?? [] : null);
}

// ---------------------------------------------------------------- discovery documents

const attr = (name: string, type: string, extra: Record<string, unknown> = {}) => ({
  name, type, multiValued: false, required: false, caseExact: false, mutability: 'readWrite', returned: 'default', uniqueness: 'none', ...extra,
});

const SCHEMAS = [
  {
    id: SCHEMA.user, name: 'User', description: 'User Account',
    attributes: [
      attr('userName', 'string', { required: true, uniqueness: 'server' }),
      attr('name', 'complex', { subAttributes: [attr('formatted', 'string'), attr('givenName', 'string'), attr('familyName', 'string')] }),
      attr('displayName', 'string'),
      attr('active', 'boolean'),
      attr('externalId', 'string', { caseExact: true }),
      attr('emails', 'complex', { multiValued: true, subAttributes: [attr('value', 'string'), attr('type', 'string'), attr('primary', 'boolean')] }),
      attr('groups', 'complex', { multiValued: true, mutability: 'readOnly', subAttributes: [attr('value', 'string'), attr('display', 'string')] }),
    ],
  },
  { id: SCHEMA.enterprise, name: 'EnterpriseUser', description: 'Enterprise User', attributes: [attr('department', 'string')] },
  {
    id: SCHEMA.group, name: 'Group', description: 'Group',
    attributes: [
      attr('displayName', 'string', { required: true }),
      attr('externalId', 'string', { caseExact: true }),
      attr('members', 'complex', { multiValued: true, subAttributes: [attr('value', 'string', { mutability: 'immutable' }), attr('display', 'string', { mutability: 'readOnly' })] }),
    ],
  },
].map((s) => ({ ...s, schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'], meta: { resourceType: 'Schema', location: `/scim/v2/Schemas/${s.id}` } }));

const RESOURCE_TYPES = [
  { id: 'User', name: 'User', endpoint: '/Users', schema: SCHEMA.user, schemaExtensions: [{ schema: SCHEMA.enterprise, required: false }] },
  { id: 'Group', name: 'Group', endpoint: '/Groups', schema: SCHEMA.group },
].map((r) => ({ ...r, schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], meta: { resourceType: 'ResourceType', location: `/scim/v2/ResourceTypes/${r.id}` } }));

const list = (resources: unknown[], total: number, startIndex: number) => ({
  schemas: [SCHEMA.list], totalResults: total, startIndex, itemsPerPage: resources.length, Resources: resources,
});

// ---------------------------------------------------------------- routes

export async function scimRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser('application/scim+json', { parseAs: 'string' }, app.getDefaultJsonParser('error', 'error'));

  app.setErrorHandler((err, req, reply) => {
    const locale = requestLocale(req);
    reply.type(CONTENT_TYPE);
    const send = (status: number, detail: string, scimType?: string) =>
      reply.status(status).send({ schemas: [SCHEMA.error], status: String(status), ...(scimType ? { scimType } : {}), detail });
    if (err instanceof ScimError) return send(err.status, tr(locale, err.text), err.scimType);
    if (err instanceof RateLimitError) {
      reply.header('retry-after', String(err.retryAfter));
      return send(429, tr(locale, err.text));
    }
    if (err instanceof HttpError) return send(err.status, tr(locale, err.text));
    if (err instanceof ZodError) return send(400, tr(locale, m('identity.scim.invalidSyntax')), 'invalidSyntax');
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return send(status, tr(locale, m('identity.scim.invalidSyntax')), 'invalidSyntax');
    req.log.error(err);
    return send(500, tr(locale, m('common.internal')));
  });

  app.setNotFoundHandler((req, reply) => {
    reply.type(CONTENT_TYPE).status(404).send({ schemas: [SCHEMA.error], status: '404', detail: tr(requestLocale(req), m('identity.scim.notFound')) });
  });

  // Discovery (RFC 7644 section 4): no tenant data, so no token needed.
  const discovery = (body: unknown) => async (req: FastifyRequest, reply: FastifyReply) => {
    await enforce([['scimIp', clientIp(req)]]);
    reply.type(CONTENT_TYPE);
    return body;
  };
  app.get('/ServiceProviderConfig', discovery({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{ type: 'oauthbearertoken', name: 'OAuth Bearer Token', description: 'SCIM token from Einstellungen › Anmeldung', primary: true }], // texts-ok
    meta: { resourceType: 'ServiceProviderConfig', location: '/scim/v2/ServiceProviderConfig' },
  }));
  app.get('/Schemas', discovery(list(SCHEMAS, SCHEMAS.length, 1)));
  app.get('/ResourceTypes', discovery(list(RESOURCE_TYPES, RESOURCE_TYPES.length, 1)));

  // --- Users
  app.get('/Users', scim(async (s, req) => {
    const q = req.query as Record<string, unknown>;
    const f = parseFilter(typeof q.filter === 'string' ? q.filter : undefined);
    const { startIndex, count } = paging(q);
    let where = 'scim_deleted_at IS NULL AND anonymized_at IS NULL';
    const params: unknown[] = [];
    if (f) {
      if (f.attr === 'username') where += ` AND (lower(email) = lower($1) OR lower(scim_name->>'userName') = lower($1))`;
      else if (f.attr === 'externalid') where += ' AND external_id = $1';
      else if (f.attr === 'id') where += ` AND id::text = lower($1)`;
      else if (f.attr === 'displayname') where += ' AND display_name = $1';
      else if (f.attr === 'emails.value' || /^emails\[type eq "work"\]\.value$/.test(f.attr)) where += ' AND lower(email) = lower($1)';
      else throw new ScimError(400, 'invalidFilter', m('identity.scim.invalidFilter'));
      params.push(f.value);
    }
    const total = (await s.ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE ${where}`, params)).rows[0].n;
    const rows = (await s.ctx.db.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE ${where} ORDER BY created_at, id LIMIT ${count} OFFSET ${startIndex - 1}`, params,
    )).rows;
    const groups = await userGroups(s, rows.map((u) => u.id));
    return list(rows.map((u) => userResource(u, groups.get(u.id) ?? [])), total, startIndex);
  }));

  app.get('/Users/:id', scim(async (s, req) => {
    const u = await loadUser(s, (req.params as { id: string }).id);
    return userResource(u, (await userGroups(s, [u.id])).get(u.id) ?? []);
  }));

  app.post('/Users', scim(async (s, req, reply) => {
    const doc = userDocFromBody(req.body);
    const email = accountEmail(doc);
    // A person deleted via SCIM before (not yet anonymised) comes back as the same account.
    const previous = (await s.ctx.db.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = lower($1) AND anonymized_at IS NULL AND scim_deleted_at IS NOT NULL`, [email],
    )).rows[0];
    const id = await saveUser(s, doc, previous ?? null);
    reply.code(201);
    return sendUser(s, id);
  }));

  app.put('/Users/:id', scim(async (s, req) => {
    const u = await loadUser(s, (req.params as { id: string }).id);
    const id = await saveUser(s, userDocFromBody(req.body), u);
    return sendUser(s, id);
  }));

  app.patch('/Users/:id', scim(async (s, req) => {
    const u = await loadUser(s, (req.params as { id: string }).id);
    const id = await saveUser(s, patchUser(docOf(u), req.body), u);
    return sendUser(s, id);
  }));

  app.delete('/Users/:id', scim(async (s, req, reply) => {
    const u = await loadUser(s, (req.params as { id: string }).id);
    // Delete = lock now, anonymise after the retention period (Settings › Prozess › Löschfristen).
    await s.ctx.db.query(
      `UPDATE users SET active = false, deactivated_at = coalesce(deactivated_at, now()), scim_deleted_at = now() WHERE id = $1`,
      [u.id],
    );
    const groups = await s.ctx.db.query<{ group_id: string }>('DELETE FROM scim_group_members WHERE user_id = $1 RETURNING group_id', [u.id]);
    await endSessions(u.id);
    await audit(s.ctx, 'scim.user.delete', 'user', u.id, { active: u.active }, { active: false, groups: groups.rowCount });
    reply.code(204);
    return null;
  }));

  // --- Groups
  app.get('/Groups', scim(async (s, req) => {
    const q = req.query as Record<string, unknown>;
    const f = parseFilter(typeof q.filter === 'string' ? q.filter : undefined);
    const { startIndex, count } = paging(q);
    let where = 'true';
    const params: unknown[] = [];
    if (f) {
      if (f.attr === 'displayname') where = 'lower(display_name) = lower($1)';
      else if (f.attr === 'externalid') where = 'external_id = $1';
      else if (f.attr === 'id') where = 'id::text = lower($1)';
      else throw new ScimError(400, 'invalidFilter', m('identity.scim.invalidFilter'));
      params.push(f.value);
    }
    const total = (await s.ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM scim_groups WHERE ${where}`, params)).rows[0].n;
    const rows = (await s.ctx.db.query<GroupRow>(
      `SELECT id, display_name, external_id, created_at, updated_at FROM scim_groups WHERE ${where} ORDER BY created_at, id LIMIT ${count} OFFSET ${startIndex - 1}`, params,
    )).rows;
    const withMembers = !excludesMembers(req);
    const members = withMembers ? await groupMembers(s, rows.map((g) => g.id)) : new Map();
    return list(rows.map((g) => groupResource(g, withMembers ? members.get(g.id) ?? [] : null)), total, startIndex);
  }));

  app.get('/Groups/:id', scim(async (s, req) => sendGroup(s, (req.params as { id: string }).id, !excludesMembers(req))));

  app.post('/Groups', scim(async (s, req, reply) => {
    const id = await saveGroup(s, groupDocFromBody(req.body), null);
    reply.code(201);
    return sendGroup(s, id);
  }));

  app.put('/Groups/:id', scim(async (s, req) => {
    const g = await loadGroup(s, (req.params as { id: string }).id);
    const id = await saveGroup(s, groupDocFromBody(req.body), g);
    return sendGroup(s, id);
  }));

  app.patch('/Groups/:id', scim(async (s, req, reply) => {
    const g = await loadGroup(s, (req.params as { id: string }).id);
    const members = (await s.ctx.db.query<{ user_id: string }>('SELECT user_id FROM scim_group_members WHERE group_id = $1', [g.id])).rows.map((r) => r.user_id);
    const doc = patchGroup({ displayName: g.display_name, externalId: g.external_id, members }, req.body);
    if (!doc.displayName) throw invalidValue('displayName');
    await saveGroup(s, doc, g);
    // Entra ID expects 204 without a body for group PATCH; Okta accepts both.
    reply.code(204);
    return null;
  }));

  app.delete('/Groups/:id', scim(async (s, req, reply) => {
    const g = await loadGroup(s, (req.params as { id: string }).id);
    const members = (await s.ctx.db.query<{ user_id: string }>('DELETE FROM scim_group_members WHERE group_id = $1 RETURNING user_id', [g.id])).rows.map((r) => r.user_id);
    await s.ctx.db.query('DELETE FROM scim_groups WHERE id = $1', [g.id]);
    for (const u of members) await syncRoles(s.ctx.db, s.cfg, u);
    await audit(s.ctx, 'scim.group.delete', 'scim_group', g.id, { displayName: g.display_name }, null);
    reply.code(204);
    return null;
  }));
}
