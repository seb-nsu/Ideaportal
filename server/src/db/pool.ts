import { readFileSync } from 'node:fs';
import pg from 'pg';
import { config } from '../config.js';
import { currentContext } from '../lib/requestContext.js';

// Return DATE columns as plain 'YYYY-MM-DD' strings; deadlines are calendar dates.
pg.types.setTypeParser(1082, (v) => v);
// numeric -> number (benefit values are small enough)
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(20, (v) => Number(v));

export type Db = pg.PoolClient;

let pool: pg.Pool | undefined;

/** TLS options for the database connection (R3-08, DATABASE_SSL). */
export function poolSsl(mode = config.databaseSsl, ca = config.databaseSslCa): pg.PoolConfig['ssl'] {
  // DATABASE_SSL_CA holds the PEM text or the path of a PEM file.
  if (mode === 'require') return { rejectUnauthorized: true, ...(ca ? { ca: ca.includes('-----BEGIN') ? ca : readFileSync(ca, 'utf8') } : {}) };
  // Encrypted without certificate check: protects against passive sniffing only.
  if (mode === 'no-verify') return { rejectUnauthorized: false }; // security-ok: opt-in DATABASE_SSL=no-verify
  return undefined;
}

export function getPool(): pg.Pool {
  const ssl = poolSsl();
  pool ??= new pg.Pool({ connectionString: config.databaseUrl, max: 10, ...(ssl ? { ssl } : {}) });
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

async function tx<T>(setup: (c: Db) => Promise<void>, fn: (c: Db) => Promise<T>, begin = 'BEGIN'): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query(begin);
    await setup(client);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Runs fn inside a transaction as the restricted role with the tenant context set.
 * Row-level security guarantees that only rows of this tenant are visible or writable.
 */
export function withTenant<T>(tenantId: string, fn: (c: Db) => Promise<T>): Promise<T> {
  return tx(async (c) => {
    await c.query('SET LOCAL ROLE ideenportal_app');
    const r = currentContext();
    // Request id, hashed address and user agent for the audit trigger (migration 031), in the same round trip.
    await c.query(
      `SELECT set_config('app.tenant_id', $1, true), set_config('app.request_id', $2, true),
              set_config('app.ip_hash', $3, true), set_config('app.user_agent', $4, true)`,
      [tenantId, r?.requestId ?? '', r?.ipHash ?? '', r?.userAgent ?? ''],
    );
  }, fn);
}

/** Owner connection without tenant context: login, session lookup, job scheduling, migrations. */
export function withSystem<T>(fn: (c: Db) => Promise<T>): Promise<T> {
  const r = currentContext();
  if (!r) return tx(async () => undefined, fn);
  // Inside a request the context goes along with BEGIN (one round trip); values are escaped literals.
  const lit = (v: string | null) => pg.escapeLiteral(v ?? '');
  const begin = `BEGIN; SELECT set_config('app.request_id', ${lit(r.requestId)}, true), set_config('app.ip_hash', ${lit(r.ipHash)}, true), set_config('app.user_agent', ${lit(r.userAgent)}, true)`;
  return tx(async () => undefined, fn, begin);
}
