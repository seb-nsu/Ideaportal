# Interviewleitfaden Segmententscheidung Vorschlagswesen (Modul Z)

Stand 12.10.2026 · Release 0 · Arbeitspaket AP-10

**Status: vorbereitet, Interviews offen (Product Owner).**

## Ziel

Entscheiden, ob das Ideenportal das **Modul Z „Vorschlagswesen“** baut (R3-35 Fachgutachten und Kommission, R3-36 Prämienregeln, R3-37 QR- und Kiosk-Einreichung, R3-38 Benchmark-Kennzahlen; zusammen 24 SP) **oder die Industrie als Zielbranche für das Vorschlagswesen streicht** (Review V3, Befund L-10 und Use-Case BVW; `../../05-review-v3/einarbeitung.md`, Leitentscheidung 3).

Bis zur Entscheidung stehen die Stories von Epic Z mit Priorität „Soll“ im Backlog. Phase 4 baut Epic Z nur nach positiver Entscheidung (Umsetzungskonzept Abschnitt 4).

Die Interviews prüfen drei Fragen:

1. Ist der Schmerz im betrieblichen Vorschlagswesen (BVW) groß genug, und trifft ihn die Stärke des Ideenportals (Fristen, Wirkungsnachweis, Mitbestimmungs-Design)?
2. Reichen die geplanten 24 SP, oder fehlen Pflichtfunktionen (Prämienlogik, Payroll, Shopfloor), die den Aufwand sprengen?
3. Gibt es Zahlungsbereitschaft und einen erreichbaren Käufer, trotz etablierter Anbieter (HYPE Improve, trideoX, target, Trevios, HCM Ideos, Innolytics)?

## Wen befragen (10 Interviews)

| Gruppe | Anzahl | Warum |
| --- | --- | --- |
| Ideenmanager:in / BVW-Verantwortliche:r in Industrie (Maschinenbau, Automotive-Zulieferer, Metall, Chemie), 500–5.000 MA | 4 | Kernzielgruppe des Moduls |
| BVW-Verantwortliche:r in Energie/Versorgung oder Versicherung | 2 | Branchen der Primärzielgruppe mit etabliertem BVW |
| Betriebsratsmitglied mit Zuständigkeit für BVW oder IT-Vereinbarungen | 2 | Mitbestimmung nach § 87 Abs. 1 Nr. 12 BetrVG und Nr. 6 (keine Rechtsberatung); prüft die Muster-Betriebsvereinbarung |
| Bestandskunde eines auslaufenden Systems (IBYKUS id-Force, Weiterentwicklung endet 31.12.2025; HLP, wird in HYPE überführt) | 1 | Migrationschance (Review Abschnitt 8) |
| Beratung oder Netzwerk Ideenmanagement (z. B. Zentrum Ideenmanagement, Neckel-Netzwerk, Koblank) | 1 | Marktüberblick, möglicher Partnerkanal |

Mindestens 3 der 10 Personen sollen über Budget entscheiden oder es beantragen. Mindestens 6 Unternehmen sollen eine gültige Betriebsvereinbarung zum BVW haben.

## Screener (vorab, 5 Minuten)

| Frage | Einschluss |
| --- | --- |
| Wie groß ist Ihr Unternehmen bzw. der Betrieb? | 250–5.000 MA (Beratung: entfällt) |
| Gibt es ein betriebliches Vorschlagswesen oder KVP mit Prämien? | ja (außer Beratung) |
| Gibt es eine Betriebsvereinbarung zum Vorschlagswesen? Aus welchem Jahr? | notieren |
| Wie viele Vorschläge gehen im Jahr ein? | ≥ 50 |
| Womit wird das BVW heute verwaltet? | notieren (Software, Version, Vertragsende) |
| Welche Rolle haben Sie? | Ideenmanagement, BVW, KVP, HR, Betriebsrat, Beratung |
| Sitz | DACH |

## Ablauf (50 Minuten)

Problem-Interview, kein Verkaufsgespräch. Nach vergangenem Verhalten fragen, Zahlen nachfragen („Woher wissen Sie das?“), keine Suggestivfragen. Demo erst am Ende und nur auf Wunsch.

