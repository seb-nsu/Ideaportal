import { z } from 'zod';
import { config } from '../config.js';
import { withSystem } from '../db/pool.js';
import { ROLES, SCOPABLE_ROLES, hasRole, type Ctx, type Role, type ScopableRole } from '../lib/context.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { parseTable } from '../lib/importer.js';
import { LOCALES, m, tr } from '../i18n/index.js';
import { issuePasswordToken } from '../routes/auth.js';
import { audit } from './audit.js';
import { listAreas } from './areas.js';

// People administration (enterprise): delegated role "user_admin" and bulk changes without
// SCIM. A user_admin manages people and their roles, but can neither give the admin role nor
// change a person who is admin; settings stay with the admins.

/** Checks a change of a person by the acting user (admin or user_admin). */
export function assertPeopleChange(ctx: Ctx, target: { roles: readonly string[] } | null, nextRoles?: readonly string[] | null): void {
  if (hasRole(ctx.user, 'admin')) return;
  if (target?.roles.includes('admin')) throw forbidden(m('people.adminOnlyByAdmin'));
  if (nextRoles?.includes('admin')) throw forbidden(m('people.adminRoleByAdmin'));
}

// ---------------------------------------------------------------- CSV import

const COLUMNS = {
  email: ['e-mail', 'email', 'mail', 'e-mail-adresse'],
  name: ['name', 'anzeigename', 'display name', 'displayname', 'vollständiger name'],
  roles: ['rollen', 'rolle', 'roles', 'role'],
  department: ['abteilung', 'organisationseinheit', 'department', 'org_unit', 'orgunit', 'org unit', 'bereich (organisation)'],
  area: ['bereich', 'area', 'themenbereich'],
} as const;
type Column = keyof typeof COLUMNS;

export interface ImportRow {
  row: number;
  email: string;
  name: string;
  roles: Role[];
  orgUnit: string | null;
  area: string | null;
  action: 'create' | 'update' | 'skip';
  errors: string[];
}

export const importInput = z.object({
  filename: z.string().min(1).max(200),
  data: z.base64(),
  dryRun: z.boolean().default(true),
});

/** Role from an id or a label in any language (e.g. "Triage", "Gremium", "committee"). */
function roleLookup(): Map<string, Role> {
  const map = new Map<string, Role>();
  for (const r of ROLES) {
    map.set(r, r);
    for (const l of LOCALES) map.set(tr(l, m(`codet.role.${r}`)).toLowerCase(), r);
  }
  return map;
}

/**
 * Reads the table and checks every row. dryRun: preview only. Otherwise new people are invited,
 * existing ones get the new roles added (none removed) and name and department updated.
 * Roles that can be scoped (triage, committee, lead) apply to the given area only.
 */
