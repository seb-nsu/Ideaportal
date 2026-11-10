import { randomBytes } from 'node:crypto';
import type { Db } from '../db/pool.js';
import { HttpError, conflict, notFound } from '../lib/errors.js';
import type { Ctx } from '../lib/context.js';
import { m, tr } from '../i18n/index.js';
import { audit } from './audit.js';
import { hasFeature } from './billing.js';

// External participation (R3-19) and moderation (R3-21): consent texts with versions, the
// consent log, access per challenge, spam checks. Externals see only their own ideas and the
// released ideas of other externals in their challenges; internal ideas stay invisible.

export type ConsentKind = 'terms' | 'challenge';

export interface ConsentText {
  id: string;
  kind: ConsentKind;
  challenge_id: string | null;
  version: number;
  body: string;
  created_at: Date;
}

export interface ExternalChallenge {
  id: string;
  title: string;
  question: string;
  topic: string | null;
  starts_on: string;
  ends_on: string;
  external_enabled: boolean;
  external_code: string | null;
  moderation: 'pre' | 'post' | null;
  phase: string | null;
  phase_plan: unknown;
  custom_fields: unknown;
}

/**
 * Ideas an external person may see: their own, and released (approved, not confidential)
 * ideas of other externals in a challenge they take part in. $1 = user id.
 */
export const EXTERNAL_VISIBLE_SQL = `(
  i.author_id = $1
  OR (i.origin = 'external' AND i.moderation = 'approved' AND NOT i.confidential AND i.status NOT IN ('draft', 'merged')
      AND EXISTS (SELECT 1 FROM external_access ea WHERE ea.user_id = $1 AND ea.challenge_id = i.challenge_id))
)`;

export const newPortalCode = () => randomBytes(12).toString('base64url');

/**
 * External participation is on when the package includes it (feature switch of AP-18, R3-05)
 * and the tenant switched it on (Einstellungen › Externe, default off).
 */
export function externalOn(ctx: Pick<Ctx, 'settings' | 'plan'>): boolean {
  return ctx.settings.external.enabled && hasFeature(ctx, 'externalParticipation');
}

export function requireExternalEnabled(ctx: Ctx): void {
  if (!externalOn(ctx)) throw new HttpError(404, m('external.disabled'), 'EXTERNAL_DISABLED');
}

/** Moderation mode of a challenge: its own choice, else the tenant default. */
export function moderationMode(ctx: Ctx, c: { moderation: 'pre' | 'post' | null }): 'pre' | 'post' {
  return c.moderation ?? ctx.settings.external.moderation;
}

export async function latestText(db: Db, kind: ConsentKind, challengeId: string | null): Promise<ConsentText | null> {
  const r = await db.query<ConsentText>(
    `SELECT id, kind, challenge_id, version, body, created_at FROM consent_texts
      WHERE kind = $1 AND challenge_id IS NOT DISTINCT FROM $2 ORDER BY version DESC LIMIT 1`,
    [kind, challengeId],
  );
  return r.rows[0] ?? null;
}

/** Adds a new version of a consent text; earlier versions and the consents given to them stay. */
export async function addTextVersion(ctx: Ctx, kind: ConsentKind, challengeId: string | null, body: string): Promise<ConsentText> {
  // One writer at a time per text, so versions never collide.
  await ctx.db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`consent:${ctx.tenantId}:${kind}:${challengeId ?? ''}`]);
  const r = await ctx.db.query<ConsentText>(
    `INSERT INTO consent_texts (tenant_id, kind, challenge_id, version, body, created_by)
     VALUES ($1, $2, $3, (SELECT coalesce(max(version), 0) + 1 FROM consent_texts WHERE kind = $2 AND challenge_id IS NOT DISTINCT FROM $3), $4, $5)
     RETURNING id, kind, challenge_id, version, body, created_at`,
    [ctx.tenantId, kind, challengeId, body, ctx.user?.id ?? null],
  );
  await audit(ctx, 'consent_text.version', kind === 'terms' ? 'tenant' : 'challenge', challengeId ?? ctx.tenantId, null, { kind, version: r.rows[0].version });
  return r.rows[0];
}

/** The current text, or version 1 from the default draft in the workspace language. */
export async function ensureText(ctx: Ctx, kind: ConsentKind, challengeId: string | null): Promise<ConsentText> {
  const existing = await latestText(ctx.db, kind, challengeId);
  if (existing) return existing;
  const body = tr(ctx.settings.locale, m(kind === 'terms' ? 'external.defaultTerms' : 'external.defaultConsent'));
  return addTextVersion(ctx, kind, challengeId, body);
}

