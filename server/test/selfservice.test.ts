import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { features } from '../src/config.js';
import { ensureDemoTenant } from '../src/db/seed.js';
import { closePool, withSystem } from '../src/db/pool.js';
import { PASSWORD, client, createTenant, createUser, resetDb, testApp } from './helpers.js';

// Self-service without a company login: own workspace, join link, demo, login without tenant.

let app: FastifyInstance;

beforeAll(async () => {
  await resetDb();
  app = await testApp();
});

afterAll(async () => {
  await app.close();
  await closePool();
});

const cookieOf = (res: { cookies: { name: string; value: string }[] }) => `ip_session=${res.cookies.find((c) => c.name === 'ip_session')!.value}`;

describe('sign-up (capstone self-service)', () => {
  let founder: ReturnType<typeof client>;

  it('creates a workspace with the founder as admin, triage and committee', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/signup',
      payload: { workspace: 'Grüne Küche GmbH', name: 'Frieda Gründerin', email: 'frieda@kueche.example', password: 'sehr-geheim-123', acceptPrivacy: true },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).slug).toBe('gruene-kueche-gmbh');
    founder = client(app, cookieOf(res));
    const me = await founder.get('/api/me');
    expect(me.body.user.roles).toEqual(expect.arrayContaining(['admin', 'triage', 'committee']));
    expect(me.body.mfaSetupRequired).toBe(false);
    // Starter content: one example idea waiting for triage, one implemented example (R3-02) and a first challenge (R1-38).
    const ideas = await founder.get('/api/ideas?scope=all');
    expect(ideas.body.items ?? ideas.body).toHaveLength(2);
    expect((await founder.get('/api/challenges')).body.length).toBe(1);
  });

  it('requires accepting the privacy notice and a password of 10+ characters', async () => {
    const base = { workspace: 'Team X', name: 'Xaver', email: 'x@x.example', password: 'kurz', acceptPrivacy: true };
    expect((await app.inject({ method: 'POST', url: '/api/signup', payload: base })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/signup', payload: { ...base, password: 'lang-genug-123', acceptPrivacy: false } })).statusCode).toBe(400);
  });

  it('lets colleagues join with the link, and a reset link stops the old one', async () => {
    const { code } = (await founder.get('/api/admin/join-link')).body;
    expect(code).toBeTruthy();
    expect((await app.inject({ method: 'GET', url: `/api/join/${code}` })).json().name).toBe('Grüne Küche GmbH');
    const join = await app.inject({
      method: 'POST', url: `/api/join/${code}`,
      payload: { name: 'Jonas Kollege', email: 'jonas@kueche.example', password: 'auch-geheim-123', acceptPrivacy: true },
    });
    expect(join.statusCode).toBe(201);
    const jonas = client(app, cookieOf(join));
    expect((await jonas.get('/api/me')).body.user.roles).toEqual(['submitter']);
    expect((await jonas.get('/api/admin/join-link')).status).toBe(403);

    const again = await app.inject({ method: 'POST', url: `/api/join/${code}`, payload: { name: 'Jonas', email: 'JONAS@kueche.example', password: 'auch-geheim-123', acceptPrivacy: true } });
    expect(again.statusCode).toBe(409);

    const reset = await founder.post('/api/admin/join-link', { enabled: true });
    expect(reset.body.code).not.toBe(code);
    expect((await app.inject({ method: 'GET', url: `/api/join/${code}` })).statusCode).toBe(404);
    await founder.post('/api/admin/join-link', { enabled: false });
    expect((await founder.get('/api/admin/join-link')).body.code).toBeNull();
  });

  it('keeps the new workspace separate from other workspaces', async () => {
    const other = await createTenant('andere');
    await createUser(other, 'someone@andere.example');
    const users = await founder.get('/api/users?q=someone');
    expect(users.body).toHaveLength(0);
  });

  it('can be switched off', async () => {
    features.signup = false;
    const res = await app.inject({ method: 'POST', url: '/api/signup', payload: { workspace: 'Aus', name: 'Aus', email: 'a@aus.example', password: 'lang-genug-123', acceptPrivacy: true } });
    features.signup = true;
    expect(res.statusCode).toBe(403);
  });
});

