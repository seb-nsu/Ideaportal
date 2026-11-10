import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closePool, withSystem, withTenant } from '../src/db/pool.js';
import type { SessionUser } from '../src/lib/context.js';
import { addWorkdays } from '../src/lib/workdays.js';
import { dispatchMail } from '../src/services/mailer.js';
import { notifyUser } from '../src/services/notify.js';
import { applyRetention } from '../src/services/privacy.js';
import { purgeDueTenants } from '../src/services/tenantLifecycle.js';
import { PASSWORD, asUser, client, createTenant, createUser, login, resetDb, testApp, validIdea } from './helpers.js';

// Open pilot features of Release 1: deputies (R1-11), notification settings and digest (R1-36),
// co-authors (R1-15), merging (R1-20), attachments (R1-13), import (R1-39),
// data protection and retention (R1-40), deleting a workspace (R1-43).

let app: FastifyInstance;
let tenant: string;
let other: string;
let users: Record<string, SessionUser>;
let api: Record<string, ReturnType<typeof client>>;

beforeAll(async () => {
  await resetDb();
  app = await testApp();
  tenant = await createTenant('pilot');
  other = await createTenant('nachbar');
  users = {
    mia: await createUser(tenant, 'mia@p.example'),
    max: await createUser(tenant, 'max@p.example'),
    triage: await createUser(tenant, 'triage@p.example', ['submitter', 'triage']),
    owner: await createUser(tenant, 'owner@p.example', ['submitter', 'implementer']),
    deputy: await createUser(tenant, 'deputy@p.example', ['submitter', 'implementer']),
    admin: await createUser(tenant, 'admin@p.example', ['submitter', 'admin']),
    stranger: await createUser(other, 'stranger@n.example', ['submitter', 'admin']),
  };
  api = {};
  for (const [k, u] of Object.entries(users)) api[k] = client(app, await login(app, k === 'stranger' ? 'nachbar' : 'pilot', u.email));
});

afterAll(async () => {
  await app.close();
  await closePool();
});

async function submitted(by = 'mia', extra: Record<string, unknown> = {}): Promise<string> {
  const created = await api[by].post('/api/ideas', { ...validIdea, ...extra });
  expect(created.status).toBe(201);
  expect((await api[by].post(`/api/ideas/${created.body.id}/submit`, { confirmNotReport: true, boundaryAcknowledged: true })).status).toBe(200);
  return created.body.id;
}

const today = () => asUser(null, tenant, async (ctx) => ctx.today);

