import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { closePool, withSystem, withTenant } from '../src/db/pool.js';
import { acsUrl, certInfo, checkSettings, normalizeCert, parseIdpMetadata, spEntityId } from '../src/lib/saml.js';
import { ATTACKER, IDP_A, IDP_B, IDP_ENTITY, IDP_SSO, buildResponse, idpMetadata, newId, readAuthnRequest, type ResponseOpts } from './fake-saml-idp.js';
import { PASSWORD, client, createTenant, createUser, login, resetDb, testApp } from './helpers.js';

// Company login with SAML 2.0 (R3-26) against a fake identity provider in the test process:
// SP-initiated login, signatures (assertion or response), audience, Recipient, Destination,
// time, InResponseTo (single use, browser binding), replay, XSW, tenant separation,
// just-in-time accounts, groups → roles, domains, local accounts switched off, audit log.

const ENTRA = {
  email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  name: 'http://schemas.microsoft.com/identity/claims/displayname',
  groups: 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups',
};

let app: FastifyInstance;
let acme: string;
let other: string;
let adminCookie: string;
let otherAdminCookie: string;

const MAPPING = [
  { group: 'grp-triage', roles: ['triage'] },
  { group: 'grp-admins', roles: ['admin'] },
];

function samlBody(over: Record<string, unknown> = {}, saml: Record<string, unknown> = {}, domains = ['acme.example']) {
  return {
    oidcEnabled: true,
    protocol: 'saml',
    issuer: '',
    clientId: '',
    allowedDomains: domains,
    groupRoles: MAPPING,
    jitProvisioning: true,
    localLoginDisabled: false,
    claims: { email: '', name: '', department: '', groups: '' },
    saml: {
      metadataUrl: '',
      idpEntityId: IDP_ENTITY,
      ssoUrl: IDP_SSO,
      certs: [IDP_A.cert],
      attributes: { email: '', name: '', department: 'department', groups: '' },
      allowIdpInitiated: false,
      ...saml,
    },
    ...over,
  };
}

const cookieValue = (res: { cookies: { name: string; value: string }[] }, name: string) => res.cookies.find((c) => c.name === name)?.value;
const sessionOf = (res: { cookies: { name: string; value: string }[] }) => `ip_session=${cookieValue(res, 'ip_session')}`;

async function startLogin(tenant = 'acme', weiter = '/ideen') {
  const res = await app.inject({ method: 'GET', url: `/api/auth/saml/${tenant}/login?weiter=${encodeURIComponent(weiter)}` });
  expect(res.statusCode).toBe(302);
  const req = readAuthnRequest(res.headers.location as string);
  return { res, req, browser: cookieValue(res, 'ip_saml')! };
}

function post(tenantPath: string, base64: string, browser?: string) {
  return app.inject({
    method: 'POST',
    url: `/api/auth/saml/${tenantPath}/acs`,
    payload: new URLSearchParams({ SAMLResponse: base64, RelayState: '' }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(browser ? { cookie: `ip_saml=${browser}` } : {}) },
  });
}

/** Full SP-initiated login for acme: start → (IdP) → ACS. */
async function samlLogin(
  attributes: Record<string, string | string[]>,
  opts: Partial<ResponseOpts> & { tenantId?: string; tenantSlug?: string; postTo?: string } = {},
) {
  const tenantId = opts.tenantId ?? acme;
  const { req, browser } = await startLogin(opts.tenantSlug ?? 'acme');
  const r = buildResponse({ audience: spEntityId(tenantId), recipient: acsUrl(tenantId), inResponseTo: req.id, attributes, ...opts });
  const res = await post(opts.postTo ?? tenantId, r.base64, browser);
  return { res, response: r, requestId: req.id, browser };
}

