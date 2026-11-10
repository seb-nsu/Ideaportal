import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { withSystem, withTenant, type Db } from '../db/pool.js';
import { base32Decode, sha256, verifyPassword, verifyTotp } from '../lib/crypto.js';
import { HttpError, conflict, forbidden, notFound } from '../lib/errors.js';
import { localizedDefaults } from '../lib/default-texts.js';
import { decryptSecret, encryptSecret, ensureTenantKey, hasSecretKey, isSealed, masterFingerprint } from '../lib/secretbox.js';
import { resolveSettings } from '../lib/settings.js';
import { m, type Locale } from '../i18n/index.js';
import { issuePasswordToken } from '../routes/auth.js';
import { slugify } from '../routes/selfservice.js';
import { evaluate, healthMetrics } from './ops.js';
import { componentStates } from './status.js';
import { isDemoSlug } from '../db/demo-content.js';

// Operator and support console (R3-01, R3-07). Operators sign in with their own account
// (operator_accounts: e-mail, password, mandatory TOTP, role). OPERATOR_TOKEN plus
// OPERATOR_TOTP_SECRET remain only as the bootstrap path: they work while no active owner
// account exists (or with OPERATOR_BREAK_GLASS=true) and act as the built-in owner "bootstrap".
// The console shows operational figures per tenant; the data of a tenant only while its admins
// have granted a time-limited support access, and every such access is written into that
// tenant's audit log.

export const OPERATOR_COOKIE = 'ip_operator';

export const OPERATOR_ROLES = ['owner', 'support', 'billing', 'technical'] as const;
export type OperatorRole = (typeof OPERATOR_ROLES)[number];

/** What each operator role may do; owner may do everything. */
export const OPERATOR_PERMISSIONS = {
  // Platform health and tenant figures without content, the operator log.
  overview: ['owner', 'support', 'billing', 'technical'],
  // Support access with the tenant's grant, incidents and maintenance notes.
  support: ['owner', 'support'],
  // Packages, top-ups, invoice drafts.
  billing: ['owner', 'billing'],
  // New tenants, status (suspend, resume, offboarding), feature switches and limits.
  tenants: ['owner', 'technical'],
  // Operator accounts.
  operators: ['owner'],
} as const satisfies Record<string, readonly OperatorRole[]>;
export type OperatorPermission = keyof typeof OPERATOR_PERMISSIONS;

/** The signed-in operator; id null for the bootstrap login with OPERATOR_TOKEN. */
export interface Operator {
  id: string | null;
  name: string;
  email: string | null;
  role: OperatorRole;
  bootstrap: boolean;
  mustChangePassword: boolean;
}

export const operatorCan = (op: Pick<Operator, 'role'>, permission: OperatorPermission) =>
  (OPERATOR_PERMISSIONS[permission] as readonly string[]).includes(op.role);

/** OPERATOR_TOKEN and OPERATOR_TOTP_SECRET are set and long enough (bootstrap path). */
export function operatorTokenConfigured(): boolean {
  const token = config.operatorToken ?? '';
  const totp = config.operatorTotpSecret ?? '';
  return token.length >= 32 && base32Decode(totp).length >= 10;
}

async function activeOwnerExists(c: Db): Promise<boolean> {
  return !!(await c.query(`SELECT 1 FROM operator_accounts WHERE active AND role = 'owner' LIMIT 1`)).rowCount;
}

/** The env token login works while no active owner account exists, or as break-glass access. */
export async function bootstrapLoginAvailable(c?: Db): Promise<boolean> {
  if (!operatorTokenConfigured()) return false;
  if (config.operatorBreakGlass) return true;
  return c ? !(await activeOwnerExists(c)) : withSystem(async (s) => !(await activeOwnerExists(s)));
}

