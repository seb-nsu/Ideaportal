import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setProviderFactory, type ModelProvider } from '../src/ai/providers.js';
import { setWebSearch } from '../src/ai/search.js';
import type { AiSettings } from '../src/ai/settings.js';
import { drainAiJobs } from '../src/ai/worker.js';
import { config } from '../src/config.js';
import { closePool, withSystem } from '../src/db/pool.js';
import { newTotpSecret, totp } from '../src/lib/crypto.js';
import { clearOidcCache } from '../src/lib/oidc.js';
import { resetBuildInfo } from '../src/lib/version.js';
import { setConnectorHttp } from '../src/services/connectors.js';
import type { HttpRequest, HttpResponse } from '../src/services/connectorKinds.js';
import { startFakeIdp, type FakeIdp } from './fake-idp.js';
import { client, createTenant, createUser, login, resetDb, testApp, validIdea } from './helpers.js';

// Endpoints that had no test of their own (docs/enterprise/qualitaet-und-lieferkette.md): every
// block checks the happy path, the permission (403/401) and, where data is involved, that the
// other tenant cannot reach it (404).

const OPERATOR_TOKEN = 'operator-token-for-coverage-tests-0123456789';
const OPERATOR_TOTP = newTotpSecret();
const PUBLIC_BASE = 'https://93.184.216.34';
const SUBMIT = { confirmNotReport: true, boundaryAcknowledged: true };
const EXT_SETTINGS = { external: { enabled: true, moderation: 'post', maxLinks: 2 } };

type Api = ReturnType<typeof client>;
let app: FastifyInstance;
let tenant: string;
let other: string;
let api: Record<'admin' | 'triage' | 'mia' | 'max' | 'lead' | 'pat' | 'otherAdmin', Api>;
let anonymous: Api;
let today: string;

beforeAll(async () => {
  await resetDb();
  config.operatorToken = OPERATOR_TOKEN;
  config.operatorTotpSecret = OPERATOR_TOTP;
  app = await testApp();
  tenant = await createTenant('cov-a', { holidays: [], ...EXT_SETTINGS });
  other = await createTenant('cov-b', { holidays: [], ...EXT_SETTINGS });
  const people = {
    admin: await createUser(tenant, 'admin@cov-a.example', ['submitter', 'admin', 'triage']),
    triage: await createUser(tenant, 'triage@cov-a.example', ['submitter', 'triage']),
    mia: await createUser(tenant, 'mia@cov-a.example'),
    max: await createUser(tenant, 'max@cov-a.example'),
    lead: await createUser(tenant, 'lead@cov-a.example', ['submitter', 'lead']),
    pat: await createUser(tenant, 'pat@cov-a.example', ['submitter', 'mentor']),
    otherAdmin: await createUser(other, 'admin@cov-b.example', ['submitter', 'admin', 'triage', 'lead']),
  };
  api = {} as typeof api;
  for (const [k, u] of Object.entries(people)) api[k as keyof typeof api] = client(app, await login(app, k === 'otherAdmin' ? 'cov-b' : 'cov-a', u.email));
  anonymous = client(app, '');
  today = (await api.mia.get('/api/settings')).body.today;
});

afterEach(() => {
  setProviderFactory(null);
  setWebSearch(null);
  setConnectorHttp(null);
});

afterAll(async () => {
  config.operatorToken = undefined;
  config.operatorTotpSecret = undefined;
  await app.close();
  await closePool();
});

async function submittedIdea(as: Api, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await as.post('/api/ideas', { ...validIdea, ...extra });
  expect(created.status).toBe(201);
  expect((await as.post(`/api/ideas/${created.body.id}/submit`, SUBMIT)).status).toBe(200);
  return created.body.id;
}

