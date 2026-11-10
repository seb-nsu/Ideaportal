import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { withTenant, type Db } from '../db/pool.js';
import { badRequest } from './errors.js';
import { m } from '../i18n/index.js';

// Encryption of stored secrets (AES-256-GCM): AI and search keys (R2-09), TOTP secrets
// (R1-45), chat and webhook secrets (R3-16, R3-17), the OIDC client secret (R3-26).
//
// Envelope encryption (R3-01): every tenant has its own random data key (table tenant_keys).
// The data key is stored wrapped with the server's SECRET_KEY ("k1." format, bound to the
// tenant id) and encrypts that tenant's secrets ("v2." format, bound to the tenant id as
// additional authenticated data). A secret of tenant A can never be opened with B's key.
// Rotating SECRET_KEY (R3-41) only re-wraps the data keys, see db/rotate-key.ts.
//
// "v1." values are the older format, encrypted directly with SECRET_KEY. They are still read
// and are converted to "v2." on start (upgradeLegacySecrets in db/migrate.ts).
//
// Key derivation (enterprise security): "k2." wraps derive the wrapping key from SECRET_KEY with
// HKDF-SHA256 (salt and purpose label, versioned). Older "k1." wraps used a plain SHA-256 of
// SECRET_KEY; they stay readable and are re-wrapped as "k2." on start (upgradeKeyWrapping) and by
// every rotation. "v1." values keep the plain SHA-256 key, they are converted on start anyway.

const LEGACY = 'v1';
const TENANT = 'v2';
const WRAP_LEGACY = 'k1';
const WRAP = 'k2';

/**
 * Columns that hold sealed secrets. Columns named "*_enc" in tables with tenant_id are found
 * on their own (see secretColumns); others must be listed here so start and rotation convert them.
 */
export const SECRET_COLUMNS: { table: string; column: string }[] = [
  { table: 'users', column: 'mfa_secret' },
  { table: 'tenant_secrets', column: 'ciphertext' },
];

export function hasSecretKey(): boolean {
  return !!config.secretKey && config.secretKey.length >= 16;
}

function requireSecretKey(): void {
  if (!hasSecretKey()) throw badRequest(m('misc.noSecretKey'), { code: 'NO_SECRET_KEY' });
}

const masterKey = (secret: string) => createHash('sha256').update(secret).digest();

/** Wrapping key of "k2." values: HKDF-SHA256 over SECRET_KEY, bound to its purpose and version. */
const wrappingKey = (secret: string) => Buffer.from(hkdfSync('sha256', secret, 'ideenportal-secretbox', 'tenant-key-wrap:v2', 32));

/** Short public fingerprint of a SECRET_KEY: tells which key wrapped a tenant key, never the key. */
export const masterFingerprint = (secret: string) => createHash('sha256').update(`ideenportal-master:${secret}`).digest('hex').slice(0, 16);

/** The current SECRET_KEY first, then SECRET_KEY_PREVIOUS during a rotation. */
function masters(): string[] {
  return [config.secretKey, config.secretKeyPrevious].filter((s): s is string => !!s && s.length >= 16);
}