describe('login without a tenant field', () => {
  it('logs in directly when the e-mail address belongs to one workspace', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'frieda@kueche.example', password: 'sehr-geheim-123' } });
    expect(res.statusCode).toBe(200);
  });

  it('asks which workspace when the same address exists in several', async () => {
    const a = await createTenant('erste');
    const b = await createTenant('zweite');
    await createUser(a, 'doppelt@x.example');
    await createUser(b, 'doppelt@x.example');
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'doppelt@x.example', password: PASSWORD } });
    expect(res.json().chooseWorkspace.map((w: { slug: string }) => w.slug).sort()).toEqual(['erste', 'zweite']);
    expect(res.cookies.find((c) => c.name === 'ip_session')).toBeUndefined();
    const chosen = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenant: 'zweite', email: 'doppelt@x.example', password: PASSWORD } });
    expect(chosen.statusCode).toBe(200);
  });
});

describe('demo', () => {
  it('is off unless DEMO_MODE is set', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/demo/login', payload: { role: 'triage' } })).statusCode).toBe(404);
  });

  it('logs in with a chosen role into the demo workspace', async () => {
    features.demo = true;
    try {
      await ensureDemoTenant();
      const via = await withSystem(async (c) => (await c.query("SELECT created_via FROM tenants WHERE slug = 'demo'")).rows[0].created_via);
      expect(via).toBe('demo');
      const res = await app.inject({ method: 'POST', url: '/api/demo/login', payload: { role: 'triage' } });
      expect(res.statusCode).toBe(200);
      const me = await client(app, cookieOf(res)).get('/api/me');
      expect(me.body.user.roles).toContain('triage');
      expect(me.body.demo).toBe(true);
      const admin = client(app, cookieOf(await app.inject({ method: 'POST', url: '/api/demo/login', payload: { role: 'admin' } })));
      expect((await admin.post('/api/admin/workspace/delete', { confirm: 'Demo AG' })).status).toBe(403);
    } finally {
      features.demo = false;
    }
  });
  it('opens the English demo workspace for an English page (R3-22)', async () => {
    features.demo = true;
    try {
      await ensureDemoTenant();
      const res = await app.inject({ method: 'POST', url: '/api/demo/login', payload: { role: 'submitter', locale: 'en' } });
      expect(res.statusCode).toBe(200);
      const me = await client(app, cookieOf(res)).get('/api/me');
      expect(me.body.tenant.slug).toBe('demo-en');
      expect(me.body.demo).toBe(true);
      const byHeader = await app.inject({ method: 'POST', url: '/api/demo/login', headers: { 'accept-language': 'en-GB,en;q=0.9' }, payload: { role: 'triage' } });
      expect((await client(app, cookieOf(byHeader)).get('/api/me')).body.tenant.slug).toBe('demo-en');
      const rows = await withSystem(async (c) => (await c.query<{ title: string; locale: string; warnings: string[] }>(
        `SELECT i.title, t.settings->>'locale' AS locale, (SELECT r.content->'warnings' FROM ai_results r WHERE r.idea_id = i.id LIMIT 1) AS warnings
           FROM ideas i JOIN tenants t ON t.id = i.tenant_id WHERE t.slug = 'demo-en' ORDER BY i.title`,
      )).rows);
      expect(rows.map((r) => r.title)).toEqual(['Digital leave requests instead of a paper form', 'Motion sensors for the warehouse lights', 'Self-service portal for spare part orders']);
      expect(rows.every((r) => r.locale === 'en')).toBe(true);
      expect(rows[0].warnings[0]).toMatch(/^Example result for the demo/);
      for (const r of rows) expect(r.title).not.toMatch(/[äöüß]/);
    } finally {
      features.demo = false;
    }
  });
});
