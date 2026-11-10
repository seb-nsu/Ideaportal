# Scorecard mit Ankerbeispielen

Stand 12.10.2026 · Release 0 · Entwurf · Bezug: R2-03, Konzept v2 Folie 8, `server/src/lib/settings.ts` (`scorecard`)

Die Scorecard wird an Gate 2 vom Paten ausgefüllt (Skala 1–5, gewichtet). An Gate 1 gibt es keinen Score, nur den Quick-Check mit drei Fragen (relevantes Problem? passt zu Strategie oder Themenfeld? grob machbar?). Der Score ist eine Entscheidungshilfe: Weicht das Gremium ab, begründet es das. Kalibrierung nach dem ersten Pilotquartal.

## Kriterien und Gewichte

| ID | Kriterium | Gewicht | Leitfrage | Richtung |
| --- | --- | --- | --- | --- |
| `strategic_fit` | Strategischer Fit | 25 % | Zahlt die Idee auf Unternehmensziele oder ein Themenfeld ein? | 5 = starker Fit |
| `user_value` | Kunden- und Mitarbeiternutzen | 25 % | Spürbare Verbesserung für wen, wie viele, wie oft? | 5 = großer Nutzen |
| `economic_value` | Wirtschaftlicher Nutzen | 20 % | Einsparung, Umsatz, vermiedene Risiken oder Kosten? | 5 = großer Nutzen |
| `feasibility` | Umsetzbarkeit | 15 % | Aufwand, Know-how, Abhängigkeiten | 5 = einfach |
| `risk` | Risiko | 15 % | Rechtliche, technische, organisatorische Risiken | 5 = geringes Risiko |

**Gesamtscore** = Σ (Wert × Gewicht) / 100, eine Nachkommastelle. Community-Stimmen sind ein Signal, kein Kriterium.

## Anker je Skalenstufe

Im Produkt sind heute Anker für 1, 3 und 5 hinterlegt. Die Stufen 2 und 4 unten ergänzen sie und sollen in `settings.scorecard.criteria[].anchors` übernommen werden (Schema erweitern: Anker für 2 und 4).

### Strategischer Fit (25 %)

| Stufe | Anker | Beispiel |
| --- | --- | --- |
| 1 | Kein Bezug zu Zielen oder Themenfeldern. | Eigene Smartwatch mit Logo bei einem Pumpenhersteller |
| 2 | Loser Bezug, nur über Umwege begründbar. | Firmenpodcast „weil man das heute macht“ |
| 3 | Passt zu einem Themenfeld, aber nicht zu den Jahreszielen. | Dunkelmodus der App (Themenfeld Produkte, kein Jahresziel) |
| 4 | Passt zu einem Themenfeld und unterstützt ein Jahresziel indirekt. | Wissensdatenbank im Innendienst bei Jahresziel „Servicequalität“ |
| 5 | Zahlt direkt auf ein Jahresziel ein. | Abo für vorausschauende Wartung bei Ziel „30 % wiederkehrender Umsatz“ |

### Kunden- und Mitarbeiternutzen (25 %)

| Stufe | Anker | Beispiel |
| --- | --- | --- |
| 1 | Wenige Personen, selten betroffen. | Sonderformular für 2 Personen, einmal im Jahr |
| 2 | Ein Team profitiert gelegentlich. | Vorlage für das Quartalsreporting eines Teams |
| 3 | Ein Bereich profitiert regelmäßig. | Fokuszeit am Mittwoch für die Entwicklung |
| 4 | Mehrere Bereiche oder eine Kundengruppe profitieren wöchentlich. | Automatische Nachricht bei Lieferverzug für alle Direktkunden |
| 5 | Viele Kundinnen, Kunden oder Mitarbeitende profitieren täglich. | Ersatzteil-Vorbestellung im Kundenportal |

### Wirtschaftlicher Nutzen (20 %)

| Stufe | Anker | Beispiel |
| --- | --- | --- |
| 1 | Kein messbarer Nutzen. | „Wir wirken moderner“ |
| 2 | Nutzen unter 10.000 € pro Jahr. | Doppelseitiger Druck: ca. 3.000 € Papier und Toner |
| 3 | Nutzen im fünfstelligen Bereich pro Jahr (10.000–99.999 €). | Bestellfreigabe bis 500 €: ca. 400 h × 60 € = 24.000 € |
| 4 | 100.000–249.999 € pro Jahr. | Eingangsrechnungen automatisch auslesen |
| 5 | Ab 250.000 € pro Jahr. | Neues Abo-Produkt mit sechsstelligem wiederkehrendem Umsatz |

