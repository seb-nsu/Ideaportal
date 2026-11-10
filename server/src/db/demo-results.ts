import { normalizeSections, type ModelSection, type Source } from '../ai/content.js';
import type { StoredContent } from '../ai/pipeline.js';
import type { Db } from './pool.js';
import type { Locale } from '../i18n/index.js';
import { DEMO_CONTENT } from './demo-content.js';
import { portalResultsEn, holidayResultsEn } from './demo-results-en.js';

// Pre-generated analyses for the public demo (R2-40). The demo has no real model and no
// paid search, so the two example ideas carry results that were written ahead of time in
// the style of a real model run. They are labelled as examples ("vorab erstellt") and
// contain no invented sources: figures without a source are estimates with a confidence.
// The rest of the demo uses the builtin provider, which delivers structure and questions.

const GENERATED_AT = '2026-10-12T08:00:00.000Z';
// Labels of the pre-generated results in the language of the demo workspace (R3-22).
const NOTE: Record<Locale, string> = {
  de: 'Beispielergebnis für die Demo, vorab erstellt. Es lief kein Modell und keine Websuche.',
  en: 'Example result for the demo, prepared in advance. No model and no web search ran.',
};
const MODEL: Record<Locale, string> = { de: 'vorab erstellt (Beispiel)', en: 'prepared in advance (example)' };
const SKIPPED: Record<Locale, string> = { de: 'Demo: vorab erstellte Ergebnisse', en: 'Demo: results prepared in advance' };

type Claim = ModelSection['claims'][number];
export const fact = (text: string, sources: number[]): Claim => ({ text, kind: 'fact', sources, confidence: null });
export const assume = (text: string): Claim => ({ text, kind: 'assumption', sources: [], confidence: null });
export const estimate = (text: string, confidence: 'low' | 'medium' | 'high'): Claim => ({ text, kind: 'estimate', sources: [], confidence });

export const WEB_SOURCES: Source[] = [
  { id: 1, title: 'Syncron – Service-Parts-Management für Hersteller', url: 'https://www.syncron.com/', snippet: 'Anbieter von Software für Ersatzteilplanung, Preisgestaltung und Ersatzteil-Portale von Herstellern.', origin: 'web', retrievedAt: '2026-10-12' },
  { id: 2, title: 'Partium – Ersatzteilsuche für die Industrie', url: 'https://www.partium.io/', snippet: 'Software zur Suche und Identifikation von Ersatzteilen, auch per Foto oder Seriennummer.', origin: 'web', retrievedAt: '2026-10-12' },
  { id: 3, title: 'SAP Commerce Cloud', url: 'https://www.sap.com/products/crm/commerce-cloud.html', snippet: 'B2B-Commerce-Plattform mit Anbindung an SAP-ERP; Preise auf Anfrage.', origin: 'web', retrievedAt: '2026-10-12' },
];

export function content(agent: string, data: Record<string, unknown>, sections: ModelSection[], sources: Source[] = [], locale: Locale = 'de'): StoredContent {
  return {
    agent: agent as StoredContent['agent'],
    data,
    sections: normalizeSections(sections, sources, []).value,
    sources,
    warnings: [NOTE[locale]],
    meta: { model: MODEL[locale], provider: 'demo', local: true, generatedAt: GENERATED_AT, costEur: 0 },
  };
}

