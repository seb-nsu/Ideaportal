# Rechtsgrundlagen

Stand 12.10.2026 · Release 0 · Entwurf

> **Hinweis:** Keine Rechtsberatung. Die Einordnung ist eine Arbeitshypothese für die Prüfung durch Datenschutzbeauftragte und eine Kanzlei (R3-11).

## Ausgangslage

- **Intern:** Das eigene Unternehmen hat keinen Betriebsrat (Umsetzungskonzept Abschnitt 1). Die Rechtsgrundlagen müssen daher **ohne Betriebsvereinbarung** tragen.
- **SaaS:** Der Kunde ist Verantwortlicher, der Betreiber Auftragsverarbeiter (Art. 28 DSGVO). Bei Kunden mit Betriebsrat ist eine Betriebsvereinbarung üblich und oft nötig.
- **Beschäftigtenkontext:** § 26 Abs. 1 BDSG ist nach dem EuGH-Urteil vom 30.03.2023 (C-34/21) als Grundlage unsicher. Der Entwurf stützt sich deshalb unmittelbar auf Art. 6 Abs. 1 DSGVO; Einwilligungen im Arbeitsverhältnis werden vermieden, weil ihre Freiwilligkeit zweifelhaft sein kann.

## Rechtsgrundlagen je Verarbeitung (intern)

| Verarbeitung (siehe Verzeichnis) | Rechtsgrundlage (Vorschlag) | Begründung / Bedingung |
| --- | --- | --- |
| V1 Konten und Anmeldung | Art. 6 Abs. 1 lit. b (Durchführung des Arbeitsverhältnisses) und lit. f (Sicherheit) | Teilnahme ist freiwillig; Konto ist Voraussetzung der Teilnahme |
| V2 Ideen | Art. 6 Abs. 1 lit. f (berechtigtes Interesse an Verbesserungen und Innovation) | Freiwillige Einreichung; Interessenabwägung dokumentieren; vertraulich/anonym als Schutz |
| V3 Kommentare, Unterstützung | Art. 6 Abs. 1 lit. f | freiwillig; Zufriedenheit nur aggregiert |
| V3 Zufriedenheitsabfrage | Art. 6 Abs. 1 lit. f | freiwillig, optional, Auswertung erst ab 5 Personen |
| V4 Entscheidungen, Umsetzung | Art. 6 Abs. 1 lit. b (Aufgaben der Rollen) und lit. f | Rollenträger:innen handeln im Rahmen ihrer Arbeitsaufgabe |
| V4 Abwesenheit und Vertretung | Art. 6 Abs. 1 lit. b | nur Zeitraum und Vertretung, kein Grund |
| V5 Benachrichtigungen | Art. 6 Abs. 1 lit. b und f | E-Mail abschaltbar |
| V6 KI-Analyse | Art. 6 Abs. 1 lit. f | Interessenabwägung: Analyse der Idee, nicht der Person; Datenminimierung; Opt-out je Mandant und Agent; keine Entscheidung durch KI (Art. 22) |
| V7 Protokolle | Art. 6 Abs. 1 lit. c (Nachweispflichten, Art. 5 Abs. 2, Art. 32) und lit. f | Zugriff beschränkt, Löschfristen |
| V8 Websuche | Art. 6 Abs. 1 lit. f | ohne Personenbezug geplant; falls doch, Löschung im Protokoll |
| V9 Demo / Registrierung | Art. 6 Abs. 1 lit. b (Nutzungsvertrag / vorvertraglich) | Hinweis „keine echten Daten“ |
| V10 Export / Auskunft | Art. 6 Abs. 1 lit. c i. V. m. Art. 15, 20 | – |

**Besondere Kategorien (Art. 9):** nicht beabsichtigt. Hinweis im Formular („Bitte keine Gesundheitsdaten oder Daten Dritter“). Treffen solche Daten ein, löscht die Triage den Inhalt (R1-28).

**Hinweisgeberschutz:** Das Portal ist kein Meldekanal nach HinSchG. Erkannte Meldungen werden nicht gespeichert, wenn die Person abbricht; Verarbeitung nur, soweit für den Hinweis auf den richtigen Kanal nötig.

**Ideen und Rechte:** Rechte an Ideen von Beschäftigten (z. B. Arbeitnehmererfindungen nach ArbnErfG) sind gesondert zu regeln; Prüfschritt R3-25.