/** Current texts the person still has to accept for the given challenges (terms first). */
export async function openConsents(db: Db, userId: string, challengeIds: string[]): Promise<ConsentText[]> {
  const r = await db.query<ConsentText>(
    `SELECT DISTINCT ON (t.kind, t.challenge_id) t.id, t.kind, t.challenge_id, t.version, t.body, t.created_at
       FROM consent_texts t
      WHERE t.kind = 'terms' OR t.challenge_id = ANY($1::uuid[])
      ORDER BY t.kind DESC, t.challenge_id, t.version DESC`,
    [challengeIds],
  );
  const accepted = new Set((await db.query<{ consent_text_id: string }>('SELECT consent_text_id FROM consents WHERE user_id = $1', [userId])).rows.map((x) => x.consent_text_id));
  return r.rows.filter((t) => !accepted.has(t.id));
}

/**
 * Logs the consent of a person to the given texts (who, which version, when). Only current
 * versions are accepted; an outdated version means the text changed while the person read it.
 */
export async function recordConsents(db: Db, tenantId: string, userId: string, textIds: string[]): Promise<void> {
  for (const id of new Set(textIds)) {
    const t = (await db.query<ConsentText>('SELECT id, kind, challenge_id, version FROM consent_texts WHERE id = $1', [id])).rows[0];
    if (!t) throw notFound(m('external.consentUnknown'));
    const latest = await latestText(db, t.kind, t.challenge_id);
    if (latest?.id !== t.id) throw conflict(m('external.consentChanged'), 'CONSENT_CHANGED');
    const r = await db.query('INSERT INTO consents (tenant_id, user_id, consent_text_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [tenantId, userId, id]);
    if (r.rowCount) {
      await db.query('INSERT INTO audit_log (tenant_id, actor_id, action, entity, entity_id, after) VALUES ($1, $2, $3, $4, $5, $6)', [
        tenantId, userId, 'consent.accept', t.kind === 'terms' ? 'tenant' : 'challenge', t.challenge_id ?? tenantId, JSON.stringify({ kind: t.kind, version: t.version, textId: t.id }),
      ]);
    }
  }
}

/** Throws unless the person accepted the current terms and the current text of the challenge. */
export async function requireConsents(ctx: Ctx, challengeId: string): Promise<void> {
  const open = await openConsents(ctx.db, ctx.user!.id, [challengeId]);
  if (open.length) throw conflict(m('external.consentRequired'), 'CONSENT_REQUIRED', { open: open.map((t) => t.id) });
}

/** A challenge the external person takes part in and that is open to externals. */
export async function accessibleChallenge(ctx: Ctx, challengeId: string): Promise<ExternalChallenge> {
  const c = (await ctx.db.query<ExternalChallenge>(
    `SELECT c.id, c.title, c.question, c.topic, c.starts_on::text, c.ends_on::text, c.external_enabled, c.external_code, c.moderation,
            c.phase, c.phase_plan, c.custom_fields
       FROM challenges c JOIN external_access ea ON ea.challenge_id = c.id AND ea.user_id = $2
      WHERE c.id = $1`,
    [challengeId, ctx.user!.id],
  )).rows[0];
  if (!c) throw notFound(m('external.noAccess'));
  if (!c.external_enabled) throw conflict(m('external.challengeNotExternal'), 'CHALLENGE_NOT_EXTERNAL');
  return c;
}

const LINK = /\bhttps?:\/\/|\bwww\.[a-z0-9-]/gi;

export function countLinks(text: string): number {
  return (text.match(LINK) ?? []).length;
}

/**
 * Spam protection for posts of external people and feature requests (R3-21): the honeypot field
 * stays empty for people (it is hidden), and a post may carry only a few links.
 */
export function spamCheck(ctx: Ctx, texts: (string | null | undefined)[], honeypot: string | null | undefined): void {
  if (honeypot && honeypot.trim()) throw new HttpError(400, m('external.spam'), 'SPAM_SUSPECTED');
  const max = ctx.settings.external.maxLinks;
  if (countLinks(texts.filter(Boolean).join(' ')) > max) throw new HttpError(400, m('external.tooManyLinks', { max }), 'TOO_MANY_LINKS');
}
