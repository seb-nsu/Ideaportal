import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, withSystem } from '../src/db/pool.js';
import { totp } from '../src/lib/crypto.js';
import { openTotp } from '../src/lib/secretbox.js';
import { PASSWORD, client, createTenant, createUser, login, resetDb, testApp } from './helpers.js';

// Own accounts with lockout, invitations and two-factor login (R1-09); MFA mandatory for admins.

let app: FastifyInstance;
let tenant: string;

beforeAll(async () => {
  await resetDb();
  app = await testApp();
  const t = await createTenant('auth', { requireMfaForAdmins: true });
  tenant = t;
  await createUser(t, 'user@auth.example');
  await createUser(t, 'admin@auth.example', ['submitter', 'admin']);
  await createUser(t, 'lock@auth.example');
});

afterAll(async () => {
  await app.close();
  await closePool();
});

const tryLogin = (email: string, password: string) =>
  app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenant: 'auth', email, password } });

describe('accounts', () => {
  it('rejects requests without a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/ideas' })).statusCode).toBe(401);
  });

  it('rejects form posts without JSON (CSRF protection)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: 'tenant=auth', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(res.statusCode).toBe(415);
  });

  it('locks the account after five failed attempts', async () => {
    for (let i = 0; i < 5; i++) expect((await tryLogin('lock@auth.example', 'falsch')).statusCode).toBe(401);
    expect((await tryLogin('lock@auth.example', PASSWORD)).statusCode).toBe(423);
  });

  it('forces admins to set up MFA and then requires the second factor', async () => {
    const admin = client(app, await login(app, 'auth', 'admin@auth.example'));
    const blocked = await admin.get('/api/admin/users');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('MFA_SETUP_REQUIRED');

    const setup = await admin.post('/api/auth/mfa/setup');
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect((await admin.post('/api/auth/mfa/enable', { code: '000000' })).status).toBe(400);
    expect((await admin.post('/api/auth/mfa/enable', { code: totp(setup.body.secret) })).status).toBe(200);

    const res = await tryLogin('admin@auth.example', PASSWORD);
    expect(JSON.parse(res.body).mfaRequired).toBe(true);
    const cookie = `ip_session=${res.cookies.find((c) => c.name === 'ip_session')!.value}`;
    const pending = client(app, cookie);
    expect((await pending.get('/api/ideas')).body.code).toBe('MFA_REQUIRED');
    expect((await pending.post('/api/auth/mfa', { code: totp(setup.body.secret) })).status).toBe(200);
    expect((await pending.get('/api/admin/users')).status).toBe(200);
  });

  it('invites users who then set their own password', async () => {
    const res = await tryLogin('admin@auth.example', PASSWORD);
    const cookie = `ip_session=${res.cookies.find((c) => c.name === 'ip_session')!.value}`;
    const secret = await withSystem(async (c) => (await c.query(`SELECT mfa_secret FROM users WHERE email = 'admin@auth.example'`)).rows[0].mfa_secret as string);
    const admin = client(app, cookie);
    await admin.post('/api/auth/mfa', { code: totp(await openTotp(null, tenant, secret)) });
    const created = await admin.post('/api/admin/users', { email: 'neu@auth.example', displayName: 'Neu Person', roles: ['triage'] });
    expect(created.status).toBe(201);
    const mail = await withSystem(async (c) => (await c.query(`SELECT body FROM outbox WHERE to_email = 'neu@auth.example'`)).rows[0].body as string);
    const token = mail.match(/token=([\w-]+)/)![1];
    const anon = client(app, '');
    expect((await anon.post('/api/auth/set-password', { token, password: 'kurz' })).status).toBe(400);
    expect((await anon.post('/api/auth/set-password', { token, password: 'ein-langes-passwort' })).status).toBe(200);
    expect((await anon.post('/api/auth/set-password', { token, password: 'ein-langes-passwort' })).status).toBe(400);
    expect((await tryLogin('neu@auth.example', 'ein-langes-passwort')).statusCode).toBe(200);

    const audit = await admin.get('/api/admin/audit');
    expect(audit.body.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(['user.invite', 'auth.mfa_enabled']));
    // The admin cannot remove their own admin role.
    const me = (await admin.get('/api/admin/users')).body.find((u: { email: string }) => u.email === 'admin@auth.example');
    expect((await admin.patch(`/api/admin/users/${me.id}`, { roles: ['submitter'] })).status).toBe(400);
  });

  it('changes settings without restart and records them in the audit log', async () => {
    const res = await tryLogin('admin@auth.example', PASSWORD);
    const cookie = `ip_session=${res.cookies.find((c) => c.name === 'ip_session')!.value}`;
    const secret = await withSystem(async (c) => (await c.query(`SELECT mfa_secret FROM users WHERE email = 'admin@auth.example'`)).rows[0].mfa_secret as string);
    const admin = client(app, cookie);
    await admin.post('/api/auth/mfa', { code: totp(await openTotp(null, tenant, secret)) });
    const settings = (await admin.get('/api/admin/settings')).body;
    settings.deadlines.gate1Workdays = 7;
    settings.topics = ['Nur ein Thema'];
    expect((await admin.put('/api/admin/settings', settings)).status).toBe(200);
    const user = client(app, await login(app, 'auth', 'user@auth.example'));
    const pub = await user.get('/api/settings');
    expect(pub.body.deadlines.gate1Workdays).toBe(7);
    expect(pub.body.topics).toEqual(['Nur ein Thema']);
    expect((await admin.put('/api/admin/settings', { ...settings, minGroupSize: 2 })).status).toBe(400);
  });
});
