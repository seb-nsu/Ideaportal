import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { closePool, withSystem } from '../src/db/pool.js';
import { setLocalLogin } from '../src/db/identity-cli.js';
import { clearOidcCache, verifyIdToken } from '../src/lib/oidc.js';
import { rolesFromGroups } from '../src/services/identity.js';
import { safeReturnPath } from '../src/routes/identity.js';
import { otherKey, startFakeIdp, type FakeIdp, type TokenOpts } from './fake-idp.js';
import { PASSWORD, client, createTenant, createUser, login, resetDb, testApp } from './helpers.js';

// Company login with OpenID Connect (R3-26) against an in-process fake identity provider:
// discovery, PKCE, state, nonce, ID token signature and claims, just-in-time accounts,
// groups → roles, local accounts switchable, tenant separation.

let app: FastifyInstance;
let idp: FakeIdp;
let acme: string;
let other: string;
let adminCookie: string;

const MAPPING = [
  { group: 'grp-triage', roles: ['triage'] },
  { group: 'grp-admins', roles: ['admin'] },
];

function identityBody(over: Record<string, unknown> = {}) {
  return {
    oidcEnabled: true,
    issuer: idp.issuer,
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
    allowedDomains: ['acme.example'],
    groupRoles: MAPPING,
    jitProvisioning: true,
    localLoginDisabled: false,
    claims: { email: '', name: '', department: '', groups: '' },
    ...over,
  };
}

const cookieValue = (res: { cookies: { name: string; value: string }[] }, name: string) => res.cookies.find((c) => c.name === name)?.value;

/** Runs the whole browser flow: start → (provider) → callback. Returns the final response. */
async function ssoLogin(claims: Record<string, unknown>, opts: { tenant?: string; tokenOpts?: TokenOpts; tamper?: (url: URL) => void; weiter?: string } = {}) {
  const start = await app.inject({ method: 'GET', url: `/api/auth/oidc/start?tenant=${opts.tenant ?? 'acme'}&weiter=${encodeURIComponent(opts.weiter ?? '/ideen')}` });
  expect(start.statusCode).toBe(302);
  const authorize = new URL(start.headers.location as string);
  const browser = cookieValue(start, 'ip_oidc')!;
  const code = idp.issueCode(authorize.toString(), claims, opts.tokenOpts);
  const cb = new URL('http://x/api/auth/oidc/callback');
  cb.searchParams.set('code', code);
  cb.searchParams.set('state', authorize.searchParams.get('state')!);
  opts.tamper?.(cb);
  const res = await app.inject({ method: 'GET', url: cb.pathname + cb.search, headers: { cookie: `ip_oidc=${browser}` } });
  return { start, authorize, res, browser, state: authorize.searchParams.get('state')! };
}

const sessionOf = (res: { cookies: { name: string; value: string }[] }) => `ip_session=${cookieValue(res, 'ip_session')}`;

beforeAll(async () => {
  config.oidcAllowPrivateUrls = true;
  clearOidcCache();
  await resetDb();
  app = await testApp();
  idp = await startFakeIdp();
  acme = await createTenant('acme');
  other = await createTenant('other');
  await createUser(acme, 'admin@acme.example', ['submitter', 'admin']);
  await createUser(acme, 'old@acme.example', ['submitter', 'mentor']);
  await createUser(other, 'admin@other.example', ['submitter', 'admin']);
  adminCookie = await login(app, 'acme', 'admin@acme.example');
});

afterAll(async () => {
  config.oidcAllowPrivateUrls = false;
  await idp.close();
  await app.close();
  await closePool();
});

