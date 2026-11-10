import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { withSystem, withTenant } from '../src/db/pool.js';
import { buildCtx, type Ctx, type Role, type SessionUser } from '../src/lib/context.js';
import { hashPassword } from '../src/lib/crypto.js';

export const PASSWORD = 'test-password-123';

export async function resetDb(): Promise<void> {
  await withSystem(async (c) => {
    await c.query('DROP SCHEMA public CASCADE');
    await c.query('CREATE SCHEMA public');
  });
  await migrate(() => undefined);
}

let hash: string | undefined;

export async function createTenant(slug: string, settings: Record<string, unknown> = {}): Promise<string> {
  return withSystem(async (c) =>
    (await c.query<{ id: string }>('INSERT INTO tenants (slug, name, settings) VALUES ($1, $2, $3) RETURNING id', [
      slug, `Mandant ${slug}`, JSON.stringify({ requireMfaForAdmins: false, ...settings }),
    ])).rows[0].id,
  );
}

export async function createUser(tenantId: string, email: string, roles: Role[] = ['submitter'], orgUnit = 'Team A'): Promise<SessionUser> {
  hash ??= await hashPassword(PASSWORD);
  const id = await withSystem(async (c) =>
    (await c.query<{ id: string }>(
      'INSERT INTO users (tenant_id, email, display_name, org_unit, roles, password_hash) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [tenantId, email, email.split('@')[0], orgUnit, roles, hash],
    )).rows[0].id,
  );
  return { id, tenantId, email, displayName: email.split('@')[0], orgUnit, roles, mfaEnabled: false };
}

export function asUser<T>(user: SessionUser | null, tenantId: string, fn: (ctx: Ctx) => Promise<T>, today?: string): Promise<T> {
  return withTenant(tenantId, async (db) => fn(await buildCtx(db, tenantId, user, today)));
}

export async function testApp(): Promise<FastifyInstance> {
  return buildApp({ logger: false });
}

export async function login(app: FastifyInstance, tenant: string, email: string, password = PASSWORD): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenant, email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'ip_session');
  return `ip_session=${cookie!.value}`;
}

/** Small client bound to a session cookie. */
export function client(app: FastifyInstance, cookie: string) {
  const call = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, payload: payload as object | undefined, headers: { cookie, ...(payload === undefined && method !== 'GET' ? { 'x-requested-with': 'fetch' } : {}) } });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, payload?: unknown) => call('POST', url, payload),
    patch: (url: string, payload?: unknown) => call('PATCH', url, payload),
    put: (url: string, payload?: unknown) => call('PUT', url, payload),
    del: (url: string) => call('DELETE', url),
  };
}

export const validIdea = {
  title: 'Weniger Wartezeit an der Kantine',
  problem: 'Mittags stehen alle gleichzeitig in der Schlange und verlieren Zeit.',
  solution: 'Gestaffelte Pausenzeiten je Abteilung und Vorbestellung per App.',
  benefit: 'Etwa 10 Minuten weniger Wartezeit pro Person und Tag.',
  topic: 'Arbeitsumfeld',
  ideaType: 'internal',
};
