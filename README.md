# Ideenportal

Deutsch | [English](README.en.md)

KI-gestütztes Ideenmanagement für Innovations- und Strategieteams in Unternehmen mit 250–5.000 Mitarbeitenden: Jede Idee bekommt in einer festen Frist eine Antwort, KI-Agenten erstellen Wettbewerbs- und Marktanalyse, Business Case und Entscheidungsvorlage, und das Produkt belegt den Nutzen nach der Umsetzung. Intern und als SaaS aus demselben Code.

**Stand:** Konzept Version 3 (12.10.2026) nach dem 360-Grad-Review in [`docs/05-review-v3/`](docs/05-review-v3/); Vorgehen in fünf Phasen im Umsetzungskonzept, Abschnitt 4; Reihenfolge der Arbeit in [`docs/arbeitspakete.md`](docs/arbeitspakete.md). Release 1 ist für den Pilotbetrieb als Capstone-Produkt gebaut: Teams legen ihren Arbeitsbereich selbst an, laden Kolleg:innen per Link ein und brauchen keinen Firmen-Login. Stand je Story in [`docs/release-1/umsetzungsstand.md`](docs/release-1/umsetzungsstand.md). Release 2 (Ausarbeitung, Gremium, KI-Analysen mit einstellbaren Modellen) ist gebaut, Stand in [`docs/release-2/umsetzungsstand.md`](docs/release-2/umsetzungsstand.md). Seit 13.10.2026 sind auch Release 3 (Firmen-Login, SCIM, API, Teams und Slack, Konnektoren, Pakete, externe Beteiligung, Einsatzfelder, Compliance) und Release 4 (KI-Qualität, Erkennen, Wirkung und Lernen) gebaut, soweit es ohne bezahlte Dienste und echte Nutzer:innen geht; Stand in [`docs/release-3/umsetzungsstand.md`](docs/release-3/umsetzungsstand.md) und [`docs/release-4/umsetzungsstand.md`](docs/release-4/umsetzungsstand.md), offene Punkte für den Product Owner am Ende von [`docs/arbeitspakete.md`](docs/arbeitspakete.md). Das Modul Vorschlagswesen ist nicht gebaut. Die Ergebnisse von Release 0 (UX, Prozess, Datenschutz, Business) liegen in [`docs/release-0/`](docs/release-0/README.md). Betrieb und KI-Einrichtung in [`docs/betrieb.md`](docs/betrieb.md). Unterlagen für Enterprise-Kund:innen (Sicherheit, SLA, Upgrades, Admin-Handbuch) in [`docs/enterprise/`](docs/enterprise/README.md), auf Deutsch und Englisch.

## Meine Rolle und wichtigste Entscheidungen

Ich bin Product Owner dieses Projekts. Konzept, Anforderungen, Backlog, Priorisierung und Abnahme stammen von mir; den Code haben KI-Agenten (Claude Code) nach meiner Spezifikation geschrieben.

| Entscheidung | Begründung | Nachzulesen in |
| --- | --- | --- |
| Antwortgarantie: Ideenfluss mit Schnellspur, drei Gates und Fristen-Engine | Jede Idee endet in einem begründeten Zustand, keine bleibt liegen | [Produktkonzept](docs/02-produktkonzept/produktkonzept.md) |
| Die KI arbeitet vor, Menschen entscheiden an den Gates | Die KI bewertet keine Personen und lehnt nie ab; jede Zahl hat eine Quelle oder ist als Schätzung markiert | [Produktkonzept, Abschnitt KI-Konzept](docs/02-produktkonzept/produktkonzept.md) |
| Positionierung als Entscheidungs- und Wirkungssystem (Version 3) | KI-Ausarbeitung ist 2026 Marktstandard und taugt nicht als Alleinstellung | [Einarbeitung Review V3](docs/05-review-v3/einarbeitung.md) |
| Zielgruppe: Innovations- und Strategieteams, 250–5.000 Mitarbeitende, DACH | Keine Konzerne über 20.000 Mitarbeitende, kein US-Markt; Produktteams nur als Modul | [Einarbeitung Review V3](docs/05-review-v3/einarbeitung.md) |
| Intern und SaaS parallel aus demselben Code, mandantenfähig ab Tag 1 | Der interne Einsatz ist der erste Mandant | [ADR 0001](docs/adr/0001-technik-und-mandantenmodell.md) |
| Vertrauen vor Ausbau | Sicherheit, Betrieb und die drei KI-Vertrauensrisiken werden vor Demo und Pilot behoben | [Einarbeitung Review V3](docs/05-review-v3/einarbeitung.md) |
| Modul Vorschlagswesen bewusst nicht gebaut | Die Entscheidung fällt erst nach 10 Interviews mit Industriekunden | [Arbeitspakete](docs/arbeitspakete.md) |