export async function importPeople(ctx: Ctx, input: z.infer<typeof importInput>) {
  const rows = await parseTable(input.filename, Buffer.from(input.data, 'base64'));
  if (rows.length < 2) throw badRequest(m('people.importEmpty'));
  if (rows.length > 2001) throw badRequest(m('people.importMax'));
  const [headers, ...data] = rows;
  const idx = Object.fromEntries(
    (Object.keys(COLUMNS) as Column[]).map((k) => [k, headers.findIndex((h) => (COLUMNS[k] as readonly string[]).includes(h.trim().toLowerCase()))]),
  ) as Record<Column, number>;
  if (idx.email < 0) throw badRequest(m('people.importNoEmail'), { headers });
  const cell = (r: string[], k: Column) => (idx[k] < 0 ? '' : (r[idx[k]] ?? '').trim());
  const roles = roleLookup();
  const areas = new Map((await listAreas(ctx)).map((a) => [a.name.toLowerCase(), a]));
  const existing = new Map(
    (
      await ctx.db.query<{ id: string; email: string; roles: string[]; technical: boolean }>('SELECT id, lower(email) AS email, roles, technical FROM users')
    ).rows.map((u) => [u.email, u]),
  );
  const seen = new Set<string>();
  const isAdmin = hasRole(ctx.user, 'admin');
  const out: ImportRow[] = [];
  for (const [i, r] of data.entries()) {
    const email = cell(r, 'email');
    const errors: string[] = [];
    if (!z.email().safeParse(email).success) errors.push(tr(ctx.locale, m('people.err.email')));
    const key = email.toLowerCase();
    if (seen.has(key)) errors.push(tr(ctx.locale, m('people.err.duplicate')));
    seen.add(key);
    const user = existing.get(key);
    const name = cell(r, 'name') || email.split('@')[0];
    if (!user && name.length < 2) errors.push(tr(ctx.locale, m('people.err.name')));
    const parsed: Role[] = ['submitter'];
    for (const raw of cell(r, 'roles')
      .split(/[,;|/]+/)
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean)) {
      const role = roles.get(raw);
      if (!role || role === 'external') errors.push(tr(ctx.locale, m('people.err.role', { role: raw })));
      else if (!parsed.includes(role)) parsed.push(role);
    }
    if (!isAdmin && parsed.includes('admin')) errors.push(tr(ctx.locale, m('people.adminRoleByAdmin')));
    if (!isAdmin && user?.roles.includes('admin')) errors.push(tr(ctx.locale, m('people.adminOnlyByAdmin')));
    if (user?.technical) errors.push(tr(ctx.locale, m('people.err.technical')));
    const areaName = cell(r, 'area') || null;
    if (areaName && !areas.has(areaName.toLowerCase())) errors.push(tr(ctx.locale, m('people.err.area', { area: areaName })));
    out.push({
      row: i + 2,
      email,
      name: name.slice(0, 120),
      roles: parsed,
      orgUnit: cell(r, 'department').slice(0, 120) || null,
      area: areaName,
      action: errors.length ? 'skip' : user ? 'update' : 'create',
      errors,
    });
  }
  const summary = {
    total: out.length,
    create: out.filter((x) => x.action === 'create').length,
    update: out.filter((x) => x.action === 'update').length,
    skip: out.filter((x) => x.action === 'skip').length,
  };
  if (input.dryRun) return { dryRun: true, headers, rows: out.slice(0, 500), summary };

  const invites: string[] = [];
  for (const row of out.filter((x) => x.action !== 'skip')) {
    const area = row.area ? areas.get(row.area.toLowerCase())! : null;
    // Scopable roles with an area apply only there (R3-29); the rest is tenant-wide.
    const scoped = area ? row.roles.filter((r): r is ScopableRole => (SCOPABLE_ROLES as readonly string[]).includes(r)) : [];
    const wide = row.roles.filter((r) => !scoped.includes(r as ScopableRole));
    let id: string;
    if (row.action === 'create') {
      const created = (
        await ctx.db.query<{ id: string; tenant_id: string; email: string }>(
          'INSERT INTO users (tenant_id, email, display_name, org_unit, roles) VALUES ($1, $2, $3, $4, $5) RETURNING id, tenant_id, email',
          [ctx.tenantId, row.email, row.name, row.orgUnit, wide],
        )
      ).rows[0];
      id = created.id;
      const token = await issuePasswordToken(ctx.db, created, m('admin.invite.subject'), m('admin.invite.intro', { name: ctx.user!.displayName }));
      if (config.mailTransport === 'log') invites.push(`${row.email}: ${config.publicUrl}/passwort?token=${token}`);
      await audit(ctx, 'user.invite', 'user', id, null, { email: row.email, displayName: row.name, orgUnit: row.orgUnit, roles: wide, source: 'import' });
    } else {
      const before = (
        await ctx.db.query<{ id: string; display_name: string; org_unit: string | null; roles: string[] }>(
          'SELECT id, display_name, org_unit, roles FROM users WHERE lower(email) = lower($1) FOR UPDATE',
          [row.email],
        )
      ).rows[0];
      id = before.id;
      const after = {
        display_name: row.name || before.display_name,
        org_unit: row.orgUnit ?? before.org_unit,
        roles: Array.from(new Set([...before.roles, ...wide])),
      };
      await ctx.db.query('UPDATE users SET display_name = $2, org_unit = $3, roles = $4 WHERE id = $1', [id, after.display_name, after.org_unit, after.roles]);
      await audit(
        ctx,
        'user.update',
        'user',
        id,
        { display_name: before.display_name, org_unit: before.org_unit, roles: before.roles },
        { ...after, source: 'import' },
      );
    }
    for (const role of scoped) {
      await ctx.db.query(
        `INSERT INTO role_assignments (tenant_id, user_id, role, area_id, source) VALUES ($1, $2, $3, $4, 'manual') ON CONFLICT (user_id, role, area_id) DO NOTHING`,
        [ctx.tenantId, id, role, area!.id],
      );
    }
    if (scoped.length)
      await audit(
        ctx,
        'user.scoped_roles',
        'user',
        id,
        null,
        scoped.map((role) => ({ role, areaId: area!.id, source: 'import' })),
      );
  }
  await audit(ctx, 'users.import', 'tenant', ctx.tenantId, null, { filename: input.filename, ...summary });
  return { dryRun: false, headers, rows: out.filter((x) => x.action === 'skip').slice(0, 500), summary, inviteLinks: invites.length ? invites : undefined };
}