describe('absences and deputies (R1-11)', () => {
  let ideaId: string;

  beforeAll(async () => {
    ideaId = await submitted('mia', { title: 'Lagerregale beschriften' });
    const target = await asUser(null, tenant, async (ctx) => addWorkdays(ctx.today, 10, ctx.holidays));
    const res = await api.triage.post(`/api/ideas/${ideaId}/triage`, { lane: 'fast_lane', ownerId: users.owner.id, orgUnit: 'Lager', targetDate: target });
    expect(res.status).toBe(200);
  });

  it('rejects invalid absences', async () => {
    const t = await today();
    expect((await api.owner.post('/api/me/absences', { deputyId: users.owner.id, startsOn: t, endsOn: t })).status).toBe(400);
    expect((await api.owner.post('/api/me/absences', { deputyId: users.stranger.id, startsOn: t, endsOn: t })).status).toBe(400);
  });

  it('gives the deputy the tasks and rights of the absent person', async () => {
    expect((await api.deputy.get(`/api/ideas/${ideaId}`)).status).toBe(200); // public idea
    expect((await api.deputy.post(`/api/ideas/${ideaId}/implementation/accept`)).status).toBe(403);
    const t = await today();
    const created = await api.owner.post('/api/me/absences', { deputyId: users.deputy.id, startsOn: t, endsOn: t, note: 'Urlaub' });
    expect(created.status).toBe(201);
    const tasks = await api.deputy.get('/api/tasks');
    expect(tasks.body.implementations.map((i: { id: string }) => i.id)).toContain(ideaId);
    expect((await api.deputy.post(`/api/ideas/${ideaId}/implementation/accept`)).status).toBe(200);
    expect((await api.deputy.get('/api/me/absences')).body[0].userName).toBe('owner');
  });

  it('redirects task notifications to the deputy but not personal ones', async () => {
    await asUser(null, tenant, async (ctx) => {
      await notifyUser(ctx, users.owner.id, 'Umsetzung im Verzug', 'Bitte aktualisieren.', ideaId, 'reminders');
      await notifyUser(ctx, users.owner.id, 'Neuer Kommentar', 'Zu deiner Idee.', ideaId, 'community');
    });
    const deputy = (await api.deputy.get('/api/notifications')).body.items.map((n: { subject: string }) => n.subject);
    expect(deputy).toContain('[Vertretung für owner] Umsetzung im Verzug');
    const owner = (await api.owner.get('/api/notifications')).body.items.map((n: { subject: string }) => n.subject);
    expect(owner).toContain('Neuer Kommentar');
    expect(owner).not.toContain('Umsetzung im Verzug');
  });

  it('ends the deputy rights when the absence is removed', async () => {
    const [a] = (await api.owner.get('/api/me/absences')).body;
    expect((await api.deputy.del(`/api/me/absences/${a.id}`)).status).toBe(404);
    expect((await api.owner.del(`/api/me/absences/${a.id}`)).status).toBe(200);
    expect((await api.deputy.patch(`/api/ideas/${ideaId}/implementation`, { progress: 50 })).status).toBe(403);
  });
});

describe('notification settings and daily digest (R1-36)', () => {
  it('mails immediately, as a digest or not at all', async () => {
    const send = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await api.max.put('/api/me/preferences', { notifyEmail: 'daily', muted: ['community'] });
    expect((await api.max.get('/api/me/preferences')).body).toEqual({ notifyEmail: 'daily', muted: ['community'] });
    await withSystem((c) => c.query('UPDATE outbox SET sent_at = now()'));

    const run = (day?: string) => asUser(null, tenant, async (ctx) => dispatchMail(ctx), day);
    await asUser(null, tenant, async (ctx) => {
      await notifyUser(ctx, users.max.id, 'Status geändert', 'Deine Idee ist in der Ausarbeitung.', undefined, 'my_ideas');
      await notifyUser(ctx, users.max.id, 'Frist läuft ab', 'Bitte entscheiden.', undefined, 'reminders');
      await notifyUser(ctx, users.max.id, 'Neuer Kommentar', 'Hallo', undefined, 'community');
    });
    // Muted community mail is closed without a digest entry; the other two go into one digest.
    expect(await run()).toBe(1);
    expect(await run()).toBe(0); // only one digest per day
    const pending = await withTenant(tenant, (db) => db.query("SELECT count(*)::int AS n FROM outbox WHERE sent_at IS NULL"));
    expect(pending.rows[0].n).toBe(0);
    // Still visible in the portal.
    expect((await api.max.get('/api/notifications')).body.items).toHaveLength(3);
    send.mockRestore();
  });

  it('rejects unknown categories', async () => {
    expect((await api.max.put('/api/me/preferences', { notifyEmail: 'weekly', muted: [] })).status).toBe(400);
  });
});

