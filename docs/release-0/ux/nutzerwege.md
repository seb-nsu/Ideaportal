# Nutzerwege (Journeys)

Stand 12.10.2026 · Release 0 · Entwurf

Vier Nutzerwege beschreiben, wie die wichtigsten Rollen das Portal heute (Release 1) und mit Release 2 nutzen. Sie sind die Grundlage für den Papiertest (`papiertest.md`), die Bildschirmskizzen (`hauptbildschirme.md`) und die Benachrichtigungsmatrix.

| Nr. | Nutzerweg | Rolle (Code) | Kernfrage |
| --- | --- | --- | --- |
| 1 | Ideengeberin reicht ein und bekommt eine Antwort | `submitter` | „Passiert mit meiner Idee etwas?“ |
| 2 | Triage-Team entscheidet an Gate 1 | `triage` | „Bleibt keine Idee liegen?“ |
| 3 | Pate arbeitet eine Idee bis Gate 2 aus | `mentor` | „Wie mache ich die Idee mit wenig Aufwand entscheidungsreif?“ |
| 4 | Kunden-Admin startet einen Arbeitsbereich und lädt Externe ein | `admin` (+ später Rolle „Externe:r“, R3-19) | „Läuft das bei uns in einer Stunde?“ |

Spalten der Tabellen: **Schritt** · **Bildschirm** (echte Route) · **Ziel der Person** · **Schmerzpunkt / Risiko** · **Messgröße**.

## 1 Ideengeberin: Einreichen bis Rückmeldung

**Persona:** Lea, Sachbearbeiterin im Innendienst, 34, nutzt das Portal am Laptop und unterwegs am Smartphone. Hat schon einmal eine Idee per E-Mail eingereicht und nie eine Antwort bekommen.

| Schritt | Bildschirm | Ziel | Schmerzpunkt / Risiko | Messgröße |
| --- | --- | --- | --- | --- |
| 1 Anstoß | Startseite `/` (Aktive Challenges, Erfolge) | Sehen, dass das Portal lebt | Leere Startseite wirkt tot | Anteil Besuche mit Klick auf „Idee einreichen“ |
| 2 Einreichen, Schritt 1–4 | `/einreichen` (Titel, Problem, Idee, Nutzen, Themenfeld, Art intern/Produkt, Challenge, vertraulich/anonym) | Idee in unter 5 Minuten loswerden | Formular wirkt wie Bürokratie; Unsicherheit bei „Art der Idee“ | Abbruchquote je Schritt; Median-Dauer |
| 3 Ähnliche Ideen | `/einreichen`, Bereich „Ähnliche Ideen“ | Nicht doppelt einreichen, ggf. unterstützen | Treffer passen nicht (Trigramm statt Embedding, R1-19) | Anteil Einreichungen mit Klick auf „anschließen“ |
| 4 Absenden mit Abgrenzung | Dialog „Idee, keine Meldung“ (R1-18) | Sicher sein, im richtigen Kanal zu sein | Fehlalarm bei harmlosen Wörtern; Angst vor Meldung | Anteil Abbrüche nach Hinweis; Fehlalarme im Papiertest |
| 5 Warten | `/ideen/:id` (Statusleiste, Restfrist, nächster Schritt) | Wissen, wann die Antwort kommt | Restfrist in Arbeitstagen unverständlich | Seitenaufrufe je Idee vor Gate 1 (sinkt = Vertrauen) |
| 6 Kurzanalyse (Release 2) | `/ideen/:id`, Abschnitt „KI-Kurzanalyse“ | Erste Einordnung, Wettbewerb, Hebel | KI wirkt wie Urteil über die Person | Anteil korrigierter Aussagen (R2-15) |
| 7 Rückfrage beantworten | `/aufgaben` → „Rückfragen beantworten“; mobil | Schnell antworten, Frist läuft weiter | Rückfrage per Mail übersehen | Antwortzeit auf Rückfragen; Schließungen nach 15 AT |
| 8 Rückmeldung Gate 1 | Mail + Glocke, `/ideen/:id` Verlauf | Verständliche Antwort mit Begründung | Ablehnung ohne Wertschätzung | Zufriedenheit (R1-35) ≥ 4 von 5 |
| 9 Zufriedenheit | `/ideen/:id` „Wie zufrieden bist du mit der Rückmeldung?“ | Feedback mit einem Klick | Abfrage nervt | Antwortquote |
| 10 Umsetzung und Erfolg | `/ideen/:id`, Startseite „Erfolge“ | Sehen, was daraus wurde, genannt werden | Nennung unerwünscht | Anteil umgesetzter Ideen mit Ist-Nutzen |

