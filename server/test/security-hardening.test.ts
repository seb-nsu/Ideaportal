import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { fetch as undiciFetch } from 'undici';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { pinnedAgent, privateIp, providerFetch, publicFetch, setDnsLookup, UrlRefusedError } from '../src/ai/providers.js';
import { config, productionProblems } from '../src/config.js';
import { closePool, withSystem, withTenant } from '../src/db/pool.js';
import { isCommonPassword, passwordProblem, setBreachLookup } from '../src/lib/password.js';
import { hashIp, requestIdFrom, runBackground } from '../src/lib/requestContext.js';
import { isLegacyWrap, masterFingerprint, openSecret, sealSecret, unwrapKey, upgradeKeyWrapping, wrapKey, wrapKeyLegacy } from '../src/lib/secretbox.js';
import { recordAiCall } from '../src/lib/prometheus.js';
import { PASSWORD, client, createTenant, createUser, login, resetDb, testApp } from './helpers.js';

// Enterprise security, part 2: request ids and logs, metrics and health checks, safe defaults,
// HKDF key derivation, login hardening, password policy, idle timeout, SSRF pinning.

let app: FastifyInstance;
let tenant: string;
let other: string;
const METRICS = 'metrics-token-for-vitest-0123456789';

beforeAll(async () => {
  await resetDb();
  app = await testApp();
  tenant = await createTenant('hard');
  other = await createTenant('hard-other');
  await createUser(tenant, 'admin@hard.example', ['submitter', 'admin']);
  await createUser(tenant, 'anna@hard.example');
  await createUser(other, 'otto@hard-other.example');
});

afterEach(() => {
  setDnsLookup();
  setBreachLookup();
  config.metricsToken = undefined;
  config.passwordBreachCheck = 'off';
  config.aiAllowPrivateUrls = false;
});

afterAll(async () => {
  await app.close();
  await closePool();
});

describe('request ids and logs', () => {
  it('keeps a sane incoming X-Request-Id and replaces anything else with a UUID', async () => {
    const kept = await app.inject({ method: 'GET', url: '/api/health/live', headers: { 'x-request-id': 'lb-1234-abcd' } });
    expect(kept.headers['x-request-id']).toBe('lb-1234-abcd');
    const replaced = await app.inject({ method: 'GET', url: '/api/health/live', headers: { 'x-request-id': 'bad id\nwith newline' } });
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestIdFrom('x'.repeat(200))).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestIdFrom(undefined)).not.toBe(requestIdFrom(undefined));
  });

  it('logs unexpected errors at error level with request id and stack, answers with the id, and honours LOG_LEVEL', async () => {
    const lines: Record<string, unknown>[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(JSON.parse(String(chunk)));
        cb();
      },
    });
    const before = config.logLevel;
    config.logLevel = 'warn';
    const logged = await buildApp({ logStream: stream });
    config.logLevel = before;
    logged.get('/api/test-boom', async () => {
      throw new Error('boom in handler');
    });
    const res = await logged.inject({ method: 'GET', url: '/api/test-boom', headers: { 'x-request-id': 'req-boom-0001' } });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: 'INTERNAL', requestId: 'req-boom-0001' });
    const err = lines.find((l) => l.level === 50)!;
    expect(err).toMatchObject({ reqId: 'req-boom-0001', requestId: 'req-boom-0001', msg: 'request failed' });
    expect(String((err.err as { stack: string }).stack)).toContain('security-hardening.test.ts');
    // Level warn: the info lines "incoming request" / "request completed" are not written.
    expect(lines.some((l) => l.level === 30)).toBe(false);
    await logged.close();
  });

  it('gives background runs a run id that reaches the audit rows they write', async () => {
    const runId = await runBackground('jobs', async (id) => {
      await withTenant(tenant, (db) => db.query(`INSERT INTO audit_log (tenant_id, action, entity) VALUES ($1, 'test.background', 'tenant')`, [tenant]));
      return id;
    });
    const row = await withSystem(async (c) => (await c.query(`SELECT request_id, ip_hash FROM audit_log WHERE action = 'test.background'`)).rows[0]);
    expect(row).toEqual({ request_id: `jobs:${runId}`, ip_hash: null });
  });

  it('hashes client addresses with a key, never as plain SHA-256', () => {
    const h = hashIp('198.51.100.4')!;
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    expect(h).toBe(hashIp('198.51.100.4'));
    expect(h).not.toBe(hashIp('198.51.100.5'));
    expect(hashIp(null)).toBeNull();
  });
});

