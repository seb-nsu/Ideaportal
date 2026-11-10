import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withSystem } from '../db/pool.js';
import { HttpError, notFound } from '../lib/errors.js';
import { clientIp, enforce } from '../lib/ratelimit.js';
import { LOCALES, m } from '../i18n/index.js';
import { tenantHandler } from '../http.js';
import { audit } from '../services/audit.js';
import {
  OPERATOR_COOKIE, OPERATOR_PERMISSIONS, accountLogin, activeGrant, bootstrapLoginAvailable, createTenantByOperator, operatorConsoleEnabled, operatorCookie,
  operatorHandler, operatorLog, operatorLogin, operatorLogout, operatorOverview, supportView,
} from '../services/operator.js';
import { COMPONENTS, listIncidents, publicStatus, resetStatusCache } from '../services/status.js';

// SaaS operations (AP-17): operator console (R3-01, R3-07), support access granted by the
// tenant (R3-07) and the public status page (R3-10).

const admin = { roles: ['admin' as const] };

const incidentInput = z.object({
  kind: z.enum(['incident', 'maintenance']),
  severity: z.enum(['minor', 'major']).default('minor'),
  title: z.string().trim().min(3).max(200),
  body: z.string().trim().max(4000).default(''),
  components: z.array(z.enum(COMPONENTS)).max(COMPONENTS.length).default([]),
  startsAt: z.iso.datetime({ offset: true }).optional(),
  endsAt: z.iso.datetime({ offset: true }).nullable().optional(),
});

