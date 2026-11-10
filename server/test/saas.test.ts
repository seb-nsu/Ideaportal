import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { rotateSecretKey } from '../src/db/rotate-key.js';
import { closePool, withSystem, withTenant } from '../src/db/pool.js';
import { getSecret, setSecret } from '../src/ai/secrets.js';
import { newTotpSecret, totp } from '../src/lib/crypto.js';
import {
  encryptSecret, masterFingerprint, openSecret, openWithKey, sealSecret, tenantKey, upgradeLegacySecrets,
} from '../src/lib/secretbox.js';
import type { SessionUser } from '../src/lib/context.js';
import { createIdea, ideaInput } from '../src/services/workflow.js';
import { availability, recordStatusCheck, resetStatusCache } from '../src/services/status.js';
import { asUser, client, createTenant, createUser, login, resetDb, testApp, validIdea } from './helpers.js';

// SaaS operations (AP-17): tenant keys and leak tests (R3-01), SECRET_KEY rotation and
// versioned settings (R3-41), operator console with support access (R3-07), status page (R3-10).

let app: FastifyInstance;
let tenantA: string;
let tenantB: string;
let adminA: ReturnType<typeof client>;
let adminB: ReturnType<typeof client>;
let memberA: ReturnType<typeof client>;
const ORIGINAL_KEY = config.secretKey!;
const OPERATOR_TOKEN = 'operator-token-for-vitest-only-0123456789';
const OPERATOR_TOTP = newTotpSecret();
let operatorCookie = '';
let mia: SessionUser;

const operator = (cookie = operatorCookie) => client(app, cookie);

async function operatorLogin(code: string, token = OPERATOR_TOKEN) {
  return app.inject({ method: 'POST', url: '/api/operator/login', payload: { token, code } });
}

beforeAll(async () => {
  await resetDb();
  config.operatorToken = OPERATOR_TOKEN;
  config.operatorTotpSecret = OPERATOR_TOTP;
  app = await testApp();
  tenantA = await createTenant('saas-a');
  tenantB = await createTenant('saas-b');
  await createUser(tenantA, 'admin@a.example', ['submitter', 'admin']);
  mia = await createUser(tenantA, 'mia@a.example', ['submitter']);
  await createUser(tenantB, 'admin@b.example', ['submitter', 'admin']);
  adminA = client(app, await login(app, 'saas-a', 'admin@a.example'));
  adminB = client(app, await login(app, 'saas-b', 'admin@b.example'));
  memberA = client(app, await login(app, 'saas-a', 'mia@a.example'));
});

afterAll(async () => {
  config.secretKey = ORIGINAL_KEY;
  config.secretKeyPrevious = undefined;
  config.operatorToken = undefined;
  config.operatorTotpSecret = undefined;
  await app.close();
  await closePool();
});

