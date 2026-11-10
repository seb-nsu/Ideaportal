# Review V3 – Teil 1: Produkt und Technik

Stand 12.10.2026 · Unabhängiger Senior-Review (Produktmanagement, UX, Softwarearchitektur) · Keine Rechtsberatung

Teil 2 (Business, Markt, Wettbewerb) erstellt ein zweiter Reviewer parallel. Schnittstellen dorthin stehen in Abschnitt 7.

## 0 Prüfgrundlage und Methode

**Vollständig gelesen:** `CLAUDE.md`, `README.md`, Produktkonzept (V2), Umsetzungskonzept (V2, Backlog R1–R4), Fable-Review (Stand vor V2), Umsetzungsstand Release 1 und 2, ADR 0001–0005, Bedrohungsmodell, Datenfluss, `docs/betrieb.md`, Release-0-UX (Navigation, Nutzerwege, Hauptbildschirme, Mobil und Barrierefreiheit, Papiertest), Überschriften und Auszüge der übrigen Release-0-Dokumente.

**Code stichprobenartig gelesen** (ca. 16.000 Zeilen TypeScript in `server/src` und `web/src`): `App.tsx` (Navigation, Rollen), `http.ts` und `lib/context.ts` (Sitzung, Mandantenkontext, Rollen), Migrationen (RLS-Mechanik), `ai/gateway.ts`, `ai/pipeline.ts`, `ai/search.ts`, `ai/hooks.ts`, `ai/settings.ts`, Auszüge aus `ai/agents.ts`, `ai/eval.ts`, `routes/ai.ts`, `routes/ideas.ts`, `routes/misc.ts`, `services/mailer.ts`, Seiten `Home`, `Board`, `IdeaDetail`, `Tasks`, `Dashboard`, `Submit`, `Account`, `AiPanel`, `Elaboration` (Gliederung), `styles.css`, `e2e/smoke.mjs`, `.github/workflows/ci.yml`, Testdateien (Anzahl und Namen).

**Nicht geprüft:** Die App wurde nicht gestartet; keine Tests ausgeführt; kein echter Modellaufruf; kein Screenreader- oder Lasttest; `services/workflow.ts`, `services/elaboration.ts` und `routes/elaboration.ts` nur per Suche, nicht gelesen; Inhalte von Datenschutz- und Business-Dokumenten aus Release 0 nur überflogen. Aussagen zu Codequalität gelten für die gelesenen Stellen.

**Gesamteindruck:** Der Stand ist deutlich weiter als das Konzept vermuten lässt. Release 1 und 2 sind nicht nur geplant, sondern gebaut, mit RLS, KI-Gateway, Qualitätstor, Audit-Log, Barrierefreiheitsprüfung in der CI. Das ist für ein Team dieser Größe bemerkenswert. Die größte Schwäche ist nicht der Code, sondern dass das Produkt noch nie von einer echten Nutzerin benutzt wurde (Papiertest offen, Pilot nicht gestartet) und dass einige Leitplanken des Konzepts (zweisprachig vorbereitet, API zuerst, Betrieb) im Code noch nicht eingelöst sind.

## 1 Zusammenfassung: Top-10-Befunde

| # | Befund | Prio | Verweis |
| --- | --- | --- | --- |
| 1 | **Validierungsschuld:** 81 Stories gebaut, null Nutzertests. Papiertest und Pilot sind offen; alle UX-Annahmen (Informationsdichte, Verständlichkeit der KI-Kennzeichnung, Prüflast) sind ungeprüft. | Muss | P-01 |
| 2 | **Autor:innen sehen den KI-Triage-Vorschlag inklusive Spur „Ablehnen“** vor der menschlichen Entscheidung (`routes/ai.ts`, `canSeeAi`, keine Filterung nach Ergebnisart gesehen). Widerspricht „KI ist nie die Antwort“ und schürt Misstrauen. | Muss | P-05 |
| 3 | **Eingebauter, regelbasierter Anbieter erzeugt Zahlen** (z. B. Business Case mit festen 5.000/15.000/40.000 € Einführungskosten in `agents.ts`). In Demo und bei jedem neuen Mandanten sehen Nutzer:innen scheinbare Analysen. Vertrauensrisiko für das Alleinstellungsmerkmal. | Muss | P-20 |
| 4 | **Sicherheits-Nacharbeit vor Demo und Pilot:** kein Rate-Limit (Login, Registrierung, Demo), TOTP-Geheimnis im Klartext, keine CSP/HSTS-Header, nur `x-frame-options`. Alles im Bedrohungsmodell bekannt, aber offen. | Muss | P-14 |
| 5 | **Betrieb (R1-05) ist offen:** keine Metriken, keine Alarme für Job-Fehler, Warteschlangenalter oder Mail-Rückstau; Wiederherstellung nie getestet. Das Hauptversprechen „Fristen laufen“ hängt an einem unbeobachteten 15-Minuten-Job. | Muss | P-15 |
| 6 | **„Zweisprachig vorbereitet“ ist nicht eingelöst:** alle Texte liegen fest in TSX und Serverantworten (Fehlertexte, Mails, Prompts). R3-22 (5 SP) ist bei ~16.000 Zeilen eine Nachrüstung von eher 13–20 SP. | Muss (R3), Vorbereitung jetzt | P-18 |
| 7 | **„API zuerst“ nur halb:** Oberfläche nutzt die API, aber es gibt keine API-Tokens, keine OpenAPI-Beschreibung, keine Webhooks. Konnektoren (R3) und Kundenintegrationen haben keinen Einstieg. | Soll (jetzt), Muss (R3) | P-16 |
| 8 | **Suche und Dubletten skalieren nicht:** `ILIKE` über verkettete Felder, `LIMIT 200` ohne Paginierung, Trigramm statt Embedding, kein `tsvector`. Für den Pilot gut, für Mandanten mit über 1.000 Ideen nicht. | Muss (R3) | P-12 |
| 9 | **Qualitätstor misst Form, nicht Wahrheit:** Der Testsatz prüft Spur, Stichworte, verbotene Inhalte. Ob Quellen existieren und das Zitat enthalten, prüft niemand; Websuche liefert nur Snippets, keine Seiteninhalte. „Belegt“ bedeutet also „ein Suchtreffer-Snippet passt“. | Soll | P-21 |
| 10 | **Informationsdichte auf der Ideenseite:** Idee, Gates, Umsetzung, Ausarbeitung (6 Blöcke), 13 KI-Ergebnisarten und Diskussion liegen auf einer Seite; der im UX-Konzept geplante eigene Steckbrief (`/ideen/:id/steckbrief`) existiert im Code nicht. Für Paten und Gremium zu viel auf einmal. | Soll | P-03 |

## 2 Prüfung der alten Befunde (Fable-Review vor V2)

Nur die Punkte, bei denen das Umsetzungskonzept „gelöst“ sagt. Business-Befunde (Segment, SaaS-Case, Rechte) gehören zu Teil 2.