**Offen (Product Owner):** Interessenabwägung für V2, V3 und V6 mit der bzw. dem DSB schriftlich festhalten.

## Kunden mit Betriebsrat (SaaS)

Für Kunden mit Betriebsrat sind voraussichtlich mitbestimmungspflichtig:

- § 87 Abs. 1 Nr. 6 BetrVG: technische Einrichtungen, die zur Überwachung von Leistung oder Verhalten **geeignet** sind (Dashboards, Protokolle, KI).
- § 87 Abs. 1 Nr. 12 BetrVG: Grundsätze über das betriebliche Vorschlagswesen.

Das Produkt unterstützt eine Betriebsvereinbarung durch: Leserolle für den Betriebsrat (R3-12), Auswertungen erst ab 5 Personen, KI-Funktionen einzeln abschaltbar, Übersicht aller Auswertungen, Audit-Log. Eine Betriebsvereinbarung kann nach Art. 88 DSGVO selbst Rechtsgrundlage sein. Das Produkt liefert **keine** generierte Betriebsvereinbarung (S4-09 ersetzt durch geprüfte Compliance-Unterlagen R3-11), sondern eine Checkliste der Regelungspunkte:

| Regelungspunkt | Produktfunktion |
| --- | --- |
| Zweck und Freiwilligkeit | Datenschutzhinweis, FAQ |
| Keine Leistungs- und Verhaltenskontrolle | Gruppen ab 5, keine Personenauswertung |
| KI-Funktionen und Freigabe | Schalter je Agent, Protokoll, Testsatz |
| Prämien | erst mit R3-24, nur mit HR-Freigabe |
| Löschfristen | `settings.retention` |
| Zugriff des Betriebsrats | Leserolle |

## SaaS: Auftragsverarbeitung

- AVV zwischen Kunde und Betreiber nach Art. 28 DSGVO (Gliederung in `../business/vertragsgrundlagen.md`).
- Der Kunde wählt KI- und Suchanbieter selbst; jeder gewählte Anbieter wird Unterauftragsverarbeiter (bei `keySource: platform`) oder direkter Auftragsverarbeiter des Kunden (bei `keySource: tenant`, eigener Vertrag des Kunden). **Offen (Product Owner):** Diese Unterscheidung mit einer Kanzlei klären.
- Drittlandübermittlung (z. B. US-Anbieter): Angemessenheitsbeschluss (EU-US Data Privacy Framework, sofern der Anbieter zertifiziert ist) oder Standardvertragsklauseln; Status vor Aktivierung prüfen.

## Unterauftragsverarbeiter (Vorlage)

| Dienst | Anbieter | Zweck | Daten | Ort | Garantie | Aktiv |
| --- | --- | --- | --- | --- | --- | --- |
| Hosting App und Datenbank | Render (Frankfurt) oder interne VM | Betrieb, Backups | alle | EU (DE) | AVV, ggf. SCC für Konzernmutter | ja |
| E-Mail-Versand | {SMTP-Anbieter, EU} | Benachrichtigungen | E-Mail, Betreff, Text | EU | AVV | ja |
| Virenscan | ClamAV, selbst betrieben | Anhänge prüfen | Dateien | im Haus | – | optional |
| KI (eingebaut) | – | regelbasierte Analyse | Ideentext | im Haus | – | Standard |
| KI (lokal) | Ollama/vLLM, selbst betrieben | vertrauliche Ideen, Abgrenzung | Ideentext | im Haus | – | optional |
| KI (EU) | Mistral AI | Analysen | Ideentext | EU | AVV | optional |
| KI (weitere) | Anthropic | Analysen | Ideentext (nicht vertraulich) | USA/EU je Vertrag | AVV, DPF/SCC | optional |
| Websuche | Brave Software | anonymisierte Suchanfragen | Suchanfrage | prüfen | AVV/Bedingungen prüfen | optional |
| Websuche (eigen) | SearXNG, selbst betrieben | anonymisierte Suchanfragen | Suchanfrage | im Haus | – | optional |
| Logdienst | {Plattform} | Fehleranalyse | technische Logs | prüfen | AVV | ja |

Die Liste wird je Mandant aus der aktiven KI- und Suchkonfiguration erzeugt (R3-08) und bei Änderungen dem Kunden mitgeteilt (Widerspruchsrecht laut AVV).
