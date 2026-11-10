import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, withSystem, withTenant } from '../src/db/pool.js';
import { runTenantJobs } from '../src/jobs/deadlines.js';
import type { SessionUser } from '../src/lib/context.js';
import { guaranteeQuota } from '../src/services/guarantee.js';
import { askQuestion, createIdea, ideaInput, loadIdea, submitIdea, triageIdea } from '../src/services/workflow.js';
import { asUser, client, createTenant, createUser, login, resetDb, testApp, validIdea } from './helpers.js';

// AP-07: visible response guarantee per tenant (R1-46) with its deadline behaviour and the
// once-only notice, first start per role and screen and the "first week" checklist (R2-48).

let app: FastifyInstance;
let tenantA: string;
let tenantB: string;
const users: Record<string, SessionUser> = {};
const noHolidays = { holidays: [] };
const start = '2026-10-12'; // Monday; 10 working days later: 2026-10-26

beforeAll(async () => {
  await resetDb();
  app = await testApp();
  tenantA = await createTenant('garantie-a', { ...noHolidays, guarantee: { enabled: true, workdays: 10, alertBelowPercent: 90 } });
  tenantB = await createTenant('garantie-b', { ...noHolidays, guarantee: { enabled: true, workdays: 5, alertBelowPercent: 90 } });
  users.authorA = await createUser(tenantA, 'author@a.example');
  users.triageA = await createUser(tenantA, 'triage@a.example', ['submitter', 'triage']);
  users.adminA = await createUser(tenantA, 'admin@a.example', ['submitter', 'admin']);
  users.authorB = await createUser(tenantB, 'author@b.example');
  users.triageB = await createUser(tenantB, 'triage@b.example', ['submitter', 'triage']);
});

afterAll(async () => {
  await app.close();
  await closePool();
});

async function submitOn(author: SessionUser, tenant: string, day: string, title: string): Promise<string> {
  return asUser(author, tenant, async (ctx) => {
    const idea = await createIdea(ctx, ideaInput.parse({ ...validIdea, title }));
    await submitIdea(ctx, await loadIdea(ctx, idea.id, true), { confirmNotReport: true });
    return idea.id;
  }, day);
}

/** Events carry the real clock; the tests move them to the simulated day of the response. */
async function respondedOn(ideaId: string, kind: string, day: string): Promise<void> {
  await withSystem((c) => c.query(`UPDATE idea_events SET created_at = ($3::date + time '10:00') AT TIME ZONE 'Europe/Berlin' WHERE idea_id = $1 AND kind = $2`, [ideaId, kind, day]));
}

const quota = (tenant: string, day: string) => asUser(null, tenant, (ctx) => guaranteeQuota(ctx), day);
const run = (tenant: string, day: string) => asUser(null, tenant, (ctx) => runTenantJobs(ctx), day);

async function inbox(tenant: string, user: SessionUser): Promise<number> {
  const r = await withTenant(tenant, (db) => db.query(`SELECT count(*)::int AS n FROM outbox WHERE user_id = $1 AND subject LIKE 'Antwortgarantie%'`, [user.id]));
  return r.rows[0].n;
}

async function setGuarantee(tenant: string, guarantee: Record<string, unknown>): Promise<void> {
  await withSystem((c) => c.query(`UPDATE tenants SET settings = settings || jsonb_build_object('guarantee', $2::jsonb) WHERE id = $1`, [tenant, JSON.stringify(guarantee)]));
}

