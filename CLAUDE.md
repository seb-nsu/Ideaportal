# CLAUDE.md – Projektkontext Ideenportal

Dieses Repository enthält das **Ideenportal**: ein KI-gestütztes Ideenmanagement für Innovations- und Strategieteams, das intern und als SaaS aus demselben Code läuft.

**Stand (13.10.2026):** Konzept Version 3 nach dem 360-Grad-Review (`docs/05-review-v3/`, Zuordnung in `einarbeitung.md`). Die Arbeitspakete AP-01 bis AP-28 aus `docs/arbeitspakete.md` sind gebaut, soweit es ohne bezahlte Dienste und echte Nutzer:innen geht (AP-23 Modul Vorschlagswesen bewusst nicht; AP-05, AP-10 und AP-25 nur teilweise). Stand je Paket und die offenen Punkte für den Product Owner stehen in `docs/arbeitspakete.md`, je Story in `docs/release-<n>/umsetzungsstand.md` (1–4). Nächster Schritt: Klicktest, Pilot und die externen Prüfungen. Release 1 ist für den Pilotbetrieb als Capstone-Produkt gebaut (`server/`, `web/`): Selbstregistrierung ohne Firmen-Login, Einladungslink, öffentliche Demo; Stand je Story in `docs/release-1/umsetzungsstand.md`, Technikwahl in `docs/adr/0001-technik-und-mandantenmodell.md`, Betrieb in `docs/betrieb.md`. Firmen-Login kommt als R3-26 (ersetzt R1-08). Release 0 liegt als Dokumente in `docs/release-0/` (offene Entscheidungen dort im README). Release 2 (Ausarbeitung, Gremium, KI-Analyse) ist gebaut, Stand in `docs/release-2/umsetzungsstand.md`; KI-Anbieter und Modelle sind je Arbeitsbereich unter Einstellungen › KI einstellbar (`server/src/ai/`).

## Quellen der Wahrheit

| Datei | Inhalt |
| --- | --- |
| `docs/03-umsetzungskonzept/umsetzungskonzept.md` | **Maßgeblich für die Umsetzung**: Architektur, Vorgehen, Releaseplan, Abgrenzung, Lückenlösungen, KI-Analyse, Release 0, Backlog (146 Stories, 752 SP), Risiken |
| `backlog/backlog.csv`, `backlog/backlog.json` | Backlog maschinenlesbar, erzeugt aus dem Umsetzungskonzept mit `python3 tools/extract_backlog.py` |
| `docs/02-produktkonzept/produktkonzept.md` | Produktkonzept: Vision, Module, Datenmodell, Status-Logik, KI-Konzept, interner Einsatz, SaaS (Markt, Zielgruppe, Preise, Geschäftsmodell) |
| `docs/01-konzept-v2/` | Überarbeitetes Prozesskonzept (Foliensatz + Text), Grundlage für Gates, Triage, Scorecard, Rollen |
| `docs/diagramme/` | Diagramme als PNG (Status-Logik, KI-Kreislauf, Marktkarte, Architektur, Releaseplan, Roadmap) |

Die Markdown-Dateien sind Exporte der Live-Dokumente in Claude Docs vom 12.10.2026. Ab jetzt ist **dieses Repository die Arbeitsgrundlage**. Wenn du Konzepte änderst, ändere die Markdown-Datei und erzeuge den Backlog neu.

## Getroffene Entscheidungen

