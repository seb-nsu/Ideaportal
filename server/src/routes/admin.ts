import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { withSystem, type Db } from '../db/pool.js';
import { runTenantJobs } from '../jobs/deadlines.js';
import { ROLES } from '../lib/context.js';
import { badRequest, conflict, localizeIssues, notFound } from '../lib/errors.js';
import { m, tr, type MessageKey } from '../i18n/index.js';
import { resolveSettings, settingsSchema } from '../lib/settings.js';
import { tenantHandler } from '../http.js';
import { audit } from '../services/audit.js';
import { areaInput, createArea, deleteArea, listAreas, scopedRoleSchema, scopedRolesOf, setScopedRoles, updateArea } from '../services/areas.js';
import { issuePasswordToken } from './auth.js';
import { assertPeopleChange } from '../services/people.js';
import { toCsv } from './misc.js';
import { auditFilterSchema, listAudit } from '../services/auditLog.js';

const admin = { roles: ['admin' as const] };
// Delegated people administration (enterprise): admins and user_admin; admin rights stay with admins.
const people = { roles: ['admin' as const, 'user_admin' as const] };

const userInput = z.object({
  email: z.email().max(200),
  displayName: z.string().trim().min(2).max(120),
  orgUnit: z.string().trim().max(120).nullable().default(null),
  roles: z.array(z.enum(ROLES)).min(1),
});

export async function settingsVersion(db: Db, tenantId: string): Promise<number> {
  return (await db.query<{ v: number }>('SELECT settings_version AS v FROM tenants WHERE id = $1', [tenantId])).rows[0]?.v ?? 1;
}

/**
 * Version the client read (R3-41): If-Match header ("7", W/"7") or the field "version" in the
 * body. Without both the change is accepted as before (scripts, older clients).
 */
