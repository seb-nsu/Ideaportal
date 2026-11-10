import { inflateRawSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { closePool, withSystem, withTenant } from '../src/db/pool.js';
import { claimJob } from '../src/ai/worker.js';
import { runAllJobs } from '../src/jobs/deadlines.js';
import { newTotpSecret, totp } from '../src/lib/crypto.js';
import { createOperator } from '../src/services/operatorAccounts.js';
import { processExports } from '../src/services/tenantExport.js';
import { purgeDueTenants } from '../src/services/tenantLifecycle.js';
import { PASSWORD, client, createTenant, createUser, login, resetDb, testApp, validIdea } from './helpers.js';

// Enterprise administration: tenant status (suspend, offboarding with grace period and proof),
// export as ZIP, operator accounts with roles, overrides per tenant, delegated people
// administration with import and bulk actions. Two tenants throughout for the isolation.

let app: FastifyInstance;
let tenantA: string;
let tenantB: string;
let adminA: ReturnType<typeof client>;
let adminB: ReturnType<typeof client>;
let memberA: ReturnType<typeof client>;
const OPERATOR_TOKEN = 'operator-token-for-enterprise-tests-0123456789';
const OPERATOR_TOTP = newTotpSecret();
let opCookie = '';
const codeUses = new Map<string, number>();

const op = (cookie = opCookie) => client(app, cookie);
/** Another valid TOTP code on every use of a secret (replay protection refuses a used code). */
const freshCode = (secret: string) => {
  const n = codeUses.get(secret) ?? 0;
  codeUses.set(secret, n + 1);
  return totp(secret, Date.now() + [0, 30_000, -30_000][n % 3]);
};

async function bootstrapLogin(): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/operator/login', payload: { token: OPERATOR_TOKEN, code: freshCode(OPERATOR_TOTP) } });
  if (res.statusCode !== 200) throw new Error(`bootstrap login failed: ${res.statusCode} ${res.body}`);
  return `ip_operator=${res.cookies.find((c) => c.name === 'ip_operator')!.value}`;
}

async function accountLogin(email: string, password: string, secret: string) {
  return app.inject({ method: 'POST', url: '/api/operator/login', payload: { email, password, code: freshCode(secret) } });
}

const cookieOf = (res: { cookies: { name: string; value: string }[] }) => `ip_operator=${res.cookies.find((c) => c.name === 'ip_operator')!.value}`;

