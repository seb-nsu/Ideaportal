import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setDnsLookup } from '../src/ai/providers.js';
import { buildCtx } from '../src/lib/context.js';
import { closePool, withSystem, withTenant } from '../src/db/pool.js';
import { totp } from '../src/lib/crypto.js';
import { purgeTenant } from '../src/routes/pilot.js';
import { forwardSiem, SIEM_BATCH } from '../src/services/siem.js';
import { verifySignature, type WebhookRequest } from '../src/services/webhooks.js';
import { PASSWORD, client, createTenant, createUser, login, resetDb, testApp } from './helpers.js';

// Enterprise security, part 1: login audit with request data, tamper-evident hash chain,
// filtered view and streaming export of the audit log, SIEM forwarding.

let app: FastifyInstance;
let tenantA: string;
let tenantB: string;
let adminA: ReturnType<typeof client>;
let adminB: ReturnType<typeof client>;
let memberA: ReturnType<typeof client>;

const auditRows = (tenantId: string, action?: string) =>
  withSystem(
    async (c) =>
      (
        await c.query(
          `SELECT id, actor_id, action, ip_hash, user_agent, request_id, chain_seq, prev_hash, row_hash
         FROM audit_log WHERE tenant_id = $1 AND ($2::text IS NULL OR action = $2) ORDER BY chain_seq`,
          [tenantId, action ?? null],
        )
      ).rows,
  );

beforeAll(async () => {
  await resetDb();
  app = await testApp();
  tenantA = await createTenant('sec-a');
  tenantB = await createTenant('sec-b');
  await createUser(tenantA, 'admin@sec-a.example', ['submitter', 'admin']);
  await createUser(tenantA, 'member@sec-a.example');
  await createUser(tenantB, 'admin@sec-b.example', ['submitter', 'admin']);
  adminA = client(app, await login(app, 'sec-a', 'admin@sec-a.example'));
  adminB = client(app, await login(app, 'sec-b', 'admin@sec-b.example'));
  memberA = client(app, await login(app, 'sec-a', 'member@sec-a.example'));
});

afterEach(() => setDnsLookup());

afterAll(async () => {
  await app.close();
  await closePool();
});

describe('login audit', () => {
  it('logs a successful login with request id, hashed address and shortened user agent', async () => {
    const ua = `Mozilla/5.0 ${'x'.repeat(400)}`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '203.0.113.7',
      headers: { 'x-request-id': 'req-login-0001', 'user-agent': ua },
      payload: { tenant: 'sec-a', email: 'member@sec-a.example', password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBe('req-login-0001');
    const row = (await auditRows(tenantA, 'auth.login')).find((r) => r.request_id === 'req-login-0001')!;
    expect(row).toBeTruthy();
    expect(row.ip_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(row.ip_hash).not.toContain('203.0.113.7');
    expect(row.user_agent).toHaveLength(200);
    // Same address, same hash: attempts from one address can be grouped.
    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '203.0.113.7',
      headers: { 'x-request-id': 'req-login-0002' },
      payload: { tenant: 'sec-a', email: 'member@sec-a.example', password: PASSWORD },
    });
    const second = (await auditRows(tenantA, 'auth.login')).find((r) => r.request_id === 'req-login-0002')!;
    expect(second.ip_hash).toBe(row.ip_hash);
  });

  it('logs failed passwords of existing accounts in their tenant only, nothing for unknown addresses', async () => {
    const before = (await auditRows(tenantA, 'auth.login_failed')).length;
    const beforeB = (await auditRows(tenantB)).length;
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { tenant: 'sec-a', email: 'member@sec-a.example', password: 'falsch-falsch-falsch' },
    });
    expect(wrong.statusCode).toBe(401);
    const failed = await auditRows(tenantA, 'auth.login_failed');
    expect(failed).toHaveLength(before + 1);
    const unknown = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'niemand@sec-a.example', password: 'falsch-falsch-falsch' } });
    expect(unknown.statusCode).toBe(401);
    expect(await auditRows(tenantA, 'auth.login_failed')).toHaveLength(before + 1);
    expect(await auditRows(tenantB)).toHaveLength(beforeB);
  });

  it('logs failed and verified second factors and the logout', async () => {
    const user = await createUser(tenantA, 'mfa@sec-a.example');
    const me = client(app, await login(app, 'sec-a', 'mfa@sec-a.example'));
    const setup = await me.post('/api/auth/mfa/setup');
    expect((await me.post('/api/auth/mfa/enable', { code: totp(setup.body.secret) })).status).toBe(200);
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenant: 'sec-a', email: 'mfa@sec-a.example', password: PASSWORD } });
    const cookie = `ip_session=${res.cookies.find((c) => c.name === 'ip_session')!.value}`;
    const pending = client(app, cookie);
    expect((await pending.post('/api/auth/mfa', { code: '000000' })).status).toBe(401);
    expect((await auditRows(tenantA, 'auth.mfa_failed')).some((r) => r.actor_id === user.id)).toBe(true);
    expect((await pending.post('/api/auth/mfa', { code: totp(setup.body.secret) })).status).toBe(200);
    expect((await auditRows(tenantA, 'auth.mfa_verified')).some((r) => r.actor_id === user.id)).toBe(true);
    expect((await pending.post('/api/auth/logout')).status).toBe(200);
    expect((await auditRows(tenantA, 'auth.logout')).some((r) => r.actor_id === user.id)).toBe(true);
    expect((await pending.get('/api/me')).status).toBe(401);
  });
});

