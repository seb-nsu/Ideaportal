# Benachrichtigungsmatrix

Stand 12.10.2026 · Release 0 · Entwurf · Grundlage für R1-36 (Feinschliff) und Release 2

Die Matrix beschreibt, wer bei welchem Ereignis über welchen Kanal wann benachrichtigt wird. Zeilen mit Release 1 entsprechen den echten Aufrufen von `notifyUser`, `notifyRoles` und `notifyAuthors` in `server/src/services/workflow.ts`, `server/src/jobs/deadlines.ts` und `server/src/routes/ideas.ts`. Die Texte stehen in `textvorlagen.md` unter der genannten Vorlagen-ID.

## So funktioniert die Zustellung (Release 1)

- **Outbox:** Jede Benachrichtigung landet in der Tabelle `outbox`. Sie ist gleichzeitig Posteingang in der App (Glocke) und Warteschlange für E-Mails.
- **In der App:** immer sichtbar, auch wenn E-Mails ausgeschaltet sind.
- **E-Mail:** je Person einstellbar unter „Mein Konto“: `sofort`, `täglich` (Zusammenfassung) oder `aus`. Kategorien lassen sich stummschalten.
- **Kategorien:** `my_ideas` (eigene Ideen), `community` (Kommentare, Unterstützung), `tasks` (Aufgaben), `reminders` (Erinnerungen, Eskalationen), ab Release 4 `trends` (wöchentliche Trendhinweise für Sponsor:innen, R4-02; abwählen = abbestellen, dann entsteht der Hinweis gar nicht).
- **Vertretung:** `tasks` und `reminders` gehen bei Abwesenheit an die Vertretung mit Betreff-Präfix „[Vertretung für …]“. Persönliche Nachrichten (`my_ideas`, `community`) gehen nie an die Vertretung.
- **Versand:** Job alle 15 Minuten (`JOB_INTERVAL_MINUTES`), SMTP über `SMTP_URL`.
- **Chat (Slack, Microsoft Teams, R3-16):** zusätzlicher Kanal aus derselben Outbox. Je Person unter „Mein Konto“ einschaltbar (aus, Slack, Teams) mit **denselben Kategorien** wie E-Mail, unabhängig von der E-Mail-Einstellung stummschaltbar. Zustellung sofort im selben Job (`dispatchChat` in `server/src/services/chat.ts`, eigene Markierung `outbox.chat_sent_at`), keine Tageszusammenfassung. Jede Nachricht hat einen Link zur Idee. Ziel: Slack-Direktnachricht über den Bot (Person per E-Mail-Adresse gefunden) oder persönlicher eingehender Webhook (Teams-Workflows, Slack). Systemmails ohne Person (Einladung, Passwort) gehen nie in den Chat. Ein fehlgeschlagener Chat-Versand wird nicht wiederholt; App und E-Mail bleiben die verlässlichen Kanäle.

Abkürzungen: **IG** = Ideengebende (Urheberin, Co-Autor:innen); **AT** = Arbeitstage; **E** = E-Mail nach Einstellung der Person; **A** = App (Glocke); **C** = Chat (Slack oder Teams) nach Einstellung der Person (R3-16). Jede Benachrichtigung, die in der App erscheint, kann auch im Chat ankommen; bei „A“ allein gilt das ebenso.

## Release 1 (umgesetzt)

