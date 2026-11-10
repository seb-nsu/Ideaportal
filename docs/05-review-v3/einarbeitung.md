# Einarbeitung Review V3 in Konzept Version 3

Stand 12.10.2026. Diese Datei ordnet die Vorschläge aus [review-produkt-technik.md](review-produkt-technik.md) (P-xx, V-xx) und [review-markt-wettbewerb.md](review-markt-wettbewerb.md) (B-xx, M-xx) den Konzeptdokumenten und den Story-IDs im Backlog zu.

## Leitentscheidungen für Version 3

1. **Positionierung:** „Entscheidungs- und Wirkungssystem für Ideen: Antwortgarantie, belegte Vorlagen, nachgemessene Wirkung – gebaut für Mitbestimmung und DSGVO.“ KI-Ausarbeitung ist eine Funktion, nicht die Überschrift. Grund: KI-Ausarbeitung ist 2026 Marktstandard (ITONICS, Qmarkets, Wazoku, HYPE, Ideanote).
2. **Zielgruppe:** primär Innovations- und Strategieteams in Unternehmen mit 250–5.000 Mitarbeitenden im DACH-Raum (Industrie, Energie, Versicherungen, Gesundheit). Produktteams nur als Modul für Bestandskunden. Keine Konzerne über 20.000 Mitarbeitende, kein US-Markt.
3. **Offene Segmententscheidung:** Ob das betriebliche Vorschlagswesen (Gutachten, Kommission, Prämien) als Modul gebaut wird, entscheidet sich nach 10 Interviews mit Industriekunden. Bis dahin stehen die Stories mit Priorität „Soll“ im Backlog.
4. **Vertrauen vor Ausbau:** Vor Demo und Pilot werden Sicherheit, Betrieb und die drei KI-Vertrauensrisiken behoben (P-05, P-20, P-21). Dann folgt der Klicktest mit 7–8 Personen.
5. **Release 3 neu geschnitten:** Firmen-Login, SCIM, Teams-App und API zuerst, weil jeder Firmenkunde sie verlangt.
6. **Geschäftsmodell:** fokussiertes DACH-Unternehmen mit 30–80 Kunden (Bootstrap, Förderung oder strategischer Partner), kein VC-Plan. Marktgröße bottom-up statt Top-down-Studien.

## Neue Stories

| Neue ID | Quelle | Epic | Titel | SP | Prio |
| --- | --- | --- | --- | --- | --- |
| R1-44 | V-01 | A Plattform und Betrieb | Rate-Limits für Anmeldung, Registrierung, Reset und Demo | 3 | Muss |
| R1-45 | V-02 | A Plattform und Betrieb | TOTP verschlüsseln, CSP/HSTS, Betreff vertraulicher Ideen ohne Titel | 3 | Muss |
| R1-46 | M-17 | E Triage und Fristen | Antwortgarantie je Mandant sichtbar | 2 | Soll |
| R2-39 | V-04 | X Pilotreife | Triage-Vorschlag und Rückmeldungsentwurf nur für Triage, Gremium, Pate | 2 | Muss |
| R2-40 | V-05 | X Pilotreife | Eingebauter Anbieter liefert Struktur statt Zahlen; Banner; Demo mit echten Ergebnissen | 3 | Muss |
| R2-41 | V-22 | X Pilotreife | Durchlaufzeit je Phase, Zeitreihen, Ausgangswert im Dashboard | 5 | Muss |
| R2-42 | M-04 | X Pilotreife | Datenschutz-Nachweis je KI-Analyse | 3 | Muss |
| R2-43 | M-18 | X Pilotreife | Einseitige Gate-2-Vorlage mit Quellenlink je Zahl | 2 | Muss |
| R2-44 | V-06 | X Pilotreife | Prüfstatus je KI-Baustein und Bewertung „hilfreich?“ | 3 | Soll |
| R2-45 | V-07 | X Pilotreife | Websuche und Bausteine je Ideentyp einstellbar | 2 | Soll |
| R2-46 | V-08 | X Pilotreife | Quellenprüfung im Qualitätstor, Seitenabruf, Stichprobe | 5 | Soll |
| R2-47 | V-09 | X Pilotreife | Steckbrief als eigene Seite mit Reitern | 5 | Soll |
| R2-48 | V-10 | X Pilotreife | Erststart je Rolle, Leerzustände mit nächstem Schritt | 3 | Soll |
| R2-49 | V-23 | X Pilotreife | KI-Fairness je Mandant, Kostenschätzung vor dem Aufruf | 3 | Soll |
| R2-50 | V-11 | X Pilotreife | Textkatalog als Grundlage für Mehrsprachigkeit | 8 | Soll |
| R2-51 | M-01 | O Challenges und Anerkennung | Crowd-Bewertung nach Kriterien je Challenge | 5 | Muss |
| R2-52 | M-02 | O Challenges und Anerkennung | Challenge-Phasen mit Terminen und Vorlagen | 5 | Soll |
| R2-53 | M-03 | O Challenges und Anerkennung | Gamification nur je Challenge, abschaltbar | 5 | Kann |
| R3-26 | V-16 (ersetzt R1-08) | P Mandanten, Onboarding und Abrechnung | Firmen-Login mit OIDC (Entra ID zuerst), Gruppen → Rollen | 8 | Muss |
| R3-27 | M-11 | P Mandanten, Onboarding und Abrechnung | SCIM-Provisionierung (Entra ID, Okta) | 5 | Muss |
| R3-28 | V-13 | Q Sicherheit, Recht und Betrieb | Volltextsuche, Paginierung, semantische Dubletten mit pgvector | 8 | Muss |
| R3-29 | V-14 | P Mandanten, Onboarding und Abrechnung | Rollen je Bereich oder Themenfeld | 8 | Soll |
| R3-30 | M-12 | T Sprache und Steuerung | KI-Übersetzung von Inhalten, Original bleibt | 5 | Soll |
| R3-31 | V-17 | S Externe Beteiligung → besser eigenes Epic Y | Ideentyp „Problem ohne Lösung“ (Problembörse) | 5 | Soll |
| R3-32 | V-18 | Y Einsatzfelder | Nachhaltigkeits-Challenge mit CO₂ und kWh, ESG-Export | 3 | Soll |
| R3-33 | V-19 (ersetzt R4-05) | Y Einsatzfelder | Challenge mit Zielwert und Controlling-Bestätigung | 5 | Soll |
| R3-34 | V-20 | Y Einsatzfelder | Hackathon-Modus: Einreichfenster, Pitch, Publikumsvoting | 5 | Kann |
| R3-35 | M-06 | Z Modul Vorschlagswesen | Fachgutachten mit Frist, Kommission, Einspruch | 8 | Soll (Muss bei Segment BVW) |
| R3-36 | M-07 (ersetzt R3-24) | Z Modul Vorschlagswesen | Prämienregeln nach Betriebsvereinbarung, HR-Freigabe, Payroll-Export | 8 | Soll (Muss bei Segment BVW) |
| R3-37 | M-09 | Z Modul Vorschlagswesen | QR- und Kiosk-Einreichung ohne Konto | 5 | Soll |
| R3-38 | M-08 | Z Modul Vorschlagswesen | Benchmark-Kennzahlen nach Zentrum Ideenmanagement | 3 | Soll |
| R3-39 | M-13 | P Mandanten, Onboarding und Abrechnung | Challenge-Paket zum Festpreis in der Abrechnung | 3 | Soll |
| R3-40 | M-14 | T Sprache und Steuerung | Öffentliche Benchmark-Seite über Mandanten (aggregiert) | 3 | Kann |
| R3-41 | V-25 | Q Sicherheit, Recht und Betrieb | SECRET_KEY-Rotation, versionierte Einstellungen | 3 | Kann |
| R4-11 | M-15 | U Erkennen | Leichtes Trend- und Technologieradar | 8 | Soll |

