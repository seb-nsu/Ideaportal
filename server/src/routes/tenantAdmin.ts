import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config, features } from '../config.js';
import { withSystem } from '../db/pool.js';
import type { SessionUser } from '../lib/context.js';
import { sha256, verifyPassword, verifyTotp } from '../lib/crypto.js';
import { HttpError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { clientIp, enforce } from '../lib/ratelimit.js';
import { openTotp } from '../lib/secretbox.js';
import { m } from '../i18n/index.js';
import { SESSION_COOKIE, tenantHandler } from '../http.js';
import { audit } from '../services/audit.js';
import { OPERATOR_ROLES, operatorHandler } from '../services/operator.js';
import { changeOwnPassword, createOperator, listOperators, resetOperator, updateOperator, MIN_OPERATOR_PASSWORD } from '../services/operatorAccounts.js';
import { bulkInput, bulkPeople, importInput, importPeople } from '../services/people.js';
import { exportChunks, listExports, requestExport } from '../services/tenantExport.js';
import { cancelDeletion, graceDaysInput, listDeletions, requestDeletion, resumeTenant, suspendTenant, tenantLifecycle } from '../services/tenantLifecycle.js';
import { listOverrides, overrideInput, removeOverride, setOverride } from '../services/tenantOverrides.js';
import { isDemoSlug } from '../db/demo-content.js';

// Enterprise administration: tenant lifecycle (offboarding with re-authentication and grace
// period, export as ZIP), people administration (CSV import, bulk actions), and the operator
// side (suspend/resume, offboarding, feature switches and limits per tenant, operator accounts).

const admin = { roles: ['admin' as const] };
const people = { roles: ['admin' as const, 'user_admin' as const] };
const idParam = (req: FastifyRequest) => z.object({ id: z.uuid() }).parse(req.params).id;
const reasonInput = z.object({ reason: z.string().trim().min(3).max(300) });

interface ReauthSession {
  auth_method: string;
  age_seconds: number;
  password_hash: string | null;
  mfa_enabled: boolean;
  mfa_secret: string | null;
}

async function reauthSession(req: FastifyRequest): Promise<ReauthSession | null> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  return withSystem(
    async (c) =>
      (
        await c.query<ReauthSession>(
          `SELECT s.auth_method, extract(epoch FROM now() - s.created_at)::int AS age_seconds, u.password_hash, u.mfa_enabled, u.mfa_secret
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()`,
          [sha256(token)],
        )
      ).rows[0] ?? null,
  );
}

/** How the person confirms a deletion: password (plus code), or a fresh company login plus the slug. */
function reauthMethod(s: ReauthSession | null): 'password' | 'password_totp' | 'sso' {
  if (s?.auth_method === 'oidc') return 'sso';
  return s?.mfa_enabled ? 'password_totp' : 'password';
}

/**
 * Re-authentication before the deletion (enterprise): with a password login the password and,
 * when two-factor login is on, a current code; after a company login (no password here) a
 * login of at most REAUTH_SSO_MINUTES minutes plus the workspace slug typed in.
 */
async function verifyReauth(req: FastifyRequest, user: SessionUser, body: { password?: string; code?: string; slug?: string }, slug: string): Promise<void> {
  await enforce([
    ['loginIp', clientIp(req)],
    ['mfaAccount', `reauth:${user.id}`],
  ]);
  const s = await reauthSession(req);
  if (!s) throw new HttpError(401, m('common.unauthenticated'), 'UNAUTHENTICATED');
  const fail = async (reason: string) => {
    await withSystem((c) =>
      c.query('INSERT INTO audit_log (tenant_id, actor_id, action, entity, entity_id, after) VALUES ($1, $2, $3, $4, $5, $6)', [
        user.tenantId,
        user.id,
        'tenant.delete_reauth_failed',
        'tenant',
        user.tenantId,
        JSON.stringify({ reason }),
      ]),
    );
    return new HttpError(401, m('tenantlc.reauthFailed'), 'REAUTH_FAILED');
  };
  if (s.auth_method === 'oidc') {
    if (s.age_seconds > config.reauthSsoMinutes * 60) {
      throw new HttpError(401, m('tenantlc.reauthSso', { minutes: config.reauthSsoMinutes }), 'REAUTH_SSO_REQUIRED', {
        maxAgeMinutes: config.reauthSsoMinutes,
      });
    }
    if ((body.slug ?? '').trim().toLowerCase() !== slug) throw await fail('slug');
    return;
  }
  if (!(await verifyPassword(body.password ?? '', s.password_hash))) throw await fail('password');
  if (s.mfa_enabled) {
    const secret = s.mfa_secret ? await openTotp(null, user.tenantId, s.mfa_secret) : '';
    if (!secret || !verifyTotp(secret, body.code ?? '')) throw await fail('code');
  }
}