| Nr. | Ereignis | Empfänger | Kategorie | Kanal | Zeitpunkt | Tonalität | Vorlage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| N01 | Idee eingereicht | Rolle `triage` | tasks | A + E + C | sofort | sachlich | `N-NEU` |
| N02 | Idee im Namen einer Person eingereicht | Urheberin | my_ideas | A + E + C | sofort | freundlich, Bitte um Bestätigung | `N-DELEGIERT` |
| N03 | Rückfrage gestellt | IG | my_ideas | A + E + C | sofort | freundlich, klare Frage | `N-RUECKFRAGE` |
| N04 | Rückfrage beantwortet | Rolle `triage` | tasks | A + E + C | sofort | sachlich | `N-ANTWORT` |
| N05 | Schnellspur: Übergabe an Fachbereich | verantwortliche Person | tasks | A + E + C | sofort | sachlich, mit Zieltermin | `N-UEBERGABE` |
| N06 | Entscheidung Gate 1 (Spur) | IG | my_ideas | A + E + C | sofort | wertschätzend | `G1-SCHNELL`, `G1-AUSARB`, `G1-WEITER`, `G1-ABLEHN` |
| N07 | Gate 2: Owner benannt | Owner | tasks | A + E + C | sofort | sachlich | `N-OWNER` |
| N08 | Entscheidung Gate 2 | IG | my_ideas | A + E + C | sofort | wertschätzend | `G2-UMSETZEN`, `G2-ERPROBEN`, `G2-INTEGRIEREN`, `G2-PARKEN`, `G2-ABLEHN` |
| N09 | Umsetzung übernommen | IG | my_ideas | A + E + C | sofort | positiv | `N-START` |
| N10 | Umsetzung abgeschlossen mit Ist-Nutzen | IG | my_ideas | A + E + C | sofort | feiernd, Dank | `N-UMGESETZT` |
| N11 | Geschlossen nach 15 AT ohne Antwort | IG | my_ideas | A + E + C | Job | freundlich, Tür offen | `N-GESCHLOSSEN` |
| N12 | Wiedervorlage fällig | Rollen `triage`, `committee` | tasks | A + E + C | Job, am Datum | sachlich | `N-WIEDERVORLAGE` |
| N13 | Idee zusammengeführt (Quelle) | IG der Quelle | my_ideas | A + E + C | sofort | erklärend | `N-ZUSAMMEN-Q` |
| N14 | Idee zusammengeführt (Ziel) | IG des Ziels | my_ideas | A + E + C | sofort | erklärend | `N-ZUSAMMEN-Z` |
| N15 | Als Co-Autor:in eingetragen | die Person | my_ideas | A + E + C | sofort | freundlich | `N-COAUTOR` |
| N16 | Neuer Kommentar | IG außer Kommentierender | community | A + E + C | sofort | neutral | `N-KOMMENTAR` |
| N17 | Neue Unterstützung | IG außer Unterstützender | community | A + E + C | sofort | positiv | `N-UNTERSTUETZT` |
| N18 | Frist endet bald | `triage` (Gate 1) bzw. `triage` + `committee` (Ausarbeitung) | reminders | A + E + C | Job, 2 AT vorher (`reminderWorkdaysBefore`) | sachlich | `E-ERINNERUNG` |
| N19 | Frist überschritten | `admin` + Zuständige | reminders | A + E + C | Job, erster Tag nach Fälligkeit | klar, nicht vorwurfsvoll | `E-ESKALATION` |
| N20 | Umsetzung im Verzug | Owner | reminders | A + E + C | Job, Tag nach Zieltermin | freundlich-bestimmt | `E-VERZUG` |
| N21 | Einladung / Passwort-Reset | die Person | – (direkt) | nur E | sofort | sachlich | `K-EINLADUNG`, `K-RESET` |

**Offen im Code (Release 1):** Zufriedenheitsabfrage (R1-35) erscheint nur in der App, nicht per Mail – so beabsichtigt. Bounce-Behandlung (R1-07) fehlt.

## Release 2 (geplant)

| Nr. | Ereignis | Empfänger | Kategorie | Kanal | Zeitpunkt | Vorlage | Story |
| --- | --- | --- | --- | --- | --- | --- | --- |
| N30 | Pate zugewiesen | Pate; IG zur Info | tasks / my_ideas | A + E + C | sofort | `N-PATE`, `N-PATE-IG` | R2-01 |
| N31 | Warnung: Pate hat ≥ 2 aktive Ideen | Triage | tasks | A + C | bei Zuweisung | `N-PATE-LAST` | R2-01 |
| N32 | Timebox endet bald / überschritten | Pate, Triage | reminders | A + E + C | 5 AT vorher / am Tag danach | `E-TIMEBOX` | R2-01 |
| N33 | Kurzanalyse fertig | Triage (nicht IG) | tasks | A + C | sofort | `KI-FERTIG-KURZ` | R2-22 |
| N34 | Vollanalyse / Steckbrief-Entwurf fertig | Pate | tasks | A + E + C | sofort | `KI-FERTIG-VOLL` | R2-22, R2-31 |
| N35 | Gremiumsunterlagen | Rolle `committee` | tasks | A + E + C | 5 AT vor Sitzung (`meetingPackWorkdays`) | `N-GREMIUM` | R2-04 |
| N36 | Experiment endet | Owner | reminders | A + E + C | 2 AT vorher (`experimentReminderWorkdays`) | `E-EXPERIMENT` | R2-06 |
| N37 | Wirkungsreview fällig | Pate, Sponsor | tasks | A + E + C | `impactReviewMonths` nach Umsetzung | `N-WIRKUNG` | R2-07 |
| N38 | KI-Budget bei 80 % / erreicht | `admin` | reminders | A + E + C | sofort | `KI-BUDGET` | R2-09 |
| N39 | Agent nicht freigegeben (Testsatz verfehlt) | `admin` | tasks | A + E + C | nach Bewertungslauf | `KI-QUALITAET` | R2-12 |
| N40 | Verdächtiger Inhalt (Prompt-Injection) erkannt | `admin` | tasks | A + C | sofort, gebündelt täglich | `KI-INJECTION` | R2-13 |
| N41 | Erfolgsgeschichte zur Freigabe | Urheberin | my_ideas | A + E + C | sofort | `N-ERFOLG` | R2-37 |
| N42 | Challenge: Phase Sammeln beginnt | Sponsor | tasks | A + E + C | Job, am Starttag der Phase | `CH-SAMMELN` | R2-52 |
| N43 | Challenge: Phase Bewerten beginnt | Sponsor; IG der Challenge-Ideen | tasks / my_ideas | A + E + C | Job, am Starttag der Phase | `CH-BEWERTEN` | R2-52 |
| N44 | Challenge: Phase Ausarbeiten beginnt | Sponsor; IG der Challenge-Ideen | tasks / my_ideas | A + E + C | Job, am Starttag der Phase | `CH-AUSARBEITEN` | R2-52 |
| N45 | Challenge: Phase Jury beginnt | Sponsor; Jury (Aufgabe); IG der Challenge-Ideen | tasks / my_ideas | A + E + C | Job, am Starttag der Phase | `CH-JURY` | R2-52 |
| N46 | Challenge: Phase Ergebnis beginnt (auch beim Beenden) | Sponsor; IG der Challenge-Ideen | tasks / my_ideas | A + E + C | Job, am Starttag der Phase | `CH-ERGEBNIS` | R2-52 |

