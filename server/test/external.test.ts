import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, withSystem, withTenant } from '../src/db/pool.js';
import type { SessionUser } from '../src/lib/context.js';
import { countLinks } from '../src/services/external.js';
import { asUser, client, createTenant, createUser, login, resetDb, testApp, validIdea } from './helpers.js';

// External participation (R3-19), moderation (R3-21) and feature requests (R3-20).

let app: FastifyInstance;
let tenant: string;
let other: string;
let users: Record<string, SessionUser>;
let api: Record<string, ReturnType<typeof client>>;
let today: string;
let challengeId: string;
let code: string;

const EXT_SETTINGS = { external: { enabled: true, moderation: 'pre', maxLinks: 2 }, featureRequests: { enabled: true, publicPage: true } };
const extIdea = {
  title: 'Self-Service-Portal für Ersatzteile',
  problem: 'Wir warten oft Tage auf Ersatzteile, weil Bestellungen per E-Mail laufen.',
  solution: 'Ein Bestellportal mit Lagerbestand und Lieferzeit je Teil.',
  benefit: 'Kürzere Stillstände bei unseren Anlagen und weniger Rückfragen.',
  confirmNotReport: true,
  boundaryAcknowledged: true,
};

function cookieOf(res: { cookies: { name: string; value: string }[] }) {
  return `ip_session=${res.cookies.find((c) => c.name === 'ip_session')!.value}`;
}

async function join(portal: string, email: string, extra: Record<string, unknown> = {}) {
  const info = await app.inject({ method: 'GET', url: `/api/external/join/${portal}` });
  const body = JSON.parse(info.body);
  return app.inject({
    method: 'POST',
    url: `/api/external/join/${portal}`,
    payload: { name: `Person ${email.split('@')[0]}`, email, password: 'external-pass-123', termsId: body.terms.id, consentId: body.consent.id, acceptTerms: true, acceptConsent: true, ...extra },
  });
}

beforeAll(async () => {
  await resetDb();
  app = await testApp();
  tenant = await createTenant('ext', { holidays: [], ...EXT_SETTINGS });
  other = await createTenant('extb', { holidays: [], ...EXT_SETTINGS });
  users = {
    admin: await createUser(tenant, 'admin@ext.example', ['submitter', 'admin', 'triage']),
    triage: await createUser(tenant, 'triage@ext.example', ['submitter', 'triage']),
    mia: await createUser(tenant, 'mia@ext.example'),
    lead: await createUser(tenant, 'lead@ext.example', ['submitter', 'lead']),
    otherAdmin: await createUser(other, 'admin@extb.example', ['submitter', 'admin', 'triage']),
  };
  api = {};
  for (const [k, u] of Object.entries(users)) api[k] = client(app, await login(app, k === 'otherAdmin' ? 'extb' : 'ext', u.email));
  today = (await api.mia.get('/api/settings')).body.today;
  const c = await api.admin.post('/api/challenges', { title: 'Kundenideen Service', question: 'Wie können wir unseren Service verbessern?', contact: 'Produktteam', startsOn: today, endsOn: '2099-12-31' });
  expect(c.status).toBe(201);
  challengeId = c.body.id;
  const enable = await api.admin.patch(`/api/admin/external/challenges/${challengeId}`, { externalEnabled: true });
  expect(enable.status).toBe(200);
  code = enable.body.link.split('/mitmachen/')[1];
});

afterAll(async () => {
  await app.close();
  await closePool();
});

