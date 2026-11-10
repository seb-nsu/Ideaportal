# Arbeitspakete Version 3

Stand 12.10.2026, Umsetzungsstand 13.10.2026 (Abschnitt unten). Grundlage: Umsetzungskonzept Version 3 (Abschnitt 4, Phasen 1–5), Backlog (146 Stories, offen 396 SP), Review V3 (`docs/05-review-v3/`) und die offenen Punkte aus `docs/release-0/README.md` und den Umsetzungsständen.

Ein Arbeitspaket (AP) ist so geschnitten, dass es in einer bis drei Sitzungen mit Claude Code fertig wird, für sich lauffähig ist und am Ende committet werden kann. Jedes Paket nennt Code und Dokumentation gemeinsam, weil die Definition of Done beides verlangt.

## Regeln für die Reihenfolge

1. **Erst schließen, was öffentlich offen ist.** Die Demo ist im Netz. Rate-Limits und Sicherheits-Header kommen vor allem anderen.
2. **Vertrauen vor Testen.** Der Klicktest läuft erst, wenn die Demo keine Platzhalterzahlen mehr zeigt und Autor:innen keinen KI-Spur-Vorschlag sehen. Sonst misst der Test bekannte Fehler.
3. **Messen vor dem Pilot.** Die Durchlaufzeit (R2-41) und die Ausgangswerte müssen vor dem Pilotstart da sein, sonst lässt sich die Kernhypothese nicht belegen.
4. **Textkatalog vor neuer Oberfläche.** R2-50 kommt vor jeder größeren Oberflächen-Story. Jede Story davor erhöht die Nachrüstkosten für Englisch.
5. **Grundlage vor Aufbau.** Firmen-Login → SCIM → Rollen je Bereich. API-Tokens → Teams-App und Konnektoren. Pakete und Feature-Schalter → Challenge-Paket und Modul Vorschlagswesen.
6. **Doku vor Prüfung.** ADR, Datenfluss und DSFA müssen dem Code entsprechen, bevor Datenschutz, Betriebsrat oder Pentest sie lesen.
7. **Pentest zuletzt.** Erst wenn der Funktionsumfang für den Marktstart steht.

## Übersicht