**Challenge-Phasen (R2-52, umgesetzt):** Der Fristen-Job (`server/src/jobs/deadlines.ts` → `runChallengePhases` in `server/src/services/challenges.ts`) setzt die Phase am Starttag und benachrichtigt einmal je Übergang. Werden Phasen übersprungen (Job lief nicht, Plan geändert), geht nur die Nachricht der erreichten Phase raus. Jede Person bekommt je Übergang eine Nachricht: Sponsor vor Jury vor IG. Ideengebende erst ab „Bewerten“ (beim Sammeln gibt es noch keine). Keine Rundmail an alle Mitarbeitenden (Regel 1). Texte im Katalog unter `challenges.phase.<phase>.*` (`server/src/i18n/de/challenges.ts`). Die Schwarmbewertung (R2-51) löst keine Benachrichtigung aus.

## Release 4 (umgesetzt)

| Nr. | Ereignis | Empfänger | Kategorie | Kanal | Zeitpunkt | Vorlage | Story |
| --- | --- | --- | --- | --- | --- | --- | --- |
| N60 | Trendhinweise der Woche zu den eigenen Themenfeldern (Zusammenfassung, Hinweise mit Quellennummern, Quellenliste, Link zum Radar, Abbestell-Hinweis) | Sponsor:innen der Themenfelder (`topic_sponsors`) und Sponsor:innen laufender Challenges im Themenfeld; eine Mail je Person über alle ihre Themenfelder | trends | A + E + C | Job, einmal je ISO-Woche ab dem eingestellten Wochentag (`radar.weekday`, Standard Montag); nur mit eingerichteter Websuche und mindestens einem Hinweis mit Quelle | `radar.mail.*` (`server/src/i18n/de/radar.ts`) | R4-02 |

**Trendhinweise (R4-02):** Der Regel-Job stellt einen KI-Auftrag `trend_digest` ein, der Worker erstellt je Themenfeld einen Wochenhinweis und verschickt danach die Mails. Keine Rundmail: nur Sponsor:innen. Wer die Kategorie „Trendhinweise“ unter Mein Konto abwählt, bekommt nichts mehr, auch nicht im Postfach des Portals; die Abwahl ist auch bei „Keine E-Mails“ möglich. Der Knopf „Jetzt erzeugen“ der Innovationsleitung verschickt keine Mail.

## Regeln

1. **Keine Benachrichtigung ohne Handlung oder Neuigkeit.** Info-Mails ohne Aufgabe nur für eigene Ideen.
2. **Höchstens eine Erinnerung je Frist und eine Eskalation** (Felder `reminded_at`, `escalated_at`).
3. **Tägliche Zusammenfassung** bündelt alle Nachrichten eines Tages in einer Mail um 7 Uhr Ortszeit des Mandanten.
4. **KI-Ergebnisse gehen nie automatisch an Ideengebende.** Rückmeldungen schreibt ein Mensch; die KI liefert nur Entwürfe (R2-19).
5. **Vertrauliche Ideen:** Betreff enthält nur Nummer und den Hinweis „vertraulich“, nicht den Titel. **Offen (Product Owner):** Bestätigen; heute enthält der Betreff den Titel (`label(idea)`).
6. **Chat (R3-16):** Titel und Texte vertraulicher Ideen stehen nie im Chat, nur „Idee #N“, ein neutraler Satz und der Link. Dasselbe gilt für weitergeleitete Ideen und für Texte, bei denen die lokale Abgrenzungsprüfung (R1-18) anschlägt (mögliche Meldungen); ohne Ideennummer heißt die Nachricht nur „Neuigkeit im Ideenportal“. Bei einer offenen Rückfrage (N03) zeigt der Chat die Rückfrage-Karte mit Antwortweg (Slack: Knopf „Rückfrage beantworten“, Teams: Befehl `antwort #N …` oder Nachrichtenerweiterung).