| Datum | Entscheidung |
| --- | --- |
| 02.10.2026 | Prozess: Ideenfluss mit Schnellspur und drei Gates (G1 Triage, G2 Entscheidung, G3 Wirkungsreview), Fristen-Engine, Wirkungsnachweis |
| 02.10.2026 | Finale Lösung funktioniert **ohne ServiceNow**; ServiceNow ist nur ein Konnektor |
| 02.10.2026 | KI übernimmt die Ausarbeitung (Recherche, Wettbewerb, Markt, Business Case); Menschen entscheiden an den Gates |
| 12.10.2026 | Intern und extern werden **parallel** aus demselben Code gebaut; der interne Einsatz ist der erste Mandant |
| 12.10.2026 | Rechte an der Software geklärt (schriftliche Vereinbarung noch festhalten) |
| 12.10.2026 | ~~Zielgruppe Innovations- und Produktteams~~ – ersetzt durch Version 3 (siehe unten) |
| 12.10.2026 | **Jede Idee**, auch interne, bekommt Wettbewerbs- und Marktanalyse (Kurzanalyse nach Einreichung, Vollanalyse bei Ausarbeitung) |
| 12.10.2026 | Zuerst als **Capstone-Produkt** (Product Faculty): funktioniert ohne Firmen-Login mit Selbstregistrierung, Einladungslink und öffentlicher Demo |
| 12.10.2026 | Schätzung: 0,8 Personentage je Story Point plus 25 % Puffer; empfohlen 2 Entwickler:innen |
| 12.10.2026 | **Konzept Version 3** (Review V3): Positionierung als Entscheidungs- und Wirkungssystem (Antwortgarantie, belegte Vorlagen, nachgemessene Wirkung, gebaut für Mitbestimmung und DSGVO); KI-Ausarbeitung ist Funktion, nicht Alleinstellung |
| 12.10.2026 | Zielgruppe: **Innovations- und Strategieteams** in Unternehmen mit 250–5.000 Mitarbeitenden, DACH; Produktteams nur als Modul für Bestandskunden |
| 12.10.2026 | Vorgehen in fünf Phasen: Härtung vor Demo/Pilot → Pilot mit Nacharbeit → R3 „Firmenfähig“ (SSO, SCIM, Teams, API) → R3 Marktreife → R4 |

## Begriffe (verbindlich)

- **Release 0–4**: Lieferumfang. Release 0 = Grundlagen ohne Code, Release 1 = MVP, 2 = KI-Ausarbeitung, 3 = Marktreife SaaS, 4 = lernendes System.
- **Phase**: Schritt im Ideenfluss (Anregen, Einreichen, Ausarbeiten, Umsetzen, Anerkennen).
- **Gate 1–3**: Entscheidungspunkte. **Spur** an Gate 1: Schnellspur, Ausarbeiten, Weiterleiten, Ablehnen.
- **Ideentyp**: intern oder Produkt/Kunde; steuert den Inhalt der KI-Analyse, nicht ob sie läuft.
- **Story-IDs**: `R<Release>-<Nr>`, z. B. `R1-31`. Alte IDs (`S1-01` …) nur noch im Anhang des Umsetzungskonzepts.

## Leitplanken für den Bau

1. **Mandantenfähig ab Tag 1**: Row-Level-Security in PostgreSQL, Mandantenkontext in jeder Anfrage, getrennte Suchindizes. Test mit zwei Mandanten ist Pflicht.
2. **Einstellungen statt Code**: Fristen, Schwellen, Gewichte, Themenfelder, Texte, Zielkanäle je Mandant konfigurierbar. Keine firmenspezifischen Namen oder Daten im Code.
3. **API zuerst**: Oberfläche und Konnektoren nutzen dieselbe API.
4. **KI nur über das KI-Gateway**: austauschbare Modelle und Suchanbieter, Protokoll jeder KI-Aktion, Kostenlimit je Idee und Mandant.
5. **KI-Leitplanken**: keine Bewertung von Personen; KI entscheidet und lehnt nie ab; jede Zahl mit Quelle oder als Schätzung markiert; vertrauliche Ideen und erkannte Meldungen nie an externe KI- oder Suchdienste; Agenten mit minimalen Rechten (Prompt-Injection).
6. **Abgrenzung**: Das Portal ist kein Meldekanal nach dem Hinweisgeberschutzgesetz (Umsetzungskonzept Abschnitt 6).
7. **Datenschutz und Barrierefreiheit**: Auswertungen nur aggregiert und erst ab 5 Personen; WCAG 2.1 AA; Löschfristen konfigurierbar.
8. **Definition of Done** (Umsetzungskonzept Abschnitt 3): Akzeptanzkriterien erfüllt, automatische Tests für Fristen, Rechte und Mandantentrennung, Doku aktualisiert, bei KI: Kennzeichnung, Protokoll, Testfälle.

## Technik

