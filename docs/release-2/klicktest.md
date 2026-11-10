# Klicktest auf der Demo (Phase 1, AP-05)

Stand 12.10.2026 · **vorbereitet, Durchführung offen (Product Owner)**

Grundlage ist der Plan in `docs/release-0/ux/papiertest.md`. Der Klicktest läuft auf der öffentlichen Demo mit Rollenwechsel, nachdem AP-01 bis AP-04 dort live sind (Regel „Vertrauen vor Testen“). Ergebnisse trägt der Product Owner in die Tabellen unten ein; kritische Befunde werden Stories in Epic X und landen in AP-07.

## Voraussetzungen (vor dem ersten Termin abhaken)

- [ ] Demo zeigt den Stand von AP-01 bis AP-04 (Render-Deploy aus `main`, `DEMO_MODE=true`)
- [ ] `SIGNUP_ENABLED=true` (für Aufgabe D1), Rate-Limits aktiv
- [ ] Demo wurde am Testtag frisch angelegt (Reset alle 24 Stunden oder Neustart)
- [ ] Je Person ein eigenes Browserprofil oder privates Fenster (Rollenwechsel teilt sonst die Sitzung)
- [ ] Ein Smartphone für A5 und mobile Durchgänge, ein Rechner mit NVDA oder VoiceOver für mindestens eine Person
- [ ] Einverständniserklärung unterschrieben (Vorlage unten)

## Teilnehmende

| Nr. | Gruppe | Nutzerweg | Gerät | Hilfsmittel | Termin | Einverständnis |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | Ideengebende ohne Vorwissen | 1 | Laptop | – | | |
| P2 | Ideengebende ohne Vorwissen | 1 | Smartphone | – | | |
| P3 | Innovations- oder Ideenmanagement | 2 | Laptop | – | | |
| P4 | Innovations- oder Ideenmanagement | 2 | Laptop | Tastatur allein | | |
| P5 | Pate (Produkt oder Fachbereich) | 3 | Laptop | – | | |
| P6 | Pate (Produkt oder Fachbereich) | 3 | Laptop | Screenreader | | |
| P7 | Leitung Innovation (Kunden-Admin) | 4 | Laptop | – | | |
| P8 | Leitung Innovation (Kunden-Admin), optional | 4 | Smartphone | – | | |

## Aufgaben (so gesagt) mit Demo-Rolle

Ergänzt gegenüber dem Papiertest um die Funktionen aus Release 2 und Phase 1 (markiert mit „neu“).

| Nr. | Aufgabe | Demo-Rolle | Erfolg | Zeitlimit |
| --- | --- | --- | --- | --- |
| A1 | „Du hast eine Idee, wie Besprechungsräume besser genutzt werden. Reiche sie ein.“ | Ideengeber:in | Idee abgeschickt, Themenfeld und Art richtig | 5 Min. |
| A2 | „Es gibt schon eine ähnliche Idee. Was tust du?“ | Ideengeber:in | ähnliche Idee gefunden, anschließen oder bewusst eigene Idee | 2 Min. |
| A3 | „Dein Laptop startet nicht. Melde das.“ | Ideengeber:in | erkennt Hinweis, landet beim Service Desk, nichts gespeichert | 2 Min. |
| A4 | „Wann bekommst du eine Antwort? Was passiert als Nächstes?“ | Ideengeber:in | nennt Datum und nächsten Schritt | 1 Min. |
| A5 | „Beantworte die Rückfrage am Smartphone.“ | Ideengeber:in | Antwort gesendet, versteht die pausierte Frist | 3 Min. |
| A6 (neu) | „Was sagt die KI zu deiner Idee? Was heißt ‚Schätzung‘?“ | Ideengeber:in | findet die Kurzanalyse, erklärt Kennzeichnung; sieht keinen Spur-Vorschlag | 2 Min. |
| B1 | „Welche Idee ist am dringendsten?“ | Triage-Team | wählt die überfällige Idee über Ampel oder Text | 1 Min. |
| B2 | „Entscheide über diese Idee; nutze, was das System vorschlägt.“ | Triage-Team | Spur mit Begründung; liest KI-Vorschlag als Vorschlag | 4 Min. |
| B3 | „Leite dieses Anliegen an die richtige Stelle weiter.“ | Triage-Team | Zielkanal gewählt, Ideengebende informiert | 2 Min. |
| C1 | „Mach die Idee ‚Selbstservice-Portal‘ in 20 Minuten entscheidungsreif.“ | Triage-Team (als Pate) | findet Zusammenfassung, prüft mindestens eine Quelle | 20 Min. |
| C2 | „Diese Zahl im Business Case fehlt noch. Trag sie ein.“ (neu: „zu klären“) | Triage-Team | Wert eingetragen, Szenarien erscheinen | 3 Min. |
| C3 | „Bewerte die Idee mit der Scorecard.“ | Entscheidungsgremium | alle Kriterien bewertet, Anker genutzt | 5 Min. |
| C4 (neu) | „Lies die Gate-2-Vorlage. Woher stammt die Zahl zur Amortisation?“ | Entscheidungsgremium | öffnet die Grundlage der Kennzahl, nennt Quelle oder Schätzung; Lesezeit unter 10 Minuten | 10 Min. |
| D1 | „Leg einen Arbeitsbereich für dein Team an und lade zwei Kolleg:innen ein.“ | ohne Demo, Registrierung | Registrierung, MFA, Einladungslink kopiert | 8 Min. |
| D2 | „Stell ein, wohin Hinweise auf Rechtsverstöße gehen.“ | Admin | Zielkanal „Meldestelle“ geprüft oder angelegt | 3 Min. |
| D3 | „Schalte die KI so ein, dass vertrauliche Ideen das Haus nicht verlassen.“ | Admin | Vertraulich-Slot auf lokalen Anbieter; erklärt die Folge | 5 Min. |
| D4 (neu) | „Dein Betriebsrat fragt, welche Daten an KI-Dienste gingen. Zeig es ihm.“ | Admin | findet „KI-Nachweise“ und lädt ein PDF | 3 Min. |
| D5 (neu) | „Wie lange dauert Gate 1 im Moment, verglichen mit vorher?“ | Admin | findet Durchlaufzeiten im Dashboard, liest Median und Ausgangswert | 2 Min. |