const failures = async () =>
  withSystem(
    async (c) =>
      (
        await c.query<{ reason: string }>(
          `SELECT after->>'reason' AS reason FROM audit_log WHERE action = 'auth.sso_failed' ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
      ).rows[0]?.reason,
  );

beforeAll(async () => {
  await resetDb();
  app = await testApp();
  acme = await createTenant('acme');
  other = await createTenant('other');
  await createUser(acme, 'admin@acme.example', ['submitter', 'admin']);
  await createUser(acme, 'old@acme.example', ['submitter', 'mentor']);
  await createUser(other, 'admin@other.example', ['submitter', 'admin']);
  adminCookie = await login(app, 'acme', 'admin@acme.example');
  otherAdminCookie = await login(app, 'other', 'admin@other.example');
});

afterAll(async () => {
  config.oidcAllowPrivateUrls = false;
  await app.close();
  await closePool();
});

describe('settings › Anmeldung with SAML', () => {
  it('validates and stores the SAML settings; shows the SP values', async () => {
    const admin = client(app, adminCookie);
    expect((await admin.put('/api/admin/identity', samlBody({}, { idpEntityId: '' }))).status).toBe(400);
    expect((await admin.put('/api/admin/identity', samlBody({}, { ssoUrl: 'http://idp.example/sso' }))).status).toBe(400);
    expect((await admin.put('/api/admin/identity', samlBody({}, { certs: [] }))).status).toBe(400);
    const badCert = await admin.put('/api/admin/identity', samlBody({}, { certs: ['not a certificate'] }));
    expect(badCert.status).toBe(400);
    expect(badCert.body.details.code).toBe('CERT_INVALID');
    expect((await admin.put('/api/admin/identity', samlBody({ allowedDomains: [] }))).status).toBe(400);

    // Two certificates for the rollover; the bare base64 body (as in metadata) is accepted too.
    const bare = IDP_B.cert.replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, '');
    const ok = await admin.put('/api/admin/identity', samlBody({}, { certs: [IDP_A.cert, bare] }));
    expect(ok.status).toBe(200);
    expect(ok.body.config.protocol).toBe('saml');
    expect(ok.body.config.saml.certs[1]).toBe(normalizeCert(IDP_B.cert));
    expect(ok.body.samlSp).toEqual({ entityId: spEntityId(acme), acsUrl: acsUrl(acme), metadataUrl: spEntityId(acme) });
    expect(ok.body.samlSp.acsUrl).toMatch(new RegExp(`/api/auth/saml/${acme}/acs$`));
    expect(ok.body.samlCerts).toHaveLength(2);
    expect(ok.body.samlCerts[0].daysLeft).toBeGreaterThan(30);
  });

  it('refuses other roles and keeps the other tenant unchanged', async () => {
    await createUser(acme, 'triage@acme.example', ['submitter', 'triage']);
    const triage = client(app, await login(app, 'acme', 'triage@acme.example'));
    expect((await triage.post('/api/admin/identity/saml/check', samlBody().saml)).status).toBe(403);
    const view = await client(app, otherAdminCookie).get('/api/admin/identity');
    expect(view.body.config.protocol).toBe('oidc');
    expect(view.body.config.saml.idpEntityId).toBe('');
    expect(view.body.samlSp.entityId).toBe(spEntityId(other));
  });

  it('serves the SP metadata as XML', async () => {
    for (const p of [acme, 'acme']) {
      const res = await app.inject({ method: 'GET', url: `/api/auth/saml/${p}/metadata?download` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/samlmetadata\+xml/);
      expect(res.headers['content-disposition']).toMatch(/attachment/);
      expect(res.body).toContain(`entityID="${spEntityId(acme)}"`);
      expect(res.body).toContain(`Location="${acsUrl(acme)}"`);
      expect(res.body).toContain('urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST');
    }
    expect((await app.inject({ method: 'GET', url: '/api/auth/saml/nobody/metadata' })).statusCode).toBe(404);
  });

  it('reads IdP metadata from pasted XML and from a URL; refuses DTDs (XXE)', async () => {
    const admin = client(app, adminCookie);
    const pasted = await admin.post('/api/admin/identity/saml/metadata', { xml: idpMetadata([IDP_A.cert, IDP_B.cert]) });
    expect(pasted.status).toBe(200);
    expect(pasted.body).toMatchObject({ idpEntityId: IDP_ENTITY, ssoUrl: IDP_SSO });
    expect(pasted.body.certs).toEqual([normalizeCert(IDP_A.cert), normalizeCert(IDP_B.cert)]);

    const xxe = await admin.post('/api/admin/identity/saml/metadata', {
      xml: idpMetadata([IDP_A.cert], '<!DOCTYPE md [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>'),
    });
    expect(xxe.status).toBe(400);
    expect(xxe.body.details.reason).toBe('dtd');
    expect((await admin.post('/api/admin/identity/saml/metadata', { xml: '<md:EntityDescriptor' })).status).toBe(400);

    // URL import passes the SSRF guard: private addresses only with OIDC_ALLOW_PRIVATE_URLS.
    const server: Server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/xml');
      res.end(idpMetadata([IDP_A.cert]));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/metadata`;
    try {
      const refused = await admin.post('/api/admin/identity/saml/metadata', { url });
      expect(refused.status).toBe(400);
      expect(refused.body.details.reason).toBe('metadata_url');
      config.oidcAllowPrivateUrls = true;
      const fetched = await admin.post('/api/admin/identity/saml/metadata', { url });
      expect(fetched.status).toBe(200);
      expect(fetched.body.idpEntityId).toBe(IDP_ENTITY);
      // "Verbindung prüfen" compares with the metadata: a new certificate there is a rollover hint.
      const check = await admin.post('/api/admin/identity/saml/check', samlBody({}, { metadataUrl: url, certs: [IDP_B.cert] }).saml);
      expect(check.body.ok).toBe(true);
      expect(check.body.warnings).toContain('metadata_new_cert');
    } finally {
      config.oidcAllowPrivateUrls = false;
      server.close();
    }
  });

  it('checks the settings and warns about certificates expiring within 30 days', async () => {
    const s = samlBody().saml;
    const validTo = new Date(certInfo(normalizeCert(IDP_A.cert)).validTo).getTime();
    const fine = await checkSettings(s as never);
    expect(fine).toMatchObject({ ok: true, warnings: [] });
    const soon = await checkSettings(s as never, validTo - 10 * 86_400_000);
    expect(soon.ok).toBe(true);
    expect(soon.warnings).toContain('cert_expiring');
    expect(soon.certs[0].daysLeft).toBe(10);
    const expired = await checkSettings(s as never, validTo + 86_400_000);
    expect(expired.ok).toBe(false);
    expect(expired.problems).toEqual(expect.arrayContaining(['cert_expired', 'cert_all_expired']));
    const incomplete = await client(app, adminCookie).post('/api/admin/identity/saml/check', { ...s, idpEntityId: '', ssoUrl: 'ftp://x', certs: ['garbage'] });
    expect(incomplete.body.problems).toEqual(expect.arrayContaining(['entity_missing', 'sso_invalid', 'cert_invalid']));
  });

  it('tells the login page which protocol to use; OIDC start is closed for a SAML tenant', async () => {
    const sso = JSON.parse((await app.inject({ method: 'GET', url: '/api/auth/sso?email=x@acme.example' })).body);
    expect(sso).toMatchObject({ available: true, tenant: 'acme', protocol: 'saml' });
    expect((await app.inject({ method: 'GET', url: '/api/auth/oidc/start?tenant=acme' })).headers.location).toBe('/login?sso=not_configured');
    expect((await app.inject({ method: 'GET', url: '/api/auth/saml/other/login' })).headers.location).toBe('/login?sso=not_configured');
  });
});