Gebaut mit TypeScript/Node.js (Fastify), React (Vite) und PostgreSQL mit Row-Level-Security (ADR 0001, Bestätigung offen). Befehle: `npm run seed`, `npm run dev`, `npm test` (braucht PostgreSQL, siehe README), `npm run lint`, `npm run format` (neue Dateien), `npm run eval -w server`. Enterprise-Unterlagen in `docs/enterprise/`; der RLS-Wächter-Test prüft jede neue Tabelle. Jede Anfrage läuft über `withTenant()` als Rolle `ideenportal_app`; neue Tabellen brauchen `tenant_id`, eine Policy und einen Test.

### Ursprünglicher Technikvorschlag

TypeScript (Node.js) oder Python · Web-App (React oder Vue) · PostgreSQL mit Row-Level-Security und pgvector · lokales Open-Source-Embedding-Modell für Dubletten · OpenID Connect/SAML plus eigene Konten mit MFA · Job-Queue mit Datenbanksperren · Container, intern auf VM, extern in EU-Cloud · CI/CD mit Staging.
Die endgültige Wahl wird in Release 0 als Architekturentscheidung (ADR) dokumentiert, z. B. unter `docs/adr/`.

## Release 0 (erledigt, Ablage der Ergebnisse)

Ergebnisse laut Umsetzungskonzept Abschnitt 9, vorgeschlagene Ablage:

- `docs/release-0/ux/` – 3–4 Nutzerwege, Navigationsstruktur, Skizzen der Hauptbildschirme, Benachrichtigungsmatrix, Textvorlagen, mobile Kernaufgaben, Prüfplan Barrierefreiheit
- `docs/release-0/prozess/` – Pilotbereich und Pilotkunden, Scorecard mit Ankerbeispielen, Schwellen, Zielkanäle, Ausgangswerte, Einführungsplan
- `docs/adr/` – Architekturentscheidungen (Stack, Mandantenmodell, Anmeldung, Job-Queue, KI-Gateway, Suchanbieter), Datenflussdiagramm, Bedrohungsmodell
- `docs/release-0/datenschutz/` – Entwurf Datenschutz-Folgenabschätzung, Verzeichnis der Verarbeitungen, Rechtsgrundlagen
- `docs/release-0/ki/` – KI-Testsatz mit 30 Beispielideen und erwarteten Ergebnissen
- `docs/release-0/business/` – korrigiertes SaaS-Finanzmodell, Gesprächsleitfaden, Vertragsgrundlagen

## Offene Fragen

- Klicktest, manuelle Barrierefreiheitsprüfung und Ausgangswerte (AP-05) – Voraussetzung für den Pilot
- Prüfungen von außen: DSB (DSFA), Anwalt (Rechtstexte, Muster-BV, Texte für Externe), Pentest, Test mit echtem Entra ID oder Okta, Teams Store
- Zahlungsanbieter für die Abrechnung (Rechnungen sind bisher Entwürfe)
- Annahmen in den Umsetzungsständen bestätigen (z. B. Paketpreise Enterprise, KI-Kontingente, Bereichszuordnung über Themenfeld und Organisationseinheit)
- Segment Industrie/Vorschlagswesen: Modul Z bauen oder Branche streichen? Entscheidung nach 10 Interviews
- Finanzierung: Bootstrap, Förderung oder strategischer Partner? Finanzmodell auf Bottom-up-DACH umrechnen
- Welche 2–3 externen Pilotkunden?
- Stellt die IT VM/Container-Umgebung und Firmen-Login bereit?
- Welches KI-Modell und welcher Suchanbieter sind datenschutzrechtlich freigegeben?
- Größe der eigenen Organisation (für den internen Business Case)

## Konventionen

- Dokumentation und UI-Texte auf Deutsch, klare und kurze Sätze.
- **Neue Texte nur im Katalog** (R2-50): Oberfläche in `web/src/i18n/de/<bereich>.ts`, Server (Fehler, Mails, Benachrichtigungen) in `server/src/i18n/de/<bereich>.ts`, jeweils mit englischer Fassung in `en/`. Im Code nur `t('bereich.schluessel')` bzw. `m('bereich.schluessel')`. `npm run check:texts` muss 0 melden (läuft in der CI).
- Vorschlag für Code: Bezeichner, Commits und Code-Kommentare auf Englisch (noch zu bestätigen).
- Rechtliche Aussagen in den Dokumenten sind keine Rechtsberatung.