| Alter Befund | Status in Konzept V2 | Status im Code | Bewertung |
| --- | --- | --- | --- |
| Keine UX-Artefakte | Release 0: Nutzerwege, Navigation, Skizzen, Matrix, Textvorlagen | Navigation stimmt mit `App.tsx` überein; Skizzen 1–4, 7 entsprechen dem Bau | **gelöst**, aber Papiertest offen |
| Umsetzungsverfolgung nach Gate 2 fehlt | R1-31, R1-32 | Abschnitt „Umsetzung“ mit Abschluss und Ist-Nutzen, Verzugserinnerung im Job | **gelöst** |
| Mandantentrennung zu dünn | R1-03 mit 8 SP | RLS mit `FORCE`, Policy-Schleife über alle Tabellen mit `tenant_id` (001, 003, 004), App-Rolle ohne Eigentum, Test mit zwei Mandanten | **gelöst**, vorbildlich |
| Kein lokaler Login | R1-09 | Konten, TOTP, Sperre, Einladung, Reset | **gelöst**; Firmen-Login (R1-08) zurückgestellt |
| Betrieb ohne Budget nicht gelöst | R1-02, R1-05 | CI mit Tests, Audit, e2e; Staging, Geheimnisverwaltung, Monitoring offen | **teilweise** |
| Audit-Log fehlt | R1-06 | nur anhängbar per Trigger, CSV-Export | **gelöst** |
| Websuche nicht datenschutzfest | R2-14 | Anfragen werden im Code aus Stichworten gebaut (nicht vom Modell), Namen, Mandant, interne Begriffe entfernt; vertraulich nie gesucht | **gelöst**, sogar strenger als ADR 0005 beschreibt (dort formuliert das Modell die Anfrage) |
| Zufriedenheit nicht erhoben | R1-35 | Abfrage auf der Ideenseite, aggregiert ab 5 | **gelöst** |
| Kein Onboarding | R1-38 | 3-Schritt-Rundgang, Beispielidee, FAQ | **gelöst**, aber nicht rollenbezogen |
| Mobile nur Absicht | AK in R1-12/16/21/27 | Breakpoints 860/720 px, e2e mit 390 px, Aktionen mobil zuerst | **gelöst** für die Kernaufgaben |
| Barrierefreiheit ohne Ziel | R1-42 | axe in CI, Skip-Link, `aria-current`, Dark Mode | **teilweise** (manueller Test offen) |
| Vertretung fehlt | R1-11 | vorhanden | **gelöst** |
| Idee-Typ als Steuerlogik | R2-26/27 getrennt | `pipeline.ts`: `market_size` nur bei Produkt, sonst `internal_market` | **gelöst** |
| S1-24 Echtzeit-Kollaboration unrealistisch | R2-02 Abschnittssperre | Sperre je Abschnitt, 30 Min. einstellbar | **gelöst** |

Fazit: Die technischen und funktionalen Befunde von damals sind weitgehend abgearbeitet. Offen bleiben Betrieb, manuelle Barrierefreiheitsprüfung und der Nutzertest.

## 3 Dimension 1: UI/UX

**Stärken**

- Navigation ist je Rolle sinnvoll gestuft (Ideengeber:in 6 Punkte, Triage/Gremium 10, Admin 11). Rechte serverseitig; Menü und API stimmen überein.
- Ideenseite zeigt immer Status, Restfrist in Arbeitstagen und nächsten Schritt; Aktionen (Rückfrage, Zufriedenheit, Urheberschaft) stehen mobil oben (`order: -1`).
- KI-Darstellung ist handwerklich gut: Badge „KI-Entwurf“, je Aussage Belegt/Annahme/Schätzung mit Farbe **und** Text, Quellen mit Abrufdatum, Konfidenz als Text, Korrekturen mit Grund sichtbar, Änderungen gegenüber Vorversion. Kurzanalyse und Triage-Vorschlag offen, alles andere eingeklappt.
- Barrierefreiheit ist ernst gemeint: axe in der Pipeline, Skip-Link, `sr-only`-Überschriften, `aria-current="step"`, `aria-live`, Dark Mode, Druck-CSS.
- Benachrichtigungen: sofort, täglich, aus; Kategorien stummschaltbar; Matrix mit 21 Ereignissen und Tonalität dokumentiert.
- Motivation ohne Punktesystem: Unterstützen, Erfolge, Nennung nur mit Zustimmung, Urkunde, Jury-Rangliste. Für DACH-Unternehmen mit Betriebsrat die richtige Zurückhaltung.

**Befunde**

| ID | Befund | Auswirkung | Empfehlung | Prio |
| --- | --- | --- | --- | --- |
| P-01 | Kein einziger Nutzertest; Papiertest (7–8 Personen) steht als „Offen (Product Owner)“. | Alle folgenden UX-Urteile sind Expertenmeinung, keine Evidenz. Fehlentwicklungen in Release 2 (Steckbrief, KI-Panel) werden spät entdeckt. | Klicktest mit der Demo in den nächsten 2 Wochen; Aufgaben aus `papiertest.md` nutzen; Befunde als Stories. | Muss |
| P-02 | Onboarding ist für alle gleich (3 Schritte, Beispielidee). Triage, Pate, Gremium und Admin bekommen keine Einführung in ihre Aufgaben, Fristen und die KI-Vorschläge. | Triage versteht Ampel und Spuren erst durch Probieren; Paten wissen nicht, was „prüfen statt recherchieren“ heißt. | Rollenbezogener Erststart (3 Schritte je Rolle) plus Checkliste „Deine erste Woche“ auf „Meine Aufgaben“. | Soll |
| P-03 | Ideenseite trägt alles: Idee, Gate 1, Gate 2, Umsetzung, Ausarbeitung (Steckbrief, Schätzungen, Scorecard, Experimente, Gate 3, Erfolgsgeschichte), 13 KI-Ergebnisarten, Verlauf, Diskussion, Anhänge, Co-Autor:innen, Dublette, Zusammenführen. Die geplante Route `/ideen/:id/steckbrief` (`navigation.md`) fehlt. | Paten und Gremium scrollen; die „eine Seite Zusammenfassung vorn“ (R2-31) geht in der Masse unter. | Steckbrief als eigene Seite mit Reitern (Zusammenfassung, Analysen, Scorecard, Experimente, Wirkung); Ideenseite zeigt nur Kurzfassung und Link. | Soll |
| P-04 | Leerzustände sind Einzeiler („Noch keine Ideen.“, „Gerade gibt es nichts für dich zu tun.“). Challenges und Erfolge verschwinden ganz, wenn leer. | Ein neuer Arbeitsbereich wirkt leer; die Startseite erklärt nicht, was als Nächstes sinnvoll ist (Challenge anlegen, Kolleg:innen einladen, Bestand importieren). | Leerzustände mit nächstem Schritt und Knopf je Rolle (Admin: einladen, importieren, Challenge; Ideengeber:in: erste Idee). | Soll |
| P-05 | Autor:innen sehen alle KI-Ergebnisse ihrer Idee, auch den Triage-Vorschlag mit Spur und Begründung (`canSeeAi` erlaubt Autor:innen; Filterung nach `kind` im gelesenen Code nicht gefunden). | Vorschlag „Ablehnen“ wirkt als Vorentscheidung; die menschliche Antwort kommt danach. Genau das Risiko, das `nutzerwege.md` Schritt 6 nennt. | Triage-Vorschlag und Rückmeldungsentwurf nur für Triage, Gremium, Pate; Autor:innen sehen Kurzanalyse ohne Spur-Empfehlung. Bitte im Code verifizieren. | Muss |
| P-06 | Mobile Navigation scrollt horizontal (`overflow-x: auto`), kein Menü; `navigation.md` beschreibt ein zusammenklappendes Menü. | Mit 10 Menüpunkten (Triage) sind rechts liegende Punkte unsichtbar; kein Hinweis auf weitere Punkte. | Ab 720 px Menü-Knopf mit `aria-expanded` oder Fokus auf 4 Punkte plus „Mehr“. | Soll |
| P-07 | Manuelle Barrierefreiheitsprüfung (Tastatur, Screenreader, Zoom, Kontrast) offen; axe findet nur etwa 30–40 % der WCAG-Kriterien. | WCAG-2.1-AA-Aussage ist noch nicht belastbar; für öffentliche Kunden (BITV) riskant. | Prüfplan Ebene 3–5 vor dem Pilot abarbeiten; Befunde als Stories. | Muss (vor Marktstart), Soll (Pilot) |
| P-08 | Alle UI-Texte hart kodiert, Deutsch; Dateien wie `Admin.tsx` (688 Zeilen) und `Elaboration.tsx` (910 Zeilen) mischen Text und Logik. | Siehe P-18; außerdem erschwert es Textpflege und die Textvorlagen-Konfiguration je Mandant über die heutigen `texts.*` hinaus. | Textkatalog einführen (siehe V-11). | Soll |
| P-09 | KI-Kosten und Modell nur im Tooltip des Badges; kein sichtbarer Zustand „von Pate geprüft“ an einem Ergebnis (Übernahme per Klick existiert, ein sichtbarer Prüfstatus je Baustein nicht erkennbar). | Gremium kann nicht unterscheiden, ob ein Steckbrief geprüft oder roh ist; die Skizze in `hauptbildschirme.md` („geprüft: nein“) ist nicht umgesetzt. | Prüfstatus je Baustein (ungeprüft, geprüft, korrigiert) mit Person und Datum; Pflicht vor Gate 2 einstellbar. | Soll |
| P-10 | Keine Nutzen-Rückmeldung zu KI-Ergebnissen („war das hilfreich?“); Qualität in Nutzung misst nur Trefferquote Triage und Korrekturquote. | Ob Paten die Analysen überhaupt lesen, bleibt unbekannt; die Hypothese „6 Wochen auf 1–2“ ist nicht messbar. | Ein-Klick-Bewertung je Ergebnis plus Lesezeit und Aufklappquote in der Qualitätsansicht. | Soll |
| P-11 | Ideenliste und Feed ohne Paginierung (`LIMIT 200`), ohne gespeicherte Filter, ohne Sortierung nach Frist außerhalb des Boards. | Ab einigen hundert Ideen fehlt Orientierung; Volltextsuche ist nur `ILIKE`. | Siehe P-12 und V-13. | Soll |