| AP | Phase | Titel | Stories | SP (Muss) | Art | Hängt ab von |
| --- | --- | --- | --- | --- | --- | --- |
| AP-00 | 0 | Version 3 sichern, Demo absichern | – | – | Doku, Betrieb | – |
| AP-01 | 1 | Sicherheit der öffentlichen Demo | R1-44, R1-45 | 6 (6) | Code + Doku | AP-00 |
| AP-02 | 1 | KI-Vertrauen | R2-39, R2-40, R2-43 | 7 (7) | Code | AP-00 |
| AP-03 | 1 | Betrieb und Messung | R1-05, R2-41 | 10 (10) | Code + Doku | AP-00 |
| AP-04 | 1 | Datenschutz-Nachweis und Doku-Abgleich | R2-42 | 3 (3) | Doku + Code | AP-01 |
| AP-05 | 1 | Validierung und Pilotvorbereitung | – | – | PO-Aufgaben | AP-01, AP-02 |
| AP-06 | 2 | Textkatalog | R2-50 | 8 (0) | Code | Phase 1 |
| AP-07 | 2 | Bedienbarkeit aus dem Klicktest | R2-47, R2-48, R1-46 + Befunde | 10 (0) + Befunde | Code | AP-05, AP-06 |
| AP-08 | 2 | KI-Qualität | R2-44, R2-45, R2-46, R2-49 | 13 (0) | Code + Doku | AP-02 |
| AP-09 | 2 | Challenges | R2-51, R2-52 | 10 (5) | Code | AP-06 |
| AP-10 | 2 | Business-Unterlagen und Go/No-go | – | – | Doku | AP-05 |
| AP-11 | 3 | Identität: Firmen-Login und SCIM | R3-26, R3-27 | 13 (13) | Code + Doku | Phase 2 |
| AP-12 | 3 | API-Tokens, OpenAPI, Webhooks | R3-17 | 13 (13) | Code + Doku | Phase 2 |
| AP-13 | 3 | Teams- und Slack-App | R3-16 | 8 (8) | Code + Doku | AP-11, AP-12 |
| AP-14 | 3 | Suche und Skalierung | R3-28 | 8 (8) | Code + Doku | – |
| AP-15 | 3 | Mitbestimmung | R3-12 | 10 (10) | Code + Doku | AP-10 |
| AP-16 | 3 | Mehrsprachigkeit | R3-22 | 13 (13) | Code | AP-06 |
| AP-17 | 4 | SaaS-Betrieb | R3-01, R3-41, R3-07, R3-10 | 21 (18) | Code + Doku | AP-03 |
| AP-18 | 4 | Pakete und Abrechnung | R3-05, R3-06, R3-02, R3-03, R3-39 | 29 (26) | Code + Doku | AP-17, AP-08 |
| AP-19 | 4 | Rollen je Bereich | R3-29 | 8 (0) | Code | AP-11 |
| AP-20 | 4 | Konnektoren | R3-13, R3-14, R3-15, R3-18 | 29 (16) | Code + Doku | AP-12 |
| AP-21 | 4 | Externe Beteiligung | R3-19, R3-21, R3-20 | 22 (14) | Code + Doku | AP-15 |
| AP-22 | 4 | Einsatzfelder | R3-31, R3-32, R3-33, R3-34 | 18 (0) | Code | AP-09 |
| AP-23 | 4 | Modul Vorschlagswesen | R3-35, R3-36, R3-37, R3-38 | 24 (0) | Code + Doku | AP-18, Segmententscheidung |
| AP-24 | 4 | Portfolio, Sprache, Gamification | R3-23, R3-30, R3-40, R2-53 | 18 (0) | Code | AP-16 |
| AP-25 | 4 | Compliance und Pentest | R3-08, R3-11, R3-25, R3-09 | 19 (19) | Doku + Code | alle Muss-APs aus Phase 4 |
| AP-26 | 5 | KI-Qualitäts-Dashboard und KI-Import | R4-08, R4-12 | 10 (5) | Code | AP-08 |
| AP-27 | 5 | Erkennen | R4-11, R4-02, R4-03, R4-01 | 34 (13) | Code | AP-20 |
| AP-28 | 5 | Wirkung und Lernen | R4-04, R4-06, R4-07 | 32 (24) | Code | ≥ 20 abgeschlossene Ideen |

Summe: 396 SP. Phase 1: 26 SP, Phase 2: 41 SP plus Klicktest-Befunde, Phase 3: 65 SP, Phase 4: 188 SP, Phase 5: 76 SP.

## Umsetzungsstand (13.10.2026)

