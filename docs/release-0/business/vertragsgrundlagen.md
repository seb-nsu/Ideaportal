# Vertragsgrundlagen

Stand 12.10.2026 · Release 0 · Entwurf

> **Hinweis:** Keine Rechtsberatung. Dies ist eine Gliederung der Regelungspunkte als Grundlage für die Arbeit mit einer Kanzlei (R3-11). Keine der Formulierungen ist ein fertiger Vertragstext.

> **Stand AP-25 (13.10.2026):** Ausformulierte Entwürfe für AGB (2), AVV mit Anlage 1 TOM und Anlage 2 Unterauftragnehmer (3), Datenschutzerklärung und DSFA-Muster liegen versioniert unter `server/templates/legal/` und sind im Produkt abrufbar (`/rechtliches`, Einstellungen › Rechtliches). Die anwaltliche Prüfung ist offen.

## Übersicht

| Dokument | Zweck | Wann nötig | Wer prüft |
| --- | --- | --- | --- |
| 1 Pilotvereinbarung | Rahmen für Pilotkunden | vor Pilotstart (ab Monat 7) | Kanzlei, Kunde |
| 2 SaaS-Nutzungsbedingungen (AGB B2B) | Hauptvertrag | vor dem ersten zahlenden Kunden | Kanzlei |
| 3 Auftragsverarbeitungsvertrag (AVV) mit Anlagen TOM und Unterauftragnehmer | Art. 28 DSGVO | mit jedem Kunden, auch im Pilot | Kanzlei, DSB |
| 4 Service Level Agreement (SLA) | Verfügbarkeit, Support | ab Business-Paket | Product Owner |
| 5 KI-Klausel | Regeln für KI-Funktionen | Teil von 2 und 3 | Kanzlei |
| 6 Vertrag mit Agentur oder Team | Bau: Rechte am Code, Repository, Abnahme | vor Baustart | Kanzlei |
| 7 Rechte an der Software | Rechteinhaber, Vermarktung, Vertragspartei | **vor allem anderen** | Kanzlei |

**Offen (Product Owner):** Rechte an der Software schriftlich festhalten. Vertragspartei der Kunden klären (Person, Firma, Ausgründung).

## 1 Pilotvereinbarung (Gliederung)

1. Gegenstand: Nutzung des Ideenportals im Pilot, Funktionsumfang laut Release-Stand
2. Laufzeit: 6 Monate, Verlängerung oder Übergang in den Hauptvertrag
3. Konditionen: Design-Partner-Preis 250 € je Monat im Pilot, danach 50 % im ersten Jahr gegen Referenz, Fallstudie und Benchmark-Teilnahme (`finanzmodell.md` Version 3, `../prozess/pilotbereich.md`)
4. Mitwirkung des Kunden: Ansprechperson, Fachpate, Ausgangswerte, Feedback je Inkrement, Teilnahme an Go/No-go
5. Referenz und Veröffentlichung: Nennung als Referenz nur mit Freigabe
6. Vertraulichkeit beidseitig; Ideen des Kunden gehören dem Kunden
7. Haftung: begrenzt, Pilotcharakter (Beta), keine Verfügbarkeitszusage
8. Datenschutz: AVV ist Pflicht-Anlage; KI standardmäßig `builtin`, externe Anbieter nur auf Wunsch des Kunden
9. Ende: Datenexport (R1-43) und Löschung innerhalb von 30 Tagen
10. Feedback-Rechte: Anbieter darf Verbesserungsvorschläge des Kunden frei verwenden

## 2 SaaS-Nutzungsbedingungen (Gliederung)

1. Geltungsbereich (nur Unternehmer, B2B)
2. Leistungsbeschreibung: Pakete Team, Business (bis 1.000 und bis 2.500 Mitarbeitende), Enterprise (`finanzmodell.md` Version 3); Einführungspaket ab Business verpflichtend; Änderungen der Software
3. Vertragsschluss: Selbstregistrierung mit 30-Tage-Test (R3-02) oder Angebot
4. Preise, Abrechnung nach Zahl der Mitarbeitenden, KI-Kontingent und Zukauf (R3-05, R3-06), Zahlungsziel
   - Preisblatt laut Produkt (`server/src/lib/plans.ts`, Einstellungen › Paket): Team 590 €, Business 1.490 € (bis 1.000 MA) / 2.490 € (bis 2.500 MA), Enterprise ab 3.990 € pro Monat netto; Challenge-Paket 2.500 € einmalig für 8 Wochen (R3-39). KI-Vollanalysen je Monat: Team 5, Business 20/40, Enterprise 80; Zukauf wird vom Anbieter gebucht und monatlich mit abgerechnet.
   - Testphase 30 Tage (R3-02); danach nur lesbar bis zur Paketwahl, Daten bleiben erhalten und exportierbar.
   - Rechnungen erstellt der Anbieter aus den Entwürfen des Portals. **Zahlungsanbieter und Zahlungsweg sind offen** (Überweisung als Standard bis zur Entscheidung).
