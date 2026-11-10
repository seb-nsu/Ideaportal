import type { Db } from '../db/pool.js';
import { holidaySet, resolveSettings, type Settings } from './settings.js';
import { todayIn } from './workdays.js';
import type { Locale } from '../i18n/index.js';
import { planState, type OverrideRow, type PlanRow, type PlanState } from './plans.js';

// works_council: read-only role for the works council (R2-42, R3-12); sees AI proofs and the co-determination overview, no idea texts.
// external: customers and partners (R3-19); see only their own and released ideas, every endpoint
// is closed to them unless it is opened explicitly (tenantHandler opts.external).
// controlling: confirms or corrects the actual benefit of implemented ideas (R3-33).
// user_admin: delegated people administration (enterprise): invites, deactivates and gives roles
// except admin; no settings. Admins themselves can only be changed by admins.
export const ROLES = ['submitter', 'mentor', 'triage', 'committee', 'lead', 'implementer', 'admin', 'works_council', 'controlling', 'external', 'user_admin'] as const;
export type Role = (typeof ROLES)[number];

export interface SessionUser {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  orgUnit: string | null;
  roles: Role[];
  mfaEnabled: boolean;
  /** Language of the interface, errors and mails (R2-50); German when unknown. */
  locale?: Locale;
  /** Technical user of an API token (R3-17). */
  technical?: boolean;
  tokenId?: string;
  /**
   * Roles held only for some areas (R3-29): role → area IDs. A role listed here is also in
   * roles (so endpoint checks pass), but applies to ideas of these areas only. A role held
   * tenant-wide is never listed here.
   */
  scopes?: Partial<Record<Role, string[]>>;
}

/** Everything a domain operation needs: the tenant-scoped connection, the actor and the tenant settings. */
export interface Ctx {
  db: Db;
  tenantId: string;
  user: SessionUser | null; // null for background jobs
  settings: Settings;
  holidays: Set<string>;
  today: string;
  /** Language of the acting person; background jobs use German. */
  locale: Locale;
  /** Package with feature switches and AI quota (R3-05); absent = internal workspace. */
  plan?: PlanState;
}

export async function buildCtx(db: Db, tenantId: string, user: SessionUser | null, today?: string): Promise<Ctx> {
  const row = (await db.query<{ settings: unknown; plan: PlanRow | null; overrides: OverrideRow[] | null }>(
    `SELECT t.settings, (SELECT to_jsonb(p) FROM tenant_plans p WHERE p.tenant_id = t.id) AS plan,
            (SELECT jsonb_agg(jsonb_build_object('key', o.key, 'kind', o.kind, 'bool_value', o.bool_value, 'int_value', o.int_value))
               FROM tenant_overrides o WHERE o.tenant_id = t.id AND (o.expires_at IS NULL OR o.expires_at > now())) AS overrides
       FROM tenants t WHERE t.id = $1`,
    [tenantId],
  )).rows[0];
  const settings = resolveSettings(row?.settings);
  const day = today ?? todayIn(settings.timezone);
  return {
    db,
    tenantId,
    user,
    settings,
    holidays: holidaySet(settings),
    today: day,
    locale: user?.locale ?? 'de',
    plan: planState(row?.plan, day, row?.overrides),
  };
}

/** Roles that can be given for one area only (R3-29). */
export const SCOPABLE_ROLES = ['triage', 'committee', 'lead'] as const satisfies readonly Role[];
export type ScopableRole = (typeof SCOPABLE_ROLES)[number];

/** True when the person holds one of the roles for the whole tenant (not only for an area). */
export function hasRoleEverywhere(user: SessionUser | null, ...roles: Role[]): boolean {
  return !!user && roles.some((r) => user.roles.includes(r) && !user.scopes?.[r]);
}

/**
 * Areas the person works in with one of the roles: null = no restriction (one of the roles is
 * tenant-wide), otherwise the union of the areas of the scoped roles (may be empty).
 */
export function scopeAreas(user: SessionUser | null, roles: readonly Role[]): string[] | null {
  if (!user) return [];
  if (hasRoleEverywhere(user, ...roles)) return null;
  return [...new Set(roles.flatMap((r) => (user.roles.includes(r) ? user.scopes?.[r] ?? [] : [])))];
}

/** The person's rights for one idea: scoped roles whose areas do not cover the idea are dropped. */
export function restrictToAreas(user: SessionUser, ideaAreas: readonly string[]): SessionUser {
  if (!user.scopes || !Object.keys(user.scopes).length) return user;
  const scopes: Partial<Record<Role, string[]>> = {};
  const roles = user.roles.filter((r) => {
    const areas = user.scopes![r];
    if (!areas) return true;
    const hit = areas.filter((a) => ideaAreas.includes(a));
    if (hit.length) scopes[r] = hit;
    return hit.length > 0;
  });
  return { ...user, roles, scopes };
}

export function hasRole(user: SessionUser | null, ...roles: Role[]): boolean {
  return !!user && roles.some((r) => user.roles.includes(r));
}

/**
 * Role-based rights checked inside the domain logic (R3-12). The checks below use this table,
 * and the co-determination overview lists it per role, so the overview shows what the code does.
 * Endpoint-level role lists (tenantHandler opts.roles) are collected separately by the route
 * registry in http.ts. Rights from a relationship to an idea (author, mentor, implementer,
 * sponsor, deputy) come on top and are not role-based.
 */
export const PERMISSIONS = {
  triage: ['triage', 'admin'],
  decide: ['committee', 'admin'],
  meetings: ['committee', 'triage', 'admin'],
  aiAnalyses: ['triage', 'committee', 'lead', 'admin'],
  aiRecommendations: ['triage', 'committee', 'admin'],
  gate2Delegated: ['lead'],
  aiProofs: ['works_council', 'triage', 'admin'],
  codetermination: ['works_council', 'admin'],
  configure: ['admin'],
  // Moderation queue for external posts and reports (R3-21).
  moderate: ['triage', 'admin'],
  // Status of feature requests (R3-20).
  featureRequests: ['triage', 'admin', 'lead'],
  confirmBenefit: ['controlling'],
  // People and their roles (invite, deactivate, import, bulk changes); admin rights only by admins.
  managePeople: ['admin', 'user_admin'],
} as const satisfies Record<string, readonly Role[]>;
export type Permission = keyof typeof PERMISSIONS;

export function can(user: SessionUser | null, permission: Permission): boolean {
  return hasRole(user, ...PERMISSIONS[permission]);
}

export const isTriage = (u: SessionUser | null) => can(u, 'triage');
/** Triage for every idea of the tenant (not only for some areas); used by list queries (VISIBLE_SQL $2). */
export const isTriageEverywhere = (u: SessionUser | null) => hasRoleEverywhere(u, ...PERMISSIONS.triage);
export const isDecider = (u: SessionUser | null) => can(u, 'decide');

/** External person (R3-19): restricted to the endpoints opened for externals. */
export const isExternal = (u: SessionUser | null) => !!u && u.roles.includes('external');
