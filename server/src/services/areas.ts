import { z } from 'zod';
import type { Db } from '../db/pool.js';
import { SCOPABLE_ROLES, restrictToAreas, scopeAreas, type Ctx, type Role, type SessionUser } from '../lib/context.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { m } from '../i18n/index.js';
import { audit } from './audit.js';

// Areas and roles with a scope (R3-29).
//
// An area is master data per tenant (e.g. a business unit or a topic field). An idea belongs to
// every area whose topics contain the idea's topic or whose org units contain the org unit of
// the author (rule in SQL: idea_in_area, migration 022). Roles in users.roles are tenant-wide;
// role_assignments adds roles that apply to the ideas of one area only. Board, tasks, deadline
// reminders and escalations, notifications to roles and the dashboard follow the scope.

export const areaInput = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).default(''),
  topics: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
  orgUnits: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
});
export type AreaInput = z.infer<typeof areaInput>;

export const scopedRoleSchema = z.object({ role: z.enum(SCOPABLE_ROLES), areaId: z.uuid() });
export type ScopedRole = z.infer<typeof scopedRoleSchema>;

export interface Area {
  id: string;
  name: string;
  description: string;
  topics: string[];
  orgUnits: string[];
}

const AREA_COLUMNS = 'id, name, description, topics, org_units AS "orgUnits"';

export async function listAreas(ctx: Ctx): Promise<Area[]> {
  return (await ctx.db.query<Area>(`SELECT ${AREA_COLUMNS} FROM areas ORDER BY lower(name)`)).rows;
}

const uniq = (xs: string[]) => [...new Map(xs.map((x) => [x.toLowerCase(), x])).values()];

async function nameTaken(ctx: Ctx, name: string, except: string | null): Promise<boolean> {
  const r = await ctx.db.query('SELECT 1 FROM areas WHERE lower(name) = lower($1) AND id IS DISTINCT FROM $2', [name, except]);
  return !!r.rowCount;
}

export async function createArea(ctx: Ctx, input: AreaInput): Promise<Area> {
  if (await nameTaken(ctx, input.name, null)) throw conflict(m('areas.nameTaken'));
  const area = (await ctx.db.query<Area>(
    `INSERT INTO areas (tenant_id, name, description, topics, org_units) VALUES ($1, $2, $3, $4, $5) RETURNING ${AREA_COLUMNS}`,
    [ctx.tenantId, input.name, input.description, uniq(input.topics), uniq(input.orgUnits)],
  )).rows[0];
  await audit(ctx, 'area.create', 'area', area.id, null, area);
  return area;
}

