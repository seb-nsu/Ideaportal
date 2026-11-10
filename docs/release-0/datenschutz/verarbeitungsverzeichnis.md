# Verzeichnis der Verarbeitungstätigkeiten (Entwurf)

Stand 12.10.2026 · Release 0 · Entwurf nach Art. 30 DSGVO

> **Hinweis:** Keine Rechtsberatung. Vorlage für den internen Einsatz (Abs. 1, Verantwortlicher) und für den SaaS-Betrieb (Abs. 2, Auftragsverarbeiter). Rechtsgrundlagen stehen in `rechtsgrundlagen.md`.

## Stammdaten

| Feld | Intern | SaaS |
| --- | --- | --- |
| Verantwortlicher | {Unternehmen, Anschrift} | jeweiliger Kunde |
| Auftragsverarbeiter | – | {Betreiber Ideenportal, Anschrift} |
| Datenschutzbeauftragte:r | {Name, Kontakt} | {Name, Kontakt} |
| Systeme | Ideenportal (Web-App), PostgreSQL 16, SMTP-Relay, optional ClamAV, KI-Gateway | dito, Betrieb in der EU-Cloud |

**Offen (Product Owner):** Stammdaten ausfüllen; Rolle des Betreibers (Person oder Firma) klären.

## Verarbeitungen

Allgemeine technische und organisatorische Maßnahmen (TOM) für alle Einträge: TLS, Row-Level-Security je Mandant, Rollen serverseitig, MFA für Admins, Audit-Log, tägliche Backups, Löschjob; Details in `../business/vertragsgrundlagen.md` (Anlage TOM).

### V1 Konten und Anmeldung

| Feld | Inhalt |
| --- | --- |
| Zweck | Zugang zum Portal, Rollen und Rechte, Sicherheit |
| Betroffene | Beschäftigte, Gäste, Admins; ab R3 Externe |
| Daten | Name, E-Mail, Organisationseinheit (optional), Rollen, Passwort-Hash, TOTP-Geheimnis, Fehlversuche, Sitzungen (Hash), Abwesenheit und Vertretung, Benachrichtigungseinstellungen, Sprache; mit Firmen-Login (R3-26) zusätzlich Kennung beim Identitätsanbieter (`sub`), Gruppen und Anmeldeart; mit SCIM (R3-27) externe ID und Gruppenmitgliedschaften; Chat-Zuordnung (Slack-ID, Entra-Objekt-ID, R3-16) |
| Empfänger | Admins des Mandanten; SMTP-Relay (Einladung, Reset); Identitätsanbieter und Verzeichnis des Kunden (eigene Verantwortung des Kunden, nur bei Firmen-Login und SCIM) |
| Speicherdauer | Bis zur Deaktivierung; danach Anonymisierung nach `anonymizeDeactivatedAfterDays` (30 Tage); Sitzungen 12 h |
| Drittland | nein |

### V2 Ideen und Einreichung

| Feld | Inhalt |
| --- | --- |
| Zweck | Ideen erfassen, Dubletten finden, Status und Fristen |
| Betroffene | Ideengebende, Co-Autor:innen, delegiert Einreichende; im Text genannte Personen |
| Daten | Titel, Problem, Lösung, Nutzen, Themenfeld, Art, vertraulich/anonym, Anhänge, Verlauf, Fristen |
| Empfänger | Berechtigte Rollen; Community (ohne vertrauliche Ideen; anonym ohne Namen) |
| Speicherdauer | Aktive Ideen unbegrenzt; abgelehnte, weitergeleitete, zusammengeführte und unbeantwortete nach `closedIdeasMonths` (24 Monate); Abbruch bei Abgrenzung: keine Speicherung |
| Drittland | nein (KI siehe V6) |

### V3 Kommentare, Unterstützung, Zufriedenheit

| Feld | Inhalt |
| --- | --- |
| Zweck | Zusammenarbeit, Rückenwind für Ideen, Verbesserung des Prozesses |
| Betroffene | Kommentierende, Unterstützende, Ideengebende |
| Daten | Kommentartext, Zeitpunkt, Autor:in; Unterstützung je Person; Zufriedenheit 1–5 mit optionalem Kommentar |
| Empfänger | alle mit Leserecht an der Idee; Zufriedenheit nur aggregiert ab 5 Personen |
| Speicherdauer | mit der Idee |
| Drittland | nein |

### V4 Triage, Entscheidungen, Umsetzung, Nutzen

| Feld | Inhalt |
| --- | --- |
| Zweck | Gate 1–3, Umsetzung, Wirkungsnachweis |
| Betroffene | Triage, Gremium, Paten, Owner, Ideengebende |
| Daten | Spur, Begründung, Rückfragen und Antworten, Gate-2-Ergebnis, Owner, Zieltermine, Fortschritt, Ist-Nutzen, Scorecards, Steckbrief |
| Empfänger | Beteiligte Rollen; Ideengebende erhalten Begründungen |
| Speicherdauer | mit der Idee; Audit-Log siehe V7 |
| Drittland | nein |