function portalResults(): Record<string, StoredContent> {
  return {
    short_analysis: content('short_analysis', {
      summary: 'Kundinnen und Kunden sollen Ersatzteile über die Seriennummer selbst finden und bestellen. Das entlastet den Innendienst zu Stoßzeiten und kann Zusatzumsatz bringen.',
      completeness: { complete: false, missing: ['Anzahl der Ersatzteilanrufe pro Monat', 'Anteil der Teile mit sauberen Stammdaten'] },
    }, [
      { heading: 'Worum es geht', claims: [assume('Ersatzteilbestellungen laufen heute fast vollständig über das Telefon des Innendienstes.'), assume('Ein Portal mit Suche nach Seriennummer soll die einfachen Bestellungen übernehmen.')] },
      { heading: 'Wettbewerber und Ersatzprodukte', claims: [fact('Es gibt spezialisierte Software für Ersatzteil-Portale von Herstellern.', [1]), fact('Ersatzteilsuche per Seriennummer oder Foto wird als eigenes Produkt angeboten.', [2]), fact('Große B2B-Commerce-Plattformen bieten ERP-Anbindung; Preise nennen sie nur auf Anfrage.', [3])] },
      { heading: 'Markt und Nutzen', claims: [estimate('Bei einfachen Nachbestellungen lassen sich erfahrungsgemäß 20 bis 40 % der Anrufe in ein Portal verlagern.', 'low')] },
      { heading: 'Offene Fragen', claims: [assume('Wie viele Anrufe betreffen reine Nachbestellungen, wie viele brauchen Beratung?'), assume('Sind die Seriennummern im ERP-System den Stücklisten zugeordnet?')] },
    ], WEB_SOURCES),
    triage_suggestion: content('triage_suggestion', {
      lane: 'elaborate', topic: 'Produkte und Services', confidence: 'medium',
      reason: 'Die Idee betrifft Kundschaft, Vertrieb und IT und braucht eine Entscheidung zu Kauf oder Eigenbau. Eine Ausarbeitung mit Business Case ist sinnvoll.',
      missing: ['Anrufzahlen des Innendienstes'],
    }, []),
    competition: content('competition', {
      matrix: [
        { name: 'Syncron', kind: 'competitor', features: 'Ersatzteilplanung, Preisgestaltung, Kundenportal', price: 'auf Anfrage', priceOnRequest: true, strengths: 'Fokus auf Hersteller-Service', weaknesses: 'Großer Funktionsumfang, lange Einführung', sources: [1] },
        { name: 'Partium', kind: 'substitute', features: 'Teilesuche per Seriennummer und Foto', price: 'auf Anfrage', priceOnRequest: true, strengths: 'Schnelle Identifikation von Teilen', weaknesses: 'Bestellung und ERP-Anbindung separat zu klären', sources: [2] },
        { name: 'SAP Commerce Cloud', kind: 'substitute', features: 'B2B-Shop mit ERP-Anbindung', price: 'auf Anfrage', priceOnRequest: true, strengths: 'Passt zu einem SAP-ERP', weaknesses: 'Aufwendig für einen reinen Ersatzteilshop', sources: [3] },
      ],
    }, [
      { heading: 'Überblick', claims: [fact('Für Ersatzteil-Portale gibt es spezialisierte Anbieter.', [1]), fact('Die Teile-Identifikation wird auch als eigenständiges Produkt angeboten.', [2])] },
      { heading: 'Lücken und Chancen', claims: [assume('Eine schlanke Lösung auf Basis des vorhandenen ERP kann schneller starten als eine große Plattform.'), assume('Alle Anbieter nennen Preise nur auf Anfrage; ein Vergleich braucht Angebote.')] },
    ], WEB_SOURCES),
    positioning: content('positioning', {
      axisX: { label: 'Funktionsumfang', low: 'nur Bestellung', high: 'Service-Suite' },
      axisY: { label: 'Aufwand für die Einführung', low: 'gering', high: 'hoch' },
      items: [
        { name: 'Unsere Idee', x: 3, y: 3, isIdea: true, priceOnRequest: false },
        { name: 'Syncron', x: 8, y: 8, isIdea: false, priceOnRequest: true },
        { name: 'Partium', x: 4, y: 4, isIdea: false, priceOnRequest: true },
        { name: 'SAP Commerce Cloud', x: 7, y: 7, isIdea: false, priceOnRequest: true },
      ],
      recommendation: 'combine',
      reasoning: 'Teilesuche zukaufen, Bestellung über das vorhandene ERP abbilden. So bleibt der Aufwand klein, und die schwierigste Stelle (Teile finden) ist gelöst. Die Positionen sind Einschätzungen.',
      toClarify: [],
    }, [{ heading: 'Hinweis', claims: [assume('Die Positionen sind Einschätzungen und mit Angeboten der Anbieter zu prüfen.')] }]),
    market_size: content('market_size', {
      topDown: null,
      bottomUp: { customers: { low: 800, high: 1500 }, revenuePerCustomerEur: { low: 1200, high: 3000 }, samShare: { low: 60, high: 80 }, somShare: { low: 25, high: 40 }, sources: [] },
      toClarify: ['Für den Gesamtmarkt liegt keine belastbare Studie vor. Bitte beim Vertrieb nach Marktdaten der Branche fragen.'],
    }, [
      { heading: 'Annahmen bottom-up', claims: [estimate('800 bis 1.500 aktive Bestandskunden bestellen Ersatzteile (Annahme aus der Kundenzahl des Vertriebs, zu prüfen).', 'medium'), estimate('Ersatzteilumsatz pro Kunde und Jahr: 1.200 bis 3.000 €.', 'low')] },
      { heading: 'Was die Abweichung erklärt', claims: [assume('Top-down fehlt eine Quelle; der Vergleich beider Methoden ist deshalb offen.')] },
    ]),
    business_case: content('business_case', {
      horizonYears: 3,
      assumptions: [
        { id: 'calls', label: 'Weniger Anrufe im Innendienst', unit: '€', kind: 'benefit', low: 25000, base: 40000, high: 60000, sources: [] },
        { id: 'upsell', label: 'Zusatzumsatz (Deckungsbeitrag) durch Empfehlungen', unit: '€', kind: 'benefit', low: 10000, base: 30000, high: 60000, sources: [] },
        { id: 'build', label: 'Portal, ERP-Anbindung, Datenpflege', unit: '€', kind: 'one_off_cost', low: 35000, base: 45000, high: 70000, sources: [] },
        { id: 'run', label: 'Betrieb, Lizenzen, Pflege pro Jahr', unit: '€', kind: 'running_cost', low: 8000, base: 12000, high: 18000, sources: [] },
      ],
      toClarify: ['Anrufzahlen aus der Telefonanlage für drei Monate auswerten.', 'Angebote für Teilesuche und Shop einholen.'],
    }, [
      { heading: 'Begründung der Annahmen', claims: [estimate('Ersparnis im Innendienst: etwa 1.000 Anrufe weniger pro Jahr bei rund 40 € Vollkosten je Anruf.', 'low'), estimate('Aufwand 60 Personentage laut Steckbrief, plus Lizenzen.', 'medium')] },
    ]),
    risk_check: content('risk_check', {
      areas: [
        { area: 'privacy', light: 'yellow', finding: 'Kundenkonten und Bestellhistorie sind personenbezogen. Rollen, Löschfristen und Auftragsverarbeitung klären.', office: 'Datenschutzbeauftragte' },
        { area: 'ai_act', light: 'green', finding: 'Empfehlungen ohne automatisierte Entscheidung über Personen; kein Hochrisiko-System erkennbar.', office: 'KI-Beauftragte bzw. Compliance' },
        { area: 'security', light: 'yellow', finding: 'Öffentlich erreichbares Portal mit ERP-Anbindung: Zugriffsrechte und Schnittstelle absichern.', office: 'Informationssicherheit' },
        { area: 'legal', light: 'yellow', finding: 'Allgemeine Geschäftsbedingungen und Preise im Portal mit dem Vertrieb abstimmen.', office: 'Rechtsabteilung' },
        { area: 'patentability', light: 'green', finding: 'Keine technische Erfindung erkennbar.', office: 'Patentabteilung oder Patentanwalt' },
        { area: 'employee_invention', light: 'green', finding: 'Keine Diensterfindung erkennbar.', office: 'Personalabteilung und Patentabteilung' },
      ],
    }, []),
    experiment: content('experiment', {
      hypothesis: 'Wenn zehn Stammkunden ihre Ersatzteile über eine einfache Bestellseite nach Seriennummer bestellen können, dann sinken ihre Anrufe beim Innendienst um mindestens ein Drittel.',
      smallestTest: 'Bestellformular mit Teileliste für zehn Kunden und zwei Maschinentypen, Bestellung landet als Auftrag im Innendienst.',
      metric: 'Anrufe der Testkunden pro Woche gegenüber den vier Wochen davor',
      successCriteria: 'Mindestens 33 % weniger Anrufe und mindestens 70 % der Bestellungen ohne Rückfrage.',
      durationWeeks: 6,
    }, []),
    counterarguments: content('counterarguments', {
      counterarguments: [
        { text: 'Viele Anrufe brauchen Beratung, weil Kunden das richtige Teil nicht kennen; ein Portal hilft dort wenig.', sources: [] },
        { text: 'Ohne saubere Zuordnung von Seriennummern zu Stücklisten findet niemand das richtige Teil.', sources: [] },
        { text: 'Spezialisierte Anbieter könnten schneller und günstiger sein als eine eigene Lösung.', sources: [1] },
      ],
      premortem: 'Ein Jahr später: Das Portal ist online, aber nur wenige Kunden nutzen es, weil die Teile nicht gefunden werden. Die Datenpflege wurde unterschätzt, und der Innendienst nimmt weiter alle Anrufe an.',
      earlyWarnings: ['Weniger als die Hälfte der Testbestellungen kommt ohne Rückfrage aus.', 'Die Pflege der Teiledaten hat keinen Owner.'],
    }, [], WEB_SOURCES),
    dossier_draft: content('dossier_draft', {
      summary: 'Ein Selbstservice-Portal für Ersatzteile entlastet den Innendienst und kann Zusatzumsatz bringen. Empfohlen wird, die Teilesuche zuzukaufen und die Bestellung über das ERP abzubilden; vorher klärt ein sechswöchiges Experiment mit zehn Stammkunden den Nutzen.',
      parts: [
        { section: 'benefit', content: 'Weniger Anrufe im Innendienst und Zusatzumsatz; beides Schätzungen, siehe Business Case.', status: 'filled', openQuestions: ['Anrufzahlen aus der Telefonanlage bestätigen'] },
        { section: 'effort', content: 'Rund 60 Personentage plus Lizenzen (Schätzung).', status: 'filled', openQuestions: [] },
        { section: 'risks', content: 'Datenqualität der Seriennummern, Datenschutz der Kundenkonten, Absicherung der ERP-Schnittstelle.', status: 'filled', openQuestions: [] },
        { section: 'affected', content: 'Innendienst, Vertrieb, IT, Bestandskunden.', status: 'filled', openQuestions: [] },
        { section: 'path', content: 'Experiment mit zehn Stammkunden, danach Entscheidung über Kauf der Teilesuche.', status: 'filled', openQuestions: [] },
        { section: 'analyses', content: 'Kurzanalyse, Wettbewerb, Positionierung, Markt, Business Case, Risiken, Experiment und Gegenargumente liegen als Beispielbausteine vor.', status: 'filled', openQuestions: [] },
      ],
      estimates: { effortPersonDays: { low: 50, high: 70 }, effortEuro: { low: 35000, high: 70000 }, planBenefitEuro: { low: 35000, high: 120000 } },
    }, []),
  };
}

