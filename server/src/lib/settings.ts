import { z } from 'zod';
import { aiSettingsSchema, defaultAiSettings } from '../ai/settings.js';
import { LOCALES } from '../i18n/index.js';

// Tenant settings (R1-04). Defaults follow the product concept; every value can be
// changed per tenant on the settings page without a restart.

// patent: patent office or IP department for possible inventions (R3-25).
const channelKind = z.enum(['whistleblowing', 'service_desk', 'complaints', 'safety', 'hr', 'project', 'patent', 'other']);

export const settingsSchema = z.object({
  timezone: z.string().min(1),
  // Language of the workspace (R3-22): default texts of new workspaces and AI results stored at ideas.
  locale: z.enum(LOCALES),
  deadlines: z.object({
    gate1Workdays: z.number().int().min(1).max(60),
    elaborationWorkdays: z.number().int().min(1).max(120),
    reminderWorkdaysBefore: z.number().int().min(0).max(10),
    questionTimeoutWorkdays: z.number().int().min(1).max(60),
    maxQuestionRounds: z.number().int().min(1).max(5),
    maxParkMonths: z.number().int().min(1).max(24),
  }),
  thresholds: z.object({
    fastLaneMaxPersonDays: z.number().min(0),
    fastLaneMaxEuro: z.number().min(0),
    delegationMaxPersonDays: z.number().min(0),
    delegationMaxEuro: z.number().min(0),
  }),
  topics: z.array(z.string().min(1).max(80)).min(1).max(50),
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(500),
  targetChannels: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        name: z.string().min(1).max(120),
        kind: channelKind,
        contact: z.string().max(200),
        url: z.string().max(500),
      }),
    )
    .max(30),
  boundaryRules: z
    .array(
      z.object({
        category: z.string().min(1).max(40),
        label: z.string().min(1).max(120),
        channelKind,
        keywords: z.array(z.string().min(2).max(60)).min(1).max(60),
      }),
    )
    .max(20),
  texts: z.object({
    fast_lane: z.string().max(2000),
    elaborate: z.string().max(2000),
    forward: z.string().max(2000),
    reject: z.string().max(2000),
    privacyNotice: z.string().max(10000),
    faq: z.array(z.object({ q: z.string().max(300), a: z.string().max(3000) })).max(50),
  }),
  minGroupSize: z.number().int().min(5).max(50),
  requireMfaForAdmins: z.boolean(),
  // Login hardening (enterprise security): minimum password length for own accounts (at least
  // 10) and the idle timeout of sessions in minutes (0 = off, else 5 to 1440).
  security: z.object({
    passwordMinLength: z.number().int().min(10).max(128),
    sessionIdleMinutes: z.number().int().min(0).max(1440).refine((v) => v === 0 || v >= 5, 'security.idleMin'),
  }).default({ passwordMinLength: 10, sessionIdleMinutes: 0 }),
  // Visible response guarantee (R1-46): first response within n working days, quota of the last
  // 90 days on the start page, one notice to the idea management when it drops below the threshold.
  guarantee: z.object({
    enabled: z.boolean(),
    workdays: z.number().int().min(1).max(60),
    alertBelowPercent: z.number().min(0).max(100),
  }),
  // Challenges (R2-51): crowd rating of challenge ideas by fixed criteria, switchable per tenant.
  // Conversion factors for the sustainability challenge (R3-32): kWh saved → kg CO₂ and euro.
  challenges: z.object({
    crowdRating: z.boolean(),
    kgCo2PerKwh: z.number().min(0).max(10).default(0.38),
    eurPerKwh: z.number().min(0).max(10).default(0.25),
  }),
  // Gamification per challenge (R2-53): points per action; switched per challenge by the admin.
  gamification: z.object({
    pointsSubmit: z.number().int().min(0).max(100),
    pointsComment: z.number().int().min(0).max(100),
    pointsRating: z.number().int().min(0).max(100),
  }),
  // Public benchmark (R3-40): the workspace contributes anonymised figures only with consent.
  benchmark: z.object({ share: z.boolean() }),
  // External participation (R3-19, R3-21): customers and partners per challenge; moderation
  // default ('pre' = release before publication) and the maximum number of links per post.
  external: z.object({
    enabled: z.boolean(),
    moderation: z.enum(['pre', 'post']),
    maxLinks: z.number().int().min(0).max(20),
  }),
  // Feature requests with voting and a public status page (R3-20); module for product teams.
  featureRequests: z.object({ enabled: z.boolean(), publicPage: z.boolean() }),
  // Elaboration, committee and impact review (R2-01, R2-02, R2-04, R2-06, R2-07).
  elaboration: z.object({
    timeboxWeeks: z.number().int().min(1).max(26),
    mentorWarnActive: z.number().int().min(1).max(50),
    lockMinutes: z.number().int().min(1).max(240),
    meetingMaxIdeas: z.number().int().min(1).max(10),
    meetingPackWorkdays: z.number().int().min(0).max(20),
    experimentReminderWorkdays: z.number().int().min(0).max(20),
    impactReviewMonths: z.number().int().min(1).max(24),
  }),
  // Weighted scorecard at Gate 2 (R2-03); weights are percentages and must add up to 100.
  scorecard: z.object({
    criteria: z
      .array(
        z.object({
          id: z.string().regex(/^[a-z0-9_]{1,40}$/),
          label: z.string().min(1).max(80),
          question: z.string().max(300),
          weight: z.number().min(0).max(100),
          anchors: z.object({ 1: z.string().max(300), 3: z.string().max(300), 5: z.string().max(300) }),
        }),
      )
      .min(1)
      .max(12)
      .refine((c) => Math.abs(c.reduce((sum, x) => sum + x.weight, 0) - 100) < 0.01, 'admin.weightsSum'), // catalogue key, resolved by the error handler
  }),
  // Recognize (AP-27): weekly trend hints for sponsors (R4-02, weekday 1 = Monday … 7 = Sunday,
  // web queries per topic field), white spots over the last n months (R4-03) and the problem
  // radar (R4-01): minimum cluster size, at most this many tickets per run, tickets of the last n days.
  radar: z.object({
    trendHints: z.boolean(),
    weekday: z.number().int().min(1).max(7),
    queriesPerTopic: z.number().int().min(1).max(5),
    whiteSpotMonths: z.number().int().min(1).max(60),
    minClusterSize: z.number().int().min(2).max(50),
    maxTickets: z.number().int().min(10).max(1000),
    ticketDays: z.number().int().min(1).max(365),
  }).default({ trendHints: true, weekday: 1, queriesPerTopic: 2, whiteSpotMonths: 12, minClusterSize: 3, maxTickets: 200, ticketDays: 90 }),
  ai: aiSettingsSchema,
  // Throughput times before the pilot in calendar days, shown as a line in the dashboard (R2-41).
  baselines: z.object({
    submission: z.number().min(0).max(3650).nullable(),
    gate1: z.number().min(0).max(3650).nullable(),
    gate2: z.number().min(0).max(3650).nullable(),
    implementation: z.number().min(0).max(3650).nullable(),
    gate3: z.number().min(0).max(3650).nullable(),
    note: z.string().max(300),
  }),
  retention: z.object({
    // Rejected, forwarded, merged and unanswered ideas are deleted after this many months (0 = never).
    closedIdeasMonths: z.number().int().min(0).max(120),
    notificationsMonths: z.number().int().min(1).max(60),
    // Deactivated accounts are anonymized after this many days.
    anonymizeDeactivatedAfterDays: z.number().int().min(0).max(3650),
    // AI action log and AI results (R2-10).
    aiActionsMonths: z.number().int().min(1).max(120),
  }),
  // Co-determination (R3-12): values the model works agreement and the pilot toleration
  // agreement are filled with. Empty texts stay placeholders in square brackets.
  // Invention disclosure check at triage (R3-25): claim period noted when an idea is forwarded to
  // a patent channel (German employee inventions act: 4 months after a proper disclosure).
  invention: z.object({
    enabled: z.boolean(),
    claimMonths: z.number().int().min(1).max(12),
  }).default({ enabled: true, claimMonths: 4 }),
  // Learning from closed ideas (R4-04, R4-06, R4-07): thresholds can only be raised above the
  // minimums of the stories (5 references, 20 closed ideas).
  learning: z.object({
    effortMinReferences: z.number().int().min(5).max(50),
    calibrationMinClosed: z.number().int().min(20).max(1000),
    // A forecast counts as a hit when the actual benefit is within this many percent of it.
    hitTolerancePercent: z.number().min(5).max(100),
    // Default days between two automatic after-measurements of a metric.
    measureEveryDays: z.number().int().min(1).max(365),
  }).default({ effortMinReferences: 5, calibrationMinClosed: 20, hitTolerancePercent: 20, measureEveryDays: 30 }),
  codetermination: z.object({
    employer: z.string().max(200),
    worksCouncil: z.string().max(200),
    scope: z.string().max(300),
    objectionBody: z.string().max(200),
    objectionWeeks: z.number().int().min(1).max(12),
    announceWeeks: z.number().int().min(0).max(26),
    pilotArea: z.string().max(300),
    pilotMonths: z.number().int().min(1).max(12),
  }),
});