function seal(prefix: string, key: Buffer, plain: Buffer, aad?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return [prefix, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

function unseal(prefix: string, key: Buffer, stored: string, aad?: string): Buffer {
  const [v, iv, tag, data] = stored.split('.');
  if (v !== prefix || !iv || !tag || data === undefined) throw new Error('unknown secret format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]);
}

// ---------------------------------------------------------------- legacy format (SECRET_KEY)

/** @deprecated Older format without a tenant key; use sealSecret. Kept for tests and old data. */
export function encryptSecret(plain: string): string {
  requireSecretKey();
  return seal(LEGACY, masterKey(config.secretKey!), Buffer.from(plain, 'utf8'));
}

/** Opens an old "v1." value with SECRET_KEY or, during a rotation, SECRET_KEY_PREVIOUS. */
export function decryptSecret(stored: string, secrets: string[] = masters()): string {
  if (!secrets.length) requireSecretKey();
  let last: unknown;
  for (const s of secrets) {
    try {
      return unseal(LEGACY, masterKey(s), stored).toString('utf8');
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

export const isSealed = (stored: string) => stored.startsWith(`${LEGACY}.`) || stored.startsWith(`${TENANT}.`);
export const isTenantSealed = (stored: string) => stored.startsWith(`${TENANT}.`);

// ---------------------------------------------------------------- tenant data keys (R3-01)

const wrapAad = (tenantId: string) => `tenant-key:${tenantId}`;

export function wrapKey(dataKey: Buffer, tenantId: string, secret: string): string {
  return seal(WRAP, wrappingKey(secret), dataKey, wrapAad(tenantId));
}

/** @deprecated Older "k1." wrap (plain SHA-256 of SECRET_KEY); only for tests of the upgrade path. */
export function wrapKeyLegacy(dataKey: Buffer, tenantId: string, secret: string): string {
  return seal(WRAP_LEGACY, masterKey(secret), dataKey, wrapAad(tenantId));
}

export const isLegacyWrap = (wrapped: string) => wrapped.startsWith(`${WRAP_LEGACY}.`);

/** Opens "k2." (HKDF) and older "k1." (SHA-256) wraps; the prefix tells which derivation applies. */
export function unwrapKey(wrapped: string, tenantId: string, secret: string): Buffer {
  if (isLegacyWrap(wrapped)) return unseal(WRAP_LEGACY, masterKey(secret), wrapped, wrapAad(tenantId));
  return unseal(WRAP, wrappingKey(secret), wrapped, wrapAad(tenantId));
}

/**
 * Re-wraps "k1." tenant keys as "k2." with the same SECRET_KEY (owner connection, on start).
 * The data key and therefore every stored secret stay unchanged. Keys wrapped with an unknown
 * SECRET_KEY are left as they are. Returns the number of re-wrapped keys.
 */
export async function upgradeKeyWrapping(c: Db, secrets: string[] = masters()): Promise<number> {
  if (!hasSecretKey()) return 0;
  const rows = (await c.query<{ tenant_id: string; wrapped_key: string; master_fp: string }>(
    `SELECT tenant_id, wrapped_key, master_fp FROM tenant_keys WHERE wrapped_key LIKE 'k1.%' FOR UPDATE`,
  )).rows;
  let n = 0;
  for (const r of rows) {
    const secret = secrets.find((s) => masterFingerprint(s) === r.master_fp);
    if (!secret) continue;
    let dataKey: Buffer;
    try {
      dataKey = unwrapKey(r.wrapped_key, r.tenant_id, secret);
    } catch (err) {
      console.warn(`[secrets] tenant key of ${r.tenant_id} not re-wrapped: ${(err as Error).message.slice(0, 120)}`);
      continue;
    }
    await c.query('UPDATE tenant_keys SET wrapped_key = $2, rewrapped_at = now() WHERE tenant_id = $1 AND wrapped_key = $3', [
      r.tenant_id, wrapKey(dataKey, r.tenant_id, secret), r.wrapped_key,
    ]);
    n++;
  }
  return n;
}

// Unwrapped keys by tenant and wrapped value: a re-wrapped or new key is simply a new entry,
// and a key from a rolled-back transaction is never used, because the row is read every time.
const cache = new Map<string, Buffer>();

interface KeyRow {
  wrapped_key: string;
  master_fp: string;
}

async function readKey(db: Db, tenantId: string): Promise<KeyRow | undefined> {
  return (await db.query<KeyRow>('SELECT wrapped_key, master_fp FROM tenant_keys WHERE tenant_id = $1', [tenantId])).rows[0];
}

/** Creates the data key of a tenant if it has none yet (same transaction as the caller). */
export async function ensureTenantKey(db: Db, tenantId: string): Promise<void> {
  requireSecretKey();
  if (await readKey(db, tenantId)) return;
  await db.query('INSERT INTO tenant_keys (tenant_id, wrapped_key, master_fp) VALUES ($1, $2, $3) ON CONFLICT (tenant_id) DO NOTHING', [
    tenantId, wrapKey(randomBytes(32), tenantId, config.secretKey!), masterFingerprint(config.secretKey!),
  ]);
}

/** The data key of a tenant; db may be a tenant connection (RLS) or the owner connection. */
export async function tenantKey(db: Db, tenantId: string): Promise<Buffer> {
  requireSecretKey();
  let row = await readKey(db, tenantId);
  if (!row) {
    await ensureTenantKey(db, tenantId);
    row = await readKey(db, tenantId);
    if (!row) throw new Error('tenant key missing');
  }
  // The configured keys decide, not the cache: without the wrapping key the tenant key is closed.
  const secret = masters().find((s) => masterFingerprint(s) === row.master_fp);
  if (!secret) throw new Error(`tenant key of ${tenantId} is wrapped with an unknown SECRET_KEY (fingerprint ${row.master_fp})`);
  const id = `${tenantId}:${row.wrapped_key}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const key = unwrapKey(row.wrapped_key, tenantId, secret);
  if (cache.size > 5000) cache.clear();
  cache.set(id, key);
  return key;
}

/** Runs fn with the given connection or, without one, in a tenant transaction of its own. */
const using = <T>(db: Db | null, tenantId: string, fn: (c: Db) => Promise<T>) => (db ? fn(db) : withTenant(tenantId, fn));

/** Encrypts a secret of the tenant with its own data key ("v2."). */
export async function sealSecret(db: Db | null, tenantId: string, plain: string): Promise<string> {
  const key = await using(db, tenantId, (c) => tenantKey(c, tenantId));
  return seal(TENANT, key, Buffer.from(plain, 'utf8'), tenantId);
}

/** Opens a secret of the tenant: "v2." with the tenant key, older "v1." with SECRET_KEY. */
export async function openSecret(db: Db | null, tenantId: string, stored: string): Promise<string> {
  if (stored.startsWith(`${LEGACY}.`)) return decryptSecret(stored);
  const key = await using(db, tenantId, (c) => tenantKey(c, tenantId));
  return unseal(TENANT, key, stored, tenantId).toString('utf8');
}

/** Opens with an explicit key (tests prove that the key of another tenant fails). */
export function openWithKey(key: Buffer, tenantId: string, stored: string): string {
  return unseal(TENANT, key, stored, tenantId).toString('utf8');
}

/**
 * TOTP secrets are stored encrypted when the server has a SECRET_KEY. Without one (local
 * development only) they stay readable; the health endpoint and the start log warn about it.
 */
export async function sealTotp(db: Db | null, tenantId: string, secret: string): Promise<string> {
  return hasSecretKey() ? sealSecret(db, tenantId, secret) : secret;
}

export async function openTotp(db: Db | null, tenantId: string, stored: string): Promise<string> {
  return isSealed(stored) ? openSecret(db, tenantId, stored) : stored;
}

/** Registered secret columns plus every "*_enc" text column of a table with tenant_id. */
export async function secretColumns(c: Db): Promise<{ table: string; column: string }[]> {
  const found = await c.query<{ table: string; column: string }>(
    `SELECT col.table_name AS table, col.column_name AS column
       FROM information_schema.columns col
      WHERE col.table_schema = 'public' AND col.column_name LIKE '%\\_enc' AND col.data_type = 'text'
        AND EXISTS (SELECT 1 FROM information_schema.columns t
                     WHERE t.table_schema = 'public' AND t.table_name = col.table_name AND t.column_name = 'tenant_id')
      ORDER BY 1, 2`,
  );
  const all = [...SECRET_COLUMNS];
  for (const r of found.rows) if (!all.some((x) => x.table === r.table && x.column === r.column)) all.push(r);
  return all;
}

/**
 * Converts "v1." values (encrypted with SECRET_KEY) into "v2." values with the tenant key.
 * Runs on start (owner connection) and in the rotation; returns the number of values.
 */
export async function upgradeLegacySecrets(c: Db, secrets: string[] = masters()): Promise<number> {
  if (!hasSecretKey()) return 0;
  let n = 0;
  for (const { table, column } of await secretColumns(c)) {
    const rows = (await c.query<{ tid: string; tenant_id: string; value: string }>(
      `SELECT ctid::text AS tid, tenant_id, ${ident(column)} AS value FROM ${ident(table)} WHERE ${ident(column)} LIKE 'v1.%'`,
    )).rows;
    for (const r of rows) {
      let sealed: string;
      try {
        sealed = await sealSecret(c, r.tenant_id, decryptSecret(r.value, secrets));
      } catch (err) {
        // Wrong or missing key: leave the value as it is, the start must not fail because of it.
        console.warn(`[secrets] ${table}.${column} of tenant ${r.tenant_id} not converted: ${(err as Error).message.slice(0, 120)}`);
        continue;
      }
      await c.query(`UPDATE ${ident(table)} SET ${ident(column)} = $1 WHERE ctid = $2::tid AND ${ident(column)} = $3`, [sealed, r.tid, r.value]);
      n++;
    }
  }
  return n;
}

function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`invalid identifier ${name}`);
  return `"${name}"`;
}
