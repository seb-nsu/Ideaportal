import { z } from 'zod';
import type { Db } from '../db/pool.js';
import { ROLES, SCOPABLE_ROLES, type Role } from '../lib/context.js';
import { syncIdpScopedRoles, type ScopedRole } from './areas.js';
import { EMPTY_SAML, samlSettingsSchema, type SamlSettings } from '../lib/saml.js';

// Identity settings per tenant (R3-26, R3-27): company login with OpenID Connect, group → role
// mapping, just-in-time accounts and SCIM provisioning share these rules.

export const groupRoleSchema = z.object({
  group: z.string().trim().min(1).max(200),
  roles: z.array(z.enum(ROLES)).min(1),
  // R3-29: with an area the group grants the roles for this area only (triage, committee, lead).
  areaId: z.uuid().nullable().optional(),
}).refine((g) => !g.areaId || g.roles.every((r) => (SCOPABLE_ROLES as readonly string[]).includes(r)), { path: ['roles'] });
export type GroupRole = z.infer<typeof groupRoleSchema>;

export const claimsSchema = z.object({
  email: z.string().trim().max(100).default(''),
  name: z.string().trim().max(100).default(''),
  department: z.string().trim().max(100).default(''),
  groups: z.string().trim().max(100).default(''),
});
export type ClaimNames = z.infer<typeof claimsSchema>;

export const DEFAULT_CLAIMS: Required<ClaimNames> = { email: 'email', name: 'name', department: 'department', groups: 'groups' };

export type SsoProtocol = 'oidc' | 'saml';

export interface IdentityConfig {
  /** Company login switched on; the protocol decides between OpenID Connect and SAML 2.0. */
  oidcEnabled: boolean;
  protocol: SsoProtocol;
  issuer: string;
  clientId: string;
  allowedDomains: string[];
  groupRoles: GroupRole[];
  jitProvisioning: boolean;
  localLoginDisabled: boolean;
  claims: ClaimNames;
  saml: SamlSettings;
}

export const EMPTY_IDENTITY: IdentityConfig = {
  oidcEnabled: false,
  protocol: 'oidc',
  issuer: '',
  clientId: '',
  allowedDomains: [],
  groupRoles: [],
  jitProvisioning: true,
  localLoginDisabled: false,
  claims: { email: '', name: '', department: '', groups: '' },
  saml: EMPTY_SAML,
};

interface IdentityRow {
  oidc_enabled: boolean;
  issuer: string | null;
  client_id: string | null;
  allowed_domains: string[];
  group_roles: unknown;
  jit_provisioning: boolean;
  local_login_disabled: boolean;
  claims: unknown;
  protocol?: string;
  saml?: unknown;
}

export function rowToIdentity(row: IdentityRow | undefined): IdentityConfig {
  if (!row) return { ...EMPTY_IDENTITY };
  const groups = z.array(groupRoleSchema).safeParse(row.group_roles);
  const claims = claimsSchema.safeParse(row.claims ?? {});
  const saml = samlSettingsSchema.safeParse(row.saml ?? {});
  return {
    oidcEnabled: row.oidc_enabled,
    protocol: row.protocol === 'saml' ? 'saml' : 'oidc',
    issuer: row.issuer ?? '',
    clientId: row.client_id ?? '',
    allowedDomains: row.allowed_domains,
    groupRoles: groups.success ? groups.data : [],
    jitProvisioning: row.jit_provisioning,
    localLoginDisabled: row.local_login_disabled,
    claims: claims.success ? claims.data : EMPTY_IDENTITY.claims,
    saml: saml.success ? saml.data : EMPTY_SAML,
  };
}

/** Identity settings of the tenant of the connection (row-level security) or of tenantId (owner connection). */
export async function loadIdentity(db: Db, tenantId: string): Promise<IdentityConfig> {
  const r = await db.query<IdentityRow>(
    `SELECT oidc_enabled, issuer, client_id, allowed_domains, group_roles, jit_provisioning, local_login_disabled, claims, protocol, saml
       FROM tenant_identity WHERE tenant_id = $1`,
    [tenantId],
  );
  return rowToIdentity(r.rows[0]);
}

export const emailDomain = (email: string) => email.trim().toLowerCase().split('@').pop() ?? '';

