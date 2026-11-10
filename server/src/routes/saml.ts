import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { withSystem, withTenant } from '../db/pool.js';
import { buildCtx } from '../lib/context.js';
import { newToken, sha256 } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { clientIp, enforce } from '../lib/ratelimit.js';
import {
  DbRequestCache,
  SamlError,
  acsUrl,
  certInfo,
  checkAssertion,
  checkSettings,
  claimsFromProfile,
  consumeAssertion,
  fetchIdpMetadata,
  parseIdpMetadata,
  parseXml,
  samlSettingsSchema,
  serviceProvider,
  spBase,
  spMetadata,
} from '../lib/saml.js';
import { m } from '../i18n/index.js';
import { SESSION_COOKIE, sessionCookie, tenantHandler } from '../http.js';
import { DEFAULT_CLAIMS, loadIdentity, type IdentityConfig } from '../services/identity.js';
import { loadPlanState } from '../services/billing.js';
import { createSession } from './auth.js';
import { fail, provision, safeReturnPath, systemAudit } from './identity.js';

// Company login with SAML 2.0 (R3-26), alternative to OpenID Connect per tenant:
// SP metadata, SP-initiated login (HTTP-Redirect AuthnRequest), assertion consumer service
// (HTTP-POST), optional IdP-initiated login. Accounts, groups → roles, allowed domains and
// "local accounts off" follow the same rules as OIDC (provision() in identity.ts).

const admin = { roles: ['admin' as const] };
const BROWSER_COOKIE = 'ip_saml';
const COOKIE_PATH = '/api/auth/saml';
const MAX_RESPONSE_CHARS = 1_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The ACS receives a cross-site POST from the identity provider: only SameSite=None cookies
 * arrive there, and those need Secure. Without HTTPS (local development) the cookie is Lax and
 * the browser binding is checked only when the cookie is present.
 */
function browserCookie(maxAge: number) {
  return config.cookieSecure
    ? { path: COOKIE_PATH, httpOnly: true, sameSite: 'none' as const, secure: true, maxAge }
    : { path: COOKIE_PATH, httpOnly: true, sameSite: 'lax' as const, secure: false, maxAge };
}

type TenantRow = { id: string; slug: string };

/** Tenant from the URL: its ID (used in entity ID and ACS URL) or its slug. */
async function tenantFromParam(param: string): Promise<TenantRow | undefined> {
  return withSystem(
    async (c) =>
      (
        await c.query<TenantRow>(UUID.test(param) ? 'SELECT id, slug FROM tenants WHERE id = $1' : 'SELECT id, slug FROM tenants WHERE slug = $1', [
          UUID.test(param) ? param : param.trim().toLowerCase(),
        ])
      ).rows[0],
  );
}

async function samlSetup(tenant: TenantRow): Promise<IdentityConfig | null> {
  if (!(await loadPlanState(tenant.id)).features.sso) return null;
  const cfg = await withTenant(tenant.id, (db) => loadIdentity(db, tenant.id));
  const s = cfg.saml;
  if (!cfg.oidcEnabled || cfg.protocol !== 'saml' || !s.idpEntityId || !s.ssoUrl || !s.certs.length) return null;
  return cfg;
}

/** Short reason for the audit log; never assertion content. */
function reasonOf(err: unknown): string {
  if (err instanceof SamlError) return err.reason;
  const msg = (err as Error)?.message ?? '';
  const known: [RegExp, string][] = [
    [/signature/i, 'signature'],
    [/audience/i, 'audience'],
    [/expired|not yet valid|too old/i, 'time'],
    [/InResponseTo/i, 'in_response_to'],
    [/issuer/i, 'issuer'],
    [/subject confirmation/i, 'subject_confirmation'],
    [/SAML provider returned/i, 'idp_status'],
    [/missing SAML assertion|multiple assertions|Cannot obtain assertion/i, 'assertion'],
    [/xml|parse|document/i, 'malformed'],
  ];
  return known.find(([re]) => re.test(msg))?.[1] ?? 'invalid';
}

async function refused(req: FastifyRequest, reply: FastifyReply, tenantId: string, reason: string, failure: Parameters<typeof fail>[1] = 'provider') {
  req.log.warn({ reason }, 'saml login failed');
  await withSystem((c) => systemAudit(c, tenantId, null, 'auth.sso_failed', { protocol: 'saml', reason }));
  return fail(reply, failure);
}

