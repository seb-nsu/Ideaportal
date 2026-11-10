import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { withSystem, withTenant, type Db } from '../db/pool.js';
import { getSecret, setSecret } from '../ai/secrets.js';
import { buildCtx, type Ctx } from '../lib/context.js';
import { newToken, sha256 } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { OidcError, authorizationUrl, discover, exchangeCode, normalizeIssuer, randomValue, verifyIdToken } from '../lib/oidc.js';
import { clientIp, enforce } from '../lib/ratelimit.js';
import { m } from '../i18n/index.js';
import { SESSION_COOKIE, sessionCookie, tenantHandler } from '../http.js';
import { audit } from '../services/audit.js';
import {
  claimsSchema, domainAllowed, emailDomain, groupRoleSchema, loadIdentity, personFromClaims, syncRoles, type IdentityConfig,
} from '../services/identity.js';
import { createSession } from './auth.js';
import { loadPlanState } from '../services/billing.js';
import { SamlError, acsUrl, certInfo, normalizeCert, samlSettingsSchema, spEntityId, validSsoUrl } from '../lib/saml.js';

// Company login with OpenID Connect (R3-26): authorization code flow with PKCE, state and
// nonce; accounts are created on first login (just-in-time) and roles follow the groups.
// Settings › Anmeldung configures it per tenant without a developer.

const admin = { roles: ['admin' as const] };
export const OIDC_SECRET = 'oidc_client_secret';
const STATE_COOKIE = 'ip_oidc';
const STATE_MINUTES = 10;

export const redirectUri = () => `${config.publicUrl}/api/auth/oidc/callback`;
export const scimBaseUrl = () => `${config.publicUrl}/scim/v2`;

/** Only relative paths inside the app are allowed as the target after login (no open redirect). */
export function safeReturnPath(raw: unknown): string {
  return typeof raw === 'string' && /^\/(?![/\\])[^\s]*$/.test(raw) && !raw.startsWith('/api/') ? raw : '/';
}

function stateCookie(maxAge: number) {
  // Lax, not Strict: the callback is a top-level navigation coming back from the identity provider.
  return { path: '/api/auth/oidc', httpOnly: true, sameSite: 'lax' as const, secure: config.cookieSecure, maxAge };
}

export type Failure = 'state' | 'provider' | 'denied' | 'domain' | 'no_account' | 'inactive' | 'not_configured';

export function fail(reply: FastifyReply, reason: Failure) {
  return reply.redirect(`/login?sso=${reason}`, 302);
}

export async function systemAudit(c: Db, tenantId: string, actorId: string | null, action: string, after: unknown) {
  await c.query('INSERT INTO audit_log (tenant_id, actor_id, action, entity, entity_id, after) VALUES ($1, $2, $3, $4, $5, $6)', [
    tenantId, actorId, action, 'user', actorId, JSON.stringify(after),
  ]);
}

/** The tenant that has company login for this e-mail domain, if exactly one has it. */
type SsoTenant = { id: string; slug: string; name: string; local_login_disabled: boolean; protocol: string };

async function tenantByDomain(c: Db, domain: string): Promise<SsoTenant | null> {
  const rows = (await c.query<SsoTenant>(
    `SELECT t.id, t.slug, t.name, ti.local_login_disabled, ti.protocol FROM tenant_identity ti JOIN tenants t ON t.id = ti.tenant_id
      WHERE ti.oidc_enabled AND $1 = ANY(ti.allowed_domains)`,
    [domain],
  )).rows;
  return rows.length === 1 ? rows[0] : null;
}

interface Provisioned {
  userId?: string;
  failure?: Failure;
}

/**
 * Finds or creates the account after a verified ID token (OIDC) or SAML assertion; runs in the
 * tenant's context. sub is the stable subject (OIDC sub, SAML NameID); null when the provider
 * sends none that is stable (SAML transient NameID): then the account is found by address.
 */