export async function updateArea(ctx: Ctx, id: string, input: AreaInput): Promise<Area> {
  const before = (await ctx.db.query<Area>(`SELECT ${AREA_COLUMNS} FROM areas WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!before) throw notFound(m('areas.notFound'));
  if (await nameTaken(ctx, input.name, id)) throw conflict(m('areas.nameTaken'));
  const after = (await ctx.db.query<Area>(
    `UPDATE areas SET name = $2, description = $3, topics = $4, org_units = $5, updated_at = now() WHERE id = $1 RETURNING ${AREA_COLUMNS}`,
    [id, input.name, input.description, uniq(input.topics), uniq(input.orgUnits)],
  )).rows[0];
  await audit(ctx, 'area.update', 'area', id, before, after);
  return after;
}

/** Deleting an area removes its scoped roles (cascade); the people keep their tenant-wide roles. */
export async function deleteArea(ctx: Ctx, id: string): Promise<void> {
  const before = (await ctx.db.query<Area>(`SELECT ${AREA_COLUMNS} FROM areas WHERE id = $1`, [id])).rows[0];
  if (!before) throw notFound(m('areas.notFound'));
  const roles = (await ctx.db.query('SELECT user_id, role FROM role_assignments WHERE area_id = $1', [id])).rows;
  await ctx.db.query('DELETE FROM areas WHERE id = $1', [id]);
  await audit(ctx, 'area.delete', 'area', id, { ...before, roles }, null);
}

// ---------------------------------------------------------------- scoped roles of people

/** Scoped roles of one or more people: user ID → [{role, areaId, source}]. */
export async function scopedRolesOf(db: Db, userIds: string[]): Promise<Map<string, (ScopedRole & { source: string })[]>> {
  const out = new Map<string, (ScopedRole & { source: string })[]>();
  if (!userIds.length) return out;
  const r = await db.query<{ user_id: string; role: ScopedRole['role']; area_id: string; source: string }>(
    'SELECT user_id, role, area_id, source FROM role_assignments WHERE user_id = ANY($1::uuid[]) ORDER BY role, area_id',
    [userIds],
  );
  for (const row of r.rows) {
    const list = out.get(row.user_id) ?? [];
    list.push({ role: row.role, areaId: row.area_id, source: row.source });
    out.set(row.user_id, list);
  }
  return out;
}

async function requireAreas(db: Db, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const r = await db.query<{ id: string }>('SELECT id FROM areas WHERE id = ANY($1::uuid[])', [ids]);
  if (r.rowCount !== new Set(ids).size) throw badRequest(m('areas.unknownArea'));
}

/** Replaces the manually given scoped roles of a person (admin, Einstellungen › Personen). */
export async function setScopedRoles(ctx: Ctx, userId: string, roles: ScopedRole[]): Promise<void> {
  await requireAreas(ctx.db, roles.map((r) => r.areaId));
  const before = (await scopedRolesOf(ctx.db, [userId])).get(userId)?.filter((r) => r.source === 'manual') ?? [];
  await ctx.db.query("DELETE FROM role_assignments WHERE user_id = $1 AND source = 'manual'", [userId]);
  for (const r of roles) {
    await ctx.db.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role, area_id, source) VALUES ($1, $2, $3, $4, 'manual')
       ON CONFLICT (user_id, role, area_id) DO NOTHING`,
      [ctx.tenantId, userId, r.role, r.areaId],
    );
  }
  await audit(ctx, 'user.scoped_roles', 'user', userId, before.map(({ role, areaId }) => ({ role, areaId })), roles);
}

/**
 * Replaces the scoped roles that come from the identity provider (group → role + area). Unknown
 * areas (deleted after the mapping was saved) are skipped. Returns true when something changed.
 */