**Nutzerwege je Rolle (Kurzurteil)**

| Rolle | Weg im Code | Urteil |
| --- | --- | --- |
| Ideengeber:in | Start → Einreichen (4 Schritte, ähnliche Ideen, Abgrenzung) → Status/Restfrist → Rückfrage → Rückmeldung → Zufriedenheit → Erfolge | vollständig; Risiko P-05 |
| Triage | Board (5 Spalten, Ampel) → Idee → KI-Vorschlag, Rückfrage, Spur mit Vorlage oder KI-Entwurf → Weiterleiten, Zusammenführen | vollständig; Onboarding fehlt (P-02) |
| Pate | Aufgaben → Steckbrief auf der Ideenseite → Analysen prüfen, korrigieren → Scorecard → Gate 2 | funktional, zu dicht (P-03) |
| Gremium | Gremium → Sitzung mit Agenda, Vergleich, Entscheidung | vorhanden (Code nicht im Detail gelesen) |
| Umsetzer:in | Aufgaben → Umsetzung pflegen → Abschluss mit Ist-Nutzen → Wirkungsreview | vollständig |
| Admin | Registrieren → MFA → Rundgang → Einstellungen (14 Reiter) → Einladen → Import → KI | vollständig; 14 Reiter ohne Priorisierung (P-04) |

## 4 Dimension 2: Architektur

**Stärken**

- Mandantentrennung in der Datenbank, nicht im Anwendungscode: `FORCE ROW LEVEL SECURITY`, Policy je Tabelle per Schleife, App-Rolle ohne Tabelleneigentum, Systemverbindung nur für Anmeldung, Jobs, Migrationen. Test mit zwei Mandanten. Das ist der richtige Schnitt für SaaS.
- KI-Gateway (`gateway.ts`) tut, was ADR 0004 verspricht: Routing vertraulich → nur lokal, Budget je Idee und Monat, Protokoll je Aktion in eigener Transaktion, Schema-Prüfung mit einem Korrekturversuch, Modell-Fallback protokolliert, Freigabe über Konfigurations-Hash mit begründeter Ausnahme.
- Research-Anfragen werden im Code gebaut (Stichworte), nicht vom Modell; Anonymisierung gegen Nutzer-, Mandanten- und interne Begriffe; Protokoll der Anfragen.
- Job-Design ohne Broker: Advisory-Lock für Regel-Jobs, `FOR UPDATE SKIP LOCKED` für KI-Jobs, idempotente Marker, Backoff, hängende Jobs zurücksetzen. Ideenfluss wartet nie auf KI.
- Tests gegen echte PostgreSQL (13 Dateien, ca. 130 Fälle), e2e mit axe auf Desktop und 390 px, CI mit Typecheck, Audit, Build. Einstellungen je Mandant per zod-Schema validiert.
- Betriebsmodell schlank: eine App, eine Datenbank, Konfiguration nur über Umgebungsvariablen; Render-Blueprint und Docker Compose.

**Befunde**

