import { m, relocalize, tr, type Locale, type MessageKey, type Text } from '../i18n/index.js';
import { de } from '../i18n/de/index.js';

/** API error; the message is a catalogue entry resolved in the reader's language (R2-50). */
export class HttpError extends Error {
  constructor(public status: number, public text: Text, public code?: string, public details?: unknown) {
    super(tr('de', text));
  }
}

export const badRequest = (msg: Text, details?: unknown) => new HttpError(400, msg, 'BAD_REQUEST', details);
export const forbidden = (msg: Text = m('common.forbidden')) => new HttpError(403, msg, 'FORBIDDEN');
export const notFound = (msg: Text = m('common.notFound')) => new HttpError(404, msg, 'NOT_FOUND');
export const conflict = (msg: Text, code = 'CONFLICT', details?: unknown) => new HttpError(409, msg, code, details);

/**
 * Validation issues whose message is a catalogue key (custom zod checks) get the text in the
 * reader's language; zod's own messages stay as they are (R2-50).
 */
export function localizeIssues<T extends { message: string }>(locale: Locale, issues: T[]): T[] {
  return issues.map((i) => (Object.hasOwn(de, i.message) ? { ...i, message: tr(locale, m(i.message as MessageKey)) } : i));
}

/** Message of any error in the reader's language: catalogue texts are resolved, stored German AI texts relocalized. */
export function errorText(locale: Locale, err: unknown): string {
  if (err && typeof err === 'object' && 'text' in err && err.text != null) return tr(locale, err.text as Text);
  return relocalize(locale, (err as Error)?.message ?? String(err));
}