describe('hash chain (tamper evidence)', () => {
  it('numbers the rows of each tenant without gaps and links every row to the previous one', async () => {
    for (const t of [tenantA, tenantB]) {
      const rows = await auditRows(t);
      expect(rows.length).toBeGreaterThan(0);
      rows.forEach((r, i) => {
        expect(Number(r.chain_seq)).toBe(i + 1);
        expect(r.prev_hash).toBe(i === 0 ? '0'.repeat(64) : rows[i - 1].row_hash);
        expect(r.row_hash).toMatch(/^[0-9a-f]{64}$/);
      });
    }
  });

  it('keeps the chain intact under concurrent inserts', async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        withTenant(tenantB, (db) =>
          db.query(`INSERT INTO audit_log (tenant_id, action, entity, after) VALUES ($1, 'test.parallel', 'tenant', $2)`, [tenantB, JSON.stringify({ i })]),
        ),
      ),
    );
    const res = await adminB.get('/api/admin/audit/verify');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, broken: null, firstSeq: 1 });
    expect(res.body.checked).toBeGreaterThanOrEqual(25);
  });

  it('is verified by admins only and only for the own tenant', async () => {
    expect((await memberA.get('/api/admin/audit/verify')).status).toBe(403);
    expect((await adminA.get('/api/admin/audit/verify')).body.ok).toBe(true);
    await expect(withTenant(tenantA, (db) => db.query('SELECT * FROM audit_verify($1)', [tenantB]))).rejects.toThrow(/tenant mismatch/);
    // Rows and chain heads of B stay invisible to A.
    expect((await withTenant(tenantA, (db) => db.query('SELECT 1 FROM audit_chain_heads WHERE tenant_id = $1', [tenantB]))).rowCount).toBe(0);
    await expect(withTenant(tenantA, (db) => db.query(`UPDATE audit_chain_heads SET last_seq = 1`))).rejects.toThrow(/permission denied/);
  });

  it('reports the first changed, removed or appended-away row', async () => {
    const t = await createTenant('sec-tamper');
    await createUser(t, 'admin@sec-tamper.example', ['submitter', 'admin']);
    const admin = client(app, await login(app, 'sec-tamper', 'admin@sec-tamper.example'));
    for (let i = 0; i < 5; i++)
      await withTenant(t, (db) =>
        db.query(`INSERT INTO audit_log (tenant_id, action, entity, after) VALUES ($1, 'test.row', 'tenant', $2)`, [t, JSON.stringify({ i })]),
      );
    expect((await admin.get('/api/admin/audit/verify')).body.ok).toBe(true);
    const rows = await auditRows(t, 'test.row');
    // Someone with database owner rights changes a row behind the app's back.
    const tamper = (sql: string, params: unknown[]) =>
      withSystem(async (c) => {
        await c.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update');
        try {
          await c.query(sql, params);
        } finally {
          await c.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update');
        }
      });
    await tamper(`UPDATE audit_log SET after = '{"i": 99}' WHERE id = $1`, [rows[2].id]);
    let v = (await admin.get('/api/admin/audit/verify')).body;
    expect(v).toMatchObject({ ok: false, broken: { id: Number(rows[2].id), seq: Number(rows[2].chain_seq), reason: 'row_hash' } });
    await tamper('DELETE FROM audit_log WHERE id = $1', [rows[2].id]);
    v = (await admin.get('/api/admin/audit/verify')).body;
    expect(v.broken).toMatchObject({ id: Number(rows[3].id), reason: 'gap' });
    // Removing the newest rows is noticed through the chain head.
    const all = await auditRows(t);
    await tamper('DELETE FROM audit_log WHERE tenant_id = $1 AND chain_seq >= $2', [t, rows[2].chain_seq]);
    v = (await withTenant(t, (db) => db.query('SELECT * FROM audit_verify($1)', [t]))).rows[0];
    expect(v).toMatchObject({ ok: false, reason: 'tail' });
    expect(all.length).toBeGreaterThan(Number(rows[2].chain_seq));
  });

  it('still lets a whole workspace be deleted with its audit trail and chain head', async () => {
    const t = await createTenant('sec-purge');
    await withTenant(t, (db) => db.query(`INSERT INTO audit_log (tenant_id, action, entity) VALUES ($1, 'test.purge', 'tenant')`, [t]));
    await purgeTenant(t);
    const left = await withSystem(async (c) => ({
      rows: (await c.query('SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1', [t])).rows[0].n,
      heads: (await c.query('SELECT count(*)::int AS n FROM audit_chain_heads WHERE tenant_id = $1', [t])).rows[0].n,
    }));
    expect(left).toEqual({ rows: 0, heads: 0 });
    // Single rows stay append-only.
    await expect(withSystem((c) => c.query('DELETE FROM audit_log WHERE tenant_id = $1', [tenantA]))).rejects.toThrow(/append-only/);
  });
});

