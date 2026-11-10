import { describe, expect, it, vi } from 'vitest';
import { de } from '../src/i18n/de';
import { en } from '../src/i18n/en';
import { formatDate, formatEuro, formatNumber, getLocale, labelMap, onLocaleChange, setLocale, t, tn, type MessageKey } from '../src/i18n';

// Text catalogue (R2-50, R3-22): German is the reference, English falls back key by key.

describe('t()', () => {
  it('returns the German text by default and the English one after switching', () => {
    expect(t('login.title')).toBe(de['login.title']);
    setLocale('en');
    expect(getLocale()).toBe('en');
    expect(t('login.title')).toBe(en['login.title']);
    expect(t('login.title')).not.toBe(de['login.title']);
  });

  it('falls back to German when the English text is missing, and to the key when both are missing', () => {
    const key = Object.keys(de).find((k) => !(k in en)) as MessageKey | undefined;
    setLocale('en');
    if (key) expect(t(key)).toBe(de[key]);
    expect(t('does.not.exist' as MessageKey)).toBe('does.not.exist');
  });

  it('replaces variables and keeps placeholders without a value', () => {
    expect(t('components.deadline.paused', { n: 3 })).toBe(de['components.deadline.paused'].replace('{n}', '3'));
    expect(t('components.deadline.paused')).toContain('{n}');
    expect(t('components.deadline.paused', { n: null })).toContain('{n}');
  });

  it('every English key exists in German (no orphaned translations)', () => {
    const orphans = Object.keys(en).filter((k) => !(k in de));
    expect(orphans).toEqual([]);
  });
});

describe('plural, label maps and formatting', () => {
  it('tn() picks the singular or plural form with a formatted number', () => {
    expect(tn('components.deadline.overdue', 1)).toBe(de['components.deadline.overdue.one'].replace('{n}', '1'));
    expect(tn('components.deadline.overdue', 1200)).toBe(de['components.deadline.overdue.other'].replace('{n}', '1.200'));
  });

  it('labelMap() follows the current language', () => {
    const map = labelMap('labels.light', ['green', 'red'] as const);
    const german = map.green;
    setLocale('en');
    expect(map.green).toBe(t('labels.light.green' as MessageKey));
    expect(Object.keys(map)).toEqual(['green', 'red']);
    expect(typeof german).toBe('string');
  });

  it('formats dates, numbers and euro amounts per language, with a dash for empty values', () => {
    expect(formatDate('2026-10-13')).toBe('13.10.2026');
    expect(formatDate(null)).toBe('–');
    expect(formatNumber(1234.5, 1)).toBe('1.234,5');
    expect(formatNumber(undefined)).toBe('–');
    expect(formatEuro(1500).replace(/\s/g, ' ')).toBe('1.500 €');
    expect(formatEuro(null)).toBe('–');
    setLocale('en');
    expect(formatDate('2026-10-13')).toBe('13/10/2026');
    expect(formatNumber(1234.5, 1)).toBe('1,234.5');
  });

  it('notifies listeners on a language change, sets the document language and stores the choice', () => {
    const listener = vi.fn();
    const off = onLocaleChange(listener);
    setLocale('en');
    expect(listener).toHaveBeenCalledWith('en');
    expect(document.documentElement.lang).toBe('en');
    expect(localStorage.getItem('locale')).toBe('en');
    off();
    setLocale('de');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
