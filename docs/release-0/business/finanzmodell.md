# Finanzmodell SaaS (Version 3)

Stand 12.10.2026 · Release 0 · Entwurf · Arbeitspaket AP-10

> **Alle Zahlen sind Annahmen oder Schätzungen**, keine Prognose. Sie zeigen die Größenordnung und beantworten die Frage „Was muss stimmen, damit es sich rechnet?“. Jede Zahl ist mit **(A)** für Annahme, **(S)** für Schätzung oder Ergebnis der Rechnung oder mit einer Quelle markiert. Keine Steuer-, Finanz- oder Rechtsberatung.

## Was sich gegenüber Version 2 geändert hat

Grundlage sind die Befunde B-01 bis B-08 und B-12, B-16 aus dem Review V3 (`../../05-review-v3/review-markt-wettbewerb.md`, Abschnitte 5 und 8).

| Thema | Version 2 | Version 3 (hier) | Grund |
| --- | --- | --- | --- |
| Marktgröße | Top-down-Studien (5,9–7,1 Mrd. USD), Bottom-up offen | **Bottom-up DACH** als Hauptargument, Gartner (ca. 2 Mrd. USD weltweit) als Obergrenze | B-01, B-02 |
| Pakete | Start 490 €, Business 1.490 €, Enterprise ab 2.990 € | Team 590 €, Business 1.490 € / 2.490 €, Enterprise ab 3.990 €, Challenge-Paket 2.500 €, Modul Vorschlagswesen | B-06 |
| Jahresumsatz je Kunde (Lizenz) | 15.780 € | **23.820 € (S)**, im Zielband 22.000–25.000 € | B-06 |
| Einführung | 7.500 € bei 50 % der Neukunden | Pflicht ab Business, im Mittel 10.000 € (A) bei 80 % der Neukunden | B-06 |
| Pilotkunden | 0 € bis Monat 12, dann 50 % | **Design-Partner zu 250 € pro Monat**, danach 50 % im ersten Vertragsjahr | B-12 |
| Vertrieb | Budget im Posten „Sonstiges“ versteckt | **Vertriebsbudget separat** (2.000 € ab Monat 7, 3.000 € ab Monat 12), Vertriebsstelle ab Monat 8 | B-07 |
| Partner | nicht im Modell | **Partnerprovision 20 %** im ersten Vertragsjahr für die Hälfte der Neukunden; Sensitivität 15 % | B-07 |
| Zahlungsweise | monatlich | **Jahresvorauszahlung** bei 70 % der Kunden (A); Liquidität getrennt vom Ergebnis | B-07 |
| Kündigungen | 8 % pro Jahr | **8 % und 15 %** pro Jahr gerechnet; Planungswert 15 % | B-08 |
| Zeitachse | Monat 1 = Baustart Release 1, Marktstart Monat 15 | **Monat 1 = Beginn Phase 1** (Release 1 und 2 sind gebaut), Marktstart Monat 10 | Umsetzungskonzept V3, Abschnitt 4 |
| Team | fester Plan bis 8,7 Stellen | Grundteam fest, weitere Stellen **an gewonnene Kunden gekoppelt** | B-07, Lesart V2 |
| Finanzierung | Bedarf genannt, Quelle offen | **Szenarien Bootstrap, Förderung, strategischer Partner** | B-02, B-16 |

**Wichtig für den Vergleich:** Version 2 begann mit dem Bau von Release 1. Version 3 beginnt nach dem Bau von Release 1 und 2. Die Kosten für Release 1 und 2 sind hier **nicht enthalten** (bereits angefallen). Break-even und Finanzierungsbedarf sind deshalb nicht direkt mit Version 2 vergleichbar. Gerechnet ab Marktstart liegt der Break-even im Basisszenario nach etwa 25 Monaten (Version 2: Monat 40 bei Marktstart Monat 15, also ebenfalls nach etwa 25 Monaten). Der höhere Umsatz je Kunde wird also weitgehend durch Vertriebskosten, Provisionen, frühere Vertriebsstelle und vorsichtigere Kündigungsrate aufgezehrt. Die Erwartung aus dem Review („Break-even 8–10 Monate früher“) bestätigt sich **nicht**, sobald der Vertrieb ehrlich mitgerechnet wird.