export async function provision(ctx: Ctx, cfg: IdentityConfig, claims: Record<string, unknown> & { sub: string | null }, source: 'oidc' | 'saml' = 'oidc'): Promise<Provisioned> {
  const person = personFromClaims(claims, cfg.claims);
  if (!person.email || !person.emailVerified || !domainAllowed(cfg, person.email) || !cfg.allowedDomains.length) return { failure: 'domain' };
  const db = ctx.db;
  type Row = { id: string; email: string; active: boolean; scim_deleted_at: Date | null };
  let user = claims.sub ? (await db.query<Row>('SELECT id, email, active, scim_deleted_at FROM users WHERE oidc_subject = $1', [claims.sub])).rows[0] : undefined;
  let bySubject = !!user;
  if (!user) {
    user = (await db.query<Row>('SELECT id, email, active, scim_deleted_at FROM users WHERE lower(email) = lower($1) AND anonymized_at IS NULL', [person.email])).rows[0];
  }
  if (user && (!user.active || user.scim_deleted_at)) return { failure: 'inactive' };
  if (!user) {
    if (!cfg.jitProvisioning) return { failure: 'no_account' };
    const name = person.name && person.name.length >= 2 ? person.name.slice(0, 120) : person.email.split('@')[0];
    const created = (await db.query<Row>(
      `INSERT INTO users (tenant_id, email, display_name, org_unit, roles, idp_managed, oidc_subject, idp_groups, onboarded)
       VALUES ($1, $2, $3, $4, ARRAY['submitter'], true, $5, $6, false)
       ON CONFLICT (tenant_id, email) DO NOTHING RETURNING id, email, active, scim_deleted_at`,
      [ctx.tenantId, person.email, name, person.department?.slice(0, 120) ?? null, claims.sub, person.groups ?? []],
    )).rows[0];
    if (!created) return { failure: 'inactive' };
    user = created;
    bySubject = true;
    await audit({ ...ctx, user: null }, 'user.jit_create', 'user', user.id, null, { email: person.email, source });
  } else {
    // Name, department and groups follow the directory on every login; a changed sign-in
    // address follows too when the account was found by its subject and the address is free.
    const newEmail = bySubject && user.email.toLowerCase() !== person.email
      && !(await db.query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [person.email])).rowCount ? person.email : user.email;
    await db.query(
      `UPDATE users SET idp_managed = true, oidc_subject = coalesce($2, oidc_subject), email = $3,
              display_name = CASE WHEN length($4::text) >= 2 THEN left($4::text, 120) ELSE display_name END,
              org_unit = coalesce(left($5::text, 120), org_unit),
              idp_groups = coalesce($6::text[], idp_groups), failed_logins = 0, locked_until = NULL
        WHERE id = $1`,
      [user.id, claims.sub, newEmail, person.name ?? '', person.department, person.groups],
    );
  }
  await syncRoles(db, cfg, user.id);
  return { userId: user.id };
}

const identityInput = z.object({
  oidcEnabled: z.boolean(),
  // Omitted = keep the stored protocol and SAML settings (older clients).
  protocol: z.enum(['oidc', 'saml']).optional(),
  saml: samlSettingsSchema.optional(),
  issuer: z.string().trim().max(500),
  clientId: z.string().trim().max(200),
  // undefined = keep, '' or null = delete
  clientSecret: z.string().max(500).nullable().optional(),
  allowedDomains: z.array(z.string().trim().toLowerCase().max(200)).max(50),
  groupRoles: z.array(groupRoleSchema).max(100),
  jitProvisioning: z.boolean(),
  localLoginDisabled: z.boolean(),
  claims: claimsSchema,
});

const DOMAIN = /^(?=.{3,200}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

async function currentAuthMethod(req: FastifyRequest): Promise<string> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return 'password';
  return withSystem(async (c) => (await c.query<{ auth_method: string }>('SELECT auth_method FROM sessions WHERE token_hash = $1', [sha256(token)])).rows[0]?.auth_method ?? 'password');
}

