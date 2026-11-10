import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { withSystem, withTenant } from './db/pool.js';
import { buildCtx, isExternal, type Ctx, type Role, type SessionUser } from './lib/context.js';
import { sha256 } from './lib/crypto.js';
import { HttpError, forbidden } from './lib/errors.js';
import { resolveSettings } from './lib/settings.js';
import { bearerToken, userFromToken } from './services/apitokens.js';
import { withScopes } from './services/areas.js';
import { enforcePlan } from './services/billing.js';
import { localeFromHeader, m, type Locale } from './i18n/index.js';

const locales = new WeakMap<FastifyRequest, Locale>();

/** Language for the answer: the person's setting, else the browser's (R2-50). */
export function requestLocale(req: FastifyRequest): Locale {
  return locales.get(req) ?? localeFromHeader(req.headers['accept-language']);
}

export const SESSION_COOKIE = 'ip_session';

interface SessionRow {
  user_id: string;
  tenant_id: string;
  mfa_pending: boolean;
  auth_method: string;
  email: string;
  display_name: string;
  org_unit: string | null;
  roles: Role[];
  mfa_enabled: boolean;
  locale: Locale;
  settings: unknown;
  idle_seconds: number;
}

/** last_seen_at is written at most once per this many seconds per session (idle timeout). */
export const LAST_SEEN_THROTTLE_SECONDS = 60;

export async function sessionFromRequest(req: FastifyRequest): Promise<{ user: SessionUser; mfaPending: boolean; mfaSetupRequired: boolean } | null> {
  // API token (R3-17): the bearer wins; cookies are never read together with it (see guardBearer).
  const bearer = bearerToken(req);
  if (bearer !== undefined) return { user: await userFromToken(req, bearer), mfaPending: false, mfaSetupRequired: false };
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const found = await withSystem(async (c) => {
    const r = (await c.query<SessionRow>(
      `SELECT s.user_id, s.tenant_id, s.mfa_pending, s.auth_method, u.email, u.display_name, u.org_unit, u.roles, u.mfa_enabled, u.locale, t.settings,
              extract(epoch FROM now() - s.last_seen_at)::int AS idle_seconds
         FROM sessions s JOIN users u ON u.id = s.user_id JOIN tenants t ON t.id = s.tenant_id
        WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`,
      [sha256(token)],
    )).rows[0];
    if (!r) return null;
    // Idle timeout per tenant (security.sessionIdleMinutes, 0 = off): an idle session ends.
    const idleMinutes = resolveSettings(r.settings).security.sessionIdleMinutes;
    if (idleMinutes > 0 && r.idle_seconds > idleMinutes * 60) {
      await c.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
      return null;
    }
    if (r.idle_seconds >= LAST_SEEN_THROTTLE_SECONDS) {
      await c.query('UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1', [sha256(token)]);
    }
    // Roles with a scope (R3-29) are added to roles and listed in scopes.
    const base: SessionUser = {
      id: r.user_id,
      tenantId: r.tenant_id,
      email: r.email,
      displayName: r.display_name,
      orgUnit: r.org_unit,
      roles: r.roles,
      mfaEnabled: r.mfa_enabled,
      locale: r.locale,
    };
    return { row: r, user: await withScopes(c, base) };
  });
  if (!found) return null;
  const { row, user } = found;
  locales.set(req, row.locale);
  // Company login (R3-26): the identity provider is responsible for the second factor.
  const mfaSetupRequired = !['oidc', 'saml'].includes(row.auth_method) && user.roles.includes('admin') && !user.mfaEnabled && resolveSettings(row.settings).requireMfaForAdmins;
  return { user, mfaPending: row.mfa_pending, mfaSetupRequired };
}

/**
 * allowExternal: the endpoint is open to external people (R3-19). Every other endpoint is closed
 * to them by default, so new endpoints never leak comments, people, dashboards or AI analyses.
 * Endpoints of the own account (allowMfaSetup) are open to externals as well.
 */
export async function requireUser(req: FastifyRequest, opts: { allowMfaSetup?: boolean; allowExternal?: boolean } = {}): Promise<SessionUser> {
  const s = await sessionFromRequest(req);
  if (!s) throw new HttpError(401, m('common.unauthenticated'), 'UNAUTHENTICATED');
  if (s.mfaPending) throw new HttpError(401, m('common.mfaRequired'), 'MFA_REQUIRED');
  if (s.mfaSetupRequired && !opts.allowMfaSetup) {
    throw new HttpError(403, m('common.mfaSetupRequired'), 'MFA_SETUP_REQUIRED');
  }
  if (isExternal(s.user) && !opts.allowExternal && !opts.allowMfaSetup) {
    throw new HttpError(403, m('external.forbidden'), 'EXTERNAL_FORBIDDEN');
  }
  // Package (R3-05, R3-02, R3-39): feature switches, read-only mode, challenge limit.
  await enforcePlan(req, s.user);
  return s.user;
}

// Route registry (R3-12): which endpoints need a session and which roles they require. The
// co-determination overview reads it, so the rights shown are the ones the server enforces.
const ROLE_MARK = Symbol('roles');
type Marked = { [ROLE_MARK]?: readonly Role[] | null };

/** Marks a handler as session-bound with the given role list (null = every signed-in person). */
export function markRoles<F extends (...args: never[]) => unknown>(fn: F, roles: readonly Role[] | undefined): F {
  (fn as F & Marked)[ROLE_MARK] = roles ?? null;
  return fn;
}

export interface RouteRight {
  method: string;
  url: string;
  /** Roles required by the endpoint; null = every signed-in person (further checks in the logic). */
  roles: Role[] | null;
}

const routeRegistry = new Map<string, RouteRight>();

/** Called for every route (onRoute hook in app.ts); only session-bound handlers are recorded. */
export function registerRoute(method: string | string[], url: string, handler: unknown): void {
  if (typeof handler !== 'function' || !(ROLE_MARK in handler)) return;
  const roles = (handler as Marked)[ROLE_MARK] ?? null;
  for (const m of Array.isArray(method) ? method : [method]) {
    if (m === 'HEAD') continue;
    routeRegistry.set(`${m} ${url}`, { method: m, url, roles: roles ? [...roles] : null });
  }
}

export function routeRights(): RouteRight[] {
  return [...routeRegistry.values()].sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method));
}

/** Runs a handler with a tenant-scoped transaction (row-level security active). */
export function tenantHandler<T>(
  fn: (ctx: Ctx, req: FastifyRequest, reply: FastifyReply) => Promise<T>,
  opts: { roles?: readonly Role[]; external?: boolean } = {},
) {
  return markRoles(async (req: FastifyRequest, reply: FastifyReply): Promise<T> => {
    const user = await requireUser(req, { allowExternal: opts.external });
    if (opts.roles && !opts.roles.some((r) => user.roles.includes(r))) throw forbidden();
    return withTenant(user.tenantId, async (db) => fn(await buildCtx(db, user.tenantId, user), req, reply));
  }, opts.roles);
}

export function sessionCookie() {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: config.cookieSecure,
    maxAge: config.sessionHours * 3600,
  };
}
