<!-- template: datenschutz, version 2026-10-13.1 -->
# Datenschutzerklärung des Ideenportals

> **Entwurf, keine Rechtsberatung, anwaltliche Prüfung offen.** Fassung {{template.version}} vom {{template.date}}. Werte in eckigen Klammern sind noch festzulegen.

## 1 Verantwortlicher und Kontakt

Verantwortlich für die Website, die Registrierung und die Kundenkonten ist **{{#if operator.name}}{{operator.name}}{{else}}[Name des Anbieters]{{/if}}**, {{#if operator.address}}{{operator.address}}{{else}}[Anschrift]{{/if}}, {{#if operator.email}}{{operator.email}}{{else}}[E-Mail-Adresse]{{/if}}.

Datenschutzkontakt: {{#if operator.privacyContact}}{{operator.privacyContact}}{{else}}[Datenschutzbeauftragte Person oder Kontaktadresse]{{/if}}.

## 2 Zwei Rollen: Anbieter und Auftragsverarbeiter

1. **Inhalte im Arbeitsbereich** (Ideen, Kommentare, Bewertungen, Konten der Mitarbeitenden) verarbeitet der Anbieter im Auftrag des Kunden (Art. 28 DSGVO). Verantwortlich ist das Unternehmen, das den Arbeitsbereich nutzt. Informationen dazu gibt der Datenschutzhinweis im Arbeitsbereich; Fragen dazu richten Sie bitte an Ihr Unternehmen.
2. **Website, Registrierung, Vertrag und Abrechnung** verarbeitet der Anbieter als Verantwortlicher. Dafür gilt diese Erklärung.

## 3 Welche Daten wir verarbeiten

| Zweck | Daten | Rechtsgrundlage | Speicherdauer |
| --- | --- | --- | --- |
| Aufruf der Website und der Anwendung | IP-Adresse (nur in den Zugriffsprotokollen des Hosters, nicht in den Protokollen der Anwendung), Zeitpunkt, aufgerufene Seite ohne Suchbegriffe, Browserangaben | Art. 6 Abs. 1 lit. f DSGVO (sicherer Betrieb) | Server-Protokolle [14] Tage |
| Schutz vor Missbrauch | IP-Adresse und Konto bei Anmeldeversuchen, Registrierung und Passwort-Reset (Rate-Limits) | Art. 6 Abs. 1 lit. f DSGVO | höchstens 24 Stunden, Sicherheitsereignisse 90 Tage |
| Registrierung und Konto der ersten Admin | Name, E-Mail-Adresse, Passwort (nur als Hash), Name des Arbeitsbereichs, Sprache | Art. 6 Abs. 1 lit. b DSGVO | bis zum Vertragsende |
| Anmeldung | Sitzungs-Cookie `ip_session` (technisch notwendig, nur Hash gespeichert), optional Zwei-Faktor-Geheimnis (verschlüsselt) | Art. 6 Abs. 1 lit. b DSGVO, § 25 Abs. 2 TDDDG | Sitzung höchstens [12] Stunden |
| Vertrag und Abrechnung | Firmenname, Ansprechperson, Rechnungsdaten, bestätigte Fassung der AGB mit Zeitpunkt | Art. 6 Abs. 1 lit. b und c DSGVO | gesetzliche Aufbewahrungsfristen |
| Öffentliche Demo | Inhalte, die Besucherinnen und Besucher eingeben | Art. 6 Abs. 1 lit. f DSGVO | Zurücksetzen täglich |

Wir verwenden keine Tracking- oder Werbe-Cookies und keine Analysedienste Dritter. Die Sprache der öffentlichen Seiten wird nur im Browser gespeichert (`localStorage`).

## 4 Empfänger und Hosting

Die Anwendung und die Datenbank laufen {{#if hosting.eu}}in der EU{{else}}[Region]{{/if}}{{#if hosting.provider}} bei {{hosting.provider}}{{/if}}{{#if hosting.region}} ({{hosting.region}}){{/if}}. Daten werden verschlüsselt übertragen (TLS) und verschlüsselt gespeichert.

{{#each subprocessors}}- {{.name}}: {{.purpose}} ({{.locationText}})
{{/each}}
KI- und Suchanbieter wählt jeder Kunde für seinen Arbeitsbereich selbst; die aktuelle Liste steht für Admins im Produkt. Vertrauliche Ideen und mögliche Meldungen gehen nie an externe KI- oder Suchdienste.

## 5 Ihre Rechte

Sie haben das Recht auf Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung, Datenübertragbarkeit und Widerspruch (Art. 15–21 DSGVO) sowie das Recht, sich bei einer Aufsichtsbehörde zu beschweren (Art. 77 DSGVO). Wenden Sie sich dazu an den Datenschutzkontakt oben.

## 6 Keine automatisierten Entscheidungen

Das Ideenportal trifft keine automatisierten Entscheidungen im Sinne von Art. 22 DSGVO. KI-Funktionen erstellen nur Entwürfe und bewerten keine Personen.

## 7 Änderungen

Neue Fassungen dieser Erklärung werden mit Version und Datum unter `/rechtliches` veröffentlicht.