describe('response guarantee (R1-46)', () => {
  let answered: string;
  let open: string;

  it('counts only ideas whose period has ended or that got a response', async () => {
    answered = await submitOn(users.authorA, tenantA, start, 'Beantwortet');
    open = await submitOn(users.authorA, tenantA, start, 'Offen');
    await asUser(users.triageA, tenantA, async (ctx) => askQuestion(ctx, await loadIdea(ctx, answered, true), 'Wer ist betroffen?'), '2026-10-14');
    await respondedOn(answered, 'question', '2026-10-14');

    const before = await quota(tenantA, '2026-10-26'); // last day of the period
    expect(before).toMatchObject({ enabled: true, workdays: 10, counted: 1, met: 1, pending: 1, quota: 100 });
    const after = await quota(tenantA, '2026-10-27'); // the open idea is now late
    expect(after).toMatchObject({ counted: 2, met: 1, pending: 0, quota: 50 });
  });

  it('counts a late response as missed and a triage decision as a response', async () => {
    const late = await submitOn(users.authorA, tenantA, start, 'Spät entschieden');
    await asUser(users.triageA, tenantA, async (ctx) => triageIdea(ctx, await loadIdea(ctx, late, true), { lane: 'reject', reason: 'Passt nicht zu den Zielen.' }), '2026-10-28');
    await respondedOn(late, 'gate1', '2026-10-28');
    expect(await quota(tenantA, '2026-10-28')).toMatchObject({ counted: 3, met: 1 });
  });

  it('leaves out ideas older than 90 days', async () => {
    expect(await quota(tenantA, '2027-01-09')).toMatchObject({ counted: 3 }); // 89 days after the start
    expect(await quota(tenantA, '2027-01-10')).toMatchObject({ counted: 0, quota: null }); // 90 days
  });

  it('tells the idea management once when the quota drops below the threshold', async () => {
    expect((await run(tenantA, '2026-10-26')).guaranteeAlerts).toBe(0); // 100 %
    expect((await run(tenantA, '2026-10-27')).guaranteeAlerts).toBe(1); // 50 %
    expect((await run(tenantA, '2026-10-28')).guaranteeAlerts).toBe(0); // still below: no repeat
    expect((await run(tenantA, '2026-10-29')).guaranteeAlerts).toBe(0);
    expect(await inbox(tenantA, users.triageA)).toBe(1);
    expect(await inbox(tenantA, users.adminA)).toBe(1);
    expect(await inbox(tenantA, users.authorA)).toBe(0);
    const audit = await withTenant(tenantA, (db) => db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'guarantee.alert'`));
    expect(audit.rows[0].n).toBe(1);
  });

  it('re-arms the notice after the quota has recovered', async () => {
    await setGuarantee(tenantA, { enabled: true, workdays: 10, alertBelowPercent: 30 });
    expect((await run(tenantA, '2026-10-30')).guaranteeAlerts).toBe(0); // 33 % ≥ 30 %: recovered
    await setGuarantee(tenantA, { enabled: true, workdays: 10, alertBelowPercent: 90 });
    expect((await run(tenantA, '2026-11-02')).guaranteeAlerts).toBe(1);
    expect(await inbox(tenantA, users.triageA)).toBe(2);
  });

  it('sends nothing when the guarantee is switched off', async () => {
    await setGuarantee(tenantA, { enabled: false, workdays: 10, alertBelowPercent: 30 });
    expect((await run(tenantA, '2026-11-03')).guaranteeAlerts).toBe(0);
    await setGuarantee(tenantA, { enabled: false, workdays: 10, alertBelowPercent: 90 });
    expect((await run(tenantA, '2026-11-04')).guaranteeAlerts).toBe(0);
    await setGuarantee(tenantA, { enabled: true, workdays: 10, alertBelowPercent: 90 });
  });

  it('keeps two tenants apart: own settings, own ideas, own notice state', async () => {
    const b = await submitOn(users.authorB, tenantB, start, 'Mandant B');
    await asUser(users.triageB, tenantB, async (ctx) => askQuestion(ctx, await loadIdea(ctx, b, true), 'Welche Abteilung?'), '2026-10-13');
    await respondedOn(b, 'question', '2026-10-13');
    expect(await quota(tenantB, '2026-11-04')).toMatchObject({ workdays: 5, counted: 1, met: 1, quota: 100 });
    expect((await run(tenantB, '2026-11-04')).guaranteeAlerts).toBe(0);
    expect(await inbox(tenantB, users.triageB)).toBe(0);

    // Row-level security on the notice state.
    const seenFromB = await withTenant(tenantB, (db) => db.query('SELECT tenant_id FROM guarantee_alerts'));
    expect(seenFromB.rows.map((r) => r.tenant_id)).toEqual([tenantB]);
    await expect(
      withTenant(tenantB, (db) => db.query('INSERT INTO guarantee_alerts (tenant_id, below) VALUES ($1, true)', [tenantA])),
    ).rejects.toThrow();
  });

  it('shows the quota and the setting to every person of the tenant', async () => {
    const author = client(app, await login(app, 'garantie-b', 'author@b.example'));
    const r = await author.get('/api/guarantee');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, workdays: 5, windowDays: 90 });
    const s = await author.get('/api/settings');
    expect(s.body.guarantee).toEqual({ enabled: true, workdays: 5, alertBelowPercent: 90 });
  });

  it('lets the admin change the guarantee under Einstellungen › Prozess', async () => {
    const admin = client(app, await login(app, 'garantie-a', 'admin@a.example'));
    const current = (await admin.get('/api/admin/settings')).body;
    const r = await admin.put('/api/admin/settings', { ...current, guarantee: { enabled: true, workdays: 15, alertBelowPercent: 80 } });
    expect(r.status).toBe(200);
    expect(r.body.guarantee).toEqual({ enabled: true, workdays: 15, alertBelowPercent: 80 });
    const bad = await admin.put('/api/admin/settings', { ...current, guarantee: { enabled: true, workdays: 0, alertBelowPercent: 80 } });
    expect(bad.status).toBe(400);
    const triage = client(app, await login(app, 'garantie-a', 'triage@a.example'));
    expect((await triage.put('/api/admin/settings', current)).status).toBe(403);
  });
});

describe('first start per role and first week (R2-48)', () => {
  it('remembers the first-start steps per person and screen', async () => {
    const triage = client(app, await login(app, 'garantie-a', 'triage@a.example'));
    const admin = client(app, await login(app, 'garantie-a', 'admin@a.example'));
    expect((await triage.get('/api/me/onboarding')).body).toEqual({ introsSeen: [], firstWeek: { done: [], hidden: false } });
    expect((await triage.post('/api/me/onboarding/intro', { screen: 'board' })).status).toBe(200);
    expect((await triage.post('/api/me/onboarding/intro', { screen: 'board' })).status).toBe(200); // no duplicate
    expect((await triage.get('/api/me/onboarding')).body.introsSeen).toEqual(['board']);
    expect((await admin.get('/api/me/onboarding')).body.introsSeen).toEqual([]); // per person
    expect((await triage.post('/api/me/onboarding/intro', { screen: 'unbekannt' })).status).toBe(400);
    expect((await triage.del('/api/me/onboarding/intro')).status).toBe(200);
    expect((await triage.get('/api/me/onboarding')).body.introsSeen).toEqual([]);
  });

  it('stores the ticked items of the first week', async () => {
    const author = client(app, await login(app, 'garantie-b', 'author@b.example'));
    expect((await author.put('/api/me/onboarding/first-week', { done: ['account', 'submit', 'submit'], hidden: false })).status).toBe(200);
    expect((await author.get('/api/me/onboarding')).body.firstWeek).toEqual({ done: ['account', 'submit'], hidden: false });
    expect((await author.put('/api/me/onboarding/first-week', { done: ['<script>'], hidden: false })).status).toBe(400);
    expect((await author.put('/api/me/onboarding/first-week', { done: [], hidden: true })).status).toBe(200);
    expect((await author.get('/api/me/onboarding')).body.firstWeek.hidden).toBe(true);
  });
});