export type Settings = z.infer<typeof settingsSchema>;

export const defaultSettings: Settings = {
  timezone: 'Europe/Berlin',
  locale: 'de',
  deadlines: {
    gate1Workdays: 10,
    elaborationWorkdays: 30,
    reminderWorkdaysBefore: 2,
    questionTimeoutWorkdays: 15,
    maxQuestionRounds: 2,
    maxParkMonths: 6,
  },
  thresholds: {
    fastLaneMaxPersonDays: 5,
    fastLaneMaxEuro: 5000,
    delegationMaxPersonDays: 25,
    delegationMaxEuro: 25000,
  },
  topics: ['Prozesse und Effizienz', 'Produkte und Services', 'Kundenerlebnis', 'Nachhaltigkeit', 'Arbeitsumfeld'],
  // Nationwide public holidays in Germany 2026 and 2027; regional holidays are added per tenant.
  holidays: [
    '2026-01-01', '2026-04-03', '2026-04-06', '2026-05-01', '2026-05-14', '2026-05-25', '2026-10-03', '2026-12-25', '2026-12-26',
    '2027-01-01', '2027-03-26', '2027-03-29', '2027-05-01', '2027-05-06', '2027-05-17', '2027-10-03', '2027-12-25', '2027-12-26',
  ],
  targetChannels: [],
  boundaryRules: [
    {
      category: 'report',
      label: 'Hinweis auf einen Rechtsverstoß oder Fehlverhalten',
      channelKind: 'whistleblowing',
      keywords: ['verstoß', 'verstoss', 'belästigung', 'belaestigung', 'korruption', 'bestechung', 'betrug', 'diskriminierung', 'mobbing', 'compliance-verstoß'],
    },
    {
      category: 'incident',
      label: 'IT-Störung oder Service-Anfrage',
      channelKind: 'service_desk',
      keywords: ['störung', 'stoerung', 'ausfall', 'funktioniert nicht', 'passwort zurücksetzen', 'ticket'],
    },
    {
      category: 'complaint',
      label: 'Beschwerde',
      channelKind: 'complaints',
      keywords: ['beschwerde', 'reklamation'],
    },
    {
      category: 'safety',
      label: 'Arbeitsschutz, Unfall oder Beinahe-Unfall',
      channelKind: 'safety',
      keywords: ['unfall', 'beinahe-unfall', 'verletzung', 'arbeitsschutz'],
    },
  ],
  texts: {
    fast_lane:
      'Danke für deine Idee! Sie ist klein genug, um direkt umgesetzt zu werden. Der Fachbereich übernimmt die Umsetzung, und du wirst über den Fortschritt informiert.',
    elaborate:
      'Danke für deine Idee! Sie hat Potenzial und wird jetzt ausgearbeitet. Anschließend wird an Gate 2 über die Umsetzung entschieden.',
    forward:
      'Danke für dein Anliegen! Es wird an anderer Stelle bearbeitet. Unten findest du, wohin es weitergeleitet wurde und wer dein Ansprechpartner ist.',
    reject:
      'Danke für deine Idee! Wir setzen sie nicht um. Die Begründung findest du unten. Gerne erklären wir dir die Entscheidung auch im Gespräch.',
    privacyNotice:
      'Das Ideenportal speichert deine Ideen, Kommentare und Bewertungen sowie Name, E-Mail-Adresse und Organisationseinheit. Auswertungen erfolgen nur zusammengefasst und erst ab 5 Personen. Es gibt keine personenbezogenen Leistungsauswertungen.',
    faq: [
      {
        q: 'Ist das Ideenportal eine Meldestelle für Hinweise auf Rechtsverstöße?',
        a: 'Nein. Das Ideenportal ist kein Meldekanal nach dem Hinweisgeberschutzgesetz. „Anonym“ heißt hier nur: anonym gegenüber der Community. Hinweise auf Verstöße gibst du bitte über die interne Meldestelle ab.',
      },
      {
        q: 'Wie schnell bekomme ich eine Antwort?',
        a: 'Jede Idee bekommt innerhalb der eingestellten Frist (standardmäßig 10 Arbeitstage) eine Richtung: Schnellspur, Ausarbeiten, Weiterleiten oder Ablehnen mit Begründung.',
      },
      {
        q: 'Wer sieht eine vertrauliche Idee?',
        a: 'Nur du, das Triage-Team und die für die Umsetzung verantwortliche Person.',
      },
    ],
  },
  minGroupSize: 5,
  requireMfaForAdmins: true,
  security: { passwordMinLength: 10, sessionIdleMinutes: 0 },
  guarantee: { enabled: true, workdays: 10, alertBelowPercent: 90 },
  // Estimates to adjust per workspace: German electricity mix and an average price per kWh.
  challenges: { crowdRating: true, kgCo2PerKwh: 0.38, eurPerKwh: 0.25 },
  gamification: { pointsSubmit: 10, pointsComment: 2, pointsRating: 1 },
  benchmark: { share: false },
  external: { enabled: false, moderation: 'pre', maxLinks: 2 },
  featureRequests: { enabled: false, publicPage: true },
  elaboration: {
    timeboxWeeks: 6,
    mentorWarnActive: 2,
    lockMinutes: 30,
    meetingMaxIdeas: 5,
    meetingPackWorkdays: 5,
    experimentReminderWorkdays: 2,
    impactReviewMonths: 3,
  },
  scorecard: {
    criteria: [
      {
        id: 'strategic_fit', label: 'Strategischer Fit', weight: 25,
        question: 'Zahlt die Idee auf Unternehmensziele oder ein Themenfeld ein?',
        anchors: { 1: 'Kein Bezug zu Zielen oder Themenfeldern.', 3: 'Passt zu einem Themenfeld, aber nicht zu den Jahreszielen.', 5: 'Zahlt direkt auf ein Jahresziel ein.' },
      },
      {
        id: 'user_value', label: 'Kunden- und Mitarbeiternutzen', weight: 25,
        question: 'Spürbare Verbesserung für wen, wie viele, wie oft?',
        anchors: { 1: 'Wenige Personen, selten betroffen.', 3: 'Ein Bereich profitiert regelmäßig.', 5: 'Viele Kundinnen, Kunden oder Mitarbeitende profitieren täglich.' },
      },
      {
        id: 'economic_value', label: 'Wirtschaftlicher Nutzen', weight: 20,
        question: 'Einsparung, Umsatz, vermiedene Risiken oder Kosten?',
        anchors: { 1: 'Kein messbarer Nutzen.', 3: 'Nutzen im fünfstelligen Bereich pro Jahr.', 5: 'Nutzen im sechsstelligen Bereich pro Jahr oder mehr.' },
      },
      {
        id: 'feasibility', label: 'Umsetzbarkeit', weight: 15,
        question: 'Aufwand, Know-how, Abhängigkeiten (5 = einfach).',
        anchors: { 1: 'Großes Vorhaben mit vielen Abhängigkeiten.', 3: 'Machbar mit einem Projekt über einige Monate.', 5: 'Mit vorhandenen Mitteln in wenigen Wochen umsetzbar.' },
      },
      {
        id: 'risk', label: 'Risiko', weight: 15,
        question: 'Rechtliche, technische und organisatorische Risiken (5 = gering).',
        anchors: { 1: 'Hohe Risiken, Fachstellen müssen intensiv prüfen.', 3: 'Bekannte, beherrschbare Risiken.', 5: 'Kaum Risiken.' },
      },
    ],
  },
  radar: { trendHints: true, weekday: 1, queriesPerTopic: 2, whiteSpotMonths: 12, minClusterSize: 3, maxTickets: 200, ticketDays: 90 },
  ai: defaultAiSettings,
  baselines: { submission: null, gate1: null, gate2: null, implementation: null, gate3: null, note: '' },
  retention: {
    closedIdeasMonths: 24,
    notificationsMonths: 12,
    anonymizeDeactivatedAfterDays: 30,
    aiActionsMonths: 24,
  },
  invention: { enabled: true, claimMonths: 4 },
  learning: { effortMinReferences: 5, calibrationMinClosed: 20, hitTolerancePercent: 20, measureEveryDays: 30 },
  codetermination: {
    employer: '',
    worksCouncil: '',
    scope: '',
    objectionBody: '',
    objectionWeeks: 2,
    announceWeeks: 4,
    pilotArea: '',
    pilotMonths: 6,
  },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) out[k] = deepMerge(base[k], v);
  return out;
}

/** Stored settings are partial; missing values fall back to the defaults. */
export function resolveSettings(stored: unknown): Settings {
  const merged = deepMerge(defaultSettings, stored ?? {});
  const parsed = settingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : defaultSettings;
}

export function holidaySet(s: Settings): Set<string> {
  return new Set(s.holidays);
}