async function auditActions(tenantId: string, action: string): Promise<number> {
  return withSystem(
    async (c) => (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = $2', [tenantId, action])).rows[0].n,
  );
}

async function setAi(patch: Partial<AiSettings>) {
  const current = (await api.admin.get('/api/admin/ai')).body.settings as AiSettings;
  const res = await api.admin.put('/api/admin/ai', { ...current, ...patch });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return current;
}

// ---------------------------------------------------------------- public endpoints

describe('public configuration and tenant lookup', () => {
  it('GET /api/public-config answers without sign-in', async () => {
    const res = await anonymous.get('/api/public-config');
    expect(res.status).toBe(200);
    expect(typeof res.body.signup).toBe('boolean');
    expect(typeof res.body.demo).toBe('boolean');
  });

  it('GET /api/version shows the app version and the build commit from GIT_COMMIT', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    const previous = process.env.GIT_COMMIT;
    try {
      process.env.GIT_COMMIT = 'ABCDEF1234567';
      resetBuildInfo();
      const res = await anonymous.get('/api/version');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ version: pkg.version, commit: 'abcdef1234567' });
      // Anything that is not a commit hash is not echoed.
      process.env.GIT_COMMIT = '<script>';
      resetBuildInfo();
      expect((await anonymous.get('/api/version')).body.commit).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.GIT_COMMIT;
      else process.env.GIT_COMMIT = previous;
      resetBuildInfo();
    }
  });

  it('GET /api/tenants/:slug shows name and slug only, 404 for unknown workspaces', async () => {
    const res = await anonymous.get('/api/tenants/cov-a');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: 'Mandant cov-a', slug: 'cov-a' });
    const missing = await anonymous.get('/api/tenants/does-not-exist');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------- administration

describe('POST /api/admin/jobs/run', () => {
  it('runs the deadline jobs of the own tenant for admins only', async () => {
    const res = await api.admin.post('/api/admin/jobs/run');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      reminders: expect.any(Number),
      escalations: expect.any(Number),
      closed: expect.any(Number),
      mailsSent: expect.any(Number),
    });
    expect((await api.mia.post('/api/admin/jobs/run')).status).toBe(403);
    expect((await api.triage.post('/api/admin/jobs/run')).status).toBe(403);
    expect((await anonymous.post('/api/admin/jobs/run')).status).toBe(401);
  });
});

describe('AI administration: evaluation and connection test', () => {
  it('POST /api/admin/ai/eval queues a manual evaluation (admin only)', async () => {
    expect((await api.mia.post('/api/admin/ai/eval')).status).toBe(403);
    const res = await api.admin.post('/api/admin/ai/eval');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true });
    await drainAiJobs();
    const evals = (await api.admin.get('/api/admin/ai/evals')).body as { trigger: string; status: string }[];
    expect(evals.some((e) => e.trigger === 'manual')).toBe(true);
    // The other tenant sees none of these runs.
    const foreign = (await api.otherAdmin.get('/api/admin/ai/evals')).body as { trigger: string }[];
    expect(foreign.some((e) => e.trigger === 'manual')).toBe(false);
  });

  it('POST /api/admin/ai/test checks the builtin provider and rejects unknown providers', async () => {
    expect((await api.mia.post('/api/admin/ai/test', { provider: 'builtin', model: 'regelbasiert' })).status).toBe(403);
    const ok = await api.admin.post('/api/admin/ai/test', { provider: 'builtin', model: 'regelbasiert' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, ms: 0 });
    expect((await api.admin.post('/api/admin/ai/test', { provider: 'nope', model: 'x' })).status).toBe(400);
    expect((await api.admin.post('/api/admin/ai/test', { provider: 'builtin' })).status).toBe(400);
  });

  it('POST /api/admin/ai/test calls an external provider, logs the action and reports failures', async () => {
    const current = await setAi({
      providers: [
        { id: 'builtin', name: 'Eingebaut', kind: 'builtin', baseUrl: '', hosting: 'local', keySource: 'none' },
        { id: 'anthropic', name: 'Anthropic Claude', kind: 'anthropic', baseUrl: '', hosting: 'other', keySource: 'tenant' },
      ] as AiSettings['providers'],
    });
    let fail = false;
    setProviderFactory((p) => {
      if (p.kind === 'builtin') throw new Error('builtin');
      const provider: ModelProvider = {
        async generate(req) {
          if (fail) throw new Error('connection refused');
          return { json: { ok: true }, inputTokens: 10, outputTokens: 5, servedBy: `${req.model}-served`, refused: false };
        },
      };
      return provider;
    });
    const ok = await api.admin.post('/api/admin/ai/test', { provider: 'anthropic', model: 'test-model' });
    expect(ok.body).toMatchObject({ ok: true, model: 'test-model-served' });
    fail = true;
    const bad = await api.admin.post('/api/admin/ai/test', { provider: 'anthropic', model: 'test-model' });
    expect(bad.status).toBe(200);
    expect(bad.body).toEqual({ ok: false, error: 'connection refused' });
    const log = (await api.admin.get('/api/admin/ai/log')).body as { agent: string; status: string }[];
    const tests = log.filter((l) => l.agent === 'connection_test');
    expect(tests.map((l) => l.status).sort()).toEqual(['error', 'ok']);
    await setAi({ providers: current.providers });
  });
});