**Bestanden, wenn:** je Aufgabe mindestens 80 % Erfolg ohne Hilfe; keine Aufgabe mit kritischem Missverständnis (KI-Vorschlag als Entscheidung gelesen, Meldung als Idee gespeichert, Schätzung als Beleg gelesen); SUS-Kurzform im Mittel mindestens 70.

## Beobachtungsbogen (je Person und Aufgabe)

| Person | Aufgabe | Erfolg (ja / mit Hilfe / nein) | Zeit | Zitat | Befund |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

## Nachbefragung (SUS-Kurzform, 1 = stimme gar nicht zu, 5 = stimme voll zu)

1. Ich würde das Ideenportal gern regelmäßig nutzen.
2. Ich fand das Portal unnötig kompliziert.
3. Ich fand das Portal einfach zu benutzen.
4. Ich würde Hilfe brauchen, um es zu nutzen.
5. Ich habe mich bei der Nutzung sicher gefühlt.

Dazu offen: „Wie sehr vertraust du den KI-Analysen, und warum?“ · „Hast du verstanden, bis wann du eine Antwort bekommst?“

## Ergebnisse (nach den Terminen ausfüllen)

| Aufgabe | Erfolg ohne Hilfe | Ø Zeit | Kritische Missverständnisse | bestanden |
| --- | --- | --- | --- | --- |
| A1 … D5 | | | | |

SUS-Mittelwert: · Lesezeit der Gate-2-Vorlage (Median aus Einstellungen › KI › Qualität):

## Befunde

| Nr. | Befund | Schweregrad (kritisch / hoch / mittel / niedrig) | Bildschirm | Aufgabe | Story-ID | Status |
| --- | --- | --- | --- | --- | --- | --- |
| K-01 | | | | | | |

Schweregrade und Folgen wie im Papiertest-Plan: kritisch vor dem Pilot beheben (Story in Epic X, AP-07), hoch im nächsten Inkrement, mittel ins Backlog, niedrig sammeln.

## Einverständniserklärung (Vorlage)

> Ich nehme freiwillig an einem Test des Ideenportals teil. Getestet wird das Produkt, nicht ich. Bildschirm und Ton werden aufgezeichnet, nur für die Auswertung genutzt, nicht weitergegeben und nach drei Monaten gelöscht. Ich kann jederzeit abbrechen. In der Demo gebe ich keine echten Daten ein.
>
> Name, Datum, Unterschrift

Keine Rechtsberatung; bei Tests mit Beschäftigten Betriebsrat vorab informieren.
