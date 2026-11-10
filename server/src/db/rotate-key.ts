import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { masterFingerprint, unwrapKey, upgradeLegacySecrets, wrapKey } from '../lib/secretbox.js';
import { closePool, withSystem } from './pool.js';

// Rotation of SECRET_KEY (R3-41). Only the tenant data keys are wrapped with SECRET_KEY
// (envelope encryption, R3-01), so the rotation re-wraps them; the secrets themselves stay
// as they are. Each batch runs in its own transaction and only touches keys that are not yet on
// the new key: a run can be repeated (idempotent) and continued after an abort (resumable).
//
//   SECRET_KEY_OLD=… SECRET_KEY_NEW=… npm run rotate-key -w server
//
// Order in operation (docs/betrieb.md): deploy with SECRET_KEY=new and SECRET_KEY_PREVIOUS=old,
// run the rotation, then remove SECRET_KEY_PREVIOUS.

export interface RotationResult {
  rewrapped: number;
  alreadyCurrent: number;
  legacyConverted: number;
}

const BATCH = 100;

export async function rotateSecretKey(oldSecret: string, newSecret: string, log: (msg: string) => void = () => undefined): Promise<RotationResult> {
  if (!oldSecret || oldSecret.length < 16 || !newSecret || newSecret.length < 16) throw new Error('SECRET_KEY_OLD and SECRET_KEY_NEW need at least 16 characters');
  if (oldSecret === newSecret) throw new Error('SECRET_KEY_OLD and SECRET_KEY_NEW are the same');
  const oldFp = masterFingerprint(oldSecret);
  const newFp = masterFingerprint(newSecret);
  // From here on the process works with the new key and still reads the old one.
  config.secretKey = newSecret;
  config.secretKeyPrevious = oldSecret;
  let rewrapped = 0;
  for (;;) {
    const n = await withSystem(async (c) => {
      // One rotation at a time; a second run waits and then finds nothing left to do.
      await c.query('SELECT pg_advisory_xact_lock(4714)');
      const rows = (await c.query<{ tenant_id: string; wrapped_key: string; master_fp: string }>(
        'SELECT tenant_id, wrapped_key, master_fp FROM tenant_keys WHERE master_fp <> $1 ORDER BY tenant_id LIMIT $2 FOR UPDATE',
        [newFp, BATCH],
      )).rows;
      for (const r of rows) {
        if (r.master_fp !== oldFp) throw new Error(`tenant key of ${r.tenant_id} is wrapped with an unknown key (fingerprint ${r.master_fp}); nothing changed in this batch`);
        const dataKey = unwrapKey(r.wrapped_key, r.tenant_id, oldSecret);
        await c.query('UPDATE tenant_keys SET wrapped_key = $2, master_fp = $3, rewrapped_at = now() WHERE tenant_id = $1', [
          r.tenant_id, wrapKey(dataKey, r.tenant_id, newSecret), newFp,
        ]);
      }
      return rows.length;
    });
    rewrapped += n;
    if (n) log(`tenant keys re-wrapped: ${rewrapped}`);
    if (n < BATCH) break;
  }
  // Values of the older format were encrypted with SECRET_KEY directly: move them to the tenant keys.
  const legacyConverted = await withSystem((c) => upgradeLegacySecrets(c, [oldSecret, newSecret]));
  if (legacyConverted) log(`secrets of the older format moved to tenant keys: ${legacyConverted}`);
  const alreadyCurrent = await withSystem(async (c) =>
    (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM tenant_keys WHERE master_fp = $1', [newFp])).rows[0].n - rewrapped,
  );
  return { rewrapped, alreadyCurrent, legacyConverted };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const oldSecret = process.env.SECRET_KEY_OLD ?? process.env.SECRET_KEY_PREVIOUS ?? '';
  const newSecret = process.env.SECRET_KEY_NEW ?? process.env.SECRET_KEY ?? '';
  rotateSecretKey(oldSecret, newSecret, console.log)
    .then(async (r) => {
      console.log(`rotation finished: ${r.rewrapped} re-wrapped, ${r.alreadyCurrent} already on the new key, ${r.legacyConverted} older values converted`);
      await closePool();
    })
    .catch(async (err) => {
      console.error(`rotation failed: ${(err as Error).message}`);
      await closePool();
      process.exit(1);
    });
}
