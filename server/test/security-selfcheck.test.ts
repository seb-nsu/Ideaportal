import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { closePool, withSystem } from '../src/db/pool.js';
import { PASSWORD, client, createTenant, createUser, login, resetDb, testApp, validIdea } from './helpers.js';

// OWASP-style self-check (R3-09): the automated part of the pentest preparation. It probes the
// app the way an external tester would (security headers, cookie flags, CSRF, CORS, rate limits,
// error leaks, vertical rights and IDOR across two tenants), but through app.inject instead of a
// network scanner, so it runs in every CI build without extra tools. Checklist and status:
// docs/sicherheit/pentest-vorbereitung.md.

let app: FastifyInstance;
let tenantA: string;
let tenantB: string;
let a: Record<string, ReturnType<typeof client>>;
let b: Record<string, ReturnType<typeof client>>;
let ideaB: string;
const cookieBefore = config.cookieSecure;

beforeAll(async () => {
  await resetDb();
  // Production-like: HTTPS, so HSTS and the Secure flag must be present.
  config.cookieSecure = true;
  app = await testApp();
  tenantA = await createTenant('probe-a', { holidays: [] });
  tenantB = await createTenant('probe-b', { holidays: [] });
  const usersA = {
    submitter: await createUser(tenantA, 'user@a.example'),
    power: await createUser(tenantA, 'power@a.example', ['submitter', 'admin', 'triage', 'committee', 'mentor']),
  };
  const usersB = {
    author: await createUser(tenantB, 'author@b.example'),
    triage: await createUser(tenantB, 'triage@b.example', ['submitter', 'triage']),
  };
  a = {};
  b = {};
  for (const [k, u] of Object.entries(usersA)) a[k] = client(app, await login(app, 'probe-a', u.email));
  for (const [k, u] of Object.entries(usersB)) b[k] = client(app, await login(app, 'probe-b', u.email));
  const created = await b.author.post('/api/ideas', { ...validIdea, title: 'Geheime Idee von B' });
  ideaB = created.body.id;
  expect((await b.author.post(`/api/ideas/${ideaB}/submit`, { confirmNotReport: true, boundaryAcknowledged: true })).status).toBe(200);
});

afterAll(async () => {
  config.cookieSecure = cookieBefore;
  config.rateLimitFactor = 100;
  await app.close();
  await closePool();
});

const REQUIRED_HEADERS: Record<string, RegExp> = {
  'content-security-policy': /default-src 'self'.*frame-ancestors 'none'/,
  'x-content-type-options': /^nosniff$/,
  'x-frame-options': /^DENY$/,
  'referrer-policy': /^same-origin$/,
  'cross-origin-opener-policy': /^same-origin$/,
  'permissions-policy': /camera=\(\)/,
  'strict-transport-security': /max-age=31536000; includeSubDomains/,
};

function expectHeaders(res: LightMyRequestResponse) {
  for (const [name, re] of Object.entries(REQUIRED_HEADERS)) expect(String(res.headers[name] ?? ''), `${name} on ${res.statusCode}`).toMatch(re);
  expect(res.headers['content-security-policy']).not.toMatch(/unsafe-inline|unsafe-eval/);
  expect(res.headers['x-powered-by']).toBeUndefined();
}

