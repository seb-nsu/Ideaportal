import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';
import type { Ctx } from '../lib/context.js';
import { LOCALES, isLocale, m, tr, type Locale } from '../i18n/index.js';

// E-mail delivery from the outbox (R1-07, R1-36). Every notification stays visible in the
// portal; e-mail delivery follows each person's preferences: immediately, once a day as a
// digest, or not at all, and muted categories are never mailed.

export interface Mail {
  to: string;
  subject: string;
  body: string;
}

export type Transport = (mail: Mail) => Promise<void>;

let smtp: Transporter | null = null;

/** "erika.mustermann@firma.de" becomes "e***@firma.de". */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  return domain ? `${local.slice(0, 1)}***@${domain}` : '***';
}

const transports: Record<string, Transport> = {
  // Logs carry no idea content (R1-05): only a masked recipient and the size of the mail.
  log: async (mail) => {
    console.log(`[mail] to=${maskEmail(mail.to)} subject=${mail.subject.length} chars body=${mail.body.length} chars`);
  },
  none: async () => undefined,
  smtp: async (mail) => {
    if (!config.smtpUrl) throw new Error('SMTP_URL is not set');
    smtp ??= nodemailer.createTransport(config.smtpUrl);
    await smtp.sendMail({ from: config.mailFrom, to: mail.to, subject: mail.subject, text: mail.body });
  },
};

/** Platform mail outside any workspace (operator alerts), sent with the configured transport. */
export async function sendPlatformMail(mail: Mail): Promise<void> {
  await (transports[config.mailTransport] ?? transports.log)(mail);
}

interface PendingMail {
  id: number;
  user_id: string | null;
  to_email: string;
  subject: string;
  body: string;
  category: string;
  notify_email: string | null;
  notify_muted: string[] | null;
  confidential: boolean | null;
  number: number | null;
  locale: string | null;
}

/** Recipient language; system mails without a known person fall back to German (R2-50). */
const mailLocale = (l: string | null | undefined): Locale => (isLocale(l) ? l : 'de');

/** "[Vertretung für Name] " (or its translation) at the start of a subject. */
const escapeRe = (s: string) => s.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');
const DEPUTY_PREFIX = new RegExp(
  '^(?:' + LOCALES.map((l) => escapeRe(tr(l, m('mail.deputyPrefix', { name: '\u0000' }))).replace('\u0000', '[^\\]]+')).join('|') + ')',
);

/**
 * Mails about confidential ideas carry only the idea number in the subject (R1-45, T-I10):
 * subjects end up in forwarding rules, deputies' inboxes and mail server logs. The in-app
 * inbox keeps the full subject.
 */
export function mailSubject(mail: { subject: string; confidential: boolean | null; number: number | null }, locale: Locale = 'de'): string {
  if (!mail.confidential || mail.number == null) return mail.subject;
  const deputy = mail.subject.match(DEPUTY_PREFIX)?.[0] ?? '';
  return `${deputy}${tr(locale, m('mail.confidentialSubject', { number: mail.number }))}`;
}

const footer = (locale: Locale) => `\n\n--\n${tr(locale, m('mail.footer', { url: config.publicUrl }))}`;

export async function dispatchMail(ctx: Ctx, limit = 200): Promise<number> {
  const send = transports[config.mailTransport] ?? transports.log;
  const pending = await ctx.db.query<PendingMail>(
    `SELECT o.id, o.user_id, o.to_email, o.subject, o.body, o.category, u.notify_email, u.notify_muted, i.confidential, i.number, u.locale
       FROM outbox o LEFT JOIN users u ON u.id = o.user_id LEFT JOIN ideas i ON i.id = o.idea_id
      WHERE o.sent_at IS NULL ORDER BY o.id LIMIT $1 FOR UPDATE OF o SKIP LOCKED`,
    [limit],
  );
  let sent = 0;
  for (const row of pending.rows) {
    // System mails (invitations, password links) have no user and are always sent.
    const pref = row.user_id ? row.notify_email : 'immediate';
    if (pref === 'daily' && !row.notify_muted?.includes(row.category)) continue; // collected for the digest
    if (pref === 'immediate' && !row.notify_muted?.includes(row.category)) {
      const locale = mailLocale(row.locale);
      await send({ to: row.to_email, subject: mailSubject(row, locale), body: row.body + (row.user_id ? footer(locale) : '') });
      sent++;
    }
    await ctx.db.query('UPDATE outbox SET sent_at = now() WHERE id = $1', [row.id]);
  }
  return sent + (await dispatchDigests(ctx, send));
}

/** One summary mail per person and day for everyone who chose the daily digest. */
async function dispatchDigests(ctx: Ctx, send: Transport): Promise<number> {
  const users = await ctx.db.query<{ id: string; email: string; locale: string | null }>(
    `SELECT u.id, u.email, u.locale FROM users u
      WHERE u.notify_email = 'daily' AND u.active AND (u.last_digest_on IS NULL OR u.last_digest_on < $1)
        AND EXISTS (SELECT 1 FROM outbox o WHERE o.user_id = u.id AND o.sent_at IS NULL)
      FOR UPDATE OF u SKIP LOCKED`,
    [ctx.today],
  );
  for (const u of users.rows) {
    const items = await ctx.db.query<{ id: number; subject: string; body: string; confidential: boolean | null; number: number | null }>(
      `SELECT o.id, o.subject, o.body, i.confidential, i.number FROM outbox o LEFT JOIN ideas i ON i.id = o.idea_id
        WHERE o.user_id = $1 AND o.sent_at IS NULL ORDER BY o.id`,
      [u.id],
    );
    const locale = mailLocale(u.locale);
    const body = items.rows.map((i) => `• ${mailSubject(i, locale)}\n  ${i.body.replace(/\n/g, '\n  ')}`).join('\n\n');
    await send({ to: u.email, subject: tr(locale, m('mail.digestSubject', { count: items.rows.length })), body: body + footer(locale) });
    await ctx.db.query('UPDATE outbox SET sent_at = now() WHERE id = ANY($1)', [items.rows.map((i) => i.id)]);
    await ctx.db.query('UPDATE users SET last_digest_on = $2 WHERE id = $1', [u.id, ctx.today]);
  }
  return users.rowCount ?? 0;
}