describe('co-authors (R1-15) and merging (R1-20)', () => {
  it('lets the author add co-authors who then see and edit the idea in "mine"', async () => {
    const created = await api.mia.post('/api/ideas', { ...validIdea, title: 'Gemeinsame Idee zur Mülltrennung', confidential: true });
    expect((await api.max.get(`/api/ideas/${created.body.id}`)).status).toBe(404);
    expect((await api.max.post(`/api/ideas/${created.body.id}/coauthors`, { userId: users.max.id })).status).toBe(404);
    expect((await api.mia.post(`/api/ideas/${created.body.id}/coauthors`, { userId: users.max.id })).status).toBe(200);
    expect((await api.mia.post(`/api/ideas/${created.body.id}/coauthors`, { userId: users.stranger.id })).status).toBe(400);
    const mine = await api.max.get('/api/ideas?scope=mine');
    expect(mine.body.map((i: { id: string }) => i.id)).toContain(created.body.id);
    const detail = await api.max.get(`/api/ideas/${created.body.id}`);
    expect(detail.body.coauthors.map((c: { name: string }) => c.name)).toEqual(['max']);
    expect((await api.mia.del(`/api/ideas/${created.body.id}/coauthors/${users.max.id}`)).status).toBe(200);
    expect((await api.max.get(`/api/ideas/${created.body.id}`)).status).toBe(404);
  });

  it('merges a duplicate into the original and keeps its authors and supporters', async () => {
    const original = await submitted('mia', { title: 'Fahrradständer am Haupteingang' });
    const duplicate = await submitted('max', { title: 'Mehr Fahrradstellplätze vor dem Eingang' });
    await api.owner.post(`/api/ideas/${duplicate}/support`);
    expect((await api.max.post(`/api/ideas/${duplicate}/merge`, { targetId: original, reason: 'Gleiche Idee, bereits eingereicht.' })).status).toBe(403);
    expect((await api.triage.post(`/api/ideas/${duplicate}/merge`, { targetId: original, reason: 'Gleiche Idee, bereits eingereicht.' })).status).toBe(200);

    const merged = await api.max.get(`/api/ideas/${duplicate}`);
    expect(merged.body.status).toBe('merged');
    expect(merged.body.mergedInto.id).toBe(original);
    const target = await api.mia.get(`/api/ideas/${original}`);
    expect(target.body.coauthors.map((c: { name: string }) => c.name)).toContain('max');
    expect(target.body.supporters).toBeGreaterThanOrEqual(1);
    const list = await api.mia.get('/api/ideas');
    expect(list.body.map((i: { id: string }) => i.id)).not.toContain(duplicate);
    const notes = (await api.max.get('/api/notifications')).body.items.map((n: { subject: string }) => n.subject).join(' ');
    expect(notes).toMatch(/zusammengeführt/i);
  });
});

describe('attachments (R1-13)', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

  it('accepts allowed types and checks the content, not the name', async () => {
    const id = await submitted('mia', { title: 'Skizze für den Pausenraum' });
    const ok = await api.mia.post(`/api/ideas/${id}/attachments`, { filename: '../skizze.png', data: png.toString('base64') });
    expect(ok.status).toBe(201);
    expect((await api.mia.post(`/api/ideas/${id}/attachments`, { filename: 'virus.exe', data: png.toString('base64') })).status).toBe(400);
    expect((await api.mia.post(`/api/ideas/${id}/attachments`, { filename: 'fake.pdf', data: png.toString('base64') })).status).toBe(400);
    expect((await api.max.post(`/api/ideas/${id}/attachments`, { filename: 'x.png', data: png.toString('base64') })).status).toBe(400);

    const detail = await api.max.get(`/api/ideas/${id}`);
    expect(detail.body.attachments[0].filename).toBe('skizze.png');
    const file = await app.inject({ method: 'GET', url: `/api/ideas/${id}/attachments/${ok.body.id}`, headers: { cookie: await login(app, 'pilot', 'max@p.example') } });
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['content-disposition']).toMatch(/^attachment/);
    expect(file.rawPayload.equals(png)).toBe(true);
    // Another tenant cannot read it.
    expect((await api.stranger.get(`/api/ideas/${id}/attachments/${ok.body.id}`)).status).toBe(404);
  });
});