function holidayResults(): Record<string, StoredContent> {
  return {
    short_analysis: content('short_analysis', {
      summary: 'Urlaubsanträge sollen digital gestellt und per Klick freigegeben werden. Das spart Druck, Unterschrift und Scan.',
      completeness: { complete: false, missing: ['Anzahl der Anträge pro Jahr'] },
    }, [
      { heading: 'Worum es geht', claims: [assume('Heute wird jeder Antrag ausgedruckt, unterschrieben und eingescannt.'), assume('Die Freigabe soll per Klick durch die Führungskraft erfolgen.')] },
      { heading: 'Ähnliche Ideen im Portal', claims: [assume('Im Portal gibt es keine ähnliche Idee.')] },
      { heading: 'Fertige Lösungen und Vorgehen anderer', claims: [assume('Viele Personal- und Zeiterfassungssysteme haben eine Urlaubsfunktion; zuerst prüfen, ob das vorhandene System sie schon kann.')] },
      { heading: 'Markt und Nutzen', claims: [estimate('Laut Einreichung etwa 10 Minuten weniger Aufwand je Antrag.', 'low')] },
      { heading: 'Offene Fragen', claims: [assume('Welches System nutzt die Personalabteilung heute?')] },
    ]),
    triage_suggestion: content('triage_suggestion', {
      lane: 'fast_lane', topic: 'Prozesse und Effizienz', confidence: 'medium',
      reason: 'Klein und klar umsetzbar, wenn das vorhandene Personalsystem die Funktion bereits hat. Dann genügt das Einschalten.',
      missing: ['Name des vorhandenen Personalsystems'],
    }, []),
  };
}

/** Writes the pre-generated results for the demo ideas and cancels their queued AI jobs. */
export async function addDemoResults(db: Db, tenantId: string, locale: Locale = 'de'): Promise<void> {
  const ideas = await db.query<{ id: string; title: string }>('SELECT id, title FROM ideas');
  const d = DEMO_CONTENT[locale];
  const portal = locale === 'en' ? portalResultsEn : portalResults;
  const holiday = locale === 'en' ? holidayResultsEn : holidayResults;
  for (const idea of ideas.rows) {
    const results = idea.title === d.portal.title ? portal() : idea.title === d.holiday.title ? holiday() : null;
    if (!results) continue;
    await db.query(`UPDATE ai_jobs SET status = 'skipped', error = $2, finished_at = now() WHERE idea_id = $1 AND status = 'queued'`, [idea.id, SKIPPED[locale]]);
    for (const [kind, c] of Object.entries(results)) {
      await db.query(
        `INSERT INTO ai_results (tenant_id, idea_id, kind, version, content) VALUES ($1, $2, $3, 1, $4)`,
        [tenantId, idea.id, kind, JSON.stringify(c)],
      );
    }
  }
}
