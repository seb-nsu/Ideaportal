# Plan für den Papier- und Klicktest

Stand 12.10.2026 · Release 0 · Entwurf

## Ziel

Prüfen, ob die vier Nutzerwege (`nutzerwege.md`) ohne Erklärung funktionieren, bevor Release 2 gebaut wird. Release-1-Bildschirme werden in der öffentlichen Demo getestet (Klicktest), Release-2-Bildschirme als Papier- oder Figma-Prototyp nach `hauptbildschirme.md`.

## Teilnehmende

| Gruppe | Anzahl | Nutzerweg | Herkunft |
| --- | --- | --- | --- |
| Ideengebende ohne Vorwissen | 2 | 1 | intern, verschiedene Bereiche |
| Innovations- oder Ideenmanagement | 2 | 2 | intern und Pilotkunde A |
| Produktmanager:in / Fachexpert:in als Pate | 2 | 3 | intern und Pilotkunde A oder B |
| Leitung Innovation oder Produkt (Kunden-Admin) | 1–2 | 4 | Pilotkunde A oder B |
| **Summe** | **7–8** (mind. 5) | | mind. 2 Personen je Nutzerweg |

Mindestens eine Person nutzt einen Screenreader oder die Tastatur allein; mindestens zwei Durchgänge laufen am Smartphone.

**Offen (Product Owner):** Namen der Teilnehmenden, Termin beim Pilotkunden, Einverständnis zur Aufzeichnung.

## Ablauf je Sitzung (45 Minuten)

1. Begrüßung, Einverständnis, „Wir testen das Produkt, nicht dich“ (5 Min.)
2. Kontextfragen: Wie läuft es heute mit Ideen? (5 Min.)
3. Aufgaben mit lautem Denken (25 Min.)
4. Nachbefragung: Vertrauen in KI, Verständlichkeit der Fristen, Note 1–5 (SUS-Kurzform mit 5 Fragen) (10 Min.)

## Aufgaben und Erfolgskriterien

| Nr. | Aufgabe (so gesagt) | Nutzerweg | Erfolg | Zeitlimit |
| --- | --- | --- | --- | --- |
| A1 | „Du hast eine Idee, wie Besprechungsräume besser genutzt werden. Reiche sie ein.“ | 1 | Idee abgeschickt, Themenfeld und Art richtig | 5 Min. |
| A2 | „Es gibt schon eine ähnliche Idee. Was tust du?“ | 1 | Ähnliche Idee gefunden, „anschließen“ oder bewusst eigene Idee | 2 Min. |
| A3 | „Dein Laptop startet nicht. Melde das.“ | 1 | Erkennt Hinweis und landet beim Service Desk; nichts gespeichert | 2 Min. |
| A4 | „Wann bekommst du eine Antwort? Was passiert als Nächstes?“ | 1 | Nennt Datum und nächsten Schritt korrekt | 1 Min. |
| A5 | „Beantworte die Rückfrage des Triage-Teams am Smartphone.“ | 1 | Antwort gesendet, versteht, dass die Frist pausiert war | 3 Min. |
| B1 | „Welche Idee ist am dringendsten?“ | 2 | Wählt überfällige Idee über Ampel/Text | 1 Min. |
| B2 | „Entscheide über diese Idee; nutze, was das System vorschlägt.“ | 2 | Spur mit Begründung; erkennt KI-Vorschlag als Vorschlag | 4 Min. |
| B3 | „Leite dieses Anliegen an die richtige Stelle weiter.“ | 2 | Zielkanal gewählt, Ideengeberin informiert | 2 Min. |
| C1 | „Mach diese Idee in 20 Minuten entscheidungsreif.“ | 3 | Findet Zusammenfassung, prüft mindestens eine Quelle | 20 Min. |
| C2 | „Diese Marktzahl stimmt nicht. Korrigiere sie.“ | 3 | Korrektur mit Grund gespeichert | 2 Min. |
| C3 | „Bewerte die Idee mit der Scorecard.“ | 3 | Alle 5 Kriterien bewertet, Anker genutzt | 5 Min. |
| D1 | „Leg einen Arbeitsbereich für dein Team an und lade zwei Kolleg:innen ein.“ | 4 | Registrierung, MFA, Einladungslink kopiert | 8 Min. |
| D2 | „Stell ein, wohin Hinweise auf Rechtsverstöße gehen.“ | 4 | Zielkanal „Meldestelle“ angelegt | 3 Min. |
| D3 | „Schalte die KI so ein, dass vertrauliche Ideen das Haus nicht verlassen.“ | 4 | Vertraulich-Slot auf lokalen Anbieter; erklärt Folge | 5 Min. |

**Gesamtkriterien für „bestanden“:** je Aufgabe ≥ 80 % Erfolg ohne Hilfe; keine Aufgabe mit kritischem Missverständnis (z. B. KI-Vorschlag als Entscheidung gelesen, Meldung als Idee gespeichert); SUS-Kurzform ≥ 70.

## Auswertung

| Schweregrad | Bedeutung | Folge |
| --- | --- | --- |
| kritisch | Aufgabe scheitert oder falsche Annahme mit Risiko (Datenschutz, Abgrenzung) | Vor Release 2 beheben |
| hoch | Aufgabe nur mit Hilfe | Story im nächsten Inkrement |
| mittel | Umweg, Zögern > 30 s | Backlog |
| niedrig | Wording, Geschmack | Sammeln |

Ergebnisse als Tabelle Befund × Schweregrad × Bildschirm × Story-ID in `docs/release-0/ux/papiertest-ergebnisse.md` (entsteht nach dem Test).

## Material

- Öffentliche Demo (`DEMO_MODE=true`) mit Rollenwechsel für Release 1
- Ausdrucke oder Figma-Prototyp für Steckbrief, Gremium, KI-Einstellungen
- Beobachtungsbogen: Aufgabe, Erfolg (ja/mit Hilfe/nein), Zeit, Zitat, Befund
- Einverständniserklärung (Aufzeichnung, Speicherdauer 3 Monate, keine Weitergabe)

## Zeitplan

| Woche | Schritt |
| --- | --- |
| R0-W2 | Prototypen fertig, Teilnehmende eingeladen |
| R0-W3 | 4 interne Sitzungen |
| R0-W3/4 | 3–4 Sitzungen bei Pilotkunde A |
| R0-W4 | Auswertung, Backlog-Anpassung |