| ID | Befund | Auswirkung | Empfehlung | Prio |
| --- | --- | --- | --- | --- |
| P-12 | Suche: `ILIKE` über vier verkettete Textfelder ohne Index, Listen mit festem `LIMIT 200`, Board lädt alles; Dubletten per Trigramm; pgvector nicht installiert (ADR 0001: „folgt“). | Ab etwa 1.000–5.000 Ideen je Mandant wird die Startseite langsam; Dublettenqualität ist für Paraphrasen schwach (R1-19 „teilweise“). | `tsvector`-Spalte mit GIN-Index und Cursor-Paginierung; pgvector mit lokalem Embedding hinter der bestehenden Schnittstelle `GET /api/ideas/similar`. | Muss (R3) |
| P-13 | Eine Datenbank, ein Schema, ein `SECRET_KEY` für alle Mandantenschlüssel; keine Plattform-Rolle, keine Support-Konsole. Mandanten-Einstellungen als ein JSONB-Blob (`tenants.settings`). | Für Pilot richtig; für Enterprise-Kunden fehlen Schlüssel je Mandant (R3-01), Schlüsselrotation und ein kontrollierter Support-Zugriff (R3-07). Gleichzeitige Einstellungsänderungen überschreiben sich (letzter gewinnt). | R3-01 und R3-07 behalten; Rotation von `SECRET_KEY` als Betriebsprozedur jetzt dokumentieren; Einstellungen mit Versionsnummer (optimistisches Sperren). | Soll |
| P-14 | Kein Rate-Limit (Grep nach „rate“ in `server/src`: nichts), TOTP-Geheimnis im Klartext, Sicherheits-Header nur `x-frame-options`, `npm audit` blockiert erst bei „critical“. Alles im Bedrohungsmodell als offen gelistet (T-S2, T-I8, T-D2, T-D3). | Öffentliche Demo und Selbstregistrierung sind ohne Rate-Limit ein Einfallstor für Credential Stuffing und Massenregistrierung. | Vor Veröffentlichung: Rate-Limit je IP und Konto, CSP und HSTS, TOTP verschlüsseln, Audit-Level „high“. | Muss |
| P-15 | Betrieb (R1-05) offen: kein `/metrics`, keine Alarme, kein strukturiertes Log mit Prüfung „keine Ideentexte in Logs“ (Datenfluss F11 „zu prüfen“), Wiederherstellung nie getestet, Staging fehlt. | Fällt der 15-Minuten-Job aus, laufen Fristen, Erinnerungen und Mails still ins Leere. Das ist genau das Versprechen des Produkts. | Mindestpaket: Health erweitert um Job-Alter, Queue-Länge, Outbox-Rückstau; Alarm per Mail oder Webhook; Restore-Test einmal durchführen und dokumentieren; Staging als zweiter Render-Dienst. | Muss |
| P-16 | API nur mit Cookie-Sitzung; keine API-Tokens, keine OpenAPI-Beschreibung, keine Webhooks. 136 Routen ohne maschinenlesbare Doku. | Leitplanke „API zuerst“ ist nur intern erfüllt. Konnektoren (R3-13 bis R3-17), Teams-Bot und Kundenintegrationen brauchen zuerst Auth und Doku. | OpenAPI aus den vorhandenen zod-Schemas erzeugen (günstig), Mandanten-Tokens mit Rollen, Webhooks bei Statuswechseln (R3-17 vorziehen, mindestens Teil 1). | Soll (jetzt), Muss (R3) |
| P-17 | KI-Worker holt je Takt (5 s) einen Job je Instanz; Vollanalyse ist eine Kette aus Recherche plus 9 Agentenaufrufen, sequenziell. Budgetprüfung vergleicht nur bisherige Ausgaben mit dem Limit, keine Schätzung oder Reservierung vor dem Aufruf (ADR 0004 behauptet eine Schätzung). | Ein Mandant mit 30 Einreichungen am Tag blockiert Kurzanalysen anderer Mandanten; Budget kann um einen Aufruf überschritten werden. Für den Pilot unkritisch. | Parallelität je Instanz konfigurierbar, Fairness je Mandant (Round-Robin), Kostenschätzung vor dem Aufruf; Queue-Kennzahlen ins Monitoring. ADR anpassen oder Code. | Soll |
| P-18 | Keine Internationalisierung: keine Textdatei, keine Bibliothek; Texte in TSX, Fehlermeldungen im Server, Prompts und Mails Deutsch. Produktkonzept-Bauregel 3 („zweisprachig vorbereitet“) ist nicht erfüllt. | R3-22 mit 5 SP ist unrealistisch; Nachrüstung über ~16.000 Zeilen plus Serverfehler, Mails, KI-Ausgabesprache eher 13–20 SP. Jede weitere Story erhöht die Schuld. | Jetzt Textkatalog (z. B. flache JSON-Datei je Sprache) für neue Stories verpflichtend; Bestand schrittweise; Sprache je Person im Profil; KI antwortet in Nutzersprache. | Muss (R3), Vorbereitung Soll (jetzt) |
| P-19 | Technische Schulden in der Struktur: `agents.ts` 1.005, `workflow.ts` 897, `Elaboration.tsx` 910, `routes/ai.ts` 728, `Admin.tsx` 688 Zeilen; Migration 004 legt 15 Tabellen in einem Schritt an; ADR 0001 weiterhin „vorgeschlagen“. Keine Frontend-Tests außer e2e. | Erschwert Einarbeitung eines zweiten Entwicklers und gezielte Tests einzelner Agenten. | Agenten in Module je Baustein; Ausarbeitungs-Seite in Komponenten je Reiter; ADR 0001 bestätigen. Kein eigenes Projekt, sondern Regel „bei Berührung aufteilen“. | Kann |
| P-21 | Qualitätstor misst Spur-Treffer, Stichwort-Abdeckung, verbotene Inhalte und Injection-Resistenz. Quellen werden nicht geprüft (Erreichbarkeit, Zitat enthalten). Research nutzt nur Suchtreffer-Snippets, keine Seiteninhalte (in `search.ts` keine Seitenabrufe; Datenfluss F8 beschreibt „Quellenabruf“). | „Belegt“ ist formal (Quelle verlinkt), nicht inhaltlich. Preise, Marktzahlen und Funktionen aus Snippets sind oft veraltet oder werblich. | Quellenprüfung ins Qualitätstor (URL erreichbar, Zitat im Text, Anteil belegter Zahlen); Seitenabruf für die 3–5 wichtigsten Treffer mit Längenbegrenzung und Einzäunung; monatliche menschliche Stichprobe je Baustein. Datenfluss-Dokument korrigieren. | Soll |
| P-22 | Dokument und Code weichen an Stellen voneinander ab: ADR 0005 (Modell formuliert Anfrage) vs. Code (Stichworte), Datenfluss F8 (Seitenabruf) vs. Code (nur Snippets), `navigation.md` (eigener Steckbrief, Menü klappt) vs. Code. | Datenschutzprüfung und Pentest arbeiten mit falschen Annahmen. | Abgleich ADR/Datenfluss mit Code vor dem Sicherheitsreview; Dokument sagt künftig „Stand im Code“. | Soll |
| P-23 | Mail: Outbox mit Versandjob, aber keine Bounce-Behandlung; Betreff vertraulicher Ideen enthält Titel (T-I10 offen). | Falsche Adressen bleiben unbemerkt; vertrauliche Titel landen in fremden Postfächern (Vertretung, Weiterleitungsregeln). | Betreff ohne Titel bei vertraulich; Bounce-Adresse mit einfacher Auswertung; Status „nicht zustellbar“ an der Person. | Muss (Betreff), Soll (Bounce) |

**Skalierbarkeit (Einschätzung):** Eine Instanz plus verwaltete PostgreSQL trägt den Pilot und erste Kunden problemlos. Grenzen liegen in der Reihenfolge: Suche und Listen (P-12), KI-Fairness zwischen Mandanten (P-17), dann Datenbank-Trennung für Enterprise (P-13). Horizontale Skalierung ist durch Advisory-Locks und `SKIP LOCKED` vorbereitet.

## 5 Dimension 3: Funktionen und Umfang

**Stärken**

- Release 1 und 2 sind als Schnitt richtig: Kernstrecke plus Nutzen im MVP, KI darauf. Alle kritischen Lücken des alten Reviews sind im Code (Umsetzung, Ist-Nutzen, Wiedervorlage, Vertretung, Import, Zufriedenheit, Challenge).
- Challenges mit eigenem Formular, Teams, Jury und Rangliste (R2-35) sind bereits ein Hackathon-Grundgerüst.
- Nutzenarten enthalten schon Euro, Stunden, Qualität, Umsatz und CO₂ (R1-32).
- Einstellungen je Mandant decken Fristen, Schwellen, Themenfelder, Feiertage, Zielkanäle, Abgrenzungsregeln, Texte, Ausarbeitung, Scorecard, Löschfristen, KI. „Einstellungen statt Code“ ist eingelöst.

**Befunde**