**Erkenntnisse für das Design:** Restfrist immer als Datum *und* „noch X Arbeitstage“ zeigen; die Ablehnung erklärt den Grund und nennt eine Ansprechperson; KI-Inhalte sind klar gekennzeichnet und nie die Antwort selbst.

## 2 Triage-Team: Gate 1

**Persona:** Murat, Innovationsmanager, triagiert wöchentlich 30–60 Minuten mit einer Kollegin.

| Schritt | Bildschirm | Ziel | Schmerzpunkt / Risiko | Messgröße |
| --- | --- | --- | --- | --- |
| 1 Überblick | `/board` (Spalten je Status, Fristen-Ampel) | Sehen, was brennt | Zu viele Karten, keine Sortierung | Fristtreue Gate 1 (Dashboard) |
| 2 Idee öffnen | `/ideen/:id` mit „Gate 1: Triage“ | Idee in 2 Minuten verstehen | Lange Texte, fehlende Angaben | Median-Zeit je Triage-Entscheidung |
| 3 KI-Vorschlag prüfen (Release 2) | Abschnitt „Triage-Vorschlag“ (R2-18) mit Spur, Themenfeld, Begründung, Konfidenz | Schneller entscheiden | Blindes Übernehmen; Vorschlag „Ablehnen“ wirkt wie KI-Entscheidung | Trefferquote Vorschlag vs. Entscheidung |
| 4 Rückfrage stellen | Formular „Frage“ | Fehlende Angaben holen | Mehr als 2 Runden | Anteil Ideen mit Rückfrage |
| 5 Spur wählen | Schnellspur (Fachbereich, Verantwortliche, Zieltermin) · Ausarbeiten · Weiterleiten (Zielkanal) · Ablehnen | Klare Entscheidung mit Begründung | Begründung schreiben kostet Zeit | Anteil Entscheidungen mit Vorlage oder KI-Entwurf (R2-19) |
| 6 Zusammenführen | Dublette zusammenführen (R1-20) | Diskussion bündeln | Ideengebende fühlen sich übergangen | Beschwerden über Zusammenführung (qualitativ) |
| 7 Erinnerung / Eskalation | Mail „Erinnerung: Frist für …“ / „Frist überschritten“ | Nichts vergessen | Alarmmüdigkeit | Anzahl Eskalationen pro Monat |

## 3 Pate: Ausarbeiten bis Gate 2 (Release 2)

**Persona:** Dr. Anna Weber, Produktmanagerin, ist Patin für höchstens 2 Ideen gleichzeitig (Warnung ab 2, R2-01), Zeitbudget 5–10 %.

| Schritt | Bildschirm | Ziel | Schmerzpunkt / Risiko | Messgröße |
| --- | --- | --- | --- | --- |
| 1 Aufgabe erhalten | `/aufgaben`, Mail „Du bist Patin für …“ | Timebox (6 Wochen) und Ziel kennen | Keine Zeit freigegeben | Anteil Ausarbeitungen in der Timebox |
| 2 Steckbrief öffnen | `/ideen/:id/steckbrief` (neu): Nutzen, Aufwand, Risiken, Betroffene, Umsetzungsweg, Analysen | Überblick in 10 Minuten | KI-Entwurf zu lang | Lesezeit bis erste Änderung |
| 3 Vollanalyse prüfen | Reiter Wettbewerb, Markt, Patente, Kaufen/Bauen, Business Case, Risiko | Nur noch prüfen statt recherchieren | Quellen falsch oder veraltet | Korrekturrate je Agent (R2-15) |
| 4 Aussagen korrigieren | Pro Aussage „korrigieren / verwerfen“ mit Grund | Fehler nicht weitertragen | Aufwand für Korrektur | Anzahl Korrekturen; Rückfluss in Testsatz |
| 5 Mit Ideengeberin abstimmen | Steckbrief mit Sperre je Abschnitt (30 Min.) | Ideengeberin bleibt an Bord | Gleichzeitige Bearbeitung | Anteil Steckbriefe mit Beiträgen der Ideengeberin |
| 6 Scorecard | Scorecard 1–5 mit Ankerbeispielen (`../prozess/scorecard.md`) | Vergleichbar bewerten | Anker unklar | Streuung zwischen Bewertenden |
| 7 Einreichen zu Gate 2 | Gremium-Agenda (max. 5 Ideen, Versand 5 AT vorher) | Termin sicher | Zu spät fertig | Anteil fristgerechter Vorlagen |
| 8 Wirkungsreview | Aufgabe nach 3–6 Monaten (R2-07) | Nutzen belegen | Nutzen schwer messbar | Ideen mit bestätigtem Nutzen an Gate 3 |

