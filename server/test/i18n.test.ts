import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSystem } from '../src/db/pool.js';
import { de } from '../src/i18n/de/index.js';
import { en } from '../src/i18n/en/index.js';
import { m, tr } from '../src/i18n/index.js';
import { closePool } from '../src/db/pool.js';
import { notifyRoles } from '../src/services/notify.js';
import type { SessionUser } from '../src/lib/context.js';
import { asUser, client, createTenant, createUser, login, resetDb, testApp } from './helpers.js';

// Text catalogue (R2-50): server messages and mails in the language of the person.

let app: FastifyInstance;
let tenant: string;
let other: string;
let anna: SessionUser;
let ben: SessionUser;
let annaCookie: string;

beforeAll(async () => {
  await resetDb();
  app = await testApp();
  tenant = await createTenant('sprache');
  other = await createTenant('andere');
  anna = await createUser(tenant, 'anna@sprache.example', ['submitter', 'triage']);
  ben = await createUser(tenant, 'ben@sprache.example', ['submitter', 'triage']);
  await createUser(other, 'cara@andere.example', ['submitter', 'triage']);
  annaCookie = await login(app, 'sprache', anna.email);
});

afterAll(async () => {
  await app.close();
  await closePool();
});

describe('text catalogue', () => {
  it('has an English text for every German key', () => {
    const missing = Object.keys(de).filter((k) => !(k in en));
    expect(missing).toEqual([]);
  });

  it('fills variables and falls back to German', () => {
    expect(tr('de', m('common.rateLimited', { minutes: 3 }))).toContain('3 Minute(n)');
    expect(tr('en', m('common.rateLimited', { minutes: 3 }))).toContain('3 minute(s)');
    expect(tr('en', 'Text aus den Einstellungen')).toBe('Text aus den Einstellungen');
  });

  it('answers without a session in the language of the browser', async () => {
    const deRes = await app.inject({ method: 'GET', url: '/api/ideas', headers: { 'accept-language': 'de-DE,de;q=0.9' } });
    expect(deRes.statusCode).toBe(401);
    expect(deRes.json().error).toBe('Bitte melde dich an.');
    const enRes = await app.inject({ method: 'GET', url: '/api/ideas', headers: { 'accept-language': 'en-GB,en;q=0.9' } });
    expect(enRes.json().error).toBe('Please sign in.');
  });

  it('stores the language per person and uses it for errors', async () => {
    const api = client(app, annaCookie);
    expect((await api.put('/api/me/locale', { locale: 'fr' })).status).toBe(400);
    expect((await api.put('/api/me/locale', { locale: 'en' })).status).toBe(200);
    expect((await api.get('/api/me')).body.user.locale).toBe('en');
    const res = await app.inject({ method: 'GET', url: '/api/ideas/00000000-0000-0000-0000-000000000000', headers: { cookie: annaCookie, 'accept-language': 'de' } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).not.toMatch(/nicht|Nicht/);
  });

  it('writes each notification in the language of its recipient, only in the own workspace', async () => {
    await asUser(anna, tenant, (ctx) => notifyRoles(ctx, ['triage'], m('common.notFound'), m('common.rateLimited', { minutes: 5 })));
    const rows = await withSystem(async (c) =>
      (await c.query<{ to_email: string; subject: string; body: string }>('SELECT to_email, subject, body FROM outbox ORDER BY to_email')).rows,
    );
    expect(rows.map((r) => r.to_email)).toEqual(['anna@sprache.example', 'ben@sprache.example']);
    expect(rows[0]).toMatchObject({ subject: 'Not found.', body: expect.stringContaining('5 minute(s)') });
    expect(rows[1]).toMatchObject({ subject: 'Nicht gefunden.', body: expect.stringContaining('5 Minute(n)') });
    expect(ben.id).toBeTruthy();
  });
});