describe('settings › Anmeldung', () => {
  it('validates the configuration and stores the client secret encrypted', async () => {
    const admin = client(app, adminCookie);
    expect((await admin.put('/api/admin/identity', identityBody({ allowedDomains: [] }))).status).toBe(400);
    expect((await admin.put('/api/admin/identity', identityBody({ allowedDomains: ['not a domain'] }))).status).toBe(400);
    expect((await admin.put('/api/admin/identity', identityBody({ clientSecret: undefined }))).status).toBe(400);
    const bad = await admin.put('/api/admin/identity', identityBody({ issuer: 'http://127.0.0.1:1/nothing' }));
    expect(bad.status).toBe(400);
    expect(bad.body.details.code).toBe('DISCOVERY_FAILED');

    const ok = await admin.put('/api/admin/identity', identityBody());
    expect(ok.status).toBe(200);
    expect(ok.body.secretSet).toBe(true);
    expect(ok.body.redirectUri).toMatch(/\/api\/auth\/oidc\/callback$/);
    expect(JSON.stringify(ok.body)).not.toContain(idp.clientSecret);
    const stored = await withSystem(async (c) => (await c.query<{ ciphertext: string }>(`SELECT ciphertext FROM tenant_secrets WHERE name = 'oidc_client_secret'`)).rows[0]);
    expect(stored.ciphertext).toMatch(/^v2\./);
    expect(stored.ciphertext).not.toContain(idp.clientSecret);

    // Saving again without a secret keeps the stored one.
    const again = await admin.put('/api/admin/identity', identityBody({ clientSecret: undefined }));
    expect(again.status).toBe(200);
    expect(again.body.secretSet).toBe(true);
  });

  it('refuses other roles and keeps tenants apart', async () => {
    await createUser(acme, 'triage@acme.example', ['submitter', 'triage']);
    const triage = client(app, await login(app, 'acme', 'triage@acme.example'));
    expect((await triage.get('/api/admin/identity')).status).toBe(403);

    const otherAdmin = client(app, await login(app, 'other', 'admin@other.example'));
    const view = await otherAdmin.get('/api/admin/identity');
    expect(view.body.config.oidcEnabled).toBe(false);
    expect(view.body.config.issuer).toBe('');
    // A domain belongs to one workspace only.
    const clash = await otherAdmin.put('/api/admin/identity', identityBody({ allowedDomains: ['acme.example'], clientSecret: 'x' }));
    expect(clash.status).toBe(409);
  });

  it('tells the login page which workspace has a company login', async () => {
    const byMail = await app.inject({ method: 'GET', url: '/api/auth/sso?email=someone@acme.example' });
    expect(JSON.parse(byMail.body)).toMatchObject({ available: true, tenant: 'acme', localLogin: true });
    const bySlug = await app.inject({ method: 'GET', url: '/api/auth/sso?tenant=acme' });
    expect(JSON.parse(bySlug.body).available).toBe(true);
    expect(JSON.parse((await app.inject({ method: 'GET', url: '/api/auth/sso?email=x@other.example' })).body).available).toBe(false);
  });
});