Umgesetzt mit Claude Code auf dem Branch `claude/arbeitspakete-v3-6i8kcs` (Pull Request #2). Grundsätze: keine bezahlten Dienste, keine echten Schlüssel, externe Systeme (Identitätsanbieter, Teams, Slack, Jira, ServiceNow, Azure DevOps) über Attrappen in den Tests. Stand je Story in `docs/release-1/`, `release-2/`, `release-3/` und `release-4/umsetzungsstand.md`.

| AP | Stand | Was offen bleibt |
| --- | --- | --- |
| AP-00 | fertig (vor diesem Lauf) | `SIGNUP_ENABLED` auf Render nach AP-01 wieder auf `true` setzen (Product Owner) |
| AP-01 | fertig | – |
| AP-02 | fertig | – |
| AP-03 | fertig | Restore-Test auf Render (bezahlter Plan), Alarmkanal und Bereitschaft benennen; Staging-Dienst in Render anlegen |
| AP-04 | fertig | Prüfung von DSFA und Verarbeitungsverzeichnis durch den DSB |
| AP-05 | vorbereitet | Klicktest mit 7–8 Personen, manuelle Barrierefreiheitsprüfung, Ausgangswerte, Pilotbereich (alles Product Owner); Vorlagen liegen bereit |
| AP-06 | fertig | – |
| AP-07 | fertig | Befunde aus dem Klicktest folgen; mobiles Menü erst nach dem Klicktest |
| AP-08 | fertig | – |
| AP-09 | fertig | – |
| AP-10 | teilweise | Dokumente fertig (Finanzmodell V3, Gesprächs- und Interviewleitfaden, Muster-BV, Go/No-go-Vorlage); offen: 10 Interviews, Segmententscheidung, Go/No-go nach 3 Monaten Pilot, Diagramme und PDFs (kein Erzeugungsskript im Repository) |
| AP-11 | fertig | Test mit echtem Entra ID oder Okta |
| AP-12 | fertig | – |
| AP-13 | fertig | Veröffentlichung im Teams Store, Test in einem echten Teams- und Slack-Arbeitsbereich |
| AP-14 | fertig | pgvector auf Render prüfen (sonst Trigramm-Rückfall) |
| AP-15 | fertig | Muster-BV anwaltlich prüfen lassen |
| AP-16 | fertig | – |
| AP-17 | fertig | externer Verfügbarkeitsmonitor, Vorlauf für Wartungsankündigungen, Rotation der Mandantenschlüssel selbst, eigene Konten für Betreiber |
| AP-18 | fertig | Zahlungsanbieter (Rechnungen bleiben Entwürfe), Annahmen zu Enterprise-Staffel und Kontingenten bestätigen |
| AP-19 | fertig | – |
| AP-20 | fertig | Test gegen echte Jira-, ServiceNow- und Azure-DevOps-Instanzen; Ziele im Firmennetz brauchen eine Freigabe privater Adressen |
| AP-21 | fertig | Rechtstexte für Externe anwaltlich prüfen, Löschfrist für inaktive externe Konten |
| AP-22 | fertig | – |
| AP-23 | nicht gebaut (Vorgabe) | wartet auf die Segmententscheidung aus AP-10; Modul Z ist nur als Paketschalter angelegt |
| AP-24 | fertig | keine dritte Oberflächensprache ausgeliefert (nur der Weg dahin) |
| AP-25 | teilweise | externer Pentest, anwaltliche Prüfung der Rechtstexte, Nachweise von Render (Zertifikate, AVV), ISMS-Entscheidung |
| AP-26 | fertig | Betreiberweite Sicht auf die KI-Qualität über alle Mandanten (optional, nicht gebaut) |
| AP-27 | fertig | Anbindung echter Ticketsysteme; Löschfrist für Problem-Läufe und Trendhinweise |
| AP-28 | fertig (mit Testdaten) | Kalibrierung mit echten 20 abgeschlossenen Ideen; Oberfläche für die Lern-Schwellen (bisher nur über die API) |

Abweichung vom Vorgehen „ein Commit je AP“: AP-07 bis AP-09, AP-11 bis AP-16, Phase 4 und Phase 5 wurden parallel gebaut und berühren dieselben Dateien; sie sind deshalb in je einem gemeinsamen Commit zusammengefasst, die Commit-Nachricht nennt die Stories je AP.

## Phase 0 – Sofort

### AP-00 Version 3 sichern, Demo absichern

- Konzept Version 3, Reviews und Backlog committen und pushen.
- Render: bis AP-01 fertig ist `SIGNUP_ENABLED=false` setzen. Die Demo mit Rollenwechsel bleibt an.
- Ersten Start in den Render-Logs prüfen (Rolle `ideenportal_app` anlegen, `CREATEROLE`). Ergebnis in `docs/betrieb.md` festhalten („auf Render getestet“).
- **Fertig, wenn** `main` den Stand von Version 3 hat und die Demo erreichbar ist.

## Phase 1 – Härtung vor Demo und Pilot (2–3 Wochen)

Reihenfolge: AP-01 → AP-02 → AP-03 → AP-04. AP-05 beginnt, sobald AP-01 und AP-02 auf der Demo laufen.

### AP-01 Sicherheit der öffentlichen Demo

- **Code:** R1-44 Rate-Limits je IP und Konto (Anmeldung, Registrierung, Reset, Demo). R1-45 TOTP verschlüsselt mit Migration für den Bestand, CSP und HSTS, Mail-Betreff vertraulicher Ideen ohne Titel, `npm audit --audit-level=high` in der CI.
- **Doku:** `adr/bedrohungsmodell.md` (T-S2, T-I8, T-I10, T-D2, T-D3 auf „umgesetzt“), Abschnitt „Offen“ in `release-2/umsetzungsstand.md`, Umsetzungsstand Release 1.
- **Danach:** `SIGNUP_ENABLED` wieder auf `true`.

### AP-02 KI-Vertrauen

- **Code:** R2-39 Triage-Vorschlag und Rückmeldungsentwurf nur für Triage, Gremium und Pate. Filter nach Ergebnisart in `server/src/routes/ai.ts` (heute liefert die Abfrage alle Arten), Test je Rolle. R2-40 eingebauter Anbieter ohne Beträge, Banner „Kein KI-Modell eingerichtet“, Demo-Seed mit vorab erzeugten echten Ergebnissen. R2-43 einseitige Gate-2-Vorlage mit Quellenlink je Zahl.
- **Doku:** `betrieb.md` Abschnitt „KI einrichten“ (was der eingebaute Anbieter liefert und was nicht).

### AP-03 Betrieb und Messung

- **Code:** R1-05 Health mit Alter des letzten Job-Laufs, Queue-Länge, ältestem Job und Outbox-Rückstau, Alarm per Mail oder Webhook, Test „keine Ideentexte in Logs“. R2-41 Durchlaufzeit je Phase (Median, 90. Perzentil), Zeitreihen, Ausgangswert als Linie.
- **Betrieb:** Staging als zweiter Render-Dienst in `render.yaml`. Restore-Test einmal durchführen.
- **Doku:** `betrieb.md` (Kennzahlen, Alarme, Staging), Protokoll des Restore-Tests in `release-0/technik/betriebshandbuch.md`.

### AP-04 Datenschutz-Nachweis und Doku-Abgleich

- **Code:** R2-42 Datenschutz-Nachweis je KI-Analyse (gesendete Suchanfragen, entfernte Begriffe, Anbieter, Hosting).
- **Doku (Review P-22):** ADR 0005 (Anfrage aus Stichworten, nicht vom Modell), `adr/datenfluss.md` F8 (nur Snippets, kein Seitenabruf) und F11 (Logs), `release-0/ux/navigation.md` (Steckbrief, mobiles Menü). ADR 0001 auf „angenommen“ setzen. DSFA-Entwurf und Verarbeitungsverzeichnis um den Datenschutz-Nachweis ergänzen.
- **Warum hier:** Der Datenschutzbeauftragte prüft vor dem Pilot. Er muss den echten Stand lesen.

### AP-05 Validierung und Pilotvorbereitung (Product Owner)

- Klicktest mit 7–8 Personen auf der Demo nach `release-0/ux/papiertest.md`. Befunde mit Schweregrad in `docs/release-2/klicktest.md`. Kritische Befunde als Stories in Epic X.
- Manuelle Barrierefreiheitsprüfung (Tastatur, Screenreader, Zoom 200 %, Kontrast). Ergebnis in `release-0/ux/mobil-und-barrierefreiheit.md`, R1-42 abschließen.
- Ausgangswerte erheben (`release-0/prozess/ausgangswerte.md`), Pilotbereich und Zielkanäle festlegen, DSFA durch den DSB prüfen lassen.
- **Fertig, wenn** das Exit-Kriterium von Phase 1 erfüllt ist und der Pilot starten kann.

## Phase 2 – Pilot mit Nacharbeit (parallel zum Pilot, ca. 6–8 Wochen)

Reihenfolge: AP-06 zuerst. Danach AP-07 und AP-08 parallel, AP-09 im Anschluss. AP-10 läuft daneben.

### AP-06 Textkatalog

- **Code:** R2-50 Textkatalog für Oberfläche, Serverfehler und Mails. Bestand in zwei Schritten auslagern, Sprache je Person im Profil.
- **Doku:** Regel in `CLAUDE.md` unter Konventionen: Neue Texte nur im Katalog.

### AP-07 Bedienbarkeit aus dem Klicktest

- **Code:** zuerst die kritischen Befunde aus AP-05. Danach R2-47 Steckbrief als eigene Seite mit Reitern, R2-48 Erststart je Rolle und Leerzustände mit nächstem Schritt, R1-46 sichtbare Antwortgarantie. Mobiles Menü (Review P-06), falls der Klicktest es bestätigt.
- **Doku:** `release-0/ux/hauptbildschirme.md` und `navigation.md` auf den neuen Stand.

### AP-08 KI-Qualität

- **Code:** R2-44 Prüfstatus je Baustein und Bewertung „hilfreich?“, R2-45 Websuche und Bausteine je Ideentyp (Standard: intern ohne Websuche, Patente aus, wie für R2-24 festgelegt), R2-46 Quellenprüfung im Qualitätstor mit Seitenabruf, R2-49 Fairness je Mandant und Kostenschätzung vor dem Aufruf.
- **Doku:** ADR 0004 (Kostenschätzung, Fairness), ADR 0005 und `datenfluss.md` F8 (jetzt mit Seitenabruf), DSFA-Ergänzung zum Seitenabruf.

### AP-09 Challenges

- **Code:** R2-51 Crowd-Bewertung nach Kriterien, aggregiert und nie personenbezogen. R2-52 Challenge-Phasen mit Terminen und Vorlagen.
- **Doku:** Benachrichtigungsmatrix (neue Ereignisse je Phase), Umsetzungsstand Release 2.

### AP-10 Business-Unterlagen und Go/No-go

- Finanzmodell auf Bottom-up-DACH, Churn-Szenario 15 %, Vertriebsbudget und neue Preise umrechnen (`release-0/business/finanzmodell.md`).
- Gesprächsleitfaden auf die neue Positionierung umstellen. Interviewleitfaden für die Segmententscheidung Vorschlagswesen anlegen, 10 Interviews führen.
- Ersten Entwurf der Muster-Betriebsvereinbarung schreiben (Inhalt für R3-12, auch als Vertriebsunterlage).
- Diagramme (Releaseplan, Marktkarte, KI-Kreislauf) und PDFs von Produkt- und Umsetzungskonzept neu erzeugen.
- Nach 3 Monaten Pilot: Go/No-go nach Umsetzungskonzept Abschnitt 4.
- **Ergebnis:** Segmententscheidung (Modul Z ja oder nein) und Go/No-go sind dokumentiert.

## Phase 3 – Release 3 Teil 1 „Firmenfähig“ (ca. 7 Wochen)

Kann im 2. Pilotmonat beginnen. AP-11 und AP-12 laufen parallel (bei 2 Entwickler:innen), dann AP-13. AP-14 bis AP-16 folgen.

### AP-11 Identität

- **Code:** R3-26 Firmen-Login mit OIDC (Entra ID zuerst), Gruppen → Rollen, Just-in-time-Anlage, lokale Konten je Mandant abschaltbar. R3-27 SCIM für Entra ID und Okta.
- **Doku:** ADR 0002 (Anmeldung) aktualisieren, Einrichtungsanleitung für Kunden-IT in `betrieb.md`.

### AP-12 API-Tokens, OpenAPI, Webhooks

- **Code:** R3-17 Tokens je Mandant mit Rollen, Ablauf, Widerruf und Audit. OpenAPI aus den zod-Schemas unter `/api/docs`. Webhooks mit Signatur und Wiederholung.
- **Doku:** neue ADR „Öffentliche API und Webhooks“, Bedrohungsmodell um Tokens erweitern.

### AP-13 Teams- und Slack-App

- **Code:** R3-16 Benachrichtigung und Einreichen in Teams (Teams Store) und Slack. Gleiche Matrix wie E-Mail. Vertrauliche Titel nicht im Chat.
- **Doku:** Benachrichtigungsmatrix, Datenfluss (neuer Empfänger), Anleitung zur Einrichtung.

### AP-14 Suche und Skalierung

- **Code:** R3-28 `tsvector` mit GIN-Index, Cursor-Paginierung, pgvector mit lokalem Embedding für Dubletten. Lasttest mit 10.000 Ideen. Damit ist R1-19 abgeschlossen.
- **Doku:** ADR 0001 (pgvector), `betrieb.md` (Erweiterung `vector`).

### AP-15 Mitbestimmung

- **Code:** R3-12 Übersicht aller Rollen, Rechte, Auswertungen und KI-Funktionen. Muster-Betriebsvereinbarung wird aus der Konfiguration erzeugt.
- **Doku:** Muster-BV aus AP-10 fertigstellen, DSFA abgleichen.

### AP-16 Mehrsprachigkeit

- **Code:** R3-22 englische Oberfläche, Mails und KI-Ausgabe in der Sprache der Person, Datums- und Zahlenformate.
- **Doku:** Textvorlagen auf Englisch, README.

## Phase 4 – Release 3 Teil 2 „Marktreife“ (ca. 16 Wochen)

Reihenfolge: AP-17 → AP-18 (Grundlage für Verkauf und Modulschalter). Danach AP-19 bis AP-22 nach Kapazität. AP-23 nur bei positiver Segmententscheidung. AP-24 bei Kapazität. AP-25 als letztes Paket vor dem Marktstart.

### AP-17 SaaS-Betrieb

- **Code:** R3-01 eigene Schlüssel je Mandant, R3-41 Rotation des `SECRET_KEY` und versionierte Einstellungen, R3-07 Admin-Konsole für den Support (nutzt die Kennzahlen aus AP-03), R3-10 Statusseite und Verfügbarkeitszusage.
- **Doku:** `betrieb.md` (Rotation, Support-Zugriff), Bedrohungsmodell.

### AP-18 Pakete und Abrechnung

- **Code:** R3-05 Pakete mit Feature-Schaltern je Mandant (Grundlage für Modul Z), R3-06 KI-Kontingent je Mandant (nutzt R2-49), R3-02 Testphase bei der Selbstregistrierung, R3-03 KI-Vorschlag für den Prozess, R3-39 Challenge-Paket zum Festpreis.
- **Doku:** Preisblatt aus dem Produktkonzept, Vertragsgrundlagen.

### AP-19 Rollen je Bereich

- **Code:** R3-29 Bereich als Stammdatum, Rollen mit Geltungsbereich, Board, Aufgaben, Eskalation und Dashboard filtern danach. Gruppen aus SCIM (AP-11) auf Bereiche abbilden.

### AP-20 Konnektoren

- **Code:** R3-13 Jira, R3-14 ServiceNow, R3-15 Azure DevOps, R3-18 Umsetzungspaket. Alle über die Tokens und Webhooks aus AP-12.
- **Doku:** Anleitung je Konnektor, Datenfluss.

### AP-21 Externe Beteiligung

- **Code:** R3-19 externe Einreichende mit Einwilligung zu Nutzungsrechten je Challenge, R3-21 Moderation, R3-20 Feature-Wünsche mit Status-Seite (nur für Bestandskunden mit Produktteams).
- **Doku:** Rechtstexte für Externe, DSFA-Ergänzung.

### AP-22 Einsatzfelder

- **Code:** R3-31 Problembörse, R3-32 Nachhaltigkeits-Challenge mit kWh und ESG-Export, R3-33 Challenge mit Zielwert und Controlling-Bestätigung, R3-34 Hackathon-Modus.
- **Doku:** Einsatzfelder im Produktkonzept als „gebaut“ markieren, Vorlagen für Challenges.

### AP-23 Modul Vorschlagswesen (nur nach Segmententscheidung)

- **Code:** R3-35 Fachgutachten, Kommission und Einspruch, R3-36 Prämienregeln und Payroll-Export, R3-37 Einreichen per QR-Code und Kiosk, R3-38 Benchmark-Kennzahlen. Das Modul ist über den Schalter aus AP-18 zubuchbar.
- **Doku:** Muster-BV um Prämienregeln ergänzen.
- **Wenn die Entscheidung „nein“ ist:** Stories auf „geparkt“ setzen und den Backlog neu erzeugen.

### AP-24 Portfolio, Sprache, Gamification

- **Code:** R3-23 Fragen an das Portfolio, R3-30 KI-Übersetzung von Inhalten, R3-40 öffentliche Benchmark-Seite, R2-53 Gamification je Challenge.

### AP-25 Compliance und Pentest

- **Doku und Code:** R3-08 EU-Hosting, Verschlüsselung, AV-Vertrag. R3-11 Rechtstexte im Produkt. R3-25 Prüfschritt für Erfindungsmeldungen. R3-09 externer Pentest und Sicherheitskonzept, Befunde beheben.
- **Fertig, wenn** der Pentest ohne kritische oder hohe offene Befunde abgeschlossen ist. Das ist die Voraussetzung für den Marktstart.

## Phase 5 – Release 4 „Lernendes System“ (ca. 8 Wochen)

### AP-26 KI-Qualitäts-Dashboard und KI-Import

- **Code:** R4-08 Qualitäts-Dashboard (nutzt Prüfstatus, Bewertungen und Quellenprüfung aus AP-08), R4-12 Import alter Ideen mit KI-Unterstützung.

### AP-27 Erkennen

- **Code:** R4-11 Trend- und Technologieradar, R4-02 Trendhinweise, R4-03 weiße Flecken, R4-01 Problem-Radar aus Tickets und Feedback (braucht die Konnektoren aus AP-20).

### AP-28 Wirkung und Lernen

- **Code:** R4-04 Kennzahlen vorher und nachher aus angebundenen Systemen, R4-06 Aufwandsschätzung aus ähnlichen Ideen, R4-07 Kalibrierung der Prognosen mit Trefferband in der Gremiumsvorlage.
- **Voraussetzung:** mindestens 20 abgeschlossene Ideen mit Ist-Nutzen.

## Daueraufgaben in jedem Paket

- Umsetzungsstand des Releases pflegen (`docs/release-<n>/umsetzungsstand.md`), bei Release 3 und 4 neu anlegen.
- ADR, Datenfluss und Bedrohungsmodell ändern, wenn das Paket sie berührt.
- Große Dateien aufteilen, wenn die Story sie ohnehin ändert (`agents.ts`, `workflow.ts`, `Elaboration.tsx`, `Admin.tsx`).
- Nach Änderungen am Umsetzungskonzept: `python tools/extract_backlog.py`.

## Offene Punkte für den Product Owner

Diese Punkte gehen nicht ohne echte Nutzer:innen, Kunden, bezahlte Dienste oder externe Prüfer. Sie sind die Voraussetzung für die Exit-Kriterien der Phasen.

1. **Klicktest** mit 7–8 Personen auf der Demo (`release-0/ux/papiertest.md`, Vorlage `release-2/klicktest.md`), Befunde als Stories in Epic X.
2. **Manuelle Barrierefreiheitsprüfung** (Tastatur, Screenreader, Zoom 200 %, Kontrast; Prüfliste in `release-0/ux/mobil-und-barrierefreiheit.md`), danach R1-42 abschließen.
3. **Ausgangswerte und Pilotbereich** festlegen (`release-0/prozess/`).
4. **10 Interviews** zur Segmententscheidung Vorschlagswesen (`release-0/business/interviewleitfaden-vorschlagswesen.md`), danach Entscheidung zu AP-23.
5. **Go/No-go** nach 3 Monaten Pilot (`release-0/business/go-no-go.md`).
6. **Externer Penetrationstest** (Vorbereitung in `sicherheit/pentest-vorbereitung.md`).
7. **Teams-Store-Veröffentlichung** (Partner Center, Bot-Registrierung; App-Paket in `integrations/teams/`).
8. **Render-Einstellungen:** Staging-Dienst aus `render.yaml` anlegen, `SIGNUP_ENABLED` setzen, `SECRET_KEY`, `OPERATOR_TOKEN` und `OPERATOR_TOTP_SECRET` (`npm run operator -w server -- setup`), `DATABASE_SSL`, Restore-Test auf dem bezahlten Plan, pgvector prüfen.
9. **DSB-Prüfung** von DSFA (`release-0/datenschutz/dsfa-entwurf.md`, neue Abschnitte 6a–6d) und Verarbeitungsverzeichnis (neu V11, V12).
10. **Anwaltliche Prüfung** der Rechtstexte (`server/templates/legal/`, `release-0/business/rechtstexte-externe.md`), der Muster-Betriebsvereinbarung und des AVV.
11. **Test mit echten Systemen:** Entra ID oder Okta (Firmen-Login, SCIM), Teams und Slack, Jira, ServiceNow, Azure DevOps.
12. **Zahlungsanbieter** auswählen und anbinden (Rechnungen sind bisher Entwürfe, die der Betreiber versendet).
13. **Annahmen bestätigen**, die in den Umsetzungsständen als „Annahme“ markiert sind (z. B. Enterprise-Staffel und KI-Kontingente, Bereichszuordnung über Themenfeld und Organisationseinheit, Trefferband ±20 %).
14. **Externer Verfügbarkeitsmonitor** für die Statusseite vor dem Marktstart.
