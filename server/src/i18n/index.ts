import { de } from './de/index.js';
import { en } from './en/index.js';

// Text catalogue for server messages: API errors and mails (R2-50). Every text a person can
// read comes from here, in the language stored for that person (users.locale). German is
// the reference; a missing English text falls back to German.

// Languages, in one place (R3-30). A new language: add a folder <code>/ with the same namespace
// files as de/ and an index.ts, add it here to LOCALES, catalogs and INTL, and add a rule to
// LANGUAGE_RULE in server/src/ai/gateway.ts (the compiler asks for it). Then the web side
// (web/src/i18n/index.ts). Missing keys fall back to German.
export const LOCALES = ['de', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export type MessageKey = keyof typeof de;
export type Vars = Record<string, string | number | null | undefined>;

/** A text that is resolved later, in the language of the reader. */
export interface MessageRef {
  key: MessageKey;
  vars?: Vars;
}
/** Several texts in a row, e.g. a catalogue sentence followed by a tenant text. */
export interface TextList {
  parts: Text[];
  sep?: string;
}
export type Text = string | MessageRef | TextList;

const catalogs: Record<Locale, Partial<Record<MessageKey, string>>> = { de, en };

export const m = (key: MessageKey, vars?: Vars): MessageRef => ({ key, vars });
export const cat = (parts: Text[], sep = ''): TextList => ({ parts, sep });

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Fills the variables; calendar dates (YYYY-MM-DD) appear in the reader's format (R3-22). */
function fill(s: string, vars: Vars | undefined, locale: Locale): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (all, k: string) => {
    const v = vars[k];
    if (v == null) return all;
    return typeof v === 'string' && ISO_DATE.test(v) ? fmt.date(locale, v) : String(v);
  });
}

/** Text in one language. Plain strings (tenant texts, AI output) pass through unchanged. */
export function tr(locale: Locale, text: Text): string {
  if (typeof text === 'string') return text;
  if ('parts' in text) return text.parts.map((p) => tr(locale, p)).join(text.sep ?? '');
  const vars = text.vars && Object.fromEntries(Object.entries(text.vars).map(([k, v]) => [k, v]));
  return fill(catalogs[locale][text.key] ?? de[text.key] ?? text.key, vars, locale);
}

/** The same text in every language, e.g. for an outbox row whose reader is known only in SQL. */
export function trAll(text: Text): Record<Locale, string> {
  return Object.fromEntries(LOCALES.map((l) => [l, tr(l, text)])) as Record<Locale, string>;
}

/** Language from the Accept-Language header for requests without a session. */
export function localeFromHeader(header: string | undefined): Locale {
  const first = (header ?? '').split(',')[0]?.trim().slice(0, 2).toLowerCase();
  return isLocale(first) ? first : 'de';
}

const INTL: Record<Locale, string> = { de: 'de-DE', en: 'en-GB' };
export const intlLocale = (l: Locale) => INTL[l];

/** Dates and numbers in the reader's format (R2-50). */
export const fmt = {
  date: (l: Locale, iso: string | Date) => new Date(typeof iso === 'string' && iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString(intlLocale(l), { timeZone: 'Europe/Berlin' }),
  number: (l: Locale, n: number) => n.toLocaleString(intlLocale(l)),
};

// ---------------------------------------------------------------- stored AI texts (R3-22)

// AI warnings and job errors are stored as German reference text (they are read by several
// people). relocalize() finds the catalogue entry behind such a text and returns it in the
// reader's language; agent names inside it are translated as well. Unknown texts (provider
// messages, model output, tenant texts) pass through unchanged.
const RELOCALIZE_PREFIXES = ['aigw.err.', 'aigw.warn.', 'aigw.note.'];
let matchers: { key: MessageKey; re: RegExp; vars: string[] }[] | undefined;
let agentNames: Map<string, MessageKey> | undefined;

function buildMatchers() {
  matchers = [];
  agentNames = new Map();
  for (const [key, text] of Object.entries(de) as [MessageKey, string][]) {
    if (key.startsWith('aigw.agent.')) agentNames.set(text, key);
    if (!RELOCALIZE_PREFIXES.some((p) => key.startsWith(p))) continue;
    const vars: string[] = [];
    const source = text
      .split(/(\{\w+\})/)
      .map((part) => {
        const v = /^\{(\w+)\}$/.exec(part);
        if (v) {
          vars.push(v[1]);
          return '(.+?)';
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('');
    matchers.push({ key, re: new RegExp(`^${source}$`, 's'), vars });
  }
}

/** A stored German AI text in the reader's language (see above). */
export function relocalize(locale: Locale, text: string): string {
  if (locale === 'de' || !text) return text;
  if (!matchers) buildMatchers();
  const agent = agentNames!.get(text);
  if (agent) return tr(locale, m(agent));
  for (const { key, re, vars } of matchers!) {
    const hit = re.exec(text);
    if (!hit) continue;
    const values: Vars = {};
    vars.forEach((name, i) => {
      const value = hit[i + 1];
      const agent = agentNames!.get(value);
      values[name] = agent ? tr(locale, m(agent)) : relocalize(locale, value);
    });
    return tr(locale, m(key, values));
  }
  return text;
}

/** relocalize() for a list, e.g. the warnings of an AI result. */
export const relocalizeAll = (locale: Locale, texts: readonly string[] | null | undefined): string[] => (texts ?? []).map((s) => relocalize(locale, s));

/** German reference text of a catalogue entry, for texts that are stored and relocalized on reading. */
export const refText = (key: MessageKey, vars?: Vars): string => tr('de', m(key, vars));

/** relocalize() line by line; a line may start with a label such as "competition: …" (job errors). */
export function relocalizeLines(locale: Locale, text: string | null): string | null {
  if (!text || locale === 'de') return text;
  return text
    .split('\n')
    .map((line) => {
      const whole = relocalize(locale, line);
      if (whole !== line) return whole;
      const i = line.indexOf(': ');
      return i > 0 ? `${line.slice(0, i + 2)}${relocalize(locale, line.slice(i + 2))}` : line;
    })
    .join('\n');
}