describe('POST /api/admin/connectors/:id/rotate-secret', () => {
  it('issues a new callback secret, audited, admins of the own tenant only', async () => {
    const created = await api.admin.post('/api/admin/connectors', {
      kind: 'jira',
      name: 'Jira Rotation',
      baseUrl: PUBLIC_BASE,
      config: { project: 'ROT', itemType: 'Epic' },
      credentials: { email: 'bot@firma.example', apiToken: 'jira-token-rot' },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as string;
    const first = await api.admin.post(`/api/admin/connectors/${id}/rotate-secret`);
    expect(first.status).toBe(200);
    expect(first.body.callbackSecret).toMatch(/^\S{20,}$/);
    const second = await api.admin.post(`/api/admin/connectors/${id}/rotate-secret`);
    expect(second.body.callbackSecret).not.toBe(first.body.callbackSecret);
    // Stored encrypted, never in plain text.
    const stored = await withSystem(
      async (c) => (await c.query<{ s: string }>('SELECT callback_secret_enc AS s FROM connectors WHERE id = $1', [id])).rows[0].s,
    );
    expect(stored).not.toContain(second.body.callbackSecret);
    expect(await auditActions(tenant, 'connector.rotate_secret')).toBe(2);
    expect((await api.triage.post(`/api/admin/connectors/${id}/rotate-secret`)).status).toBe(403);
    expect((await api.otherAdmin.post(`/api/admin/connectors/${id}/rotate-secret`)).status).toBe(404);
    expect((await api.admin.post('/api/admin/connectors/not-a-uuid/rotate-secret')).status).toBe(400);
  });
});

describe('POST /api/admin/identity/check', () => {
  let idp: FakeIdp;
  const allowPrivate = config.oidcAllowPrivateUrls;

  beforeAll(async () => {
    config.oidcAllowPrivateUrls = true;
    clearOidcCache();
    idp = await startFakeIdp();
  });

  afterAll(async () => {
    config.oidcAllowPrivateUrls = allowPrivate;
    clearOidcCache();
    await idp.close();
  });

  it('reads the discovery document of the issuer', async () => {
    const res = await api.admin.post('/api/admin/identity/check', { issuer: idp.issuer });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, issuer: idp.issuer, authorizationEndpoint: `${idp.issuer}/authorize` });
  });

  it('reports an unreachable issuer without throwing, and is for admins only', async () => {
    const res = await api.admin.post('/api/admin/identity/check', { issuer: 'http://127.0.0.1:1/nothing' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(typeof res.body.reason).toBe('string');
    expect((await api.admin.post('/api/admin/identity/check', { issuer: '' })).status).toBe(400);
    expect((await api.mia.post('/api/admin/identity/check', { issuer: idp.issuer })).status).toBe(403);
  });
});

describe('PUT /api/admin/feature-requests', () => {
  it('switches the module per tenant, audited, admins only', async () => {
    expect((await api.mia.get('/api/feature-requests')).status).toBe(404);
    expect((await api.triage.put('/api/admin/feature-requests', { enabled: true, publicPage: false })).status).toBe(403);
    const on = await api.admin.put('/api/admin/feature-requests', { enabled: true, publicPage: false });
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ enabled: true, publicPage: false });
    expect((await api.mia.get('/api/feature-requests')).status).toBe(200);
    // Public page stays off; the other tenant is not affected.
    expect((await anonymous.get('/api/public/feature-requests/cov-a')).status).toBe(404);
    expect((await api.otherAdmin.get('/api/feature-requests')).status).toBe(404);
    expect(await auditActions(tenant, 'settings.feature_requests')).toBe(1);
    expect((await api.admin.put('/api/admin/feature-requests', { enabled: true })).status).toBe(400);
    expect((await api.admin.put('/api/admin/feature-requests', { enabled: false, publicPage: false })).status).toBe(200);
    expect((await api.mia.get('/api/feature-requests')).status).toBe(404);
  });
});

