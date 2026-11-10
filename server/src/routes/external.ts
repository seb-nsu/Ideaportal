import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { withSystem, withTenant } from '../db/pool.js';
import { SESSION_COOKIE, requestLocale, sessionCookie, tenantHandler } from '../http.js';
import { LOCALES, m } from '../i18n/index.js';
import { buildCtx, isExternal, type Ctx } from '../lib/context.js';
import { hashPassword } from '../lib/crypto.js';
import { assertPasswordPolicy } from '../lib/password.js';
import { HttpError, conflict, forbidden, notFound } from '../lib/errors.js';
import { clientIp, enforce } from '../lib/ratelimit.js';
import { resolveSettings } from '../lib/settings.js';
import { audit } from '../services/audit.js';
import { acceptsIdeas } from '../services/challenges.js';
import {
  EXTERNAL_VISIBLE_SQL,
  accessibleChallenge,
  addTextVersion,
  ensureText,
  externalOn,
  latestText,
  moderationMode,
  newPortalCode,
  recordConsents,
  requireConsents,
  requireExternalEnabled,
  spamCheck,
  type ConsentText,
  type ExternalChallenge,
} from '../services/external.js';
import { featureRequestsOn } from '../services/featureRequests.js';
import { notifyUser } from '../services/notify.js';
import { answerQuestion, createIdea, loadIdea, submitIdea, type IdeaRow } from '../services/workflow.js';
import { createSession, issuePasswordToken } from './auth.js';

// External participation (R3-19): portal link and invitation per challenge, consent to the terms
// of use and to the text on usage rights and confidentiality (versioned, logged), own ideas and
// released ideas only. Every endpoint here that externals use is opened with { external: true };
// all other endpoints of the API stay closed to them (requireUser in http.ts).

const team = { roles: ['admin' as const, 'triage' as const] };
const admin = { roles: ['admin' as const] };
const ext = { external: true };

const idParam = (req: { params: unknown }) => z.object({ id: z.uuid() }).parse(req.params).id;
const portalLink = (code: string | null) => (code ? `${config.publicUrl}/mitmachen/${code}` : null);
const textOut = (t: ConsentText | null, accepted?: Set<string>) =>
  t ? { id: t.id, version: t.version, body: t.body, createdAt: t.created_at, ...(accepted ? { accepted: accepted.has(t.id) } : {}) } : null;

function requireExternalUser(ctx: Ctx): void {
  if (!isExternal(ctx.user)) throw forbidden();
}

/** The challenge behind a portal link, with its tenant; only while both are open to externals. */
async function challengeByCode(code: string) {
  const row = await withSystem(async (c) =>
    (await c.query<{ id: string; title: string; question: string; tenant_id: string; external_enabled: boolean; name: string; slug: string; settings: unknown }>(
      `SELECT c.id, c.title, c.question, c.tenant_id, c.external_enabled, t.name, t.slug, t.settings
         FROM challenges c JOIN tenants t ON t.id = c.tenant_id WHERE c.external_code = $1`,
      [code],
    )).rows[0],
  );
  if (!row || !row.external_enabled || !resolveSettings(row.settings).external.enabled) throw notFound(m('external.linkInvalid'));
  return row;
}

const account = {
  name: z.string().trim().min(2).max(120),
  email: z.email().max(200),
  password: z.string().min(10).max(200),
};

export const externalIdeaInput = z.object({
  title: z.string().trim().min(3).max(140),
  problem: z.string().trim().max(5000).default(''),
  solution: z.string().trim().max(5000).default(''),
  benefit: z.string().trim().max(3000).default(''),
  topic: z.string().trim().max(80).nullable().optional(),
  confidential: z.boolean().default(false),
  customValues: z.record(z.string().max(40), z.union([z.string().max(2000), z.number()])).optional(),
  confirmNotReport: z.literal(true),
  boundaryAcknowledged: z.boolean().optional(),
  // Honeypot (R3-21): hidden from people, filled in by bots.
  website: z.string().max(500).optional(),
});

async function externalIdea(ctx: Ctx, id: string): Promise<IdeaRow> {
  const r = await ctx.db.query<IdeaRow>(`SELECT i.* FROM ideas i WHERE i.id = $2 AND ${EXTERNAL_VISIBLE_SQL}`, [ctx.user!.id, id]);
  if (!r.rows[0]) throw notFound(m('workflow.ideaNotFound'));
  return r.rows[0];
}