/** Minimal ZIP reader (central directory, stored and deflated entries) for the export test. */
function unzip(buf: Buffer): Map<string, Buffer> {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

beforeAll(async () => {
  await resetDb();
  config.operatorToken = OPERATOR_TOKEN;
  config.operatorTotpSecret = OPERATOR_TOTP;
  config.operatorBreakGlass = false;
  app = await testApp();
  tenantA = await createTenant('ent-a');
  tenantB = await createTenant('ent-b');
  await createUser(tenantA, 'admin@a.example', ['submitter', 'admin']);
  await createUser(tenantA, 'mia@a.example', ['submitter']);
  await createUser(tenantB, 'admin@b.example', ['submitter', 'admin']);
  adminA = client(app, await login(app, 'ent-a', 'admin@a.example'));
  adminB = client(app, await login(app, 'ent-b', 'admin@b.example'));
  memberA = client(app, await login(app, 'ent-a', 'mia@a.example'));
  opCookie = await bootstrapLogin();
});

afterAll(async () => {
  config.operatorToken = undefined;
  config.operatorTotpSecret = undefined;
  config.operatorBreakGlass = false;
  await app.close();
  await closePool();
});

describe('suspending a tenant', () => {
  it('blocks sign-in, sessions, API tokens, SCIM, jobs and AI work of that tenant only', async () => {
    const token = (await adminA.post('/api/admin/api-tokens', { name: 'Konnektor', roles: ['submitter'] })).body.token as string;
    const scim = (await adminA.post('/api/admin/identity/scim-tokens', { label: 'Entra ID' })).body.token as string;
    const bearer = (t: string, url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${t}` } });
    expect((await bearer(token, '/api/ideas')).statusCode).toBe(200);
    await withSystem((c) =>
      c.query(`INSERT INTO ai_jobs (tenant_id, kind, params) VALUES ($1, 'trend_digest', '{}'), ($2, 'trend_digest', '{}')`, [tenantA, tenantB]),
    );

    // Workspace sessions cannot suspend; the operator needs a reason.
    expect((await adminA.post(`/api/operator/tenants/${tenantA}/suspend`, { reason: 'Zahlung offen' })).status).toBe(401);
    expect((await op().post(`/api/operator/tenants/${tenantA}/suspend`, {})).status).toBe(400);
    expect((await op().post(`/api/operator/tenants/${tenantA}/suspend`, { reason: 'Zahlung offen' })).status).toBe(200);
    expect((await op().post(`/api/operator/tenants/${tenantA}/suspend`, { reason: 'noch einmal' })).status).toBe(409);

    // Signed-in people are out, new sign-ins get a clear message.
    expect((await memberA.get('/api/ideas')).status).toBe(401);
    const refused = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenant: 'ent-a', email: 'mia@a.example', password: PASSWORD } });
    expect(refused.statusCode).toBe(403);
    expect(JSON.parse(refused.body)).toMatchObject({ code: 'TENANT_SUSPENDED', error: expect.stringContaining('gesperrt') });
    const refusedEn = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'accept-language': 'en' },
      payload: { tenant: 'ent-a', email: 'mia@a.example', password: PASSWORD },
    });
    expect(JSON.parse(refusedEn.body).error).toContain('suspended');
    // API token and SCIM token are refused as well.
    const api = await bearer(token, '/api/ideas');
    expect(api.statusCode).toBe(403);
    expect(JSON.parse(api.body).code).toBe('TENANT_SUSPENDED');
    expect((await bearer(scim, '/scim/v2/Users')).statusCode).toBe(403);
    // The other tenant works as before.
    expect((await adminB.get('/api/ideas')).status).toBe(200);

    // Jobs and the AI worker skip the suspended tenant.
    const jobs = await runAllJobs();
    expect(Object.keys(jobs ?? {})).toEqual(['ent-b']);
    const claimed: string[] = [];
    for (let job = await claimJob(10); job; job = await claimJob(10)) claimed.push(job.tenant_id);
    expect(claimed).toContain(tenantB);
    expect(claimed).not.toContain(tenantA);

    // Logged in the operator log and in the tenant's audit log; visible in the overview.
    const overview = (await op().get('/api/operator/overview')).body.tenants.find((t: { id: string }) => t.id === tenantA);
    expect(overview).toMatchObject({ status: 'suspended', suspendedReason: 'Zahlung offen' });
    const audit = await withTenant(tenantA, (db) => db.query(`SELECT after FROM audit_log WHERE action = 'tenant.suspend'`));
    expect(audit.rows[0].after).toMatchObject({ reason: 'Zahlung offen', operator: 'operator' });
    expect((await op().get('/api/operator/log')).body.map((l: { action: string }) => l.action)).toContain('tenant.suspend');

    // The app role cannot change the status itself (defence in depth).
    await expect(withTenant(tenantA, (db) => db.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [tenantA]))).rejects.toThrow();

    expect((await op().post(`/api/operator/tenants/${tenantA}/resume`, { reason: 'Zahlung eingegangen' })).status).toBe(200);
    memberA = client(app, await login(app, 'ent-a', 'mia@a.example'));
    adminA = client(app, await login(app, 'ent-a', 'admin@a.example'));
    expect((await memberA.get('/api/ideas')).status).toBe(200);
    expect((await bearer(token, '/api/ideas')).statusCode).toBe(200);
  });
});

describe('full export as ZIP', () => {
  it('exports every table of the own tenant with files and manifest, only for admins', async () => {
    const idea = (await memberA.post('/api/ideas', { ...validIdea, title: 'Solarzellen auf dem Parkhaus' })).body;
    await adminB.post('/api/ideas', { ...validIdea, title: 'Geheimprojekt Bravo' });
    const pdf = Buffer.from('%PDF-1.4 export test file');
    const mia = await withSystem(async (c) => (await c.query(`SELECT id FROM users WHERE email = 'mia@a.example'`)).rows[0].id);
    const att = await withTenant(
      tenantA,
      async (db) =>
        (
          await db.query(
            `INSERT INTO attachments (tenant_id, idea_id, filename, mime, size, data, scan_status, uploaded_by) VALUES ($1, $2, 'plan.pdf', 'application/pdf', $3, $4, 'type_checked', $5) RETURNING id`,
            [tenantA, idea.id, pdf.length, pdf, mia],
          )
        ).rows[0].id,
    );

    expect((await memberA.post('/api/admin/exports')).status).toBe(403);
    const started = await adminA.post('/api/admin/exports');
    expect(started.status).toBe(202);
    // A second request while one is open returns the same export.
    expect((await adminA.post('/api/admin/exports')).body).toEqual({ id: started.body.id, existing: true });
    const notReady = await app.inject({
      method: 'GET',
      url: `/api/admin/exports/${started.body.id}/download`,
      headers: { cookie: await login(app, 'ent-a', 'admin@a.example') },
    });
    expect(notReady.statusCode).toBe(409);

    expect(await processExports()).toBe(1);
    const list = (await adminA.get('/api/admin/exports')).body;
    expect(list[0]).toMatchObject({ id: started.body.id, status: 'done', files: 1 });
    // The requester is told in the inbox.
    const note = await withTenant(tenantA, (db) => db.query(`SELECT subject FROM outbox WHERE subject LIKE '%Datenexport%'`));
    expect(note.rowCount).toBe(1);

    // B cannot see or download A's export.
    expect((await adminB.get('/api/admin/exports')).body).toEqual([]);
    const cookieA = await login(app, 'ent-a', 'admin@a.example');
    const cookieB = await login(app, 'ent-b', 'admin@b.example');
    expect((await app.inject({ method: 'GET', url: `/api/admin/exports/${started.body.id}/download`, headers: { cookie: cookieB } })).statusCode).toBe(404);

    const res = await app.inject({ method: 'GET', url: `/api/admin/exports/${started.body.id}/download`, headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/zip');
    const files = unzip(res.rawPayload);
    const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8'));
    expect(manifest).toMatchObject({
      format: 'ideenportal-tenant-export',
      formatVersion: 1,
      schemaVersion: expect.stringMatching(/^\d{3}_/),
      tenant: { id: tenantA, slug: 'ent-a' },
    });
    expect(manifest.tables.ideas.rows).toBe(1);
    // Two people and the technical user of the API token.
    expect(manifest.tables.users.rows).toBe(3);
    expect(manifest.tables.users.excludedColumns).toEqual(expect.arrayContaining(['password_hash', 'mfa_secret']));
    expect(manifest.files).toMatchObject({ count: 1, bytes: pdf.length });
    for (const t of ['ideas', 'audit_log', 'attachments', 'scorecards', 'meetings', 'ai_results', 'ai_actions', 'dossier_sections', 'dossier_history']) {
      expect(manifest.tables[t], t).toBeDefined();
      expect(files.has(`tables/${t}.csv`), t).toBe(true);
      expect(files.has(`tables/${t}.jsonl`), t).toBe(true);
    }
    expect(manifest.excludedTables).toEqual(expect.arrayContaining(['sessions', 'tenant_keys']));
    expect(files.get(`files/attachments/${att}/plan.pdf`)!.equals(pdf)).toBe(true);
    const ideasCsv = files.get('tables/ideas.csv')!.toString('utf8');
    expect(ideasCsv).toContain('Solarzellen auf dem Parkhaus');
    const attachmentRow = JSON.parse(files.get('tables/attachments.jsonl')!.toString('utf8').trim());
    expect(attachmentRow.data).toBe(`files/attachments/${att}/plan.pdf`);
    // Nothing of B, no secrets.
    const all = [...files.values()].map((b) => b.toString('latin1')).join('\n');
    expect(all).not.toContain('Geheimprojekt Bravo');
    expect(all).not.toContain(tenantB);
    expect(all).not.toContain('scrypt$');
    // Download is logged; the old JSON endpoint still works.
    const audit = await withTenant(tenantA, (db) => db.query(`SELECT action FROM audit_log WHERE action LIKE 'tenant.export%'`));
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['tenant.export_requested', 'tenant.export_ready', 'tenant.export_download']));
    expect((await adminA.get('/api/admin/export')).status).toBe(200);

    // After the retention period the file is gone.
    await withSystem((c) => c.query(`UPDATE tenant_exports SET expires_at = now() - interval '1 minute' WHERE id = $1`, [started.body.id]));
    await processExports();
    expect((await app.inject({ method: 'GET', url: `/api/admin/exports/${started.body.id}/download`, headers: { cookie: cookieA } })).statusCode).toBe(409);
    expect((await withSystem((c) => c.query('SELECT 1 FROM tenant_export_chunks WHERE export_id = $1', [started.body.id]))).rowCount).toBe(0);
  });
});

describe('feature switches and limits per tenant by the operator', () => {
  it('overrides the package with reason and expiry, for one tenant only', async () => {
    expect((await adminA.get('/api/plan')).body.features.api).toBe(true);
    expect((await op().put(`/api/operator/tenants/${tenantA}/overrides`, { kind: 'feature', key: 'api', enabled: false })).status).toBe(400);
    expect(
      (await op().put(`/api/operator/tenants/${tenantA}/overrides`, { kind: 'feature', key: 'api', enabled: false, reason: 'Sicherheitsprüfung' })).status,
    ).toBe(200);
    expect((await adminA.get('/api/plan')).body.features.api).toBe(false);
    const blocked = await adminA.post('/api/admin/api-tokens', { name: 'Neu', roles: ['submitter'] });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('FEATURE_UNAVAILABLE');
    expect((await adminB.get('/api/plan')).body.features.api).toBe(true);

    // A limit: no further challenges.
    expect((await op().put(`/api/operator/tenants/${tenantA}/overrides`, { kind: 'limit', key: 'maxChallenges', value: 0, reason: 'Testphase' })).status).toBe(
      200,
    );
    const challenge = {
      title: 'Weniger Papier',
      question: 'Wie sparen wir Papier im Büro?',
      contact: 'Team Umwelt',
      startsOn: '2026-10-01',
      endsOn: '2026-12-31',
    };
    const limited = await adminA.post('/api/challenges', challenge);
    expect(limited.status).toBe(403);
    expect(limited.body.code).toBe('PLAN_LIMIT');

    // Expired overrides no longer apply.
    await withSystem((c) => c.query(`UPDATE tenant_overrides SET expires_at = now() - interval '1 minute' WHERE tenant_id = $1 AND key = 'api'`, [tenantA]));
    expect((await adminA.get('/api/plan')).body.features.api).toBe(true);
    const listed = (await op().get(`/api/operator/tenants/${tenantA}/overrides`)).body;
    expect(listed.find((o: { key: string }) => o.key === 'api')).toMatchObject({ expired: true, reason: 'Sicherheitsprüfung', setBy: 'operator' });

    expect((await op().del(`/api/operator/tenants/${tenantA}/overrides/maxChallenges`)).status).toBe(400);
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/operator/tenants/${tenantA}/overrides/maxChallenges`,
      headers: { cookie: opCookie },
      payload: { reason: 'Test vorbei' },
    });
    expect(removed.statusCode).toBe(200);
    expect((await op().get(`/api/operator/tenants/${tenantB}/overrides`)).body).toEqual([]);
    const audit = await withTenant(tenantA, (db) => db.query(`SELECT action FROM audit_log WHERE action LIKE 'tenant.override%' ORDER BY id`));
    expect(audit.rows.map((r) => r.action)).toEqual(['tenant.override_set', 'tenant.override_set', 'tenant.override_removed']);
    // Only the operator writes overrides; the workspace can read its own.
    await expect(
      withTenant(tenantA, (db) =>
        db.query(`INSERT INTO tenant_overrides (tenant_id, key, kind, bool_value, reason, set_by) VALUES ($1, 'sso', 'feature', true, 'x', 'x')`, [tenantA]),
      ),
    ).rejects.toThrow();
    expect((await withTenant(tenantB, (db) => db.query('SELECT 1 FROM tenant_overrides'))).rowCount).toBe(0);
  });
});

