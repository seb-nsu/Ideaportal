import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, hkdfSync, randomUUID } from 'node:crypto';
import { config } from '../config.js';

// Request context (enterprise security): request id, hashed client address and user agent of
// the current HTTP request or background run. The database layer passes them to PostgreSQL as
// transaction settings, and the audit trigger copies them into every audit row, whichever code
// path writes the row (migration 031).

export interface RequestContext {
  /** Request id (X-Request-Id) or run id of a background run ("jobs:<uuid>"). */
  requestId: string;
  /** Keyed hash of the client address; null for background runs. */
  ipHash: string | null;
  /** User agent, shortened to USER_AGENT_MAX characters; null for background runs. */
  userAgent: string | null;
}

export const USER_AGENT_MAX = 200;

const storage = new AsyncLocalStorage<RequestContext>();

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Accepted incoming request ids: short, printable, no spaces (they end up in logs and headers). */
const SANE_ID = /^[A-Za-z0-9._:\-]{8,128}$/;

export function requestIdFrom(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return value && SANE_ID.test(value) ? value : randomUUID();
}

let ipKey: Buffer | undefined;
let ipKeySource: string | undefined;

/**
 * Keyed hash (HMAC-SHA256) of a client address. A plain SHA-256 of an IPv4 address can be
 * reversed by trying all 2^32 addresses, so the key is derived from SECRET_KEY (HKDF). Without
 * SECRET_KEY (local development only) a fixed key is used. Same address, same hash: the audit
 * log can show that attempts came from one address without storing it.
 */
export function hashIp(ip: string | undefined | null): string | null {
  if (!ip) return null;
  const source = config.secretKey ?? '';
  if (!ipKey || ipKeySource !== source) {
    ipKey = Buffer.from(hkdfSync('sha256', source || 'ideenportal-dev-only', 'ideenportal', 'audit-ip-hash:v1', 32));
    ipKeySource = source;
  }
  return createHmac('sha256', ipKey).update(ip).digest('hex').slice(0, 32);
}

export function shortUserAgent(ua: string | string[] | undefined): string | null {
  const value = Array.isArray(ua) ? ua[0] : ua;
  if (!value) return null;
  // Control characters never reach logs or CSV exports.
  // eslint-disable-next-line no-control-regex -- strips control characters on purpose
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, USER_AGENT_MAX);
}

/** Runs a background loop with its own run id; audit rows written by it carry "<kind>:<id>". */
export function runBackground<T>(kind: string, fn: (runId: string) => Promise<T>): Promise<T> {
  const runId = randomUUID();
  return storage.run({ requestId: `${kind}:${runId}`, ipHash: null, userAgent: null }, () => fn(runId));
}