### A Einstieg (5 Min.)

1. Erzählen Sie kurz von Ihrer Rolle und davon, wie das Vorschlagswesen bei Ihnen organisiert ist (zentral, über Vorgesetzte, Teams).
2. Welche Kennzahlen berichten Sie, und an wen?

### B Heutiger Ablauf (10 Min.) – Z1, Z2

3. Erzählen Sie mir vom letzten Vorschlag, der prämiert wurde. Was ist passiert, Schritt für Schritt, von der Einreichung bis zur Auszahlung?
4. Wie lange hat das gedauert? Wo hat es am längsten gelegen?
5. Wie viele Vorschläge sind gerade offen? Wie viele davon warten auf ein Gutachten?
6. Wie werden Gutachter:innen ausgewählt und erinnert? Was passiert, wenn ein Gutachten nicht kommt?
7. Gibt es eine Kommission? Wie oft tagt sie, wie wird sie vorbereitet?
8. Wie sehen Sie heute Beteiligungsquote, Umsetzungsquote und Durchlaufzeit? Nehmen Sie am Kennzahlenvergleich teil?

### C Betriebsvereinbarung und Mitbestimmung (8 Min.) – Z3

9. Was regelt Ihre Betriebsvereinbarung zum Vorschlagswesen? (Prämienformel, Kommission, Einspruch, Fristen, Datenschutz)
10. Gibt es eine eigene IT-Rahmenvereinbarung, unter die eine neue Software fallen würde?
11. Wie lange hat die Einführung des heutigen Systems mit dem Betriebsrat gedauert? Was waren die Streitpunkte?
12. Wie steht der Betriebsrat zu KI im Vorschlagswesen (Formulierungshilfe, Dubletten, Nutzenschätzung)? Wo sind Grenzen?
13. (Betriebsrat) Was müsste eine Muster-Betriebsvereinbarung enthalten, damit Sie sie als Grundlage akzeptieren? (Entwurf: `muster-betriebsvereinbarung.md`)

### D Prämien und Nutzen (8 Min.) – Z4

14. Wie wird die Prämie berechnet? (Anteil am Erstjahresnettonutzen, Punkte, Pauschalen, Deckel, Anerkennungsprämie, Teilung bei Gruppen)
15. Wer berechnet und wer gibt frei (Ideenmanagement, HR, Kommission)? Wie kommt die Prämie in die Lohnabrechnung (Export, SAP, von Hand)?
16. Wie wird der Nutzen ermittelt und nach 12 Monaten nachgeprüft? Wer bestätigt ihn (Controlling)?
17. Was ist der aufwendigste oder fehleranfälligste Schritt bei Prämien?

### E Shopfloor und Beteiligung (5 Min.) – Z5

18. Wie reichen Mitarbeitende ohne PC-Arbeitsplatz heute ein? (Papier, Kiosk, Vorgesetzte, App, QR)
19. Welche Sprachen sprechen die Einreichenden? Wie wird übersetzt?
20. Wie viel Prozent der Vorschläge kommen aus Produktion und Logistik?

### F Werkzeuge und Wechsel (6 Min.) – Z6

21. Welche Software nutzen Sie (z. B. HYPE Improve, trideoX, target, Trevios, HCM Ideos, Innolytics, Eigenbau, Excel)? Seit wann, und wann endet der Vertrag?
22. Was fehlt Ihnen am heutigen Werkzeug? Was würden Sie auf keinen Fall aufgeben?
23. Haben Sie in den letzten 3 Jahren einen Wechsel erwogen? Was hat ihn verhindert?
24. Wie wichtig wären Ihnen verbindliche Fristen für Gutachten mit Vertretung und Eskalation, und ein bestätigter Nutzen je Vorschlag? (erst fragen, nachdem 4–6 beantwortet sind)

### G Zahlungsbereitschaft und Entscheidungsweg (6 Min.) – Z7, Z8