describe('delegated people administration', () => {
  let ua: ReturnType<typeof client>;
  let uaId: string;
  let adminAId: string;
  let miaId: string;

  beforeAll(async () => {
    uaId = (await createUser(tenantA, 'people@a.example', ['submitter', 'user_admin'])).id;
    ua = client(app, await login(app, 'ent-a', 'people@a.example'));
    const ids = await withSystem(async (c) => (await c.query(`SELECT id, email FROM users WHERE tenant_id = $1`, [tenantA])).rows);
    adminAId = ids.find((r) => r.email === 'admin@a.example').id;
    miaId = ids.find((r) => r.email === 'mia@a.example').id;
  });

  it('manages people and roles except admin, but no settings', async () => {
    expect((await ua.get('/api/admin/users')).status).toBe(200);
    expect((await ua.get('/api/admin/settings')).status).toBe(403);
    expect((await ua.get('/api/admin/audit')).status).toBe(403);
    expect((await ua.post('/api/admin/exports')).status).toBe(403);
    expect((await ua.post('/api/admin/users', { email: 'neu@a.example', displayName: 'Neu Person', roles: ['triage'] })).status).toBe(201);
    expect((await ua.post('/api/admin/users', { email: 'chef@a.example', displayName: 'Chef Person', roles: ['admin'] })).status).toBe(403);
    expect((await ua.patch(`/api/admin/users/${miaId}`, { roles: ['submitter', 'committee'] })).status).toBe(200);
    expect((await ua.patch(`/api/admin/users/${miaId}`, { roles: ['submitter', 'admin'] })).status).toBe(403);
    expect((await ua.patch(`/api/admin/users/${adminAId}`, { active: false })).status).toBe(403);
    expect((await ua.patch(`/api/admin/users/${uaId}`, { active: false })).status).toBe(400);
    // The rights overview of the works council lists the new role.
    const roles = (await adminA.get('/api/codetermination')).body.roles;
    expect(roles.find((r: { role: string }) => r.role === 'user_admin').permissions.map((p: { key: string }) => p.key)).toEqual(['managePeople']);
  });

  it('changes many people at once, audited, within the own tenant', async () => {
    const bId = await withSystem(async (c) => (await c.query(`SELECT id FROM users WHERE email = 'admin@b.example'`)).rows[0].id);
    const r = await ua.post('/api/admin/users/bulk', { userIds: [miaId, adminAId, bId, uaId], action: 'addRole', role: 'mentor' });
    expect(r.status).toBe(200);
    expect(r.body.updated).toBe(2);
    expect(r.body.skipped).toEqual(
      expect.arrayContaining([
        { id: bId, reason: 'notFound' },
        { id: adminAId, reason: 'adminOnly' },
      ]),
    );
    expect((await ua.post('/api/admin/users/bulk', { userIds: [miaId], action: 'addRole', role: 'admin' })).status).toBe(403);
    const off = await ua.post('/api/admin/users/bulk', { userIds: [miaId, uaId], action: 'deactivate' });
    expect(off.body).toMatchObject({ updated: 1, skipped: [{ id: uaId, reason: 'self' }] });
    expect((await memberA.get('/api/ideas')).status).toBe(401);
    expect((await withSystem((c) => c.query('SELECT roles FROM users WHERE id = $1', [bId]))).rows[0].roles).not.toContain('mentor');
    const audit = await withTenant(tenantA, (db) => db.query(`SELECT after FROM audit_log WHERE action = 'users.bulk' ORDER BY id`));
    expect(audit.rows.map((x) => x.after.action)).toEqual(['addRole', 'deactivate']);
    await adminA.post('/api/admin/users/bulk', { userIds: [miaId], action: 'activate' });
    expect((await memberA.get('/api/ideas')).status).toBe(401); // the old session stays ended
  });

  it('imports people from CSV with preview and confirmation', async () => {
    await adminA.post('/api/admin/areas', { name: 'Vertrieb', description: '', topics: [], orgUnits: [] });
    const csv = [
      'E-Mail;Name;Rollen;Abteilung;Bereich',
      'lea@a.example;Lea Import;Triage, Gremium;Einkauf;Vertrieb',
      'mia@a.example;Mia Neu;Pate;Team A;',
      'kaputt;;;;',
      'boss@a.example;Boss;Admin;;',
      'lea@a.example;Doppelt;;;',
      'ole@a.example;Ole;Zauberer;;',
    ].join('\n');
    const data = Buffer.from(csv, 'utf8').toString('base64');
    const preview = await ua.post('/api/admin/users/import', { filename: 'personen.csv', data, dryRun: true });
    expect(preview.status).toBe(200);
    expect(preview.body.summary).toEqual({ total: 6, create: 1, update: 1, skip: 4 });
    expect(preview.body.rows.find((x: { email: string }) => x.email === 'boss@a.example').errors.join(' ')).toContain('Admin');
    expect((await withSystem((c) => c.query(`SELECT 1 FROM users WHERE email = 'lea@a.example'`))).rowCount).toBe(0);

    const done = await ua.post('/api/admin/users/import', { filename: 'personen.csv', data, dryRun: false });
    expect(done.body.summary).toMatchObject({ create: 1, update: 1 });
    const lea = (await withTenant(tenantA, (db) => db.query(`SELECT id, roles, org_unit FROM users WHERE email = 'lea@a.example'`))).rows[0];
    expect(lea.org_unit).toBe('Einkauf');
    // Triage and committee apply to the area only.
    expect(lea.roles).toEqual(['submitter']);
    const scoped = await withTenant(tenantA, (db) => db.query('SELECT role FROM role_assignments WHERE user_id = $1 ORDER BY role', [lea.id]));
    expect(scoped.rows.map((x) => x.role)).toEqual(['committee', 'triage']);
    const mia = (await withTenant(tenantA, (db) => db.query(`SELECT display_name, roles FROM users WHERE email = 'mia@a.example'`))).rows[0];
    expect(mia.display_name).toBe('Mia Neu');
    expect(mia.roles).toEqual(expect.arrayContaining(['committee', 'mentor']));
    const invite = await withTenant(tenantA, (db) => db.query(`SELECT 1 FROM outbox WHERE to_email = 'lea@a.example'`));
    expect(invite.rowCount).toBe(1);
    expect((await withTenant(tenantA, (db) => db.query(`SELECT 1 FROM audit_log WHERE action = 'users.import'`))).rowCount).toBe(1);
    // Nothing reaches the other tenant.
    expect((await withTenant(tenantB, (db) => db.query(`SELECT 1 FROM users WHERE email = 'lea@a.example'`))).rowCount).toBe(0);
    expect((await memberA.post('/api/admin/users/import', { filename: 'p.csv', data, dryRun: true })).status).toBe(401);
  });
});

