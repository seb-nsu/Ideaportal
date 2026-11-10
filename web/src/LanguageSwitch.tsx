import { LOCALES, LOCALE_INFO, getLocale, setLocale, t } from './i18n';

// Language switch for visitors without an account (R3-22): landing page, login, sign-up, join.
// The choice is kept in the browser (localStorage); after sign-in the person's language wins.

// Every interface language from the catalogue (web/src/i18n/index.ts, LOCALES).
const LANGUAGES = LOCALES.map((value) => ({ value, short: value.toUpperCase(), name: LOCALE_INFO[value].name }));

export function LanguageSwitch() {
  const current = getLocale();
  return (
    <nav className="lang-switch" aria-label={t('publicPages.language.label')}>
      {LANGUAGES.map((l, i) => (
        <span key={l.value}>
          {i > 0 && <span aria-hidden="true"> | </span>}
          <button
            type="button"
            className="link"
            lang={l.value}
            aria-pressed={current === l.value}
            title={l.name}
            onClick={() => setLocale(l.value)}
          >
            {l.short}
          </button>
        </span>
      ))}
    </nav>
  );
}