describe('health checks and metrics', () => {
  it('shows only the status publicly and the figures with the metrics token', async () => {
    const pub = await app.inject({ method: 'GET', url: '/api/health' });
    expect(pub.statusCode).toBe(200);
    expect(Object.keys(pub.json())).toEqual(['status']);
    config.metricsToken = METRICS;
    expect(Object.keys((await app.inject({ method: 'GET', url: '/api/health', headers: { authorization: 'Bearer wrong' } })).json())).toEqual(['status']);
    const full = (await app.inject({ method: 'GET', url: '/api/health', headers: { authorization: `Bearer ${METRICS}` } })).json();
    expect(full).toHaveProperty('aiQueue');
    expect(full).toHaveProperty('alerts');
  });

  it('answers liveness without and readiness with the database', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/health/live' })).json()).toEqual({ status: 'ok' });
    const ready = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ok' });
  });

  it('serves Prometheus metrics only with METRICS_TOKEN, labelled by route pattern and without tenant names', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/metrics' })).statusCode).toBe(404);
    config.metricsToken = METRICS;
    expect((await app.inject({ method: 'GET', url: '/api/metrics' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/metrics', headers: { authorization: `Bearer ${METRICS}x` } })).statusCode).toBe(404);
    const cookie = await login(app, 'hard', 'anna@hard.example');
    await app.inject({ method: 'GET', url: '/api/ideas/00000000-0000-0000-0000-000000000000', headers: { cookie } });
    recordAiCall('triage', 'ok', false, 0.0123);
    const res = await app.inject({ method: 'GET', url: '/api/metrics', headers: { authorization: `Bearer ${METRICS}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    const body = res.body;
    expect(body).toContain('ideenportal_process_cpu_seconds_total');
    expect(body).toMatch(/ideenportal_http_request_duration_seconds_bucket\{[^}]*route="\/api\/ideas\/:id"/);
    expect(body).not.toContain('00000000-0000-0000-0000-000000000000');
    expect(body).toMatch(/ideenportal_ai_queue_jobs\{state="queued"\} \d+/);
    expect(body).toMatch(/ideenportal_outbox_pending \d+/);
    expect(body).toMatch(/ideenportal_job_last_run_age_seconds\{loop="jobs"\}/);
    expect(body).toMatch(/ideenportal_ai_calls_total\{agent="triage",status="ok",local="false"\} \d+/);
    expect(body).toContain('ideenportal_ai_cost_eur_total');
    expect(body).not.toMatch(/hard-other|hard\.example|Mandant/);
  });
});

describe('safe defaults', () => {
  it('refuses production without a strong SECRET_KEY', () => {
    expect(productionProblems({ NODE_ENV: 'development' })).toEqual([]);
    expect(productionProblems({ NODE_ENV: 'production' })).toHaveLength(1);
    expect(productionProblems({ NODE_ENV: 'production', SECRET_KEY: 'short-key-1234567890' })[0]).toMatch(/SECRET_KEY/);
    expect(productionProblems({ NODE_ENV: 'production', SECRET_KEY: 'k'.repeat(32) })).toEqual([]);
    expect(productionProblems({ NODE_ENV: 'production', SECRET_KEY: 'k'.repeat(32), METRICS_TOKEN: 'short' })[0]).toMatch(/METRICS_TOKEN/);
  });

  it('forces Secure cookies when PUBLIC_URL is https', async () => {
    vi.resetModules();
    vi.stubEnv('PUBLIC_URL', 'https://ideen.example.com');
    vi.stubEnv('COOKIE_SECURE', 'false');
    try {
      const fresh = await import('../src/config.js');
      expect(fresh.config.cookieSecure).toBe(true);
      vi.stubEnv('PUBLIC_URL', 'http://localhost:3000');
      vi.stubEnv('COOKIE_SECURE', '');
      vi.resetModules();
      expect((await import('../src/config.js')).config.cookieSecure).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe('key derivation (HKDF, versioned)', () => {
  it('reads and upgrades tenant keys wrapped with the older SHA-256 derivation without losing secrets', async () => {
    const t = await createTenant('hkdf');
    const secret = config.secretKey!;
    const dataKey = randomBytes(32);
    // A tenant key as written before the change ("k1.").
    await withSystem((c) =>
      c.query('INSERT INTO tenant_keys (tenant_id, wrapped_key, master_fp) VALUES ($1, $2, $3)', [
        t,
        wrapKeyLegacy(dataKey, t, secret),
        masterFingerprint(secret),
      ]),
    );
    const sealed = await sealSecret(null, t, 'alter-schluessel-wert');
    expect(await openSecret(null, t, sealed)).toBe('alter-schluessel-wert');
    const upgraded = await withSystem((c) => upgradeKeyWrapping(c));
    expect(upgraded).toBeGreaterThanOrEqual(1);
    const row = await withSystem(async (c) => (await c.query('SELECT wrapped_key FROM tenant_keys WHERE tenant_id = $1', [t])).rows[0]);
    expect(row.wrapped_key.startsWith('k2.')).toBe(true);
    expect(isLegacyWrap(row.wrapped_key)).toBe(false);
    expect(unwrapKey(row.wrapped_key, t, secret).equals(dataKey)).toBe(true);
    expect(await openSecret(null, t, sealed)).toBe('alter-schluessel-wert');
    // Running it again changes nothing; other keys never open the wrap.
    expect(await withSystem((c) => upgradeKeyWrapping(c))).toBe(0);
    expect(() => unwrapKey(row.wrapped_key, t, 'another-secret-key-of-32-characters!')).toThrow();
    expect(() => unwrapKey(row.wrapped_key, other, secret)).toThrow();
  });

  it('wraps new keys with HKDF and keeps both formats apart', () => {
    const key = randomBytes(32);
    const k2 = wrapKey(key, tenant, config.secretKey!);
    const k1 = wrapKeyLegacy(key, tenant, config.secretKey!);
    expect(k2.startsWith('k2.')).toBe(true);
    expect(unwrapKey(k1, tenant, config.secretKey!).equals(key)).toBe(true);
    expect(unwrapKey(k2, tenant, config.secretKey!).equals(key)).toBe(true);
    // A k1 value relabelled as k2 does not open (different derivation).
    expect(() => unwrapKey(`k2.${k1.slice(3)}`, tenant, config.secretKey!)).toThrow();
  });
});

describe('login hardening', () => {
  const timeLogin = async (email: string) => {
    const start = process.hrtime.bigint();
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenant: 'hard', email, password: 'falsch-falsch-falsch' } });
    expect(res.statusCode).toBe(401);
    return Number(process.hrtime.bigint() - start) / 1e6;
  };

  it('spends the scrypt work for unknown accounts as well', async () => {
    const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 5; i++) {
      known.push(await timeLogin('anna@hard.example'));
      unknown.push(await timeLogin(`niemand${i}@hard.example`));
    }
    // Without the dummy hash an unknown address answers in a fraction of the time.
    expect(median(unknown)).toBeGreaterThan(median(known) * 0.4);
    await withSystem((c) => c.query("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE email = 'anna@hard.example'"));
  });

  it('ends idle sessions after the tenant setting and writes last_seen throttled', async () => {
    const cookie = await login(app, 'hard', 'anna@hard.example');
    const me = client(app, cookie);
    const token = cookie.split('=')[1];
    const session = () =>
      withSystem(
        async (c) => (await c.query(`SELECT last_seen_at FROM sessions WHERE token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')`, [token])).rows[0],
      );
    // Off by default: an old last_seen does not end the session.
    await withSystem((c) =>
      c.query(`UPDATE sessions SET last_seen_at = now() - interval '3 hours' WHERE token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')`, [token]),
    );
    expect((await me.get('/api/me')).status).toBe(200);
    const seen = (await session()).last_seen_at as Date;
    expect(Date.now() - seen.getTime()).toBeLessThan(10_000);
    // A second request within the throttle window does not write again.
    await me.get('/api/me');
    expect(((await session()).last_seen_at as Date).getTime()).toBe(seen.getTime());

    await withSystem((c) =>
      c.query(`UPDATE tenants SET settings = settings || '{"security": {"passwordMinLength": 10, "sessionIdleMinutes": 15}}' WHERE id = $1`, [tenant]),
    );
    await withSystem((c) =>
      c.query(`UPDATE sessions SET last_seen_at = now() - interval '10 minutes' WHERE token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')`, [token]),
    );
    expect((await me.get('/api/me')).status).toBe(200);
    await withSystem((c) =>
      c.query(`UPDATE sessions SET last_seen_at = now() - interval '16 minutes' WHERE token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')`, [token]),
    );
    expect((await me.get('/api/me')).status).toBe(401);
    expect(await session()).toBeUndefined();
    // The setting of one tenant does not affect another.
    const otto = client(app, await login(app, 'hard-other', 'otto@hard-other.example'));
    await withSystem((c) => c.query(`UPDATE sessions SET last_seen_at = now() - interval '2 hours' WHERE tenant_id = $1`, [other]));
    expect((await otto.get('/api/me')).status).toBe(200);
  });

  it('validates the security settings', async () => {
    await withSystem((c) => c.query(`UPDATE tenants SET settings = settings - 'security' WHERE id = $1`, [tenant]));
    const admin = client(app, await login(app, 'hard', 'admin@hard.example'));
    const s = (await admin.get('/api/admin/settings')).body;
    expect(s.security).toEqual({ passwordMinLength: 10, sessionIdleMinutes: 0 });
    expect((await admin.put('/api/admin/settings', { ...s, security: { passwordMinLength: 8, sessionIdleMinutes: 0 } })).status).toBe(400);
    const idle = await admin.put('/api/admin/settings', { ...s, security: { passwordMinLength: 12, sessionIdleMinutes: 3 } });
    expect(idle.status).toBe(400);
    const ok = await admin.put('/api/admin/settings', { ...s, security: { passwordMinLength: 14, sessionIdleMinutes: 0 } });
    expect(ok.status).toBe(200);
    expect(ok.body.security.passwordMinLength).toBe(14);
  });
});

describe('password policy', () => {
  it('recognises very common passwords and simple patterns', () => {
    for (const pw of ['password123', 'Passwort2024!', '1234567890', 'qwertyuiop', 'aaaaaaaaaaaa', 'abcabcabcabc', 'abcdefghijk', '!!Sunshine123']) {
      expect(isCommonPassword(pw), pw).toBe(true);
    }
    for (const pw of [PASSWORD, 'sehr-geheim-123', 'Kaffeemaschine im 3. Stock', 'ein-langes-passwort']) {
      expect(isCommonPassword(pw), pw).toBe(false);
    }
    expect(passwordProblem('kurz-123')).toBe('tooShort');
    expect(passwordProblem('Kaffee-7x', { minLength: 4 })).toBe('tooShort'); // never below 10
    expect(passwordProblem('frieda-geheim-99', { email: 'frieda@kueche.example' })).toBe('personal');
    expect(passwordProblem('Kaffeemaschine im 3. Stock', { minLength: 30 })).toBe('tooShort');
  });

  it('refuses weak passwords at sign-up, joining and password reset with the tenant minimum', async () => {
    const weak = await app.inject({
      method: 'POST',
      url: '/api/signup',
      payload: { workspace: 'Schwach GmbH', name: 'Sina Schwach', email: 'sina@schwach.example', password: 'password123', acceptPrivacy: true },
    });
    expect(weak.statusCode).toBe(400);
    expect(weak.json()).toMatchObject({ code: 'PASSWORD_POLICY', details: { reason: 'common' } });
    // Tenant minimum 14 (set above): a 12-character password is refused when it is reset.
    const anna = await withSystem(async (c) => (await c.query("SELECT id FROM users WHERE email = 'anna@hard.example'")).rows[0].id);
    const token = 'reset-token-for-the-policy-test-0123456789';
    await withSystem((c) =>
      c.query(`UPDATE users SET reset_token_hash = encode(sha256(convert_to($2, 'UTF8')), 'hex'), reset_expires_at = now() + interval '1 hour' WHERE id = $1`, [
        anna,
        token,
      ]),
    );
    const short = await app.inject({ method: 'POST', url: '/api/auth/set-password', payload: { token, password: 'gruene-wiese' } });
    expect(short.statusCode).toBe(400);
    expect(short.json().details.reason).toBe('tooShort');
    expect(short.json().error).toContain('14');
    const good = await app.inject({ method: 'POST', url: '/api/auth/set-password', payload: { token, password: 'gruene-wiese-am-see' } });
    expect(good.statusCode).toBe(200);
  });

  it('checks known breaches by k-anonymity only when PASSWORD_BREACH_CHECK=hibp', async () => {
    const prefixes: string[] = [];
    // SHA-1 of "kaffee-am-morgen-7" is looked up by its first five characters only.
    const { createHash } = await import('node:crypto');
    const sha1 = createHash('sha1').update('kaffee-am-morgen-7').digest('hex').toUpperCase();
    setBreachLookup(async (prefix) => {
      prefixes.push(prefix);
      return `0000000000000000000000000000000000A:3\r\n${sha1.slice(5)}:42\r\n`;
    });
    const signup = (email: string) =>
      app.inject({
        method: 'POST',
        url: '/api/signup',
        payload: { workspace: 'Leck GmbH', name: 'Lea Leck', email, password: 'kaffee-am-morgen-7', acceptPrivacy: true },
      });
    // Off by default: no lookup at all.
    expect((await signup('lea1@leck.example')).statusCode).toBe(201);
    expect(prefixes).toEqual([]);
    config.passwordBreachCheck = 'hibp';
    const res = await signup('lea2@leck.example');
    expect(res.statusCode).toBe(400);
    expect(res.json().details.reason).toBe('breached');
    expect(prefixes).toEqual([sha1.slice(0, 5)]);
    // A failing service never blocks the password (fail open).
    setBreachLookup(async () => {
      throw new Error('down');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await signup('lea3@leck.example')).statusCode).toBe(201);
    warn.mockRestore();
  });
});

describe('SSRF: DNS rebinding', () => {
  let server: Server;
  let port: number;
  const seen: IncomingHttpHeaders[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(req.headers);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('connects to the address that was checked, not to a second DNS answer, and keeps the host name', async () => {
    config.aiAllowPrivateUrls = true;
    const answers = [[{ address: '127.0.0.1', family: 4 }], [{ address: '10.255.255.1', family: 4 }]];
    let calls = 0;
    setDnsLookup(async () => answers[Math.min(calls++, 1)]);
    const res = await providerFetch(`http://rebind.test:${port}/v1/models`, { signal: AbortSignal.timeout(5000) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toBe(1);
    expect(seen.at(-1)!.host).toBe(`rebind.test:${port}`);
  });

  it('pins the connection even for names the system resolver does not know', async () => {
    const agent = pinnedAgent({ address: '127.0.0.1', family: 4 });
    const res = await undiciFetch(`http://unknown-name.invalid:${port}/`, { dispatcher: agent });
    expect(res.status).toBe(200);
    await res.text();
    await agent.close();
  });

  it('refuses private answers for public fetches and provider URLs', async () => {
    setDnsLookup(async () => [{ address: '169.254.169.254', family: 4 }]);
    await expect(publicFetch('https://metadata.example.com/latest')).rejects.toBeInstanceOf(UrlRefusedError);
    await expect(providerFetch('https://metadata.example.com/v1')).rejects.toThrow(/internen Netz/);
    setDnsLookup(async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    await expect(publicFetch('https://mixed.example.com/')).rejects.toBeInstanceOf(UrlRefusedError);
    for (const ip of ['::ffff:7f00:1', '::ffff:127.0.0.1', 'fe90::1', 'ff02::1', '198.18.0.1', '224.0.0.1', '100.64.0.1']) expect(privateIp(ip), ip).toBe(true);
    for (const ip of ['93.184.216.34', '2a00:1450:4001::1']) expect(privateIp(ip), ip).toBe(false);
  });
});