5. Laufzeit und Kündigung (Vorschlag: 12 Monate, Jahresvorauszahlung als Standard; monatlich nur für Team)
6. Pflichten des Kunden: Zugangsdaten schützen, keine rechtswidrigen Inhalte, Zielkanäle hinterlegen, **Portal nicht als Meldekanal nach HinSchG nutzen**
7. Rechte an Inhalten: Kunde behält alle Rechte an Ideen und Daten; Anbieter erhält nur die zur Leistung nötigen Rechte; kein Training von Modellen mit Kundendaten
8. Externe Einreichende (R3-19): Kunde holt Einwilligung zu Nutzungsbedingungen und Rechten an Ideen ein
9. Verfügbarkeit und Support: siehe SLA
10. Gewährleistung und Haftung: Begrenzung, Kardinalpflichten
11. KI-Klausel (siehe 5)
12. Datenschutz: AVV
13. Datenexport und Löschung nach Vertragsende (R1-43)
14. Schlussbestimmungen: deutsches Recht, Gerichtsstand

## 3 Auftragsverarbeitungsvertrag (Gliederung)

1. Gegenstand, Dauer, Art und Zweck (siehe `../datenschutz/verarbeitungsverzeichnis.md`)
2. Kategorien Daten und Betroffene
3. Weisungen; Weisungen zu KI-Anbietern über die Einstellungen im Produkt
4. Vertraulichkeit der Beschäftigten des Anbieters
5. Technische und organisatorische Maßnahmen (Anlage 1)
6. Unterauftragsverarbeiter (Anlage 2), Informationspflicht bei Änderung, Widerspruchsrecht
7. Unterstützung bei Betroffenenrechten (Auskunft, Export, Anonymisierung im Produkt)
8. Meldung von Datenschutzverletzungen: unverzüglich, Ziel 24 h
9. Löschung und Rückgabe nach Ende
10. Nachweise und Prüfungen (Doku für Kundenaudits, R3-09)
11. Drittlandübermittlung: nur mit Garantie; KI-Anbieter mit `hosting: other` nur auf Weisung des Kunden

### Anlage 1: TOM (Kurzfassung, Stand Code)

| Bereich | Maßnahme |
| --- | --- |
| Zutritt | Rechenzentrum des Hosters (EU), Zertifizierungen des Hosters |
| Zugang | eigene Konten, scrypt, MFA (Pflicht für Admins), Sperre nach Fehlversuchen, Sitzungen 12 h |
| Zugriff | Rollen serverseitig, Row-Level-Security je Mandant, vertrauliche Ideen nur für Berechtigte |
| Trennung | Mandanten in der Datenbank getrennt; Test mit zwei Mandanten in der CI |
| Weitergabe | TLS; vertrauliche Ideen nie an externe KI- oder Suchdienste; anonymisierte Suchanfragen |
| Eingabekontrolle | unveränderliches Audit-Log, KI-Protokoll |
| Verfügbarkeit | tägliche Backups, monatlicher Wiederherstellungstest, Monitoring (Betriebshandbuch) |
| Verschlüsselung | TLS; gespeicherte Daten durch den Hoster; Anbieterschlüssel AES-256-GCM |
| Löschung | Löschfristen je Mandant, automatischer Löschjob |
| Organisation | Abhängigkeits-Scan in der CI, Sicherheitsreview vor Pilot, Penetrationstest vor Marktstart |

### Anlage 2: Unterauftragsverarbeiter

Vorlage in `../datenschutz/rechtsgrundlagen.md`.

## 4 SLA (Vorschlag)