async function adminView(ctx: Ctx, req: FastifyRequest) {
  const cfg = await loadIdentity(ctx.db, ctx.tenantId);
  const secret = await ctx.db.query('SELECT 1 FROM tenant_secrets WHERE name = $1', [OIDC_SECRET]);
  const tokens = await ctx.db.query(
    `SELECT id, label, created_at AS "createdAt", last_used_at AS "lastUsedAt", revoked_at AS "revokedAt"
       FROM scim_tokens ORDER BY created_at DESC`,
  );
  return {
    config: cfg,
    secretSet: !!secret.rowCount,
    redirectUri: redirectUri(),
    scimUrl: scimBaseUrl(),
    // SAML service provider of this tenant (R3-26): values for the enterprise app at the IdP.
    samlSp: { entityId: spEntityId(ctx.tenantId), acsUrl: acsUrl(ctx.tenantId), metadataUrl: spEntityId(ctx.tenantId) },
    samlCerts: cfg.saml.certs.map((c) => { try { return certInfo(c); } catch { return null; } }),
    tokens: tokens.rows,
    authMethod: await currentAuthMethod(req),
  };
}

export async function identityRoutes(app: FastifyInstance): Promise<void> {
  // Login page: does the workspace (by slug or e-mail domain) have a company login?
  app.get('/api/auth/sso', async (req) => {
    const q = z.object({ email: z.string().max(200).optional(), tenant: z.string().max(100).optional() }).parse(req.query);
    await enforce([['ssoIp', clientIp(req)]]);
    return withSystem(async (c) => {
      let t: SsoTenant | null = null;
      if (q.tenant) {
        t = (await c.query<SsoTenant>(
          `SELECT t.id, t.slug, t.name, ti.local_login_disabled, ti.protocol FROM tenants t JOIN tenant_identity ti ON ti.tenant_id = t.id
            WHERE t.slug = $1 AND ti.oidc_enabled`,
          [q.tenant.trim().toLowerCase()],
        )).rows[0] ?? null;
      } else if (q.email?.includes('@')) {
        t = await tenantByDomain(c, emailDomain(q.email));
      }
      return t ? { available: true, tenant: t.slug, name: t.name, localLogin: !t.local_login_disabled, protocol: t.protocol } : { available: false };
    });
  });

  app.get('/api/auth/oidc/start', async (req, reply) => {
    const q = z.object({ tenant: z.string().max(100), weiter: z.string().max(500).optional(), login_hint: z.string().max(200).optional() }).safeParse(req.query);
    await enforce([['ssoIp', clientIp(req)]]);
    if (!q.success) return fail(reply, 'not_configured');
    const tenant = await withSystem(async (c) => {
      await c.query('DELETE FROM oidc_login_states WHERE expires_at < now()');
      return (await c.query<{ id: string }>('SELECT id FROM tenants WHERE slug = $1', [q.data.tenant.trim().toLowerCase()])).rows[0];
    });
    if (!tenant) return fail(reply, 'not_configured');
    // Company login belongs to the package (R3-05).
    if (!(await loadPlanState(tenant.id)).features.sso) return fail(reply, 'not_configured');
    const setup = await withTenant(tenant.id, async (db) => {
      const ctx = await buildCtx(db, tenant.id, null);
      const cfg = await loadIdentity(db, tenant.id);
      const secret = cfg.oidcEnabled ? await getSecret(ctx, OIDC_SECRET).catch(() => null) : null;
      return { cfg, secret };
    });
    if (!setup.cfg.oidcEnabled || setup.cfg.protocol !== 'oidc' || !setup.cfg.issuer || !setup.cfg.clientId || !setup.secret) return fail(reply, 'not_configured');
    let d;
    try {
      d = await discover(setup.cfg.issuer);
    } catch (err) {
      req.log.warn({ reason: (err as Error).message }, 'oidc discovery failed');
      return fail(reply, 'provider');
    }
    const state = randomValue();
    const nonce = randomValue();
    const codeVerifier = randomValue();
    // One browser value per browser, reused for parallel logins in several tabs.
    const browser = req.cookies[STATE_COOKIE] && req.cookies[STATE_COOKIE].length >= 40 ? req.cookies[STATE_COOKIE] : newToken();
    await withSystem((c) => c.query(
      `INSERT INTO oidc_login_states (state_hash, tenant_id, nonce, code_verifier, browser_hash, return_to, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7))`,
      [sha256(state), tenant.id, nonce, codeVerifier, sha256(browser), safeReturnPath(q.data.weiter), STATE_MINUTES],
    ));
    reply.setCookie(STATE_COOKIE, browser, stateCookie(STATE_MINUTES * 60));
    const hint = q.data.login_hint?.includes('@') ? q.data.login_hint : undefined;
    return reply.redirect(authorizationUrl(d, { clientId: setup.cfg.clientId, redirectUri: redirectUri(), state, nonce, codeVerifier, loginHint: hint }), 302);
  });

  app.get('/api/auth/oidc/callback', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    await enforce([['ssoIp', clientIp(req)]]);
    const browser = req.cookies[STATE_COOKIE];
    const state = q.state;
    if (typeof state !== 'string' || !browser) return fail(reply, 'state');
    // One-time use: the state row is deleted whatever happens next.
    const st = await withSystem(async (c) => (await c.query<{ tenant_id: string; nonce: string; code_verifier: string; browser_hash: string; return_to: string }>(
      'DELETE FROM oidc_login_states WHERE state_hash = $1 AND expires_at > now() RETURNING tenant_id, nonce, code_verifier, browser_hash, return_to',
      [sha256(state)],
    )).rows[0]);
    if (!st || st.browser_hash !== sha256(browser)) return fail(reply, 'state');
    if (typeof q.error === 'string') return fail(reply, 'denied');
    if (typeof q.code !== 'string' || !q.code) return fail(reply, 'state');

    const setup = await withTenant(st.tenant_id, async (db) => {
      const ctx = await buildCtx(db, st.tenant_id, null);
      const cfg = await loadIdentity(db, st.tenant_id);
      return { cfg, secret: cfg.oidcEnabled ? await getSecret(ctx, OIDC_SECRET).catch(() => null) : null };
    });
    if (!setup.cfg.oidcEnabled || setup.cfg.protocol !== 'oidc' || !setup.secret) return fail(reply, 'not_configured');
    let claims;
    try {
      const d = await discover(setup.cfg.issuer);
      const idToken = await exchangeCode(d, { clientId: setup.cfg.clientId, clientSecret: setup.secret, redirectUri: redirectUri(), code: q.code, codeVerifier: st.code_verifier });
      claims = await verifyIdToken(idToken, { jwksUri: d.jwks_uri, issuer: d.issuer, clientId: setup.cfg.clientId, nonce: st.nonce });
    } catch (err) {
      // No token or claim content in the log, only the reason.
      req.log.warn({ reason: err instanceof OidcError ? `${err.reason}: ${err.message}` : (err as Error).name }, 'oidc login failed');
      return fail(reply, 'provider');
    }
    const result = await withTenant(st.tenant_id, async (db) => provision(await buildCtx(db, st.tenant_id, null), setup.cfg, claims, 'oidc'));
    if (!result.userId) {
      await withSystem((c) => systemAudit(c, st.tenant_id, null, 'auth.sso_refused', { reason: result.failure }));
      return fail(reply, result.failure!);
    }
    const token = await withSystem(async (c) => {
      await systemAudit(c, st.tenant_id, result.userId!, 'auth.sso_login', { method: 'oidc', protocol: 'oidc' });
      return createSession(c, result.userId!, st.tenant_id, false, 'oidc');
    });
    reply.clearCookie(STATE_COOKIE, { path: '/api/auth/oidc' });
    reply.setCookie(SESSION_COOKIE, token, sessionCookie());
    return reply.redirect(st.return_to, 302);
  });

  // --- Settings › Anmeldung (admins)
  app.get('/api/admin/identity', tenantHandler(async (ctx, req) => adminView(ctx, req), admin));

  app.put(
    '/api/admin/identity',
    tenantHandler(async (ctx, req) => {
      const body = identityInput.parse(req.body);
      const stored = await loadIdentity(ctx.db, ctx.tenantId);
      const protocol = body.protocol ?? stored.protocol;
      const saml = body.saml ?? stored.saml;
      const domains = Array.from(new Set(body.allowedDomains.filter(Boolean)));
      for (const d of domains) if (!DOMAIN.test(d)) throw badRequest(m('identity.domainInvalid', { domain: d }));
      const issuer = body.issuer ? normalizeIssuer(body.issuer) : '';
      const hasSecret = body.clientSecret === undefined
        ? !!(await ctx.db.query('SELECT 1 FROM tenant_secrets WHERE name = $1', [OIDC_SECRET])).rowCount
        : !!body.clientSecret;
      // Certificates are public; stored normalized as PEM, invalid ones refused.
      try {
        saml.certs = saml.certs.filter(Boolean).map(normalizeCert);
      } catch (err) {
        if (err instanceof SamlError) throw badRequest(m('saml.certInvalid'), { code: 'CERT_INVALID' });
        throw err;
      }
      if (body.oidcEnabled && protocol === 'saml') {
        if (!saml.idpEntityId) throw badRequest(m('saml.entityRequired'));
        if (!saml.ssoUrl || !validSsoUrl(saml.ssoUrl)) throw badRequest(m('saml.ssoUrlRequired'));
        if (!saml.certs.length) throw badRequest(m('saml.certRequired'));
        if (saml.certs.every((c) => certInfo(c).daysLeft < 0)) throw badRequest(m('saml.certExpired'), { code: 'CERT_EXPIRED' });
        if (!domains.length) throw badRequest(m('identity.domainsRequired'));
      }
      if (body.oidcEnabled && protocol === 'oidc') {
        if (!issuer) throw badRequest(m('identity.issuerRequired'));
        if (!body.clientId) throw badRequest(m('identity.clientIdRequired'));
        if (!hasSecret) throw badRequest(m('identity.secretRequired'));
        if (!domains.length) throw badRequest(m('identity.domainsRequired'));
      }
      if (body.localLoginDisabled) {
        if (!body.oidcEnabled) throw badRequest(m('identity.localNeedsOidc'));
        // Proof that the company login works for at least one admin before passwords stop working.
        // The session must come from the protocol that is switched on now.
        if ((await currentAuthMethod(req)) !== protocol) throw badRequest(m('identity.localNeedsOidcSession'));
      }
      // A domain belongs to one workspace only; it decides where the login page sends people.
      const taken = await withSystem(async (c) => (await c.query<{ d: string }>(
        'SELECT unnest(allowed_domains) AS d FROM tenant_identity WHERE tenant_id <> $1', [ctx.tenantId],
      )).rows.map((r) => r.d));
      const clash = domains.find((d) => taken.includes(d));
      if (clash) throw conflict(m('identity.domainTaken', { domain: clash }), 'DOMAIN_TAKEN');
      if (body.oidcEnabled && protocol === 'oidc') {
        try {
          await discover(issuer, true);
        } catch (err) {
          throw badRequest(m('identity.discoveryFailed', { reason: err instanceof OidcError ? err.message : 'error' }), { code: 'DISCOVERY_FAILED' });
        }
      }
      // Group → role + area (R3-29): the area must exist in this tenant.
      const areaIds = [...new Set(body.groupRoles.map((g) => g.areaId).filter((a): a is string => !!a))];
      if (areaIds.length && (await ctx.db.query('SELECT id FROM areas WHERE id = ANY($1::uuid[])', [areaIds])).rowCount !== areaIds.length) {
        throw badRequest(m('areas.unknownArea'));
      }
      const before = stored;
      if (body.clientSecret !== undefined) await setSecret(ctx, OIDC_SECRET, body.clientSecret || null);
      await ctx.db.query(
        `INSERT INTO tenant_identity (tenant_id, oidc_enabled, issuer, client_id, allowed_domains, group_roles, jit_provisioning, local_login_disabled, claims, updated_by, updated_at, protocol, saml)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), $11, $12)
         ON CONFLICT (tenant_id) DO UPDATE SET oidc_enabled = EXCLUDED.oidc_enabled, issuer = EXCLUDED.issuer, client_id = EXCLUDED.client_id,
           allowed_domains = EXCLUDED.allowed_domains, group_roles = EXCLUDED.group_roles, jit_provisioning = EXCLUDED.jit_provisioning,
           local_login_disabled = EXCLUDED.local_login_disabled, claims = EXCLUDED.claims, updated_by = EXCLUDED.updated_by, updated_at = now(),
           protocol = EXCLUDED.protocol, saml = EXCLUDED.saml`,
        [ctx.tenantId, body.oidcEnabled, issuer || null, body.clientId || null, domains, JSON.stringify(body.groupRoles),
          body.jitProvisioning, body.localLoginDisabled, JSON.stringify(body.claims), ctx.user!.id, protocol, JSON.stringify(saml)],
      );
      const after = await loadIdentity(ctx.db, ctx.tenantId);
      // The secret never goes into the audit log; only whether it was changed.
      await audit(ctx, 'identity.update', 'tenant', ctx.tenantId, before, { ...after, clientSecretChanged: body.clientSecret !== undefined });
      // A changed mapping applies to every managed account at once.
      if (JSON.stringify(before.groupRoles) !== JSON.stringify(after.groupRoles)) {
        const managed = await ctx.db.query<{ id: string }>('SELECT id FROM users WHERE idp_managed AND active');
        for (const u of managed.rows) await syncRoles(ctx.db, after, u.id);
      }
      return adminView(ctx, req);
    }, admin),
  );

  app.post(
    '/api/admin/identity/check',
    tenantHandler(async (_ctx, req) => {
      const { issuer } = z.object({ issuer: z.string().trim().min(1).max(500) }).parse(req.body);
      try {
        const d = await discover(issuer, true);
        return { ok: true, issuer: d.issuer, authorizationEndpoint: d.authorization_endpoint };
      } catch (err) {
        return { ok: false, reason: err instanceof OidcError ? err.message : 'error' };
      }
    }, admin),
  );

  // SCIM tokens (R3-27): shown once, stored as a hash, revocable.
  app.post(
    '/api/admin/identity/scim-tokens',
    tenantHandler(async (ctx, req, reply) => {
      const { label } = z.object({ label: z.string().trim().min(1).max(80) }).parse(req.body);
      const token = `scim_${newToken()}`;
      const r = await ctx.db.query<{ id: string }>(
        'INSERT INTO scim_tokens (tenant_id, token_hash, label, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
        [ctx.tenantId, sha256(token), label, ctx.user!.id],
      );
      await audit(ctx, 'scim_token.create', 'tenant', ctx.tenantId, null, { id: r.rows[0].id, label });
      reply.code(201);
      return { id: r.rows[0].id, token };
    }, admin),
  );

  app.delete(
    '/api/admin/identity/scim-tokens/:id',
    tenantHandler(async (ctx, req) => {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const r = await ctx.db.query('UPDATE scim_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1', [id]);
      if (!r.rowCount) throw notFound(m('identity.tokenNotFound'));
      await audit(ctx, 'scim_token.revoke', 'tenant', ctx.tenantId, null, { id });
      return { ok: true };
    }, admin),
  );
}
