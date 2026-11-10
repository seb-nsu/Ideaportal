import { de } from './de';
import { en } from './en';

// Text catalogue for the interface (R2-50). Every visible text comes from here; German is the
// reference, English (R3-22) falls back to German key by key. New texts go only into the
// catalogue (check: `npm run check:texts`).

// Interface languages, in one place (R3-30). A new language: add a folder <code>/ with the same
// namespace files as de/ (an index.ts that spreads them), add it here to LOCALES, LOCALE_INFO and
// catalogs, and add it to the server (server/src/i18n/index.ts). Missing keys fall back to German.
export const LOCALES = ['de', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export type MessageKey = keyof typeof de;
type Vars = Record<string, string | number | null | undefined>;

/** Format locale and the language's own name (for the language switch) per interface language. */
export const LOCALE_INFO: Record<Locale, { intl: string; name: string }> = {
  de: { intl: 'de-DE', name: 'Deutsch' }, // texts-ok: language names stay in their own language
  en: { intl: 'en-GB', name: 'English' }, // texts-ok
};

const catalogs: Record<Locale, Partial<Record<MessageKey, string>>> = { de, en };
const isLocale = (v: unknown): v is Locale => typeof v === 'string' && (LOCALES as readonly string[]).includes(v);
let current: Locale = initialLocale();

function initialLocale(): Locale {
  try {
    const stored = localStorage.getItem('locale');
    if (isLocale(stored)) return stored;
  } catch {
    // storage blocked: use the browser language
  }
  const browser = typeof navigator !== 'undefined' ? navigator.language?.toLowerCase().slice(0, 2) : undefined;
  return isLocale(browser) ? browser : 'de';
}

export function getLocale(): Locale {
  return current;
}

const listeners = new Set<(l: Locale) => void>();

/** Called after every language change, e.g. to re-render the public pages (R3-22). */
export function onLocaleChange(fn: (l: Locale) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Sets the language; the app remounts so every text is read again. */
export function setLocale(l: Locale): void {
  current = l;
  listeners.forEach((fn) => fn(l));
  try {
    localStorage.setItem('locale', l);
  } catch {
    // not essential
  }
  if (typeof document !== 'undefined') document.documentElement.lang = l;
}

export function t(key: MessageKey, vars?: Vars): string {
  const s = catalogs[current][key] ?? de[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (all, k: string) => (vars[k] == null ? all : String(vars[k]))) : s;
}

/** Singular or plural: uses "<key>.one" or "<key>.other" with {n}. */
export function tn(key: string, n: number, vars?: Vars): string {
  const form = new Intl.PluralRules(intlLocale()).select(n) === 'one' ? 'one' : 'other';
  return t(`${key}.${form}` as MessageKey, { n: formatNumber(n), ...vars });
}

/** A label map whose values follow the current language (status, roles, lanes …). */
export function labelMap<K extends string>(prefix: string, keys: readonly K[]): Record<K, string> & Record<string, string> {
  const out = {} as Record<string, string>;
  for (const k of keys) Object.defineProperty(out, k, { enumerable: true, get: () => t(`${prefix}.${k}` as MessageKey) });
  return out as Record<K, string> & Record<string, string>;
}

export const intlLocale = () => LOCALE_INFO[current].intl;

export function formatDate(value: string | null | undefined): string {
  if (!value) return '–';
  const d = value.length === 10 ? new Date(`${value}T12:00:00`) : new Date(value);
  return d.toLocaleDateString(intlLocale(), { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function formatDateTime(value: string): string {
  return new Date(value).toLocaleString(intlLocale(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatNumber(value: number | null | undefined, digits?: number): string {
  return value == null ? '–' : Number(value).toLocaleString(intlLocale(), digits == null ? undefined : { maximumFractionDigits: digits });
}

export function formatEuro(value: number | null | undefined, digits = 0): string {
  if (value == null) return '–';
  return Number(value).toLocaleString(intlLocale(), { style: 'currency', currency: 'EUR', maximumFractionDigits: digits, minimumFractionDigits: digits });
}
