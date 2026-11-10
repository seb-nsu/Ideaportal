# Release 1 – Umsetzungsstand

Stand 13.10.2026. Release 1 ist für den Pilotbetrieb als Capstone-Produkt umgesetzt: Selbstregistrierung ohne Firmen-Login, alle Muss- und Soll-Stories der Kernstrecke, dazu die Nacharbeit aus Version 3 (R1-05, R1-44 bis R1-46). Von 45 Stories sind 41 umgesetzt, 3 teilweise (R1-02, R1-07, R1-42 manuelle Barrierefreiheitsprüfung offen) und R1-08 ist durch den Firmen-Login R3-26 ersetzt. „Teilweise“ heißt: Kern umgesetzt, einzelne Akzeptanzkriterien offen.

| Story | Inhalt | Stand | Hinweis |
| --- | --- | --- | --- |
| R1-01 | Ein Container-Image, Health-Check | umgesetzt | `Dockerfile`, `docker-compose.yml`, `/api/health` |
| R1-02 | CI/CD, Abhängigkeits-Scan | teilweise | GitHub Actions mit Tests, `npm audit --audit-level=high`, Browser-Test mit Barrierefreiheitsprüfung, Image-Build; Deployment-Vorlage `render.yaml`; Staging und Geheimnisverwaltung offen |
| R1-03 | Mandantentrennung mit Row-Level-Security | umgesetzt | Test mit zwei Mandanten |
| R1-04 | Einstellungen je Mandant | umgesetzt | Fristen, Schwellen, Themenfelder, Feiertage, Zielkanäle, Abgrenzung, Texte; ohne Neustart |
| R1-05 | Backups, Kennzahlen und Alarme | umgesetzt (AP-03) | `/api/health` mit Alter des letzten Job-Laufs, KI-Warteschlange, ältestem Auftrag und Mail-Rückstau; Alarm per Mail oder Webhook mit Entwarnung; Logs ohne Ideentexte (Test); Staging als zweiter Render-Dienst; Restore-Test lokal protokolliert. Offen: Restore-Test auf Render mit bezahltem Plan, Alarmkanal und Bereitschaft für den Pilot benennen (Product Owner) |
| R1-06 | Audit-Log | umgesetzt | unveränderlich, CSV-Export |
| R1-07 | E-Mail-Versand | teilweise | Outbox, Versandjob, SMTP (`SMTP_URL`); Bounce-Verarbeitung offen |
| R1-08 | Firmen-Login (OIDC/SAML) | ersetzt durch R3-26 | Für den Capstone-Betrieb nicht nötig: eigene Konten, Selbstregistrierung und Einladungslink. Umgesetzt als R3-26 (OpenID Connect, Entra ID zuerst) mit SCIM (R3-27), siehe `docs/release-3/umsetzungsstand.md` |
| R1-09 | Eigene Konten mit MFA | umgesetzt | Einladung, Passwort-Reset, TOTP, Sperre nach 5 Fehlversuchen, MFA-Pflicht für Admins |
| R1-10 | Rollen | umgesetzt | serverseitig geprüft, im Protokoll |
| R1-11 | Vertretung und Abwesenheit | umgesetzt | Abwesenheit unter „Mein Konto“; Vertretung erhält Aufgaben und Erinnerungen und darf Umsetzungen pflegen |
| R1-12 | Geführtes Formular | umgesetzt | 4 Schritte, Entwurf, mobil |
| R1-13 | Anhänge | umgesetzt | bis 10 MB, Positivliste mit Inhaltsprüfung; Virenscan mit ClamAV, wenn `CLAMAV_HOST` gesetzt ist |
| R1-14 | Vertraulich, anonym | umgesetzt | |
| R1-15 | Co-Autor:innen | umgesetzt | gleiche Rechte wie Ideengebende, werden benachrichtigt |
| R1-16 | Status, Restfrist, Verlauf | umgesetzt | |
| R1-17 | Einreichen im Namen anderer | umgesetzt | Bestätigung per Klick |
| R1-18 | Abgrenzungshinweis | umgesetzt | Pflicht-Bestätigung, Begriffserkennung, bei Abbruch nichts gespeichert |
| R1-19 | Ähnliche Ideen | umgesetzt | Mit R3-28 abgeschlossen: bis zu 5 ähnliche Ideen live beim Schreiben, lokales Embedding-Modell mit pgvector (ohne die Erweiterung Trigramm-Ähnlichkeit), Index je Mandant über `idea_embeddings` mit RLS, Knopf „anschließen“ (ADR 0001, `docs/release-3/umsetzungsstand.md`) |
| R1-20 | Ideen zusammenführen | umgesetzt | Kommentare und Unterstützung wandern mit, Ideengebende werden Co-Autor:innen, beide werden benachrichtigt |
| R1-21 | Kommentieren, unterstützen | umgesetzt | |
| R1-22 | Startseite, Filter, Suche | umgesetzt | |
| R1-23 | Triage-Board mit Ampel | umgesetzt | |
| R1-24 | Spur mit Begründung | umgesetzt | Textvorlagen, automatische Nachricht |
| R1-25 | Fristen in Arbeitstagen | umgesetzt | Feiertage je Mandant, Pause bei Rückfrage, Historie im Audit-Log |
| R1-26 | Erinnern, eskalieren | umgesetzt | Eskalation an Admins; bei Abwesenheit an die Vertretung |
| R1-27 | Rückfrage | umgesetzt | höchstens 2 Runden |
| R1-28 | Weiterleiten an Zielkanal | umgesetzt | optional Inhalt löschen |
| R1-29 | Übergabe an Fachbereich | umgesetzt | |
| R1-30 | Entscheidung Gate 2 | umgesetzt | Parken höchstens 6 Monate |
| R1-31 | Umsetzung pflegen | umgesetzt | Erinnerung bei Verzug |
| R1-32 | Abschluss mit Ist-Nutzen | umgesetzt | |
| R1-33 | Wiedervorlage | umgesetzt | |
| R1-34 | Einfache Challenge | umgesetzt | |
| R1-35 | Zufriedenheit | umgesetzt | |
| R1-36 | Benachrichtigungsmatrix | umgesetzt | sofort, täglich als Zusammenfassung oder aus; Kategorien abschaltbar; in der App immer sichtbar. Feinschliff der Matrix aus Release 0 |
| R1-37 | Dashboard | umgesetzt | ab 5 Personen, CSV |
| R1-38 | Rundgang, Beispielideen, FAQ | umgesetzt | Beispielidee und erste Challenge bei der Registrierung; öffentliche Demo mit Rollenwechsel |
| R1-39 | Import CSV/Excel | umgesetzt | Vorschau, Spaltenzuordnung, Dubletten nach Titel, importierte Ideen starten mit Frist für Gate 1 |
| R1-40 | Löschfristen, Auskunft | umgesetzt | Löschfristen je Mandant (Job), Auskunft je Person (selbst und durch Admin), Anonymisieren |
| R1-41 | Datenschutzhinweis | umgesetzt | Admin-Zugriffe auf Protokoll und Export werden protokolliert |
| R1-42 | Barrierefreiheit WCAG 2.1 AA | teilweise | axe-Prüfung aller Hauptseiten ohne Befund, läuft in der Pipeline (`e2e/smoke.mjs`); manueller Test mit Screenreader offen |
| R1-43 | Datenexport | umgesetzt | JSON-Vollexport; Arbeitsbereich löschen inklusive Protokoll |
| R1-44 | Rate-Limits | umgesetzt | AP-01: je IP-Adresse und je Konto für Anmeldung, zweiten Faktor, Registrierung, Beitritt, Reset und Demo; 429 mit `Retry-After`; Ereignis im Audit-Log und in `security_events`; Test mit 20 Fehlversuchen (`security.test.ts`). Annahme: feste Zeitfenster in PostgreSQL statt Redis, damit kein weiterer Dienst nötig ist |
| R1-45 | TOTP verschlüsselt, CSP, HSTS, vertrauliche Betreffs | umgesetzt | AP-01: TOTP mit `SECRET_KEY` verschlüsselt, Bestand wird beim Start migriert; CSP ohne `unsafe-inline`, HSTS hinter HTTPS; Betreff „Idee #Nr“; `npm audit --audit-level=high` in der CI |
| R1-46 | Sichtbare Antwortgarantie | umgesetzt (AP-07) | Einstellung je Mandant unter Einstellungen › Prozess (`guarantee`: an/aus, erste Rückmeldung in n Arbeitstagen, Hinweisschwelle in %); Startseite zeigt Versprechen und Quote der letzten 90 Tage (`GET /api/guarantee`, nur Zählwerte). Der Fristen-Job meldet dem Ideenmanagement (Triage und Admin) einmal, wenn die Quote unter die Schwelle fällt, mit Audit-Eintrag; erneut erst, wenn sie sich erholt hat (`guarantee_alerts`, Migration 012). Tests mit zwei Mandanten und simuliertem Datum (`usability.test.ts`). **Annahme:** Als Rückmeldung zählt die Entscheidung an Gate 1, eine Rückfrage oder das Zusammenführen; gezählt werden Gate-1-Fristen, die in den letzten 90 Tagen begannen und deren Frist abgelaufen ist oder die schon beantwortet sind |

## Capstone-Betrieb ohne Firmen-Login

| Funktion | Stand | Hinweis |
| --- | --- | --- |
| Landingpage | umgesetzt | öffentlich unter `/` |
| Arbeitsbereich selbst anlegen | umgesetzt | `/registrieren`; wer anlegt, wird Admin, Triage und Gremium. Abschaltbar mit `SIGNUP_ENABLED=false` |
| Einladungslink | umgesetzt | `/beitreten/<code>`, neu erzeugen oder abschalten unter Einstellungen > Personen |
| Anmeldung nur mit E-Mail und Passwort | umgesetzt | bei mehreren Arbeitsbereichen mit derselben Adresse Auswahl nach dem Passwort |
| Öffentliche Demo mit Rollenwechsel | umgesetzt | `DEMO_MODE=true`; der Demo-Arbeitsbereich wird täglich zurückgesetzt |