/** What an external person sees of an idea: no comments, people, AI analyses or internal history. */
async function externalDetail(ctx: Ctx, idea: IdeaRow) {
  const own = idea.author_id === ctx.user!.id;
  const challenge = idea.challenge_id ? (await ctx.db.query('SELECT id, title FROM challenges WHERE id = $1', [idea.challenge_id])).rows[0] ?? null : null;
  const questions = own
    ? (await ctx.db.query(`SELECT round, question, answer, asked_on AS "askedOn", answered_at AS "answeredAt" FROM questions WHERE idea_id = $1 ORDER BY round`, [idea.id])).rows
    : [];
  const decisions = own
    ? (await ctx.db.query(`SELECT gate, outcome, reason, decided_at AS "decidedAt" FROM decisions WHERE idea_id = $1 ORDER BY decided_at`, [idea.id])).rows
    : [];
  return {
    id: idea.id,
    number: idea.number,
    title: idea.title,
    problem: idea.problem,
    solution: idea.solution,
    benefit: idea.benefit,
    topic: idea.topic,
    status: idea.status,
    lane: own ? idea.lane : null,
    confidential: idea.confidential,
    moderation: own ? idea.moderation ?? null : null,
    createdAt: idea.created_at,
    submittedAt: idea.submitted_at,
    challenge,
    own,
    questions,
    decisions,
    can: { answer: own && idea.status === 'in_question', report: !own && idea.status !== 'draft' },
  };
}