## 4 Kunden-Admin: Selbstregistrierung und externe Einreichende

**Persona:** Jonas, Leiter Produktmanagement bei *Pilotkunde A (Industrie, ca. 800 MA)*. Hat die öffentliche Demo gesehen und will das Portal mit seinem Team und zwei Schlüsselkunden testen.

| Schritt | Bildschirm | Ziel | Schmerzpunkt / Risiko | Messgröße |
| --- | --- | --- | --- | --- |
| 1 Demo ansehen | `/` Landingpage → „Demo ansehen“, Rolle wählen, Rollenwechsel oben | Ohne Konto verstehen, was das Produkt kann | Demo-Daten wirken unecht | Demo → Registrierung (Konversion) |
| 2 Arbeitsbereich anlegen | `/registrieren` (Name des Teams, Name, E-Mail, Passwort) | In 2 Minuten starten | Wo liegen die Daten? (EU-Hosting sichtbar machen) | Dauer bis erster Login |
| 3 MFA einrichten | „Zwei-Faktor-Anmeldung einrichten“ (Pflicht für Admins) | Sicherheit, ohne aufzuhalten | Keine Authenticator-App zur Hand | Abbrüche bei MFA-Einrichtung |
| 4 Rundgang | Onboarding-Dialog, Beispielidee, erste Challenge | Prinzip verstehen | Rundgang zu lang | Anteil, der den Rundgang beendet |
| 5 Prozess einstellen | `/einstellungen` Reiter Prozess, Themen und Kalender, Zielkanäle, Abgrenzung, Texte | Eigene Fristen, Themenfelder, Meldestelle | Zu viele Einstellungen | Anteil Arbeitsbereiche mit hinterlegter Meldestelle |
| 6 KI einstellen (Release 2) | `/einstellungen` Reiter „KI“: Anbieter, Modelle, Budget, Websuche | KI datenschutzkonform einschalten | Unklar, was das Haus verlässt | Anteil mit externem Anbieter; Budget-Warnungen |
| 7 Team einladen | Reiter Personen → Einladungslink `/beitreten/<code>` | Kolleg:innen in einer Minute dabei | Link landet bei Falschen | Beitritte je Link; Link neu erzeugt |
| 8 Externe einladen (Release 3, R3-19) | Einladung als „Externe:r“ | Kunden reichen Feature-Wünsche ein | Rechte an Ideen, Moderation | Externe Einreichungen je Monat |
| 9 Bestand importieren | Reiter Import (CSV/Excel) | Nicht leer starten | Spaltenzuordnung | Importierte Ideen; Dubletten |
| 10 Nutzen zeigen | `/dashboard` (ab 5 Personen) | Argument fürs Management | Zu wenig Daten im ersten Monat | Fristtreue, Zufriedenheit nach 3 Monaten |

**Offen (Product Owner):** Persona Jonas mit einem echten Gesprächspartner aus den Problem-Interviews (`../business/gespraechsleitfaden.md`) abgleichen.

## Gemeinsame Erkenntnisse

1. **Antwortfrist ist das Hauptversprechen.** Jede Ansicht, die eine Idee zeigt, zeigt auch Status und Restfrist.
2. **KI ist Entwurf, nie Entscheidung.** Vorschläge stehen neben dem Entscheidungsformular, nie an seiner Stelle.
3. **Mobil zählen vier Aufgaben:** einreichen, Status sehen, Rückfrage beantworten, kommentieren/unterstützen (siehe `mobil-und-barrierefreiheit.md`).
4. **Selbstbedienung braucht Vertrauen:** EU-Hosting, Datenschutzhinweis und Abgrenzung sind vor der Registrierung sichtbar.