export async function tenantAdminRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------ lifecycle, tenant side

  app.get(
    '/api/admin/workspace/lifecycle',
    tenantHandler(async (ctx, req) => {
      const lc = (await tenantLifecycle(ctx.tenantId))!;
      const [kind, who] = (lc.deletionRequestedBy ?? '').split(':');
      const requester =
        kind === 'admin' && who
          ? ((await ctx.db.query<{ display_name: string }>('SELECT display_name FROM users WHERE id::text = $1', [who])).rows[0]?.display_name ?? null)
          : null;
      return {
        status: lc.status,
        deletionRequestedAt: lc.deletionRequestedAt,
        deleteAfter: lc.deleteAfter,
        deletionRequestedBy: requester,
        deletionByOperator: kind === 'operator',
        graceDays: config.tenantDeleteGraceDays,
        reauth: reauthMethod(await reauthSession(req)),
        ssoMaxAgeMinutes: config.reauthSsoMinutes,
        exportRetentionDays: config.exportRetentionDays,
      };
    }, admin),
  );

  // Offboarding (R1-43, enterprise): re-authentication, then the grace period starts; the job
  // deletes the workspace afterwards. Replaces the immediate deletion.
  app.post(
    '/api/admin/workspace/delete',
    tenantHandler(async (ctx, req) => {
      const body = z
        .object({
          confirm: z.string().max(200),
          password: z.string().max(200).optional(),
          code: z.string().max(8).optional(),
          slug: z.string().max(40).optional(),
          reason: z.string().trim().max(300).optional(),
        })
        .parse(req.body);
      if (ctx.user!.technical) throw forbidden();
      const t = (await ctx.db.query<{ name: string; slug: string }>('SELECT name, slug FROM tenants WHERE id = $1', [ctx.tenantId])).rows[0];
      if (features.demo && isDemoSlug(t.slug)) throw forbidden(m('pilot.demoDelete'));
      if (body.confirm.trim() !== t.name) throw badRequest(m('pilot.confirmName'));
      await verifyReauth(req, ctx.user!, body, t.slug);
      const deleteAfter = await requestDeletion(ctx.tenantId, { kind: 'admin', name: ctx.user!.displayName, userId: ctx.user!.id }, body.reason || null);
      return { ok: true, status: 'deleting', deleteAfter };
    }, admin),
  );

  app.post(
    '/api/admin/workspace/delete/cancel',
    tenantHandler(async (ctx) => {
      const status = await cancelDeletion(ctx.tenantId, { kind: 'admin', name: ctx.user!.displayName, userId: ctx.user!.id });
      return { ok: true, status };
    }, admin),
  );

  // ------------------------------------------------------------ full export as ZIP

  app.get(
    '/api/admin/exports',
    tenantHandler(async (ctx) => listExports(ctx.db), admin),
  );

  app.post(
    '/api/admin/exports',
    tenantHandler(async (ctx, _req, reply) => {
      const r = await requestExport(ctx.db, ctx.tenantId, ctx.user!.id);
      if (!r.existing) await audit(ctx, 'tenant.export_requested', 'tenant_export', r.id, null, { format: 'zip' });
      reply.code(202);
      return r;
    }, admin),
  );

  app.get(
    '/api/admin/exports/:id/download',
    tenantHandler(async (ctx, req, reply) => {
      const id = idParam(req);
      const e = (
        await ctx.db.query<{ status: string; expires_at: Date | null; size_bytes: number; sha256: string; created_at: Date }>(
          'SELECT status, expires_at, size_bytes, sha256, created_at FROM tenant_exports WHERE id = $1',
          [id],
        )
      ).rows[0];
      if (!e) throw notFound(m('tenantlc.export.notFound'));
      if (e.status !== 'done' || !e.expires_at || e.expires_at <= new Date()) throw new HttpError(409, m('tenantlc.export.notReady'), 'EXPORT_NOT_READY');
      await ctx.db.query('UPDATE tenant_exports SET downloads = downloads + 1 WHERE id = $1', [id]);
      await audit(ctx, 'tenant.export_download', 'tenant_export', id, null, { size: e.size_bytes });
      const day = new Date(e.created_at).toISOString().slice(0, 10);
      reply
        .type('application/zip')
        .header('content-length', String(e.size_bytes))
        .header('x-content-sha256', e.sha256)
        .header('content-disposition', `attachment; filename="ideenportal-export-${day}.zip"`);
      return Readable.from(exportChunks(ctx.tenantId, id));
    }, admin),
  );

  // ------------------------------------------------------------ people: import and bulk actions

  app.post(
    '/api/admin/users/import',
    { bodyLimit: 8_000_000 },
    tenantHandler(async (ctx, req) => importPeople(ctx, importInput.parse(req.body)), people),
  );

  app.post(
    '/api/admin/users/bulk',
    tenantHandler(async (ctx, req) => bulkPeople(ctx, bulkInput.parse(req.body)), people),
  );

  // ------------------------------------------------------------ operator: tenant status

  app.post(
    '/api/operator/tenants/:id/suspend',
    operatorHandler('tenants', async (op, req) => {
      await suspendTenant(op, idParam(req), reasonInput.parse(req.body).reason);
      return { ok: true, status: 'suspended' };
    }),
  );

  app.post(
    '/api/operator/tenants/:id/resume',
    operatorHandler('tenants', async (op, req) => {
      await resumeTenant(op, idParam(req), reasonInput.parse(req.body).reason);
      return { ok: true, status: 'active' };
    }),
  );

  app.post(
    '/api/operator/tenants/:id/offboarding',
    operatorHandler('tenants', async (op, req) => {
      const body = reasonInput.extend({ graceDays: z.number().int().optional() }).parse(req.body);
      const deleteAfter = await requestDeletion(idParam(req), { kind: 'operator', name: op.name, operator: op }, body.reason, graceDaysInput(body.graceDays));
      return { ok: true, status: 'deleting', deleteAfter };
    }),
  );

  app.post(
    '/api/operator/tenants/:id/offboarding/cancel',
    operatorHandler('tenants', async (op, req) => {
      const status = await cancelDeletion(idParam(req), { kind: 'operator', name: op.name, operator: op });
      return { ok: true, status };
    }),
  );

  app.get(
    '/api/operator/deletions',
    operatorHandler('tenants', async () => listDeletions()),
  );

  // ------------------------------------------------------------ operator: switches and limits per tenant

  app.get(
    '/api/operator/tenants/:id/overrides',
    operatorHandler('tenants', async (_op, req) => listOverrides(idParam(req))),
  );

  app.put(
    '/api/operator/tenants/:id/overrides',
    operatorHandler('tenants', async (op, req) => {
      await setOverride(op, idParam(req), overrideInput.parse(req.body));
      return { ok: true };
    }),
  );

  app.delete(
    '/api/operator/tenants/:id/overrides/:key',
    operatorHandler('tenants', async (op, req) => {
      const { id, key } = z.object({ id: z.uuid(), key: z.string().regex(/^[A-Za-z]{2,40}$/) }).parse(req.params);
      await removeOverride(op, id, key, reasonInput.parse(req.body ?? {}).reason);
      return { ok: true };
    }),
  );

  // ------------------------------------------------------------ operator accounts

  app.get(
    '/api/operator/operators',
    operatorHandler('operators', async () => listOperators()),
  );

  app.post(
    '/api/operator/operators',
    operatorHandler('operators', async (op, req, reply) => {
      const body = z.object({ email: z.email().max(200), name: z.string().trim().min(2).max(120), role: z.enum(OPERATOR_ROLES) }).parse(req.body);
      reply.code(201);
      return createOperator(op, body);
    }),
  );

  app.patch(
    '/api/operator/operators/:id',
    operatorHandler('operators', async (op, req) => {
      const body = z
        .object({ role: z.enum(OPERATOR_ROLES).optional(), active: z.boolean().optional(), name: z.string().trim().min(2).max(120).optional() })
        .parse(req.body);
      await updateOperator(op, idParam(req), body);
      return { ok: true };
    }),
  );

  app.post(
    '/api/operator/operators/:id/reset',
    operatorHandler('operators', async (op, req) => resetOperator(op, idParam(req))),
  );

  app.post(
    '/api/operator/me/password',
    operatorHandler('self', async (op, req) => {
      const body = z.object({ current: z.string().min(1).max(200), password: z.string().min(MIN_OPERATOR_PASSWORD).max(200) }).parse(req.body);
      await changeOwnPassword(op, body.current, body.password);
      return { ok: true };
    }),
  );
}
