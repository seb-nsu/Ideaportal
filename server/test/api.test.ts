import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { closePool, withSystem, withTenant } from '../src/db/pool.js';
import type { SessionUser } from '../src/lib/context.js';
import { isSealed } from '../src/lib/secretbox.js';
import {
  BACKOFF_SECONDS,
  MAX_ATTEMPTS,
  SIGNATURE_HEADER,
  processWebhookDeliveries,
  verifySignature,
  type WebhookRequest,
} from '../src/services/webhooks.js';
import { asUser, client, createTenant, createUser, login, resetDb, testApp, validIdea } from './helpers.js';

// AP-12 (R3-17): API tokens with roles, expiry, revocation and audit; OpenAPI; webhooks with
// signature, retry, auto-disable and confidential payloads. Two tenants throughout.

let app: FastifyInstance;
let tenant: string;
let other: string;
let users: Record<string, SessionUser>;
let adminA: ReturnType<typeof client>;
let adminB: ReturnType<typeof client>;
let mia: ReturnType<typeof client>;

const SUBMIT = { confirmNotReport: true, boundaryAcknowledged: true };
const HOOK_URL = 'https://93.184.216.34/hook';

function bearer(token: string, extraHeaders: Record<string, string> = {}) {
  const call = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, payload: payload as object | undefined, headers: { authorization: `Bearer ${token}`, ...extraHeaders } });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, payload?: unknown) => call('POST', url, payload),
  };
}

async function newToken(roles: string[], extra: Record<string, unknown> = {}, as = adminA) {
  const r = await as.post('/api/admin/api-tokens', { name: `Konnektor ${roles.join('+')}`, roles, ...extra });
  expect(r.status).toBe(201);
  return r.body as { id: string; token: string; prefix: string };
}

/** Fake HTTP sender: records requests and answers with the given status; no network. */
function fakeSender(status: number | (() => number)) {
  const sent: WebhookRequest[] = [];
  const send = async (req: WebhookRequest) => {
    sent.push(req);
    return { status: typeof status === 'function' ? status() : status };
  };
  return { sent, send };
}

const deliveries = (t: string) =>
  withTenant(t, async (db) => (await db.query<{ id: string; event: string; payload: { data: Record<string, unknown> }; status: string; attempts: number; next_attempt_at: Date; subscription_id: string }>(
    'SELECT id, event, payload, status, attempts, next_attempt_at, subscription_id FROM webhook_deliveries ORDER BY created_at, event',
  )).rows);

beforeAll(async () => {
  await resetDb();
  app = await testApp();
  tenant = await createTenant('apia', { holidays: [] });
  other = await createTenant('apib', { holidays: [] });
  users = {
    admin: await createUser(tenant, 'admin@apia.example', ['submitter', 'admin']),
    mia: await createUser(tenant, 'mia@apia.example'),
    adminB: await createUser(other, 'admin@apib.example', ['submitter', 'admin']),
  };
  adminA = client(app, await login(app, 'apia', users.admin.email));
  adminB = client(app, await login(app, 'apib', users.adminB.email));
  mia = client(app, await login(app, 'apia', users.mia.email));
});

afterAll(async () => {
  config.rateLimitFactor = 100;
  await app.close();
  await closePool();
});

