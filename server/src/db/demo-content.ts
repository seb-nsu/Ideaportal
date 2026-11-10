import type { Role } from '../lib/context.js';
import type { Locale } from '../i18n/index.js';

// Example data of the demo and example workspaces in each interface language (R3-22). The
// German set is the reference; the English set tells the same story for the English demo.
// Topics match the default topic fields of a workspace in that language.

/** Demo workspace per interface language (R3-22): slug, name and mail domain. */
export const DEMO_WORKSPACES: Record<Locale, { slug: string; name: string; domain: string }> = {
  de: { slug: 'demo', name: 'Demo AG', domain: 'demo.example' },
  en: { slug: 'demo-en', name: 'Demo Ltd', domain: 'demo-en.example' },
};

/** Whether a slug belongs to one of the demo workspaces. */
export const isDemoSlug = (slug: string | null | undefined): boolean => Object.values(DEMO_WORKSPACES).some((w) => w.slug === slug);

/** Demo account per role, by its local part in DEMO_CONTENT. */
export function demoAccount(locale: Locale, role: string): string | null {
  const p = DEMO_CONTENT[locale].people.find((x) => x.key === role);
  return p ? `${p.local}@${DEMO_WORKSPACES[locale].domain}` : null;
}

export interface DemoPerson {
  key: string;
  local: string;
  name: string;
  orgUnit: string;
  roles: Role[];
}

export interface DemoIdeaText {
  title: string;
  problem: string;
  solution: string;
  benefit: string;
  topic: string;
}

export interface DemoContent {
  people: DemoPerson[];
  channels: { id: string; name: string; kind: string; local: string; withUrl: boolean }[];
  challenge: { title: string; question: string; topic: string; fields: { id: string; label: string; type: 'select' | 'number'; options: string[] }[] };
  holiday: DemoIdeaText;
  portal: DemoIdeaText & {
    triageReason: string;
    dossier: { summary: string; benefit: string; benefitOpen: string; effort: string; risks: string };
    meeting: string;
  };
  light: DemoIdeaText & { triageReason: string; orgUnit: string; evidence: string; storyTitle: string; storyBody: string };
}

const roles = {
  admin: ['submitter', 'admin', 'triage'],
  triage: ['submitter', 'triage'],
  committee: ['submitter', 'committee'],
  owner: ['submitter', 'implementer'],
  mentor: ['submitter', 'mentor'],
  lead: ['submitter', 'lead'],
  submitter: ['submitter'],
} satisfies Record<string, Role[]>;

