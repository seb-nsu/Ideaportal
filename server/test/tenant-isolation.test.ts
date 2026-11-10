import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, withTenant } from '../src/db/pool.js';
import { createIdea, ideaInput } from '../src/services/workflow.js';
import { asUser, client, createTenant, createUser, login, resetDb, testApp, validIdea } from './helpers.js';

// R1-03: strict tenant separation with row-level security, tested with two tenants.

let app: FastifyInstance;
let tenantA: string;
let tenantB: string;
let ideaA: string;
let ideaB: string;

beforeAll(async () => {
  await resetDb();
  app = await testApp();
  tenantA = await createTenant('mandant-a');
  tenantB = await createTenant('mandant-b');
  const userA = await createUser(tenantA, 'anna@a.example', ['submitter', 'triage', 'admin']);
  const userB = await createUser(tenantB, 'ben@b.example', ['submitter', 'triage', 'admin']);
  ideaA = (await asUser(userA, tenantA, (ctx) => createIdea(ctx, ideaInput.parse({ ...validIdea, title: 'Idee von A' })))).id;
  ideaB = (await asUser(userB, tenantB, (ctx) => createIdea(ctx, ideaInput.parse({ ...validIdea, title: 'Idee von B' })))).id;
});

afterAll(async () => {
  await app.close();
  await closePool();
});

describe('row-level security', () => {
  it('only shows rows of the current tenant', async () => {
    const rows = await withTenant(tenantA, (db) => db.query('SELECT id FROM ideas'));
    expect(rows.rows.map((r) => r.id)).toEqual([ideaA]);
    const users = await withTenant(tenantB, (db) => db.query('SELECT email FROM users'));
    expect(users.rows.map((r) => r.email)).toEqual(['ben@b.example']);
  });

  it('shows nothing without tenant context', async () => {
    const rows = await withTenant('', (db) => db.query('SELECT id FROM ideas'));
    expect(rows.rowCount).toBe(0);
  });

  it('rejects writes into another tenant', async () => {
    await expect(
      withTenant(tenantA, (db) =>
        db.query(`UPDATE ideas SET tenant_id = $1 WHERE id = $2`, [tenantB, ideaA]),
      ),
    ).rejects.toThrow(/row-level security/);
    const touched = await withTenant(tenantA, (db) => db.query(`UPDATE ideas SET title = 'gehackt' WHERE id = $1`, [ideaB]));
    expect(touched.rowCount).toBe(0);
    await expect(
      withTenant(tenantA, (db) => db.query(`INSERT INTO comments (tenant_id, idea_id, author_id, body) SELECT $1, $2, author_id, 'x' FROM ideas WHERE id = $2`, [tenantB, ideaA])),
    ).rejects.toThrow(/row-level security/);
  });

  it('keeps the audit log append-only', async () => {
    await withTenant(tenantA, (db) =>
      db.query(`INSERT INTO audit_log (tenant_id, action, entity) VALUES ($1, 'test', 'test')`, [tenantA]),
    );
    await expect(withTenant(tenantA, (db) => db.query('DELETE FROM audit_log'))).rejects.toThrow(/permission denied|append-only/);
  });

  it('does not leak ideas or users over the API', async () => {
    const a = client(app, await login(app, 'mandant-a', 'anna@a.example'));
    expect((await a.get(`/api/ideas/${ideaB}`)).status).toBe(404);
    expect((await a.get(`/api/ideas/${ideaA}`)).status).toBe(200);
    const users = await a.get('/api/users?q=');
    expect(users.body.map((u: { email: string }) => u.email)).toEqual(['anna@a.example']);
    const exported = await a.get('/api/admin/export');
    expect(exported.body.ideas.map((i: { id: string }) => i.id)).toEqual([ideaA]);
  });

  it('cannot log in to another tenant with valid credentials', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenant: 'mandant-b', email: 'anna@a.example', password: 'test-password-123' } });
    expect(res.statusCode).toBe(401);
  });
});