## Markt: Bottom-up DACH

| Schritt | Wert | Grundlage |
| --- | --- | --- |
| Weltmarkt Innovationsmanagement-Plattformen 2025 | ca. 2 Mrd. USD, bis 2032 über 3 Mrd. USD | Gartner Market Guide 2025, zitiert bei [HYPE (21.09.2025)](https://www.hypeinnovation.com/news/innovation-management-in-2025-ai-is-taking-over-but-thats-not-enough); dient nur als Obergrenze |
| Unternehmen ab 250 Mitarbeitenden in Deutschland | ca. 18.600 (18.632) | [Antwort der Bundesregierung, Daten 2024](https://der-betrieb.de/?p=45501), [Drucksache 21/7502](https://dserver.bundestag.de/btd/21/075/2107502.pdf) |
| Österreich und Schweiz | ca. 3.000–3.500 (S) | Schätzung aus Beschäftigtenanteilen, keine Primärquelle (Review B-02); [WKO KMU-Statistik 2024](https://www.wko.at/statistik/wgraf/2025-28-kmu-2024.pdf) als Anhalt |
| DACH gesamt | ca. 22.000 (S) | Summe; enthält auch Unternehmen über 5.000 Mitarbeitende, die nicht zur Zielgruppe gehören (Anteil nicht herausgerechnet) |
| davon mit Innovations- oder Strategieteam und Budget für ein Werkzeug | 20–30 % (S) → ca. 4.500–6.500 (S) | Schätzung Review B-02; **in den Interviews zu prüfen** (`gespraechsleitfaden.md`, Screener) |
| Erreichbares Marktvolumen (SAM) | ca. 100–160 Mio. € pro Jahr (S) | 4.500–6.500 Unternehmen × Ziel-ARPA 22.000–25.000 € (Version 2 mit 15.800 €: ca. 70–100 Mio. €) |
| Ziel des Geschäftsmodells | 30–80 Kunden (A) | Produktkonzept Teil B, Geschäftsmodell |
| Realistisch erreichbar in 5 Jahren (SOM) | ca. 0,7–1,9 Mio. € ARR (S) | 30–80 Kunden × 23.820 €; entspricht 0,5–1,8 % der 4.500–6.500 Unternehmen |

**Lesart:** Der Markt trägt ein fokussiertes Unternehmen mit 1–2 Mio. € ARR. Für Risikokapital ist er zu klein. Das Basisszenario unten erreicht nach 60 Monaten 75 Kunden und 1,78 Mio. € ARR (S), liegt also am oberen Rand des SOM.

**Pipeline-Bedarf:** Ein Neukunde pro Monat braucht etwa 10–15 qualifizierte Gespräche pro Monat bei einer Abschlussquote von 7–10 % (Schätzung, Review B-07). Bei 2 Neukunden pro Monat (ab Monat 35) sind es 20–30 Gespräche. Ohne Partnerkanal ist das mit einer Vertriebsstelle nicht zu schaffen.

## Annahmen

### Pakete, Preise und Mix

Preise aus dem Produktkonzept (Teil B, Preismodell), Mix je Neukunde (A). Abrechnung nach Zahl der Mitarbeitenden.

| Paket | Preis je Monat | Jahr | Anteil Neukunden (A) | Ideen je Jahr (A) |
| --- | --- | --- | --- | --- |
| Team (bis 500 MA) | 590 € | 7.080 € | 20 % | 100 |
| Business (bis 1.000 MA) | 1.490 € | 17.880 € | 35 % | 250 |
| Business (bis 2.500 MA) | 2.490 € | 29.880 € | 30 % | 450 |
| Enterprise (ab 2.500 MA, Mindestpreis gerechnet) | 3.990 € | 47.880 € | 15 % | 800 |
| **Mittel je Neukunde** | **1.985 € (S)** | **23.820 € (S)** | | **362 (S)** |

Weitere Erlöse und Regeln:

| Posten | Annahme |
| --- | --- |
| Einführung | Pflicht ab Business (80 % der Neukunden), im Mittel 10.000 € (A; Spanne 7.500–20.000 €); 30 % davon als Fremdleistung an Partner (A) |
| Challenge-Paket | 2.500 € einmalig; 0,5 Pakete pro Monat ab Marktstart im Basisszenario (A); Übergänge in eine Jahreslizenz sind in den Neukunden enthalten |
| Modul Vorschlagswesen | **nicht gerechnet**, bis die Segmententscheidung fällt (`interviewleitfaden-vorschlagswesen.md`); Hebel siehe unten |
| KI-Zukauf über das Kontingent | nicht gerechnet (Hebel) |
| Design-Partner | 3 Design-Partner zahlen 250 € pro Monat von Monat 2 bis Monat 9 (A). Zum Marktstart wechseln 2 von 3 in das Paket Business (bis 1.000 MA) mit 50 % Nachlass im ersten Vertragsjahr (A); keine Einführungsgebühr |
| Interner Mandant | zahlt nicht; Nutzen über den internen Business Case (Produktkonzept Teil A); KI-Kosten für 300 Ideen pro Jahr (A) sind enthalten |
| Jahresvorauszahlung | 70 % der Kunden zahlen jährlich im Voraus, 30 % monatlich (A). Wirkt nur auf die Liquidität, nicht auf das Ergebnis |
| Kündigungen | 8 % oder 15 % pro Jahr, wirksam zum Ende eines Vertragsjahres (A; Review B-08: B2B-SaaS im Mittelstand eher 10–15 %, Schätzung) |

### Zeitplan und Neukunden

Monat 1 ist der Beginn von Phase 1 „Härtung vor Demo und Pilot“ (voraussichtlich November 2026, A). Phasen nach Umsetzungskonzept Abschnitt 4, Szenario B.

| Ereignis | Monat |
| --- | --- |
| Phase 1 Härtung | 1 |
| Pilot (intern und Design-Partner), Phase 2 | 2–4 |
| Go/No-go nach 3 Monaten Pilot (`go-no-go.md`) | Ende 4 bzw. 5 |
| Phase 3 „Firmenfähig“ | 3–5 |
| Phase 4 „Marktreife“ | 5–9 |
| **Marktstart** | **10** |
| Erste zahlende Neukunden (Verkaufszyklus 6–12 Monate, Vorlauf über Design-Partner und Interviews) | ab 11 |

| Neukunden je Monat (A) | Monat 11–22 | Monat 23–34 | Monat 35–46 | Monat 47–60 |
| --- | --- | --- | --- | --- |
| Pessimistisch (× 0,5) | 0,5 | 0,75 | 1,0 | 1,25 |
| **Basis** | **1,0** | **1,5** | **2,0** | **2,5** |
| Optimistisch (× 1,5) | 1,5 | 2,25 | 3,0 | 3,75 |

Bruchteile sind Erwartungswerte. Im Basisszenario sind bis Monat 36 insgesamt 34 Neukunden plus 2 umgestellte Design-Partner gewonnen (S).

### Team (Vollkosten 100.000 € je Vollzeitstelle und Jahr, A)

Offen sind rund 396 Story Points, also etwa 396 Personentage mit Puffer (0,8 PT je SP plus 25 %; Produktkonzept). Mit 2 Entwickler:innen sind das etwa 9–10 Monate bis zum Ende von Release 4 (S).

| Rolle | Regel (A) | Basis: erreicht in Monat |
| --- | --- | --- |
| Entwicklung | 2 Stellen ab Monat 1; 3. Stelle ab 30 gewonnenen Neukunden | 34 |
| UX | 0,3 bis Monat 11, danach 0,2 | – |
| Product Owner | 1 Stelle ab Monat 1 | – |
| Vertrieb | 1 Stelle ab Monat 8 (2 Monate vor Marktstart); 2. ab 25, 3. ab 50 gewonnenen Neukunden | 31, 44 |
| Kundenbetreuung/Support | 0,5 Stellen je Stufe bei 8, 20, 40 und 60 aktiven Kunden | – |
| **Summe am Jahresende (Basis, S)** | Jahr 1: 4,2 · Jahr 2: 4,7 · Jahr 3: 7,2 · Jahr 4: 8,7 · Jahr 5: 9,2 | |

Die Kopplung an gewonnene Kunden (nicht an aktive) sorgt dafür, dass die Kündigungsrate nur über den Umsatz wirkt, nicht über den Personalplan.

### Kosten der Leistungserbringung und weitere Kosten

| Posten | Annahme |
| --- | --- |
| Plattform (App, Datenbank, Backups, Monitoring, Mail) | 300 € je Monat Grundlast + 25 € je Kunde und Monat (A) |
| Zahlungsabwicklung | 1 % des Umsatzes (A) |
| KI und Websuche | 1,45 € je Idee (S, Herleitung unten) × 362 Ideen je Kunde und Jahr (S) ≈ 44 € je Kunde und Monat (S) |
| Fremdleistung Einführung | 30 % des Einführungsumsatzes (A) |
| Sonstiges (Werkzeuge, Reisen, Verwaltung) | 1.500 € je Monat bis Monat 9, danach 2.500 € (A). Marketing liegt jetzt im Vertriebsbudget |
| **Vertriebsbudget** (Events, Content, Benchmark-Studie, Teams Store, Partner-Schulung) | **2.000 € je Monat ab Monat 7, 3.000 € je Monat ab Monat 12** (A; Review B-07: mindestens 2.000–3.000 € pro Monat) |
| **Partnerprovision** | **20 %** des Lizenzumsatzes im ersten Vertragsjahr, für 50 % der Neukunden (A; Spanne 15–20 %) |
| Einmalig | Rechteklärung, Gründung, Verträge 5.000 € (Monat 2); anwaltliche Prüfung der Muster-Betriebsvereinbarung 8.000 € (Monat 3, Exit-Kriterium Phase 3); Rechtstexte AGB/AVV 15.000 € (Monat 6); Penetrationstest 20.000 € (Monat 8), danach jährlich 15.000 € ab Monat 20 (A) |

## KI-Kosten je Idee (Schätzung, unverändert)

Preise aus den Standard-Einstellungen (`server/src/ai/settings.ts`, Euro je Million Tokens, Listenpreise 1:1 umgerechnet, gegen den eigenen Vertrag prüfen): `claude-haiku-5-5` 0,10 Eingabe / 0,50 Ausgabe; `claude-opus-5-5` 4 / 20. Websuche 0,005 € je Anfrage.

| Baustein | Modell | Tokens Eingabe / Ausgabe (S) | Suchanfragen | Kosten (S) |
| --- | --- | --- | --- | --- |
| Kurzanalyse | Haiku (Slot `fast`) | 15.000 / 2.000 | 6 | 0,0015 + 0,0010 + 0,03 = **0,03 €** |
| Triage-Vorschlag + Rückmeldungsentwurf | Haiku | 10.000 / 1.500 | – | **0,002 €** |
| Vollanalyse (ca. 10 Agenten, mehrere Werkzeugrunden) | Opus (Slot `deep`) | 400.000 / 50.000 | 60 | 1,60 + 1,00 + 0,30 = **2,90 €** |
| Aktualisierung vor Gate 2 (R2-32) | Opus | 200.000 / 25.000 | 30 | **1,45 €** |
| **Vollanalyse inkl. Aktualisierung** | | | | **4,35 €** |

Je Idee im Mittel, wenn 30 % (A) ausgearbeitet werden: 0,03 + 0,002 + 0,30 × 4,35 ≈ 1,34 €; mit Coach und Zusammenfassungen ≈ **1,45 € (S)**. Je Kunde und Jahr ≈ 362 × 1,45 ≈ **526 € (S)**, also rund **2,2 % des Lizenzumsatzes je Kunde (S)** (Version 2: 3 %). Die Vollanalyse-Kontingente der Pakete (Team 5, Business 20 bzw. 40 pro Monat) liegen über dem gerechneten Bedarf (Team 30, Business 75 bzw. 135, Enterprise 240 Vollanalysen pro Jahr bei 30 % Ausarbeitung, S). Vertrauliche Ideen auf eigenem Modell verursachen keine Tokenkosten, aber Betriebskosten beim Kunden.

## Rechenweg

Monatsrechnung über 60 Monate (Python-Skript `tools/finanzmodell.py`; Regeln vollständig oben). Jede Monatskohorte von Neukunden hat den mittleren Lizenzpreis von 1.985 €. Zum Ende jedes Vertragsjahres fällt der Anteil der Kündigungen weg. **ARR** = MRR × 12, nur Lizenzen (ohne Einführung und Challenge-Pakete). **Ergebnis** = Umsatz minus alle Kosten (periodengerecht). **Liquidität** = Zahlungseingänge (mit Jahresvorauszahlung) minus Kosten. **Break-even** = erster Monat nach Marktstart, ab dem das operative Monatsergebnis (ohne einmalige Kosten) bis Monat 60 nicht mehr negativ wird. **Finanzierungsbedarf** = tiefster Stand der kumulierten Liquidität.

## Ergebnis Basisszenario (Kündigungen 15 %)

### Monatliche Kosten (Auswahl, S)

| Monat | Stellen | Team | Leistungserbringung (davon KI) | Sonstiges | Vertriebsbudget | Partnerprovision | Einmalig | **Kosten gesamt** | Umsatz | Ergebnis |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 3 | 3,3 | 27.500 € | 473 € (91 €) | 1.500 € | 0 € | 0 € | 8.000 € | **37.473 €** | 750 € | −36.723 € |
| 9 | 4,3 | 35.833 € | 473 € (91 €) | 1.500 € | 2.000 € | 0 € | 0 € | **39.806 €** | 750 € | −39.056 € |
| 12 | 4,2 | 35.000 € | 3.131 € (184 €) | 2.500 € | 3.000 € | 397 € | 0 € | **44.028 €** | 14.710 € | −29.318 € |
| 24 | 4,7 | 39.167 € | 5.491 € (731 €) | 2.500 € | 3.000 € | 2.580 € | 0 € | **52.738 €** | 44.962 € | −7.776 € |
| 36 | 7,2 | 60.000 € | 8.202 € (1.459 €) | 2.500 € | 3.000 € | 3.772 € | 0 € | **77.474 €** | 81.921 € | +4.447 € |
| 48 | 8,7 | 72.500 € | 11.224 € (2.341 €) | 2.500 € | 3.000 € | 4.962 € | 0 € | **94.187 €** | 125.845 € | +31.658 € |
| 60 | 9,2 | 76.667 € | 13.183 € (3.309 €) | 2.500 € | 3.000 € | 5.955 € | 0 € | **101.304 €** | 169.706 € | +68.401 € |

Bis zum Marktstart kostet das Vorhaben rund 35.000–40.000 € pro Monat (S), fast nur Personal.

### Rampe über 36 Monate (Quartalsende, S)

Kunden = aktive zahlende Kunden inkl. umgestellter Design-Partner (Bruchteile durch Erwartungswerte).

| Monat | Kunden | MRR | ARR | Stellen | Ergebnis im Monat | Ergebnis kumuliert | Liquidität kumuliert |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3 | 0 (3 Design-Partner) | 750 € | 9.000 € | 3,3 | −36.700 € | −99.800 € | −99.800 € |
| 6 | 0 (3 Design-Partner) | 750 € | 9.000 € | 3,3 | −43.700 € | −201.000 € | −201.000 € |
| 9 | 0 (3 Design-Partner) | 750 € | 9.000 € | 4,3 | −39.100 € | −329.800 € | −329.800 € |
| 12 | 4 | 5.500 € | 65.500 € | 4,2 | −29.300 € | −428.000 € | −398.800 € |
| 15 | 7 | 11.400 € | 137.000 € | 4,2 | −24.200 € | −505.800 € | −443.300 € |
| 18 | 10 | 17.400 € | 208.400 € | 4,7 | −23.300 € | −580.800 € | −497.400 € |
| 21 | 13 | 23.300 € | 279.900 € | 4,7 | −18.200 € | −655.500 € | −563.800 € |
| 24 | 16 | 31.700 € | 380.600 € | 4,7 | −7.800 € | −689.000 € | −557.900 € |
| 27 | 20 | 39.800 € | 477.000 € | 5,2 | −4.600 € | −701.700 € | −525.600 € |
| 30 | 24 | 47.800 € | 573.500 € | 5,2 | +2.800 € | −700.600 € | −496.300 € |
| 33 | 28 | 55.800 € | 670.000 € | 6,2 | +1.900 € | −717.400 € | −501.900 € |
| 36 | 33 | 64.700 € | 776.000 € | 7,2 | +4.400 € | −715.900 € | −452.300 € |

### Jahresübersicht (S)

| Jahr | Kunden Ende | ARR Ende | Umsatz | Leistungserbringung (davon KI) | Team | Vertrieb (Budget + Provision) | Sonstiges + Einmalig | Ergebnis | kumuliert | Liquidität Ende |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 4 | 65.500 € | 36.200 € | 10.800 € (1.200 €) | 370.800 € | 13.600 € | 69.000 € | −428.000 € | −428.000 € | −398.800 € |
| 2 | 16 | 380.600 € | 344.600 € | 47.000 € (5.600 €) | 457.500 € | 55.900 € | 45.000 € | −260.900 € | −689.000 € | −557.900 € |
| 3 | 33 | 776.000 € | 757.200 € | 77.700 € (13.400 €) | 586.700 € | 74.700 € | 45.000 € | −26.900 € | −715.900 € | −452.300 € |
| 4 | 53 | 1.255.100 € | 1.246.700 € | 112.300 € (23.200 €) | 795.000 € | 89.000 € | 45.000 € | +205.300 € | −510.500 € | −88.500 € |
| 5 | 75 | 1.781.500 € | 1.801.900 € | 147.700 € (34.500 €) | 907.500 € | 103.000 € | 45.000 € | +598.600 € | +88.100 € | +676.100 € |

- **Bruttomarge** (Umsatz minus Leistungserbringung): Jahr 2 86 %, Jahr 3 90 %, Jahr 5 92 % (S). Die Einführung mit Fremdleistung senkt sie leicht. KI-Kosten liegen ab Jahr 2 bei unter 2 % des Umsatzes (S): kein Margenproblem.
- **Break-even:** ab **Monat 35** operativ dauerhaft positiv (S), bei ca. 32 Kunden.
- **Finanzierungsbedarf:** tiefster Stand der Liquidität **ca. −580.000 € (S) in Monat 22**; mit 20 % Reserve **ca. 0,7 Mio. € (S)**. Ohne Jahresvorauszahlung wären es ca. −720.000 € (S) in Monat 34.
- **Kumuliert positiv:** Ergebnis in Monat 59, Liquidität im Laufe von Jahr 5 (S).

## Szenarien und Kündigungsrate

| Szenario | Kündigungen | Kunden nach 36 M. | ARR nach 12 M. | ARR nach 24 M. | **ARR nach 36 M.** | ARR nach 60 M. | **Break-even (Monat)** | Finanzierungsbedarf (Liquidität) | Ergebnis kumuliert positiv |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Pessimistisch | 8 % | 18 | 41.700 € | 209.600 € | 419.200 € | 986.000 € | 52 | ca. 0,88 Mio. € | nicht bis Monat 60 |
| Pessimistisch | 15 % | 17 | 41.700 € | 205.500 € | 400.900 € | 900.100 € | 54 | ca. 0,91 Mio. € | nicht bis Monat 60 |
| Basis | 8 % | 34 | 65.500 € | 386.400 € | 808.100 € | 1.946.400 € | 35 | ca. 0,58 Mio. € | Monat 57 |
| **Basis** | **15 %** | **33** | **65.500 €** | **380.600 €** | **776.000 €** | **1.781.500 €** | **35** | **ca. 0,58 Mio. €** | **Monat 59** |
| Optimistisch | 8 % | 51 | 89.300 € | 563.100 € | 1.197.000 € | 2.906.800 € | 23 | ca. 0,43 Mio. € | Monat 45 |
| Optimistisch | 15 % | 49 | 89.300 € | 555.600 € | 1.151.200 € | 2.662.900 € | 23 | ca. 0,43 Mio. € | Monat 46 |

Weitere Sensitivitäten (Basis, Kündigungen 15 %, S):

| Änderung | Break-even (Monat) | Finanzierungsbedarf |
| --- | --- | --- |
| KI-Kosten × 3 (4,35 € je Idee) | 36 | ca. 0,59 Mio. € |
| Partnerprovision 15 % statt 20 % | 35 | ca. 0,58 Mio. € |
| keine Jahresvorauszahlung | 35 | ca. 0,72 Mio. € |

**Lesart:**

1. Der Engpass ist die **Zahl der Neukunden**, nicht die KI und nicht die Kündigungsrate. Halb so viele Neukunden verschieben den Break-even um rund 18 Monate und erhöhen den Bedarf um gut 0,3 Mio. €.
2. Die Kündigungsrate wirkt in den ersten drei Jahren kaum, weil Kündigungen erst zum Ende eines Vertragsjahres greifen und die meisten Kunden jung sind. Sie wirkt langfristig: 15 % statt 8 % kosten nach 60 Monaten 7 Kunden und rund 165.000 € ARR (Basis, S) und verschieben das kumuliert positive Ergebnis um 2 Monate. Der Review erwartete 3–6 Monate Verschiebung des Break-even (B-08); bei Jahresverträgen ist der Effekt kleiner.
3. Die **Jahresvorauszahlung** ist der stärkste Liquiditätshebel: Sie senkt den Finanzierungsbedarf um rund 140.000 € (S).
4. Im pessimistischen Fall muss der Ausbau weiter an Kunden gekoppelt bleiben. Dann sinkt der Bedarf nicht unter ca. 0,9 Mio. €, und der Break-even liegt nach Monat 50. Das ist ein Grund, den Go/No-go nach dem Pilot und die Segmententscheidung ernst zu nehmen.

## Kundengewinnungskosten (CAC) und Amortisation

CAC = Vertriebsstellen + Vertriebsbudget + Partnerprovision je gewonnenem Neukunden. Amortisation = CAC ÷ (Lizenz-MRR 1.985 € × Bruttomarge 95 %, S). Einführungsumsatz ist nicht gegengerechnet (vorsichtig).

| Zeitraum (Basis) | Vertriebskosten | Neukunden | CAC | Amortisation |
| --- | --- | --- | --- | --- |
| Monat 10–21 (erstes Verkaufsjahr) | 147.100 € | 11 | 13.400 € | 7 Monate |
| Monat 22–33 | 196.100 € | 17,5 | 11.200 € | 6 Monate |
| Monat 34–45 | 302.100 € | 23,5 | 12.900 € | 7 Monate |
| Monat 10–21 mit 0,5 Stelle Product Owner im Vertrieb | 197.100 € | 11 | 17.900 € | 10 Monate |
| Monat 10–21, pessimistisch | – | 5,5 | 25.600 € | 14 Monate |

Der Review schätzte 18–30 Monate Amortisation bei altem ARPA (B-06). Mit dem neuen Umsatz je Kunde liegt sie bei 6–14 Monaten (S). Das hält nur, wenn die Neukundenrate erreicht wird; die Vertriebskosten sind weitgehend fix.

## Finanzierung

Bedarf im Basisszenario: ca. 0,58 Mio. € (S), mit Reserve ca. 0,7 Mio. € (S). Kein Risikokapital-Plan (Review B-02, Produktkonzept Teil B).

| Variante | Annahme | Restbedarf (S) | Folge |
| --- | --- | --- | --- |
| **Bootstrap** (schlank) | 1 Entwickler:in bis 10 Neukunden, Product Owner ohne Gehalt bis 5 Neukunden (arbeitet daneben weiter, A), keine Vertriebsstelle bis 15 Neukunden, Vertriebsbudget 2.000 €; Roadmap langsamer, **Marktstart Monat 16** (A) | ca. 0,22 Mio. € (Monat 16), mit Reserve ca. 0,27 Mio. € | Break-even Monat 41; ARR nach 36 Monaten ca. 573.500 €, nach 60 Monaten ca. 1,53 Mio. €. Geringster Kapitalbedarf, aber 6 Monate später am Markt und hohe persönliche Last |
| **Förderung** | Zuschuss 50 % der Kosten für Entwicklung und UX in Monat 1–12 (A, ca. 115.000 €); Programm offen (z. B. EXIST, Landesprogramme; Bedingungen prüfen, EXIST setzt eine Hochschulanbindung voraus) | ca. 0,46 Mio. € | Förderung allein reicht nicht; nur mit einer zweiten Quelle |
| **Strategischer Partner** | Ein Partner trägt das Team bis zum Marktstart (Monat 1–9, ca. 264.000 €) gegen Beteiligung oder Lizenz (Lizenzmodell) | ca. 0,32 Mio. € | Partner wird erster Referenzkunde; Rechte und Anteile müssen schriftlich geregelt sein |
| **Partner + Förderung** | beide oben | ca. 0,20 Mio. € | Rest über Gründer:innen, Bankdarlehen oder Business Angels (A) |

Empfehlung aus Sicht des Modells (keine Finanzberatung): Partner-Szenario oder Kombination mit Förderung prüfen. Bootstrap nur, wenn ein späterer Marktstart akzeptiert wird.

## Hebel

1. **Neukundenrate über Partner** (3–5 Beratungen, 15–20 % Provision): jeder zusätzliche Neukunde pro Quartal ≈ +95.000 € ARR nach 12 Monaten (S).
2. **Jahresvorauszahlung** als Standard: −140.000 € Finanzierungsbedarf (S).
3. **Modul Vorschlagswesen** (+490 € / +990 € pro Monat): bei 30 % der Business- und Enterprise-Kunden ca. +1.700 € ARPA (S); Entscheidung nach den Interviews.
4. **Höherer Enterprise-Anteil** und Staffel je 1.000 MA (hier nur Mindestpreis gerechnet).
5. **KI-Zukauf** nach Verbrauch über dem Kontingent (R3-06).
6. **Mehrjahresverträge** und Integration in den Entscheidungsprozess senken die Kündigungsrate (Review B-08).

## Offen

- **Offen (Product Owner):** Finanzierungsvariante entscheiden; Kosten der eigenen Rolle bestätigen (hier 1 Stelle ab Monat 1).
- **Offen (Product Owner):** Preise und Paketmix in 10–15 Interviews mit Van-Westendorp-Fragen prüfen (`gespraechsleitfaden.md`, Block E); Annahme „20–30 % mit Team und Budget“ im Screener prüfen.
- **Offen (Product Owner):** Gehälter, Tagessätze und Kanzleikosten durch Angebote ersetzen; Förderprogramme konkret prüfen.
- **Offen (Product Owner):** Pilot-Konditionen in `../prozess/pilotbereich.md` und `vertragsgrundlagen.md` (dort noch „kostenfrei, danach 50 %“) an den Design-Partner-Preis von 250 € angleichen.
