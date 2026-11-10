# Release 0 – Grundlagen

Stand 12.10.2026

Release 0 liefert die Unterlagen, ohne die ein Team oder eine Agentur nur ins Blaue schätzen kann (Umsetzungskonzept Abschnitt 9). Release 1 ist bereits gebaut; die Unterlagen beschreiben deshalb den echten Stand und legen Release 2 fest.

**Status:** „Entwurf“ = Dokument liegt vor und ist prüfbar. „Offen (Product Owner)“ = Dokument liegt vor, braucht aber Eingaben oder Freigaben, die nur der Product Owner liefern kann (im Dokument mit **Offen (Product Owner):** markiert).

## Checkliste aus Abschnitt 9

### Produkt und UX

| Punkt | Datei | Status |
| --- | --- | --- |
| Drei Nutzerwege (Ideengeberin, Triage-Team, Pate) plus externe Einreichende | [ux/nutzerwege.md](ux/nutzerwege.md) | Entwurf |
| Navigationsstruktur | [ux/navigation.md](ux/navigation.md) | Entwurf |
| Skizzen der Hauptbildschirme | [ux/hauptbildschirme.md](ux/hauptbildschirme.md) | Entwurf |
| Papiertest mit 2–3 Personen je Nutzerweg | [ux/papiertest.md](ux/papiertest.md) | Offen (Product Owner) – Plan steht, Test durchführen |
| Benachrichtigungsmatrix | [ux/benachrichtigungsmatrix.md](ux/benachrichtigungsmatrix.md) | Entwurf |
| Textvorlagen für Rückmeldungen | [ux/textvorlagen.md](ux/textvorlagen.md) | Entwurf |
| Mobile Kernaufgaben und Prüfplan Barrierefreiheit | [ux/mobil-und-barrierefreiheit.md](ux/mobil-und-barrierefreiheit.md) | Entwurf |

### Prozess und Pilot

| Punkt | Datei | Status |
| --- | --- | --- |
| Pilotbereich intern und 2–3 externe Pilotkunden | [prozess/pilotbereich.md](prozess/pilotbereich.md) | Offen (Product Owner) – Profile als Vorlage |
| Scorecard mit Ankerbeispielen | [prozess/scorecard.md](prozess/scorecard.md) | Entwurf |
| Schwellen für Schnellspur und Delegation | [prozess/schwellen-und-zielkanaele.md](prozess/schwellen-und-zielkanaele.md) | Entwurf |
| Zielkanäle je Pilot | [prozess/schwellen-und-zielkanaele.md](prozess/schwellen-und-zielkanaele.md#zielkanäle-für-die-abgrenzung) | Offen (Product Owner) – Kontakte einsammeln |
| Ausgangswerte vor dem Pilot | [prozess/ausgangswerte.md](prozess/ausgangswerte.md) | Offen (Product Owner) – Erhebung ausstehend |
| Kommunikations- und Einführungsplan | [prozess/einfuehrungsplan.md](prozess/einfuehrungsplan.md) | Entwurf |

### Technik, Sicherheit und Datenschutz

| Punkt | Datei | Status |
| --- | --- | --- |
| ADR Technik und Mandantenmodell | [../adr/0001-technik-und-mandantenmodell.md](../adr/0001-technik-und-mandantenmodell.md) | Entwurf (vorgeschlagen, Bestätigung offen) |
| ADR Anmeldung | [../adr/0002-anmeldung.md](../adr/0002-anmeldung.md) | Entwurf |
| ADR Job-Queue | [../adr/0003-job-queue.md](../adr/0003-job-queue.md) | Entwurf |
| ADR KI-Gateway | [../adr/0004-ki-gateway.md](../adr/0004-ki-gateway.md) | Entwurf |
| ADR Suchanbieter | [../adr/0005-suchanbieter.md](../adr/0005-suchanbieter.md) | Entwurf |
| Datenflussdiagramm | [../adr/datenfluss.md](../adr/datenfluss.md) | Entwurf |
| Bedrohungsmodell | [../adr/bedrohungsmodell.md](../adr/bedrohungsmodell.md) | Entwurf |
| Datenschutz-Folgenabschätzung (Entwurf) | [datenschutz/dsfa-entwurf.md](datenschutz/dsfa-entwurf.md) | Offen (Product Owner) – Prüfung durch DSB |
| Verzeichnis der Verarbeitungen | [datenschutz/verarbeitungsverzeichnis.md](datenschutz/verarbeitungsverzeichnis.md) | Offen (Product Owner) – Stammdaten |
| Rechtsgrundlagen ohne Betriebsvereinbarung | [datenschutz/rechtsgrundlagen.md](datenschutz/rechtsgrundlagen.md) | Entwurf |
| KI-Testsatz mit 30 Beispielideen | [ki/testsatz.md](ki/testsatz.md), [`server/testset/ki-testsatz.json`](../../server/testset/ki-testsatz.json) (32 Ideen) | Entwurf |
| Skelett des Betriebshandbuchs | [technik/betriebshandbuch.md](technik/betriebshandbuch.md) | Entwurf |

### Business

| Punkt | Datei | Status |
| --- | --- | --- |
| Finanzmodell SaaS korrigiert | [business/finanzmodell.md](business/finanzmodell.md) | Entwurf |
| Leitfaden für 10–15 Gespräche | [business/gespraechsleitfaden.md](business/gespraechsleitfaden.md) | Entwurf |
| Vertrag mit Agentur oder Team (und weitere Vertragsgrundlagen) | [business/vertragsgrundlagen.md](business/vertragsgrundlagen.md) | Offen (Product Owner) – Team oder Agentur, Rechte am Code |

## Wichtigste offene Punkte für den Product Owner

1. Rechte am Code und Vertragspartei der Kunden schriftlich festhalten (vor allen Gesprächen mit Externen).
2. Internen Pilotbereich, Sponsor und 2–3 Pilotkunden benennen.
3. Ausgangswerte erheben (Antwortzeit, Realisierungsquote, Zufriedenheit, Aufwand je Bewertung).
4. Zielkanäle intern einsammeln (Meldestelle, IT, Arbeitssicherheit, HR).
5. DSFA und Interessenabwägung mit der bzw. dem DSB prüfen; KI-Anbieter freigeben lassen.
6. Papiertest durchführen (7–8 Personen).
7. Finanzierung von Release 0–2 und Entscheidung Team oder Agentur.

Rechtliche Aussagen in diesen Dokumenten sind keine Rechtsberatung.