describe('OIDC login', () => {
  it('starts the code flow with PKCE (S256), state and nonce', async () => {
    const start = await app.inject({ method: 'GET', url: '/api/auth/oidc/start?tenant=acme' });
    expect(start.statusCode).toBe(302);
    const url = new URL(start.headers.location as string);
    expect(url.toString().startsWith(`${idp.issuer}/authorize`)).toBe(true);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.get('state')).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.get('nonce')).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    const cookie = start.cookies.find((c) => c.name === 'ip_oidc')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
    // Only the hash of the state is stored.
    const rows = await withSystem(async (c) => (await c.query<{ state_hash: string }>('SELECT state_hash FROM oidc_login_states')).rows);
    expect(rows.some((r) => r.state_hash === url.searchParams.get('state'))).toBe(false);
  });

  it('creates the account just in time with name, department and roles from the groups; no local MFA', async () => {
    // Admins normally need a second factor; with the company login the provider is responsible.
    await withSystem((c) => c.query(`UPDATE tenants SET settings = settings || '{"requireMfaForAdmins": true}' WHERE id = $1`, [acme]));
    const { res } = await ssoLogin({ sub: 'sub-anna', email: 'Anna@acme.example', name: 'Anna Berg', department: 'Einkauf', groups: ['grp-triage', 'grp-admins', 'unmapped'] });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/ideen');
    const anna = client(app, sessionOf(res));
    const me = await anna.get('/api/me');
    expect(me.body.user).toMatchObject({ email: 'anna@acme.example', displayName: 'Anna Berg', orgUnit: 'Einkauf' });
    expect(me.body.user.roles.sort()).toEqual(['admin', 'submitter', 'triage']);
    expect(me.body.authMethod).toBe('oidc');
    expect(me.body.mfaSetupRequired).toBe(false);
    expect((await anna.get('/api/admin/identity')).status).toBe(200);
    const audit = await withSystem(async (c) => (await c.query<{ action: string }>(`SELECT action FROM audit_log WHERE tenant_id = $1 AND action IN ('user.jit_create', 'auth.sso_login')`, [acme])).rows);
    expect(audit.map((a) => a.action).sort()).toEqual(['auth.sso_login', 'user.jit_create']);
    await withSystem((c) => c.query(`UPDATE tenants SET settings = settings || '{"requireMfaForAdmins": false}' WHERE id = $1`, [acme]));
  });

  it('updates the account on the next login and follows group changes', async () => {
    const { res } = await ssoLogin({ sub: 'sub-anna', email: 'anna@acme.example', name: 'Anna Berg-Meier', department: 'Strategie', groups: [] });
    const me = await client(app, sessionOf(res)).get('/api/me');
    expect(me.body.user).toMatchObject({ displayName: 'Anna Berg-Meier', orgUnit: 'Strategie', roles: ['submitter'] });
  });

  it('links an existing local account by address', async () => {
    const { res } = await ssoLogin({ sub: 'sub-old', email: 'old@acme.example', name: 'Old Timer', groups: ['grp-triage'] });
    expect(res.statusCode).toBe(302);
    const row = await withSystem(async (c) => (await c.query<{ oidc_subject: string; idp_managed: boolean; roles: string[] }>(
      `SELECT oidc_subject, idp_managed, roles FROM users WHERE email = 'old@acme.example'`)).rows[0]);
    expect(row).toMatchObject({ oidc_subject: 'sub-old', idp_managed: true });
    expect(row.roles.sort()).toEqual(['submitter', 'triage']);
  });

  it('rejects wrong, missing or replayed state', async () => {
    const wrong = await ssoLogin({ sub: 's1', email: 'a@acme.example' }, { tamper: (u) => u.searchParams.set('state', 'forged') });
    expect(wrong.res.headers.location).toBe('/login?sso=state');
    const noCookie = await ssoLogin({ sub: 's1', email: 'a@acme.example' });
    expect(noCookie.res.statusCode).toBe(302);
    // Replaying the same state (already used) fails.
    const replay = await app.inject({ method: 'GET', url: `/api/auth/oidc/callback?code=x&state=${noCookie.state}`, headers: { cookie: `ip_oidc=${noCookie.browser}` } });
    expect(replay.headers.location).toBe('/login?sso=state');
    // Another browser (other binding cookie) cannot finish a login it did not start.
    const start = await app.inject({ method: 'GET', url: '/api/auth/oidc/start?tenant=acme' });
    const state = new URL(start.headers.location as string).searchParams.get('state');
    const foreign = await app.inject({ method: 'GET', url: `/api/auth/oidc/callback?code=x&state=${state}`, headers: { cookie: 'ip_oidc=someone-elses-browser-value-0123456789abcdef' } });
    expect(foreign.headers.location).toBe('/login?sso=state');
  });

  it('rejects ID tokens with a bad signature, algorithm, audience, issuer, nonce or expiry', async () => {
    const now = Math.floor(Date.now() / 1000);
    const cases: [Record<string, unknown>, TokenOpts | undefined][] = [
      [{ sub: 'x', email: 'x@acme.example' }, { key: otherKey() }],
      [{ sub: 'x', email: 'x@acme.example' }, { alg: 'none' }],
      [{ sub: 'x', email: 'x@acme.example' }, { kid: 'unknown' }],
      [{ sub: 'x', email: 'x@acme.example', aud: 'someone-else' }, undefined],
      [{ sub: 'x', email: 'x@acme.example', aud: ['portal-client', 'other'], azp: 'other' }, undefined],
      [{ sub: 'x', email: 'x@acme.example', iss: 'https://evil.example/v2.0' }, undefined],
      [{ sub: 'x', email: 'x@acme.example', nonce: 'wrong' }, undefined],
      [{ sub: 'x', email: 'x@acme.example', exp: now - 3600 }, undefined],
      [{ sub: 'x', email: 'x@acme.example', iat: now + 3600 }, undefined],
    ];
    for (const [claims, opts] of cases) {
      const { res } = await ssoLogin(claims, { tokenOpts: opts });
      expect(res.headers.location, JSON.stringify(claims)).toBe('/login?sso=provider');
      expect(cookieValue(res, 'ip_session')).toBeUndefined();
    }
    const created = await withSystem(async (c) => (await c.query(`SELECT 1 FROM users WHERE email = 'x@acme.example'`)).rowCount);
    expect(created).toBe(0);
  });

  it('rejects a wrong PKCE verifier at the token endpoint', async () => {
    const start = await app.inject({ method: 'GET', url: '/api/auth/oidc/start?tenant=acme' });
    const authorize = new URL(start.headers.location as string);
    authorize.searchParams.set('code_challenge', 'not-the-real-challenge');
    const code = idp.issueCode(authorize.toString(), { sub: 'p', email: 'p@acme.example' });
    const res = await app.inject({ method: 'GET', url: `/api/auth/oidc/callback?code=${code}&state=${authorize.searchParams.get('state')}`, headers: { cookie: `ip_oidc=${cookieValue(start, 'ip_oidc')}` } });
    expect(res.headers.location).toBe('/login?sso=provider');
  });

  it('accepts only allowed domains, verified addresses and active accounts', async () => {
    expect((await ssoLogin({ sub: 'd1', email: 'eve@evil.example' })).res.headers.location).toBe('/login?sso=domain');
    expect((await ssoLogin({ sub: 'd2', email: 'eve@acme.example', email_verified: false })).res.headers.location).toBe('/login?sso=domain');
    await withSystem((c) => c.query(`UPDATE users SET active = false WHERE email = 'old@acme.example'`));
    expect((await ssoLogin({ sub: 'sub-old', email: 'old@acme.example' })).res.headers.location).toBe('/login?sso=inactive');
    await withSystem((c) => c.query(`UPDATE users SET active = true WHERE email = 'old@acme.example'`));
  });

  it('falls back to preferred_username (Entra ID without the email claim) and honours JIT off', async () => {
    const { res } = await ssoLogin({ sub: 'sub-upn', preferred_username: 'upn.user@acme.example', given_name: 'Upn', family_name: 'User' });
    const me = await client(app, sessionOf(res)).get('/api/me');
    expect(me.body.user).toMatchObject({ email: 'upn.user@acme.example', displayName: 'Upn User' });

    const admin = client(app, adminCookie);
    expect((await admin.put('/api/admin/identity', identityBody({ clientSecret: undefined, jitProvisioning: false }))).status).toBe(200);
    expect((await ssoLogin({ sub: 'sub-new', email: 'new@acme.example' })).res.headers.location).toBe('/login?sso=no_account');
    expect((await admin.put('/api/admin/identity', identityBody({ clientSecret: undefined }))).status).toBe(200);
  });

  it('only redirects to paths inside the app', () => {
    expect(safeReturnPath('/ideen/1')).toBe('/ideen/1');
    expect(safeReturnPath('//evil.example')).toBe('/');
    expect(safeReturnPath('https://evil.example')).toBe('/');
    expect(safeReturnPath('/\\evil.example')).toBe('/');
    expect(safeReturnPath('/api/admin/export')).toBe('/');
  });

  it('creates accounts only in the tenant of the login', async () => {
    const { res } = await ssoLogin({ sub: 'sub-iso', email: 'iso@acme.example' });
    expect(res.statusCode).toBe(302);
    const rows = await withSystem(async (c) => (await c.query<{ tenant_id: string }>(`SELECT tenant_id FROM users WHERE email = 'iso@acme.example'`)).rows);
    expect(rows.map((r) => r.tenant_id)).toEqual([acme]);
    // The other tenant has no company login: start fails cleanly.
    const start = await app.inject({ method: 'GET', url: '/api/auth/oidc/start?tenant=other' });
    expect(start.headers.location).toBe('/login?sso=not_configured');
  });
});