/** The console is on with the env token or with at least one active operator account. */
export async function operatorConsoleEnabled(): Promise<boolean> {
  if (operatorTokenConfigured()) return true;
  return withSystem(async (c) => !!(await c.query('SELECT 1 FROM operator_accounts WHERE active LIMIT 1')).rowCount);
}

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(sha256(a), 'hex'), Buffer.from(sha256(b), 'hex'));
}

/** Writes an operator action; the individual operator is recorded with name and account id. */
export async function operatorLog(c: Db, operator: Operator | string, action: string, tenantId: string | null, detail: unknown = {}): Promise<void> {
  const name = typeof operator === 'string' ? operator : operator.name;
  const id = typeof operator === 'string' ? null : operator.id;
  await c.query('INSERT INTO operator_log (operator, operator_id, action, tenant_id, detail) VALUES ($1, $2, $3, $4, $5)', [name, id, action, tenantId, JSON.stringify(detail)]);
}

// TOTP secrets of operator accounts: encrypted with SECRET_KEY when it is set.
export const sealOperatorTotp = (secret: string) => (hasSecretKey() ? encryptSecret(secret) : secret);
export const openOperatorTotp = (stored: string) => (isSealed(stored) ? decryptSecret(stored) : stored);

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

async function newSession(c: Db, name: string, operatorId: string | null, role: OperatorRole): Promise<string> {
  const session = randomBytes(32).toString('base64url');
  await c.query(
    'INSERT INTO operator_sessions (token_hash, operator, operator_id, role, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5))',
    [sha256(session), name, operatorId, role, config.operatorSessionHours],
  );
  await c.query('DELETE FROM operator_sessions WHERE expires_at < now()');
  return session;
}

async function codeReused(c: Db, operatorId: string | null, codeHash: string): Promise<boolean> {
  return !!(await c.query(
    `SELECT 1 FROM operator_log WHERE action = 'login' AND operator_id IS NOT DISTINCT FROM $1 AND detail->>'code' = $2 AND created_at > now() - interval '3 minutes'`,
    [operatorId, codeHash],
  )).rowCount;
}

/**
 * Bootstrap login with OPERATOR_TOKEN and a TOTP code; a code is accepted only once (replay).
 * Returns the session token, '' when refused.
 */
export async function operatorLogin(token: string, code: string, ip: string): Promise<string> {
  const okToken = sameSecret(token, config.operatorToken ?? '');
  const okCode = verifyTotp(config.operatorTotpSecret ?? '', code);
  return withSystem(async (c) => {
    const codeHash = sha256(`operator-code:${code.replace(/\s/g, '')}`);
    const available = await bootstrapLoginAvailable(c);
    const reused = okCode && (await codeReused(c, null, codeHash));
    if (!available || !okToken || !okCode || reused) {
      await c.query('INSERT INTO security_events (kind, detail) VALUES ($1, $2)', ['operator_login_failed', JSON.stringify({ ipHash: sha256(ip), bootstrap: true })]);
      return '';
    }
    const session = await newSession(c, config.operatorName, null, 'owner');
    await operatorLog(c, config.operatorName, 'login', null, { code: codeHash, bootstrap: true });
    return session;
  });
}

interface AccountRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  totp_secret: string;
  role: OperatorRole;
  failed_logins: number;
  locked_until: Date | null;
}

