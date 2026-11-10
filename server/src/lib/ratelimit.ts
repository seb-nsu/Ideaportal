import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { withSystem, type Db } from '../db/pool.js';
import { sha256 } from './crypto.js';
import { m } from '../i18n/index.js';
import { HttpError } from './errors.js';

// Rate limits per IP address and per account (R1-44). Counters live in PostgreSQL so that
// several app instances share them; keys are stored as hashes only. Fixed windows keep the
// logic simple: the first hit opens a window, every further hit counts until it ends.

export interface Limit {
  /** Maximum number of requests per window. */
  max: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

export const LIMITS = {
  loginIp: { max: 30, windowSeconds: 15 * 60 },
  loginAccount: { max: 10, windowSeconds: 15 * 60 },
  mfaAccount: { max: 10, windowSeconds: 15 * 60 },
  signupIp: { max: 5, windowSeconds: 60 * 60 },
  joinIp: { max: 20, windowSeconds: 60 * 60 },
  resetIp: { max: 10, windowSeconds: 60 * 60 },
  resetAccount: { max: 3, windowSeconds: 60 * 60 },
  demoIp: { max: 60, windowSeconds: 10 * 60 },
  // Company login and SCIM (R3-26, R3-27). SCIM syncs of Entra ID and Okta send bursts of
  // requests, so the per-token limit is generous; failed SCIM authentications are limited per IP.
  ssoIp: { max: 60, windowSeconds: 15 * 60 },
  scimToken: { max: 2000, windowSeconds: 60 },
  scimIp: { max: 3000, windowSeconds: 60 },
  scimAuthIp: { max: 20, windowSeconds: 15 * 60 },
  // Requests per API token (R3-17).
  apiToken: { max: 300, windowSeconds: 60 },
  // Operator console login (R3-07).
  operatorIp: { max: 10, windowSeconds: 15 * 60 },
  // External participation (R3-19, R3-21): sign-up by portal link, posts and reports per
  // account, the public status page of feature requests (R3-20) per IP.
  externalJoinIp: { max: 10, windowSeconds: 60 * 60 },
  externalPostAccount: { max: 10, windowSeconds: 60 * 60 },
  reportAccount: { max: 20, windowSeconds: 60 * 60 },
  publicPageIp: { max: 120, windowSeconds: 10 * 60 },
} satisfies Record<string, Limit>;

export type Bucket = keyof typeof LIMITS;

export class RateLimitError extends HttpError {
  constructor(public retryAfter: number) {
    super(429, m('common.rateLimited', { minutes: Math.ceil(retryAfter / 60) }), 'RATE_LIMITED', { retryAfterSeconds: retryAfter });
  }
}

/** Effective limit; RATE_LIMIT_FACTOR scales all limits (tests, load tests), 0 switches them off. */
function effective(limit: Limit): Limit | null {
  if (config.rateLimitFactor <= 0) return null;
  return { max: Math.max(1, Math.round(limit.max * config.rateLimitFactor)), windowSeconds: limit.windowSeconds };
}

/**
 * Counts one hit for bucket and key. Returns the remaining seconds of the window when the
 * limit is exceeded, otherwise null. The first hit over the limit is recorded as a security event.
 */
export async function hit(c: Db, bucket: Bucket, key: string): Promise<number | null> {
  const limit = effective(LIMITS[bucket]);
  if (!limit) return null;
  const keyHash = sha256(`${bucket}:${key.toLowerCase()}`);
  const row = (await c.query<{ hits: number; retry: number }>(
    `INSERT INTO rate_limits (bucket, key_hash, window_start, hits) VALUES ($1, $2, now(), 1)
     ON CONFLICT (bucket, key_hash) DO UPDATE SET
       hits = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $3) THEN 1 ELSE rate_limits.hits + 1 END,
       window_start = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $3) THEN now() ELSE rate_limits.window_start END
     RETURNING hits, ceil(extract(epoch FROM (window_start + make_interval(secs => $3) - now())))::int AS retry`,
    [bucket, keyHash, limit.windowSeconds],
  )).rows[0];
  if (row.hits <= limit.max) return null;
  if (row.hits === limit.max + 1) {
    await c.query('INSERT INTO security_events (kind, bucket, key_hash, detail) VALUES ($1, $2, $3, $4)', [
      'rate_limited', bucket, keyHash, JSON.stringify({ max: limit.max, windowSeconds: limit.windowSeconds }),
    ]);
  }
  return Math.max(1, row.retry);
}

/**
 * Checks several buckets in its own transaction and throws 429 if one is exceeded.
 * onExceeded runs in the same transaction, e.g. to write the event into the tenant's audit log.
 */
export async function enforce(
  checks: [Bucket, string | undefined | null][],
  onExceeded?: (c: Db, bucket: Bucket) => Promise<void>,
): Promise<void> {
  const retry = await withSystem(async (c) => {
    let worst: number | null = null;
    for (const [bucket, key] of checks) {
      if (!key) continue;
      const r = await hit(c, bucket, key);
      if (r !== null) {
        worst = Math.max(worst ?? 0, r);
        await onExceeded?.(c, bucket);
      }
    }
    return worst;
  });
  if (retry !== null) throw new RateLimitError(retry);
}

export const clientIp = (req: FastifyRequest) => req.ip ?? 'unknown';

/** Removes expired counters (daily job). */
export async function purgeRateLimits(c: Db): Promise<number> {
  const r = await c.query(`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`);
  await c.query(`DELETE FROM security_events WHERE created_at < now() - interval '90 days'`);
  return r.rowCount ?? 0;
}
