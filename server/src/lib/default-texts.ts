import { m, tr, type Locale, type MessageKey } from '../i18n/index.js';
import { defaultSettings, type Settings } from './settings.js';

// Default texts of a new workspace in the language of the person who creates it (R3-22).
// German workspaces keep the defaults of lib/settings.ts; existing tenant texts are never touched.

const k = (key: string) => key as MessageKey;

/** Settings to store for a new workspace; only the language-dependent parts. */
export function localizedDefaults(locale: Locale): Partial<Settings> {
  if (locale === 'de') return { locale };
  const t = (key: string) => tr(locale, m(k(key)));
  const d = defaultSettings;
  return {
    locale,
    topics: d.topics.map((_, i) => t(`defaults.topic.${i + 1}`)),
    texts: {
      fast_lane: t('defaults.text.fast_lane'),
      elaborate: t('defaults.text.elaborate'),
      forward: t('defaults.text.forward'),
      reject: t('defaults.text.reject'),
      privacyNotice: t('defaults.text.privacyNotice'),
      faq: d.texts.faq.map((_, i) => ({ q: t(`defaults.faq.${i + 1}.q`), a: t(`defaults.faq.${i + 1}.a`) })),
    },
    // German keywords stay: people often write in both languages; the detection must not get weaker.
    boundaryRules: d.boundaryRules.map((r) => {
      const extra = t(`defaults.boundary.${r.category}.keywords`).split(',').map((w) => w.trim()).filter((w) => w.length >= 2);
      return { ...r, label: t(`defaults.boundary.${r.category}.label`), keywords: [...new Set([...r.keywords, ...extra])].slice(0, 60) };
    }),
    // Only the tone of the AI texts; the other AI settings keep their defaults (deep merge on load).
    ai: { tone: t('aigw.defaultTone') } as Settings['ai'],
    scorecard: {
      criteria: d.scorecard.criteria.map((c) => ({
        ...c,
        label: t(`defaults.scorecard.${c.id}.label`),
        question: t(`defaults.scorecard.${c.id}.question`),
        anchors: { 1: t(`defaults.scorecard.${c.id}.a1`), 3: t(`defaults.scorecard.${c.id}.a3`), 5: t(`defaults.scorecard.${c.id}.a5`) },
      })),
    },
  };
}