export const DEMO_CONTENT: Record<Locale, DemoContent> = {
  de: {
    people: [
      { key: 'admin', local: 'admin', name: 'Alex Admin', orgUnit: 'Innovation', roles: roles.admin },
      { key: 'triage', local: 'triage', name: 'Toni Triage', orgUnit: 'Innovation', roles: roles.triage },
      { key: 'committee', local: 'gremium', name: 'Gerd Gremium', orgUnit: 'Geschäftsleitung', roles: roles.committee },
      { key: 'owner', local: 'umsetzung', name: 'Uli Umsetzung', orgUnit: 'Produktion', roles: roles.owner },
      { key: 'mentor', local: 'pate', name: 'Pat Pate', orgUnit: 'Produktmanagement', roles: roles.mentor },
      { key: 'lead', local: 'bereichsleitung', name: 'Lea Leitung', orgUnit: 'Vertrieb', roles: roles.lead },
      { key: 'submitter', local: 'mitarbeit', name: 'Mika Muster', orgUnit: 'Vertrieb', roles: roles.submitter },
    ],
    channels: [
      { id: 'meldestelle', name: 'Interne Meldestelle (HinSchG)', kind: 'whistleblowing', local: 'meldestelle', withUrl: true },
      { id: 'servicedesk', name: 'IT-Service-Desk', kind: 'service_desk', local: 'servicedesk', withUrl: true },
      { id: 'beschwerden', name: 'Beschwerdemanagement', kind: 'complaints', local: 'beschwerden', withUrl: false },
      { id: 'arbeitsschutz', name: 'Arbeitssicherheit', kind: 'safety', local: 'arbeitsschutz', withUrl: false },
      { id: 'personal', name: 'Personalabteilung', kind: 'hr', local: 'personal', withUrl: false },
      { id: 'patente', name: 'Patentstelle', kind: 'patent', local: 'patente', withUrl: false },
    ],
    challenge: {
      title: 'Weniger Papier im Alltag',
      question: 'Wo verbrauchen wir heute unnötig Papier, und wie könnten wir darauf verzichten?',
      topic: 'Nachhaltigkeit',
      fields: [
        { id: 'standort', label: 'Standort', type: 'select', options: ['Zentrale', 'Werk', 'Lager'] },
        { id: 'blatt_pro_monat', label: 'Geschätzte Blätter pro Monat', type: 'number', options: [] },
      ],
    },
    holiday: {
      title: 'Digitale Urlaubsanträge statt Papierformular',
      problem: 'Urlaubsanträge werden ausgedruckt, unterschrieben und eingescannt. Das kostet Zeit und Papier.',
      solution: 'Ein einfacher digitaler Antrag mit Freigabe durch die Führungskraft per Klick.',
      benefit: 'Rund 10 Minuten pro Antrag weniger Aufwand und kein Papier mehr.',
      topic: 'Nachhaltigkeit',
    },
    portal: {
      title: 'Selbstservice-Portal für Ersatzteilbestellungen',
      problem: 'Kundinnen und Kunden rufen für jede Ersatzteilbestellung an; der Innendienst ist zu Stoßzeiten überlastet.',
      solution: 'Ein Portal, in dem Kunden Ersatzteile anhand der Seriennummer finden und direkt bestellen.',
      benefit: 'Weniger Anrufe, schnellere Lieferung, zusätzlicher Umsatz durch Empfehlungen passender Teile.',
      topic: 'Produkte und Services',
      triageReason: 'Bereichsübergreifend mit erkennbarem Marktpotenzial.',
      dossier: {
        summary: 'Ein Selbstservice-Portal für Ersatzteile entlastet den Innendienst und erschließt Zusatzumsatz.',
        benefit: 'Etwa 30 % weniger Anrufe im Innendienst (Schätzung) und Zusatzumsatz durch passende Empfehlungen.',
        benefitOpen: 'Anrufzahlen aus der Telefonanlage bestätigen',
        effort: 'Rund 60 Personentage für Portal, Anbindung an das ERP-System und Pflege der Teiledaten (Schätzung).',
        risks: 'Datenqualität der Seriennummern; Abstimmung mit dem Vertrieb zu Preisen.',
      },
      meeting: 'Innovationsgremium',
    },
    light: {
      title: 'Bewegungsmelder für das Licht im Lager',
      problem: 'Im Lager brennt das Licht den ganzen Tag, auch wenn niemand dort ist.',
      solution: 'Bewegungsmelder in den Gängen installieren, damit das Licht nur bei Bedarf brennt.',
      benefit: 'Geringerer Stromverbrauch und niedrigere Kosten.',
      topic: 'Nachhaltigkeit',
      triageReason: 'Geringer Aufwand im Verantwortungsbereich der Haustechnik.',
      orgUnit: 'Produktion',
      evidence: 'Stromzähler Lager: Verbrauch nach drei Monaten um 38 % gesunken.',
      storyTitle: 'Licht nur, wenn es gebraucht wird',
      storyBody:
        'Mika Muster hat bemerkt, dass im Lager den ganzen Tag das Licht brennt. Mit Bewegungsmeldern spart das Lager jetzt rund 3.200 Euro Strom im Jahr.',
    },
  },
  en: {
    people: [
      { key: 'admin', local: 'admin', name: 'Alex Admin', orgUnit: 'Innovation', roles: roles.admin },
      { key: 'triage', local: 'triage', name: 'Toni Triage', orgUnit: 'Innovation', roles: roles.triage },
      { key: 'committee', local: 'committee', name: 'Cora Committee', orgUnit: 'Management board', roles: roles.committee },
      { key: 'owner', local: 'implementation', name: 'Ira Implementer', orgUnit: 'Production', roles: roles.owner },
      { key: 'mentor', local: 'mentor', name: 'Max Mentor', orgUnit: 'Product management', roles: roles.mentor },
      { key: 'lead', local: 'lead', name: 'Lee Lead', orgUnit: 'Sales', roles: roles.lead },
      { key: 'submitter', local: 'staff', name: 'Sam Sample', orgUnit: 'Sales', roles: roles.submitter },
    ],
    channels: [
      { id: 'reporting', name: 'Internal reporting office (whistleblowing)', kind: 'whistleblowing', local: 'reporting', withUrl: true },
      { id: 'servicedesk', name: 'IT service desk', kind: 'service_desk', local: 'servicedesk', withUrl: true },
      { id: 'complaints', name: 'Complaints management', kind: 'complaints', local: 'complaints', withUrl: false },
      { id: 'safety', name: 'Occupational safety', kind: 'safety', local: 'safety', withUrl: false },
      { id: 'hr', name: 'Human resources', kind: 'hr', local: 'hr', withUrl: false },
      { id: 'patents', name: 'Patent office', kind: 'patent', local: 'patents', withUrl: false },
    ],
    challenge: {
      title: 'Less paper in everyday work',
      question: 'Where do we use paper today without need, and how could we do without it?',
      topic: 'Sustainability',
      fields: [
        { id: 'site', label: 'Site', type: 'select', options: ['Head office', 'Plant', 'Warehouse'] },
        { id: 'sheets_per_month', label: 'Estimated sheets per month', type: 'number', options: [] },
      ],
    },
    holiday: {
      title: 'Digital leave requests instead of a paper form',
      problem: 'Leave requests are printed, signed and scanned. That costs time and paper.',
      solution: 'A simple digital request that the line manager approves with one click.',
      benefit: 'About 10 minutes less effort per request and no more paper.',
      topic: 'Sustainability',
    },
    portal: {
      title: 'Self-service portal for spare part orders',
      problem: 'Customers call for every spare part order; the sales office is overloaded at peak times.',
      solution: 'A portal where customers find spare parts by serial number and order them directly.',
      benefit: 'Fewer calls, faster delivery, additional revenue from recommending matching parts.',
      topic: 'Products and services',
      triageReason: 'Cross-departmental with visible market potential.',
      dossier: {
        summary: 'A self-service portal for spare parts relieves the sales office and opens up additional revenue.',
        benefit: 'About 30 % fewer calls in the sales office (estimate) and additional revenue from matching recommendations.',
        benefitOpen: 'Confirm call numbers from the phone system',
        effort: 'About 60 person-days for the portal, the connection to the ERP system and maintaining the parts data (estimate).',
        risks: 'Data quality of the serial numbers; alignment with sales on prices.',
      },
      meeting: 'Innovation board',
    },
    light: {
      title: 'Motion sensors for the warehouse lights',
      problem: 'The warehouse lights are on all day, even when nobody is there.',
      solution: 'Install motion sensors in the aisles so the lights are only on when needed.',
      benefit: 'Lower power consumption and lower costs.',
      topic: 'Sustainability',
      triageReason: 'Small effort within the remit of facility management.',
      orgUnit: 'Production',
      evidence: 'Warehouse power meter: consumption down 38 % after three months.',
      storyTitle: 'Light only when it is needed',
      storyBody:
        'Sam Sample noticed that the warehouse lights were on all day. With motion sensors, the warehouse now saves about 3,200 euros of electricity a year.',
    },
  },
};
