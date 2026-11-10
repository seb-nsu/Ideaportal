import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { sealLegacyTotpSecrets } from '../src/db/migrate.js';
import { closePool, withSystem } from '../src/db/pool.js';
import { newTotpSecret, totp } from '../src/lib/crypto.js';
import { isSealed, openTotp } from '../src/lib/secretbox.js';
import { mailSubject } from '../src/services/mailer.js';
import { notifyUser } from '../src/services/notify.js';
import { createIdea, ideaInput } from '../src/services/workflow.js';
import { PASSWORD, asUser, client, createTenant, createUser, login, resetDb, testApp, validIdea } from './helpers.js';

// AP-01: rate limits (R1-44), TOTP encryption, security headers and confidential mail subjects (R1-45).

let app: FastifyInstance;
let tenant: string;

beforeAll(async () => {
  await resetDb();
  app = await testApp();
  tenant = await createTenant('sicher');
  await createUser(tenant, 'ziel@sicher.example');
  await createUser(tenant, 'admin@sicher.example', ['submitter', 'admin']);
  config.rateLimitFactor = 1;
});

afterAll(async () => {
  config.rateLimitFactor = 100;
  await app.close();
  await closePool();
});

const loginFrom = (ip: string, email: string, password: string) =>
  app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: ip, payload: { email, password } });

describe('rate limits (R1-44)', () => {
  it('stops 20 failed attempts on one account with 429 and a waiting time', async () => {
    const codes: number[] = [];
    let last;
    for (let i = 0; i < 20; i++) {
      // Different addresses: the per-account limit must hold even when the attacker rotates IPs.
      last = await loginFrom(`10.0.0.${i + 1}`, 'ziel@sicher.example', `falsch-${i}`);
      codes.push(last.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 401 || c === 423)).toBe(true);
    expect(codes.slice(10).every((c) => c === 429)).toBe(true);
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
    const body = JSON.parse(last!.body);
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.details.retryAfterSeconds).toBeGreaterThan(0);
    // The event is in the audit log of the tenant and in the platform's security events.
    const audit = await withSystem(async (c) => (await c.query(`SELECT action FROM audit_log WHERE action = 'auth.rate_limited'`)).rowCount);
    expect(audit).toBeGreaterThan(0);
    const events = await withSystem(async (c) => (await c.query(`SELECT bucket FROM security_events`)).rows.map((r) => r.bucket));
    expect(events).toContain('loginAccount');
  });

  it('limits login attempts per IP address across accounts', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 32; i++) codes.push((await loginFrom('10.1.1.1', `niemand-${i}@sicher.example`, 'x')).statusCode);
    expect(codes.slice(0, 30).every((c) => c === 401)).toBe(true);
    expect(codes.slice(30)).toEqual([429, 429]);
  });

  it('limits sign-ups, password resets and the demo login per IP address', async () => {
    const signup = (i: number) =>
      app.inject({ method: 'POST', url: '/api/signup', remoteAddress: '10.2.2.2', payload: { workspace: `Team ${i}`, name: 'Max Muster', email: `m${i}@team.example`, password: 'ein-langes-passwort', acceptPrivacy: true, exampleData: false } });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await signup(i)).statusCode);
    expect(codes).toEqual([201, 201, 201, 201, 201, 429]);

    const reset = () => app.inject({ method: 'POST', url: '/api/auth/reset-request', remoteAddress: '10.3.3.3', payload: { email: 'admin@sicher.example' } });
    const resetCodes: number[] = [];
    for (let i = 0; i < 4; i++) resetCodes.push((await reset()).statusCode);
    expect(resetCodes).toEqual([200, 200, 200, 429]);
  });

  it('can be switched off for load tests', async () => {
    config.rateLimitFactor = 0;
    for (let i = 0; i < 3; i++) expect((await loginFrom('10.1.1.1', 'niemand@sicher.example', 'x')).statusCode).toBe(401);
    config.rateLimitFactor = 1;
  });
});

describe('TOTP secrets (R1-45)', () => {
  it('stores new TOTP secrets encrypted and still accepts codes', async () => {
    config.rateLimitFactor = 100;
    const admin = client(app, await login(app, 'sicher', 'admin@sicher.example'));
    const setup = await admin.post('/api/auth/mfa/setup');
    const stored = await withSystem(async (c) => (await c.query(`SELECT mfa_secret FROM users WHERE email = 'admin@sicher.example'`)).rows[0].mfa_secret as string);
    expect(isSealed(stored)).toBe(true);
    expect(stored).not.toContain(setup.body.secret);
    expect(await openTotp(null, tenant, stored)).toBe(setup.body.secret);
    expect((await admin.post('/api/auth/mfa/enable', { code: totp(setup.body.secret) })).status).toBe(200);
    config.rateLimitFactor = 1;
  });

  it('encrypts existing plaintext secrets (data migration) without breaking the login', async () => {
    config.rateLimitFactor = 100;
    const plain = newTotpSecret();
    const u = await createUser(tenant, 'alt@sicher.example');
    await withSystem((c) => c.query('UPDATE users SET mfa_secret = $2, mfa_enabled = true WHERE id = $1', [u.id, plain]));
    expect(await withSystem((c) => sealLegacyTotpSecrets(c))).toBe(1);
    expect(await withSystem((c) => sealLegacyTotpSecrets(c))).toBe(0);
    const stored = await withSystem(async (c) => (await c.query('SELECT mfa_secret FROM users WHERE id = $1', [u.id])).rows[0].mfa_secret as string);
    expect(isSealed(stored)).toBe(true);
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenant: 'sicher', email: 'alt@sicher.example', password: PASSWORD } });
    const cookie = `ip_session=${res.cookies.find((c) => c.name === 'ip_session')!.value}`;
    expect((await client(app, cookie).post('/api/auth/mfa', { code: totp(plain) })).status).toBe(200);
    config.rateLimitFactor = 1;
  });
});

describe('security headers (R1-45)', () => {
  it('sets a content security policy without unsafe-inline', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('sets HSTS behind HTTPS', async () => {
    const before = config.cookieSecure;
    config.cookieSecure = true;
    const secure = await buildApp();
    const res = await secure.inject({ method: 'GET', url: '/api/health' });
    expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
    await secure.close();
    config.cookieSecure = before;
  });
});

describe('mail subjects of confidential ideas (R1-45)', () => {
  it('only names the idea number', async () => {
    const user = await createUser(tenant, 'geheim@sicher.example');
    const idea = await asUser(user, tenant, (ctx) => createIdea(ctx, ideaInput.parse({ ...validIdea, title: 'Streng geheimes Produkt', confidential: true })));
    await asUser(user, tenant, (ctx) => notifyUser(ctx, user.id, `Neu: ${idea.title}`, 'Text', idea.id, 'my_ideas'));
    const row = await withSystem(async (c) =>
      (await c.query('SELECT o.subject, i.confidential, i.number FROM outbox o JOIN ideas i ON i.id = o.idea_id WHERE o.idea_id = $1', [idea.id])).rows[0],
    );
    expect(row.subject).toContain('Streng geheimes Produkt'); // in-app inbox keeps it
    expect(mailSubject(row)).toBe(`Idee #${idea.number}`);
    expect(mailSubject({ ...row, subject: '[Vertretung für Ben] Neu: Streng geheim' })).toBe(`[Vertretung für Ben] Idee #${idea.number}`);
    expect(mailSubject({ ...row, confidential: false })).toBe(row.subject);
  });
});