export async function saasRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------ public status page (R3-10)
  // The current state is cached on the server for 30 seconds (services/status.ts).
  app.get('/api/status', async () => publicStatus());

  // ------------------------------------------------------------ operator console (R3-07)
  // enabled: console on; bootstrap: the env token login is open (no owner account yet or break-glass).
  app.get('/api/operator/config', async () => {
    const enabled = await operatorConsoleEnabled();
    return { enabled, bootstrap: enabled && (await bootstrapLoginAvailable()) };
  });

  // Individual account (email, password, code) or the bootstrap token (token, code).
  app.post('/api/operator/login', async (req, reply) => {
    if (!(await operatorConsoleEnabled())) throw new HttpError(404, m('saas.operatorDisabled'), 'NOT_FOUND');
    const body = z.union([
      z.object({ email: z.string().min(3).max(200), password: z.string().min(1).max(200), code: z.string().min(6).max(8) }),
      z.object({ token: z.string().min(1).max(500), code: z.string().min(6).max(8) }),
    ]).parse(req.body);
    await enforce([['operatorIp', clientIp(req)]]);
    let session = '';
    if ('email' in body) {
      const r = await accountLogin(body.email, body.password, body.code, clientIp(req));
      if ('error' in r) throw new HttpError(r.error === 'locked' ? 423 : 401, m(r.error === 'locked' ? 'opadmin.locked' : 'opadmin.loginFailed'), 'OPERATOR_LOGIN_FAILED');
      session = r.session;
    } else {
      session = await operatorLogin(body.token, body.code, clientIp(req));
      if (!session) throw new HttpError(401, m('saas.operatorLoginFailed'), 'OPERATOR_LOGIN_FAILED');
    }
    reply.setCookie(OPERATOR_COOKIE, session, operatorCookie());
    return { ok: true };
  });

  app.post('/api/operator/logout', async (req, reply) => {
    await operatorLogout(req.cookies[OPERATOR_COOKIE]);
    reply.clearCookie(OPERATOR_COOKIE, { path: '/api/operator' });
    return { ok: true };
  });

  // The own account with role and permissions; reachable while a password change is pending.
  app.get('/api/operator/me', operatorHandler('self', async (op) => ({
    operator: op.name,
    id: op.id,
    email: op.email,
    role: op.role,
    bootstrap: op.bootstrap,
    mustChangePassword: op.mustChangePassword,
    permissions: Object.entries(OPERATOR_PERMISSIONS).filter(([, roles]) => (roles as readonly string[]).includes(op.role)).map(([k]) => k),
  })));

  app.get('/api/operator/overview', operatorHandler('overview', async () => operatorOverview()));

  // New tenant with its own data key and an invited first admin (R3-01).
  app.post(
    '/api/operator/tenants',
    operatorHandler('tenants', async (operator, req, reply) => {
      const body = z
        .object({
          name: z.string().trim().min(2).max(80),
          slug: z.string().regex(/^[a-z0-9-]{2,40}$/).optional(),
          adminEmail: z.email().max(200),
          adminName: z.string().trim().min(2).max(120),
          locale: z.enum(LOCALES).default('de'),
        })
        .parse(req.body);
      reply.code(201);
      return createTenantByOperator(operator, body);
    }),
  );

  // Data of a tenant, only with its admins' grant; logged in the tenant's audit log.
  app.get(
    '/api/operator/tenants/:id/support',
    operatorHandler('support', async (operator, req) => {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      return supportView(operator, id);
    }),
  );

  app.get(
    '/api/operator/log',
    operatorHandler('overview', async () =>
      withSystem(async (c) =>
        (await c.query(
          `SELECT l.id, l.operator, l.operator_id AS "operatorId", a.email AS "operatorEmail", l.action, l.tenant_id AS "tenantId", t.name AS "tenantName",
                  l.created_at AS "createdAt"
             FROM operator_log l LEFT JOIN tenants t ON t.id = l.tenant_id LEFT JOIN operator_accounts a ON a.id = l.operator_id
            ORDER BY l.id DESC LIMIT 200`,
        )).rows,
      ),
    ),
  );

  // Incidents and maintenance notes for the status page (R3-10).
  app.get('/api/operator/incidents', operatorHandler('support', async () => listIncidents(90)));

  app.post(
    '/api/operator/incidents',
    operatorHandler('support', async (operator, req, reply) => {
      const body = incidentInput.parse(req.body);
      const id = await withSystem(async (c) => {
        const r = await c.query<{ id: string }>(
          `INSERT INTO status_incidents (kind, severity, title, body, components, starts_at, ends_at)
           VALUES ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now()), $7) RETURNING id`,
          [body.kind, body.severity, body.title, body.body, body.components, body.startsAt ?? null, body.endsAt ?? null],
        );
        await operatorLog(c, operator, 'incident.create', null, { id: r.rows[0].id, kind: body.kind });
        return r.rows[0].id;
      });
      resetStatusCache();
      reply.code(201);
      return { id };
    }),
  );

  app.patch(
    '/api/operator/incidents/:id',
    operatorHandler('support', async (operator, req) => {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const body = incidentInput.partial().extend({ resolved: z.boolean().optional() }).parse(req.body);
      await withSystem(async (c) => {
        const r = await c.query(
          `UPDATE status_incidents SET
             kind = coalesce($2, kind), severity = coalesce($3, severity), title = coalesce($4, title), body = coalesce($5, body),
             components = coalesce($6, components), starts_at = coalesce($7::timestamptz, starts_at),
             ends_at = CASE WHEN $8 THEN $9::timestamptz ELSE ends_at END,
             resolved_at = CASE WHEN $10::boolean IS NULL THEN resolved_at WHEN $10 THEN coalesce(resolved_at, now()) ELSE NULL END,
             updated_at = now()
           WHERE id = $1`,
          [id, body.kind ?? null, body.severity ?? null, body.title ?? null, body.body ?? null, body.components ?? null, body.startsAt ?? null,
           body.endsAt !== undefined, body.endsAt ?? null, body.resolved ?? null],
        );
        if (!r.rowCount) throw notFound(m('saas.incidentNotFound'));
        await operatorLog(c, operator, 'incident.update', null, { id, resolved: body.resolved });
      });
      resetStatusCache();
      return { ok: true };
    }),
  );

  app.delete(
    '/api/operator/incidents/:id',
    operatorHandler('support', async (operator, req) => {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      await withSystem(async (c) => {
        const r = await c.query('DELETE FROM status_incidents WHERE id = $1', [id]);
        if (!r.rowCount) throw notFound(m('saas.incidentNotFound'));
        await operatorLog(c, operator, 'incident.delete', null, { id });
      });
      resetStatusCache();
      return { ok: true };
    }),
  );

  // ------------------------------------------------------------ support access, tenant side (R3-07)
  app.get(
    '/api/admin/support-access',
    tenantHandler(async (ctx) => {
      const active = await activeGrant(ctx.db, ctx.tenantId);
      const grants = (await ctx.db.query(
        `SELECT g.id, g.reason, g.expires_at AS "expiresAt", g.revoked_at AS "revokedAt", g.created_at AS "createdAt",
                u.display_name AS "grantedBy", r.display_name AS "revokedBy"
           FROM support_grants g LEFT JOIN users u ON u.id = g.granted_by LEFT JOIN users r ON r.id = g.revoked_by
          ORDER BY g.created_at DESC LIMIT 20`,
      )).rows;
      // Every access of the operator to the data of this workspace (written by supportView).
      const accesses = (await ctx.db.query(
        `SELECT id, created_at AS "createdAt", after->>'operator' AS operator, after->>'grantId' AS "grantId", after->>'view' AS view
           FROM audit_log WHERE action = 'support.access' ORDER BY id DESC LIMIT 100`,
      )).rows;
      return { active: active && { id: active.id, expiresAt: active.expires_at, reason: active.reason }, grants, accesses };
    }, admin),
  );

  app.post(
    '/api/admin/support-access',
    tenantHandler(async (ctx, req, reply) => {
      const body = z.object({ hours: z.number().int().min(1).max(168), reason: z.string().trim().min(3).max(300) }).parse(req.body);
      await ctx.db.query('UPDATE support_grants SET revoked_at = now(), revoked_by = $1 WHERE revoked_at IS NULL AND expires_at > now()', [ctx.user!.id]);
      const r = await ctx.db.query<{ id: string; expires_at: Date }>(
        `INSERT INTO support_grants (tenant_id, granted_by, reason, expires_at) VALUES ($1, $2, $3, now() + make_interval(hours => $4))
         RETURNING id, expires_at`,
        [ctx.tenantId, ctx.user!.id, body.reason, body.hours],
      );
      await audit(ctx, 'support.grant', 'support_grant', r.rows[0].id, null, { hours: body.hours, reason: body.reason, expiresAt: r.rows[0].expires_at });
      reply.code(201);
      return { id: r.rows[0].id, expiresAt: r.rows[0].expires_at };
    }, admin),
  );

  app.delete(
    '/api/admin/support-access',
    tenantHandler(async (ctx) => {
      const r = await ctx.db.query<{ id: string }>(
        'UPDATE support_grants SET revoked_at = now(), revoked_by = $1 WHERE revoked_at IS NULL AND expires_at > now() RETURNING id',
        [ctx.user!.id],
      );
      for (const g of r.rows) await audit(ctx, 'support.revoke', 'support_grant', g.id, null, null);
      return { ok: true, revoked: r.rowCount ?? 0 };
    }, admin),
  );
}