// ---------------------------------------------------------------- operator console

describe('operator console: logout and billing catalogue', () => {
  // One login for both tests: a TOTP code is accepted only once (replay protection).
  let cookie: string;

  beforeAll(async () => {
    const res = await app.inject({ method: 'POST', url: '/api/operator/login', payload: { token: OPERATOR_TOKEN, code: totp(OPERATOR_TOTP, Date.now()) } });
    expect(res.statusCode).toBe(200);
    cookie = `ip_operator=${res.cookies.find((c) => c.name === 'ip_operator')!.value}`;
  });

  it('GET /api/operator/billing/catalogue needs an operator session', async () => {
    expect((await anonymous.get('/api/operator/billing/catalogue')).status).toBe(401);
    // A tenant admin is no operator.
    expect((await api.admin.get('/api/operator/billing/catalogue')).status).toBe(401);
    const res = await client(app, cookie).get('/api/operator/billing/catalogue');
    expect(res.status).toBe(200);
    expect(res.body).toBeTruthy();
    expect(JSON.stringify(res.body).length).toBeGreaterThan(10);
  });

  it('POST /api/operator/logout ends the session and clears the cookie', async () => {
    const op = client(app, cookie);
    expect((await op.get('/api/operator/me')).status).toBe(200);
    const out = await app.inject({ method: 'POST', url: '/api/operator/logout', headers: { cookie, 'x-requested-with': 'fetch' } });
    expect(out.statusCode).toBe(200);
    const cleared = out.cookies.find((c) => c.name === 'ip_operator');
    expect(cleared?.value ?? '').toBe('');
    // The old cookie is worthless afterwards.
    expect((await op.get('/api/operator/me')).status).toBe(401);
    expect((await op.get('/api/operator/billing/catalogue')).status).toBe(401);
    // Logout without a session is harmless.
    expect((await anonymous.post('/api/operator/logout')).status).toBe(200);
  });
});

// ---------------------------------------------------------------- AI before and around an idea