/** Login of an operator account: e-mail, password and TOTP code (always). '' when refused. */
export async function accountLogin(email: string, password: string, code: string, ip: string): Promise<{ session: string } | { error: 'invalid' | 'locked' }> {
  const result = await withSystem(async (c) => {
    const acc = (await c.query<AccountRow>(
      'SELECT id, email, name, password_hash, totp_secret, role, failed_logins, locked_until FROM operator_accounts WHERE lower(email) = lower($1) AND active FOR UPDATE',
      [email.trim()],
    )).rows[0];
    const fail = async (reason: string) => {
      await c.query('INSERT INTO security_events (kind, detail) VALUES ($1, $2)', ['operator_login_failed', JSON.stringify({ ipHash: sha256(ip), reason })]);
    };
    if (!acc) {
      // Same work as for an existing account, so the answer time reveals nothing.
      await verifyPassword(password, 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==');
      await fail('unknown');
      return { error: 'invalid' as const };
    }
    if (acc.locked_until && acc.locked_until > new Date()) {
      await fail('locked');
      return { error: 'locked' as const };
    }
    const secret = openOperatorTotp(acc.totp_secret);
    const codeHash = sha256(`operator-code:${acc.id}:${code.replace(/\s/g, '')}`);
    const ok = (await verifyPassword(password, acc.password_hash)) && verifyTotp(secret, code) && !(await codeReused(c, acc.id, codeHash));
    if (!ok) {
      const failed = acc.failed_logins + 1;
      const lock = failed >= MAX_FAILED;
      await c.query(
        `UPDATE operator_accounts SET failed_logins = $2, locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END WHERE id = $1`,
        [acc.id, lock ? 0 : failed, lock, LOCK_MINUTES],
      );
      await fail(lock ? 'locked_now' : 'wrong');
      if (lock) await operatorLog(c, { id: acc.id, name: acc.name, email: acc.email, role: acc.role, bootstrap: false, mustChangePassword: false }, 'account.locked', null, {});
      return { error: lock ? ('locked' as const) : ('invalid' as const) };
    }
    // Re-encrypt with the current SECRET_KEY (after a key rotation the old one may go away).
    const resealed = hasSecretKey() ? sealOperatorTotp(secret) : acc.totp_secret;
    await c.query('UPDATE operator_accounts SET failed_logins = 0, locked_until = NULL, last_login_at = now(), totp_secret = $2 WHERE id = $1', [acc.id, resealed]);
    const session = await newSession(c, acc.name, acc.id, acc.role);
    await operatorLog(c, { id: acc.id, name: acc.name, email: acc.email, role: acc.role, bootstrap: false, mustChangePassword: false }, 'login', null, { code: codeHash });
    return { session };
  });
  return result;
}

export async function operatorLogout(token: string | undefined): Promise<void> {
  if (!token) return;
  await withSystem((c) => c.query('DELETE FROM operator_sessions WHERE token_hash = $1', [sha256(token)]));
}

/**
 * The operator of the request; 404 when the console is off, 401 without a valid session, 403
 * without the permission. "self" = only the own account (password change), allowed while a
 * password change is pending.
 */
export async function requireOperator(req: FastifyRequest, permission: OperatorPermission | 'self' = 'overview'): Promise<Operator> {
  if (!(await operatorConsoleEnabled())) throw new HttpError(404, m('saas.operatorDisabled'), 'NOT_FOUND');
  const token = req.cookies[OPERATOR_COOKIE];
  if (!token) throw new HttpError(401, m('saas.operatorUnauthenticated'), 'OPERATOR_UNAUTHENTICATED');
  const op = await withSystem(async (c) => {
    const row = (await c.query<{ operator: string; operator_id: string | null; role: OperatorRole; email: string | null; name: string | null; acc_role: OperatorRole | null; must_change: boolean | null }>(
      `SELECT s.operator, s.operator_id, s.role, a.email, a.name, a.role AS acc_role, a.must_change_password AS must_change
         FROM operator_sessions s LEFT JOIN operator_accounts a ON a.id = s.operator_id AND a.active
        WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [sha256(token)],
    )).rows[0];
    if (!row) return null;
    if (!row.operator_id) {
      // Bootstrap session: valid only while the env login is still available.
      if (!(await bootstrapLoginAvailable(c))) return null;
      return { id: null, name: row.operator, email: null, role: 'owner', bootstrap: true, mustChangePassword: false } satisfies Operator;
    }
    // Deactivated account: the join finds no account, the session ends.
    if (!row.acc_role) return null;
    return { id: row.operator_id, name: row.name!, email: row.email, role: row.acc_role, bootstrap: false, mustChangePassword: !!row.must_change } satisfies Operator;
  });
  if (!op) throw new HttpError(401, m('saas.operatorUnauthenticated'), 'OPERATOR_UNAUTHENTICATED');
  if (permission !== 'self') {
    if (op.mustChangePassword) throw new HttpError(403, m('opadmin.passwordChangeRequired'), 'OPERATOR_PASSWORD_CHANGE');
    if (!operatorCan(op, permission)) throw new HttpError(403, m('opadmin.forbidden'), 'OPERATOR_FORBIDDEN');
  }
  return op;
}

/** Runs a handler for a signed-in operator with the given permission. */
export function operatorHandler<T>(permission: OperatorPermission | 'self', fn: (operator: Operator, req: FastifyRequest, reply: FastifyReply) => Promise<T>) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<T> => {
    const operator = await requireOperator(req, permission);
    reply.header('cache-control', 'no-store');
    return fn(operator, req, reply);
  };
}

export function operatorCookie() {
  return {
    path: '/api/operator',
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: config.cookieSecure,
    maxAge: config.operatorSessionHours * 3600,
  };
}

// ---------------------------------------------------------------- overview (R3-07)

export interface TenantStatus {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
  createdVia: string;
  users: number;
  lastLoginAt: string | null;
  ideas: number;
  ideas30d: number;
  aiQueued: number;
  aiRunning: number;
  aiOldestQueuedAgeSeconds: number | null;
  aiFailed24h: number;
  aiErrors24h: number;
  aiCostMonthEur: number;
  outboxPending: number;
  outboxOldestAgeSeconds: number | null;
  webhookFailed24h: number;
  supportUntil: string | null;
  keyState: 'current' | 'previous' | 'unknown' | 'missing';
  /** Lifecycle (enterprise): active, suspended or being deleted. */
  status: 'active' | 'suspended' | 'deleting';
  suspendedAt: string | null;
  suspendedReason: string | null;
  deletionRequestedAt: string | null;
  deleteAfter: string | null;
}

/** Health of the platform and operational figures per tenant, without idea content. */
export async function operatorOverview() {
  const metrics = await healthMetrics();
  const alerts = evaluate(metrics);
  const current = config.secretKey ? masterFingerprint(config.secretKey) : null;
  const previous = config.secretKeyPrevious ? masterFingerprint(config.secretKeyPrevious) : null;
  const tenants = await withSystem(async (c) =>
    (await c.query<Omit<TenantStatus, 'keyState'> & { masterFp: string | null }>(
      `SELECT t.id, t.slug, t.name, t.created_at AS "createdAt", t.created_via AS "createdVia",
              t.status, t.suspended_at AS "suspendedAt", t.suspended_reason AS "suspendedReason",
              t.deletion_requested_at AS "deletionRequestedAt", t.delete_after AS "deleteAfter",
              (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id AND u.active AND NOT u.technical) AS users,
              (SELECT max(s.created_at) FROM sessions s WHERE s.tenant_id = t.id) AS "lastLoginAt",
              (SELECT count(*)::int FROM ideas i WHERE i.tenant_id = t.id) AS ideas,
              (SELECT count(*)::int FROM ideas i WHERE i.tenant_id = t.id AND i.created_at > now() - interval '30 days') AS "ideas30d",
              (SELECT count(*)::int FROM ai_jobs j WHERE j.tenant_id = t.id AND j.status = 'queued') AS "aiQueued",
              (SELECT count(*)::int FROM ai_jobs j WHERE j.tenant_id = t.id AND j.status = 'running') AS "aiRunning",
              (SELECT extract(epoch FROM now() - min(j.created_at))::int FROM ai_jobs j WHERE j.tenant_id = t.id AND j.status = 'queued' AND j.run_after <= now()) AS "aiOldestQueuedAgeSeconds",
              (SELECT count(*)::int FROM ai_jobs j WHERE j.tenant_id = t.id AND j.status = 'failed' AND j.finished_at > now() - interval '24 hours') AS "aiFailed24h",
              (SELECT count(*)::int FROM ai_actions a WHERE a.tenant_id = t.id AND a.status = 'error' AND a.created_at > now() - interval '24 hours') AS "aiErrors24h",
              (SELECT coalesce(sum(a.cost_eur), 0) FROM ai_actions a WHERE a.tenant_id = t.id AND a.created_at >= date_trunc('month', now())) AS "aiCostMonthEur",
              (SELECT count(*)::int FROM outbox o WHERE o.tenant_id = t.id AND o.sent_at IS NULL AND o.user_id IS NULL) AS "outboxPending",
              (SELECT extract(epoch FROM now() - min(o.created_at))::int FROM outbox o WHERE o.tenant_id = t.id AND o.sent_at IS NULL AND o.user_id IS NULL) AS "outboxOldestAgeSeconds",
              (SELECT count(*)::int FROM webhook_deliveries d WHERE d.tenant_id = t.id AND d.status = 'failed' AND d.created_at > now() - interval '24 hours') AS "webhookFailed24h",
              (SELECT max(g.expires_at) FROM support_grants g WHERE g.tenant_id = t.id AND g.revoked_at IS NULL AND g.expires_at > now()) AS "supportUntil",
              k.master_fp AS "masterFp"
         FROM tenants t LEFT JOIN tenant_keys k ON k.tenant_id = t.id
        ORDER BY t.name`,
    )).rows,
  );
  return {
    platform: {
      status: alerts.length ? 'degraded' : 'ok',
      alerts: alerts.map((a) => ({ key: a.key, message: a.message })),
      components: componentStates(metrics, alerts.map((a) => a.key)),
      metrics,
      secretKey: hasSecretKey(),
      rotationPending: tenants.some((t) => t.masterFp && t.masterFp !== current),
    },
    tenants: tenants.map(({ masterFp, ...t }) => ({
      ...t,
      keyState: !masterFp ? 'missing' : masterFp === current ? 'current' : masterFp === previous ? 'previous' : 'unknown',
    })) as TenantStatus[],
  };
}

// ---------------------------------------------------------------- new tenant (R3-01)

export interface NewTenant {
  name: string;
  slug?: string;
  adminEmail: string;
  adminName: string;
  locale: Locale;
}

export async function createTenantByOperator(operator: Operator, input: NewTenant) {
  return withSystem(async (c) => {
    let slug = input.slug ?? slugify(input.name);
    if (input.slug) {
      if ((await c.query('SELECT 1 FROM tenants WHERE slug = $1', [slug])).rowCount || isDemoSlug(slug)) throw conflict(m('saas.slugTaken'), 'SLUG_TAKEN');
    } else {
      while ((await c.query('SELECT 1 FROM tenants WHERE slug = $1', [slug])).rowCount || isDemoSlug(slug)) {
        slug = `${slugify(input.name).slice(0, 33)}-${randomBytes(2).toString('hex')}`;
      }
    }
    const tenantId = (await c.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, settings, created_via) VALUES ($1, $2, $3, 'admin') RETURNING id`,
      // Created by the operator for a customer: two-factor login for admins is mandatory.
      [slug, input.name, JSON.stringify({ requireMfaForAdmins: true, ...localizedDefaults(input.locale) })],
    )).rows[0].id;
    // Own data key from the first moment (R3-01).
    if (hasSecretKey()) await ensureTenantKey(c, tenantId);
    const user = (await c.query<{ id: string; tenant_id: string; email: string }>(
      `INSERT INTO users (tenant_id, email, display_name, roles, locale) VALUES ($1, $2, $3, $4, $5) RETURNING id, tenant_id, email`,
      [tenantId, input.adminEmail, input.adminName, ['submitter', 'admin', 'triage', 'committee'], input.locale],
    )).rows[0];
    const token = await issuePasswordToken(c, user, m('saas.invite.subject'), m('saas.invite.intro', { workspace: input.name }));
    await c.query('INSERT INTO audit_log (tenant_id, actor_id, action, entity, entity_id, after) VALUES ($1, NULL, $2, $3, $4, $5)', [
      tenantId, 'tenant.operator_create', 'tenant', tenantId, JSON.stringify({ operator: operator.name, operatorId: operator.id, name: input.name, slug, admin: input.adminEmail }),
    ]);
    await operatorLog(c, operator, 'tenant.create', tenantId, { slug });
    return { id: tenantId, slug, inviteLink: config.mailTransport === 'log' ? `${config.publicUrl}/passwort?token=${token}` : undefined };
  });
}

// ---------------------------------------------------------------- support access (R3-07)

export async function activeGrant(db: Db, tenantId: string) {
  return (await db.query<{ id: string; expires_at: Date; reason: string }>(
    `SELECT id, expires_at, reason FROM support_grants
      WHERE tenant_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY expires_at DESC LIMIT 1`,
    [tenantId],
  )).rows[0] ?? null;
}

/**
 * Data of a tenant for the support, only with an active grant. Reads through the tenant's
 * row-level security and writes the access into the tenant's audit log in the same transaction.
 */
export async function supportView(operator: Operator, tenantId: string) {
  const exists = await withSystem(async (c) => (await c.query('SELECT 1 FROM tenants WHERE id = $1', [tenantId])).rowCount);
  if (!exists) throw notFound(m('saas.tenantNotFound'));
  return withTenant(tenantId, async (db) => {
    const grant = await activeGrant(db, tenantId);
    if (!grant) throw forbidden(m('saas.supportNoGrant'));
    const tenant = (await db.query<{ name: string; slug: string; settings: unknown; settings_version: number }>(
      'SELECT name, slug, settings, settings_version FROM tenants WHERE id = $1', [tenantId],
    )).rows[0];
    const users = (await db.query(
      `SELECT display_name AS "displayName", email, roles, active, mfa_enabled AS "mfaEnabled", coalesce(locked_until > now(), false) AS locked
         FROM users WHERE NOT technical ORDER BY display_name LIMIT 500`,
    )).rows;
    // Confidential ideas appear only with their number (as in chat and webhooks).
    const ideas = (await db.query(
      `SELECT number, CASE WHEN confidential THEN NULL ELSE title END AS title, confidential, status, created_at AS "createdAt"
         FROM ideas ORDER BY created_at DESC LIMIT 50`,
    )).rows;
    const aiFailures = (await db.query(
      `SELECT kind, error, finished_at AS "finishedAt" FROM ai_jobs WHERE status = 'failed' ORDER BY finished_at DESC NULLS LAST LIMIT 20`,
    )).rows;
    const webhooks = (await db.query(
      `SELECT name, active, failure_count AS "failureCount", disabled_reason AS "disabledReason", last_failure_at AS "lastFailureAt"
         FROM webhook_subscriptions ORDER BY name`,
    )).rows;
    const audit = (await db.query(
      `SELECT a.created_at AS "createdAt", a.action, a.entity, u.display_name AS "actorName"
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT 50`,
    )).rows;
    await db.query('INSERT INTO audit_log (tenant_id, actor_id, action, entity, entity_id, after) VALUES ($1, NULL, $2, $3, $4, $5)', [
      tenantId, 'support.access', 'tenant', tenantId, JSON.stringify({ operator: operator.name, operatorId: operator.id, grantId: grant.id, view: 'support' }),
    ]);
    await withSystem((c) => operatorLog(c, operator, 'support.access', tenantId, { grantId: grant.id }));
    return {
      tenant: { id: tenantId, name: tenant.name, slug: tenant.slug, settingsVersion: tenant.settings_version },
      grant: { id: grant.id, expiresAt: grant.expires_at, reason: grant.reason },
      settings: resolveSettings(tenant.settings),
      users,
      ideas,
      aiFailures,
      webhooks,
      audit,
    };
  });
}