| ID | Befund | Auswirkung | Empfehlung | Prio |
| --- | --- | --- | --- | --- |
| P-24 | Rechte sind mandantenweit flach: Triage, Gremium, Dashboard gelten für den ganzen Mandanten. Kein Scoping nach Bereich, Standort oder Themenfeld; `org_unit` ist nur ein Textfeld der Person. | Zielgruppe ab 250, Business-Paket bis 2.500 Mitarbeitende: dort triagieren mehrere Teams. Ohne Scoping sehen alle alles oder man braucht je Bereich einen Mandanten (und verliert den Portfolio-Blick). | Bereich als Stammdatum; Rollen optional je Bereich oder Themenfeld; Board, Aufgaben, Dashboard filtern. | Soll (R3) |
| P-25 | Firmen-Login (R1-08) zurückgestellt; kein SCIM, keine Gruppen-Rollen-Abbildung. | Jeder Firmenkunde verlangt SSO; ohne IdP keine Nutzerpflege bei 1.000 Personen. | R1-08 als erste Story von Release 3 (OIDC zuerst, Entra ID), SCIM als Kann. | Muss (R3) |
| P-26 | Kanäle: nur E-Mail und Glocke. Teams (R3-16) ist Soll, Slack fehlt im Backlog. Produkt- und Innovationsteams leben in Teams oder Slack. | Rückfragen werden übersehen, Fristen laufen ab; der Weg „aus der Mail mit einem Tipp“ ist bei Unternehmens-Mailfiltern schwach. | Teams-Benachrichtigung auf Muss (nur eingehender Webhook, 3 SP), Slack analog als Kann; Einreichen aus Teams bleibt Soll. | Soll |
| P-27 | Reporting: Dashboard mit 6 Kennzahlen, Trichter, Nutzen je Art, Ideen je Bereich (ab 5). Kein Zeitverlauf, keine Challenge-Auswertung, kein Vergleich gegen Ausgangswerte (`ausgangswerte.md`), kein KI-Kosten-Bericht je Mandant außerhalb des KI-Protokolls. | Go/No-go-Kriterien (Fristtreue, Ist-Nutzen, Zufriedenheit) sind ablesbar, aber nicht über die Zeit; Innovationsleitung braucht Quartalsbericht. | Zeitreihen je Kennzahl, Challenge-Bericht, Ausgangswert als Linie, Export als PDF oder Markdown. | Soll |
| P-28 | Crowd-Bewertung: nur „unterstützen“ (ein Klick). Keine strukturierte Einschätzung durch die Community (z. B. Nutzen und Umsetzbarkeit 1–5), obwohl das Konzept „Basis drückt“ als Prinzip nennt. | Triage sieht Popularität, nicht Einschätzung; bei Produktideen fehlt die Stimme der Kolleg:innen aus Vertrieb und Service. | Optionale Community-Einschätzung je Challenge (2 Fragen), aggregiert, nie personenbezogen. | Kann |
| P-29 | Problem ohne Lösung lässt sich nicht einreichen (Formular verlangt Problem, Idee, Nutzen). Problem-Radar kommt erst R4. | Mitarbeitende mit Beobachtung, aber ohne Lösung bleiben draußen; genau daraus entstehen Challenges. | Ideentyp „Problem“: Lösung optional, Community schlägt Lösungen vor, Triage kann ein Problem zur Challenge machen. | Soll |
| P-30 | Überdimensioniert für den Start: Patentrecherche über Websuche (R2-24, nur Google-Patents-Snippets), Positionierungskarte und Marktgröße für jede Produktidee, 9 Bausteine je Vollanalyse. Release 4: Portfolio-Simulator und Kalibrierung ohne Datenbasis (eigene AK: ab 20 Ideen). | Prüflast und Kosten je Idee steigen; Patent-Hinweise aus Snippets erzeugen Scheinsicherheit. | Vollanalyse-Bausteine je Mandant und Ideentyp zuschaltbar (heute nur je Agent); Patente standardmäßig aus bis EPO OPS angebunden; R4-07/R4-09 bleiben Kann. | Soll |
| P-31 | Import/Export: CSV-/Excel-Import mit Vorschau, JSON-Vollexport, CSV für Audit und Dashboard. Kein Import von Personen und Rollen, kein Export je Idee (Steckbrief als Datei), nur Druck-CSS. | Für Gremiumsunterlagen per Mail und für Archivierung fehlt ein Dokumentformat. | Steckbrief und Gate-2-Vorlage als PDF oder DOCX exportieren; Personenimport per CSV bis SCIM kommt. | Kann |
| P-32 | Backlog-Schätzung R3: R3-22 (i18n) 5 SP zu niedrig (P-18); R3-17 (API, Webhooks) 8 SP ohne Token-Verwaltung und OpenAPI knapp; R1-05 ohne konkrete AK für Alarme. | Release 3 wird größer als 155 SP. | Neu schätzen: R3-22 auf 13, R3-17 auf 13 (oder teilen), R1-05 mit AK aus P-15. | Soll |

**Was fehlt im Backlog ganz:** Slack, SCIM, Bereichs-Scoping, Problem-Typ, Zeitreihen-Reporting, Steckbrief-Export, Rate-Limit als Story, Monitoring-Kennzahlen als Story, Prüfstatus je KI-Baustein, KI-Nutzenbewertung.

**Was gestrichen oder geparkt werden kann:** R2-24 Patente bis zur Datenbank-Anbindung auf „aus“; R4-09 Simulator und R4-10 Konsistenz-Check bleiben Kann; R3-24 Prämienregeln bleibt Kann (Zielgruppe Innovationsteams, nicht BVW).

## 6 Dimension 4: Sinnhaftigkeit

**Löst das Produkt die Kernprobleme?**

| Kernproblem | Mechanik im Code | Urteil |
| --- | --- | --- |
| Ideen versanden | Fristen in Arbeitstagen, Pause bei Rückfrage, Erinnerung, Eskalation an Vertretung oder Admin, Schließen nach 15 AT, Wiedervorlage automatisch, Verzugserinnerung in der Umsetzung | **ja**, solange der Job läuft (P-15) |
| Keine Antwort | Spur mit Pflichtbegründung, Textvorlagen, KI-Entwurf der Rückmeldung, Zufriedenheitsabfrage, Zielkanal mit Ansprechperson beim Weiterleiten | **ja** |
| Kein Nutzennachweis | Umsetzung mit Ist-Nutzen in fünf Nutzenarten, Wirkungsreview nach einstellbaren Monaten mit Sponsor-Bestätigung, Realisierungsquote im Dashboard | **strukturell ja**; Belastbarkeit hängt an Selbstauskunft, Controlling-Bestätigung erst R4-05 |
| Gremium als Engpass | Delegationsschwelle (Bereichsleitung), Sitzung mit höchstens 5 Ideen, Vergleichsansicht, Gate-2-Vorlage, Gegenargumente | **ja** |

**KI-Ausarbeitung für jede Idee: sinnvoll oder zu laut?**

- **Kurzanalyse für jede Idee** ist richtig, wenn sie der Triage dient: Vollständigkeit, Themenfeld, Spur-Vorschlag, ähnliche Ideen, interner Hebel. Das ist im Code so (`short_analysis` plus `triage_suggestion`). Die Websuche in der Kurzanalyse (eine Anfrage) ist für Produktideen nützlich, für die Mehrzahl interner Ideen Rauschen und Kosten. Empfehlung: Websuche in der Kurzanalyse je Ideentyp einstellbar, Standard für interne Ideen aus (V-07).
- **Vollanalyse** mit 9 Bausteinen nur bei Spur „Ausarbeiten“ ist der richtige Auslöser. Kosten sind begrenzt (5 € je Idee, 200 € je Monat Standard). Bei 400 Ideen im Jahr und 25 % Ausarbeitung sind das grob 100 Vollanalysen; mit den hinterlegten Listenpreisen liegt eine Vollanalyse eher bei 0,50–2 € als bei 5 €. Kosten sind kein Problem, Prüflast schon (P-03, P-09).
- **Das größte Risiko ist Scheinpräzision** (P-20): Der eingebaute Anbieter liefert Business Cases mit festen Beträgen, der Websuche-Pfad liefert „Belegt“ auf Snippet-Basis (P-21), und der Autor sieht die KI-Spur vor dem Menschen (P-05). Diese drei Punkte entscheiden, ob das Alleinstellungsmerkmal Vertrauen gewinnt oder verspielt.