25. Was kostet Ihr heutiges System pro Jahr (Lizenz, Wartung, Customizing, interne Betreuung)?
26. Wer entscheidet über ein neues System für das Vorschlagswesen (Ideenmanagement, HR, IT, Einkauf, Betriebsrat, Geschäftsführung)? Wie lange dauert das?
27. Preisfragen nach Van Westendorp für das Modul Vorschlagswesen als Zusatz zum Business-Paket (Fragen und Reihenfolge wie in `gespraechsleitfaden.md`, Block E). Listenpreis-Hypothese: +490 € pro Monat (Business), +990 € (Enterprise), zusätzlich zum Paket ab 1.490 €.
28. Würde ein Migrationsangebot (Import plus Einführung zum Festpreis) einen Wechsel wahrscheinlicher machen?

### H Abschluss (2 Min.)

29. Mit wem sollte ich noch sprechen?
30. Dürfen wir Sie für einen Test des Moduls oder als Design-Partner ansprechen?

## Hypothesen mit Schwellen

„Erfüllt“ heißt: die Schwelle ist in den 10 Interviews erreicht. Gezählt werden nur Gespräche, in denen die Frage beantwortet wurde (Beratung und Betriebsrat zählen bei Z4, Z6, Z7 nicht mit).

| Nr. | Hypothese | Erfüllt, wenn … | Nicht erfüllt, wenn … | Gewicht |
| --- | --- | --- | --- | --- |
| Z1 | Lange Durchlaufzeiten, vor allem bei Gutachten, sind ein Hauptschmerz. | ≥ 60 % nennen Gutachten oder Kommission als längsten Schritt; Median-Durchlaufzeit > 60 Tage | < 40 % oder Durchlaufzeit unbekannt und egal | Muss |
| Z2 | Wirkung und Nutzen sind schwer zu belegen. | ≥ 50 % haben keine systematische Nachprüfung nach 12 Monaten oder keine Bestätigung durch Controlling | Nachprüfung läuft bei der Mehrheit gut | Soll |
| Z3 | Ein fertiges Mitbestimmungs-Paket (Leserolle, Muster-BV, Datenschutz-Nachweis) verkürzt die Einführung spürbar. | ≥ 2 der 2 Betriebsratsmitglieder und ≥ 50 % der übrigen halten es für hilfreich; genannte Verkürzung ≥ 2 Monate | Betriebsrat lehnt Muster ab oder BV-Abschluss ist kein Engpass | Muss |
| Z4 | Die Prämienlogik passt in das geplante Regelwerk (R3-36). | ≥ 70 % der Prämienformeln lassen sich mit Prozentsatz, Punkten, Pauschalen, Deckel, Teilung und Nachberechnung abbilden; Payroll per CSV-Export reicht bei ≥ 50 % | Mehrheit braucht SAP-HCM-Integration oder Sonderlogik je Werk | Muss |
| Z5 | Shopfloor-Einreichung per QR und Kiosk genügt. | ≥ 50 % sehen QR/Kiosk plus Stellvertreter-Einreichung als ausreichend | Mehrheit verlangt native App oder Terminal-Integration | Soll |
| Z6 | Es gibt Wechselbereitschaft. | ≥ 3 Unternehmen planen einen Wechsel in 24 Monaten oder haben ein auslaufendes System (id-Force, HLP) | niemand erwägt einen Wechsel | Muss |
| Z7 | Zahlungsbereitschaft für das Modul liegt im Band. | ≥ 3 Gespräche mit akzeptablem Preisbereich, der +490 € pro Monat (zusätzlich zu Business) einschließt, und benannter Budgetquelle | akzeptabler Preis klar darunter oder Budget nur für Bestandssystem | Muss |
| Z8 | Käufer und Entscheidungsweg sind erreichbar. | Käufer ist bei ≥ 50 % dieselbe Stelle wie für Innovation oder eng verbunden; Entscheidung ≤ 9 Monate | Kauf nur über Konzern-IT oder zentrale HR-Ausschreibung | Soll |

## Auswertung (10 Interviews)

Je Gespräch und Hypothese: **+** (stützt), **0** (neutral oder nicht beantwortet), **−** (widerlegt). Kürzel der Gruppe: I = Industrie, E = Energie/Versicherung, B = Betriebsrat, M = Migration, N = Netzwerk/Beratung.

