# Pilotbereich und Pilotkunden

Stand 12.10.2026 · Release 0 · Entwurf

Der Pilot startet intern (erster Mandant) und bei 2–3 externen Pilotkunden parallel. Nach 3 Monaten Pilotbetrieb entscheidet ein Go/No-go (Produktkonzept Teil A, Umsetzungskonzept Abschnitt 4).

## Auswahlkriterien

### Interner Pilotbereich

| Kriterium | Warum | Mindestanforderung |
| --- | --- | --- |
| Größe | Auswertungen erst ab 5 Personen; genug Ideen für Gate 2 | 80–300 Mitarbeitende im Bereich |
| Mischung | Interne und Produktideen testen | mind. ein Produkt- oder Innovationsteam plus ein interner Fachbereich |
| Sponsor | Führungskräfte sind der größte Hebel | Bereichsleitung sagt Zeit für Paten zu (5–10 % je Pate) |
| Triage-Kapazität | Frist 10 AT halten | 2 Personen, je 30–60 Min./Woche, mit Vertretung |
| Gremium | Gate 2 im Pilot erreichen | monatlicher Termin 60–90 Min., 3–5 Mitglieder |
| Daten | Ausgangswerte messbar | Ideen der letzten 12 Monate auffindbar (Excel, Mail, Tool) |
| Offenheit für KI | Release 2 im Pilot | Datenschutz und IT stimmen dem KI-Einsatz zu |

### Externe Pilotkunden

| Kriterium | Gewicht | Beschreibung |
| --- | --- | --- |
| Zielgruppe | Muss | Innovations- oder Produktteam in Unternehmen ab ca. 250 MA, DACH |
| Schmerz | Muss | Viele unbewertete Ideen, Recherche kostet Zeit oder Management verlangt Nutzennachweis |
| Entscheiderin erreichbar | Muss | Leitung Innovation/Produkt nimmt an Kick-off und Go/No-go teil |
| Zahlungsbereitschaft | hoch | Bereit, nach dem Pilot zu zahlen (Kriterium im Go/No-go) |
| Branchenmix | mittel | Unterschiedliche Branchen der Startliste (Industrie, Software, Finanzen, Energie, Medizintechnik) |
| Betriebsrat | mittel | Mindestens ein Kunde mit Betriebsrat, weil intern keiner existiert |
| Firmen-Login | niedrig | Ohne SSO startbar (Selbstregistrierung); SSO-Wunsch wird notiert (R1-08) |
| Referenz | mittel | Bereit, als Referenz genannt zu werden |

Ausschluss: Kunden, die das Portal als Meldekanal nach HinSchG nutzen wollen; Kunden, deren Daten außerhalb der EU liegen müssen.

## Profil interner Pilotbereich (Vorlage)

| Feld | Annahme |
| --- | --- |
| Bereich | Produktmanagement + Innendienst (Annahme) |
| Mitarbeitende | ca. 150 |
| Sponsor | Bereichsleitung Produkt |
| Triage-Team | 2 Personen aus dem Innovationsmanagement, je mit Vertretung |
| Paten | 6–8 Personen, max. 2 aktive Ideen je Pate |
| Gremium | 4 Personen, monatlich |
| Erwartete Ideen | 8–15 je Monat (Annahme: 1,3 Ideen je beteiligter Person und Jahr bei 50–70 % Beteiligung im Pilot) |
| Challenge | eine zum Start (siehe `einfuehrungsplan.md`) |
| Mandant | eigener Arbeitsbereich, Selbstregistrierung durch Product Owner, Einladungslink |
| KI | Release 1 ohne KI; Release 2 mit Anbieter nach Freigabe |

**Offen (Product Owner):** Pilotbereich, Sponsor und Personen benennen; Größe der eigenen Organisation für den internen Business Case.

## Profile externer Pilotkunden (Vorlage)

| Feld | Pilotkunde A | Pilotkunde B | Pilotkunde C (optional) |
| --- | --- | --- | --- |
| Branche, Größe | Industrie / Maschinenbau, ca. 800 MA | Software / SaaS, ca. 400 MA | Versicherung oder Energie, ca. 2.000 MA |
| Team | Innovationsmanagement, 3 Personen | Produktmanagement, 6 Personen | Innovation Lab, 4 Personen |
| Hauptschmerz | Ideen aus Vertrieb und Service versanden | Feature-Wünsche von Kunden ohne Priorisierung | Nutzennachweis gegenüber Vorstand |
| Ideentyp-Schwerpunkt | Produkt/Kunde und intern gemischt | Produkt/Kunde | intern |
| Betriebsrat | ja | nein | ja |
| Firmen-Login | Microsoft Entra ID gewünscht (später) | Google Workspace (später) | Pflicht vor Rollout |
| KI-Freigabe erwartet | EU-Anbieter oder eigenes Modell | Anthropic oder EU-Anbieter | nur eigenes Modell (`hosting: local`) |
| Paket nach Pilot | Business (bis 1.000 MA) | Team | Enterprise |
| Zielkanäle | Meldestelle (Ombudsperson), Service Desk, Arbeitssicherheit | Support, Jira | Meldestelle, IT-Service, Beschwerdemanagement |
| Pilot-Konditionen | Design-Partner: 250 € je Monat im Pilot, danach 50 % im 1. Jahr gegen Referenz, Fallstudie und Benchmark-Teilnahme (Finanzmodell Version 3) | wie A | wie A |

**Offen (Product Owner):** 2–3 echte Pilotkunden aus den Problem-Interviews auswählen und mit Pilotvereinbarung (`../business/vertragsgrundlagen.md`) binden. Keine Gespräche über das Produkt, bevor Rechte und Vertragspartei schriftlich geklärt sind (Review-Befund).

## Rollen im Pilot

| Rolle | Intern | Je Pilotkunde |
| --- | --- | --- |
| Product Owner | [Name] | Ansprechpartner Produkt |
| Fachpate (testet jedes Inkrement) | 1–2 Personen | 1 Person |
| Kunden-Admin | Product Owner | Leitung Innovation/Produkt |
| Triage, Gremium, Paten | siehe Profil | durch Kunden besetzt |
| Datenschutz | interne:r DSB | DSB des Kunden (AVV) |

## Erfolgskriterien Go/No-go (nach 3 Monaten)

- [ ] Fristtreue Gate 1 ≥ 80 % intern und bei den Pilotkunden
- [ ] Mindestens 5 Ideen an Gate 2 entschieden, davon mindestens 2 mit erfasstem Ist-Nutzen
- [ ] Zufriedenheit der Ideengebenden ≥ 4 von 5
- [ ] Datenschutz und IT-Sicherheit haben freigegeben
- [ ] Mindestens 2 Pilotkunden sind bereit, nach dem Pilot zu zahlen