describe('AI helpers: transcription, image description, challenge suggestions', () => {
  const audio = Buffer.from('fake-webm-audio').toString('base64');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');

  it('POST /api/ai/transcribe explains that the builtin provider has no speech, validates input and needs sign-in', async () => {
    expect((await anonymous.post('/api/ai/transcribe', { audio, mime: 'audio/webm' })).status).toBe(401);
    expect((await api.mia.post('/api/ai/transcribe', { audio, mime: 'video/mp4' })).status).toBe(400);
    const res = await api.mia.post('/api/ai/transcribe', { audio, mime: 'audio/webm;codecs=opus' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AI_NO_SPEECH');
  });

  it('POST /api/ai/transcribe uses a local speech model and logs the action', async () => {
    const current = await setAi({
      providers: [
        { id: 'builtin', name: 'Eingebaut', kind: 'builtin', baseUrl: '', hosting: 'local', keySource: 'none' },
        { id: 'whisper', name: 'Lokale Sprache', kind: 'openai_compatible', baseUrl: 'https://speech.example.org/v1', hosting: 'local', keySource: 'none' },
      ] as AiSettings['providers'],
      models: { ...((await api.admin.get('/api/admin/ai')).body.settings as AiSettings).models, speech: { provider: 'whisper', model: 'whisper-small' } },
    });
    const seen: { mime: string; model: string }[] = [];
    setProviderFactory((p) => {
      if (p.kind === 'builtin') throw new Error('builtin');
      return {
        async generate() {
          throw new Error('not used');
        },
        async transcribe(a, model) {
          seen.push({ mime: a.mime, model });
          return { text: 'Wir sollten die Kantine früher öffnen.', seconds: 4 };
        },
      };
    });
    const res = await api.mia.post('/api/ai/transcribe', { audio, mime: 'audio/webm;codecs=opus' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ text: 'Wir sollten die Kantine früher öffnen.' });
    expect(seen).toEqual([{ mime: 'audio/webm', model: 'whisper-small' }]);
    const log = (await api.admin.get('/api/admin/ai/log')).body as { agent: string; status: string }[];
    expect(log.some((l) => l.agent === 'transcribe' && l.status === 'ok')).toBe(true);
    await setAi({ providers: current.providers, models: current.models });
  });

  it('POST /api/ai/describe-image describes an image with the builtin provider and checks the type', async () => {
    const res = await api.mia.post('/api/ai/describe-image', { image: png, mime: 'image/png' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.builtin).toBe(true);
    expect(Array.isArray(res.body.warnings)).toBe(true);
    expect((await api.mia.post('/api/ai/describe-image', { image: png, mime: 'image/svg+xml' })).status).toBe(400);
    expect((await anonymous.post('/api/ai/describe-image', { image: png, mime: 'image/png' })).status).toBe(401);
  });

  it('POST /api/ai/challenge-suggestions is for triage and deciders and needs enough strategy text', async () => {
    const strategy =
      'Unsere Strategie 2027: Wir wollen Durchlaufzeiten im Service halbieren, die Kundenzufriedenheit messbar steigern und Energiekosten in der Produktion senken. '.repeat(
        2,
      );
    expect((await api.mia.post('/api/ai/challenge-suggestions', { text: strategy })).status).toBe(403);
    expect((await api.triage.post('/api/ai/challenge-suggestions', { text: 'zu kurz' })).status).toBe(400);
    expect(
      (await api.triage.post('/api/ai/challenge-suggestions', { file: { name: 'strategie.pdf', data: Buffer.from(strategy).toString('base64') } })).status,
    ).toBe(400);
    const res = await api.triage.post('/api/ai/challenge-suggestions', { file: { name: 'strategie.txt', data: Buffer.from(strategy).toString('base64') } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Array.isArray(res.body.warnings)).toBe(true);
    const saved = await withSystem(
      async (c) =>
        (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_results WHERE tenant_id = $1 AND kind = 'challenge_suggestions'`, [tenant])).rows[0].n,
    );
    expect(saved).toBe(1);
  });
});

describe('AI around an idea: reply draft and positioning map', () => {
  it('POST /api/ideas/:id/ai/reply-draft drafts a reply for triage only', async () => {
    const id = await submittedIdea(api.mia);
    expect((await api.mia.post(`/api/ideas/${id}/ai/reply-draft`, { lane: 'reject', reason: 'Gibt es schon.' })).status).toBe(403);
    expect((await api.triage.post(`/api/ideas/${id}/ai/reply-draft`, { lane: 'unknown' })).status).toBe(400);
    const res = await api.triage.post(`/api/ideas/${id}/ai/reply-draft`, { lane: 'reject', reason: 'Wird bereits im Projekt Kantine 2.0 umgesetzt.' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.model).toBeTruthy();
    expect(Array.isArray(res.body.warnings)).toBe(true);
    // Another tenant's triage does not find the idea.
    expect((await api.otherAdmin.post(`/api/ideas/${id}/ai/reply-draft`, { lane: 'reject' })).status).toBe(404);
  });

  it('PUT /api/ai/results/:id/positioning saves edited axes as a new version for those who work on it', async () => {
    const id = await submittedIdea(api.mia, { ideaType: 'product' });
    expect((await api.triage.post(`/api/ideas/${id}/triage`, { lane: 'elaborate' })).status).toBe(200);
    await drainAiJobs();
    const results = (await api.triage.get(`/api/ideas/${id}/ai`)).body.results as { id: string; kind: string; version: number }[];
    const positioning = results.find((r) => r.kind === 'positioning')!;
    const businessCase = results.find((r) => r.kind === 'business_case')!;
    expect(positioning).toBeTruthy();
    const body = {
      axisX: { label: 'Preis', low: 'günstig', high: 'teuer' },
      axisY: { label: 'Service', low: 'wenig', high: 'viel' },
      items: [
        { name: 'Unsere Idee', x: 3, y: 8, isIdea: true, priceOnRequest: false },
        { name: 'Anbieter A', x: 7, y: 4, isIdea: false, priceOnRequest: true },
      ],
    };
    expect((await api.max.put(`/api/ai/results/${positioning.id}/positioning`, body)).status).toBe(403);
    expect((await api.otherAdmin.put(`/api/ai/results/${positioning.id}/positioning`, body)).status).toBe(404);
    expect((await api.triage.put(`/api/ai/results/${businessCase.id}/positioning`, body)).status).toBe(400);
    expect((await api.triage.put(`/api/ai/results/${positioning.id}/positioning`, { ...body, items: [{ ...body.items[0], x: 11 }] })).status).toBe(400);
    const saved = await api.triage.put(`/api/ai/results/${positioning.id}/positioning`, body);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.version).toBe(positioning.version + 1);
    const latest = ((await api.triage.get(`/api/ideas/${id}/ai`)).body.results as { kind: string; data: typeof body; meta: { edited?: boolean } }[]).find(
      (r) => r.kind === 'positioning',
    )!;
    expect(latest.data.axisX).toEqual(body.axisX);
    expect(latest.meta.edited).toBe(true);
  });
});

// ---------------------------------------------------------------- external participation

describe('external participation: answers and consent texts', () => {
  let challengeId: string;
  let code: string;

  async function join(email: string): Promise<Api> {
    const info = JSON.parse((await app.inject({ method: 'GET', url: `/api/external/join/${code}` })).body);
    const res = await app.inject({
      method: 'POST',
      url: `/api/external/join/${code}`,
      payload: {
        name: `Person ${email}`,
        email,
        password: 'external-pass-123',
        termsId: info.terms.id,
        consentId: info.consent.id,
        acceptTerms: true,
        acceptConsent: true,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return client(app, `ip_session=${res.cookies.find((c) => c.name === 'ip_session')!.value}`);
  }

  beforeAll(async () => {
    const c = await api.admin.post('/api/challenges', {
      title: 'Service von morgen',
      question: 'Wie wird unser Service besser?',
      contact: 'Produktteam',
      startsOn: today,
      endsOn: '2099-12-31',
    });
    expect(c.status).toBe(201);
    challengeId = c.body.id;
    const enable = await api.admin.patch(`/api/admin/external/challenges/${challengeId}`, { externalEnabled: true });
    expect(enable.status).toBe(200);
    code = enable.body.link.split('/mitmachen/')[1];
  });

  it('POST /api/external/ideas/:id/answer: only the external author answers a question', async () => {
    const ext = await join('kundin@extern.example');
    const created = await ext.post(`/api/external/challenges/${challengeId}/ideas`, {
      title: 'Ersatzteile online bestellen',
      problem: 'Bestellungen per E-Mail dauern Tage und gehen verloren.',
      solution: 'Ein Bestellportal mit Lagerbestand und Lieferzeit je Teil.',
      benefit: 'Kürzere Stillstände und weniger Rückfragen.',
      ...SUBMIT,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as string;
    expect((await api.triage.post(`/api/ideas/${id}/question`, { question: 'Welche Teile bestellen Sie am häufigsten?' })).status).toBe(200);

    const second = await join('partner@extern.example');
    expect([403, 404]).toContain((await second.post(`/api/external/ideas/${id}/answer`, { answer: 'Fremde Antwort' })).status);
    // Internal people use the internal endpoint, not the external one.
    expect((await api.mia.post(`/api/external/ideas/${id}/answer`, { answer: 'Interne Antwort' })).status).toBe(403);
    expect((await ext.post(`/api/external/ideas/${id}/answer`, { answer: 'x' })).status).toBe(400);
    const ok = await ext.post(`/api/external/ideas/${id}/answer`, { answer: 'Vor allem Filter und Dichtungen.' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const detail = await api.triage.get(`/api/ideas/${id}`);
    expect(detail.body.status).not.toBe('in_question');
    expect(JSON.stringify(detail.body)).toContain('Vor allem Filter und Dichtungen.');
  });

  it('POST /api/admin/external/challenges/:id/consent adds a new consent text version (team only)', async () => {
    const text = 'Neue Einwilligung: Wir prüfen eingereichte Ideen auf Schutzrechte und melden uns innerhalb von vier Wochen.';
    expect((await api.mia.post(`/api/admin/external/challenges/${challengeId}/consent`, { body: text })).status).toBe(403);
    expect((await api.admin.post(`/api/admin/external/challenges/${challengeId}/consent`, { body: 'zu kurz' })).status).toBe(400);
    expect((await api.otherAdmin.post(`/api/admin/external/challenges/${challengeId}/consent`, { body: text })).status).toBe(404);
    expect((await api.admin.post('/api/admin/external/challenges/00000000-0000-4000-8000-000000000000/consent', { body: text })).status).toBe(404);
    const res = await api.triage.post(`/api/admin/external/challenges/${challengeId}/consent`, { body: text });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.version).toBe(2);
    const info = JSON.parse((await app.inject({ method: 'GET', url: `/api/external/join/${code}` })).body);
    expect(info.consent.version).toBe(2);
    expect(info.consent.body).toBe(text);
  });
});

// ---------------------------------------------------------------- impact, meetings, notifications, radar

describe('POST /api/ideas/:id/impact-metrics/:metricId/measure', () => {
  it('measures a connector metric on demand; manual metrics and outsiders are refused', async () => {
    const id = await submittedIdea(api.mia);
    const patId = (await api.pat.get('/api/me')).body.user.id;
    await withSystem((c) => c.query(`UPDATE ideas SET status = 'elaboration', mentor_id = $2 WHERE id = $1`, [id, patId]));
    const conn = await api.admin.post('/api/admin/connectors', {
      kind: 'jira',
      name: 'Jira Wirkung',
      baseUrl: PUBLIC_BASE,
      config: { project: 'SUP', itemType: 'Epic' },
      credentials: { email: 'bot@firma.example', apiToken: 'jira-token-measure' },
    });
    expect(conn.status).toBe(201);
    expect((await api.admin.post(`/api/admin/connectors/${conn.body.id}/enable`)).status).toBe(200);
    const metric = await api.pat.post(`/api/ideas/${id}/impact-metrics`, {
      name: 'Tickets zur Hotline',
      unit: 'Tickets',
      direction: 'decrease',
      source: 'connector',
      connectorId: conn.body.id,
      query: 'project = SUP AND created >= "{from}" AND created <= "{to}"',
      baselineFrom: '2026-01-01',
      baselineTo: '2026-01-31',
    });
    expect(metric.status, JSON.stringify(metric.body)).toBe(201);
    const manual = await api.pat.post(`/api/ideas/${id}/impact-metrics`, {
      name: 'Minuten je Anruf',
      unit: 'Minuten',
      direction: 'decrease',
      source: 'api',
      baselineFrom: '2026-01-01',
      baselineTo: '2026-01-31',
    });
    expect(manual.status).toBe(201);

    const requests: HttpRequest[] = [];
    setConnectorHttp(async (req: HttpRequest): Promise<HttpResponse> => {
      requests.push(req);
      if (req.method === 'POST' && new URL(req.url).pathname.endsWith('/approximate-count')) return { status: 200, json: { count: 120 } };
      return { status: 200, json: {} };
    });
    expect((await api.max.post(`/api/ideas/${id}/impact-metrics/${metric.body.id}/measure`)).status).toBe(403);
    expect((await api.otherAdmin.post(`/api/ideas/${id}/impact-metrics/${metric.body.id}/measure`)).status).toBe(404);
    const notConnector = await api.pat.post(`/api/ideas/${id}/impact-metrics/${manual.body.id}/measure`);
    expect(notConnector.status).toBe(409);
    expect(notConnector.body.code).toBe('METRIC_NOT_CONNECTOR');
    const res = await api.pat.post(`/api/ideas/${id}/impact-metrics/${metric.body.id}/measure`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.error).toBeNull();
    expect(requests.some((r) => r.url.endsWith('/approximate-count'))).toBe(true);
    const list = await api.pat.get(`/api/ideas/${id}/impact-metrics`);
    const measured = list.body.metrics.find((x: { id: string }) => x.id === metric.body.id);
    expect(measured.baseline).toMatchObject({ value: 120, source: 'connector' });
  });
});

describe('POST /api/meetings/:id/held', () => {
  it('closes a meeting for triage only; decisions afterwards are refused', async () => {
    const meetsOn = `${Number(today.slice(0, 4)) + 1}${today.slice(4)}`;
    const created = await api.triage.post('/api/meetings', { title: 'Gremium Abdeckung', meetsOn });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as string;
    expect((await api.mia.post(`/api/meetings/${id}/held`)).status).toBe(403);
    expect((await api.otherAdmin.post(`/api/meetings/${id}/held`)).status).toBe(404);
    expect((await api.triage.post(`/api/meetings/${id}/held`)).status).toBe(200);
    const detail = await api.triage.get(`/api/meetings/${id}`);
    expect(JSON.stringify(detail.body)).toContain('held');
    const ideaId = await submittedIdea(api.mia);
    const decide = await api.triage.post(`/api/meetings/${id}/decisions/${ideaId}`, { outcome: 'park', reason: 'Später erneut ansehen, Budget fehlt.' });
    expect(decide.status).toBe(409);
  });
});

describe('POST /api/notifications/read', () => {
  it('marks only the own notifications as read', async () => {
    const id = await submittedIdea(api.mia);
    expect((await api.triage.post(`/api/ideas/${id}/question`, { question: 'Wie viele Personen sind betroffen?' })).status).toBe(200);
    const before = await api.mia.get('/api/notifications');
    expect(before.status).toBe(200);
    expect(before.body.unread).toBeGreaterThan(0);
    const triageBefore = (await api.triage.get('/api/notifications')).body.unread as number;
    expect((await anonymous.post('/api/notifications/read')).status).toBe(401);
    expect((await api.mia.post('/api/notifications/read')).status).toBe(200);
    expect((await api.mia.get('/api/notifications')).body.unread).toBe(0);
    expect((await api.triage.get('/api/notifications')).body.unread).toBe(triageBefore);
  });
});

describe('POST /api/radar/digests/run', () => {
  it('runs the trend digests for radar managers only', async () => {
    expect((await api.mia.post('/api/radar/digests/run', {})).status).toBe(403);
    expect((await anonymous.post('/api/radar/digests/run', {})).status).toBe(401);
    expect((await api.lead.post('/api/radar/digests/run', { topics: ['x'.repeat(81)] })).status).toBe(400);
    const res = await api.lead.post('/api/radar/digests/run', { topics: ['Arbeitsumfeld'] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ week: expect.any(String), digests: expect.any(Number), mails: 0 });
    // Manual runs never send mails; the other tenant's list stays empty.
    const foreign = await api.otherAdmin.get('/api/radar/digests');
    expect(foreign.status).toBe(200);
    expect(JSON.stringify(foreign.body)).not.toContain('Arbeitsumfeld');
  });
});