describe('import from CSV (R1-39)', () => {
  const csv = [
    'Titel;Problem;Lösung;Nutzen;Themenfeld;E-Mail',
    'Papierlose Reisekosten;Belege gehen verloren;App zum Fotografieren;Zeitersparnis;Prozesse und Effizienz;mia@p.example',
    '"Kaffeemaschine; zweite Etage";Lange Wege;Zweite Maschine;Weniger Wege;Arbeitsumfeld;unbekannt@p.example',
    'Papierlose Reisekosten;Doppelt;;;;',
    'x;zu kurz;;;;',
  ].join('\n');
  const data = Buffer.from(csv, 'utf8').toString('base64');

  it('shows a preview first and creates nothing', async () => {
    expect((await api.mia.post('/api/admin/import', { filename: 'alt.csv', data })).status).toBe(403);
    const res = await api.admin.post('/api/admin/import', { filename: 'alt.csv', data, dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.mapping).toMatchObject({ title: 0, problem: 1, solution: 2, benefit: 3, topic: 4, email: 5 });
    expect(res.body.report).toMatchObject({ total: 4, imported: 2, duplicates: [4], skipped: [5], unknownAuthors: 1 });
    expect(res.body.preview[1].title).toBe('Kaffeemaschine; zweite Etage');
    const n = await withTenant(tenant, (db) => db.query("SELECT count(*)::int AS n FROM ideas WHERE imported"));
    expect(n.rows[0].n).toBe(0);
  });

  it('imports ideas as submitted with a Gate 1 deadline', async () => {
    const res = await api.admin.post('/api/admin/import', { filename: 'alt.csv', data, dryRun: false });
    expect(res.body.report.imported).toBe(2);
    const rows = await withTenant(tenant, (db) => db.query<{ title: string; status: string; author: string; due: string | null }>(
      `SELECT i.title, i.status, u.email AS author, d.due_on AS due FROM ideas i JOIN users u ON u.id = i.author_id
         LEFT JOIN deadlines d ON d.idea_id = i.id AND d.phase = 'gate1' WHERE i.imported ORDER BY i.number`,
    ));
    expect(rows.rows.map((r) => [r.title, r.status, r.author])).toEqual([
      ['Papierlose Reisekosten', 'submitted', 'mia@p.example'],
      ['Kaffeemaschine; zweite Etage', 'submitted', 'admin@p.example'],
    ]);
    expect(rows.rows.every((r) => r.due)).toBe(true);
    // Importing the same file again finds the duplicates.
    expect((await api.admin.post('/api/admin/import', { filename: 'alt.csv', data, dryRun: true })).body.report.imported).toBe(0);
  });

  it('accepts a manual column mapping', async () => {
    const res = await api.admin.post('/api/admin/import', { filename: 'alt.csv', data, mapping: { title: 1 }, dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.preview[0].title).toBe('Belege gehen verloren');
  });

  it('rejects files that cannot be read', async () => {
    const res = await api.admin.post('/api/admin/import', { filename: 'alt.pdf', data });
    expect(res.status).toBe(400);
  });
});

describe('data protection (R1-40)', () => {
  it('exports the data of one person', async () => {
    const mine = await api.mia.get('/api/me/export');
    expect(mine.body.person.email).toBe('mia@p.example');
    expect(mine.body.ideas.length).toBeGreaterThan(0);
    expect((await api.mia.get(`/api/admin/users/${users.max.id}/export`)).status).toBe(403);
    expect((await api.admin.get(`/api/admin/users/${users.max.id}/export`)).body.person.email).toBe('max@p.example');
    expect((await api.stranger.get(`/api/admin/users/${users.max.id}/export`)).body.person).toBeNull();
  });

  it('anonymizes a person but keeps the ideas as history', async () => {
    const leaver = await createUser(tenant, 'leaver@p.example');
    const c = client(app, await login(app, 'pilot', 'leaver@p.example'));
    const created = await c.post('/api/ideas', { ...validIdea, title: 'Idee einer Person, die geht' });
    expect((await api.admin.post(`/api/admin/users/${leaver.id}/anonymize`)).status).toBe(200);
    expect((await c.get('/api/me')).status).toBe(401);
    const row = await withTenant(tenant, (db) => db.query('SELECT display_name, email, active, password_hash FROM users WHERE id = $1', [leaver.id]));
    expect(row.rows[0]).toMatchObject({ display_name: 'Ehemalige Person', active: false, password_hash: null });
    expect(row.rows[0].email).not.toContain('leaver');
    const idea = await withTenant(tenant, (db) => db.query('SELECT 1 FROM ideas WHERE id = $1', [created.body.id]));
    expect(idea.rowCount).toBe(1);
  });

  it('applies the retention periods', async () => {
    const gone = await createUser(tenant, 'gone@p.example');
    await api.admin.patch(`/api/admin/users/${gone.id}`, { active: false });
    const rejected = await submitted('mia', { title: 'Abgelehnte alte Idee' });
    expect((await api.triage.post(`/api/ideas/${rejected}/triage`, { lane: 'reject', reason: 'Passt nicht zur Strategie, siehe Gespräch.' })).status).toBe(200);

    const now = await today();
    expect(await asUser(null, tenant, (ctx) => applyRetention(ctx), now)).toMatchObject({ ideasDeleted: 0, usersAnonymized: 0 });
    const later = new Date(Date.parse(now) + 800 * 86400_000).toISOString().slice(0, 10);
    const res = await asUser(null, tenant, (ctx) => applyRetention(ctx), later);
    expect(res.ideasDeleted).toBeGreaterThanOrEqual(1);
    expect(res.usersAnonymized).toBeGreaterThanOrEqual(1);
    expect((await withTenant(tenant, (db) => db.query('SELECT 1 FROM ideas WHERE id = $1', [rejected]))).rowCount).toBe(0);
    // Other tenants are not touched.
    expect((await withTenant(other, (db) => db.query('SELECT 1 FROM users'))).rowCount).toBe(1);
  });
});

describe('deleting a workspace (R1-43)', () => {
  it('needs an admin, the exact name and the password, then removes everything after the grace period', async () => {
    const t = await createTenant('weg');
    await createUser(t, 'admin@weg.example', ['submitter', 'admin']);
    await createUser(t, 'user@weg.example');
    const admin = client(app, await login(app, 'weg', 'admin@weg.example'));
    const user = client(app, await login(app, 'weg', 'user@weg.example'));
    await user.post('/api/ideas', validIdea);
    expect((await user.post('/api/admin/workspace/delete', { confirm: 'Mandant weg' })).status).toBe(403);
    expect((await admin.post('/api/admin/workspace/delete', { confirm: 'falsch', password: PASSWORD })).status).toBe(400);
    // Re-authentication (enterprise): without the password nothing happens.
    expect((await admin.post('/api/admin/workspace/delete', { confirm: 'Mandant weg' })).status).toBe(401);
    const requested = await admin.post('/api/admin/workspace/delete', { confirm: 'Mandant weg', password: PASSWORD });
    expect(requested.status).toBe(200);
    expect(requested.body.status).toBe('deleting');
    // The grace period is over: the job deletes the workspace.
    await withSystem((c) => c.query(`UPDATE tenants SET delete_after = now() - interval '1 minute' WHERE id = $1`, [t]));
    expect(await purgeDueTenants()).toBe(1);

    const left = await withSystem(async (c) => {
      const q = async (sql: string) => (await c.query(sql, [t])).rowCount;
      return {
        tenants: await q('SELECT 1 FROM tenants WHERE id = $1'),
        users: await q('SELECT 1 FROM users WHERE tenant_id = $1'),
        ideas: await q('SELECT 1 FROM ideas WHERE tenant_id = $1'),
        audit: await q('SELECT 1 FROM audit_log WHERE tenant_id = $1'),
      };
    });
    expect(left).toEqual({ tenants: 0, users: 0, ideas: 0, audit: 0 });
    expect((await user.get('/api/me')).status).toBe(401);
    // Other workspaces and their audit trail remain.
    expect((await api.admin.get('/api/ideas')).status).toBe(200);
    const audit = await withSystem(async (c) => (await c.query('SELECT 1 FROM audit_log WHERE tenant_id = $1', [tenant])).rowCount);
    expect(audit).toBeGreaterThan(0);
  });

  it('keeps the audit log append-only otherwise', async () => {
    await expect(withSystem((c) => c.query('DELETE FROM audit_log WHERE tenant_id = $1', [tenant]))).rejects.toThrow();
  });
});