describe('own data key per tenant (R3-01)', () => {
  it('gives every tenant its own key and binds secrets to it', async () => {
    const sealedA = await sealSecret(null, tenantA, 'geheim-von-a');
    const sealedB = await sealSecret(null, tenantB, 'geheim-von-b');
    expect(sealedA).toMatch(/^v2\./);
    const keyA = await withSystem((c) => tenantKey(c, tenantA));
    const keyB = await withSystem((c) => tenantKey(c, tenantB));
    expect(keyA.equals(keyB)).toBe(false);
    expect(openWithKey(keyA, tenantA, sealedA)).toBe('geheim-von-a');
    // The key of B never opens a secret of A, not even when the tenant id is forged.
    expect(() => openWithKey(keyB, tenantA, sealedA)).toThrow();
    expect(() => openWithKey(keyB, tenantB, sealedA)).toThrow();
    // A's key with B's id fails as well: the tenant id is authenticated data.
    expect(() => openWithKey(keyA, tenantB, sealedA)).toThrow();
    // Through the tenant context of B, a value copied from A cannot be opened.
    await expect(openSecret(null, tenantB, sealedA)).rejects.toThrow();
    expect(await openSecret(null, tenantB, sealedB)).toBe('geheim-von-b');
    const wrapped = await withSystem(async (c) => (await c.query('SELECT tenant_id, wrapped_key, master_fp FROM tenant_keys ORDER BY tenant_id')).rows);
    expect(wrapped).toHaveLength(2);
    expect(wrapped.every((r) => r.wrapped_key.startsWith('k2.') && r.master_fp === masterFingerprint(ORIGINAL_KEY))).toBe(true);
  });

  it('keeps tenant keys and operator tables out of reach of other tenants (RLS)', async () => {
    const own = await withTenant(tenantB, (db) => db.query('SELECT tenant_id FROM tenant_keys'));
    expect(own.rows.map((r) => r.tenant_id)).toEqual([tenantB]);
    expect((await withTenant(tenantB, (db) => db.query('SELECT 1 FROM tenant_keys WHERE tenant_id = $1', [tenantA]))).rowCount).toBe(0);
    await expect(withTenant(tenantB, (db) => db.query(`INSERT INTO tenant_keys (tenant_id, wrapped_key, master_fp) VALUES ($1, 'x', 'y')`, [tenantA]))).rejects.toThrow(/row-level security|duplicate/);
    await expect(withTenant(tenantB, (db) => db.query(`UPDATE tenant_keys SET master_fp = 'x'`))).rejects.toThrow(/permission denied/);
    for (const table of ['operator_sessions', 'operator_log', 'status_checks', 'status_incidents']) {
      await expect(withTenant(tenantA, (db) => db.query(`SELECT * FROM ${table}`)), table).rejects.toThrow(/permission denied/);
    }
  });

  it('stores AI keys with the tenant key and keeps them apart', async () => {
    await asUser(null, tenantA, (ctx) => setSecret(ctx, 'search', 'sk-a-123'));
    expect(await asUser(null, tenantA, (ctx) => getSecret(ctx, 'search'))).toBe('sk-a-123');
    expect(await asUser(null, tenantB, (ctx) => getSecret(ctx, 'search'))).toBeNull();
    // Even a ciphertext copied into B's table is useless there.
    const stolen = await withSystem(async (c) => (await c.query('SELECT ciphertext FROM tenant_secrets WHERE tenant_id = $1', [tenantA])).rows[0].ciphertext);
    await withSystem((c) => c.query(`INSERT INTO tenant_secrets (tenant_id, name, ciphertext) VALUES ($1, 'search', $2)`, [tenantB, stolen]));
    await expect(asUser(null, tenantB, (ctx) => getSecret(ctx, 'search'))).rejects.toThrow();
    await withSystem((c) => c.query(`DELETE FROM tenant_secrets WHERE tenant_id = $1`, [tenantB]));
  });

  it('moves secrets of the older format to the tenant key', async () => {
    await withSystem((c) => c.query(`INSERT INTO tenant_secrets (tenant_id, name, ciphertext) VALUES ($1, 'provider:alt', $2)`, [tenantA, encryptSecret('alt-123')]));
    expect(await withSystem((c) => upgradeLegacySecrets(c))).toBe(1);
    expect(await withSystem((c) => upgradeLegacySecrets(c))).toBe(0);
    const stored = await withSystem(async (c) => (await c.query(`SELECT ciphertext FROM tenant_secrets WHERE name = 'provider:alt'`)).rows[0].ciphertext);
    expect(stored).toMatch(/^v2\./);
    expect(await asUser(null, tenantA, (ctx) => getSecret(ctx, 'provider:alt'))).toBe('alt-123');
  });

  it('refuses the operator console to tenant sessions and without a session', async () => {
    expect((await adminA.get('/api/operator/overview')).status).toBe(401);
    expect((await adminB.post('/api/operator/tenants', { name: 'Fremd', adminEmail: 'x@y.example', adminName: 'X Y' })).status).toBe(401);
    expect((await client(app, '').get(`/api/operator/tenants/${tenantA}/support`)).status).toBe(401);
    // A tenant session cookie is not an operator cookie.
    const tenantCookie = (await login(app, 'saas-a', 'admin@a.example')).replace('ip_session=', 'ip_operator=');
    expect((await operator(tenantCookie).get('/api/operator/overview')).status).toBe(401);
  });

  it('lets the operator create a tenant with its own key and an invited admin', async () => {
    const now = Date.now();
    expect((await operatorLogin(totp(OPERATOR_TOTP, now), 'wrong-token-wrong-token-wrong-token-xx')).statusCode).toBe(401);
    expect((await operatorLogin('000000')).statusCode).toBe(401);
    const ok = await operatorLogin(totp(OPERATOR_TOTP, now));
    expect(ok.statusCode).toBe(200);
    const cookie = ok.cookies.find((c) => c.name === 'ip_operator')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.path).toBe('/api/operator');
    operatorCookie = `ip_operator=${cookie.value}`;
    // The same code is accepted only once.
    expect((await operatorLogin(totp(OPERATOR_TOTP, now))).statusCode).toBe(401);

    const r = await operator().post('/api/operator/tenants', { name: 'Neue Kundin GmbH', adminEmail: 'chefin@kundin.example', adminName: 'Chefin Kundin' });
    expect(r.status).toBe(201);
    expect(r.body.slug).toBe('neue-kundin-gmbh');
    expect((await operator().post('/api/operator/tenants', { name: 'Zweite', slug: 'neue-kundin-gmbh', adminEmail: 'a@b.example', adminName: 'A B' })).status).toBe(409);
    const key = await withSystem(async (c) => (await c.query('SELECT master_fp FROM tenant_keys WHERE tenant_id = $1', [r.body.id])).rows[0]);
    expect(key.master_fp).toBe(masterFingerprint(ORIGINAL_KEY));
    const mail = await withSystem(async (c) => (await c.query(`SELECT body FROM outbox WHERE to_email = 'chefin@kundin.example'`)).rows[0].body as string);
    const token = mail.match(/token=([\w-]+)/)![1];
    expect((await client(app, '').post('/api/auth/set-password', { token, password: 'ein-langes-passwort' })).status).toBe(200);
    const auditRows = await withTenant(r.body.id, (db) => db.query(`SELECT action, after FROM audit_log WHERE action = 'tenant.operator_create'`));
    expect(auditRows.rowCount).toBe(1);
    const user = await withTenant(r.body.id, (db) => db.query('SELECT roles FROM users'));
    expect(user.rows[0].roles).toContain('admin');
    const log = await operator().get('/api/operator/log');
    expect(log.body.map((l: { action: string }) => l.action)).toEqual(expect.arrayContaining(['login', 'tenant.create']));
  });
});