### V5 Benachrichtigungen

| Feld | Inhalt |
| --- | --- |
| Zweck | Information über Aufgaben, Fristen und eigene Ideen |
| Betroffene | Empfänger:innen, ggf. Vertretung |
| Daten | E-Mail-Adresse, Betreff (Ideentitel), Text, Kategorie, Versandstatus (`outbox`) |
| Empfänger | SMTP-Relay ({Anbieter}) |
| Speicherdauer | `notificationsMonths` (12 Monate) |
| Drittland | abhängig vom Mail-Anbieter; EU-Anbieter vorgesehen |

### V6 KI-Analyse (ab Release 2)

| Feld | Inhalt |
| --- | --- |
| Zweck | Kurz- und Vollanalyse, Triage-Vorschlag, Entwürfe, Abgrenzung |
| Betroffene | Ideengebende, im Text genannte Personen, Kommentierende (Zusammenfassung) |
| Daten | Ideentexte, Kommentare (für Zusammenfassung), Ergebnisse, Quellen, Korrekturen mit Grund und Person |
| Empfänger | KI-Anbieter nach Mandanten-Konfiguration: eingebaut (keine), lokales Modell, EU-Anbieter, Anthropic; vertrauliche Ideen und mögliche Meldungen nur lokal |
| Speicherdauer | Ergebnisse und Protokoll nach `aiActionsMonths` (24 Monate); bei Anbietern laut AVV (Zero Data Retention anstreben) |
| Drittland | möglich bei Anbietern mit `hosting: other`; Grundlage vor Aktivierung prüfen |
| Nachweis | Datenschutz-Nachweis je Idee (R2-42, AP-04): je KI-Aktion Dienst, Region (Hosting zum Zeitpunkt des Aufrufs), Modell, Token, Kosten und gesendete Suchanfragen mit Zahl der entfernten Begriffe; ohne Eingaben, Antworten und Ideentexte, bei vertraulichen Ideen ohne Titel. Abruf als Seite oder PDF für Admin, Betriebsrat (Leserolle `works_council`) und Beteiligte der Idee |

### V7 Protokolle (Audit-Log, KI-Protokoll, Server-Logs)

| Feld | Inhalt |
| --- | --- |
| Zweck | Nachvollziehbarkeit, Sicherheit, Prüfungen |
| Betroffene | handelnde Personen |
| Daten | Wer, wann, was, vorher, nachher; Admin-Zugriffe; KI-Aktionen mit Tokens, Kosten und Hosting; technische Logs (Zeit, Methode, Pfad ohne Query-String, Statuscode, Fehlertyp; keine Ideentexte, AP-03) |
| Empfänger | Admins (Audit-Log, Export protokolliert); Betrieb (Server-Logs) |
| Speicherdauer | Audit-Log mit dem Mandanten (Vorschlag: konfigurierbar, offen); KI-Protokoll 24 Monate; Server-Logs 30 Tage (Vorschlag) |
| Drittland | Logdienst der Plattform prüfen |

### V8 Websuche (ab Release 2)

| Feld | Inhalt |
| --- | --- |
| Zweck | Quellen für Wettbewerbs-, Markt- und Patentrecherche |
| Betroffene | keine beabsichtigt (Anfragen anonymisiert) |
| Daten | Suchanfrage aus Stichworten der Idee, im Code gebildet, ohne Namen (auch Namensteile), E-Mail, Telefon, Firma und interne Begriffe; Treffer (Titel, URL, Snippet, Abrufdatum); Seitenabruf für höchstens 5 Treffer je Analyse zur Quellenprüfung (R2-46): nur die Adresse des Treffers, ohne Ideentext und Cookies; gespeichert wird nur das Prüfergebnis, nicht der Seitentext; für vertrauliche Ideen kein Abruf. Je Ideentyp abschaltbar (R2-45) |
| Empfänger | Brave Search API oder eigene SearXNG-Instanz; beim Seitenabruf die Betreiber der Trefferseiten (sehen die IP-Adresse des Servers) |
| Speicherdauer | Anfrage und Zahl der entfernten Begriffe im KI-Protokoll (24 Monate); sichtbar im Datenschutz-Nachweis |
| Drittland | Brave: prüfen; SearXNG: eigene Instanz |

### V9 Öffentliche Demo und Selbstregistrierung