| Nr. | Datum | Gruppe | Größe | BV BVW ja/nein | Werkzeug heute | Z1 | Z2 | Z3 | Z4 | Z5 | Z6 | Z7 | Z8 | Kernzitat |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | | | | | | | | | | | | | | |
| 2 | | | | | | | | | | | | | | |
| 3 | | | | | | | | | | | | | | |
| 4 | | | | | | | | | | | | | | |
| 5 | | | | | | | | | | | | | | |
| 6 | | | | | | | | | | | | | | |
| 7 | | | | | | | | | | | | | | |
| 8 | | | | | | | | | | | | | | |
| 9 | | | | | | | | | | | | | | |
| 10 | | | | | | | | | | | | | | |
| **Summe +** | | | | | | | | | | | | | | |
| **Schwelle erfüllt?** | | | | | | | | | | | | | | |

Zusätzlich je Gespräch: Durchlaufzeit (Median), Vorschläge pro Jahr, Systemkosten pro Jahr, Vertragsende, genannte Pflichtfunktionen, die in R3-35 bis R3-38 fehlen.

## Entscheidungsregel „Modul Z ja/nein“

| Ergebnis | Entscheidung | Folge |
| --- | --- | --- |
| Alle Muss-Hypothesen (Z1, Z3, Z4, Z6, Z7) erfüllt und mindestens 1 Soll-Hypothese erfüllt | **Modul Z: ja** | Epic Z in Phase 4 bauen (R3-35, R3-36 auf Muss); Modul im Finanzmodell als Erlös rechnen; Industrie bleibt Zielbranche |
| Z4 nicht erfüllt, sonst alles erfüllt | **Ja, aber Umfang neu schätzen** | Fehlende Pflichtfunktionen als Stories anlegen und schätzen; Entscheidung erneut, wenn Epic Z über 35 SP wächst |
| Z1 oder Z3 erfüllt, aber Z6 oder Z7 nicht | **Nein, später prüfen** | Epic Z bleibt „Soll“ im Backlog; Wiedervorlage nach dem ersten zahlenden Industriekunden; Mitbestimmungs-Paket (R3-12) bleibt Muss |
| Weniger als 3 Muss-Hypothesen erfüllt | **Modul Z: nein** | Industrie-BVW aus der Zielbranchenliste streichen; Epic Z auf „Kann“ oder streichen; Industrie nur mit Innovationsteams ansprechen |

Bei weniger als 8 auswertbaren Interviews wird nicht entschieden; dann bis zu 3 weitere Gespräche führen.

## Wo die Entscheidung dokumentiert wird

1. **Ergebnis und Begründung** mit ausgefüllter Auswertungstabelle in dieser Datei (Abschnitt „Ergebnis“ unten).
2. **Entscheidungstabelle** in `CLAUDE.md` (Abschnitt „Getroffene Entscheidungen“) und Streichung der offenen Frage „Segment Industrie/Vorschlagswesen“.
3. **Backlog:** Priorität von R3-35 bis R3-38 im Umsetzungskonzept anpassen, danach `python3 tools/extract_backlog.py`.
4. **Finanzmodell:** Modul als Erlös aufnehmen oder Hinweis entfernen (`finanzmodell.md`, Abschnitt Hebel).
5. **Produktkonzept Teil B:** Zielgruppe und Pakete angleichen.

## Ergebnis

Status: offen. Verantwortlich: Product Owner. Geplant: nach 10 Interviews, spätestens vor Beginn von Phase 4.

| Feld | Eintrag |
| --- | --- |
| Datum der Entscheidung | |
| Auswertbare Interviews | |
| Erfüllte Muss-Hypothesen | |
| Erfüllte Soll-Hypothesen | |
| Entscheidung | |
| Begründung (3–5 Sätze) | |
| Folgeaufgaben | |

## Datenschutz

Einwilligung zur Notiz und ggf. Aufzeichnung vor Beginn; Notizen pseudonymisiert ablegen; Aufzeichnungen nach der Auswertung, spätestens nach 3 Monaten löschen. Keine Namen von Einreichenden oder Prämienbeträge einzelner Personen notieren. Rechtliche Hinweise in diesem Leitfaden sind keine Rechtsberatung.
