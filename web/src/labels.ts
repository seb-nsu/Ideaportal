import { formatDate, formatDateTime, formatNumber as i18nFormatNumber, formatEuro as i18nFormatEuro, getLocale, labelMap, t } from './i18n';

export { formatDate, formatDateTime };

export const STATUS = labelMap('labels.status', [
  'draft', 'submitted', 'in_question', 'fast_lane', 'elaboration', 'forwarded', 'rejected', 'implementing',
  'piloting', 'integrated', 'parked', 'completed', 'closed_no_answer', 'merged',
] as const);

export const STATUS_SHORT = labelMap('labels.statusShort', [
  'draft', 'submitted', 'in_question', 'fast_lane', 'elaboration', 'forwarded', 'rejected', 'implementing',
  'piloting', 'integrated', 'parked', 'completed', 'closed_no_answer', 'merged',
] as const);

/** Steps of the status bar (R1-16); `plain` avoids process terms for people without a process role. */
export const STEPS = [
  { key: 'submit', get label() { return t('labels.step.submit'); }, get plain() { return t('labels.stepPlain.submit'); }, statuses: ['submitted', 'in_question'] },
  { key: 'gate1', get label() { return t('labels.step.gate1'); }, get plain() { return t('labels.stepPlain.gate1'); }, statuses: ['fast_lane', 'elaboration', 'forwarded', 'rejected', 'closed_no_answer', 'merged'] },
  { key: 'gate2', get label() { return t('labels.step.gate2'); }, get plain() { return t('labels.stepPlain.gate2'); }, statuses: ['implementing', 'piloting', 'integrated', 'parked'] },
  { key: 'done', get label() { return t('labels.step.done'); }, get plain() { return t('labels.stepPlain.done'); }, statuses: ['completed'] },
];

export const NEXT_STEP = labelMap('labels.nextStep', [
  'draft', 'submitted', 'in_question', 'fast_lane', 'elaboration', 'forwarded', 'rejected', 'implementing',
  'piloting', 'integrated', 'parked', 'completed', 'closed_no_answer', 'merged',
] as const);

export const LANES = labelMap('labels.lane', ['fast_lane', 'elaborate', 'forward', 'reject'] as const);

export const OUTCOMES = labelMap('labels.outcome', ['implement', 'pilot', 'integrate', 'park', 'reject'] as const);

export const ROLES = labelMap('labels.role', ['submitter', 'mentor', 'triage', 'committee', 'lead', 'implementer', 'admin', 'works_council', 'controlling', 'external', 'user_admin'] as const);

export const BENEFIT = labelMap('labels.benefit', ['euro', 'hours', 'quality', 'revenue', 'co2', 'kwh'] as const);

export const CHANNELS = labelMap('labels.channel', ['line', 'project', 'backlog', 'experiment'] as const);

export const CHANNEL_KINDS = labelMap('labels.channelKind', ['whistleblowing', 'service_desk', 'complaints', 'safety', 'hr', 'project', 'patent', 'other'] as const);

export const LIGHT = labelMap('labels.light', ['green', 'yellow', 'red', 'paused'] as const);

/** Dossier sections (R2-02). */
export const SECTIONS = labelMap('labels.section', ['summary', 'benefit', 'effort', 'risks', 'affected', 'path', 'analyses'] as const);

export const HORIZON: Record<number, string> = labelMap('labels.horizon', ['1', '2', '3'] as const);

export const EXPERIMENT_OUTCOME = labelMap('labels.experimentOutcome', ['confirmed', 'refuted', 'inconclusive'] as const);

export const IMPACT_OUTCOME = labelMap('labels.impactOutcome', ['close', 'scale', 'adjust', 'stop'] as const);

export const STORY_STATUS = labelMap('labels.storyStatus', ['draft', 'pending_author', 'published', 'declined'] as const);

/** Whole euros; German keeps "1.234 €", other languages use the currency format. */
export function formatEuro(value: number | null | undefined): string {
  if (value == null) return '–';
  return getLocale() === 'de' ? `${i18nFormatNumber(value, 0)} €` : i18nFormatEuro(value, 0);
}

export function formatNumber(value: number | null | undefined): string {
  return i18nFormatNumber(value);
}

/** Parses a German or English decimal; empty input is null. */
export function parseNumber(value: string): number | null {
  const raw = value.trim().replace(/\s|€/g, '');
  // "1.234,5" (German) or "1234.5"; a comma always marks the decimals.
  const norm = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw;
  if (!norm) return null;
  const n = Number(norm);
  return Number.isFinite(n) ? n : NaN;
}
