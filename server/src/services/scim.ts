import { m, type Text } from '../i18n/index.js';

// SCIM 2.0 (RFC 7643, RFC 7644) for Entra ID and Okta (R3-27): resource documents, PATCH
// operations and filters. Pure functions; the routes in routes/scim.ts store the result.
// Only the attributes the portal needs are kept (userName, name, displayName, active,
// externalId, department, group members); everything else a provider sends is ignored
// on purpose (data minimisation), not rejected, so the default mappings of Entra ID work.

export const SCHEMA = {
  user: 'urn:ietf:params:scim:schemas:core:2.0:User',
  enterprise: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User',
  group: 'urn:ietf:params:scim:schemas:core:2.0:Group',
  list: 'urn:ietf:params:scim:api:messages:2.0:ListResponse',
  patch: 'urn:ietf:params:scim:api:messages:2.0:PatchOp',
  error: 'urn:ietf:params:scim:api:messages:2.0:Error',
} as const;

export class ScimError extends Error {
  constructor(public status: number, public scimType: string | undefined, public text: Text) {
    super(typeof text === 'string' ? text : 'scim error');
  }
}

export const invalidValue = (field: string) => new ScimError(400, 'invalidValue', m('identity.scim.invalidValue', { field }));

export interface UserDoc {
  userName?: string;
  /** Work address from emails; used as the account address when userName is not an address. */
  email?: string | null;
  externalId?: string | null;
  active?: boolean;
  displayName?: string | null;
  name?: { givenName?: string | null; familyName?: string | null; formatted?: string | null };
  department?: string | null;
}

export interface GroupDoc {
  displayName?: string;
  externalId?: string | null;
  members: string[];
}

export interface PatchOp {
  op: string;
  path?: string;
  value?: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Entra ID sends booleans as "True"/"False" strings in PATCH requests. */
export function toBool(v: unknown, field: string): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string' && /^(true|false)$/i.test(v.trim())) return v.trim().toLowerCase() === 'true';
  throw invalidValue(field);
}

function toStr(v: unknown, field: string, max = 200): string | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v) && v.length === 1) return toStr(isObject(v[0]) ? v[0].value : v[0], field, max);
  if (typeof v !== 'string' && typeof v !== 'number') throw invalidValue(field);
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function stripPrefix(path: string, schema: string): string | null {
  return path.toLowerCase().startsWith(`${schema.toLowerCase()}:`) ? path.slice(schema.length + 1) : null;
}