| ID | Befund | Auswirkung | Empfehlung | Prio |
| --- | --- | --- | --- | --- |
| P-20 | Eingebauter, regelbasierter Anbieter erzeugt vollständige Analysen mit Zahlen (Business Case mit festen Kostenspannen, Hebel mit Standardwerten 20–100 Personen, 50–220 Vorgänge). Kennzeichnung „Schätzung“ und Badge „(regelbasiert)“ sind vorhanden, aber die Form ist identisch mit echten Analysen. Standard für jeden neuen Mandanten und die Demo. | Erste Begegnung mit dem Produkt zeigt Platzhalterzahlen als Analyse. Entscheider:innen testen genau damit. Gegenteil von „Vertrauen ab Werk“. | Eingebauter Anbieter liefert Struktur, Fragen und Rechenformeln ohne Beträge; deutlicher Hinweis „Platzhalter, kein Modell eingerichtet“ mit Link zu Einstellungen; Demo mit einem echten, budgetierten Modell und Vorab-Ergebnissen aus dem Seed. | Muss |
| P-33 | Hypothese „Ausarbeitung von 6 Wochen auf 1–2“ hat im Produkt keine Messung: Timebox-Start und Gate-2-Datum existieren, aber keine Kennzahl „Dauer Ausarbeitung“ im Dashboard und kein Vergleich mit `ausgangswerte.md`. | Der Pilot kann die Kernhypothese nicht belegen. | Kennzahl Durchlaufzeit je Phase (Einreichung → Gate 1 → Gate 2 → Umsetzung) mit Median und Ausgangswert. | Muss (Pilot) |
| P-34 | „KI entscheidet nie“ gilt im Code (Entscheidungen nur über menschliche Routen). Aber: Triage-Vorschlag mit Konfidenz plus Rückmeldungsentwurf plus Vorlage machen „Übernehmen mit einem Klick“ zum Standardweg. | Automatisierungs-Bias; Trefferquote wird gemessen, aber eine hohe Trefferquote kann auch Nachgeben sein. | Trefferquote getrennt nach „übernommen ohne Änderung“ und „geändert“; Stichprobe mit verdeckter Zweitbewertung je Quartal. | Soll |
| P-35 | Vertrauliche Ideen ohne lokales Modell: Gateway blockiert korrekt (`AI_CONFIDENTIAL`). Für Pilotkunden ohne Ollama heißt das: vertrauliche Ideen bekommen gar keine KI, auch keine Kurzanalyse. | Genau die wertvollsten Produktideen laufen ohne Unterstützung; Kunden merken das erst im Betrieb. | In Einstellungen deutlich zeigen, welche Ideen ohne KI laufen; Option „EU-Anbieter mit Vertrag für vertraulich zulassen“ als bewusste Admin-Entscheidung mit Protokoll (Datenschutzprüfung nötig). | Soll |

**Risiken (Produkt und Technik):** Validierungsschuld (P-01), Vertrauensverlust durch Platzhalter und Snippet-Belege (P-20, P-21), stiller Job-Ausfall (P-15), Sicherheitslücke in der öffentlichen Demo (P-14), Nachrüstkosten i18n und API (P-16, P-18), Schlüsselperson: ein Entwickler kennt 16.000 Zeilen (P-19).

## 7 Dimension 5: Use-Cases und weitere Einsatzfelder

Der Kern (Einreichen → Triage mit Frist → Ausarbeiten mit KI → Entscheiden → Umsetzen → Wirkung) trägt mehrere Felder. Bewertung nach Aufwand auf dem heutigen Code.

| Einsatzfeld | Was heute schon da ist | Was fehlt | Aufwand | Empfehlung |
| --- | --- | --- | --- | --- |
| **Nachhaltigkeitsideen (ESG)** | Nutzenart CO₂ (R1-32), Challenges, Dashboard je Nutzenart | Challenge-Vorlage, Kennzahl kWh, Export für Nachhaltigkeitsbericht | sehr gering (3 SP) | jetzt mitnehmen (V-18) |
| **Hackathons / Ideenwettbewerbe** | Teams, Jury, Kriterien, Rangliste, eigenes Formular (R2-35) | Einreichfenster, Pitch-Reihenfolge, optionales Publikumsvoting, Team-Seite | gering (5 SP) | R3, als Einstiegsangebot für Innovationsabteilungen (V-20) |
| **Kostensenkungs- und Effizienzprogramme** | Challenge, Ist-Nutzen in Euro, Wirkungsreview, Portfolio-Summen | Zielwert je Challenge, Fortschritt gegen Ziel, Controlling-Bestätigung (R4-05 vorziehen) | gering (5 SP) | R3 (V-19) |
| **Problembörse / Mitarbeiterbeobachtungen** | Formular, Community, Challenge-Vorschläge aus Strategie | Ideentyp „Problem“ ohne Lösung, Lösungsvorschläge der Community, Problem → Challenge | gering (5 SP) | R2-Nacharbeit oder R3 (V-17); Vorstufe zum Problem-Radar R4-01 |
| **KVP / kontinuierliche Verbesserung** | Schnellspur, Einreichen im Namen anderer, Ist-Nutzen, Delegation | Kiosk/QR-Einreichung ohne Konto, Schichtkalender, Prämien (R3-24 Kann), Mehrsprachigkeit, Bereichs-Scoping | mittel | erst nach Segmententscheidung (Teil 2); technisch durch Bereichs-Scoping (V-14) und i18n (V-11) vorbereitet |
| **Kundenfeedback / Feature-Wünsche** | Ideentyp Produkt, Unterstützen, Status, Benachrichtigung | Rolle Externe:r (R3-19), öffentliche Status-Seite (R3-20), Moderation (R3-21), Branding, Jira (R3-13) | mittel (im Backlog) | R3 wie geplant; Marktdruck durch Canny/Productboard beachten (Teil 2) |
| **Open Innovation mit Externen (Start-ups, Hochschulen)** | Vertraulichkeit, Patent-Hinweis, Challenges | Externe Rolle, Einwilligung zu Nutzungsrechten je Challenge, NDA-Hinweis, getrennte Sichtbarkeit | mittel | R3 mit R3-19 bündeln (V-21) |
| **Lieferanten-Innovation** | wie Open Innovation plus Erfindungsprüfschritt (R3-25) | Lieferanten-Stammdaten, Einkauf als Rolle | mittel | Kann; nur bei Industriekunden |
| **Lessons Learned / Maßnahmen aus Gate 3** | Wirkungsreview mit „Nachsteuern“ | Folgeobjekt „Maßnahme“ mit Owner und Frist | gering | Kann |
| **Start-up-Scouting** | Wettbewerbsagent, Positionierung | eigenes Objekt „Start-up“, Datenquellen, Scoring-Modell | hoch | nicht jetzt; verwässert den Kern |
| **Öffentlicher Sektor** | WCAG-Arbeit, On-Premise per Docker, Datenschutz-Dokumente | BITV-Prüfung, Personalvertretung in Texten, Vergabedokumente | mittel | nach Marktstart; Barrierefreiheit (P-07) zahlt darauf ein |

Die drei günstigsten Felder (Nachhaltigkeit, Hackathon, Kostensenkung) stärken das Kernversprechen „Wirkung belegen“ und brauchen zusammen etwa 13 SP.

## 8 Schnittstellen zum Business-Review (Teil 2)

- **Pakete und Preise:** Der Code kennt keine Pakete oder Funktionsschalter je Tarif; KI-Kosten je Mandant liegen vollständig in `ai_actions` (Tokens, Euro, Suchanfragen). Eine Kontingentabrechnung (R3-06) ist damit günstig; eine Paketlogik (R3-05) braucht Feature-Flags je Mandant, die es noch nicht gibt.
- **Segmententscheidung** steuert P-30 (welche Bausteine Standard sind), V-07 (Websuche in der Kurzanalyse) und ob KVP-Funktionen (Kiosk, Prämien) ins Backlog kommen.
- **Vertrauensversprechen** („jede Zahl mit Quelle“) ist technisch nur so stark wie P-20 und P-21; Vertriebsaussagen sollten „Quelle verlinkt“ sagen, nicht „geprüft“.
- **Betriebskosten:** Eine Instanz plus verwaltete PostgreSQL reicht für Dutzende Mandanten; Kostentreiber sind KI und Websuche, beide gedeckelt.

## 9 Vorgeschlagene neue oder geänderte Stories

Legende „Stand“: **gebaut** = im Code vorhanden, Story ändert oder ergänzt; **Konzept** = nur im Backlog; **neu** = weder noch.

