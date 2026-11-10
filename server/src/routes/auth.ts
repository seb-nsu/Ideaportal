import { isLocale, m, tr, type Text } from '../i18n/index.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config, features } from '../config.js';
import { withSystem, type Db } from '../db/pool.js';
import { hashPassword, newToken, newTotpSecret, sha256, verifyPassword, verifyTotp } from '../lib/crypto.js';
import { HttpError, badRequest } from '../lib/errors.js';
import { clientIp, enforce, type Bucket } from '../lib/ratelimit.js';
import { openTotp, sealTotp } from '../lib/secretbox.js';
import { assertPasswordPolicy, PASSWORD_MAX } from '../lib/password.js';
import { resolveSettings } from '../lib/settings.js';
import { requireUser, SESSION_COOKIE, sessionCookie, sessionFromRequest } from '../http.js';
import { isDemoSlug } from '../db/demo-content.js';

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

interface LoginUser {
  id: string;
  tenant_id: string;
  password_hash: string | null;
  mfa_enabled: boolean;
  mfa_secret: string | null;
  failed_logins: number;
  locked_until: Date | null;
}

async function systemAudit(c: Db, tenantId: string, actorId: string | null, action: string, after: unknown) {
  await c.query('INSERT INTO audit_log (tenant_id, actor_id, action, entity, entity_id, after) VALUES ($1, $2, $3, $4, $5, $6)', [
    tenantId, actorId, action, 'user', actorId, JSON.stringify(after),
  ]);
}

async function registerFailure(c: Db, user: LoginUser): Promise<void> {
  const failed = user.failed_logins + 1;
  const lock = failed >= MAX_FAILED;
  await c.query(
    `UPDATE users SET failed_logins = $2, locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END WHERE id = $1`,
    [user.id, lock ? 0 : failed, lock, LOCK_MINUTES],
  );
  if (lock) await systemAudit(c, user.tenant_id, user.id, 'auth.locked', { minutes: LOCK_MINUTES });
}

/** Writes a rate-limit hit on an account into the audit log of every tenant that has this address. */
function auditAccountLimit(email: string) {
  return async (c: Db, bucket: Bucket) => {
    if (!bucket.endsWith('Account')) return;
    const users = (await c.query<{ id: string; tenant_id: string }>('SELECT id, tenant_id FROM users WHERE lower(email) = lower($1)', [email.trim()])).rows;
    for (const u of users) await systemAudit(c, u.tenant_id, u.id, 'auth.rate_limited', { bucket });
  };
}

// Unknown accounts and accounts without a password cost the same scrypt work as a wrong
// password, so the answer time does not tell whether an address exists.
let dummyHash: Promise<string> | undefined;
async function verifyDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword('dummy-password-for-constant-time');
  await verifyPassword(password, await dummyHash);
}

