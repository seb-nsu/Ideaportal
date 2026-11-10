import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { features } from '../config.js';
import { withSystem, withTenant, type Db } from '../db/pool.js';
import { buildCtx, type SessionUser } from '../lib/context.js';
import { addWorkdays } from '../lib/workdays.js';
import { acceptImplementation, closeImplementation, createIdea, loadIdea, submitIdea, triageIdea } from '../services/workflow.js';
import { startTrial } from '../services/billing.js';
import { todayIn } from '../lib/workdays.js';
import { hashPassword } from '../lib/crypto.js';
import { assertPasswordPolicy } from '../lib/password.js';
import { resolveSettings } from '../lib/settings.js';
import { HttpError, conflict, notFound } from '../lib/errors.js';
import { LOCALES, m, tr } from '../i18n/index.js';
import { localizedDefaults } from '../lib/default-texts.js';
import { SESSION_COOKIE, requestLocale, sessionCookie, tenantHandler } from '../http.js';
import { audit } from '../services/audit.js';
import { clientIp, enforce } from '../lib/ratelimit.js';
import { createSession } from './auth.js';
import { buildInfo } from '../lib/version.js';
import { DEMO_WORKSPACES, demoAccount, isDemoSlug } from '../db/demo-content.js';

// Self-service without a company login: create a workspace, join by link, try the demo.

export const DEMO_TENANT = DEMO_WORKSPACES.de.slug;
/** Roles offered on the demo page; the workspace follows the language of the page (R3-22). */
const DEMO_ROLES = ['submitter', 'triage', 'committee', 'owner', 'admin'] as const;

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '');
  return base.length >= 2 ? base : `team-${base}`.replace(/-+$/, '');
}

async function uniqueSlug(c: Db, name: string): Promise<string> {
  const base = slugify(name);
  let slug = base;
  while ((await c.query('SELECT 1 FROM tenants WHERE slug = $1', [slug])).rowCount || isDemoSlug(slug)) {
    slug = `${base.slice(0, 33)}-${randomBytes(2).toString('hex')}`;
  }
  return slug;
}

const newJoinCode = () => randomBytes(9).toString('base64url');

const account = {
  name: z.string().trim().min(2).max(120),
  email: z.email().max(200),
  password: z.string().min(10).max(200),
};

async function systemAudit(c: Db, tenantId: string, actorId: string, action: string, after: unknown) {
  await c.query('INSERT INTO audit_log (tenant_id, actor_id, action, entity, entity_id, after) VALUES ($1, $2, $3, $4, $5, $6)', [
    tenantId, actorId, action, 'user', actorId, JSON.stringify(after),
  ]);
}

