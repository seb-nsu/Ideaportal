import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withSystem } from '../db/pool.js';
import { ROLES, type Ctx, type Role, type SessionUser } from '../lib/context.js';
import { newToken, sha256 } from '../lib/crypto.js';
import { HttpError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { enforce } from '../lib/ratelimit.js';
import { localeFromHeader, m } from '../i18n/index.js';
import { audit } from './audit.js';

// API tokens per tenant (R3-17). A token acts as its own technical user with the roles chosen
// at creation; requests run through withTenant() like every session, so row-level security and
// the role checks of the domain apply unchanged. The token is shown once and stored as SHA-256;
// the prefix is a public lookup id so that the check needs no scan over all hashes.

export const TOKEN_PREFIX = 'ipt';
/** How often a token use is written to the audit log at most (per token). */
export const USE_AUDIT_MINUTES = 60;
export const MAX_TOKEN_DAYS = 365;

export const tokenInput = z.object({
  name: z.string().trim().min(2).max(80),
  roles: z.array(z.enum(ROLES)).min(1),
  expiresInDays: z.number().int().min(1).max(MAX_TOKEN_DAYS).default(90),
  /** Admin rights must be confirmed explicitly, in addition to the role (R3-17). */
  allowAdmin: z.boolean().default(false),
});

/** Paths a token may never call: login and personal settings, token and webhook management, deleting the workspace. */
const DENIED = [/^\/api\/auth\//, /^\/api\/me\//, /^\/api\/admin\/api-tokens/, /^\/api\/admin\/webhooks/, /^\/api\/admin\/workspace\//, /^\/api\/demo\//];

export function bearerToken(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(h.trim());
  return match ? match[1].trim() : undefined;
}

/**
 * Request guard for bearer requests: a bearer token and a session cookie together are refused
 * (no mixing of credentials), and some paths are closed to tokens.
 */
export function guardBearer(req: FastifyRequest, sessionCookie: string): boolean {
  if (!req.url.startsWith('/api/') || bearerToken(req) === undefined) return false;
  if (req.cookies?.[sessionCookie] || (req.headers.cookie ?? '').includes(`${sessionCookie}=`)) {
    throw new HttpError(400, m('api.bearerWithCookie'), 'BEARER_WITH_COOKIE');
  }
  const path = req.url.split('?')[0];
  if (DENIED.some((re) => re.test(path))) throw new HttpError(403, m('api.tokenNotAllowed'), 'TOKEN_NOT_ALLOWED');
  return true;
}

interface TokenRow {
  id: string;
  tenant_id: string;
  user_id: string;
  name: string;
  token_hash: string;
  roles: Role[];
  last_used_at: Date | null;
}

const resolved = new WeakMap<FastifyRequest, Promise<SessionUser>>();

/** The technical user of a bearer token; 401 when the token is unknown, expired or revoked, 429 over the limit. */
export function userFromToken(req: FastifyRequest, token: string): Promise<SessionUser> {
  let p = resolved.get(req);
  if (!p) {
    p = resolveToken(req, token);
    resolved.set(req, p);
  }
  return p;
}

const invalid = () => new HttpError(401, m('api.tokenInvalid'), 'TOKEN_INVALID');

async function resolveToken(req: FastifyRequest, token: string): Promise<SessionUser> {
  const match = /^ipt_([a-f0-9]{12})_[A-Za-z0-9_-]{20,}$/.exec(token);
  if (!match) throw invalid();
  const row = await withSystem(async (c) =>
    (await c.query<TokenRow>(
      `SELECT id, tenant_id, user_id, name, token_hash, roles, last_used_at FROM api_tokens
        WHERE prefix = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [match[1]],
    )).rows[0],
  );
  const given = Buffer.from(sha256(token), 'hex');
  if (!row || !timingSafeEqual(given, Buffer.from(row.token_hash, 'hex'))) throw invalid();
  await enforce([['apiToken', row.id]]);
  await withSystem(async (c) => {
    // last_used_at always; the audit log only once per USE_AUDIT_MINUTES, so it is not flooded.
    const first = await c.query(
      `UPDATE api_tokens SET last_used_at = now() WHERE id = $1
         AND (last_used_at IS NULL OR last_used_at < now() - make_interval(mins => $2)) RETURNING id`,
      [row.id, USE_AUDIT_MINUTES],
    );
    if (first.rowCount) {
      await c.query('INSERT INTO audit_log (tenant_id, actor_id, action, entity, entity_id, after) VALUES ($1, $2, $3, $4, $5, $6)', [
        row.tenant_id, row.user_id, 'api_token.use', 'api_token', row.id, JSON.stringify({ method: req.method, path: req.url.split('?')[0] }),
      ]);
    } else {
      await c.query('UPDATE api_tokens SET last_used_at = now() WHERE id = $1', [row.id]);
    }
  });
  return {
    id: row.user_id,
    tenantId: row.tenant_id,
    email: '',
    displayName: row.name,
    orgUnit: null,
    roles: row.roles,
    mfaEnabled: false,
    locale: localeFromHeader(req.headers['accept-language']),
    technical: true,
    tokenId: row.id,
  };
}

/** Token management is for people only; a token cannot create or revoke tokens. */
export function requirePerson(ctx: Ctx): void {
  if (ctx.user?.technical) throw forbidden(m('api.tokenNotAllowed'));
}

export async function createToken(ctx: Ctx, input: z.infer<typeof tokenInput>) {
  requirePerson(ctx);
  const roles = Array.from(new Set(input.roles));
  if (roles.includes('admin') && !input.allowAdmin) throw badRequest(m('api.adminConfirm'));
  const prefix = randomBytes(6).toString('hex');
  const token = `${TOKEN_PREFIX}_${prefix}_${newToken()}`;
  const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000);
  // The technical user: no password, inactive (no login, no mail), hidden from the people list.
  const user = (await ctx.db.query<{ id: string }>(
    `INSERT INTO users (tenant_id, email, display_name, roles, active, technical, onboarded)
     VALUES ($1, $2, $3, $4, false, true, true) RETURNING id`,
    [ctx.tenantId, `api-${prefix}@tokens.invalid`, `${input.name} (API)`, roles],
  )).rows[0];
  const r = await ctx.db.query<{ id: string }>(
    `INSERT INTO api_tokens (tenant_id, user_id, name, prefix, token_hash, roles, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [ctx.tenantId, user.id, input.name, prefix, sha256(token), roles, expiresAt, ctx.user!.id],
  );
  await audit(ctx, 'api_token.create', 'api_token', r.rows[0].id, null, { name: input.name, prefix, roles, expiresAt: expiresAt.toISOString() });
  return { id: r.rows[0].id, token, prefix, roles, expiresAt: expiresAt.toISOString() };
}

export async function listTokens(ctx: Ctx) {
  const r = await ctx.db.query(
    `SELECT t.id, t.name, t.prefix, t.roles, t.expires_at AS "expiresAt", t.created_at AS "createdAt",
            t.last_used_at AS "lastUsedAt", t.revoked_at AS "revokedAt", c.display_name AS "createdBy",
            CASE WHEN t.revoked_at IS NOT NULL THEN 'revoked' WHEN t.expires_at <= now() THEN 'expired' ELSE 'active' END AS state
       FROM api_tokens t LEFT JOIN users c ON c.id = t.created_by
      ORDER BY (t.revoked_at IS NULL AND t.expires_at > now()) DESC, t.created_at DESC`,
  );
  return r.rows;
}

export async function revokeToken(ctx: Ctx, id: string): Promise<void> {
  requirePerson(ctx);
  const r = await ctx.db.query<{ name: string; prefix: string }>(
    'UPDATE api_tokens SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING name, prefix',
    [id, ctx.user!.id],
  );
  if (!r.rowCount) throw notFound(m('api.tokenNotFound'));
  await audit(ctx, 'api_token.revoke', 'api_token', id, null, r.rows[0]);
}