export async function externalRoutes(app: FastifyInstance): Promise<void> {
  // --- Portal link per challenge (public)
  app.get('/api/external/join/:code', async (req) => {
    const { code } = z.object({ code: z.string().min(10).max(40) }).parse(req.params);
    const c = await challengeByCode(code);
    return withTenant(c.tenant_id, async (db) => {
      const ctx = await buildCtx(db, c.tenant_id, null);
      if (!externalOn(ctx)) throw notFound(m('external.linkInvalid'));
      const terms = await ensureText(ctx, 'terms', null);
      const consent = await ensureText(ctx, 'challenge', c.id);
      return {
        workspace: c.name,
        challenge: { title: c.title, question: c.question },
        terms: textOut(terms),
        consent: textOut(consent),
        privacyNotice: ctx.settings.texts.privacyNotice,
      };
    });
  });

  app.post('/api/external/join/:code', async (req, reply) => {
    const { code } = z.object({ code: z.string().min(10).max(40) }).parse(req.params);
    const body = z
      .object({
        ...account,
        termsId: z.uuid(),
        consentId: z.uuid(),
        acceptTerms: z.literal(true),
        acceptConsent: z.literal(true),
        website: z.string().max(500).optional(),
        locale: z.enum(LOCALES).optional(),
      })
      .parse(req.body);
    await enforce([['externalJoinIp', clientIp(req)]]);
    if (body.website?.trim()) throw new HttpError(400, m('external.spam'), 'SPAM_SUSPECTED');
    const c = await challengeByCode(code);
    await assertPasswordPolicy(body.password, { minLength: resolveSettings(c.settings).security.passwordMinLength, email: body.email });
    const hash = await hashPassword(body.password);
    const locale = body.locale ?? requestLocale(req);
    const userId = await withTenant(c.tenant_id, async (db) => {
      if (!externalOn(await buildCtx(db, c.tenant_id, null))) throw notFound(m('external.linkInvalid'));
      const exists = await db.query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [body.email]);
      if (exists.rowCount) throw conflict(m('external.accountExists'), 'ACCOUNT_EXISTS');
      const terms = await latestText(db, 'terms', null);
      const consent = await latestText(db, 'challenge', c.id);
      if (!terms || !consent || terms.id !== body.termsId || consent.id !== body.consentId) throw conflict(m('external.consentChanged'), 'CONSENT_CHANGED');
      const id = (await db.query<{ id: string }>(
        `INSERT INTO users (tenant_id, email, display_name, roles, password_hash, locale, onboarded) VALUES ($1, $2, $3, ARRAY['external'], $4, $5, true) RETURNING id`,
        [c.tenant_id, body.email, body.name, hash, locale],
      )).rows[0].id;
      await db.query(`INSERT INTO external_access (tenant_id, user_id, challenge_id, via) VALUES ($1, $2, $3, 'link')`, [c.tenant_id, id, c.id]);
      await recordConsents(db, c.tenant_id, id, [terms.id, consent.id]);
      await db.query('INSERT INTO audit_log (tenant_id, actor_id, action, entity, entity_id, after) VALUES ($1, $2, $3, $4, $5, $6)', [
        c.tenant_id, id, 'user.join_external', 'user', id, JSON.stringify({ challengeId: c.id, via: 'link' }),
      ]);
      return id;
    });
    const token = await withSystem((s) => createSession(s, userId, c.tenant_id));
    reply.setCookie(SESSION_COOKIE, token, sessionCookie());
    reply.code(201);
    return { ok: true, challengeId: c.id };
  });

  // A signed-in external person opens the portal link of a further challenge.
  app.post(
    '/api/external/access/:code',
    tenantHandler(async (ctx, req) => {
      requireExternalUser(ctx);
      requireExternalEnabled(ctx);
      const { code } = z.object({ code: z.string().min(10).max(40) }).parse(req.params);
      const c = (await ctx.db.query<{ id: string }>('SELECT id FROM challenges WHERE external_code = $1 AND external_enabled', [code])).rows[0];
      if (!c) throw notFound(m('external.linkInvalid'));
      await ctx.db.query(`INSERT INTO external_access (tenant_id, user_id, challenge_id, via) VALUES ($1, $2, $3, 'link') ON CONFLICT DO NOTHING`, [ctx.tenantId, ctx.user!.id, c.id]);
      await ensureText(ctx, 'challenge', c.id);
      return { challengeId: c.id };
    }, ext),
  );

  // --- Start page of an external person: challenges, texts to accept, topics.
  app.get(
    '/api/external/home',
    tenantHandler(async (ctx) => {
      requireExternalUser(ctx);
      const me = ctx.user!.id;
      if (!externalOn(ctx)) return { enabled: false, terms: null, challenges: [], topics: [], featureRequests: featureRequestsOn(ctx), privacyNotice: ctx.settings.texts.privacyNotice };
      const accepted = new Set((await ctx.db.query<{ consent_text_id: string }>('SELECT consent_text_id FROM consents WHERE user_id = $1', [me])).rows.map((x) => x.consent_text_id));
      const rows = (await ctx.db.query<ExternalChallenge>(
        `SELECT c.id, c.title, c.question, c.topic, c.starts_on::text, c.ends_on::text, c.external_enabled, c.external_code, c.moderation,
                c.phase, c.phase_plan, c.custom_fields
           FROM challenges c JOIN external_access ea ON ea.challenge_id = c.id AND ea.user_id = $1
          WHERE c.external_enabled ORDER BY c.ends_on DESC`,
        [me],
      )).rows;
      const challenges = [];
      for (const c of rows) {
        challenges.push({
          id: c.id,
          title: c.title,
          question: c.question,
          topic: c.topic,
          startsOn: c.starts_on,
          endsOn: c.ends_on,
          open: c.starts_on <= ctx.today && c.ends_on >= ctx.today && acceptsIdeas({ phase_plan: c.phase_plan as never, phase: c.phase as never }),
          moderation: moderationMode(ctx, c),
          customFields: c.custom_fields ?? [],
          consent: textOut(await latestText(ctx.db, 'challenge', c.id), accepted),
        });
      }
      return {
        enabled: true,
        terms: textOut(await latestText(ctx.db, 'terms', null), accepted),
        challenges,
        topics: ctx.settings.topics,
        featureRequests: featureRequestsOn(ctx),
        privacyNotice: ctx.settings.texts.privacyNotice,
      };
    }, ext),
  );

  app.post(
    '/api/external/consents',
    tenantHandler(async (ctx, req) => {
      requireExternalUser(ctx);
      requireExternalEnabled(ctx);
      const { ids } = z.object({ ids: z.array(z.uuid()).min(1).max(20) }).parse(req.body);
      // Only the terms and texts of challenges the person takes part in.
      const allowed = await ctx.db.query(
        `SELECT t.id FROM consent_texts t WHERE t.id = ANY($1::uuid[])
            AND (t.kind = 'terms' OR EXISTS (SELECT 1 FROM external_access ea WHERE ea.user_id = $2 AND ea.challenge_id = t.challenge_id))`,
        [ids, ctx.user!.id],
      );
      if (allowed.rowCount !== new Set(ids).size) throw notFound(m('external.consentUnknown'));
      await recordConsents(ctx.db, ctx.tenantId, ctx.user!.id, ids);
      return { ok: true };
    }, ext),
  );

  // --- Ideas of an external person: own ideas and released ideas of the same challenges.
  app.get(
    '/api/external/ideas',
    tenantHandler(async (ctx, req) => {
      requireExternalUser(ctx);
      const q = z.object({ challengeId: z.uuid().optional() }).parse(req.query);
      const r = await ctx.db.query(
        `SELECT i.id, i.number, i.title, i.topic, i.status, i.confidential, i.challenge_id AS "challengeId", c.title AS "challengeTitle",
                i.created_at AS "createdAt", i.submitted_at AS "submittedAt", (i.author_id = $1) AS own,
                CASE WHEN i.author_id = $1 THEN i.moderation END AS moderation
           FROM ideas i LEFT JOIN challenges c ON c.id = i.challenge_id
          WHERE ${EXTERNAL_VISIBLE_SQL} AND ($2::uuid IS NULL OR i.challenge_id = $2)
          ORDER BY coalesce(i.submitted_at, i.created_at) DESC LIMIT 200`,
        [ctx.user!.id, q.challengeId ?? null],
      );
      return r.rows;
    }, ext),
  );

  app.get(
    '/api/external/ideas/:id',
    tenantHandler(async (ctx, req) => {
      requireExternalUser(ctx);
      return externalDetail(ctx, await externalIdea(ctx, idParam(req)));
    }, ext),
  );

  app.post(
    '/api/external/challenges/:id/ideas',
    tenantHandler(async (ctx, req, reply) => {
      requireExternalUser(ctx);
      requireExternalEnabled(ctx);
      const body = externalIdeaInput.parse(req.body);
      const c = await accessibleChallenge(ctx, idParam(req));
      const open = c.starts_on <= ctx.today && c.ends_on >= ctx.today && acceptsIdeas({ phase_plan: c.phase_plan as never, phase: c.phase as never });
      if (!open) throw conflict(m('external.challengeClosed'), 'CHALLENGE_CLOSED');
      await requireConsents(ctx, c.id);
      spamCheck(ctx, [body.title, body.problem, body.solution, body.benefit, ...Object.values(body.customValues ?? {}).map(String)], body.website);
      await enforce([['externalPostAccount', ctx.user!.id]]);
      const topic = body.topic && ctx.settings.topics.includes(body.topic) ? body.topic : c.topic ?? ctx.settings.topics[0];
      const created = await createIdea(ctx, {
        title: body.title, problem: body.problem, solution: body.solution, benefit: body.benefit, topic,
        ideaType: 'product', confidential: body.confidential, anonymous: false, challengeId: c.id, customValues: body.customValues,
      });
      const moderation = moderationMode(ctx, c) === 'pre' ? 'pending' : 'approved';
      await ctx.db.query(`UPDATE ideas SET origin = 'external', moderation = $2 WHERE id = $1`, [created.id, moderation]);
      await submitIdea(ctx, await loadIdea(ctx, created.id, true), { confirmNotReport: true, boundaryAcknowledged: body.boundaryAcknowledged });
      reply.code(201);
      return { id: created.id, number: created.number, moderation };
    }, ext),
  );

  app.post(
    '/api/external/ideas/:id/answer',
    tenantHandler(async (ctx, req) => {
      requireExternalUser(ctx);
      const { answer } = z.object({ answer: z.string().trim().min(2).max(5000) }).parse(req.body);
      const idea = await externalIdea(ctx, idParam(req));
      if (idea.author_id !== ctx.user!.id) throw forbidden();
      await answerQuestion(ctx, await loadIdea(ctx, idea.id, true), answer);
      return { ok: true };
    }, ext),
  );

  // --- Administration: tenant switch, terms, challenges, invitations, consent log.
  app.get(
    '/api/admin/external',
    tenantHandler(async (ctx) => {
      const rows = (await ctx.db.query<ExternalChallenge & { participants: number; pending: number }>(
        `SELECT c.id, c.title, c.starts_on::text, c.ends_on::text, c.external_enabled, c.external_code, c.moderation,
                (SELECT count(*) FROM external_access ea WHERE ea.challenge_id = c.id)::int AS participants,
                (SELECT count(*) FROM ideas i WHERE i.challenge_id = c.id AND i.moderation = 'pending' AND i.status <> 'draft')::int AS pending
           FROM challenges c ORDER BY (c.ends_on >= $1) DESC, c.ends_on DESC`,
        [ctx.today],
      )).rows;
      const challenges = [];
      for (const c of rows) {
        challenges.push({
          id: c.id,
          title: c.title,
          startsOn: c.starts_on,
          endsOn: c.ends_on,
          externalEnabled: c.external_enabled,
          link: c.external_enabled ? portalLink(c.external_code) : null,
          moderation: c.moderation,
          effectiveModeration: moderationMode(ctx, c),
          consent: textOut(await latestText(ctx.db, 'challenge', c.id)),
          participants: c.participants,
          pending: c.pending,
        });
      }
      return { settings: ctx.settings.external, terms: textOut(await latestText(ctx.db, 'terms', null)), challenges };
    }, team),
  );

  app.put(
    '/api/admin/external',
    tenantHandler(async (ctx, req) => {
      const body = z.object({ enabled: z.boolean(), moderation: z.enum(['pre', 'post']), maxLinks: z.number().int().min(0).max(20) }).parse(req.body);
      await ctx.db.query(`UPDATE tenants SET settings = settings || jsonb_build_object('external', $2::jsonb) WHERE id = $1`, [ctx.tenantId, JSON.stringify(body)]);
      await audit(ctx, 'settings.external', 'tenant', ctx.tenantId, ctx.settings.external, body);
      if (body.enabled) await ensureText(ctx, 'terms', null);
      return body;
    }, admin),
  );

  app.post(
    '/api/admin/external/terms',
    tenantHandler(async (ctx, req, reply) => {
      const { body } = z.object({ body: z.string().trim().min(20).max(20000) }).parse(req.body);
      const t = await addTextVersion(ctx, 'terms', null, body);
      reply.code(201);
      return textOut(t);
    }, admin),
  );

  // Version history of a text with the number of consents per version.
  app.get(
    '/api/admin/external/texts',
    tenantHandler(async (ctx, req) => {
      const q = z.object({ challengeId: z.uuid().optional() }).parse(req.query);
      const r = await ctx.db.query(
        `SELECT t.id, t.version, t.body, t.created_at AS "createdAt", u.display_name AS "createdBy",
                (SELECT count(*) FROM consents c WHERE c.consent_text_id = t.id)::int AS consents
           FROM consent_texts t LEFT JOIN users u ON u.id = t.created_by
          WHERE t.kind = $1 AND t.challenge_id IS NOT DISTINCT FROM $2 ORDER BY t.version DESC`,
        [q.challengeId ? 'challenge' : 'terms', q.challengeId ?? null],
      );
      return r.rows;
    }, team),
  );

  app.patch(
    '/api/admin/external/challenges/:id',
    tenantHandler(async (ctx, req) => {
      const id = idParam(req);
      const body = z
        .object({ externalEnabled: z.boolean().optional(), moderation: z.enum(['pre', 'post']).nullable().optional(), newLink: z.boolean().optional() })
        .parse(req.body);
      const before = (await ctx.db.query<{ external_enabled: boolean; external_code: string | null; moderation: string | null }>(
        'SELECT external_enabled, external_code, moderation FROM challenges WHERE id = $1 FOR UPDATE', [id],
      )).rows[0];
      if (!before) throw notFound(m('workflow.challengeNotFound'));
      const enabled = body.externalEnabled ?? before.external_enabled;
      if (enabled) requireExternalEnabled(ctx);
      // A new link makes the old one invalid (e.g. after it was passed on too widely).
      const code = enabled && (!before.external_code || body.newLink) ? newPortalCode() : before.external_code;
      const moderation = body.moderation === undefined ? before.moderation : body.moderation;
      await ctx.db.query('UPDATE challenges SET external_enabled = $2, external_code = $3, moderation = $4 WHERE id = $1', [id, enabled, code, moderation]);
      if (enabled) await ensureText(ctx, 'challenge', id);
      await audit(ctx, 'challenge.external', 'challenge', id, { enabled: before.external_enabled, moderation: before.moderation },
        { enabled, moderation, newLink: !!body.newLink });
      return { externalEnabled: enabled, link: enabled ? portalLink(code) : null, moderation };
    }, team),
  );

  app.post(
    '/api/admin/external/challenges/:id/consent',
    tenantHandler(async (ctx, req, reply) => {
      const id = idParam(req);
      const { body } = z.object({ body: z.string().trim().min(20).max(20000) }).parse(req.body);
      const exists = await ctx.db.query('SELECT 1 FROM challenges WHERE id = $1', [id]);
      if (!exists.rowCount) throw notFound(m('workflow.challengeNotFound'));
      const t = await addTextVersion(ctx, 'challenge', id, body);
      reply.code(201);
      return textOut(t);
    }, team),
  );

  // Invitation by e-mail: a new external account, or access to one more challenge.
  app.post(
    '/api/admin/external/challenges/:id/invitations',
    tenantHandler(async (ctx, req, reply) => {
      requireExternalEnabled(ctx);
      const id = idParam(req);
      const body = z.object({ email: z.email().max(200), name: z.string().trim().min(2).max(120) }).parse(req.body);
      const c = (await ctx.db.query<{ title: string; external_enabled: boolean }>('SELECT title, external_enabled FROM challenges WHERE id = $1', [id])).rows[0];
      if (!c) throw notFound(m('workflow.challengeNotFound'));
      if (!c.external_enabled) throw conflict(m('external.challengeNotExternal'), 'CHALLENGE_NOT_EXTERNAL');
      await ensureText(ctx, 'challenge', id);
      const existing = (await ctx.db.query<{ id: string; roles: string[] }>('SELECT id, roles FROM users WHERE lower(email) = lower($1)', [body.email])).rows[0];
      let userId: string;
      let inviteLink: string | undefined;
      if (existing) {
        if (!existing.roles.includes('external')) throw conflict(m('external.internalAccount'), 'INTERNAL_ACCOUNT');
        userId = existing.id;
        await notifyUser(ctx, userId, m('external.access.subject', { challenge: c.title }), m('external.access.body', { challenge: c.title, url: `${config.publicUrl}/` }), undefined, 'my_ideas');
      } else {
        const u = (await ctx.db.query<{ id: string; tenant_id: string; email: string }>(
          `INSERT INTO users (tenant_id, email, display_name, roles, locale, onboarded) VALUES ($1, $2, $3, ARRAY['external'], $4, true) RETURNING id, tenant_id, email`,
          [ctx.tenantId, body.email, body.name, ctx.settings.locale],
        )).rows[0];
        userId = u.id;
        const token = await issuePasswordToken(ctx.db, u, m('external.invite.subject', { challenge: c.title }),
          m('external.invite.intro', { name: ctx.user!.displayName, challenge: c.title }));
        if (config.mailTransport === 'log') inviteLink = `${config.publicUrl}/passwort?token=${token}`;
      }
      await ctx.db.query(
        `INSERT INTO external_access (tenant_id, user_id, challenge_id, via, invited_by) VALUES ($1, $2, $3, 'invite', $4) ON CONFLICT DO NOTHING`,
        [ctx.tenantId, userId, id, ctx.user!.id],
      );
      await audit(ctx, 'user.invite_external', 'user', userId, null, { challengeId: id, email: body.email });
      reply.code(201);
      return { id: userId, inviteLink };
    }, team),
  );

  // Consent log (R3-19): who accepted which version of which text when.
  app.get(
    '/api/admin/external/consents',
    tenantHandler(async (ctx, req) => {
      const q = z.object({ challengeId: z.uuid().optional() }).parse(req.query);
      const r = await ctx.db.query(
        `SELECT c.accepted_at AS "acceptedAt", u.display_name AS name, u.email, t.kind, t.version, ch.title AS "challengeTitle"
           FROM consents c JOIN users u ON u.id = c.user_id JOIN consent_texts t ON t.id = c.consent_text_id
           LEFT JOIN challenges ch ON ch.id = t.challenge_id
          WHERE ($1::uuid IS NULL OR t.challenge_id = $1 OR t.kind = 'terms')
          ORDER BY c.accepted_at DESC LIMIT 1000`,
        [q.challengeId ?? null],
      );
      await audit(ctx, 'consents.view', 'tenant', ctx.tenantId, null, { challengeId: q.challengeId ?? null });
      return r.rows;
    }, admin),
  );
}