describe('support console with the customer\'s approval (R3-07)', () => {
  it('shows status per tenant without idea content', async () => {
    await asUser(mia, tenantA, (ctx) => createIdea(ctx, ideaInput.parse({ ...validIdea, title: 'Geheimprojekt Quokka', confidential: true })));
    await withSystem((c) => c.query(`INSERT INTO ai_actions (tenant_id, agent, provider, model, local, status, input, cost_eur) VALUES ($1, 'short', 'builtin', 'x', true, 'error', '{}', 0.25)`, [tenantA]));
    const r = await operator().get('/api/operator/overview');
    expect(r.status).toBe(200);
    const a = r.body.tenants.find((t: { id: string }) => t.id === tenantA);
    expect(a).toMatchObject({ slug: 'saas-a', users: 2, ideas: 1, aiErrors24h: 1, aiCostMonthEur: 0.25, keyState: 'current', supportUntil: null });
    expect(r.body.platform.components).toMatchObject({ api: 'operational' });
    expect(r.body.platform.rotationPending).toBe(false);
    expect(JSON.stringify(r.body)).not.toContain('Quokka');
  });

  it('reads tenant data only with an active grant and logs every access', async () => {
    expect((await operator().get(`/api/operator/tenants/${tenantA}/support`)).status).toBe(403);
    // Only admins grant access.
    expect((await memberA.post('/api/admin/support-access', { hours: 2, reason: 'Fehler beim Import' })).status).toBe(403);
    const g = await adminA.post('/api/admin/support-access', { hours: 2, reason: 'Fehler beim Import' });
    expect(g.status).toBe(201);
    // B's grant situation is untouched; B's admin sees nothing of A.
    expect((await adminB.get('/api/admin/support-access')).body).toMatchObject({ active: null, grants: [], accesses: [] });
    expect((await operator().get(`/api/operator/tenants/${tenantB}/support`)).status).toBe(403);

    const view = await operator().get(`/api/operator/tenants/${tenantA}/support`);
    expect(view.status).toBe(200);
    expect(view.body.users.map((u: { email: string }) => u.email).sort()).toEqual(['admin@a.example', 'mia@a.example']);
    expect(view.body.users.every((u: { email: string }) => u.email.endsWith('@a.example'))).toBe(true);
    // Confidential ideas appear only with their number.
    expect(JSON.stringify(view.body)).not.toContain('Quokka');
    expect(view.body.ideas[0]).toMatchObject({ number: 1, title: null, confidential: true });

    const seen = await adminA.get('/api/admin/support-access');
    expect(seen.body.active.reason).toBe('Fehler beim Import');
    expect(seen.body.accesses).toHaveLength(1);
    expect(seen.body.accesses[0]).toMatchObject({ operator: 'operator', grantId: g.body.id });
    const auditA = await adminA.get('/api/admin/audit');
    expect(auditA.body.map((x: { action: string }) => x.action)).toEqual(expect.arrayContaining(['support.grant', 'support.access']));
    const auditB = await adminB.get('/api/admin/audit');
    expect(auditB.body.map((x: { action: string }) => x.action)).not.toContain('support.access');

    const overview = await operator().get('/api/operator/overview');
    expect(overview.body.tenants.find((t: { id: string }) => t.id === tenantA).supportUntil).not.toBeNull();

    // Revoked or expired: no access.
    expect((await adminA.del('/api/admin/support-access')).body.revoked).toBe(1);
    expect((await operator().get(`/api/operator/tenants/${tenantA}/support`)).status).toBe(403);
    await adminA.post('/api/admin/support-access', { hours: 1, reason: 'Noch einmal' });
    await withSystem((c) => c.query(`UPDATE support_grants SET expires_at = now() - interval '1 minute' WHERE tenant_id = $1`, [tenantA]));
    expect((await operator().get(`/api/operator/tenants/${tenantA}/support`)).status).toBe(403);
  });

  it('is switched off without OPERATOR_TOKEN and OPERATOR_TOTP_SECRET', async () => {
    config.operatorTotpSecret = undefined;
    expect((await operator().get('/api/operator/overview')).status).toBe(404);
    expect((await operatorLogin('123456')).statusCode).toBe(404);
    config.operatorTotpSecret = OPERATOR_TOTP;
    config.operatorToken = 'too-short';
    expect((await client(app, '').get('/api/operator/config')).body).toMatchObject({ enabled: false });
    config.operatorToken = OPERATOR_TOKEN;
    expect((await operator().get('/api/operator/me')).body).toMatchObject({ operator: 'operator', role: 'owner', bootstrap: true });
  });
});