export function domainAllowed(cfg: IdentityConfig, email: string): boolean {
  return cfg.allowedDomains.length === 0 || cfg.allowedDomains.includes(emailDomain(email));
}

/**
 * Roles from the group mapping. Without a mapping the roles stay as they are (null).
 * With a mapping the identity provider is the source of truth: submitter plus every mapped role.
 */
export function rolesFromGroups(mapping: GroupRole[], groups: string[]): Role[] | null {
  if (!mapping.length) return null;
  const have = new Set(groups.map((g) => g.toLowerCase()));
  const roles = new Set<Role>(['submitter']);
  for (const m of mapping) if (!m.areaId && have.has(m.group.toLowerCase())) m.roles.forEach((r) => roles.add(r));
  return ROLES.filter((r) => roles.has(r));
}

/** Roles for one area from the group mapping (R3-29): group → role + area. */
export function scopedRolesFromGroups(mapping: GroupRole[], groups: string[]): ScopedRole[] {
  const have = new Set(groups.map((g) => g.toLowerCase()));
  const out: ScopedRole[] = [];
  for (const m of mapping) {
    if (!m.areaId || !have.has(m.group.toLowerCase())) continue;
    for (const r of m.roles) if ((SCOPABLE_ROLES as readonly string[]).includes(r)) out.push({ role: r as ScopedRole['role'], areaId: m.areaId });
  }
  return out;
}

/**
 * Recomputes the roles of an account managed by the identity provider from the groups of the
 * ID token (idp_groups) and its SCIM groups (name, external ID or ID). Local accounts keep their roles.
 */
export async function syncRoles(db: Db, cfg: IdentityConfig, userId: string): Promise<Role[] | null> {
  const row = (await db.query<{ idp_managed: boolean; idp_groups: string[]; scim: string[] | null; roles: Role[]; tenant_id: string }>(
    `SELECT u.idp_managed, u.idp_groups, u.roles, u.tenant_id,
            (SELECT array_agg(x) FROM scim_group_members m JOIN scim_groups g ON g.id = m.group_id,
                    unnest(ARRAY[g.display_name, g.external_id, g.id::text]) AS x
              WHERE m.user_id = u.id AND x IS NOT NULL) AS scim
       FROM users u WHERE u.id = $1`,
    [userId],
  )).rows[0];
  if (!row || !row.idp_managed) return null;
  const groups = [...row.idp_groups, ...(row.scim ?? [])];
  const roles = rolesFromGroups(cfg.groupRoles, groups);
  if (!roles) return null;
  await syncIdpScopedRoles(db, row.tenant_id, userId, scopedRolesFromGroups(cfg.groupRoles, groups));
  const same = roles.length === row.roles.length && roles.every((r) => row.roles.includes(r));
  if (!same) await db.query('UPDATE users SET roles = $2 WHERE id = $1', [userId, roles]);
  return roles;
}

// ---------------------------------------------------------------- claims of the ID token

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export interface Person {
  email: string | null;
  name: string | null;
  department: string | null;
  /** null when the provider did not send groups (or only an overage reference). */
  groups: string[] | null;
  emailVerified: boolean;
}

/** Reads e-mail, name, department and groups; claim names are configurable per tenant. */
export function personFromClaims(claims: Record<string, unknown>, names: ClaimNames): Person {
  const n = { ...DEFAULT_CLAIMS, ...Object.fromEntries(Object.entries(names).filter(([, v]) => v)) };
  // Entra ID without the optional "email" claim: preferred_username or upn hold the sign-in name.
  const email = str(claims[n.email]) ?? str(claims.preferred_username) ?? str(claims.upn);
  const given = str(claims.given_name);
  const family = str(claims.family_name);
  const name = str(claims[n.name]) ?? ([given, family].filter(Boolean).join(' ') || null);
  const rawGroups = claims[n.groups];
  const groups = Array.isArray(rawGroups) ? rawGroups.filter((g): g is string => typeof g === 'string') : typeof rawGroups === 'string' ? [rawGroups] : null;
  return {
    email: email && email.includes('@') ? email.toLowerCase() : null,
    name,
    department: str(claims[n.department]),
    groups,
    emailVerified: claims.email_verified !== false && claims.email_verified !== 'false',
  };
}