describe('offboarding with re-authentication and grace period', () => {
  let adminACookie: string;

  it('needs the password and the TOTP code, keeps only admins in and can be cancelled', async () => {
    adminACookie = await login(app, 'ent-a', 'admin@a.example');
    const a = client(app, adminACookie);
    const member = client(app, await login(app, 'ent-a', 'people@a.example'));
    expect((await a.get('/api/admin/workspace/lifecycle')).body).toMatchObject({ status: 'active', reauth: 'password', graceDays: 30 });
    expect((await a.post('/api/admin/workspace/delete', { confirm: 'Mandant ent-a', password: 'falsch-falsch' })).status).toBe(401);
    // Two-factor login on: the code is needed as well.
    const secret = newTotpSecret();
    await withSystem((c) =>
      c.query(`UPDATE users SET mfa_secret = $2, mfa_enabled = true WHERE email = 'admin@a.example' AND tenant_id = $1`, [tenantA, secret]),
    );
    expect((await a.get('/api/admin/workspace/lifecycle')).body.reauth).toBe('password_totp');
    expect((await a.post('/api/admin/workspace/delete', { confirm: 'Mandant ent-a', password: PASSWORD })).status).toBe(401);
    const ok = await a.post('/api/admin/workspace/delete', { confirm: 'Mandant ent-a', password: PASSWORD, code: totp(secret), reason: 'Vertragsende' });
    expect(ok.status).toBe(200);
    expect(new Date(ok.body.deleteAfter).getTime()).toBeGreaterThan(Date.now() + 29 * 86400_000);
    const failed = await withTenant(tenantA, (db) => db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'tenant.delete_reauth_failed'`));
    expect(failed.rows[0].n).toBe(2);

    // Only admins remain; they can read and export but not change anything.
    expect((await member.get('/api/ideas')).status).toBe(401);
    const login403 = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenant: 'ent-a', email: 'people@a.example', password: PASSWORD } });
    expect(JSON.parse(login403.body).code).toBe('TENANT_DELETING');
    expect((await a.get('/api/ideas')).status).toBe(200);
    const write = await a.post('/api/ideas', validIdea);
    expect(write.status).toBe(403);
    expect(write.body.code).toBe('TENANT_DELETING');
    expect((await a.post('/api/admin/exports')).status).toBe(202);
    expect((await a.get('/api/admin/workspace/lifecycle')).body).toMatchObject({ status: 'deleting', deletionRequestedBy: 'admin' });
    // Jobs skip it; the export still runs.
    expect(Object.keys((await runAllJobs()) ?? {})).toEqual(['ent-b']);
    expect(await processExports()).toBe(1);

    expect((await a.post('/api/admin/workspace/delete/cancel')).body).toMatchObject({ ok: true, status: 'active' });
    expect((await a.post('/api/ideas', validIdea)).status).toBe(201);
  });

  it('accepts a fresh company login plus the slug for admins without password', async () => {
    const a = client(app, adminACookie);
    await withSystem((c) => c.query(`UPDATE sessions SET auth_method = 'oidc', created_at = now() - interval '30 minutes' WHERE tenant_id = $1`, [tenantA]));
    expect((await a.get('/api/admin/workspace/lifecycle')).body.reauth).toBe('sso');
    const stale = await a.post('/api/admin/workspace/delete', { confirm: 'Mandant ent-a', slug: 'ent-a' });
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('REAUTH_SSO_REQUIRED');
    await withSystem((c) => c.query(`UPDATE sessions SET created_at = now() WHERE tenant_id = $1`, [tenantA]));
    expect((await a.post('/api/admin/workspace/delete', { confirm: 'Mandant ent-a', slug: 'ent-b' })).status).toBe(401);
    expect((await a.post('/api/admin/workspace/delete', { confirm: 'Mandant ent-a', slug: 'ent-a' })).status).toBe(200);
    // The operator can cancel as well.
    expect((await op().post(`/api/operator/tenants/${tenantA}/offboarding/cancel`)).body.status).toBe('active');
  });

  it('lets the operator offboard; the job purges after the grace period and keeps a proof', async () => {
    const counts = await withSystem(
      async (c) => (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM ideas WHERE tenant_id = $1', [tenantA])).rows[0].n,
    );
    expect((await op().post(`/api/operator/tenants/${tenantA}/offboarding`, { reason: 'Kündigung', graceDays: 400 })).status).toBe(400);
    expect((await op().post(`/api/operator/tenants/${tenantA}/offboarding`, { reason: 'Kündigung', graceDays: 0 })).status).toBe(200);
    expect(await purgeDueTenants()).toBe(1);
    const left = await withSystem(async (c) => ({
      tenants: (await c.query('SELECT 1 FROM tenants WHERE id = $1', [tenantA])).rowCount,
      ideas: (await c.query('SELECT 1 FROM ideas WHERE tenant_id = $1', [tenantA])).rowCount,
      audit: (await c.query('SELECT 1 FROM audit_log WHERE tenant_id = $1', [tenantA])).rowCount,
      chunks: (await c.query('SELECT 1 FROM tenant_export_chunks WHERE tenant_id = $1', [tenantA])).rowCount,
    }));
    expect(left).toEqual({ tenants: 0, ideas: 0, audit: 0, chunks: 0 });
    const proofs = (await op().get('/api/operator/deletions')).body;
    expect(proofs).toHaveLength(1);
    expect(proofs[0]).toMatchObject({ slug: 'ent-a', requestedByKind: 'operator', requestedBy: 'operator', reason: 'Kündigung' });
    expect(proofs[0].rowCounts.ideas).toBe(counts);
    expect(JSON.stringify(proofs[0])).not.toContain(tenantA);
    expect(JSON.stringify(proofs[0])).not.toContain('Solarzellen');
    // The other tenant is untouched.
    expect((await adminB.get('/api/ideas')).status).toBe(200);
  });
});

describe('individual operator accounts with roles', () => {
  it('replaces the bootstrap token by personal accounts with TOTP and roles', async () => {
    // The bootstrap owner creates the first personal owner.
    const created = await op().post('/api/operator/operators', { email: 'vera@betrieb.example', name: 'Vera Betrieb', role: 'owner' });
    expect(created.status).toBe(201);
    const vera = created.body as { id: string; password: string; totpSecret: string };
    expect(vera.password.length).toBeGreaterThanOrEqual(16);
    const stored = await withSystem(async (c) => (await c.query('SELECT password_hash, totp_secret FROM operator_accounts WHERE id = $1', [vera.id])).rows[0]);
    expect(stored.password_hash).toMatch(/^scrypt\$/);
    expect(stored.totp_secret).not.toBe(vera.totpSecret);

    // With an owner account, the env token no longer works and its session ends.
    expect((await op().get('/api/operator/overview')).status).toBe(401);
    const boot = await app.inject({ method: 'POST', url: '/api/operator/login', payload: { token: OPERATOR_TOKEN, code: freshCode(OPERATOR_TOTP) } });
    expect(boot.statusCode).toBe(401);
    expect((await client(app, '').get('/api/operator/config')).body).toEqual({ enabled: true, bootstrap: false });
    // Break-glass keeps it open on purpose.
    config.operatorBreakGlass = true;
    expect((await client(app, '').get('/api/operator/config')).body.bootstrap).toBe(true);
    config.operatorBreakGlass = false;

    // Password and code are both needed; the start password must be changed first.
    expect((await accountLogin('vera@betrieb.example', 'falsch', vera.totpSecret)).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: '/api/operator/login', payload: { email: 'vera@betrieb.example', password: vera.password, code: '000000' } }))
        .statusCode,
    ).toBe(401);
    const res = await accountLogin('vera@betrieb.example', vera.password, vera.totpSecret);
    expect(res.statusCode).toBe(200);
    const veraCookie = cookieOf(res);
    expect((await op(veraCookie).get('/api/operator/overview')).body.code).toBe('OPERATOR_PASSWORD_CHANGE');
    expect((await op(veraCookie).get('/api/operator/me')).body).toMatchObject({ operator: 'Vera Betrieb', role: 'owner', mustChangePassword: true });
    expect((await op(veraCookie).post('/api/operator/me/password', { current: vera.password, password: 'kurz' })).status).toBe(400);
    expect((await op(veraCookie).post('/api/operator/me/password', { current: vera.password, password: 'ein-langes-neues-passwort' })).status).toBe(200);
    expect((await op(veraCookie).get('/api/operator/overview')).status).toBe(200);
    opCookie = veraCookie;

    // Roles: support, billing, technical.
    const mk = async (email: string, role: string) => {
      const c = (await op().post('/api/operator/operators', { email, name: email.split('@')[0], role })).body as {
        id: string;
        password: string;
        totpSecret: string;
      };
      const first = cookieOf(await accountLogin(email, c.password, c.totpSecret));
      await op(first).post('/api/operator/me/password', { current: c.password, password: `${role}-passwort-12345` });
      return { ...c, cookie: first };
    };
    const support = await mk('sam@betrieb.example', 'support');
    const billing = await mk('bea@betrieb.example', 'billing');
    const technical = await mk('tom@betrieb.example', 'technical');
    expect((await op(support.cookie).get('/api/operator/incidents')).status).toBe(200);
    expect((await op(support.cookie).get('/api/operator/billing/tenants')).status).toBe(403);
    expect((await op(support.cookie).post(`/api/operator/tenants/${tenantB}/suspend`, { reason: 'Test' })).status).toBe(403);
    expect((await op(support.cookie).get('/api/operator/operators')).status).toBe(403);
    expect((await op(billing.cookie).get('/api/operator/billing/tenants')).status).toBe(200);
    expect((await op(billing.cookie).get('/api/operator/incidents')).status).toBe(403);
    expect(
      (await op(technical.cookie).put(`/api/operator/tenants/${tenantB}/overrides`, { kind: 'feature', key: 'chat', enabled: false, reason: 'Wartung' }))
        .status,
    ).toBe(200);
    expect((await op(technical.cookie).get('/api/operator/billing/tenants')).status).toBe(403);
    expect((await op(technical.cookie).post('/api/operator/operators', { email: 'x@y.example', name: 'X Y', role: 'owner' })).status).toBe(403);

    // The log records the individual operator.
    const log = (await op().get('/api/operator/log')).body as { action: string; operator: string; operatorId: string | null }[];
    expect(log.find((l) => l.action === 'tenant.override_set')).toMatchObject({ operator: 'tom', operatorId: technical.id });
    expect(log.find((l) => l.action === 'operator.create' && l.operatorId === null)).toMatchObject({ operator: 'operator' });
    const audit = await withTenant(tenantB, (db) => db.query(`SELECT after FROM audit_log WHERE action = 'tenant.override_set'`));
    expect(audit.rows[0].after).toMatchObject({ operator: 'tom', operatorId: technical.id });

    // Deactivated accounts lose their session; the last owner stays.
    expect((await op().patch(`/api/operator/operators/${support.id}`, { active: false })).status).toBe(200);
    expect((await op(support.cookie).get('/api/operator/overview')).status).toBe(401);
    expect((await op().patch(`/api/operator/operators/${vera.id}`, { role: 'support' })).status).toBe(400);
    const second = await createOperator('test', { email: 'otto@betrieb.example', name: 'Otto', role: 'owner' });
    expect((await op().patch(`/api/operator/operators/${second.id}`, { active: false })).status).toBe(200);

    // Five wrong attempts lock the account.
    for (let i = 0; i < 5; i++) await accountLogin('bea@betrieb.example', 'falsch', billing.totpSecret);
    expect((await accountLogin('bea@betrieb.example', 'billing-passwort-12345', billing.totpSecret)).statusCode).toBe(423);
    const reset = await op().post(`/api/operator/operators/${billing.id}/reset`);
    expect(reset.status).toBe(200);
    expect((await accountLogin('bea@betrieb.example', reset.body.password, reset.body.totpSecret)).statusCode).toBe(200);
    expect((await op().get('/api/operator/operators')).body.map((o: { email: string }) => o.email)).toEqual(
      expect.arrayContaining(['vera@betrieb.example', 'bea@betrieb.example']),
    );
    // Operator tables are out of reach of the app role.
    await expect(withTenant(tenantB, (db) => db.query('SELECT 1 FROM operator_accounts'))).rejects.toThrow();
  });
});