/** Sets (or with value undefined removes) one user attribute addressed by a SCIM path. */
export function setUserAttr(doc: UserDoc, rawPath: string, value: unknown): void {
  let path = rawPath.trim();
  if (path.toLowerCase() === SCHEMA.enterprise.toLowerCase()) {
    if (value === undefined) return void (doc.department = null);
    if (!isObject(value)) throw invalidValue(path);
    for (const [k, v] of Object.entries(value)) setUserAttr(doc, `${SCHEMA.enterprise}:${k}`, v);
    return;
  }
  const ext = stripPrefix(path, SCHEMA.enterprise);
  if (ext !== null) {
    if (ext.toLowerCase() === 'department') doc.department = value === undefined ? null : toStr(value, 'department', 120);
    return; // manager, employeeNumber, costCenter …: not stored
  }
  path = stripPrefix(path, SCHEMA.user) ?? path;
  const key = path.toLowerCase();
  switch (key) {
    case 'username': {
      const v = toStr(value, 'userName');
      if (!v) throw invalidValue('userName');
      doc.userName = v.toLowerCase();
      return;
    }
    case 'emails': {
      const list = Array.isArray(value) ? value.filter(isObject) : [];
      const pick = list.find((e) => e.primary === true || e.primary === 'True') ?? list.find((e) => e.type === 'work') ?? list[0];
      doc.email = value === undefined ? null : toStr(pick?.value, 'emails');
      if (doc.email) doc.email = doc.email.toLowerCase();
      return;
    }
    case 'externalid':
      doc.externalId = value === undefined ? null : toStr(value, 'externalId');
      return;
    case 'active':
      if (value !== undefined) doc.active = toBool(value, 'active');
      return;
    case 'displayname':
      doc.displayName = value === undefined ? null : toStr(value, 'displayName', 120);
      return;
    case 'name':
      if (value === undefined) return void (doc.name = {});
      if (!isObject(value)) throw invalidValue('name');
      for (const [k, v] of Object.entries(value)) setUserAttr(doc, `name.${k}`, v);
      return;
    case 'name.givenname':
    case 'name.familyname':
    case 'name.formatted': {
      const sub = (['givenName', 'familyName', 'formatted'] as const).find((s) => `name.${s.toLowerCase()}` === key)!;
      doc.name = { ...doc.name, [sub]: value === undefined ? null : toStr(value, path, 120) };
      return;
    }
    default:
      // emails[type eq "work"].value (Entra ID): the work address
      if (/^emails\[.*\]\.value$/.test(key) || key === 'emails.value') {
        if (/type\s+eq\s+"(?!work)/.test(key)) return;
        const v = value === undefined ? null : toStr(value, 'emails');
        doc.email = v ? v.toLowerCase() : null;
      }
      // phoneNumbers, addresses, title, locale …: not stored
      return;
  }
}

/** A user document from the body of POST or PUT. */
export function userDocFromBody(body: unknown): UserDoc {
  if (!isObject(body)) throw new ScimError(400, 'invalidSyntax', m('identity.scim.invalidSyntax'));
  const doc: UserDoc = { active: true };
  for (const [k, v] of Object.entries(body)) {
    if (k === 'schemas' || k === 'id' || k === 'meta') continue;
    setUserAttr(doc, k, v);
  }
  accountEmail(doc);
  return doc;
}

/** The account address: userName when it is an address (UPN), else the work address. */
export function accountEmail(doc: UserDoc): string {
  const email = doc.userName?.includes('@') ? doc.userName : doc.email;
  if (!doc.userName || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw invalidValue('userName');
  return email.toLowerCase();
}

function patchOps(body: unknown): PatchOp[] {
  if (!isObject(body) || !Array.isArray(body.Operations)) throw new ScimError(400, 'invalidSyntax', m('identity.scim.invalidSyntax'));
  return body.Operations.map((o) => {
    if (!isObject(o) || typeof o.op !== 'string' || !['add', 'replace', 'remove'].includes(o.op.toLowerCase())) {
      throw new ScimError(400, 'invalidSyntax', m('identity.scim.invalidSyntax'));
    }
    return { op: o.op.toLowerCase(), path: typeof o.path === 'string' ? o.path : undefined, value: o.value };
  });
}

export function patchUser(doc: UserDoc, body: unknown): UserDoc {
  const next: UserDoc = { ...doc, name: { ...doc.name } };
  for (const op of patchOps(body)) {
    if (!op.path) {
      if (op.op === 'remove') throw new ScimError(400, 'noTarget', m('identity.scim.invalidPath', { path: '' }));
      if (!isObject(op.value)) throw invalidValue('value');
      for (const [k, v] of Object.entries(op.value)) setUserAttr(next, k, v);
    } else {
      setUserAttr(next, op.path, op.op === 'remove' ? undefined : op.value);
    }
  }
  return next;
}

/** Display name: displayName, else name.formatted, else given and family name, else the address. */
export function displayNameOf(doc: UserDoc): string {
  const parts = [doc.name?.givenName, doc.name?.familyName].filter(Boolean).join(' ');
  const name = doc.displayName || doc.name?.formatted || parts || (doc.userName ?? '').split('@')[0];
  return name.length >= 2 ? name.slice(0, 120) : (doc.userName ?? 'xx').slice(0, 120);
}

// ---------------------------------------------------------------- groups

function memberIds(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return list.map((v) => (isObject(v) ? v.value : v)).filter((v): v is string => typeof v === 'string');
}

const MEMBER_FILTER = /^members\[\s*value\s+eq\s+"([^"]+)"\s*\]$/i;

export function groupDocFromBody(body: unknown): GroupDoc {
  if (!isObject(body)) throw new ScimError(400, 'invalidSyntax', m('identity.scim.invalidSyntax'));
  const displayName = toStr(body.displayName, 'displayName');
  if (!displayName) throw invalidValue('displayName');
  return { displayName, externalId: toStr(body.externalId, 'externalId'), members: memberIds(body.members) };
}

export function patchGroup(doc: GroupDoc, body: unknown): GroupDoc {
  const next: GroupDoc = { ...doc, members: [...doc.members] };
  const set = (attr: string, value: unknown, op: string) => {
    const key = (stripPrefix(attr, SCHEMA.group) ?? attr).toLowerCase();
    if (key === 'displayname') {
      const v = toStr(value, 'displayName');
      if (!v) throw invalidValue('displayName');
      next.displayName = v;
    } else if (key === 'externalid') {
      next.externalId = op === 'remove' ? null : toStr(value, 'externalId');
    } else if (key === 'members') {
      const ids = memberIds(value);
      if (op === 'add') next.members = Array.from(new Set([...next.members, ...ids]));
      else if (op === 'replace') next.members = Array.from(new Set(ids));
      else next.members = ids.length ? next.members.filter((id) => !ids.includes(id)) : [];
    }
    // id, meta and unknown attributes: ignored
  };
  for (const op of patchOps(body)) {
    if (!op.path) {
      if (op.op === 'remove') throw new ScimError(400, 'noTarget', m('identity.scim.invalidPath', { path: '' }));
      if (!isObject(op.value)) throw invalidValue('value');
      for (const [k, v] of Object.entries(op.value)) set(k, v, op.op);
      continue;
    }
    const filtered = MEMBER_FILTER.exec(op.path.trim());
    if (filtered) {
      if (op.op === 'remove') next.members = next.members.filter((id) => id !== filtered[1]);
      else next.members = Array.from(new Set([...next.members, filtered[1]]));
      continue;
    }
    set(op.path.trim(), op.value, op.op);
  }
  return next;
}

// ---------------------------------------------------------------- filters and paging

/** Supports the filters Entra ID and Okta send: `attribute eq "value"`. */
export function parseFilter(filter: string | undefined): { attr: string; value: string } | null {
  if (!filter) return null;
  const f = /^\s*([\w.:\[\]" ]+?)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  if (!f) throw new ScimError(400, 'invalidFilter', m('identity.scim.invalidFilter'));
  return { attr: f[1].trim().toLowerCase(), value: f[2].replace(/\\(.)/g, '$1') };
}

export function paging(query: Record<string, unknown>): { startIndex: number; count: number } {
  const start = Number(query.startIndex ?? 1);
  const count = Number(query.count ?? 100);
  return {
    startIndex: Number.isFinite(start) && start >= 1 ? Math.floor(start) : 1,
    count: Number.isFinite(count) ? Math.min(200, Math.max(0, Math.floor(count))) : 100,
  };
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
