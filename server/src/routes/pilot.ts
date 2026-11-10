import { LOCALES, m, tr } from '../i18n/index.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { features } from '../config.js';
import { withSystem, withTenant } from '../db/pool.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { IMPORT_FIELDS, guessMapping, parseTable, type Mapping } from '../lib/importer.js';
import { SESSION_COOKIE, requireUser, tenantHandler } from '../http.js';
import { audit } from '../services/audit.js';
import { CATEGORIES } from '../services/notify.js';
import { anonymizeUser, personalData } from '../services/privacy.js';
import { createIdea, ideaInput, loadIdea, startDeadline } from '../services/workflow.js';
import { DEMO_TENANT } from './selfservice.js';

const admin = { roles: ['admin' as const] };

export async function pilotRoutes(app: FastifyInstance): Promise<void> {
  // --- Absences and deputies (R1-11)
  app.get(
    '/api/me/absences',
    tenantHandler(async (ctx) => {
      const r = await ctx.db.query(
        `SELECT a.id, a.starts_on AS "startsOn", a.ends_on AS "endsOn", a.note,
                a.user_id = $1 AS mine, u.display_name AS "userName", d.display_name AS "deputyName"
           FROM absences a JOIN users u ON u.id = a.user_id JOIN users d ON d.id = a.deputy_id
          WHERE (a.user_id = $1 OR a.deputy_id = $1) AND a.ends_on >= $2
          ORDER BY a.starts_on`,
        [ctx.user!.id, ctx.today],
      );
      return r.rows;
    }),
  );

  app.post(
    '/api/me/absences',
    tenantHandler(async (ctx, req, reply) => {
      const body = z.object({ deputyId: z.uuid(), startsOn: z.iso.date(), endsOn: z.iso.date(), note: z.string().trim().max(300).optional() }).parse(req.body);
      if (body.endsOn < body.startsOn) throw badRequest(m('pilot.endBeforeBegin'));
      if (body.endsOn < ctx.today) throw badRequest(m('pilot.absencePast'));
      if (body.deputyId === ctx.user!.id) throw badRequest(m('pilot.selfDeputy'));
      const deputy = await ctx.db.query('SELECT 1 FROM users WHERE id = $1 AND active', [body.deputyId]);
      if (!deputy.rowCount) throw badRequest(m('pilot.deputyNotFound'));
      const r = await ctx.db.query<{ id: string }>(
        'INSERT INTO absences (tenant_id, user_id, deputy_id, starts_on, ends_on, note) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [ctx.tenantId, ctx.user!.id, body.deputyId, body.startsOn, body.endsOn, body.note ?? null],
      );
      await audit(ctx, 'absence.create', 'user', ctx.user!.id, null, body);
      reply.code(201);
      return { id: r.rows[0].id };
    }),
  );

  app.delete(
    '/api/me/absences/:id',
    tenantHandler(async (ctx, req) => {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const r = await ctx.db.query('DELETE FROM absences WHERE id = $1 AND user_id = $2', [id, ctx.user!.id]);
      if (!r.rowCount) throw notFound();
      await audit(ctx, 'absence.delete', 'user', ctx.user!.id, { id }, null);
      return { ok: true };
    }),
  );

  // --- Notification preferences (R1-36)
  app.get(
    '/api/me/preferences',
    tenantHandler(async (ctx) => {
      const r = await ctx.db.query<{ notify_email: string; notify_muted: string[] }>('SELECT notify_email, notify_muted FROM users WHERE id = $1', [ctx.user!.id]);
      return { notifyEmail: r.rows[0].notify_email, muted: r.rows[0].notify_muted };
    }),
  );

  app.put(
    '/api/me/preferences',
    tenantHandler(async (ctx, req) => {
      const body = z.object({ notifyEmail: z.enum(['immediate', 'daily', 'off']), muted: z.array(z.enum(CATEGORIES)) }).parse(req.body);
      await ctx.db.query('UPDATE users SET notify_email = $2, notify_muted = $3 WHERE id = $1', [ctx.user!.id, body.notifyEmail, body.muted]);
      return { ok: true };
    }),
  );

  // --- Language per person (R2-50): interface, API errors and mails
  app.put(
    '/api/me/locale',
    tenantHandler(async (ctx, req) => {
      const body = z.object({ locale: z.enum(LOCALES) }).parse(req.body);
      await ctx.db.query('UPDATE users SET locale = $2 WHERE id = $1', [ctx.user!.id, body.locale]);
      return { ok: true, locale: body.locale };
    }, { external: true }),
  );

  // --- Access request: own data (R1-40)
  app.get(
    '/api/me/export',
    tenantHandler(async (ctx, _req, reply) => {
      reply.header('content-disposition', 'attachment; filename="meine-daten.json"');
      return personalData(ctx, ctx.user!.id);
    }, { external: true }),
  );

  app.get(
    '/api/admin/users/:id/export',
    tenantHandler(async (ctx, req, reply) => {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      await audit(ctx, 'user.export', 'user', id, null, null);
      reply.header('content-disposition', 'attachment; filename="auskunft.json"');
      return personalData(ctx, id);
    }, admin),
  );

  app.post(
    '/api/admin/users/:id/anonymize',
    tenantHandler(async (ctx, req) => {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      if (id === ctx.user!.id) throw badRequest(m('pilot.anonymizeSelf'));
      const exists = await ctx.db.query('SELECT 1 FROM users WHERE id = $1', [id]);
      if (!exists.rowCount) throw notFound(m('admin.personNotFound'));
      await withSystem((c) => c.query('DELETE FROM sessions WHERE user_id = $1', [id]));
      await anonymizeUser(ctx, id);
      return { ok: true };
    }, admin),
  );

  // --- Delete the whole workspace at the end of the contract (R1-43): offboarding with
  // re-authentication and grace period, see routes/tenantAdmin.ts.

  // --- Import of existing ideas from CSV or Excel (R1-39)
  app.post(
    '/api/admin/import',
    { bodyLimit: 8_000_000 },
    tenantHandler(async (ctx, req) => {
      const body = z
        .object({
          filename: z.string().min(1).max(200),
          data: z.base64(),
          mapping: z.partialRecord(z.enum(IMPORT_FIELDS), z.number().int().min(0)).optional(),
          dryRun: z.boolean().default(true),
        })
        .parse(req.body);
      const rows = await parseTable(body.filename, Buffer.from(body.data, 'base64'));
      if (rows.length < 2) throw badRequest(m('pilot.importRows'));
      if (rows.length > 2001) throw badRequest(m('pilot.importMax'));
      const [headers, ...data] = rows;
      const mapping: Mapping = body.mapping ?? guessMapping(headers);
      if (mapping.title === undefined) throw badRequest(m('pilot.importTitle'), { headers, mapping });
      const cell = (r: string[], f: keyof Mapping) => (mapping[f] === undefined ? '' : (r[mapping[f]!] ?? '').trim());

      const users = new Map(
        (await ctx.db.query<{ id: string; email: string }>('SELECT id, lower(email) AS email FROM users WHERE active')).rows.map((u) => [u.email, u.id]),
      );
      const existing = (await ctx.db.query<{ t: string }>("SELECT lower(title) AS t FROM ideas WHERE status <> 'draft'")).rows.map((r) => r.t);
      const seen = new Set(existing);
      const report = { total: data.length, imported: 0, duplicates: [] as number[], skipped: [] as number[], unknownAuthors: 0 };
      const preview: Record<string, string>[] = [];

      for (const [i, r] of data.entries()) {
        const rowNo = i + 2;
        const title = cell(r, 'title').slice(0, 140);
        if (title.length < 3) {
          report.skipped.push(rowNo);
          continue;
        }
        if (seen.has(title.toLowerCase())) {
          report.duplicates.push(rowNo);
          continue;
        }
        seen.add(title.toLowerCase());
        const authorId = users.get(cell(r, 'email').toLowerCase());
        if (!authorId) report.unknownAuthors++;
        const topic = ctx.settings.topics.find((t) => t.toLowerCase() === cell(r, 'topic').toLowerCase()) ?? null;
        if (preview.length < 5) {
          preview.push({ title, problem: cell(r, 'problem'), solution: cell(r, 'solution'), benefit: cell(r, 'benefit'), topic: topic ?? '', author: cell(r, 'email') });
        }
        if (body.dryRun) {
          report.imported++;
          continue;
        }
        const idea = await createIdea(
          ctx,
          ideaInput.parse({ title, problem: cell(r, 'problem').slice(0, 5000), solution: cell(r, 'solution').slice(0, 5000), benefit: cell(r, 'benefit').slice(0, 3000), topic }),
          authorId,
        );
        await ctx.db.query(
          `UPDATE ideas SET status = 'submitted', submitted_at = now(), imported = true, author_confirmed = true WHERE id = $1`,
          [idea.id],
        );
        await ctx.db.query(
          `INSERT INTO idea_events (tenant_id, idea_id, actor_id, kind, from_status, to_status, message) VALUES ($1, $2, $3, 'imported', 'draft', 'submitted', $4)`,
          [ctx.tenantId, idea.id, ctx.user!.id, tr('de', m(authorId ? 'pilot.event.imported' : 'pilot.event.importedUnknownAuthor', { file: body.filename, row: rowNo }))],
        );
        await startDeadline(ctx, await loadIdea(ctx, idea.id), 'gate1', ctx.settings.deadlines.gate1Workdays);
        report.imported++;
      }
      if (!body.dryRun) await audit(ctx, 'ideas.import', 'tenant', ctx.tenantId, null, { filename: body.filename, ...report });
      return { headers, mapping, preview, report, dryRun: body.dryRun };
    }, admin),
  );
}

/** Deletes a workspace with all its data, including its audit trail (owner connection). */
export async function purgeTenant(tenantId: string): Promise<void> {
  await withSystem(async (c) => {
    await c.query("SELECT set_config('app.purge_tenant', $1, true)", [tenantId]);
    await c.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  });
}