| Vorschlag-ID | Release | Epic | Story | Akzeptanzkriterien (knapp) | SP | Prio | Bezug Befund | Stand |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| V-01 | 1 (Nacharbeit) | A Plattform | Als Betreiber möchte ich Rate-Limits für Anmeldung, Registrierung, Passwort-Reset und Demo-Login, damit Credential Stuffing und Massenregistrierung ins Leere laufen. | Limit je IP und je Konto; 429 mit Wartezeit; Ereignis im Audit-Log; Test mit 20 Fehlversuchen | 3 | Muss | P-14 | neu |
| V-02 | 1 (Nacharbeit) | A Plattform | Als Betreiber möchte ich TOTP-Geheimnisse verschlüsselt speichern, CSP- und HSTS-Header setzen und Mail-Betreffs vertraulicher Ideen ohne Titel senden, damit die offenen Punkte des Bedrohungsmodells geschlossen sind. | `mfa_secret` mit `SECRET_KEY` verschlüsselt, Migration für Bestand; CSP ohne `unsafe-inline`; Betreff „Idee #Nr“ bei vertraulich; `npm audit --audit-level=high` | 3 | Muss | P-14, P-23 | neu |
| V-03 | 1 (Nacharbeit) | A Plattform | Als Betreiber möchte ich Kennzahlen und Alarme für Jobs, KI-Warteschlange und Mail-Outbox, damit ein stiller Ausfall der Fristen-Engine auffällt. | `/api/health` liefert Alter des letzten Job-Laufs, Queue-Länge und ältesten Job, Outbox-Rückstau; Alarm per Mail oder Webhook bei Schwellen; Logs ohne Ideentexte (Test); Restore-Test dokumentiert; Staging-Umgebung | 5 | Muss | P-15 | Konzept (R1-05 konkretisiert) |
| V-04 | 2 (Nacharbeit) | L Triage-KI | Als Ideengeberin möchte ich die Kurzanalyse ohne Spur-Vorschlag sehen, damit die Antwort des Triage-Teams die erste Entscheidung bleibt. | Ergebnisarten `triage_suggestion` und `reply_draft` nur für Triage, Gremium, Pate; Autor:innen sehen Kurzanalyse ohne Empfehlungsfeld; Test je Rolle | 2 | Muss | P-05 | gebaut (Änderung) |
| V-05 | 2 (Nacharbeit) | K KI-Plattform | Als Admin möchte ich, dass der eingebaute Anbieter Struktur und Fragen statt Zahlen liefert, damit niemand Platzhalter für eine Analyse hält. | Keine Beträge oder Marktzahlen im `builtin`-Pfad; Felder „zu klären“ mit Leitfragen; Banner „Kein KI-Modell eingerichtet“ mit Link; Demo-Mandant mit echtem, budgetiertem Modell oder vorab erzeugten Ergebnissen im Seed | 3 | Muss | P-20 | gebaut (Änderung) |
| V-06 | 2 (Nacharbeit) | K KI-Plattform | Als Pate möchte ich je KI-Baustein einen Prüfstatus setzen und das Ergebnis mit einem Klick als hilfreich oder nicht bewerten, damit Gremium und Product Owner wissen, was geprüft und was nützlich ist. | Status ungeprüft/geprüft/korrigiert mit Person und Datum; Gate-2-Vorlage zeigt Status je Baustein; Pflicht „alle geprüft“ vor Gate 2 einstellbar; Bewertung und Aufklappquote in der Qualitätsansicht | 3 | Soll | P-09, P-10 | gebaut (Ergänzung) |
| V-07 | 2 (Nacharbeit) | M Analyse | Als Admin möchte ich Websuche und Bausteine der Analysen je Ideentyp einstellen, damit interne Kleinideen keine Wettbewerbsrecherche auslösen. | Einstellung je Ideentyp: Websuche in Kurzanalyse an/aus, Bausteine der Vollanalyse an/aus; Standard: intern ohne Websuche in der Kurzanalyse, Patente aus; Protokoll zeigt übersprungene Bausteine | 2 | Soll | P-30, Abschnitt 6 | gebaut (Ergänzung) |
| V-08 | 2 (Nacharbeit) | K KI-Plattform | Als Product Owner möchte ich, dass das Qualitätstor Quellen prüft, damit „Belegt“ inhaltlich stimmt. | Je Quelle: URL erreichbar, Zitat im Seitentext enthalten; Anteil belegter Zahlen je Baustein als Kennzahl; Seitenabruf für höchstens 5 Treffer mit Längenbegrenzung und Einzäunung; monatliche Stichprobe von 5 Ergebnissen mit Bewertung durch einen Paten; Datenfluss-Dokument angepasst | 5 | Soll | P-21, P-22 | gebaut (Ergänzung) |
| V-09 | 2 (Nacharbeit) | J Ausarbeitung | Als Pate möchte ich den Steckbrief auf einer eigenen Seite mit Reitern bearbeiten, damit ich den Überblick behalte. | Route `/ideen/:id/steckbrief` mit Reitern Zusammenfassung, Analysen, Scorecard, Experimente, Wirkung; Ideenseite zeigt Zusammenfassung und Link; mobil lesbar; axe ohne Befund | 5 | Soll | P-03 | gebaut (Umbau) |
| V-10 | 2 (Nacharbeit) | H Einstieg | Als Triage-Mitglied, Pate oder Gremiumsmitglied möchte ich einen Erststart für meine Rolle, damit ich Ampel, Spuren und KI-Vorschläge ohne Schulung verstehe. | 3 Schritte je Rolle beim ersten Aufruf von Board, Steckbrief, Gremium; Checkliste „erste Woche“ auf „Meine Aufgaben“; Leerzustände mit nächstem Schritt und Knopf je Rolle | 3 | Soll | P-02, P-04 | gebaut (Ergänzung) |
| V-11 | 2 (Nacharbeit) → 3 | T Sprache | Als Entwicklerin möchte ich einen Textkatalog für Oberfläche, Serverfehler und Mails, damit Release 3 die englische Oberfläche ohne Umbau liefern kann. | Neue Stories nur mit Katalog; Bestand in zwei Schritten extrahiert; Sprache je Person; Datums- und Zahlenformate je Sprache; KI antwortet in Nutzersprache; R3-22 auf 13 SP neu geschätzt | 8 (+5 in R3) | Muss (R3), Soll (Vorbereitung jetzt) | P-18, P-32 | neu |
| V-12 | 3 | R Integrationen | Als Kunden-Admin möchte ich API-Tokens je Mandant, eine OpenAPI-Beschreibung und Webhooks, damit Konnektoren und eigene Integrationen auf derselben API laufen. | Tokens mit Rollen, Ablauf, Widerruf, Audit; OpenAPI aus zod erzeugt und unter `/api/docs` erreichbar; Webhooks bei Statuswechseln mit Signatur und Wiederholung; die eigenen Konnektoren nutzen Tokens | 13 (ersetzt R3-17 mit 8) | Muss | P-16, P-32 | Konzept (R3-17 erweitert) |
| V-13 | 3 | P Plattform | Als Nutzerin möchte ich schnelle Volltextsuche, Paginierung und semantische Dubletten, damit das Portal auch mit tausenden Ideen bedienbar bleibt. | `tsvector` mit GIN-Index, Cursor-Paginierung in Listen und Board, pgvector mit lokalem Embedding hinter `GET /api/ideas/similar`, Index je Mandant; Lasttest mit 10.000 Ideen; R1-19 abgeschlossen | 8 | Muss | P-11, P-12 | gebaut (Ausbau) |
| V-14 | 3 | B Rollen | Als Admin möchte ich Rollen je Bereich oder Themenfeld vergeben, damit mehrere Triage-Teams und Gremien in einem Mandanten arbeiten. | Bereich als Stammdatum; Rolle optional mit Geltungsbereich; Board, Aufgaben, Eskalation und Dashboard filtern danach; Mandantenweite Rollen bleiben möglich; Tests für Rechte | 8 | Soll | P-24 | neu |
| V-15 | 3 | R Integrationen | Als Mitarbeiterin möchte ich Benachrichtigungen in Microsoft Teams oder Slack erhalten, damit ich Rückfragen und Fristen nicht übersehe. | Eingehender Webhook je Mandant (Teams, Slack); gleiche Matrix und Kategorien wie E-Mail; Link zur Idee; vertrauliche Titel nicht im Chat | 5 (Teams 3, Slack 2) | Soll (Teams), Kann (Slack) | P-26 | Konzept (R3-16 Teil 1 vorgezogen, Slack neu) |
| V-16 | 3 | B Anmeldung | Als Mitarbeiterin möchte ich mich mit dem Firmen-Login anmelden (OIDC zuerst, Entra ID), damit kein zweites Passwort nötig ist. | Wie R1-08; zusätzlich Gruppen → Rollen, Just-in-time-Anlage, Abschaltung lokaler Konten je Mandant; SCIM als Kann | 8 | Muss | P-25 | Konzept (R1-08 nach R3 verschoben) |
| V-17 | 3 (oder 2-Nacharbeit) | C Einreichen | Als Mitarbeiterin möchte ich ein Problem ohne Lösung einreichen, damit Beobachtungen nicht verloren gehen und Challenges daraus entstehen. | Ideentyp „Problem“: Lösung optional; Community schlägt Lösungen vor; Triage kann Problem zur Challenge machen oder mit Idee zusammenführen; KI-Kurzanalyse liefert Ursachenfragen statt Wettbewerb | 5 | Soll | P-29 | neu |
| V-18 | 3 | O Challenges | Als Nachhaltigkeitsbeauftragte möchte ich eine Nachhaltigkeits-Challenge mit CO₂- und kWh-Nutzen auswerten, damit Ideen in den Nachhaltigkeitsbericht einfließen. | Challenge-Vorlage; Nutzenart kWh ergänzt; Dashboard und Export je Challenge nach Nutzenart; Erfolgsgeschichte nennt die Einsparung | 3 | Soll | Abschnitt 7 | gebaut (Ergänzung) |
| V-19 | 3 | O Challenges | Als Controlling möchte ich eine Challenge mit Zielwert führen und Ist-Nutzen bestätigen, damit Kostensenkungsprogramme belastbar sind. | Zielwert und Zeitraum je Challenge; Fortschritt bestätigt gegen geschätzt; Bestätigungsschritt mit Kommentar (R4-05 vorgezogen); Dashboard zeigt bestätigt gegen geschätzt | 5 | Soll | Abschnitt 7 | Konzept (R4-05 vorgezogen) |
| V-20 | 3 | S Externe / O Challenges | Als Sponsor möchte ich einen Hackathon mit Einreichfenster, Pitch-Reihenfolge und optionalem Publikumsvoting durchführen, damit Wettbewerbe komplett im Portal laufen. | Einreichfenster mit Sperre danach; Pitch-Liste; Publikumsvoting ein Klick je Person, getrennt von der Jury; Team-Seite; Rangliste kombiniert nach Einstellung | 5 | Kann | Abschnitt 7 | gebaut (R2-35 Ausbau) |
| V-21 | 3 | S Externe | Als Produktteam möchte ich je Challenge festlegen, welche Einwilligung Externe zu Nutzungsrechten und Vertraulichkeit geben, damit Open Innovation rechtssicher startet. | Einwilligungstext je Challenge, versioniert; Zustimmung protokolliert; Externe sehen nur eigene und freigegebene Ideen; Hinweis auf Erfindungsprüfung (R3-25) | 3 (Ergänzung zu R3-19) | Soll | Abschnitt 7 | Konzept (R3-19 ergänzt) |
| V-22 | 2 (Nacharbeit) | H Messung | Als Innovationsleitung möchte ich Durchlaufzeiten je Phase und Zeitreihen im Dashboard sehen, damit der Pilot die Hypothese „Ausarbeitung in 1–2 Wochen“ belegt. | Median und 90. Perzentil für Einreichung → Gate 1 → Gate 2 → Umsetzung → Gate 3; Zeitreihe je Kennzahl; Ausgangswert als Linie; Challenge-Bericht; Export | 5 | Muss (Pilot) | P-27, P-33 | gebaut (Ausbau) |
| V-23 | 2 (Nacharbeit) | K KI-Plattform | Als Betreiber möchte ich KI-Fairness zwischen Mandanten und eine Kostenschätzung vor dem Aufruf, damit kein Mandant andere blockiert und Budgets eingehalten werden. | Parallelität je Instanz konfigurierbar; Round-Robin je Mandant; Schätzung aus Prompt-Länge und `maxTokens` vor dem Aufruf, Abbruch bei Überschreitung; Queue-Kennzahlen in V-03 | 3 | Soll | P-17 | gebaut (Ergänzung) |
| V-24 | 0/1 (kein Code) | H Einstieg | Als Product Owner möchte ich den Klicktest mit 7–8 Personen durchführen und auswerten, damit Release-2-Nacharbeit auf Evidenz beruht. | Aufgaben aus `papiertest.md`; Befunde je Bildschirm mit Schweregrad; kritische Befunde als Stories vor weiterem Ausbau | 5 | Muss | P-01 | Konzept (Release 0 offen) |
| V-25 | 3 | Q Betrieb | Als Betreiber möchte ich den `SECRET_KEY` rotieren und Einstellungen versioniert speichern, damit Schlüsselwechsel und gleichzeitige Änderungen sicher sind. | Rotation mit Neuverschlüsselung aller Mandantenschlüssel; Einstellungen mit Versionsnummer und Konfliktmeldung | 3 | Kann | P-13 | neu |