export function expectedVersion(ifMatch: string | undefined, bodyVersion: unknown): number | null {
  const fromHeader = ifMatch?.match(/^(?:W\/)?"?(\d+)"?$/)?.[1];
  if (fromHeader) return Number(fromHeader);
  if (ifMatch && ifMatch.trim() !== '*') throw badRequest(m('saas.settingsVersionInvalid'));
  if (typeof bodyVersion === 'number' && Number.isInteger(bodyVersion)) return bodyVersion;
  return null;
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // Settings carry a version (R3-41); the ETag and the field "version" go back with PUT.
  app.get('/api/admin/settings', tenantHandler(async (ctx, _req, reply) => {
    const version = await settingsVersion(ctx.db, ctx.tenantId);
    reply.header('etag', `"${version}"`);
    return { ...ctx.settings, version };
  }, admin));

  // Settings take effect immediately for the next request, no restart (R1-04).
  app.put(
    '/api/admin/settings',
    tenantHandler(async (ctx, req, reply) => {
      // AI settings have their own endpoint with extra checks (/api/admin/ai); they are kept here.
      const parsed = settingsSchema.safeParse({ ...(req.body as object), ai: ctx.settings.ai });
      if (!parsed.success) throw badRequest(m('admin.settingsInvalid'), localizeIssues(ctx.locale, parsed.error.issues));
      const ids = parsed.data.targetChannels.map((c) => c.id);
      if (new Set(ids).size !== ids.length) throw badRequest(m('admin.channelIds'));
      // Concurrent change (R3-41): the version read by the client must still be the current one.
      const expected = expectedVersion(req.headers['if-match'], (req.body as { version?: unknown } | null)?.version);
      const r = await ctx.db.query<{ settings_version: number }>(
        'UPDATE tenants SET settings = $1 WHERE id = $2 AND ($3::int IS NULL OR settings_version = $3) RETURNING settings_version',
        [JSON.stringify(parsed.data), ctx.tenantId, expected],
      );
      if (!r.rows[0]) {
        throw conflict(m('saas.settingsConflict'), 'SETTINGS_CONFLICT', { currentVersion: await settingsVersion(ctx.db, ctx.tenantId) });
      }
      await audit(ctx, 'settings.update', 'tenant', ctx.tenantId, ctx.settings, parsed.data);
      reply.header('etag', `"${r.rows[0].settings_version}"`);
      return { ...resolveSettings(parsed.data), version: r.rows[0].settings_version };
    }, admin),
  );

  app.get(
    '/api/admin/users',
    tenantHandler(async (ctx) => {
      const r = await ctx.db.query(
        `SELECT id, email, display_name AS "displayName", org_unit AS "orgUnit", roles, active, mfa_enabled AS "mfaEnabled",
                (locked_until > now()) AS locked, password_hash IS NOT NULL AS "hasPassword", idp_managed AS "idpManaged", created_at AS "createdAt"
           FROM users WHERE NOT technical ORDER BY display_name`,
      );
      // Roles with a scope (R3-29): [{role, areaId, source}] per person.
      const scoped = await scopedRolesOf(ctx.db, r.rows.map((u) => u.id));
      return r.rows.map((u) => ({ ...u, scopedRoles: scoped.get(u.id) ?? [] }));
    }, people),
  );

  // Areas as master data (R3-29).
  app.get('/api/admin/areas', tenantHandler(async (ctx) => listAreas(ctx), people));
  app.post(
    '/api/admin/areas',
    tenantHandler(async (ctx, req, reply) => {
      const area = await createArea(ctx, areaInput.parse(req.body));
      reply.code(201);
      return area;
    }, admin),
  );
  app.put(
    '/api/admin/areas/:id',
    tenantHandler(async (ctx, req) => updateArea(ctx, z.object({ id: z.uuid() }).parse(req.params).id, areaInput.parse(req.body)), admin),
  );
  app.delete(
    '/api/admin/areas/:id',
    tenantHandler(async (ctx, req) => {
      await deleteArea(ctx, z.object({ id: z.uuid() }).parse(req.params).id);
      return { ok: true };
    }, admin),
  );

  // Invitation by e-mail (R1-09); roles are assigned directly (R1-10).
  app.post(
    '/api/admin/users',
    tenantHandler(async (ctx, req, reply) => {
      const body = userInput.parse(req.body);
      assertPeopleChange(ctx, null, body.roles);
      const exists = await ctx.db.query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [body.email]);
      if (exists.rowCount) throw conflict(m('admin.emailTaken'));
      const r = await ctx.db.query<{ id: string; tenant_id: string; email: string }>(
        `INSERT INTO users (tenant_id, email, display_name, org_unit, roles) VALUES ($1, $2, $3, $4, $5) RETURNING id, tenant_id, email`,
        [ctx.tenantId, body.email, body.displayName, body.orgUnit, Array.from(new Set(['submitter', ...body.roles]))],
      );
      const token = await issuePasswordToken(ctx.db, r.rows[0], m('admin.invite.subject'),
        m('admin.invite.intro', { name: ctx.user!.displayName }));
      await audit(ctx, 'user.invite', 'user', r.rows[0].id, null, body);
      reply.code(201);
      // Without a real mail transport the admin needs the link to hand it over.
      return { id: r.rows[0].id, inviteLink: config.mailTransport === 'log' ? `${config.publicUrl}/passwort?token=${token}` : undefined };
    }, people),
  );

  app.patch(
    '/api/admin/users/:id',
    tenantHandler(async (ctx, req) => {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const body = z
        .object({
          roles: z.array(z.enum(ROLES)).min(1).optional(),
          active: z.boolean().optional(),
          orgUnit: z.string().trim().max(120).nullable().optional(),
          displayName: z.string().trim().min(2).max(120).optional(),
          // Roles for one area only (R3-29); replaces the manually given scoped roles.
          scopedRoles: z.array(scopedRoleSchema).max(100).optional(),
        })
        .parse(req.body);
      const before = (await ctx.db.query('SELECT display_name, org_unit, roles, active FROM users WHERE id = $1 AND NOT technical FOR UPDATE', [id])).rows[0];
      if (!before) throw notFound(m('admin.personNotFound'));
      assertPeopleChange(ctx, before, body.roles);
      if (id === ctx.user!.id && ((body.roles && ctx.user!.roles.includes('admin') && !body.roles.includes('admin')) || body.active === false)) {
        throw badRequest(m('admin.ownAdminRole'));
      }
      const after = {
        display_name: body.displayName ?? before.display_name,
        org_unit: body.orgUnit === undefined ? before.org_unit : body.orgUnit,
        roles: body.roles ? Array.from(new Set(['submitter', ...body.roles])) : before.roles,
        active: body.active ?? before.active,
      };
      await ctx.db.query(`UPDATE users SET display_name = $2, org_unit = $3, roles = $4, active = $5,
              deactivated_at = CASE WHEN $5 THEN NULL ELSE coalesce(deactivated_at, now()) END WHERE id = $1`, [
        id, after.display_name, after.org_unit, after.roles, after.active,
      ]);
      if (body.scopedRoles) await setScopedRoles(ctx, id, body.scopedRoles);
      if (!after.active) await withSystem((c) => c.query('DELETE FROM sessions WHERE user_id = $1', [id]));
      await audit(ctx, 'user.update', 'user', id, before, after);
      return { ok: true };
    }, people),
  );

  app.get(
    '/api/admin/audit',
    tenantHandler(async (ctx, req, reply) => {
      // Filters and cursor (enterprise security): with "cursor" or paged=true the answer is
      // { items, nextCursor }; without them the old array. The full export is /api/admin/audit/export.
      const { format, limit, cursor, paged, ...filter } = auditFilterSchema
        .extend({
          format: z.enum(['json', 'csv']).default('json'),
          limit: z.coerce.number().int().min(1).max(5000).default(200),
          cursor: z.string().max(500).optional(),
          paged: z.stringbool().optional(),
        })
        .parse(req.query);
      const page = await listAudit(ctx, filter, format === 'json' && (cursor || paged) ? Math.min(limit, 500) : limit, cursor);
      const r = { rows: page.items };
      if (!cursor) await audit(ctx, 'audit.view', 'tenant', ctx.tenantId, null, { format, limit, filter });
      if (format === 'json') return cursor || paged ? page : r.rows;
      reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="protokoll.csv"');
      return '﻿' + toCsv([
        ['time', 'person', 'action', 'object', 'id', 'before', 'after'].map((k) => tr(ctx.locale, m(`admin.auditCsv.${k}` as MessageKey))),
        ...r.rows.map((a) => [new Date(a.createdAt).toISOString(), a.actorName ?? tr(ctx.locale, m('admin.auditCsv.system')), a.action, a.entity, a.entityId, JSON.stringify(a.before), JSON.stringify(a.after)]),
      ]);
    }, admin),
  );

  // Full export of the tenant's data (R1-43, R1-40).
  app.get(
    '/api/admin/export',
    tenantHandler(async (ctx) => {
      const tables: Record<string, string> = {
        users: 'SELECT id, email, display_name, org_unit, roles, active, created_at FROM users',
        challenges: 'SELECT * FROM challenges',
        ideas: 'SELECT * FROM ideas',
        idea_events: 'SELECT * FROM idea_events',
        deadlines: 'SELECT * FROM deadlines',
        questions: 'SELECT * FROM questions',
        comments: 'SELECT * FROM comments',
        supports: 'SELECT * FROM supports',
        decisions: 'SELECT * FROM decisions',
        implementations: 'SELECT * FROM implementations',
        feedback: 'SELECT * FROM feedback',
        audit_log: 'SELECT * FROM audit_log',
        // External participation, moderation and feature requests (R3-19, R3-21, R3-20).
        consent_texts: 'SELECT * FROM consent_texts',
        consents: 'SELECT * FROM consents',
        external_access: 'SELECT * FROM external_access',
        content_reports: 'SELECT * FROM content_reports',
        feature_requests: 'SELECT * FROM feature_requests',
        feature_votes: 'SELECT * FROM feature_votes',
        // Recognition and learning (R4-11, R4-02, R4-01, R4-04).
        topic_sponsors: 'SELECT * FROM topic_sponsors',
        trend_items: 'SELECT * FROM trend_items',
        trend_links: 'SELECT * FROM trend_links',
        trend_digests: 'SELECT * FROM trend_digests',
        problem_sources: 'SELECT * FROM problem_sources',
        problem_runs: 'SELECT * FROM problem_runs',
        problem_clusters: 'SELECT * FROM problem_clusters',
        impact_metrics: 'SELECT * FROM impact_metrics',
        impact_metric_values: 'SELECT * FROM impact_metric_values',
      };
      const out: Record<string, unknown> = {
        exportedAt: new Date().toISOString(),
        settings: ctx.settings,
      };
      for (const [name, sql] of Object.entries(tables)) out[name] = (await ctx.db.query(`${sql} ORDER BY 1`)).rows;
      await audit(ctx, 'tenant.export', 'tenant', ctx.tenantId, null, { tables: Object.keys(tables) });
      return out;
    }, admin),
  );

  app.post(
    '/api/admin/jobs/run',
    tenantHandler(async (ctx) => runTenantJobs(ctx), admin),
  );
}