/** A first challenge and an example idea, so a new workspace can be tried right away (R1-38). */
async function addStarterContent(user: SessionUser): Promise<void> {
  await withTenant(user.tenantId, async (db) => {
    const ctx = await buildCtx(db, user.tenantId, user);
    const challengeId = (await db.query<{ id: string }>(
      `INSERT INTO challenges (tenant_id, title, question, topic, contact, sponsor_id, starts_on, ends_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      // Starter content belongs to the workspace and is written in its language (R3-22).
      [user.tenantId, tr(ctx.settings.locale, m('selfservice.starter.challengeTitle')), tr(ctx.settings.locale, m('selfservice.starter.challengeQuestion')), ctx.settings.topics[0],
       user.displayName, user.id, ctx.today, addWorkdays(ctx.today, 20, ctx.holidays)],
    )).rows[0].id;
    const idea = await createIdea(ctx, {
      title: tr(ctx.settings.locale, m('selfservice.starter.ideaTitle')),
      problem: tr(ctx.settings.locale, m('selfservice.starter.ideaProblem')),
      solution: tr(ctx.settings.locale, m('selfservice.starter.ideaSolution')),
      benefit: tr(ctx.settings.locale, m('selfservice.starter.ideaBenefit')),
      topic: ctx.settings.topics[0], ideaType: 'internal', confidential: false, anonymous: false, challengeId,
    });
    await submitIdea(ctx, await loadIdea(ctx, idea.id, true), { confirmNotReport: true });
    // Second example for the trial (R3-02): an implemented idea with its actual benefit, so
    // the dashboard and the success path are not empty.
    const done = await createIdea(ctx, {
      title: tr(ctx.settings.locale, m('selfservice.starter.doneTitle')),
      problem: tr(ctx.settings.locale, m('selfservice.starter.doneProblem')),
      solution: tr(ctx.settings.locale, m('selfservice.starter.doneSolution')),
      benefit: tr(ctx.settings.locale, m('selfservice.starter.doneBenefit')),
      topic: ctx.settings.topics[0], ideaType: 'internal', confidential: false, anonymous: false, challengeId: null,
    });
    await submitIdea(ctx, await loadIdea(ctx, done.id, true), { confirmNotReport: true });
    await triageIdea(ctx, await loadIdea(ctx, done.id, true), {
      lane: 'fast_lane', reason: tr(ctx.settings.locale, m('selfservice.starter.doneReason')), ownerId: user.id, orgUnit: tr(ctx.settings.locale, m('selfservice.starter.doneOrgUnit')),
      targetDate: addWorkdays(ctx.today, 10, ctx.holidays),
    });
    await acceptImplementation(ctx, await loadIdea(ctx, done.id, true));
    await closeImplementation(ctx, await loadIdea(ctx, done.id, true), {
      benefitKind: 'hours', benefitValue: 40, benefitEvidence: tr(ctx.settings.locale, m('selfservice.starter.doneEvidence')),
    });
  });
}

export async function selfServiceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/public-config', async () => ({ signup: features.signup, demo: features.demo }));
  // App version and build commit for support and the release check (no sign-in, no secrets).
  app.get('/api/version', async () => buildInfo());

  app.post('/api/signup', async (req, reply) => {
    if (!features.signup) throw new HttpError(403, m('selfservice.signupDisabled'), 'SIGNUP_DISABLED');
    const body = z
      .object({ workspace: z.string().trim().min(2).max(80), ...account, acceptPrivacy: z.literal(true), exampleData: z.boolean().default(true), locale: z.enum(LOCALES).optional() })
      .parse(req.body);
    // Language of the new workspace and its first person: chosen on the page, else the browser's (R3-22).
    const locale = body.locale ?? requestLocale(req);
    await enforce([['signupIp', clientIp(req)]]);
    await assertPasswordPolicy(body.password, { email: body.email, workspace: body.workspace });
    const hash = await hashPassword(body.password);
    const { token, slug, tenantId, userId } = await withSystem(async (c) => {
      const slug = await uniqueSlug(c, body.workspace);
      const tenantId = (await c.query<{ id: string }>(
        `INSERT INTO tenants (slug, name, settings, join_code, created_via) VALUES ($1, $2, $3, $4, 'signup') RETURNING id`,
        // Two-factor login stays available and can be made mandatory in the settings.
        [slug, body.workspace, JSON.stringify({ requireMfaForAdmins: false, ...localizedDefaults(locale) }), newJoinCode()],
      )).rows[0].id;
      const userId = (await c.query<{ id: string }>(
        `INSERT INTO users (tenant_id, email, display_name, roles, password_hash, locale) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [tenantId, body.email, body.name, ['submitter', 'admin', 'triage', 'committee'], hash, locale],
      )).rows[0].id;
      await systemAudit(c, tenantId, userId, 'tenant.signup', { workspace: body.workspace, slug });
      // 30-day trial (R3-02); afterwards the workspace is read-only until a package is chosen.
      await startTrial(c, tenantId, todayIn('Europe/Berlin'));
      return { token: await createSession(c, userId, tenantId), slug, tenantId, userId };
    });
    if (body.exampleData) {
      await addStarterContent({ id: userId, tenantId, email: body.email, displayName: body.name, orgUnit: null, roles: ['submitter', 'admin', 'triage', 'committee'], mfaEnabled: false });
    }
    reply.setCookie(SESSION_COOKIE, token, sessionCookie());
    reply.code(201);
    return { slug };
  });

  app.get('/api/join/:code', async (req) => {
    const { code } = z.object({ code: z.string().min(6).max(40) }).parse(req.params);
    const t = await withSystem(async (c) => (await c.query('SELECT name, slug FROM tenants WHERE join_code = $1', [code])).rows[0]);
    if (!t) throw notFound(m('selfservice.joinInvalid'));
    return t;
  });

  app.post('/api/join/:code', async (req, reply) => {
    const { code } = z.object({ code: z.string().min(6).max(40) }).parse(req.params);
    const body = z.object({ ...account, acceptPrivacy: z.literal(true), locale: z.enum(LOCALES).optional() }).parse(req.body);
    const locale = body.locale ?? requestLocale(req);
    await enforce([['joinIp', clientIp(req)]]);
    // Password policy of the workspace behind the link (an unknown link is answered below).
    const joinSettings = await withSystem(async (c) => (await c.query<{ settings: unknown }>('SELECT settings FROM tenants WHERE join_code = $1', [code])).rows[0]?.settings);
    await assertPasswordPolicy(body.password, { minLength: resolveSettings(joinSettings ?? {}).security.passwordMinLength, email: body.email });
    const hash = await hashPassword(body.password);
    const token = await withSystem(async (c) => {
      const tenant = (await c.query<{ id: string }>('SELECT id FROM tenants WHERE join_code = $1', [code])).rows[0];
      if (!tenant) throw notFound(m('selfservice.joinInvalid'));
      // Local accounts switched off (R3-26): people join through the company login.
      const ssoOnly = await c.query('SELECT 1 FROM tenant_identity WHERE tenant_id = $1 AND local_login_disabled', [tenant.id]);
      if (ssoOnly.rowCount) throw new HttpError(403, m('identity.joinDisabled'), 'SSO_REQUIRED');
      const exists = await c.query('SELECT 1 FROM users WHERE tenant_id = $1 AND lower(email) = lower($2)', [tenant.id, body.email]);
      if (exists.rowCount) throw conflict(m('selfservice.accountExists'));
      const userId = (await c.query<{ id: string }>(
        `INSERT INTO users (tenant_id, email, display_name, roles, password_hash, locale) VALUES ($1, $2, $3, ARRAY['submitter'], $4, $5) RETURNING id`,
        [tenant.id, body.email, body.name, hash, locale],
      )).rows[0].id;
      await systemAudit(c, tenant.id, userId, 'user.join', { email: body.email });
      return createSession(c, userId, tenant.id);
    });
    reply.setCookie(SESSION_COOKIE, token, sessionCookie());
    reply.code(201);
    return { ok: true };
  });

  // One click into the shared demo workspace with a chosen role.
  app.post('/api/demo/login', async (req, reply) => {
    if (!features.demo) throw new HttpError(404, m('selfservice.demoOff'), 'NOT_FOUND');
    const { role, locale: asked } = z.object({ role: z.enum(DEMO_ROLES), locale: z.enum(LOCALES).optional() }).parse(req.body);
    const locale = asked ?? requestLocale(req);
    await enforce([['demoIp', clientIp(req)]]);
    const token = await withSystem(async (c) => {
      const user = (await c.query<{ id: string; tenant_id: string }>(
        `SELECT u.id, u.tenant_id FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE t.slug = $1 AND u.email = $2 AND u.active`,
        [DEMO_WORKSPACES[locale].slug, demoAccount(locale, role)],
      )).rows[0];
      if (!user) throw notFound(m('selfservice.demoMissing'));
      return createSession(c, user.id, user.tenant_id);
    });
    reply.setCookie(SESSION_COOKIE, token, sessionCookie());
    return { ok: true };
  });

  app.get(
    '/api/admin/join-link',
    tenantHandler(async (ctx) => {
      const r = await ctx.db.query<{ join_code: string | null }>('SELECT join_code FROM tenants WHERE id = $1', [ctx.tenantId]);
      return { code: r.rows[0]?.join_code ?? null };
    }, { roles: ['admin'] }),
  );

  app.post(
    '/api/admin/join-link',
    tenantHandler(async (ctx, req) => {
      const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
      const code = enabled ? newJoinCode() : null;
      await ctx.db.query('UPDATE tenants SET join_code = $2 WHERE id = $1', [ctx.tenantId, code]);
      await audit(ctx, enabled ? 'join_link.reset' : 'join_link.disable', 'tenant', ctx.tenantId, null, { enabled });
      return { code };
    }, { roles: ['admin'] }),
  );
}