describe('SAML login', () => {
  it('sends an AuthnRequest with the HTTP-Redirect binding and stores its ID', async () => {
    const { res, req, browser } = await startLogin();
    expect(req.url.origin + req.url.pathname).toBe(IDP_SSO);
    expect(req.xml).toContain(`AssertionConsumerServiceURL="${acsUrl(acme)}"`);
    expect(req.xml).toContain(`Destination="${IDP_SSO}"`);
    expect(req.xml).toContain(spEntityId(acme));
    expect(req.xml).not.toContain('RequestedAuthnContext');
    const cookie = res.cookies.find((c) => c.name === 'ip_saml')!;
    expect(cookie.httpOnly).toBe(true);
    expect(browser.length).toBeGreaterThanOrEqual(40);
    const row = await withSystem(
      async (c) =>
        (await c.query<{ tenant_id: string; return_to: string }>('SELECT tenant_id, return_to FROM saml_requests WHERE request_id = $1', [req.id])).rows[0],
    );
    expect(row).toEqual({ tenant_id: acme, return_to: '/ideen' });
  });

  it('creates the account just in time with name, department and roles from the groups; no local MFA', async () => {
    await withSystem((c) => c.query(`UPDATE tenants SET settings = settings || '{"requireMfaForAdmins": true}' WHERE id = $1`, [acme]));
    const { res } = await samlLogin(
      {
        [ENTRA.email]: 'Anna@acme.example',
        [ENTRA.name]: 'Anna Berg',
        department: 'Einkauf',
        [ENTRA.groups]: ['grp-triage', 'grp-admins', 'unmapped'],
      },
      { nameId: 'entra-object-anna' },
    );
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/ideen');
    const anna = client(app, sessionOf(res));
    const me = await anna.get('/api/me');
    expect(me.body.user).toMatchObject({ email: 'anna@acme.example', displayName: 'Anna Berg', orgUnit: 'Einkauf' });
    expect(me.body.user.roles.sort()).toEqual(['admin', 'submitter', 'triage']);
    expect(me.body.authMethod).toBe('saml');
    expect(me.body.mfaSetupRequired).toBe(false);
    const audit = await withSystem(
      async (c) =>
        (
          await c.query<{ action: string; after: Record<string, unknown> }>(
            `SELECT action, after FROM audit_log WHERE tenant_id = $1 AND action IN ('user.jit_create', 'auth.sso_login')`,
            [acme],
          )
        ).rows,
    );
    expect(audit.map((a) => a.action).sort()).toEqual(['auth.sso_login', 'user.jit_create']);
    expect(audit.find((a) => a.action === 'auth.sso_login')!.after).toMatchObject({ protocol: 'saml' });
    expect(audit.find((a) => a.action === 'user.jit_create')!.after).toMatchObject({ source: 'saml' });
    await withSystem((c) => c.query(`UPDATE tenants SET settings = settings || '{"requireMfaForAdmins": false}' WHERE id = $1`, [acme]));
  });

  it('finds the account by NameID on the next login and follows group changes (Okta attribute names)', async () => {
    const { res } = await samlLogin(
      { email: 'anna@acme.example', firstName: 'Anna', lastName: 'Berg-Meier', groups: 'unmapped' },
      { nameId: 'entra-object-anna' },
    );
    const me = await client(app, sessionOf(res)).get('/api/me');
    expect(me.body.user).toMatchObject({ displayName: 'Anna Berg-Meier', roles: ['submitter'] });
  });

  it('links an existing local account by address; transient NameID is not stored', async () => {
    const { res } = await samlLogin(
      { [ENTRA.email]: 'old@acme.example', [ENTRA.groups]: 'grp-triage' },
      { nameId: 'tmp-123', nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient' },
    );
    expect(res.statusCode).toBe(303);
    const row = await withSystem(
      async (c) =>
        (
          await c.query<{ oidc_subject: string | null; idp_managed: boolean; roles: string[] }>(
            `SELECT oidc_subject, idp_managed, roles FROM users WHERE email = 'old@acme.example'`,
          )
        ).rows[0],
    );
    expect(row.oidc_subject).toBeNull();
    expect(row.idp_managed).toBe(true);
    expect(row.roles.sort()).toEqual(['submitter', 'triage']);
  });

  it('uses the NameID as address when no e-mail attribute is sent', async () => {
    const { res } = await samlLogin({}, { nameId: 'nameid.only@acme.example' });
    expect(res.statusCode).toBe(303);
    expect((await client(app, sessionOf(res)).get('/api/me')).body.user.email).toBe('nameid.only@acme.example');
  });

  it('accepts a signed response with an unsigned assertion and the second (rollover) certificate', async () => {
    const signedResponse = await samlLogin({ email: 'resp@acme.example' }, { nameId: 'resp', signAssertion: false, signResponse: true });
    expect(signedResponse.res.statusCode).toBe(303);
    const rollover = await samlLogin({ email: 'roll@acme.example' }, { nameId: 'roll', signer: IDP_B });
    expect(rollover.res.statusCode).toBe(303);
  });

  const refusedCases: [string, Partial<ResponseOpts>, string][] = [
    ['wrong audience', { audience: 'https://other-sp.example/metadata' }, 'audience'],
    ['expired assertion', { notBefore: -3600, notOnOrAfter: -600 }, 'subject_confirmation'],
    ['assertion not yet valid', { notBefore: 1800, notOnOrAfter: 3600 }, 'time'],
    ['unsigned assertion', { signAssertion: false }, 'signature'],
    ['signed by an unknown key', { signer: ATTACKER }, 'signature'],
    ['wrong recipient', { recipient: 'https://evil.example/acs' }, 'recipient'],
    ['wrong destination', { destination: 'https://evil.example/acs' }, 'destination'],
    ['wrong issuer', { issuer: 'https://evil.example/idp' }, 'issuer'],
    ['tampered assertion', { after: (x) => x.replace('victim@acme.example', 'admin@acme.example') }, 'signature'],
    ['comment injection in a signed value', { after: (x) => x.replace('victim@acme.example', 'victim@acme.example<!---->.evil') }, 'signature'],
    [
      'two assertions (XSW)',
      {
        after: (x) => {
          const signed = /<saml:Assertion[\s\S]*<\/saml:Assertion>/.exec(x)![0];
          const evil = signed
            .replace(/<ds:Signature[\s\S]*<\/ds:Signature>/, '')
            .replace(/ID="[^"]+"/, `ID="${newId()}"`)
            .replace('victim@acme.example', 'admin@acme.example');
          return x.replace(signed, evil + signed);
        },
      },
      'signature',
    ],
    [
      'signed assertion wrapped inside an evil one (XSW)',
      {
        after: (x) => {
          const signed = /<saml:Assertion[\s\S]*<\/saml:Assertion>/.exec(x)![0];
          const evil = signed
            .replace(/<ds:Signature[\s\S]*<\/ds:Signature>/, '')
            .replace(/ID="[^"]+"/, `ID="${newId()}"`)
            .replace('victim@acme.example', 'admin@acme.example');
          const wrapped = evil.replace('</saml:Subject>', `</saml:Subject><saml:Advice>${signed}</saml:Advice>`);
          return x.replace(signed, wrapped);
        },
      },
      'signature',
    ],
    ['DTD in the response', { after: (x) => `<!DOCTYPE r [<!ENTITY e "x">]>${x}` }, 'dtd'],
  ];

  it.each(refusedCases)('refuses: %s', async (_name, opts, reason) => {
    const { res } = await samlLogin({ email: 'victim@acme.example' }, { nameId: `victim-${newId()}`, ...opts });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login?sso=provider');
    expect(cookieValue(res, 'ip_session')).toBeUndefined();
    expect(await failures()).toBe(reason);
    const victims = await withSystem(async (c) => (await c.query(`SELECT 1 FROM users WHERE email = 'victim@acme.example'`)).rowCount);
    expect(victims).toBe(0);
  });

  it('refuses a replayed response and a reused InResponseTo', async () => {
    const first = await samlLogin({ email: 'replay@acme.example' }, { nameId: 'replay' });
    expect(first.res.statusCode).toBe(303);
    const again = await post(acme, first.response.base64, first.browser);
    expect(again.headers.location).toBe('/login?sso=provider');
    expect(await failures()).toBe('in_response_to');
    // A fresh assertion for the same (already used) request ID is refused as well.
    const fresh = buildResponse({
      audience: spEntityId(acme),
      recipient: acsUrl(acme),
      inResponseTo: first.requestId,
      attributes: { email: 'replay@acme.example' },
    });
    expect((await post(acme, fresh.base64, first.browser)).headers.location).toBe('/login?sso=provider');
    // An unknown request ID is refused.
    const unknown = buildResponse({ audience: spEntityId(acme), recipient: acsUrl(acme), inResponseTo: newId(), attributes: { email: 'replay@acme.example' } });
    expect((await post(acme, unknown.base64)).headers.location).toBe('/login?sso=provider');
    const rows = await withSystem(async (c) => (await c.query('SELECT 1 FROM saml_requests WHERE request_id = $1', [first.requestId])).rowCount);
    expect(rows).toBe(0);
  });

  it('binds the login to the browser that started it', async () => {
    const { req } = await startLogin();
    const r = buildResponse({ audience: spEntityId(acme), recipient: acsUrl(acme), inResponseTo: req.id, attributes: { email: 'bound@acme.example' } });
    const res = await post(acme, r.base64, 'someone-elses-browser-value-0123456789abcdef');
    expect(res.headers.location).toBe('/login?sso=state');
    expect(await failures()).toBe('browser');
  });

  it('refuses IdP-initiated logins unless switched on; replay protection by assertion ID', async () => {
    const unsolicited = buildResponse({ audience: spEntityId(acme), recipient: acsUrl(acme), attributes: { email: 'idp@acme.example' }, nameId: 'idp-init' });
    expect((await post(acme, unsolicited.base64)).headers.location).toBe('/login?sso=provider');
    expect(await failures()).toBe('in_response_to');

    const admin = client(app, adminCookie);
    expect((await admin.put('/api/admin/identity', samlBody({}, { allowIdpInitiated: true }))).status).toBe(200);
    try {
      const r = buildResponse({ audience: spEntityId(acme), recipient: acsUrl(acme), attributes: { email: 'idp@acme.example' }, nameId: 'idp-init' });
      const ok = await post(acme, r.base64);
      expect(ok.statusCode).toBe(303);
      expect(ok.headers.location).toBe('/');
      const replay = await post(acme, r.base64);
      expect(replay.headers.location).toBe('/login?sso=provider');
      expect(await failures()).toBe('replay');
    } finally {
      expect((await admin.put('/api/admin/identity', samlBody())).status).toBe(200);
    }
  });

  it('accepts only allowed domains, active accounts and honours JIT off', async () => {
    expect((await samlLogin({ email: 'eve@evil.example' }, { nameId: 'eve' })).res.headers.location).toBe('/login?sso=domain');
    expect(await failures()).toBe('domain');
    expect(await withSystem(async (c) => (await c.query(`SELECT 1 FROM users WHERE email = 'eve@evil.example'`)).rowCount)).toBe(0);

    await withSystem((c) => c.query(`UPDATE users SET active = false WHERE email = 'old@acme.example'`));
    expect((await samlLogin({ email: 'old@acme.example' }, { nameId: 'old' })).res.headers.location).toBe('/login?sso=inactive');
    await withSystem((c) => c.query(`UPDATE users SET active = true WHERE email = 'old@acme.example'`));

    const admin = client(app, adminCookie);
    expect((await admin.put('/api/admin/identity', samlBody({ jitProvisioning: false }))).status).toBe(200);
    expect((await samlLogin({ email: 'new@acme.example' }, { nameId: 'new' })).res.headers.location).toBe('/login?sso=no_account');
    expect((await admin.put('/api/admin/identity', samlBody())).status).toBe(200);
  });
});

describe('tenant separation', () => {
  beforeAll(async () => {
    // The other tenant uses the same identity provider (same certificate) with its own domain.
    const res = await client(app, otherAdminCookie).put('/api/admin/identity', samlBody({ groupRoles: [] }, {}, ['other.example']));
    expect(res.status).toBe(200);
  });

  it('refuses a response for one tenant at the ACS of another', async () => {
    const { req, browser } = await startLogin('acme');
    // Built for acme (audience, recipient), posted to the ACS of the other tenant.
    const r = buildResponse({
      audience: spEntityId(acme),
      recipient: acsUrl(acme),
      inResponseTo: req.id,
      attributes: { email: 'cross@other.example' },
      nameId: 'cross',
    });
    const res = await post(other, r.base64, browser);
    expect(res.headers.location).toBe('/login?sso=provider');
    // The request ID of acme is unknown to the other tenant; also with matching audience it fails.
    const r2 = buildResponse({
      audience: spEntityId(other),
      recipient: acsUrl(other),
      inResponseTo: req.id,
      attributes: { email: 'cross@other.example' },
      nameId: 'cross',
    });
    expect((await post(other, r2.base64, browser)).headers.location).toBe('/login?sso=provider');
    expect(await failures()).toBe('in_response_to');
    expect(await withSystem(async (c) => (await c.query(`SELECT 1 FROM users WHERE email = 'cross@other.example'`)).rowCount)).toBe(0);
  });

  it('creates accounts only in the tenant of the login', async () => {
    const { res } = await samlLogin({ email: 'iso@other.example' }, { tenantId: other, tenantSlug: 'other', nameId: 'iso' });
    expect(res.statusCode).toBe(303);
    const rows = await withSystem(async (c) => (await c.query<{ tenant_id: string }>(`SELECT tenant_id FROM users WHERE email = 'iso@other.example'`)).rows);
    expect(rows.map((r) => r.tenant_id)).toEqual([other]);
    // The same assertion ID is tracked per tenant.
    const facts = await withSystem(async (c) =>
      (await c.query<{ tenant_id: string }>('SELECT DISTINCT tenant_id FROM saml_used_assertions')).rows.map((r) => r.tenant_id),
    );
    expect(facts.sort()).toEqual([acme, other].sort());
  });

  it('keeps the request and assertion tables away from the app role', async () => {
    await expect(withTenant(acme, (db) => db.query('SELECT * FROM saml_requests'))).rejects.toThrow(/permission denied/);
    await expect(withTenant(acme, (db) => db.query('SELECT * FROM saml_used_assertions'))).rejects.toThrow(/permission denied/);
  });
});

describe('local accounts switched off', () => {
  it('needs a SAML session of the admin before passwords stop working', async () => {
    const admin = client(app, adminCookie);
    expect((await admin.put('/api/admin/identity', samlBody({ localLoginDisabled: true }))).status).toBe(400);

    const { res } = await samlLogin({ email: 'anna@acme.example', groups: ['grp-admins'] }, { nameId: 'entra-object-anna' });
    const anna = client(app, sessionOf(res));
    expect((await anna.put('/api/admin/identity', samlBody({ localLoginDisabled: true }))).status).toBe(200);

    const pw = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenant: 'acme', email: 'admin@acme.example', password: PASSWORD } });
    expect(pw.statusCode).toBe(403);
    expect(JSON.parse(pw.body)).toMatchObject({ code: 'SSO_REQUIRED' });
    expect(JSON.parse((await app.inject({ method: 'GET', url: '/api/auth/sso?tenant=acme' })).body)).toMatchObject({ localLogin: false, protocol: 'saml' });
    // The SAML login keeps working; the other tenant is not affected.
    expect((await samlLogin({ email: 'anna@acme.example' }, { nameId: 'entra-object-anna' })).res.statusCode).toBe(303);
    expect(
      (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenant: 'other', email: 'admin@other.example', password: PASSWORD } })).statusCode,
    ).toBe(200);

    // Switching back to OIDC needs an OIDC session before local accounts can stay off.
    const toOidc = await anna.put('/api/admin/identity', {
      ...samlBody({ localLoginDisabled: true }),
      protocol: 'oidc',
      issuer: 'https://login.example/v2.0',
      clientId: 'x',
      clientSecret: 'y',
    });
    expect(toOidc.status).toBe(400);
  });
});

describe('helpers', () => {
  it('parses metadata with the redirect binding and both signing certificates', () => {
    const md = parseIdpMetadata(idpMetadata([IDP_A.cert, IDP_B.cert]));
    expect(md.ssoUrl).toBe(IDP_SSO);
    expect(md.certs).toHaveLength(2);
    expect(() => parseIdpMetadata('<x/>')).toThrow();
  });
});