- **Konzept:** [Produktkonzept](docs/02-produktkonzept/produktkonzept.md) · [Umsetzungskonzept](docs/03-umsetzungskonzept/umsetzungskonzept.md)
- **Entscheidungen:** [Entscheidungsliste mit Datum](CLAUDE.md#getroffene-entscheidungen) · [Architekturentscheidungen](docs/adr/) · [Go/No-go](docs/release-0/business/go-no-go.md)
- **Backlog:** [146 Stories in vier Releases](backlog/backlog.csv) · [Arbeitspakete und offene Punkte](docs/arbeitspakete.md)
- **Review:** [360-Grad-Review und Einarbeitung](docs/05-review-v3/)

![Releaseplan: Pilot nach 6 Monaten, Marktstart nach etwa 15 Monaten](docs/diagramme/releaseplan.png)

![Status-Logik: Jede Idee endet in einem begründeten Zustand](docs/diagramme/status-logik.png)

## Schnellstart

Mit Docker (eine Datenbank und die App, öffentliche Demo eingeschaltet):

```bash
docker compose up --build
```

Ohne Docker (Node.js 22 und PostgreSQL 16 lokal):

```bash
npm install
export DATABASE_URL=postgres://ideenportal:ideenportal@localhost:5432/ideenportal
npm run seed        # Migrationen und Demodaten
npm run dev         # API auf :3000, Oberfläche auf :5173
npm test            # Tests; braucht eine leere Datenbank ideenportal_test (TEST_DATABASE_URL)
npm run check:texts # alle sichtbaren Texte im Textkatalog, Englisch vollständig
npm run check:security # einfache Sicherheitsprüfung des Codes (läuft in der CI)
npm run lint        # ESLint für Server und Oberfläche
npm run format:check # Prettier für neue Dateien (geänderte nur als Warnung)
npm run test:coverage -w server # Tests mit Mindestabdeckung
npm run eval -w server -- --provider builtin # KI-Testsatz ohne Datenbank
```

Dann `http://localhost:3000` (Docker) bzw. `http://localhost:5173` öffnen. Auf der Startseite gibt es drei Wege:

- **Arbeitsbereich anlegen:** Name, E-Mail und Passwort genügen. Wer anlegt, wird Admin und lädt weitere Personen per Einladungslink ein (Einstellungen > Personen).
- **Demo ansehen** (mit `DEMO_MODE=true`): eine Rolle wählen und im Demo-Arbeitsbereich loslegen; oben lässt sich die Rolle wechseln. Die Demo öffnet in der Sprache der Seite: den deutschen Demo-Arbeitsbereich `demo` oder den englischen `demo-en`, jeweils mit eigenen Beispielideen und -analysen.
- **Anmelden:** nur E-Mail und Passwort.

Demo-Konten (Passwort `Ideenportal-Demo-2026`):

| Deutsche Demo (`demo`) | Englische Demo (`demo-en`) | Rolle |
| --- | --- | --- |
| `mitarbeit@demo.example` | `staff@demo-en.example` | Ideengeber:in |
| `triage@demo.example` | `triage@demo-en.example` | Triage-Team |
| `gremium@demo.example` | `committee@demo-en.example` | Gremium (Gate 2) |
| `umsetzung@demo.example` | `implementation@demo-en.example` | Umsetzer:in |
| `admin@demo.example` | `admin@demo-en.example` | Admin und Triage |

Das Seed-Skript legt zusätzlich den Arbeitsbereich `beispiel` an (gleiche Konten wie die deutsche Demo mit `@beispiel.example`); dort ist die Zwei-Faktor-Anmeldung für Admins Pflicht.

Veröffentlichen: `render.yaml` ist eine Vorlage für Render (EU, Frankfurt); weitere Varianten und alle Umgebungsvariablen in [`docs/betrieb.md`](docs/betrieb.md).

## Sprachen

Das Portal läuft auf Deutsch und Englisch (R3-22). Deutsch ist die Referenz; fehlt ein englischer Text, erscheint der deutsche.

- **Je Person:** Mein Konto › Sprache (`users.locale`). Danach richten sich Oberfläche, Fehlermeldungen, E-Mails und Benachrichtigungen sowie Datums- und Zahlenformate (`de-DE`, `en-GB`).
- **Ohne Konto:** Startseite, Anmeldung, Registrierung und Einladungslink folgen der Browsersprache; der Umschalter DE | EN oben auf der Startseite und unter den Formularen merkt sich die Wahl im Browser.
- **Je Arbeitsbereich:** Einstellungen › Prozess › Sprache des Arbeitsbereichs (`settings.locale`). Ein neuer Arbeitsbereich bekommt Themenfelder, Gate-1-Texte, FAQ, Datenschutzhinweis, Scorecard, die Tonalität der KI-Texte und Beispielinhalte in der Sprache der Person, die ihn anlegt. Bestehende Texte werden nie automatisch übersetzt.
- **KI:** Antworten im Dialog (Coach, Rückmeldungsentwurf, Zusammenfassung der Diskussion, Foto, Challenge-Vorschläge, Spracheingabe) kommen in der Sprache der fragenden Person; Analysen, die an der Idee gespeichert werden (Kurzanalyse, Triage-Vorschlag, Vollanalyse, Steckbrief-Entwurf, Gate-2-Vorlage, Erfolgsgeschichte), in der Sprache des Arbeitsbereichs. Das Modell bekommt dafür eine Sprachregel im Systemtext; der eingebaute Anbieter liefert seine festen Texte aus dem Katalog (`aiout.*`). Namen der KI-Bausteine, Anbietervorlagen, Fehler von Modellen und Websuche sowie die Warnhinweise an KI-Ergebnissen kommen aus dem Katalog (`aigw.*`); Warnhinweise und Jobfehler werden als deutscher Referenztext gespeichert und in der Sprache der lesenden Person angezeigt.
- **Übersetzen von Inhalten (R3-30):** Ideen und Kommentare lassen sich auf Knopfdruck in eine von 15 Sprachen übersetzen (`TRANSLATION_LANGUAGES` in `server/src/ai/insights.ts`); das Original bleibt sichtbar, die Übersetzung wird je Text und Zielsprache gespeichert. Dafür braucht es ein KI-Modell, vertrauliche Ideen nur ein Modell auf eigener Infrastruktur; ohne passendes Modell zeigt die Oberfläche das Übersetzen nicht an.
- **Weitere Oberflächensprache:** 1. Ordner `server/src/i18n/<code>/` und `web/src/i18n/<code>/` mit denselben Namensraum-Dateien wie `de/` und einer `index.ts` anlegen (fehlende Schlüssel fallen auf Deutsch zurück). 2. Server: `<code>` in `LOCALES`, `catalogs` und `INTL` in `server/src/i18n/index.ts` eintragen und eine Sprachregel in `LANGUAGE_RULE` (`server/src/ai/gateway.ts`) ergänzen (der Compiler verlangt sie). 3. Oberfläche: `LOCALES`, `LOCALE_INFO` und `catalogs` in `web/src/i18n/index.ts`; der Umschalter übernimmt die Sprache von dort. 4. Migration, die die Prüfung `users.locale IN (…)` erweitert. 5. Beispieldaten in `server/src/db/demo-content.ts` und `demo-results-en.ts` als Vorlage für einen Demo-Arbeitsbereich in der neuen Sprache. 6. `npm run check:texts` und `server/test/multilingual.test.ts` laufen lassen.
- **Texte pflegen:** `server/src/i18n/<de|en>/` und `web/src/i18n/<de|en>/`, gleiche Schlüssel in beiden Sprachen; `npm run check:texts` findet Texte außerhalb des Katalogs (auch in `server/src/ai/`), `server/test/multilingual.test.ts` deutsche Reste im englischen Katalog. Textvorlagen: [`docs/release-0/ux/textvorlagen.md`](docs/release-0/ux/textvorlagen.md) und [`textvorlagen.en.md`](docs/release-0/ux/textvorlagen.en.md).

## Code

```
server/   API (TypeScript, Fastify, PostgreSQL mit Row-Level-Security), Jobs, Tests
web/      Oberfläche (React, Vite)
e2e/      Browser-Test mit Barrierefreiheitsprüfung (Playwright, axe)
docs/adr/ Architekturentscheidungen
docs/konnektoren/  Einrichtung Jira, ServiceNow, Azure DevOps
docs/sicherheit/   Sicherheitskonzept und Pentest-Vorbereitung
docs/enterprise/   Unterlagen für Enterprise-Kund:innen und Technik je Bereich (Deutsch und Englisch)
```

Konfiguration nur über Umgebungsvariablen, siehe `.env.example`.

## Inhalt

```
docs/
  01-konzept-v2/        Überarbeitetes Prozesskonzept (pptx + Text)
  02-produktkonzept/    Produktkonzept intern & SaaS (md)
  03-umsetzungskonzept/ Umsetzungskonzept mit Backlog (md)
  05-review-v3/         360-Grad-Review V3 (Produkt/Technik, Markt/Wettbewerb) und Einarbeitung
  diagramme/            Diagramme als PNG
  release-0 … release-4/ Ergebnisse von Release 0, Umsetzungsstand je Story ab Release 1
  arbeitspakete.md      Arbeitspakete Version 3 mit Stand je Paket
backlog/
  backlog.csv           146 User Stories, Import z. B. in Jira
  backlog.json          dieselben Stories für Skripte
tools/
  extract_backlog.py    erzeugt backlog/ aus dem Umsetzungskonzept
  finanzmodell.py       rechnet das Finanzmodell V3 nach
  check-texts.mjs, check-security.mjs  Prüfungen für die CI
  build_konzeptdeck_v2.js  Skript, mit dem der Foliensatz v2 erzeugt wurde (pptxgenjs)
CLAUDE.md               Projektkontext für Claude Code
server/, web/           Anwendung (siehe oben)
```

## Kennzahlen

| Release | Inhalt | Stories | Story Points (Muss) |
| --- | --- | --- | --- |
| 0 | Grundlagen: UX, Architektur, Datenschutz, Verträge | – | – |
| 1 | MVP-Kernstrecke und Plattformbasis | 45 | 177 (165) |
| 2 | Ausarbeitung und KI-Analyse, Pilotreife | 53 | 251 (170) |
| 3 | Firmenfähig und Marktreife SaaS, Einsatzfelder, Modul Vorschlagswesen | 39 | 248 (158) |
| 4 | Lernendes System | 9 | 76 (42) |
| **Gesamt** | | **146** | **752 (535)** |

## Mit Claude Code weiterarbeiten

1. Repository klonen und Claude Code im Repo starten; `CLAUDE.md` liefert den Kontext.
2. Backlog nach Änderungen am Umsetzungskonzept neu erzeugen: `python3 tools/extract_backlog.py`
3. Nächste Schritte: die offenen Punkte am Ende von `docs/arbeitspakete.md` (Klicktest, Pilot, Prüfungen) und danach die Befunde daraus.