describe('security headers (ASVS V14.4)', () => {
  it('sends the headers on success, error, public and download responses', async () => {
    const cookie = await login(app, 'probe-a', 'power@a.example');
    const responses = [
      await app.inject({ method: 'GET', url: '/api/health' }),
      await app.inject({ method: 'GET', url: '/api/me' }),
      await app.inject({ method: 'GET', url: '/api/gibt-es-nicht' }),
      await app.inject({ method: 'GET', url: '/api/legal/agb' }),
      await app.inject({ method: 'GET', url: '/api/legal/agb?format=pdf' }),
      await app.inject({ method: 'GET', url: '/api/admin/compliance/subprocessors?format=csv', headers: { cookie } }),
      await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'x@a.example', password: 'falsch' } }),
    ];
    expect(responses.map((r) => r.statusCode)).toEqual([200, 401, 404, 200, 200, 200, 401]);
    for (const r of responses) expectHeaders(r);
    // API answers are not cached (ASVS V8.2.1).
    for (const r of responses) expect(r.headers['cache-control']).toBe('no-store');
  });

  it('allows no cross-origin reads (no CORS headers)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/legal', headers: { origin: 'https://evil.example' } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const pre = await app.inject({ method: 'OPTIONS', url: '/api/ideas', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('session cookie (ASVS V3)', () => {
  it('sets HttpOnly, Secure, SameSite=Strict, path and lifetime; the body carries no token', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenant: 'probe-a', email: 'user@a.example', password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    const c = res.cookies.find((x) => x.name === 'ip_session')!;
    expect(c).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });
    expect(c.maxAge).toBe(config.sessionHours * 3600);
    expect(c.value.length).toBeGreaterThanOrEqual(32);
    expect(res.body).not.toContain(c.value);
    // Only the hash is stored.
    const stored = await withSystem(async (db) => (await db.query('SELECT token_hash FROM sessions')).rows.map((r) => r.token_hash));
    expect(stored).not.toContain(c.value);
  });

  it('ends the session on logout on the server, not only in the browser', async () => {
    const cookie = await login(app, 'probe-a', 'user@a.example');
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, 'x-requested-with': 'fetch' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('rejects forged and foreign session tokens', async () => {
    for (const cookie of ['ip_session=abc', 'ip_session=' + 'a'.repeat(64), 'ip_session=']) {
      expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
    }
  });
});

describe('CSRF (ASVS V4.2.2, V50)', () => {
  const formTypes = ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'text/plain'];
  it('refuses state-changing requests that a cross-site form could send', async () => {
    const cookie = await login(app, 'probe-a', 'power@a.example');
    const targets: [string, string][] = [
      ['POST', '/api/ideas'],
      ['PUT', '/api/admin/settings'],
      ['POST', '/api/admin/compliance/accept'],
      ['POST', '/api/auth/logout'],
      ['DELETE', `/api/ideas/${ideaB}`],
    ];
    for (const [method, url] of targets) {
      for (const ct of formTypes) {
        const res = await app.inject({ method: method as 'POST', url, headers: { cookie, 'content-type': ct }, payload: 'title=x' });
        expect(res.statusCode, `${method} ${url} ${ct}`).toBe(415);
      }
    }
    // The session survived: the logout form above did nothing.
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(200);
  });
});

describe('rate limits (ASVS V2.2.1)', () => {
  it('answers with 429 and Retry-After once the limit for password resets is reached', async () => {
    config.rateLimitFactor = 1;
    try {
      const codes: number[] = [];
      let last: LightMyRequestResponse | undefined;
      for (let i = 0; i < 12; i++) {
        last = await app.inject({ method: 'POST', url: '/api/auth/reset-request', remoteAddress: '10.9.9.9', payload: { email: `x${i}@a.example` } });
        codes.push(last.statusCode);
      }
      expect(codes).toContain(429);
      expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      config.rateLimitFactor = 100;
    }
  });
});

describe('error handling (ASVS V7.4)', () => {
  it('returns no stack traces, SQL or internals', async () => {
    const cookie = await login(app, 'probe-a', 'power@a.example');
    const bad = [
      await app.inject({ method: 'POST', url: '/api/ideas', headers: { cookie, 'content-type': 'application/json' }, payload: '{"title":' }),
      await app.inject({ method: 'GET', url: '/api/ideas/kein-uuid', headers: { cookie } }),
      await app.inject({ method: 'GET', url: "/api/ideas?sort=' OR 1=1 --", headers: { cookie } }),
    ];
    for (const r of bad) {
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
      expect(r.statusCode).toBeLessThan(500);
      expect(r.body).not.toMatch(/at \w+ \(|node_modules|SELECT |syntax error|\.ts:\d+/);
    }
  });
});

describe('vertical rights (ASVS V4.1)', () => {
  it('keeps admin and triage endpoints closed for a submitter and anonymous callers', async () => {
    const closed = [
      '/api/admin/settings', '/api/admin/users', '/api/admin/audit', '/api/admin/ai', '/api/admin/compliance',
      '/api/admin/compliance/documents/avv', '/api/admin/compliance/subprocessors', '/api/triage/board',
      `/api/ideas/${ideaB}/invention`,
    ];
    for (const url of closed) {
      expect((await a.submitter.get(url)).status, url).toBe(403);
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
  });
});

describe('IDOR across two tenants (ASVS V4.2.1)', () => {
  it('never reads or changes an idea of another tenant, even with every role', async () => {
    const id = ideaB;
    const probes: [('GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'), string, unknown?][] = [
      ['GET', `/api/ideas/${id}`],
      ['GET', `/api/ideas/${id}/ai`],
      ['GET', `/api/ideas/${id}/invention`],
      ['GET', `/api/ideas/${id}/status`],
      ['PATCH', `/api/ideas/${id}`, { title: 'Übernommen' }],
      ['POST', `/api/ideas/${id}/comments`, { body: 'Fremder Kommentar' }],
      ['POST', `/api/ideas/${id}/support`, {}],
      ['POST', `/api/ideas/${id}/triage`, { lane: 'reject', reason: 'Fremde Ablehnung über eine geratene Kennung.' }],
      ['POST', `/api/ideas/${id}/question`, { question: 'Fremde Frage?' }],
      ['PUT', `/api/ideas/${id}/invention`, { check: 'possible' }],
      ['DELETE', `/api/ideas/${id}`],
    ];
    for (const [method, url, payload] of probes) {
      const res = await (method === 'GET' ? a.power.get(url) : method === 'DELETE' ? a.power.del(url) : a.power[method.toLowerCase() as 'post' | 'patch' | 'put'](url, payload));
      expect([403, 404], `${method} ${url} -> ${res.status}`).toContain(res.status);
    }
    const row = await withSystem(async (c) => (await c.query('SELECT title, status, invention_check FROM ideas WHERE id = $1', [id])).rows[0]);
    expect(row).toEqual({ title: 'Geheime Idee von B', status: 'submitted', invention_check: null });
    const comments = await withSystem(async (c) => (await c.query('SELECT count(*)::int AS n FROM comments WHERE idea_id = $1', [id])).rows[0].n);
    expect(comments).toBe(0);
  });

  it('does not list ideas, people or audit entries of another tenant', async () => {
    const ideas = (await a.power.get('/api/ideas')).body as { id: string }[];
    expect(ideas.map((i) => i.id)).not.toContain(ideaB);
    const people = JSON.stringify((await a.power.get('/api/admin/users')).body);
    expect(people).not.toMatch(/@b\.example/);
    const audit = JSON.stringify((await a.power.get('/api/admin/audit')).body);
    expect(audit).not.toContain(ideaB);
    // The other way round: B's triage does not see A's admin data.
    expect((await b.triage.get('/api/admin/users')).status).toBe(403);
  });

  it('cannot use a session of tenant A to sign in to tenant B', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenant: 'probe-b', email: 'power@a.example', password: PASSWORD } });
    expect(res.statusCode).toBe(401);
    void tenantB;
  });
});