const LOCKED = () => new HttpError(423, m('auth.locked', { minutes: LOCK_MINUTES }), 'LOCKED');
const INVALID = () => new HttpError(401, m('auth.invalidCredentials'), 'INVALID_CREDENTIALS');

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/tenants/:slug', async (req) => {
    const { slug } = req.params as { slug: string };
    const t = await withSystem(async (c) => (await c.query('SELECT name, slug FROM tenants WHERE slug = $1', [slug])).rows[0]);
    if (!t) throw new HttpError(404, m('auth.tenantNotFound'), 'NOT_FOUND');
    return t;
  });

  // Login with e-mail and password. The workspace is only needed when the same
  // address with the same password exists in several workspaces.
  app.post('/api/auth/login', async (req, reply) => {
    const body = z.object({ tenant: z.string().optional(), email: z.string(), password: z.string() }).parse(req.body);
    await enforce([['loginIp', clientIp(req)], ['loginAccount', body.email.trim()]], auditAccountLimit(body.email));
    const result = await withSystem(async (c) => {
      const candidates = (await c.query<LoginUser & { slug: string; tenant_name: string; sso_only: boolean }>(
        `SELECT u.id, u.tenant_id, u.password_hash, u.mfa_enabled, u.mfa_secret, u.failed_logins, u.locked_until,
                t.slug, t.name AS tenant_name, coalesce(ti.local_login_disabled, false) AND NOT ('external' = ANY(u.roles)) AS sso_only
           FROM users u JOIN tenants t ON t.id = u.tenant_id LEFT JOIN tenant_identity ti ON ti.tenant_id = u.tenant_id
          WHERE lower(u.email) = lower($1) AND u.active AND ($2::text IS NULL OR t.slug = $2)
          ORDER BY t.name`,
        [body.email.trim(), body.tenant?.trim().toLowerCase() || null],
      )).rows;
      const matched: typeof candidates = [];
      const failed: typeof candidates = [];
      let locked = false;
      let ssoOnly: string | null = null;
      if (!candidates.length) await verifyDummy(body.password);
      for (const user of candidates) {
        if (user.locked_until && user.locked_until > new Date()) {
          locked = true;
          continue;
        }
        if (!user.password_hash) await verifyDummy(body.password);
        if (!(await verifyPassword(body.password, user.password_hash))) {
          await registerFailure(c, user);
          failed.push(user);
        }
        // Local accounts switched off for the tenant (R3-26): only the company login is allowed.
        // External people (R3-19) have no company account and keep their own login.
        // The hint is given only after the correct password, so it reveals nothing else.
        else if (user.sso_only) ssoOnly = user.slug;
        else matched.push(user);
      }
      if (matched.length === 0 && ssoOnly) return { error: new HttpError(403, m('identity.ssoRequired'), 'SSO_REQUIRED', { tenant: ssoOnly }) };
      if (matched.length === 0) {
        // Failed login of an existing account: logged in the tenant of that account. A person with
        // accounts in several workspaces gets no entries when the password fits one of them.
        for (const u of failed) await systemAudit(c, u.tenant_id, u.id, 'auth.login_failed', { reason: 'password' });
        return { error: locked ? LOCKED() : INVALID() };
      }
      if (matched.length > 1) return { choose: matched.map((u) => ({ slug: u.slug, name: u.tenant_name })) };
      const user = matched[0];
      await c.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [user.id]);
      await systemAudit(c, user.tenant_id, user.id, 'auth.login', { method: 'password', mfaPending: user.mfa_enabled });
      return { token: await createSession(c, user.id, user.tenant_id, user.mfa_enabled), mfaRequired: user.mfa_enabled };
    });
    // Failed attempts are committed before the error is raised.
    if ('error' in result) throw result.error;
    if ('choose' in result) return { chooseWorkspace: result.choose };
    reply.setCookie(SESSION_COOKIE, result.token, sessionCookie());
    return { mfaRequired: result.mfaRequired };
  });

  app.post('/api/auth/mfa', async (req) => {
    const { code } = z.object({ code: z.string().min(6).max(8) }).parse(req.body);
    const token = req.cookies[SESSION_COOKIE];
    if (!token) throw new HttpError(401, m('common.unauthenticated'), 'UNAUTHENTICATED');
    await enforce([['loginIp', clientIp(req)], ['mfaAccount', sha256(token)]]);
    const error = await withSystem(async (c) => {
      const user = (await c.query<LoginUser>(
        `SELECT u.id, u.tenant_id, u.password_hash, u.mfa_enabled, u.mfa_secret, u.failed_logins, u.locked_until
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = $1 AND s.mfa_pending AND s.expires_at > now()`,
        [sha256(token)],
      )).rows[0];
      if (!user || !user.mfa_secret) return new HttpError(401, m('auth.loginAgain'), 'UNAUTHENTICATED');
      if (user.locked_until && user.locked_until > new Date()) return LOCKED();
      if (!verifyTotp(await openTotp(c, user.tenant_id, user.mfa_secret), code)) {
        await registerFailure(c, user);
        await systemAudit(c, user.tenant_id, user.id, 'auth.mfa_failed', {});
        return new HttpError(401, m('auth.invalidCode'), 'INVALID_CODE');
      }
      await c.query('UPDATE users SET failed_logins = 0 WHERE id = $1', [user.id]);
      await systemAudit(c, user.tenant_id, user.id, 'auth.mfa_verified', {});
      await c.query('UPDATE sessions SET mfa_pending = false WHERE token_hash = $1', [sha256(token)]);
      return null;
    });
    if (error) throw error;
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      await withSystem(async (c) => {
        const s = (await c.query<{ user_id: string; tenant_id: string; auth_method: string }>(
          'DELETE FROM sessions WHERE token_hash = $1 RETURNING user_id, tenant_id, auth_method',
          [sha256(token)],
        )).rows[0];
        if (s) await systemAudit(c, s.tenant_id, s.user_id, 'auth.logout', { method: s.auth_method });
      });
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => {
    const s = await sessionFromRequest(req);
    if (!s) throw new HttpError(401, m('common.unauthenticated'), 'UNAUTHENTICATED');
    const extra = await withSystem(async (c) =>
      (await c.query<{ onboarded: boolean; tenant_name: string; tenant_slug: string; auth_method: string | null }>(
        `SELECT u.onboarded, t.name AS tenant_name, t.slug AS tenant_slug,
                (SELECT auth_method FROM sessions WHERE token_hash = $2) AS auth_method
           FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1`,
        [s.user.id, sha256(req.cookies[SESSION_COOKIE] ?? '')],
      )).rows[0],
    );
    return {
      user: s.user,
      mfaPending: s.mfaPending,
      mfaSetupRequired: s.mfaSetupRequired,
      onboarded: extra.onboarded,
      tenant: { name: extra.tenant_name, slug: extra.tenant_slug },
      authMethod: extra.auth_method ?? 'password',
      demo: features.demo && isDemoSlug(extra.tenant_slug),
    };
  });

  app.post('/api/me/onboarded', async (req) => {
    const user = await requireUser(req, { allowMfaSetup: true });
    await withSystem((c) => c.query('UPDATE users SET onboarded = true WHERE id = $1', [user.id]));
    return { ok: true };
  });

  app.post('/api/auth/mfa/setup', async (req) => {
    const user = await requireUser(req, { allowMfaSetup: true });
    if (user.mfaEnabled) throw badRequest(m('auth.mfaActive'));
    const secret = newTotpSecret();
    const tenant = await withSystem(async (c) => {
      await c.query('UPDATE users SET mfa_secret = $2 WHERE id = $1', [user.id, await sealTotp(c, user.tenantId, secret)]);
      return (await c.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [user.tenantId])).rows[0];
    });
    const issuer = encodeURIComponent(`Ideenportal ${tenant.name}`);
    return { secret, otpauthUrl: `otpauth://totp/${issuer}:${encodeURIComponent(user.email)}?secret=${secret}&issuer=${issuer}` };
  });

  app.post('/api/auth/mfa/enable', async (req) => {
    const user = await requireUser(req, { allowMfaSetup: true });
    const { code } = z.object({ code: z.string().min(6).max(8) }).parse(req.body);
    await withSystem(async (c) => {
      const secret = (await c.query<{ mfa_secret: string | null }>('SELECT mfa_secret FROM users WHERE id = $1', [user.id])).rows[0]?.mfa_secret;
      if (!secret || !verifyTotp(await openTotp(c, user.tenantId, secret), code)) throw new HttpError(400, m('auth.invalidCode'), 'INVALID_CODE');
      await c.query('UPDATE users SET mfa_enabled = true WHERE id = $1', [user.id]);
      await systemAudit(c, user.tenantId, user.id, 'auth.mfa_enabled', { mfa_enabled: true });
    });
    return { ok: true };
  });

  app.post('/api/auth/reset-request', async (req) => {
    const body = z.object({ tenant: z.string().optional(), email: z.string() }).parse(req.body);
    await enforce([['resetIp', clientIp(req)], ['resetAccount', body.email.trim()]], auditAccountLimit(body.email));
    await withSystem(async (c) => {
      // Without a workspace, every account with this address gets its own link.
      const users = (await c.query<{ id: string; tenant_id: string; email: string }>(
        `SELECT u.id, u.tenant_id, u.email FROM users u JOIN tenants t ON t.id = u.tenant_id
          WHERE ($1::text IS NULL OR t.slug = $1) AND lower(u.email) = lower($2) AND u.active
            AND (NOT EXISTS (SELECT 1 FROM tenant_identity ti WHERE ti.tenant_id = u.tenant_id AND ti.local_login_disabled)
                 OR 'external' = ANY(u.roles))`,
        [body.tenant?.trim().toLowerCase() || null, body.email.trim()],
      )).rows;
      for (const user of users) {
        await issuePasswordToken(c, user, m('auth.reset.subject'), m('auth.reset.intro'));
      }
    });
    // Same answer whether or not the address exists.
    return { ok: true };
  });

  app.post('/api/auth/set-password', async (req) => {
    const body = z.object({ token: z.string().min(20), password: z.string().min(10).max(PASSWORD_MAX) }).parse(req.body);
    await enforce([['resetIp', clientIp(req)]]);
    const ok = await withSystem(async (c) => {
      const user = (await c.query<{ id: string; tenant_id: string; email: string; settings: unknown }>(
        `SELECT u.id, u.tenant_id, u.email, t.settings FROM users u JOIN tenants t ON t.id = u.tenant_id
          WHERE u.reset_token_hash = $1 AND u.reset_expires_at > now() AND u.active`,
        [sha256(body.token)],
      )).rows[0];
      if (!user) return false;
      // Password policy of the tenant (minimum length, common and breached passwords).
      await assertPasswordPolicy(body.password, { minLength: resolveSettings(user.settings).security.passwordMinLength, email: user.email });
      await c.query(
        `UPDATE users SET password_hash = $2, reset_token_hash = NULL, reset_expires_at = NULL, failed_logins = 0, locked_until = NULL WHERE id = $1`,
        [user.id, await hashPassword(body.password)],
      );
      await c.query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
      await systemAudit(c, user.tenant_id, user.id, 'auth.password_set', {});
      return true;
    });
    if (!ok) throw badRequest(m('auth.linkInvalid'));
    return { ok: true };
  });
}

