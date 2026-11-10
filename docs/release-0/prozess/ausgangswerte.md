# Ausgangswerte vor dem Pilot

Stand 12.10.2026 · Release 0 · Entwurf

Ohne Ausgangswerte lässt sich nach dem Pilot nicht zeigen, ob das Portal etwas verbessert. Die Werte werden vor dem Start erhoben, intern und bei jedem Pilotkunden, und im Pilot mit denselben Definitionen aus dem Dashboard (R1-37) gemessen.

## Kennzahlen

| Nr. | Kennzahl | Definition | Methode heute | Messung im Pilot | Zielwert (Startannahme) | Verantwortlich |
| --- | --- | --- | --- | --- | --- | --- |
| K1 | Antwortzeit | Arbeitstage von Einreichung bis zur ersten inhaltlichen Rückmeldung (Median, 80-%-Wert) | Stichprobe der letzten 20–30 Ideen aus Mail, Excel oder Tool; Datum Eingang und Antwort | Dashboard „Ø Tage bis Gate 1“, Fristtreue | ≥ 90 % in ≤ 10 AT | Ideenmanagement |
| K2 | Anteil ohne Antwort | Ideen der letzten 12 Monate ohne jede Rückmeldung | Stichprobe wie K1 | Status „Geschlossen“ ohne Begründung (sollte 0 sein) | 0 % | Ideenmanagement |
| K3 | Realisierungsquote | Umgesetzte Ideen ÷ eingereichte Ideen (12 Monate) | Bestandsliste; Abgleich mit Projektliste | Dashboard „Realisierungsquote“ | Ausgangswert + 10 Prozentpunkte | Ideenmanagement |
| K4 | Umsetzungsquote nach Freigabe | Umgesetzte ÷ freigegebene Ideen | wie K3 | Umsetzungen mit Status „done“ | ≥ 60 % | Ideenmanagement |
| K5 | Durchlaufzeit bis Entscheidung | Kalendertage bis zur Investitionsentscheidung | Stichprobe 10 große Ideen | Einreichung → Gate 2 | ≤ 60 Tage | Innovationsleitung |
| K6 | Zufriedenheit der Ideengebenden | „Wie zufrieden bist du mit dem Umgang mit deiner Idee?“ 1–5 | Kurzumfrage (5 Fragen) an alle, die in 12 Monaten eingereicht haben | Ein-Klick-Abfrage (R1-35) | ≥ 4 von 5 | Product Owner |
| K7 | Beteiligung | Personen mit Idee, Kommentar oder Mitarbeit ÷ Mitarbeitende im Bereich | Bestandsliste | Dashboard (ab 5 Personen) | ≥ 15 % pro Jahr | Ideenmanagement |
| K8 | Aufwand je Bewertung | Stunden für Recherche und Vorlage je ausgearbeiteter Idee | Selbstauskunft von 3–5 Paten / Produktmanager:innen | Zeitangabe im Steckbrief (R2) | −50 % mit KI-Analyse | Product Owner |
| K9 | Belegter Nutzen | Summe Ist-Nutzen umgesetzter Ideen mit Nachweis | meist nicht vorhanden → „0 belegt“ | Abschluss mit Ist-Nutzen (R1-32), Gate 3 | Ausgangswert im Pilot messen | Controlling / Sponsor |
| K10 | Fehlgeleitete Anliegen | Anteil Einreichungen, die Meldungen, Störungen oder Beschwerden sind | Stichprobe wie K1 | Abgrenzungstreffer, Weiterleitungen | sinkt | Ideenmanagement |

K8 ist der wichtigste Wert für das SaaS-Versprechen „KI arbeitet aus“ und sollte bei jedem Pilotkunden erhoben werden.

## Vorgehen

1. **Bestand sichern (Woche 1):** Ideenliste der letzten 12 Monate als CSV oder Excel; sie dient zugleich als Import (R1-39).
2. **Stichprobe ziehen (Woche 1–2):** 20–30 Ideen zufällig; je Idee Datum Eingang, erste Rückmeldung, Ergebnis, Umsetzung, Nutzen (falls bekannt).
3. **Kurzumfrage (Woche 2):** 5 Fragen, anonym, Auswertung nur zusammengefasst und erst ab 5 Antworten.
4. **Interviews zu K8 (Woche 2–3):** 3–5 Personen, 20 Minuten, Leitfragen aus `../business/gespraechsleitfaden.md` Block C.
5. **Dokumentieren (Woche 3):** Tabelle unten ausfüllen, Quelle und Unsicherheit je Wert.

### Kurzumfrage (Vorlage)

1. Wie zufrieden bist du mit dem Umgang mit deiner letzten Idee? (1–5)
2. Wie lange hat es bis zur ersten Antwort gedauert? (< 1 Woche · 1–4 Wochen · > 1 Monat · nie)
3. Weißt du, was aus deiner Idee geworden ist? (ja · teilweise · nein)
4. Würdest du wieder eine Idee einreichen? (ja · vielleicht · nein)
5. Was müsste sich ändern? (Freitext, optional)

## Erhebungsbogen

| Kennzahl | Intern | Pilotkunde A | Pilotkunde B | Quelle | Unsicherheit |
| --- | --- | --- | --- | --- | --- |
| K1 Antwortzeit (Median AT) | | | | | |
| K2 ohne Antwort (%) | | | | | |
| K3 Realisierungsquote (%) | | | | | |
| K4 Umsetzung nach Freigabe (%) | | | | | |
| K5 Durchlaufzeit (Tage) | | | | | |
| K6 Zufriedenheit (1–5) | | | | | |
| K7 Beteiligung (%) | | | | | |
| K8 Aufwand je Bewertung (h) | | | | | |
| K9 Belegter Nutzen (€) | | | | | |
| K10 Fehlgeleitete Anliegen (%) | | | | | |

**Offen (Product Owner):** Echte Ausgangswerte erheben. Annahmen bis dahin (nur zur Planung): Antwortzeit Median 25 AT, 30 % ohne Antwort, Realisierungsquote 15 %, Zufriedenheit 2,8, Aufwand je Bewertung 6–10 h.

## Datenschutz

Stichproben und Umfrage nur zusammengefasst auswerten; keine Auswertung nach Personen; Gruppen unter 5 Personen zusammenfassen. Rohdaten nach der Auswertung löschen (spätestens nach dem Go/No-go).