Epic Y heißt „Y Einsatzfelder“, Epic Z „Z Modul Vorschlagswesen“ (beide Release 3), Epic X „X Pilotreife: Vertrauen, Messung, Bedienbarkeit“ (Release 2). R3-31 gehört in Epic Y.

## Geänderte Stories

| ID | Änderung | Quelle |
| --- | --- | --- |
| R1-05 | Akzeptanzkriterien aus V-03: Health mit Alter des letzten Job-Laufs, Queue-Länge, ältestem Job, Outbox-Rückstau; Alarm per Mail oder Webhook; Logs ohne Ideentexte (Test); Restore-Test dokumentiert; Staging als zweiter Render-Dienst. SP mindestens 5. | P-15 |
| R1-08 | aus Release 1 entfernt, ersetzt durch R3-26 | P-25, V-16 |
| R2-08 | Prio → Muss | Teil 2 |
| R2-24 | Patentrecherche standardmäßig aus, bis eine Patentdatenbank (EPO OPS, Lens.org) angebunden ist | P-30 |
| R2-26 | Prio → Soll, nur für Produktideen | Teil 2 |
| R3-04 | nach Release 4 verschoben (als R4-12, Inhalt unverändert) | Teil 2 |
| R3-12 | Prio → Muss; ergänzt um Muster-Betriebsvereinbarung aus der Konfiguration (M-05); SP +5 | B-Befund Mitbestimmung, M-05 |
| R3-16 | Prio → Muss, an den Anfang von Release 3; Umfang: Teams-App im Teams Store und Slack-App mit Benachrichtigung und Einreichen (M-10, V-15); SP 8 | P-26, M-10 |
| R3-17 | Umfang aus V-12: API-Tokens je Mandant, OpenAPI aus zod, Webhooks mit Signatur; SP 13; Prio Muss | P-16, V-12 |
| R3-19 | ergänzt um Einwilligung zu Nutzungsrechten je Challenge (V-21); SP +3 | V-21 |
| R3-22 | SP 13, Prio Muss (Rest der Mehrsprachigkeit nach R2-50) | P-18, P-32 |
| R3-24 | ersetzt durch R3-36 | M-07 |
| R4-05 | ersetzt durch R3-33 | V-19 |
| R4-07 | Prio → Muss; ergänzt um Trefferband früherer Prognosen in der Gremiumsvorlage (M-16); SP +3 | M-16 |
| R4-09, R4-10 | gestrichen (Simulator und Konsistenz-Check ohne Datenbasis) | P-30, Teil 2 |

## Aufgaben ohne Story

- **Klicktest** mit 7–8 Personen auf der Demo (V-24, P-01), vor dem weiteren Ausbau.
- **Manuelle Barrierefreiheitsprüfung** (P-07) vor dem Pilot.
- **Doku an Code angleichen** (P-22): ADR 0005 (Anfrage aus Stichworten), `adr/datenfluss.md` F8 (nur Snippets), `release-0/ux/navigation.md`; ADR 0001 bestätigen.
- **Finanzmodell** (`release-0/business/finanzmodell.md`) auf Bottom-up-DACH, Churn-Szenario 15 %, Vertriebsbudget und neue Preise umstellen.
- **10 Interviews** für die Segmententscheidung Vorschlagswesen.