Hinweis: Im Produkt ist Stufe 5 als „sechsstelliger Bereich oder mehr“ formuliert; die feinere Grenze bei 250.000 € ist ein Vorschlag. Mandanten passen die Beträge an ihre Größe an.

### Umsetzbarkeit (15 %, 5 = einfach)

| Stufe | Anker | Beispiel |
| --- | --- | --- |
| 1 | Großes Vorhaben mit vielen Abhängigkeiten (> 12 Monate, mehrere Bereiche, neue Technologie). | Eigene Hardware entwickeln |
| 2 | Großes Projekt, 6–12 Monate, externe Partner nötig. | Rücknahme- und Aufbereitungsprogramm |
| 3 | Machbar mit einem Projekt über einige Monate. | 3D-Konfigurator mit Standardsoftware |
| 4 | Wenige Wochen, ein Team, vorhandene Technik. | Wissensdatenbank im vorhandenen Wiki |
| 5 | Mit vorhandenen Mitteln in wenigen Wochen umsetzbar (≈ Schnellspur). | Druckertreiber zentral umstellen |

### Risiko (15 %, 5 = gering)

| Stufe | Anker | Beispiel |
| --- | --- | --- |
| 1 | Hohe Risiken, Fachstellen müssen intensiv prüfen; Umsetzung womöglich unzulässig. | Kundendaten an Adresshändler verkaufen |
| 2 | Erhebliche Risiken in einem Bereich (Recht, Sicherheit, Marke), Prüfung mit offenem Ausgang. | Eigene Kryptowährung als Treuepunkte |
| 3 | Bekannte, beherrschbare Risiken. | Vier-Tage-Woche in einer Montagelinie (Arbeitszeitrecht, Mitbestimmung) |
| 4 | Geringe Risiken, Standardprüfung reicht. | Cloud-Lösung für Raumbuchung mit AVV |
| 5 | Kaum Risiken. | Onboarding-Checkliste |

## Rechenbeispiele

### Beispiel 1: Eingangsrechnungen automatisch auslesen (intern, Testsatz T04)

| Kriterium | Wert | Begründung | Gewichtet |
| --- | --- | --- | --- |
| Strategischer Fit | 4 | Jahresziel „Prozesskosten senken“ indirekt | 1,00 |
| Nutzen Kunden/Mitarbeitende | 3 | Buchhaltung (12 Personen) täglich | 0,75 |
| Wirtschaftlicher Nutzen | 4 | Schätzung: 1.500 Rechnungen × 6 Min. × 12 Monate ≈ 1.800 h ≈ 108.000 €, dazu Skonto | 0,80 |
| Umsetzbarkeit | 3 | Standardsoftware, ERP-Anbindung 2–3 Monate | 0,45 |
| Risiko | 4 | Auftragsverarbeitung, sonst gering | 0,60 |
| **Gesamt** | | | **3,6** |

### Beispiel 2: Nachrüstsatz für vorausschauende Wartung als Abo (Produkt, vertraulich, Testsatz T18)

| Kriterium | Wert | Begründung | Gewichtet |
| --- | --- | --- | --- |
| Strategischer Fit | 5 | Direkt auf Ziel „wiederkehrender Umsatz“ | 1,25 |
| Nutzen Kunden/Mitarbeitende | 4 | Bestandskunden mit älteren Maschinen, wöchentlicher Nutzen | 1,00 |
| Wirtschaftlicher Nutzen | 5 | Schätzung: 300 Abos × 90 €/Monat ≈ 324.000 € pro Jahr (Konfidenz niedrig) | 1,00 |
| Umsetzbarkeit | 2 | Hardware, Cloud, Vertrieb; 9–12 Monate | 0,30 |
| Risiko | 3 | Produkthaftung, Datenschutz, Patente Dritter prüfen | 0,45 |
| **Gesamt** | | | **4,0** |

Lesart: Beispiel 2 hat den höheren Score, aber geringe Umsetzbarkeit. Empfehlung an das Gremium: „Erproben“ mit einem Experiment (R2-06) statt sofort „Umsetzen“.

## Kalibrierung

- Nach dem ersten Quartal: Streuung zwischen Paten je Kriterium prüfen (zwei Paten bewerten 5 Ideen doppelt).
- Abweichungen Gremium ↔ Score dokumentieren (Hinweise auf Ebene der Ideen, nie der Personen; R4-10).
- **Offen (Product Owner):** Jahresziele des Pilotbereichs als Anker für „Strategischer Fit“ eintragen; Beträge für „Wirtschaftlicher Nutzen“ an die Größe der eigenen Organisation anpassen.