describe('audit view and export', () => {
  beforeAll(async () => {
    // More rows than the old limit of 5,000 for the export.
    await withSystem((c) =>
      c.query(
        `INSERT INTO audit_log (tenant_id, action, entity, entity_id, after)
         SELECT $1, 'bulk.row', 'tenant', g::text, jsonb_build_object('n', g) FROM generate_series(1, 5200) g`,
        [tenantA],
      ),
    );
  });

  it('filters by action prefix, person and date and pages with a cursor', async () => {
    const auth = await adminA.get('/api/admin/audit?paged=true&action=auth.&limit=3');
    expect(auth.status).toBe(200);
    expect(auth.body.items.length).toBe(3);
    expect(auth.body.items.every((a: { action: string }) => a.action.startsWith('auth.'))).toBe(true);
    const next = await adminA.get(`/api/admin/audit?action=auth.&limit=3&cursor=${auth.body.nextCursor}`);
    const ids = new Set(auth.body.items.map((a: { id: number }) => a.id));
    expect(next.body.items.some((a: { id: number }) => ids.has(a.id))).toBe(false);
    expect(Math.max(...next.body.items.map((a: { id: number }) => a.id))).toBeLessThan(Math.min(...(ids as Set<number>)));
    const system = await adminA.get('/api/admin/audit?paged=true&actor=system&action=bulk.&limit=5');
    expect(system.body.items.every((a: { actorName: string | null }) => a.actorName === null)).toBe(true);
    const byName = await adminA.get('/api/admin/audit?paged=true&actor=member&action=auth.login&limit=50');
    expect(byName.body.items.length).toBeGreaterThan(0);
    expect(byName.body.items.every((a: { actorEmail: string }) => a.actorEmail === 'member@sec-a.example')).toBe(true);
    const future = await adminA.get('/api/admin/audit?paged=true&from=2999-01-01');
    expect(future.body.items).toEqual([]);
    const today = new Date().toISOString().slice(0, 10);
    expect((await adminA.get(`/api/admin/audit?paged=true&from=2000-01-01&to=${today}&limit=1`)).body.items).toHaveLength(1);
    // Without paging the old array answer stays.
    expect(Array.isArray((await adminA.get('/api/admin/audit?limit=2')).body)).toBe(true);
    expect((await adminA.get('/api/admin/audit?action=drop%20table')).status).toBe(400);
  });

  it('streams the whole log as JSON Lines and CSV without the old row limit, per tenant', async () => {
    // The client helper parses JSON; the export is fetched raw.
    const cookie = await login(app, 'sec-a', 'admin@sec-a.example');
    const jsonl = await app.inject({ method: 'GET', url: '/api/admin/audit/export?format=jsonl&action=bulk.', headers: { cookie } });
    expect(jsonl.statusCode).toBe(200);
    expect(jsonl.headers['content-type']).toContain('application/x-ndjson');
    const lines = jsonl.body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(5200);
    expect(lines[0]).toMatchObject({ action: 'bulk.row', entityId: '1' });
    expect(lines[0].rowHash).toMatch(/^[0-9a-f]{64}$/);
    const csv = await app.inject({ method: 'GET', url: '/api/admin/audit/export?format=csv', headers: { cookie } });
    expect(csv.statusCode).toBe(200);
    expect(csv.body.charCodeAt(0)).toBe(0xfeff);
    expect(csv.body.split('\r\n').filter(Boolean).length).toBeGreaterThan(5200);
    // Tenant B sees none of A's rows.
    const cookieB = await login(app, 'sec-b', 'admin@sec-b.example');
    const b = await app.inject({ method: 'GET', url: '/api/admin/audit/export?format=jsonl&action=bulk.', headers: { cookie: cookieB } });
    expect(b.body.trim()).toBe('');
    expect((await memberA.get('/api/admin/audit/export')).status).toBe(403);
  });

  it('protects the CSV export against formula injection', async () => {
    await withTenant(tenantB, (db) =>
      db.query(`INSERT INTO audit_log (tenant_id, action, entity, entity_id) VALUES ($1, 'test.csv', 'tenant', '=HYPERLINK("x")')`, [tenantB]),
    );
    const cookieB = await login(app, 'sec-b', 'admin@sec-b.example');
    const csv = await app.inject({ method: 'GET', url: '/api/admin/audit/export?format=csv&action=test.csv', headers: { cookie: cookieB } });
    expect(csv.body).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe('SIEM forwarding', () => {
  const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

  it('accepts only public https targets', async () => {
    expect((await adminA.put('/api/admin/audit/siem', { url: 'http://siem.example.com/in' })).status).toBe(400);
    setDnsLookup(async () => [{ address: '10.0.0.5', family: 4 }]);
    const priv = await adminA.put('/api/admin/audit/siem', { url: 'https://siem.intern.example/in' });
    expect(priv.status).toBe(400);
    expect(priv.body.details.reason).toBe('private');
    expect((await memberA.put('/api/admin/audit/siem', { url: 'https://siem.example.com/in' })).status).toBe(403);
  });

  it('sends signed batches with the chain values and retries without losing rows', async () => {
    setDnsLookup(publicDns);
    const saved = await adminB.put('/api/admin/audit/siem', { url: 'https://siem.example.com/in', backfill: true });
    expect(saved.status).toBe(200);
    expect(saved.body.secret).toMatch(/^siemsec_/);
    const status = await adminB.get('/api/admin/audit/siem');
    expect(status.body.siem).toMatchObject({ url: 'https://siem.example.com/in', active: true, forwardedSeq: 0 });
    expect(status.body.siem.pending).toBeGreaterThan(0);
    expect(JSON.stringify(status.body)).not.toContain(saved.body.secret);

    const now = new Date();
    const down = async () => ({ status: 503 });
    const failed = await withTenant(tenantB, async (db) => forwardSiem(await buildCtx(db, tenantB, null), { now, send: down }));
    expect(failed).toEqual({ sent: 0, failed: true });
    const after = (await adminB.get('/api/admin/audit/siem')).body.siem;
    expect(after).toMatchObject({ forwardedSeq: 0, failureCount: 1, lastError: 'http_503' });
    // Not due before the backoff has passed.
    const sent: WebhookRequest[] = [];
    const ok = async (req: WebhookRequest) => {
      sent.push(req);
      return { status: 202 };
    };
    expect(await withTenant(tenantB, async (db) => forwardSiem(await buildCtx(db, tenantB, null), { now, send: ok }))).toEqual({ sent: 0, failed: false });
    const later = new Date(now.getTime() + 61_000);
    const r = await withTenant(tenantB, async (db) => forwardSiem(await buildCtx(db, tenantB, null), { now: later, send: ok }));
    expect(r.failed).toBe(false);
    expect(r.sent).toBeGreaterThan(0);
    expect(r.sent).toBeLessThanOrEqual(SIEM_BATCH * 10);
    const body = JSON.parse(sent[0].body);
    expect(sent[0].headers['x-ideenportal-event']).toBe('audit.batch');
    expect(verifySignature(saved.body.secret, sent[0].headers['x-ideenportal-signature'], sent[0].body, { now: Math.floor(later.getTime() / 1000) })).toBe(
      true,
    );
    expect(body.events[0].seq).toBe(1);
    expect(body.tenantId).toBe(tenantB);
    // The receiver can recompute every row hash and the links between rows.
    let prev = '0'.repeat(64);
    for (const e of body.events) {
      expect(e.prevHash).toBe(prev);
      expect(
        createHash('sha256')
          .update(prev + e.canonical)
          .digest('hex'),
      ).toBe(e.rowHash);
      prev = e.rowHash;
    }
    // No tenant A rows in B's batch.
    expect(body.events.some((e: { action: string }) => e.action === 'bulk.row')).toBe(false);
    const done = (await adminB.get('/api/admin/audit/siem')).body.siem;
    expect(done).toMatchObject({ failureCount: 0, lastError: null });
    const lastSent = JSON.parse(sent.at(-1)!.body).events.at(-1).seq;
    expect(done.forwardedSeq).toBe(lastSent);
    expect(lastSent - 1).toBe(sent.reduce((n, req) => n + JSON.parse(req.body).events.length, 0) - 1);
  });

  it('forwards from the current position without backfill, rotates the secret and is invisible to other tenants', async () => {
    setDnsLookup(publicDns);
    const saved = await adminA.put('/api/admin/audit/siem', { url: 'https://siem.example.com/a' });
    const head = await withSystem(async (c) => (await c.query('SELECT last_seq FROM audit_chain_heads WHERE tenant_id = $1', [tenantA])).rows[0].last_seq);
    const s = (await adminA.get('/api/admin/audit/siem')).body.siem;
    expect(s.forwardedSeq).toBeGreaterThanOrEqual(Number(head) - 2);
    const rotated = await adminA.post('/api/admin/audit/siem/rotate');
    expect(rotated.body.secret).not.toBe(saved.body.secret);
    expect((await withTenant(tenantB, (db) => db.query('SELECT 1 FROM siem_settings WHERE tenant_id = $1', [tenantA]))).rowCount).toBe(0);
    expect((await adminA.patch('/api/admin/audit/siem', { active: false })).status).toBe(200);
    expect((await adminA.get('/api/admin/audit/siem')).body.siem.active).toBe(false);
    expect((await adminA.del('/api/admin/audit/siem')).status).toBe(200);
    expect((await adminA.get('/api/admin/audit/siem')).body.siem).toBeNull();
    expect((await adminA.post('/api/admin/audit/siem/rotate')).status).toBe(404);
    const actions = (await auditRows(tenantA)).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['siem.save', 'siem.rotate_secret', 'siem.update', 'siem.delete']));
  });
});