/** Creates a one-time link for invitations and password resets; the mail goes through the outbox. */
export async function issuePasswordToken(c: Db, user: { id: string; tenant_id: string; email: string }, subject: Text, intro: Text): Promise<string> {
  const token = newToken();
  // The mail is written in the language stored for the person (R2-50).
  const stored = (await c.query<{ locale: string | null }>('SELECT locale FROM users WHERE id = $1', [user.id])).rows[0]?.locale;
  const locale = isLocale(stored) ? stored : 'de';
  await c.query(`UPDATE users SET reset_token_hash = $2, reset_expires_at = now() + interval '24 hours' WHERE id = $1`, [user.id, sha256(token)]);
  await c.query('INSERT INTO outbox (tenant_id, user_id, to_email, subject, body) VALUES ($1, NULL, $2, $3, $4)', [
    user.tenant_id, user.email, tr(locale, subject), `${tr(locale, intro)}\n${config.publicUrl}/passwort?token=${token}`,
  ]);
  return token;
}

/** authMethod 'oidc' or 'saml': company login (R3-26); the identity provider is responsible for the second factor. */
export async function createSession(c: Db, userId: string, tenantId: string, mfaPending = false, authMethod: 'password' | 'oidc' | 'saml' = 'password'): Promise<string> {
  const token = newToken();
  await c.query(
    `INSERT INTO sessions (token_hash, tenant_id, user_id, mfa_pending, expires_at, auth_method)
     VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5), $6)`,
    [sha256(token), tenantId, userId, mfaPending, config.sessionHours, authMethod],
  );
  return token;
}