| Merkmal | Team | Business | Enterprise |
| --- | --- | --- | --- |
| Verfügbarkeit je Monat | 99,0 % | 99,5 % | 99,5 %, optional 99,9 % |
| Wartungsfenster | angekündigt, außerhalb 7–19 Uhr | dito | abgestimmt |
| Support | E-Mail, Antwort in 2 Werktagen | E-Mail, 1 Werktag | E-Mail + Telefon, 4 h für kritische Fälle |
| Statusseite | ja (R3-10) | ja | ja |
| Wiederherstellungsziel (RPO / RTO) | 24 h / 1 Werktag | 24 h / 8 h | 4 h / 4 h (Annahme, technisch prüfen) |
| Gutschrift bei Unterschreitung | – | 5 % je 0,5 % | 10 % je 0,5 % |

Die KI-Funktionen sind von der Verfügbarkeitszusage ausgenommen, soweit sie von Dritten abhängen; der Ideenfluss selbst wartet nie auf die KI.

**Messung (umgesetzt mit R3-10):** Verfügbar ist die Anwendung, wenn sie antwortet und ihre Datenbank erreicht. Die App misst im Takt von 5 Minuten; je Kalendermonat gilt Verfügbarkeit = Messungen mit erreichbarer Anwendung ÷ erwartete Messungen, fehlende Messungen zählen als nicht verfügbar. Angekündigte Wartungen (auf der Statusseite angekündigt, außerhalb 7–19 Uhr; Vorlauf je Paket noch festlegen) werden aus der Messzeit herausgerechnet. Die öffentliche Statusseite (`/status`) zeigt den Zustand je Bestandteil, Störungen und Wartungen sowie die Verfügbarkeit der letzten 90 Tage und des laufenden Monats; sie ist die Grundlage für Gutschriften. Ein externer Prüfdienst ergänzt die Messung vor dem Marktstart (`docs/betrieb.md`, Abschnitt „Statusseite und Verfügbarkeit“).

## 5 KI-Klausel (Regelungspunkte)

- KI-Ergebnisse sind **Entwürfe**; Entscheidungen treffen Menschen des Kunden. Keine Gewähr für Richtigkeit von Markt-, Wettbewerbs- und Patentangaben; Patentrecherche ist keine Freigabe.
- Kennzeichnung von KI-Inhalten, Quellen mit Abrufdatum, Schätzungen markiert.
- **Keine Bewertung von Personen** durch KI; keine Nutzung zur Leistungs- oder Verhaltenskontrolle.
- Kunde wählt Anbieter und Hosting (eingebaut, eigenes Modell, EU, weitere); vertrauliche Ideen und erkannte Meldungen gehen nie an externe Anbieter.
- Kein Training von Modellen mit Kundendaten durch den Anbieter des Portals; Bedingungen der KI-Anbieter (z. B. keine Speicherung) werden in der Unterauftragnehmerliste genannt.
- Kostenlimits je Idee und Monat, KI-Kontingent je Paket, Zukauf.
- Pflichten aus der EU-KI-Verordnung: Kennzeichnung und Transparenz; Stand vor Marktstart rechtlich prüfen.

## 6 Vertrag mit Agentur oder Team (Gliederung)

1. Leistung: Umsetzung der Stories laut Backlog (`backlog/backlog.csv`) in Inkrementen von 2 Wochen
2. **Rechte am Code:** ausschließliche, übertragbare Nutzungsrechte an allem Code, aller Doku und allen Designs beim Auftraggeber; Open-Source-Bestandteile nur mit freigegebenen Lizenzen (Liste)
3. **Eigenes Repository** des Auftraggebers; Agentur arbeitet darin; keine Kopien nach Ende
4. **Abnahme gegen Akzeptanzkriterien** und Definition of Done (Umsetzungskonzept Abschnitt 3); Abnahme je Inkrement durch den Product Owner
5. Vergütung: Festpreis je Release oder Aufwand mit Obergrenze; Tagessätze 700–1.000 € (Annahme)
6. Qualität: Tests für Fristen, Rechte und Mandantentrennung; Barrierefreiheit WCAG 2.1 AA; Sicherheitslücken beheben
7. Geheimhaltung, Datenschutz (AVV, falls Zugriff auf Pilotdaten)
8. Gewährleistung, Übergabe, Wissensübergabe am Ende
9. Kündigung und Übergang (Exit ohne Lock-in)

**Offen (Product Owner):** Entscheidung Team oder Agentur; Angebote von 2–3 Agenturen auf Basis von Backlog und Release-0-Unterlagen einholen.