| Feld | Inhalt |
| --- | --- |
| Zweck | Produkt ausprobieren; neue Arbeitsbereiche anlegen |
| Betroffene | Besucher:innen der Demo; Personen, die sich registrieren |
| Daten | Demo: frei eingegebene Inhalte, Sitzung; Registrierung: Name, E-Mail, Name des Teams, Passwort-Hash |
| Empfänger | Demo: alle Demo-Besucher:innen sehen Eingaben; Registrierung: SMTP |
| Speicherdauer | Demo: tägliches Zurücksetzen (Mandant wird nach 24 h gelöscht und neu angelegt); Registrierung: bis zur Löschung des Arbeitsbereichs |
| Drittland | nein |

### V10 Import und Export

| Feld | Inhalt |
| --- | --- |
| Zweck | Bestand übernehmen (R1-39); Datenhoheit (R1-43); Auskunft (Art. 15) |
| Betroffene | Ideengebende im Bestand; alle Nutzer:innen beim Export |
| Daten | CSV/Excel-Inhalte; JSON-Vollexport |
| Empfänger | Admins; die betroffene Person bei Auskunft |
| Speicherdauer | Importdatei wird nicht dauerhaft gespeichert; Export nur als Download |
| Drittland | nein |

### V11 Problem-Radar aus Tickets und Feedback (R4-01, ab Release 4)

| Feld | Inhalt |
| --- | --- |
| Zweck | Wiederkehrende Probleme aus Tickets (Jira, ServiceNow, Azure DevOps) und Kundenfeedback erkennen, um Challenges und Probleme gezielt anzulegen; keine Auswertung einzelner Mitarbeitender |
| Betroffene | Personen, die in Tickets oder Feedback erwähnt werden oder sie verfasst haben (Beschäftigte, Kundinnen und Kunden); beabsichtigt ist kein Personenbezug |
| Daten | Eingelesen nur **Titel und Beschreibung** der Tickets der letzten n Tage (Standard 90, höchstens 200 je Lauf) bzw. die Spalten Titel/Text einer CSV-Datei; Melder-, Bearbeiter- und andere Personenfelder werden nicht abgefragt, weitere CSV-Spalten ignoriert. Vor der Auswertung werden E-Mail-Adressen, Telefonnummern, Links, @-Erwähnungen, Felder wie „Reporter: …“, Anreden mit Namen und die Namen der Personen des Arbeitsbereichs entfernt. Gespeichert werden nur Lauf (Quelle, Anzahl, Zeitpunkt, auslösende Person) und Cluster (Bezeichnung, Zusammenfassung, Häufigkeit, bis zu 3 geschwärzte Beispiele); **Rohtickets und CSV-Dateien werden nicht gespeichert**. Cluster unter der Mindestgröße (Standard 3) werden verworfen |
| Rechtsgrundlage | Art. 6 Abs. 1 lit. f DSGVO (Verbesserung von Prozessen und Produkten); für Beschäftigte § 26 BDSG bzw. Betriebsvereinbarung; Abwägung in der DSFA (Abschnitt 6d) |
| Empfänger | Innovationsleitung, Triage, Admin im eigenen Arbeitsbereich; KI nur mit eigenem Hosting oder eingebautem Verfahren (nie externe KI-Anbieter); Zielsystem des Konnektors (Abruf mit den hinterlegten Zugangsdaten) |
| Speicherdauer | Läufe und Cluster bis zur Löschung durch die Innovationsleitung bzw. mit dem Arbeitsbereich (Vorschlag: Löschfrist ergänzen, offen); KI-Protokoll 24 Monate, nur Anzahl und Mindestgröße als Eingabe |
| Drittland | nein (KI nur lokal); Zielsystem je nach Vertrag des Kunden |

### V12 Trendhinweise und Trendradar (R4-02, R4-11, ab Release 4)

| Feld | Inhalt |
| --- | --- |
| Zweck | Sponsor:innen wöchentlich über Markt- und Technologietrends ihrer Themenfelder informieren; Trends pflegen und mit Ideen verbinden |
| Betroffene | Sponsor:innen (Zuordnung zum Themenfeld, Empfang der Mail); Ideengebende, deren nicht vertrauliche Ideen einem Trend zugeordnet werden |
| Daten | Zuordnung Themenfeld → Person (`topic_sponsors`); Wochenhinweis je Themenfeld mit Suchanfragen und Treffern (Titel, URL, Snippet); Trends, Verknüpfungen Idee–Trend, Vorschläge der KI mit entscheidender Person und Zeitpunkt. Suchanfragen nur aus dem Namen des Themenfelds, anonymisiert wie V8 |
| Empfänger | Suchanbieter wie V8 (nur die Anfrage); KI-Anbieter des Slots (Themenfeld und Treffer; für die Zuordnung Titel und Problem nicht vertraulicher Ideen); SMTP für die Wochenmail |
| Speicherdauer | Wochenhinweise und Vorschläge bis zur Löschung des Arbeitsbereichs (Vorschlag: 24 Monate, offen); Abbestellen über die Kategorie „Trendhinweise“ unter Mein Konto beendet den Versand sofort |
| Drittland | wie V6 und V8 |
