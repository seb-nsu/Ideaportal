import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ensureTenantKey, hasSecretKey, isSealed, sealSecret, upgradeKeyWrapping, upgradeLegacySecrets } from '../lib/secretbox.js';
import { closePool, withSystem, type Db } from './pool.js';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

export async function migrate(log: (msg: string) => void = console.log): Promise<void> {
  await withSystem(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(4711)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await c.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      await c.query(await readFile(path.join(migrationsDir, file), 'utf8'));
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      log(`migration applied: ${file}`);
    }
    // pgvector may have been enabled after migration 017 (R3-28): switch the embedding column then.
    const fn = await c.query<{ ok: boolean }>("SELECT to_regprocedure('enable_vector_search()') IS NOT NULL AS ok");
    if (fn.rows[0].ok) await c.query('SELECT enable_vector_search()');
    const sealed = await sealLegacyTotpSecrets(c);
    if (sealed) log(`totp secrets encrypted: ${sealed}`);
    // R3-01: every tenant gets its own data key; secrets of the older format move to it.
    const keys = await ensureAllTenantKeys(c);
    if (keys) log(`tenant keys created: ${keys}`);
    // Tenant keys wrapped with the older SHA-256 derivation move to HKDF ("k1." -> "k2.").
    const rewrapped = await upgradeKeyWrapping(c);
    if (rewrapped) log(`tenant keys re-wrapped with HKDF: ${rewrapped}`);
    const upgraded = await upgradeLegacySecrets(c);
    if (upgraded) log(`secrets moved to tenant keys: ${upgraded}`);
  });
}

/**
 * Data migration for R1-45: encrypts TOTP secrets that were stored before encryption existed.
 * Runs on every start and only touches plaintext values; without SECRET_KEY it does nothing.
 */
export async function sealLegacyTotpSecrets(c: Db): Promise<number> {
  if (!hasSecretKey()) return 0;
  const rows = (await c.query<{ id: string; tenant_id: string; mfa_secret: string }>('SELECT id, tenant_id, mfa_secret FROM users WHERE mfa_secret IS NOT NULL')).rows;
  let n = 0;
  for (const r of rows) {
    if (isSealed(r.mfa_secret)) continue;
    await c.query('UPDATE users SET mfa_secret = $2 WHERE id = $1', [r.id, await sealSecret(c, r.tenant_id, r.mfa_secret)]);
    n++;
  }
  return n;
}

/** Creates the data key of every tenant that has none (R3-01); without SECRET_KEY it does nothing. */
export async function ensureAllTenantKeys(c: Db): Promise<number> {
  if (!hasSecretKey()) return 0;
  const missing = (await c.query<{ id: string }>('SELECT t.id FROM tenants t WHERE NOT EXISTS (SELECT 1 FROM tenant_keys k WHERE k.tenant_id = t.id)')).rows;
  for (const t of missing) await ensureTenantKey(c, t.id);
  return missing.length;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate()
    .then(() => closePool())
    .catch(async (err) => {
      console.error(err);
      await closePool();
      process.exit(1);
    });
}