describe('local accounts switched off', () => {
  it('needs a company-login session of the admin before passwords stop working', async () => {
    const admin = client(app, adminCookie);
    const refused = await admin.put('/api/admin/identity', identityBody({ clientSecret: undefined, localLoginDisabled: true }));
    expect(refused.status).toBe(400);

    // Anna is admin through the group mapping and signs in with the company login.
    const { res } = await ssoLogin({ sub: 'sub-anna', email: 'anna@acme.example', groups: ['grp-admins'] });
    const anna = client(app, sessionOf(res));
    expect((await anna.put('/api/admin/identity', identityBody({ clientSecret: undefined, localLoginDisabled: true }))).status).toBe(200);

    const pw = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenant: 'acme', email: 'admin@acme.example', password: PASSWORD } });
    expect(pw.statusCode).toBe(403);
    expect(JSON.parse(pw.body)).toMatchObject({ code: 'SSO_REQUIRED', details: { tenant: 'acme' } });
    // A wrong password gets the usual answer, so the hint reveals nothing.
    const wrong = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenant: 'acme', email: 'admin@acme.example', password: 'falsch-falsch' } });
    expect(wrong.statusCode).toBe(401);
    expect(JSON.parse((await app.inject({ method: 'GET', url: '/api/auth/sso?tenant=acme' })).body).localLogin).toBe(false);

    // The other tenant is not affected.
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenant: 'other', email: 'admin@other.example', password: PASSWORD } })).statusCode).toBe(200);
  });

  it('blocks joining by link with a password', async () => {
    await withSystem((c) => c.query(`UPDATE tenants SET join_code = 'join-acme-123' WHERE id = $1`, [acme]));
    const res = await app.inject({ method: 'POST', url: '/api/join/join-acme-123', payload: { name: 'Neu', email: 'neu@acme.example', password: 'ein-langes-passwort', acceptPrivacy: true } });
    expect(res.statusCode).toBe(403);
  });

  it('break-glass: the operator switches local accounts back on (CLI)', async () => {
    expect(await setLocalLogin('acme', true)).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenant: 'acme', email: 'admin@acme.example', password: PASSWORD } })).statusCode).toBe(200);
    const audit = await withSystem(async (c) => (await c.query(`SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'identity.break_glass'`, [acme])).rowCount);
    expect(audit).toBe(1);
    expect(await setLocalLogin('missing', true)).toBe(false);
  });
});