describe('SECRET_KEY rotation and versioned settings (R3-41)', () => {
  it('re-wraps every tenant key, keeps secrets readable and can run again', async () => {
    const NEW_KEY = 'new-secret-key-for-vitest-rotation';
    await asUser(null, tenantB, (ctx) => setSecret(ctx, 'search', 'sk-b-456'));
    const before = await withSystem(async (c) => (await c.query('SELECT tenant_id, wrapped_key FROM tenant_keys ORDER BY tenant_id')).rows);
    const r1 = await rotateSecretKey(ORIGINAL_KEY, NEW_KEY);
    expect(r1.rewrapped).toBe(before.length);
    const after = await withSystem(async (c) => (await c.query('SELECT tenant_id, wrapped_key, master_fp FROM tenant_keys ORDER BY tenant_id')).rows);
    expect(after.every((r) => r.master_fp === masterFingerprint(NEW_KEY))).toBe(true);
    expect(after.every((r, i) => r.wrapped_key !== before[i].wrapped_key)).toBe(true);
    // Secrets themselves stay untouched and readable with only the new key.
    config.secretKey = NEW_KEY;
    config.secretKeyPrevious = undefined;
    expect(await asUser(null, tenantA, (ctx) => getSecret(ctx, 'search'))).toBe('sk-a-123');
    expect(await asUser(null, tenantB, (ctx) => getSecret(ctx, 'search'))).toBe('sk-b-456');
    // Idempotent: a second run has nothing to do.
    const r2 = await rotateSecretKey(ORIGINAL_KEY, NEW_KEY);
    expect(r2).toMatchObject({ rewrapped: 0, alreadyCurrent: before.length });
    // Resumable: an aborted run left one key on the old key; the next run finishes the rest.
    const r3 = await rotateSecretKey(NEW_KEY, ORIGINAL_KEY);
    expect(r3.rewrapped).toBe(before.length);
    await withSystem(async (c) => {
      const { wrapKey, unwrapKey } = await import('../src/lib/secretbox.js');
      const row = (await c.query('SELECT wrapped_key FROM tenant_keys WHERE tenant_id = $1', [tenantA])).rows[0];
      const dataKey = unwrapKey(row.wrapped_key, tenantA, ORIGINAL_KEY);
      await c.query('UPDATE tenant_keys SET wrapped_key = $2, master_fp = $3 WHERE tenant_id = $1', [tenantA, wrapKey(dataKey, tenantA, NEW_KEY), masterFingerprint(NEW_KEY)]);
    });
    const r4 = await rotateSecretKey(ORIGINAL_KEY, NEW_KEY);
    expect(r4).toMatchObject({ rewrapped: before.length - 1, alreadyCurrent: 1 });
    // A key wrapped with an unknown SECRET_KEY stops the run with a clear message.
    await expect(rotateSecretKey('some-other-key-0123456789', 'yet-another-key-0123456789')).rejects.toThrow(/unknown key/);
    await expect(rotateSecretKey(NEW_KEY, NEW_KEY)).rejects.toThrow(/same/);
    // Back to the test key for the following tests.
    await rotateSecretKey(NEW_KEY, ORIGINAL_KEY);
    config.secretKey = ORIGINAL_KEY;
    config.secretKeyPrevious = undefined;
    expect(await asUser(null, tenantA, (ctx) => getSecret(ctx, 'search'))).toBe('sk-a-123');
  });

  it('reads keys not yet re-wrapped with SECRET_KEY_PREVIOUS during the switch', async () => {
    config.secretKey = 'switched-key-0123456789abcdef';
    config.secretKeyPrevious = ORIGINAL_KEY;
    expect(await asUser(null, tenantB, (ctx) => getSecret(ctx, 'search'))).toBe('sk-b-456');
    config.secretKeyPrevious = undefined;
    // Without the previous key the old tenant keys cannot be opened (no silent fallback).
    await expect(asUser(null, tenantB, (ctx) => getSecret(ctx, 'search'))).rejects.toThrow(/unknown SECRET_KEY/);
    config.secretKey = ORIGINAL_KEY;
  });

  it('stores settings with a version and refuses a concurrent change', async () => {
    const first = await app.inject({ method: 'GET', url: '/api/admin/settings', headers: { cookie: (await login(app, 'saas-a', 'admin@a.example')) } });
    const settings = JSON.parse(first.body);
    expect(typeof settings.version).toBe('number');
    expect(first.headers.etag).toBe(`"${settings.version}"`);
    const v = settings.version;

    // Two admins load the same version; the first saves, the second gets a conflict.
    const saved = await adminA.put('/api/admin/settings', { ...settings, minGroupSize: 6 });
    expect(saved.status).toBe(200);
    expect(saved.body.version).toBe(v + 1);
    const stale = await adminA.put('/api/admin/settings', { ...settings, minGroupSize: 7 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('SETTINGS_CONFLICT');
    expect(stale.body.details.currentVersion).toBe(v + 1);
    expect((await adminA.get('/api/admin/settings')).body.minGroupSize).toBe(6);

    // If-Match works as well.
    const cookie = await login(app, 'saas-a', 'admin@a.example');
    const { version: _v, ...plain } = settings;
    const viaHeader = await app.inject({ method: 'PUT', url: '/api/admin/settings', payload: { ...plain, minGroupSize: 8 }, headers: { cookie, 'if-match': `"${v}"` } });
    expect(viaHeader.statusCode).toBe(409);
    const ok = await app.inject({ method: 'PUT', url: '/api/admin/settings', payload: { ...plain, minGroupSize: 8 }, headers: { cookie, 'if-match': `W/"${v + 1}"` } });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/api/admin/settings', payload: plain, headers: { cookie, 'if-match': 'abc' } })).statusCode).toBe(400);

    // Other writers (AI settings) raise the version too, so an open form notices them.
    const current = (await adminA.get('/api/admin/settings')).body;
    await withTenant(tenantA, (db) => db.query(`UPDATE tenants SET settings = jsonb_set(settings, '{minGroupSize}', '10')`));
    expect((await adminA.put('/api/admin/settings', { ...current, minGroupSize: 9 })).status).toBe(409);
    // Without a version the change is accepted as before (scripts, older clients).
    expect((await adminA.put('/api/admin/settings', plain)).status).toBe(200);
    // The version of B is independent.
    expect((await adminB.get('/api/admin/settings')).body.version).toBe(1);
  });
});

describe('status page (R3-10)', () => {
  it('answers without login and without internal details', async () => {
    resetStatusCache();
    const r = await client(app, '').get('/api/status');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('operational');
    expect(r.body.components.map((c: { id: string }) => c.id)).toEqual(['api', 'jobs', 'ai', 'mail']);
    const text = JSON.stringify(r.body);
    for (const word of ['queued', 'pending', 'tenant', 'saas-a', 'alerts', 'Mandant']) expect(text).not.toContain(word);
  });

  it('records health checks once per interval and computes the availability', async () => {
    expect(await recordStatusCheck()).toBe(true);
    expect(await recordStatusCheck()).toBe(false);
    await withSystem(async (c) => {
      await c.query('DELETE FROM status_checks');
      // Yesterday: the first half of the day all checks, then the API was down for six hours (no checks) and two outages.
      const day = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) - 86_400_000);
      const per = (24 * 60) / config.alerts.checkMinutes;
      for (let i = 0; i < per; i++) {
        const at = new Date(day.getTime() + i * config.alerts.checkMinutes * 60_000);
        const hour = at.getUTCHours();
        if (hour >= 12 && hour < 18) continue;
        const api = i < 2 ? 'outage' : 'operational';
        await c.query(`INSERT INTO status_checks (checked_at, api, jobs, ai, mail) VALUES ($1, $2, 'operational', $3, 'operational')`, [at, api, i === 5 ? 'degraded' : 'operational']);
      }
    });
    const now = new Date();
    const a = await availability(3, now);
    expect(a.days).toHaveLength(3);
    expect(a.days[0]).toEqual({ date: a.days[0].date, uptimePercent: null, worst: null });
    const yesterday = a.days[1];
    const per = (24 * 60) / config.alerts.checkMinutes;
    const expected = Math.round(((per * 0.75 - 2) / per) * 10_000) / 100;
    expect(yesterday.uptimePercent).toBeCloseTo(expected, 1);
    expect(yesterday.worst).toBe('outage');

    // Announced maintenance during the gap is not counted against the availability.
    const day = new Date(`${yesterday.date}T12:00:00Z`);
    await withSystem((c) => c.query(
      `INSERT INTO status_incidents (kind, title, starts_at, ends_at, resolved_at) VALUES ('maintenance', 'Datenbank-Update', $1, $2, $2)`,
      [day, new Date(day.getTime() + 6 * 3600_000)],
    ));
    const b = await availability(3, now);
    expect(b.days[1].uptimePercent).toBeCloseTo(Math.round(((per * 0.75 - 2) / (per * 0.75)) * 10_000) / 100, 1);
    expect(b.uptimePercent).not.toBeNull();
  });

  it('shows incidents and maintenance maintained by the operator', async () => {
    const created = await operator().post('/api/operator/incidents', { kind: 'incident', severity: 'major', title: 'Mails verzögert', body: 'Wir prüfen den Versand.', components: ['mail'] });
    expect(created.status).toBe(201);
    expect((await adminA.post('/api/operator/incidents', { kind: 'incident', title: 'Fremd' })).status).toBe(401);
    let s = (await client(app, '').get('/api/status')).body;
    expect(s.status).toBe('outage');
    expect(s.components.find((c: { id: string }) => c.id === 'mail').status).toBe('outage');
    expect(s.active[0]).toMatchObject({ title: 'Mails verzögert', kind: 'incident' });
    const later = new Date(Date.now() + 3 * 86_400_000).toISOString();
    await operator().post('/api/operator/incidents', { kind: 'maintenance', title: 'Wartung', components: ['api'], startsAt: later });
    expect((await operator().patch(`/api/operator/incidents/${created.body.id}`, { resolved: true, body: 'Behoben.' })).status).toBe(200);
    s = (await client(app, '').get('/api/status')).body;
    expect(s.status).toBe('operational');
    expect(s.upcoming[0]).toMatchObject({ title: 'Wartung' });
    expect(s.recent[0]).toMatchObject({ title: 'Mails verzögert', body: 'Behoben.' });
    expect(s.history.days).toHaveLength(config.statusHistoryDays);
    expect((await operator().patch('/api/operator/incidents/00000000-0000-0000-0000-000000000000', { resolved: true })).status).toBe(404);
  });
});