// ---------------------------------------------------------------- bulk actions

export const bulkInput = z.object({
  userIds: z.array(z.uuid()).min(1).max(500),
  action: z.enum(['deactivate', 'activate', 'addRole', 'removeRole']),
  role: z.enum(ROLES).optional(),
});

export async function bulkPeople(ctx: Ctx, input: z.infer<typeof bulkInput>) {
  if ((input.action === 'addRole' || input.action === 'removeRole') && (!input.role || input.role === 'submitter' || input.role === 'external')) {
    throw badRequest(m('people.bulkRole'));
  }
  const isAdmin = hasRole(ctx.user, 'admin');
  if (!isAdmin && input.role === 'admin') throw forbidden(m('people.adminRoleByAdmin'));
  const people = (
    await ctx.db.query<{ id: string; roles: string[]; active: boolean }>(
      'SELECT id, roles, active FROM users WHERE id = ANY($1::uuid[]) AND NOT technical FOR UPDATE',
      [input.userIds],
    )
  ).rows;
  const skipped: { id: string; reason: string }[] = input.userIds.filter((id) => !people.some((p) => p.id === id)).map((id) => ({ id, reason: 'notFound' }));
  const deactivated: string[] = [];
  let updated = 0;
  for (const p of people) {
    if (!isAdmin && p.roles.includes('admin')) {
      skipped.push({ id: p.id, reason: 'adminOnly' });
      continue;
    }
    if (
      p.id === ctx.user!.id &&
      (input.action === 'deactivate' || (input.action === 'removeRole' && (input.role === 'admin' || input.role === 'user_admin')))
    ) {
      skipped.push({ id: p.id, reason: 'self' });
      continue;
    }
    const after = { roles: p.roles, active: p.active };
    if (input.action === 'deactivate') after.active = false;
    if (input.action === 'activate') after.active = true;
    if (input.action === 'addRole') after.roles = Array.from(new Set([...p.roles, input.role!]));
    if (input.action === 'removeRole') after.roles = p.roles.filter((r) => r !== input.role);
    if (after.active === p.active && after.roles.length === p.roles.length && after.roles.every((r) => p.roles.includes(r))) {
      skipped.push({ id: p.id, reason: 'unchanged' });
      continue;
    }
    await ctx.db.query(
      `UPDATE users SET roles = $2, active = $3, deactivated_at = CASE WHEN $3 THEN NULL ELSE coalesce(deactivated_at, now()) END WHERE id = $1`,
      [p.id, after.roles, after.active],
    );
    if (!after.active) deactivated.push(p.id);
    await audit(ctx, 'user.update', 'user', p.id, { roles: p.roles, active: p.active }, { ...after, bulk: input.action });
    updated++;
  }
  if (deactivated.length) await withSystem((c) => c.query('DELETE FROM sessions WHERE user_id = ANY($1::uuid[])', [deactivated]));
  await audit(ctx, 'users.bulk', 'tenant', ctx.tenantId, null, {
    action: input.action,
    role: input.role ?? null,
    requested: input.userIds.length,
    updated,
    skipped: skipped.length,
  });
  return { updated, skipped };
}