describe('API tokens (R3-17)', () => {
  it('shows the token once, stores only its hash and lists it without secret', async () => {
    const t = await newToken(['submitter']);
    expect(t.token).toMatch(/^ipt_[a-f0-9]{12}_/);
    const list = await adminA.get('/api/admin/api-tokens');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(t.token.slice(17));
    expect(list.body[0]).toMatchObject({ prefix: t.prefix, state: 'active', roles: ['submitter'] });
    const row = await withSystem(async (c) => (await c.query('SELECT token_hash FROM api_tokens WHERE id = $1', [t.id])).rows[0]);
    expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.token_hash).not.toContain(t.token);
    // Only admins manage tokens.
    expect((await mia.get('/api/admin/api-tokens')).status).toBe(403);
    expect((await mia.post('/api/admin/api-tokens', { name: 'x1', roles: ['submitter'] })).status).toBe(403);
  });

  it('acts as a technical user in its own tenant only (two tenants, RLS)', async () => {
    const t = await newToken(['submitter']);
    const api = bearer(t.token);
    const created = await api.post('/api/ideas', { ...validIdea, title: 'Idee über die API' });
    expect(created.status).toBe(201);
    // Bearer requests need neither JSON content type nor X-Requested-With (no CSRF with bearer).
    const submit = await app.inject({ method: 'POST', url: `/api/ideas/${created.body.id}/submit`, headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' }, payload: JSON.stringify(SUBMIT) });
    expect(submit.statusCode).toBe(200);
    const noCsrf = await app.inject({ method: 'POST', url: `/api/ideas/${created.body.id}/confirm-authorship`, headers: { authorization: `Bearer ${t.token}` } });
    expect(noCsrf.statusCode).not.toBe(415);

    const detail = await api.get(`/api/ideas/${created.body.id}`);
    expect(detail.status).toBe(200);
    const status = await api.get(`/api/ideas/${created.body.id}/status`);
    expect(status.body).toMatchObject({ status: 'submitted', number: created.body.number });
    expect(status.body.history.map((h: { to: string }) => h.to)).toContain('submitted');

    // The technical user is the author, hidden from the people list, and cannot log in.
    const author = await withSystem(async (c) => (await c.query(
      'SELECT u.technical, u.active, u.password_hash FROM ideas i JOIN users u ON u.id = i.author_id WHERE i.id = $1', [created.body.id],
    )).rows[0]);
    expect(author).toEqual({ technical: true, active: false, password_hash: null });
    const people = await adminA.get('/api/admin/users');
    expect(people.body.some((u: { email: string }) => u.email.endsWith('@tokens.invalid'))).toBe(false);

    // Tenant B: its own token sees nothing of tenant A.
    const tb = await newToken(['submitter', 'triage'], {}, adminB);
    const apiB = bearer(tb.token);
    expect((await apiB.get(`/api/ideas/${created.body.id}`)).status).toBe(404);
    expect((await apiB.get(`/api/ideas/${created.body.id}/status`)).status).toBe(404);
    const listB = await apiB.get('/api/ideas?scope=all');
    expect(listB.body.some((i: { id: string }) => i.id === created.body.id)).toBe(false);
    // Tokens of A are invisible to the admin of B.
    const tokensB = await adminB.get('/api/admin/api-tokens');
    expect(tokensB.body.map((x: { id: string }) => x.id)).toEqual([tb.id]);
    expect((await adminB.post(`/api/admin/api-tokens/${t.id}/revoke`)).status).toBe(404);
  });

  it('applies the roles of the token; admin only when confirmed explicitly', async () => {
    const sub = bearer((await newToken(['submitter'])).token);
    const idea = (await mia.post('/api/ideas', { ...validIdea, title: 'Triage über die API' })).body;
    await mia.post(`/api/ideas/${idea.id}/submit`, SUBMIT);
    expect((await sub.post(`/api/ideas/${idea.id}/triage`, { lane: 'reject', reason: 'Passt nicht in unser Themenfeld.' })).status).toBe(403);
    expect((await sub.get('/api/admin/users')).status).toBe(403);

    const triage = bearer((await newToken(['submitter', 'triage'])).token);
    const r = await triage.post(`/api/ideas/${idea.id}/triage`, { lane: 'reject', reason: 'Passt nicht in unser Themenfeld.' });
    expect(r.status).toBe(200);

    const refused = await adminA.post('/api/admin/api-tokens', { name: 'Admin-Token', roles: ['admin'] });
    expect(refused.status).toBe(400);
    const adminToken = bearer((await newToken(['submitter', 'admin'], { allowAdmin: true })).token);
    expect((await adminToken.get('/api/admin/users')).status).toBe(200);
    // Even an admin token cannot manage tokens or webhooks, delete the workspace or log in.
    for (const url of ['/api/admin/api-tokens', '/api/admin/webhooks']) {
      const res = await adminToken.get(url);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('TOKEN_NOT_ALLOWED');
    }
    expect((await adminToken.post('/api/admin/workspace/delete', {})).status).toBe(403);
    expect((await adminToken.post('/api/auth/logout', {})).status).toBe(403);
  });

  it('refuses expired and revoked tokens and logs create, use and revoke', async () => {
    const t = await newToken(['submitter']);
    const api = bearer(t.token);
    expect((await api.get('/api/ideas')).status).toBe(200);
    expect((await api.get('/api/ideas')).status).toBe(200);
    const used = await withSystem(async (c) => (await c.query('SELECT last_used_at FROM api_tokens WHERE id = $1', [t.id])).rows[0]);
    expect(used.last_used_at).not.toBeNull();

    expect((await adminA.post(`/api/admin/api-tokens/${t.id}/revoke`)).status).toBe(200);
    const revoked = await api.get('/api/ideas');
    expect(revoked.status).toBe(401);
    expect(revoked.body.code).toBe('TOKEN_INVALID');
    expect((await adminA.post(`/api/admin/api-tokens/${t.id}/revoke`)).status).toBe(404);

    const actions = await withTenant(tenant, async (db) => (await db.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE entity = 'api_token' AND entity_id = $1 ORDER BY id`, [t.id],
    )).rows.map((r) => r.action));
    // Use is logged once per hour, not per request.
    expect(actions).toEqual(['api_token.create', 'api_token.use', 'api_token.revoke']);

    const e = await newToken(['submitter'], { expiresInDays: 1 });
    await withSystem((c) => c.query(`UPDATE api_tokens SET expires_at = now() - interval '1 minute' WHERE id = $1`, [e.id]));
    expect((await bearer(e.token).get('/api/ideas')).status).toBe(401);
    expect((await adminA.get('/api/admin/api-tokens')).body.find((x: { id: string }) => x.id === e.id).state).toBe('expired');

    // A tampered secret with a valid prefix is refused as well.
    expect((await bearer(`${e.token.slice(0, 17)}${'x'.repeat(43)}`).get('/api/ideas')).status).toBe(401);
    expect((await bearer('nonsense').get('/api/ideas')).status).toBe(401);
  });

  it('refuses a bearer together with a session cookie', async () => {
    const t = await newToken(['submitter']);
    const cookie = await login(app, 'apia', users.mia.email);
    const res = await app.inject({ method: 'GET', url: '/api/ideas', headers: { authorization: `Bearer ${t.token}`, cookie } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('BEARER_WITH_COOKIE');
  });

  it('limits requests per token', async () => {
    const t = await newToken(['submitter']);
    config.rateLimitFactor = 0.01; // 300 per minute -> 3
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await bearer(t.token).get('/api/challenges')).status);
      expect(codes).toEqual([200, 200, 200, 429]);
      // Another token has its own budget.
      config.rateLimitFactor = 100;
      expect((await bearer((await newToken(['submitter'])).token).get('/api/challenges')).status).toBe(200);
    } finally {
      config.rateLimitFactor = 100;
    }
  });
});

describe('OpenAPI (R3-17)', () => {
  it('serves OpenAPI 3.1 generated from the zod schemas and a page without scripts', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/openapi.json' });
    expect(res.statusCode).toBe(200);
    const spec = JSON.parse(res.body);
    expect(spec.openapi).toBe('3.1.0');
    for (const p of ['/api/ideas', '/api/ideas/{id}', '/api/ideas/{id}/submit', '/api/ideas/{id}/status', '/api/ideas/{id}/comments', '/api/challenges', '/api/admin/webhooks', '/api/admin/api-tokens']) {
      expect(spec.paths[p], p).toBeDefined();
    }
    // Body schema comes from the zod schema of the route (title 3..140 characters).
    const create = spec.paths['/api/ideas'].post.requestBody.content['application/json'].schema;
    expect(create.properties.title).toMatchObject({ type: 'string', minLength: 3, maxLength: 140 });
    expect(Object.keys(spec.webhooks)).toEqual(['idea.submitted', 'idea.status_changed', 'idea.gate_decided', 'challenge.phase_changed']);
    expect(spec.components.securitySchemes.bearerAuth.scheme).toBe('bearer');

    const page = await app.inject({ method: 'GET', url: '/api/docs' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect(page.body).not.toContain('<script');
    expect(page.body).toContain('/api/ideas/{id}/submit');
    expect(page.body).toContain('/api/docs.css');
    const en = await app.inject({ method: 'GET', url: '/api/docs', headers: { 'accept-language': 'en' } });
    expect(en.body).toContain('Submit a draft');
  });
});

describe('webhooks (R3-17)', () => {
  let hookId: string;
  let secret: string;

  it('accepts https only and never private addresses', async () => {
    for (const url of ['http://93.184.216.34/hook', 'https://10.0.0.5/hook', 'https://127.0.0.1/hook', 'https://localhost/hook', 'https://169.254.169.254/latest', 'https://[::1]/x', 'https://intranet.local/x']) {
      const r = await adminA.post('/api/admin/webhooks', { name: 'Intern', url, events: ['idea.submitted'] });
      expect(r.status, url).toBe(400);
    }
    const r = await adminA.post('/api/admin/webhooks', { name: 'CRM', url: HOOK_URL, events: ['idea.submitted', 'idea.status_changed', 'idea.gate_decided'] });
    expect(r.status).toBe(201);
    expect(r.body.secret).toMatch(/^whsec_/);
    hookId = r.body.id;
    secret = r.body.secret;
    const stored = await withSystem(async (c) => (await c.query('SELECT secret_enc FROM webhook_subscriptions WHERE id = $1', [hookId])).rows[0].secret_enc);
    expect(isSealed(stored)).toBe(true);
    expect(stored).not.toContain(secret);
    const list = await adminA.get('/api/admin/webhooks');
    expect(JSON.stringify(list.body)).not.toContain(secret);
    expect((await adminA.patch(`/api/admin/webhooks/${hookId}`, { url: 'https://192.168.1.2/x' })).status).toBe(400);
    expect((await mia.get('/api/admin/webhooks')).status).toBe(403);
  });

  it('delivers signed events; the receiver can verify signature and replay window', async () => {
    const idea = (await mia.post('/api/ideas', { ...validIdea, title: 'Signierte Idee' })).body;
    await mia.post(`/api/ideas/${idea.id}/submit`, SUBMIT);
    const rows = (await deliveries(tenant)).filter((d) => (d.payload.data.idea as { id: string })?.id === idea.id);
    expect(rows.map((d) => d.event).sort()).toEqual(['idea.status_changed', 'idea.submitted']);
    // Tenant B has no deliveries; RLS hides A's rows.
    expect(await deliveries(other)).toEqual([]);

    const fake = fakeSender(204);
    const now = new Date();
    const res = await asUser(null, tenant, (ctx) => processWebhookDeliveries(ctx, { now, send: fake.send }));
    expect(res.delivered).toBeGreaterThanOrEqual(2);
    const req = fake.sent.find((s) => JSON.parse(s.body).data.idea?.id === idea.id && s.headers['x-ideenportal-event'] === 'idea.submitted')!;
    expect(req.url).toBe(HOOK_URL);
    const header = req.headers[SIGNATURE_HEADER];
    const t = Math.floor(now.getTime() / 1000);
    expect(verifySignature(secret, header, req.body, { now: t })).toBe(true);
    expect(verifySignature(secret, header, req.body.replace('Signierte', 'Gefälschte'), { now: t })).toBe(false);
    expect(verifySignature('whsec_other', header, req.body, { now: t })).toBe(false);
    // Replay window: the same request ten minutes later is refused.
    expect(verifySignature(secret, header, req.body, { now: t + 600 })).toBe(false);
    const payload = JSON.parse(req.body);
    expect(payload).toMatchObject({ type: 'idea.submitted', data: { idea: { id: idea.id, title: 'Signierte Idee', status: 'submitted', confidential: false } } });
    expect(req.body).not.toContain(validIdea.problem);
    // Delivery log for admins.
    const log = await adminA.get(`/api/admin/webhooks/${hookId}/deliveries`);
    expect(log.body.filter((d: { status: string }) => d.status === 'delivered').length).toBeGreaterThanOrEqual(2);
    expect((await mia.get(`/api/admin/webhooks/${hookId}/deliveries`)).status).toBe(403);
    expect((await adminB.get(`/api/admin/webhooks/${hookId}/deliveries`)).status).toBe(404);
  });

  it('sends confidential ideas with id, number and status only', async () => {
    const idea = (await mia.post('/api/ideas', { ...validIdea, title: 'Geheimes Projekt Falke', confidential: true })).body;
    await mia.post(`/api/ideas/${idea.id}/submit`, SUBMIT);
    const fake = fakeSender(200);
    await asUser(null, tenant, (ctx) => processWebhookDeliveries(ctx, { send: fake.send }));
    const mine = fake.sent.filter((s) => JSON.parse(s.body).data.idea?.id === idea.id);
    expect(mine.length).toBe(2);
    for (const s of mine) {
      expect(s.body).not.toContain('Falke');
      expect(s.body).not.toContain(validIdea.problem);
      expect(JSON.parse(s.body).data.idea).toEqual({ id: idea.id, number: idea.number, status: 'submitted', confidential: true });
    }
  });

  it('reports gate decisions made through a token', async () => {
    const idea = (await mia.post('/api/ideas', { ...validIdea, title: 'Gate über Token' })).body;
    await mia.post(`/api/ideas/${idea.id}/submit`, SUBMIT);
    const triage = bearer((await newToken(['submitter', 'triage'])).token);
    expect((await triage.post(`/api/ideas/${idea.id}/triage`, { lane: 'reject', reason: 'Passt nicht in unser Themenfeld.' })).status).toBe(200);
    const gate = (await deliveries(tenant)).find((d) => d.event === 'idea.gate_decided' && (d.payload.data.idea as { id: string }).id === idea.id);
    expect(gate?.payload.data).toMatchObject({ gate: 1, outcome: 'reject', idea: { status: 'rejected' } });
    await asUser(null, tenant, (ctx) => processWebhookDeliveries(ctx, { send: fakeSender(200).send }));
  });

  it('retries with exponential backoff and gives up after 6 attempts', async () => {
    expect((await adminA.post(`/api/admin/webhooks/${hookId}/test`)).status).toBe(200);
    const fake = fakeSender(500);
    let now = new Date();
    const expectedGaps: number[] = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const r = await asUser(null, tenant, (ctx) => processWebhookDeliveries(ctx, { now, send: fake.send }));
      expect(r.delivered).toBe(0);
      const d = (await deliveries(tenant)).find((x) => x.event === 'webhook.test')!;
      expect(d.attempts).toBe(attempt);
      if (attempt < MAX_ATTEMPTS) {
        expect(d.status).toBe('pending');
        const gap = (d.next_attempt_at.getTime() - now.getTime()) / 1000;
        expectedGaps.push(gap);
        // Not due before the backoff has passed.
        const early = await asUser(null, tenant, (ctx) => processWebhookDeliveries(ctx, { now: new Date(now.getTime() + (gap - 5) * 1000), send: fake.send }));
        expect(early.delivered + early.retried + early.failed).toBe(0);
        now = new Date(d.next_attempt_at.getTime() + 1000);
      } else {
        expect(d.status).toBe('failed');
      }
    }
    expect(expectedGaps).toEqual(BACKOFF_SECONDS);
    expect(fake.sent.length).toBe(MAX_ATTEMPTS);
    // Six failures in a row do not yet switch the webhook off; a success resets the counter.
    let sub = await withTenant(tenant, async (db) => (await db.query('SELECT active, failure_count FROM webhook_subscriptions WHERE id = $1', [hookId])).rows[0]);
    expect(sub).toEqual({ active: true, failure_count: 6 });
    await adminA.post(`/api/admin/webhooks/${hookId}/test`);
    await asUser(null, tenant, (ctx) => processWebhookDeliveries(ctx, { send: fakeSender(200).send }));
    sub = await withTenant(tenant, async (db) => (await db.query('SELECT active, failure_count FROM webhook_subscriptions WHERE id = $1', [hookId])).rows[0]);
    expect(sub).toEqual({ active: true, failure_count: 0 });
  });

  it('switches a webhook off after repeated failures and tells the admins', async () => {
    const created = await adminA.post('/api/admin/webhooks', { name: 'Kaputt', url: 'https://93.184.216.35/x', events: ['idea.submitted'] });
    const id = created.body.id as string;
    await adminA.post(`/api/admin/webhooks/${id}/test`);
    await adminA.post(`/api/admin/webhooks/${id}/test`);
    const fake = fakeSender(() => { throw new Error('connection refused'); });
    let now = new Date();
    let disabled = 0;
    for (let i = 0; i < 6 && !disabled; i++) {
      const r = await asUser(null, tenant, (ctx) => processWebhookDeliveries(ctx, { now, send: fake.send }));
      disabled += r.disabled;
      now = new Date(now.getTime() + 86_400_000);
    }
    expect(disabled).toBe(1);
    const sub = await withTenant(tenant, async (db) => (await db.query('SELECT active, failure_count, disabled_reason FROM webhook_subscriptions WHERE id = $1', [id])).rows[0]);
    expect(sub).toEqual({ active: false, failure_count: 10, disabled_reason: 'failures' });
    const left = (await deliveries(tenant)).filter((d) => d.subscription_id === id);
    expect(left.every((d) => d.status === 'failed')).toBe(true);
    const notice = await withTenant(tenant, async (db) => (await db.query('SELECT user_id FROM outbox WHERE subject = $1', ['Webhook „Kaputt“ abgeschaltet'])).rows);
    expect(notice.map((n) => n.user_id)).toEqual([users.admin.id]);
    // Switched off: no new deliveries; switching on again resets the counter.
    const idea = (await mia.post('/api/ideas', { ...validIdea, title: 'Nach dem Abschalten' })).body;
    await mia.post(`/api/ideas/${idea.id}/submit`, SUBMIT);
    expect((await deliveries(tenant)).filter((d) => d.subscription_id === id && (d.payload.data.idea as { id: string } | undefined)?.id === idea.id)).toEqual([]);
    expect((await adminA.patch(`/api/admin/webhooks/${id}`, { active: true })).status).toBe(200);
    const on = await withTenant(tenant, async (db) => (await db.query('SELECT active, failure_count, disabled_at FROM webhook_subscriptions WHERE id = $1', [id])).rows[0]);
    expect(on).toEqual({ active: true, failure_count: 0, disabled_at: null });
    // Audit log has the automatic switch-off.
    const audit = await withTenant(tenant, async (db) => (await db.query(`SELECT 1 FROM audit_log WHERE action = 'webhook.disabled' AND entity_id = $1`, [id])).rowCount);
    expect(audit).toBe(1);
    expect((await adminA.del(`/api/admin/webhooks/${id}`)).status).toBe(200);
  });

  it('keeps subscriptions of the other tenant apart and rotates the secret', async () => {
    const b = await adminB.post('/api/admin/webhooks', { name: 'System B', url: 'https://93.184.216.36/b', events: ['idea.submitted'] });
    expect(b.status).toBe(201);
    expect((await adminA.get('/api/admin/webhooks')).body.some((w: { id: string }) => w.id === b.body.id)).toBe(false);
    expect((await adminA.patch(`/api/admin/webhooks/${b.body.id}`, { active: false })).status).toBe(404);
    // An event in A creates nothing for B.
    const idea = (await mia.post('/api/ideas', { ...validIdea, title: 'Nur für A' })).body;
    await mia.post(`/api/ideas/${idea.id}/submit`, SUBMIT);
    expect(await deliveries(other)).toEqual([]);
    const rotated = await adminA.post(`/api/admin/webhooks/${hookId}/rotate-secret`);
    expect(rotated.body.secret).toMatch(/^whsec_/);
    expect(rotated.body.secret).not.toBe(secret);
    const fake = fakeSender(200);
    const now = new Date();
    await asUser(null, tenant, (ctx) => processWebhookDeliveries(ctx, { now, send: fake.send }));
    const sent = fake.sent.find((s) => JSON.parse(s.body).data.idea?.id === idea.id)!;
    expect(verifySignature(rotated.body.secret, sent.headers[SIGNATURE_HEADER], sent.body, { now: Math.floor(now.getTime() / 1000) })).toBe(true);
    expect(verifySignature(secret, sent.headers[SIGNATURE_HEADER], sent.body, { now: Math.floor(now.getTime() / 1000) })).toBe(false);
  });
});