describe('rate limits', () => {
  it('limits the login discovery and the OIDC endpoints per IP', async () => {
    const factor = config.rateLimitFactor;
    config.rateLimitFactor = 0.05; // ssoIp: 3 per window
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await app.inject({ method: 'GET', url: '/api/auth/sso?tenant=acme', remoteAddress: '10.9.9.9' })).statusCode);
      expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
      expect(codes[4]).toBe(429);
      expect((await app.inject({ method: 'GET', url: '/api/auth/oidc/start?tenant=acme', remoteAddress: '10.9.9.9' })).statusCode).toBe(429);
    } finally {
      config.rateLimitFactor = factor;
    }
  });
});

describe('helpers', () => {
  it('maps groups to roles case-insensitively and keeps roles without a mapping', () => {
    expect(rolesFromGroups([], ['x'])).toBeNull();
    expect(rolesFromGroups([{ group: 'GRP-Triage', roles: ['triage'] }], ['grp-triage'])).toEqual(['submitter', 'triage']);
  });

  it('verifies a token directly against the JWKS', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = idp.sign({ iss: idp.issuer, aud: idp.clientId, sub: 's', iat: now, exp: now + 60, nonce: 'n' });
    const claims = await verifyIdToken(token, { jwksUri: `${idp.issuer}/keys`, issuer: idp.issuer, clientId: idp.clientId, nonce: 'n' });
    expect(claims.sub).toBe('s');
    await expect(verifyIdToken(`${token.slice(0, -4)}AAAA`, { jwksUri: `${idp.issuer}/keys`, issuer: idp.issuer, clientId: idp.clientId, nonce: 'n' })).rejects.toThrow();
  });
});