**Summe der Vorschläge:** ca. 132 SP, davon Muss ca. 60 SP. Nacharbeit zu Release 1 und 2 vor dem Pilot (V-01 bis V-05, V-22, V-24): ca. 26 SP.

## 10 Empfohlene Reihenfolge

1. **Vor der öffentlichen Demo und dem Pilot (2–3 Wochen):** V-01, V-02, V-03, V-04, V-05, V-22, V-24. Danach Sicherheitsreview mit der IT und manuelle Barrierefreiheitsprüfung (P-07).
2. **Parallel zum Pilot:** V-06 bis V-10, V-23 (Erkenntnisse aus dem Klicktest zuerst).
3. **Release 3 neu schneiden:** V-16 (SSO) und V-12 (API) zuerst, dann V-13, V-11, V-14, V-15; Use-Case-Pakete V-17 bis V-21 nach Segmententscheidung aus Teil 2.
4. **Konzeptpflege:** ADR 0005, Datenfluss und `navigation.md` an den Code angleichen (P-22); R3-17, R3-22, R1-05 neu schätzen (P-32); Backlog neu erzeugen.

## 11 Nicht geprüft, Annahmen, Unsicherheiten

- Ob `routes/ai.ts` die Ergebnisarten für Autor:innen an anderer Stelle filtert, habe ich nicht gesehen; P-05 bitte vor Umsetzung verifizieren.
- Gremiumsmodul (`Meetings.tsx`), Workflow-Übergänge (`workflow.ts`), Ausarbeitungsdienst (`elaboration.ts`) und Importer nur per Suche geprüft, nicht gelesen.
- Keine Aussage zur Laufzeitqualität der KI-Ausgaben mit echten Modellen; die Bewertung stützt sich auf Prompt-Struktur, Schema-Prüfung und Qualitätstor.
- Keine Last-, Penetrations- oder Screenreader-Tests durchgeführt.
- Story-Point-Schätzungen sind Expertenschätzungen auf Basis des gelesenen Codes, mit derselben Skala wie das Umsetzungskonzept.