export async function syncIdpScopedRoles(db: Db, tenantId: string, userId: string, roles: ScopedRole[]): Promise<boolean> {
  const before = (await db.query<{ k: string }>(
    "SELECT role || ':' || area_id AS k FROM role_assignments WHERE user_id = $1 AND source = 'idp'", [userId],
  )).rows.map((r) => r.k).sort();
  const wanted = [...new Set(roles.map((r) => `${r.role}:${r.areaId}`))].sort();
  if (before.length === wanted.length && before.every((k, i) => k === wanted[i])) return false;
  await db.query("DELETE FROM role_assignments WHERE user_id = $1 AND source = 'idp'", [userId]);
  for (const k of wanted) {
    const [role, areaId] = k.split(':');
    await db.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role, area_id, source)
       SELECT $1, $2, $3, a.id, 'idp' FROM areas a WHERE a.id = $4 AND a.tenant_id = $1
       ON CONFLICT (user_id, role, area_id) DO UPDATE SET source = 'idp'`,
      [tenantId, userId, role, areaId],
    );
  }
  return true;
}

// ---------------------------------------------------------------- rights of the acting person

/**
 * Adds the scoped roles to a person loaded from users (session, AI job, chat). Works on the
 * owner connection and on a tenant connection. Technical users of API tokens have no scopes.
 */
export async function withScopes(db: Db, user: SessionUser): Promise<SessionUser> {
  if (user.technical) return user;
  const r = await db.query<{ role: Role; areas: string[] }>(
    'SELECT role, array_agg(area_id ORDER BY area_id)::text[] AS areas FROM role_assignments WHERE user_id = $1 AND tenant_id = $2 GROUP BY role',
    [user.id, user.tenantId],
  );
  if (!r.rowCount) return user;
  const roles = [...user.roles];
  const scopes: Partial<Record<Role, string[]>> = {};
  for (const row of r.rows) {
    if (user.roles.includes(row.role)) continue; // tenant-wide wins
    roles.push(row.role);
    scopes[row.role] = row.areas;
  }
  return { ...user, roles, scopes };
}

export async function ideaAreaIds(db: Db, ideaId: string): Promise<string[]> {
  return (await db.query<{ a: string[] }>('SELECT idea_area_ids($1)::text[] AS a', [ideaId])).rows[0]?.a ?? [];
}

/**
 * Narrows the acting person's rights to one idea: scoped roles whose areas do not cover the
 * idea no longer count for the rest of the request. Called by loadIdea, so every check after it
 * (triage, Gate 2, meetings, AI) sees only the roles valid for this idea. Narrowing is
 * cumulative: a request on two ideas (merge) needs the role for both.
 */
export async function narrowToIdea(ctx: Ctx, ideaId: string): Promise<void> {
  const u = ctx.user;
  if (!u?.scopes || !Object.keys(u.scopes).length) return;
  ctx.user = restrictToAreas(u, await ideaAreaIds(ctx.db, ideaId));
}

/** Roles that see the dashboard; with a scope only for their areas. */
export const DASHBOARD_ROLES: Role[] = ['admin', 'triage', 'committee', 'lead'];

/**
 * Areas a list is limited to: null = no limit. `only` is an area chosen in a filter; a person
 * with scoped roles can only choose one of their own areas (otherwise the list is empty).
 */
export function areaScope(ctx: Ctx, roles: readonly Role[], only?: string | null): string[] | null {
  const areas = scopeAreas(ctx.user, roles);
  if (only) return areas === null || areas.includes(only) ? [only] : [];
  return areas;
}

/**
 * SQL filter for lists: `AND <col> IN (ideas of the areas)` when the person holds the given
 * roles only for some areas, '' when one of them is tenant-wide. Pushes the parameter.
 * `only` restricts further to one chosen area (dashboard filter).
 */
export function areaFilter(ctx: Ctx, roles: readonly Role[], col: string, params: unknown[], only?: string | null): string {
  const areas = areaScope(ctx, roles, only);
  if (areas === null) return '';
  params.push(areas);
  return `AND ${col} IN (SELECT idea_id FROM ideas_in_areas($${params.length}::uuid[]))`;
}

/** Areas the person may filter by (dashboard): all for tenant-wide roles, else their own. */
export async function selectableAreas(ctx: Ctx, roles: readonly Role[]): Promise<{ items: Pick<Area, 'id' | 'name'>[]; restricted: boolean }> {
  const mine = scopeAreas(ctx.user, roles);
  const all = (await ctx.db.query<Pick<Area, 'id' | 'name'>>('SELECT id, name FROM areas ORDER BY lower(name)')).rows;
  return { items: mine === null ? all : all.filter((a) => mine.includes(a.id)), restricted: mine !== null };
}

/** Co-determination overview (R3-12): areas with the number of people per scoped role. */
export async function scopedRolesOverview(ctx: Ctx) {
  const areas = await listAreas(ctx);
  const counts = (await ctx.db.query<{ area_id: string; role: string; people: number }>(
    `SELECT ra.area_id, ra.role, count(DISTINCT ra.user_id)::int AS people
       FROM role_assignments ra JOIN users u ON u.id = ra.user_id AND u.active GROUP BY 1, 2`,
  )).rows;
  return areas.map((a) => ({
    ...a,
    roles: SCOPABLE_ROLES.map((role) => ({ role, people: counts.find((c) => c.area_id === a.id && c.role === role)?.people ?? 0 })),
  }));
}