export async function samlRoutes(app: FastifyInstance): Promise<void> {
  // SP metadata for the identity provider (download or URL import in Entra ID, Okta, ADFS).
  app.get('/api/auth/saml/:tenant/metadata', async (req, reply) => {
    const { tenant: param } = z.object({ tenant: z.string().max(100) }).parse(req.params);
    await enforce([['ssoIp', clientIp(req)]]);
    const tenant = await tenantFromParam(param);
    if (!tenant || !(await loadPlanState(tenant.id)).features.sso) throw notFound();
    reply.header('content-type', 'application/samlmetadata+xml; charset=utf-8');
    if ((req.query as Record<string, unknown>).download !== undefined)
      reply.header('content-disposition', `attachment; filename="ideenportal-sp-${tenant.slug}.xml"`);
    return spMetadata(tenant.id);
  });

  // SP-initiated login: AuthnRequest with HTTP-Redirect binding; its ID is stored for InResponseTo.
  app.get('/api/auth/saml/:tenant/login', async (req, reply) => {
    await enforce([['ssoIp', clientIp(req)]]);
    const p = z.object({ tenant: z.string().max(100) }).safeParse(req.params);
    const q = z.object({ weiter: z.string().max(500).optional(), login_hint: z.string().max(200).optional() }).safeParse(req.query);
    if (!p.success || !q.success) return fail(reply, 'not_configured');
    const tenant = await tenantFromParam(p.data.tenant);
    const cfg = tenant ? await samlSetup(tenant) : null;
    if (!tenant || !cfg) return fail(reply, 'not_configured');
    const existing = req.cookies[BROWSER_COOKIE];
    const browser = existing && existing.length >= 40 ? existing : newToken();
    const cache = new DbRequestCache(tenant.id, { browserHash: sha256(browser), returnTo: safeReturnPath(q.data.weiter) });
    let url: string;
    try {
      const hint = q.data.login_hint?.includes('@') ? { login_hint: q.data.login_hint } : undefined;
      url = await serviceProvider(tenant.id, cfg.saml, cache).getAuthorizeUrlAsync('', undefined, { additionalParams: hint });
    } catch (err) {
      req.log.warn({ reason: reasonOf(err) }, 'saml request failed');
      return fail(reply, 'not_configured');
    }
    reply.setCookie(BROWSER_COOKIE, browser, browserCookie(10 * 60));
    return reply.redirect(url, 302);
  });

  // Assertion consumer service (HTTP-POST binding). Form bodies only in this scope.
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: MAX_RESPONSE_CHARS + 10_000 }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });

    scope.post('/api/auth/saml/:tenant/acs', async (req, reply) => {
      await enforce([['ssoIp', clientIp(req)]]);
      const { tenant: param } = z.object({ tenant: z.string().max(100) }).parse(req.params);
      const tenant = await tenantFromParam(param);
      if (!tenant) return fail(reply, 'not_configured');
      const cfg = await samlSetup(tenant);
      if (!cfg) return refused(req, reply, tenant.id, 'not_configured', 'not_configured');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const samlResponse = body.SAMLResponse;
      if (typeof samlResponse !== 'string' || !samlResponse || samlResponse.length > MAX_RESPONSE_CHARS) return refused(req, reply, tenant.id, 'missing');

      let responseXml: string;
      try {
        responseXml = Buffer.from(samlResponse, 'base64').toString('utf8');
        parseXml(responseXml); // no DTD / entities, well-formed, size limit
      } catch (err) {
        return refused(req, reply, tenant.id, reasonOf(err));
      }

      const cache = new DbRequestCache(tenant.id);
      const sp = serviceProvider(tenant.id, cfg.saml, cache);
      let claims: ReturnType<typeof claimsFromProfile>;
      try {
        const { profile } = await sp.validatePostResponseAsync({ SAMLResponse: samlResponse });
        if (!profile) throw new SamlError('no_assertion');
        // The ACS URL may be addressed by tenant ID (shown in the settings) or by slug.
        const facts = checkAssertion(profile, { acsUrls: [acsUrl(tenant.id), `${spBase(tenant.slug)}/acs`], idpEntityId: cfg.saml.idpEntityId, responseXml });
        if (!(await consumeAssertion(tenant.id, facts))) throw new SamlError('replay');
        claims = claimsFromProfile(profile, cfg.saml.attributes);
      } catch (err) {
        return refused(req, reply, tenant.id, reasonOf(err));
      } finally {
        // Single use, whatever happened: the request ID cannot be used a second time.
        const inResponseTo = /\bInResponseTo="([^"]{1,200})"/.exec(responseXml)?.[1];
        if (inResponseTo) await cache.removeAsync(inResponseTo);
      }

      // Browser binding of SP-initiated logins (login CSRF): the browser that started the login must finish it.
      const browser = req.cookies[BROWSER_COOKIE];
      if (cache.row?.browserHash) {
        if (browser ? sha256(browser) !== cache.row.browserHash : config.cookieSecure) return refused(req, reply, tenant.id, 'browser', 'state');
      }

      const result = await withTenant(tenant.id, async (db) =>
        provision(await buildCtx(db, tenant.id, null), { ...cfg, claims: DEFAULT_CLAIMS }, claims, 'saml'),
      );
      if (!result.userId) return refused(req, reply, tenant.id, result.failure!, result.failure!);
      const token = await withSystem(async (c) => {
        await systemAudit(c, tenant.id, result.userId!, 'auth.sso_login', { method: 'saml', protocol: 'saml', idpInitiated: !cache.row });
        return createSession(c, result.userId!, tenant.id, false, 'saml');
      });
      reply.clearCookie(BROWSER_COOKIE, { path: COOKIE_PATH });
      reply.setCookie(SESSION_COOKIE, token, sessionCookie());
      // 303: the browser follows with GET after the POST from the identity provider.
      return reply.redirect(cache.row?.returnTo ?? '/', 303);
    });
  });

  // --- Settings › Anmeldung (admins): read IdP metadata (URL or pasted XML), check the settings.
  app.post(
    '/api/admin/identity/saml/metadata',
    tenantHandler(async (_ctx, req) => {
      const body = z.object({ url: z.string().trim().max(1000).optional(), xml: z.string().max(1_000_000).optional() }).parse(req.body);
      try {
        const md = body.xml?.trim() ? parseIdpMetadata(body.xml) : body.url ? await fetchIdpMetadata(body.url) : null;
        if (!md) throw badRequest(m('saml.metadataMissing'));
        return { ...md, certInfo: md.certs.map((c) => certInfo(c)) };
      } catch (err) {
        if (err instanceof SamlError) throw badRequest(m('saml.metadataInvalid', { reason: err.reason }), { code: 'METADATA_INVALID', reason: err.reason });
        throw err;
      }
    }, admin),
  );

  app.post(
    '/api/admin/identity/saml/check',
    tenantHandler(async (_ctx, req) => checkSettings(samlSettingsSchema.parse(req.body)), admin),
  );
}