describe('external accounts and consent (R3-19)', () => {
  let ext: ReturnType<typeof client>;
  let extId: string;

  it('joins by portal link only with consent to the current texts and without honeypot', async () => {
    const info = await app.inject({ method: 'GET', url: `/api/external/join/${code}` });
    expect(info.statusCode).toBe(200);
    const body = JSON.parse(info.body);
    expect(body.challenge.title).toBe('Kundenideen Service');
    expect(body.terms.version).toBe(1);
    expect(body.consent.version).toBe(1);
    expect(body.consent.body).toContain('Erfindungsprüfung');
    expect((await app.inject({ method: 'GET', url: '/api/external/join/unknown-code-123' })).statusCode).toBe(404);

    const noConsent = await app.inject({ method: 'POST', url: `/api/external/join/${code}`, payload: { name: 'Kunde', email: 'k@kunde.example', password: 'external-pass-123', termsId: body.terms.id, consentId: body.consent.id } });
    expect(noConsent.statusCode).toBe(400);
    const bot = await join(code, 'bot@spam.example', { website: 'http://spam.example' });
    expect(bot.statusCode).toBe(400);
    expect(JSON.parse(bot.body).code).toBe('SPAM_SUSPECTED');
    const wrong = await join(code, 'k@kunde.example', { termsId: body.consent.id });
    expect(wrong.statusCode).toBe(409);

    const ok = await join(code, 'k@kunde.example');
    expect(ok.statusCode).toBe(201);
    ext = client(app, cookieOf(ok));
    const me = await ext.get('/api/me');
    expect(me.body.user.roles).toEqual(['external']);
    extId = me.body.user.id;
    // An existing address cannot sign up a second time.
    expect((await join(code, 'k@kunde.example')).statusCode).toBe(409);
  });

  it('logs the consent: who, which version, when', async () => {
    const log = await api.admin.get('/api/admin/external/consents');
    expect(log.status).toBe(200);
    const mine = log.body.filter((r: { email: string }) => r.email === 'k@kunde.example');
    expect(mine.map((r: { kind: string; version: number }) => `${r.kind}:${r.version}`).sort()).toEqual(['challenge:1', 'terms:1']);
    expect(mine[0].acceptedAt).toBeTruthy();
    const audit = await withTenant(tenant, (db) => db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'consent.accept' AND actor_id = $1`, [extId]));
    expect(audit.rows[0].n).toBe(2);
    // Only admins read the log; the consent log is append-only for the app role.
    expect((await api.triage.get('/api/admin/external/consents')).status).toBe(403);
    await expect(withTenant(tenant, (db) => db.query('DELETE FROM consents'))).rejects.toThrow();
    await expect(withTenant(tenant, (db) => db.query(`UPDATE consent_texts SET body = 'x'`))).rejects.toThrow();
  });

  it('closes every internal endpoint to externals', async () => {
    const internal = await api.mia.post('/api/ideas', { ...validIdea, title: 'Interne Idee zur Challenge', challengeId });
    await api.mia.post(`/api/ideas/${internal.body.id}/submit`, { confirmNotReport: true, boundaryAcknowledged: true });
    for (const url of ['/api/ideas', `/api/ideas/${internal.body.id}`, '/api/users', '/api/dashboard', '/api/settings', '/api/challenges',
      `/api/ideas/${internal.body.id}/ai`, '/api/tasks', '/api/portfolio', '/api/success-stories', '/api/moderation', '/api/admin/external']) {
      const r = await ext.get(url);
      expect(r.status, url).toBe(403);
    }
    expect((await ext.post(`/api/ideas/${internal.body.id}/comments`, { body: 'Hallo' })).status).toBe(403);
    expect((await ext.post('/api/ideas', validIdea)).status).toBe(403);
    // Internal ideas are invisible, also in the own list and by id.
    expect((await ext.get(`/api/external/ideas/${internal.body.id}`)).status).toBe(404);
    expect((await ext.get('/api/external/ideas')).body).toEqual([]);
    // Own account and notifications stay open.
    expect((await ext.get('/api/notifications')).status).toBe(200);
    expect((await ext.get('/api/me/export')).status).toBe(200);
  });

  it('requires consent to a new version before the next submission', async () => {
    const v2 = await api.admin.post('/api/admin/external/terms', { body: 'Neue Nutzungsbedingungen, Fassung zwei, bitte lesen.' });
    expect(v2.status).toBe(201);
    expect(v2.body.version).toBe(2);
    const home = await ext.get('/api/external/home');
    expect(home.body.terms.version).toBe(2);
    expect(home.body.terms.accepted).toBe(false);
    expect(home.body.challenges[0].consent.accepted).toBe(true);
    const blocked = await ext.post(`/api/external/challenges/${challengeId}/ideas`, extIdea);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('CONSENT_REQUIRED');
    expect((await ext.post('/api/external/consents', { ids: [home.body.terms.id] })).status).toBe(200);
    const history = await api.admin.get('/api/admin/external/texts');
    expect(history.body.map((t: { version: number; consents: number }) => [t.version, t.consents])).toEqual([[2, 1], [1, 1]]);
  });

  let pendingId: string;

  it('holds external ideas for release; colleagues and other externals see them only afterwards (R3-21)', async () => {
    const r = await ext.post(`/api/external/challenges/${challengeId}/ideas`, extIdea);
    expect(r.status).toBe(201);
    expect(r.body.moderation).toBe('pending');
    pendingId = r.body.id;
    const own = await ext.get(`/api/external/ideas/${pendingId}`);
    expect(own.body.own).toBe(true);
    expect(own.body.moderation).toBe('pending');
    expect(own.body).not.toHaveProperty('comments');
    expect(own.body).not.toHaveProperty('author');

    // Second external person in the same challenge.
    const second = client(app, cookieOf(await join(code, 'p@partner.example')));
    expect((await second.get(`/api/external/ideas/${pendingId}`)).status).toBe(404);
    // Internal colleague: invisible until released; triage sees it in the queue.
    expect((await api.mia.get(`/api/ideas/${pendingId}`)).status).toBe(404);
    expect((await api.mia.get('/api/ideas')).body.some((i: { id: string }) => i.id === pendingId)).toBe(false);
    expect((await api.triage.get(`/api/ideas/${pendingId}`)).body.origin).toBe('external');
    const queue = await api.triage.get('/api/moderation');
    expect(queue.body.pending.map((i: { id: string }) => i.id)).toContain(pendingId);
    expect((await api.mia.get('/api/moderation')).status).toBe(403);

    expect((await api.triage.post(`/api/moderation/ideas/${pendingId}`, { action: 'approve' })).status).toBe(200);
    expect((await api.mia.get(`/api/ideas/${pendingId}`)).status).toBe(200);
    const seen = await second.get(`/api/external/ideas/${pendingId}`);
    expect(seen.status).toBe(200);
    expect(seen.body.own).toBe(false);
    expect(seen.body.questions).toEqual([]);
    expect(seen.body.decisions).toEqual([]);
  });

  it('never shows internal comments to externals, also not by notification', async () => {
    expect((await api.mia.post(`/api/ideas/${pendingId}/comments`, { body: 'Interne Notiz: Kunde ist wichtig.' })).status).toBe(201);
    const detail = await ext.get(`/api/external/ideas/${pendingId}`);
    expect(JSON.stringify(detail.body)).not.toContain('Interne Notiz');
    const notes = await ext.get('/api/notifications');
    expect(JSON.stringify(notes.body)).not.toContain('Interne Notiz');
  });

  it('blocks spam: honeypot and too many links', async () => {
    const hp = await ext.post(`/api/external/challenges/${challengeId}/ideas`, { ...extIdea, website: 'x' });
    expect(hp.body.code).toBe('SPAM_SUSPECTED');
    const links = await ext.post(`/api/external/challenges/${challengeId}/ideas`, {
      ...extIdea, solution: 'Siehe https://a.example und https://b.example und www.c.example für Details.',
    });
    expect(links.status).toBe(400);
    expect(links.body.code).toBe('TOO_MANY_LINKS');
    expect(countLinks('http://a https://b www.c.de')).toBe(3);
    expect(countLinks('keine Links hier')).toBe(0);
  });

  it('publishes at once when the challenge chooses no release', async () => {
    await api.admin.patch(`/api/admin/external/challenges/${challengeId}`, { moderation: 'post' });
    const r = await ext.post(`/api/external/challenges/${challengeId}/ideas`, { ...extIdea, title: 'Zweite Kundenidee ohne Freigabe' });
    expect(r.status).toBe(201);
    expect(r.body.moderation).toBe('approved');
    expect((await api.mia.get(`/api/ideas/${r.body.id}`)).status).toBe(200);
    await api.admin.patch(`/api/admin/external/challenges/${challengeId}`, { moderation: null });
  });

  it('invites by e-mail, but not internal people', async () => {
    const inv = await api.triage.post(`/api/admin/external/challenges/${challengeId}/invitations`, { email: 'neu@partner.example', name: 'Neue Partnerin' });
    expect(inv.status).toBe(201);
    const row = await withTenant(tenant, (db) => db.query<{ roles: string[] }>('SELECT roles FROM users WHERE id = $1', [inv.body.id]));
    expect(row.rows[0].roles).toEqual(['external']);
    const mail = await withTenant(tenant, (db) => db.query(`SELECT subject FROM outbox WHERE to_email = 'neu@partner.example'`));
    expect(mail.rows[0].subject).toContain('Kundenideen Service');
    expect((await api.triage.post(`/api/admin/external/challenges/${challengeId}/invitations`, { email: 'mia@ext.example', name: 'Mia' })).status).toBe(409);
    expect((await api.mia.post(`/api/admin/external/challenges/${challengeId}/invitations`, { email: 'x@y.example', name: 'Xy' })).status).toBe(403);
  });

  it('keeps the new link only: an old portal link stops working', async () => {
    const r = await api.admin.patch(`/api/admin/external/challenges/${challengeId}`, { newLink: true });
    const fresh = r.body.link.split('/mitmachen/')[1];
    expect(fresh).not.toBe(code);
    expect((await app.inject({ method: 'GET', url: `/api/external/join/${code}` })).statusCode).toBe(404);
    code = fresh;
  });
});

describe('reports and moderation queue (R3-21)', () => {
  let ideaId: string;
  let commentId: string;

  beforeAll(async () => {
    const d = await api.mia.post('/api/ideas', { ...validIdea, title: 'Idee mit Werbung' });
    ideaId = d.body.id;
    await api.mia.post(`/api/ideas/${ideaId}/submit`, { confirmNotReport: true, boundaryAcknowledged: true });
    await api.lead.post(`/api/ideas/${ideaId}/comments`, { body: 'Kauft billige Uhren bei uns!' });
    commentId = (await api.triage.get(`/api/ideas/${ideaId}`)).body.comments[0].id;
  });

  it('lets people report once, never their own posts', async () => {
    expect((await api.mia.post(`/api/ideas/${ideaId}/report`, { reason: 'spam' })).status).toBe(400);
    expect((await api.lead.post(`/api/ideas/${ideaId}/report`, { reason: 'spam', commentId })).status).toBe(400);
    expect((await api.mia.post(`/api/ideas/${ideaId}/report`, { reason: 'spam', commentId, note: 'Werbung' })).status).toBe(201);
    expect((await api.mia.post(`/api/ideas/${ideaId}/report`, { reason: 'spam', commentId })).status).toBe(409);
    expect((await api.lead.post(`/api/ideas/${ideaId}/report`, { reason: 'offensive' })).status).toBe(201);
  });

  it('shows the queue without reporter names and hides the comment', async () => {
    const q = await api.triage.get('/api/moderation');
    expect(q.body.reports).toHaveLength(2);
    expect(JSON.stringify(q.body.reports)).not.toContain('mia');
    const commentReport = q.body.reports.find((r: { commentId: string | null }) => r.commentId === commentId);
    expect(commentReport.commentBody).toContain('Uhren');
    expect((await api.triage.post(`/api/moderation/reports/${commentReport.id}`, { action: 'hide' })).status).toBe(200);
    expect((await api.triage.post(`/api/moderation/reports/${commentReport.id}`, { action: 'hide' })).status).toBe(409);
    expect((await api.mia.get(`/api/ideas/${ideaId}`)).body.comments).toHaveLength(0);
    expect((await api.triage.get(`/api/ideas/${ideaId}`)).body.comments).toHaveLength(1);
    // The idea report is dismissed; the idea stays visible.
    const ideaReport = (await api.triage.get('/api/moderation')).body.reports[0];
    expect((await api.triage.post(`/api/moderation/reports/${ideaReport.id}`, { action: 'dismiss' })).status).toBe(200);
    expect((await api.lead.get(`/api/ideas/${ideaId}`)).status).toBe(200);
    expect((await api.triage.get('/api/moderation')).body.reports).toHaveLength(0);
  });

  it('hides a reported idea from the community, not from its author', async () => {
    expect((await api.lead.post(`/api/ideas/${ideaId}/report`, { reason: 'other' })).status).toBe(201);
    const report = (await api.triage.get('/api/moderation')).body.reports[0];
    await api.triage.post(`/api/moderation/reports/${report.id}`, { action: 'hide' });
    expect((await api.lead.get(`/api/ideas/${ideaId}`)).status).toBe(404);
    expect((await api.mia.get(`/api/ideas/${ideaId}`)).status).toBe(200);
  });
});

describe('feature requests with voting and public status page (R3-20)', () => {
  let requestId: string;

  it('is off unless the tenant switches it on', async () => {
    const off = await createTenant('extoff', { holidays: [] });
    const u = await createUser(off, 'a@off.example', ['submitter', 'admin']);
    const c = client(app, await login(app, 'extoff', u.email));
    expect((await c.get('/api/feature-requests')).status).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/public/feature-requests/extoff' })).statusCode).toBe(404);
  });

  it('allows one vote per person; new requests are not public', async () => {
    const r = await api.mia.post('/api/feature-requests', { title: 'Export als Excel', description: 'Liste der Ideen als Excel-Datei.' });
    expect(r.status).toBe(201);
    requestId = r.body.id;
    expect((await api.lead.post(`/api/feature-requests/${requestId}/vote`)).body.votes).toBe(2);
    expect((await api.lead.post(`/api/feature-requests/${requestId}/vote`)).body.votes).toBe(2);
    expect((await api.lead.del(`/api/feature-requests/${requestId}/vote`)).body.votes).toBe(1);
    await api.lead.post(`/api/feature-requests/${requestId}/vote`);
    // Not yet reviewed: other people do not see it, the public page neither.
    expect((await api.triage.get('/api/feature-requests')).body.items).toHaveLength(1);
    const pub = await app.inject({ method: 'GET', url: '/api/public/feature-requests/ext' });
    expect(JSON.parse(pub.body).items).toEqual([]);
    expect((await api.mia.post('/api/feature-requests', { title: 'Spam', website: 'bot' })).status).toBe(400);
  });

  it('notifies voters on a status change and shows the status publicly without personal data', async () => {
    expect((await api.mia.patch(`/api/feature-requests/${requestId}`, { status: 'planned' })).status).toBe(403);
    expect((await api.lead.patch(`/api/feature-requests/${requestId}`, { status: 'planned', note: 'Kommt im nächsten Quartal.' })).status).toBe(200);
    const mails = await withTenant(tenant, (db) => db.query<{ user_id: string; subject: string; body: string }>(`SELECT user_id, subject, body FROM outbox WHERE subject LIKE 'Feature-Wunsch #1%'`));
    expect(mails.rows.map((r) => r.user_id)).toEqual([users.mia.id]); // the lead changed it and is not notified
    expect(mails.rows[0].subject).toBe('Feature-Wunsch #1: geplant');
    expect(mails.rows[0].body).toContain('nächsten Quartal');
    const pub = JSON.parse((await app.inject({ method: 'GET', url: '/api/public/feature-requests/ext' })).body);
    expect(pub.items).toHaveLength(1);
    expect(pub.items[0]).toMatchObject({ number: 1, status: 'planned', votes: 2 });
    expect(Object.keys(pub.items[0]).sort()).toEqual(['description', 'number', 'status', 'statusNote', 'title', 'updatedAt', 'votes']);
    expect(JSON.stringify(pub)).not.toMatch(/mia|lead@|ext\.example/);
  });

  it('lets external customers vote', async () => {
    const ext = client(app, await login(app, 'ext', 'k@kunde.example', 'external-pass-123'));
    const list = await ext.get('/api/feature-requests');
    expect(list.body.items[0].votedByMe).toBe(false);
    expect((await ext.post(`/api/feature-requests/${requestId}/vote`)).body.votes).toBe(3);
  });
});

describe('tenant separation', () => {
  it('keeps consent texts, consents, access, reports and feature requests per tenant', async () => {
    for (const table of ['consent_texts', 'consents', 'external_access', 'content_reports', 'feature_requests', 'feature_votes']) {
      const mine = await withTenant(tenant, (db) => db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`));
      const theirs = await withTenant(other, (db) => db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`));
      expect(mine.rows[0].n, table).toBeGreaterThan(0);
      expect(theirs.rows[0].n, table).toBe(0);
    }
    // Writing into another tenant is refused by row-level security.
    await expect(asUser(users.otherAdmin, other, (ctx) => ctx.db.query(
      `INSERT INTO feature_requests (tenant_id, number, title) VALUES ($1, 99, 'fremd')`, [tenant],
    ))).rejects.toThrow();
    expect((await api.otherAdmin.get('/api/admin/external/consents')).body).toEqual([]);
    expect((await api.otherAdmin.get('/api/feature-requests')).body.items).toEqual([]);
    expect((await api.otherAdmin.patch(`/api/admin/external/challenges/${challengeId}`, { externalEnabled: false })).status).toBe(404);
  });

  it('does not let an external person of another tenant use the portal link', async () => {
    const c = await api.otherAdmin.post('/api/challenges', { title: 'B-Challenge', question: 'Was wünschen sich Kunden von B?', contact: 'Team B', startsOn: today, endsOn: '2099-12-31' });
    const link = (await api.otherAdmin.patch(`/api/admin/external/challenges/${c.body.id}`, { externalEnabled: true })).body.link as string;
    const extB = client(app, cookieOf(await join(link.split('/mitmachen/')[1], 'b@kunde.example')));
    expect((await extB.post(`/api/external/access/${code}`)).status).toBe(404);
    expect((await extB.get('/api/external/home')).body.challenges.map((x: { title: string }) => x.title)).toEqual(['B-Challenge']);
    const rows = await withSystem((s) => s.query<{ tenant_id: string }>(`SELECT u.tenant_id FROM users u WHERE u.email = 'b@kunde.example'`));
    expect(rows.rows[0].tenant_id).toBe(other);
  });
});
