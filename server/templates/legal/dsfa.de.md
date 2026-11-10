<!-- template: dsfa, version 2026-10-13.1 -->
# Muster für die Datenschutz-Folgenabschätzung (Art. 35 DSGVO)

> **Entwurf, keine Rechtsberatung, anwaltliche Prüfung offen.** Fassung {{template.version}} vom {{template.date}}, erzeugt am {{generatedOn}}{{#if workspace}} aus den Einstellungen des Arbeitsbereichs „{{workspace}}“{{/if}}. Muster für den Verantwortlichen (Kunde); die oder der Datenschutzbeauftragte prüft und ergänzt es. Werte in eckigen Klammern sind festzulegen.

## 1 Beschreibung der Verarbeitung

| Bereich | Beschreibung |
| --- | --- |
| Verantwortlicher | [Unternehmen] |
| Auftragsverarbeiter | {{#if operator.name}}{{operator.name}}{{else}}[Anbieter des Ideenportals]{{/if}} |
| Zweck | Ideen sammeln, in Fristen beantworten, ausarbeiten, entscheiden, umsetzen und Nutzen belegen; Wettbewerbs- und Marktanalyse je Idee |
| Betroffene | Beschäftigte (Einreichende, Kommentierende, Paten, Triage, Gremium, Umsetzung, Admins); [externe Einreichende, falls genutzt] |
| Daten | Konto (Name, E-Mail, Organisationseinheit, Rollen), Ideen, Kommentare, Anhänge, Entscheidungen, Protokolle, KI-Analysen |
| Speicherort | {{#if hosting.eu}}EU{{else}}[Region]{{/if}}{{#if hosting.provider}}, {{hosting.provider}}{{/if}}{{#if hosting.region}} ({{hosting.region}}){{/if}} |
| Speicherdauer | {{#if retention}}{{retention.periodsText}}{{else}}[Löschfristen]{{/if}} |

## 2 KI-Funktionen im Arbeitsbereich

{{#if ai.enabled}}Aktive KI-Funktionen: {{ai.activeText}}.

Modell für vertrauliche Ideen und mögliche Meldungen: {{ai.confidential.provider}}{{#if ai.confidential.hosting}} ({{ai.confidential.hosting}}){{/if}}. Websuche: {{#if ai.search}}eingeschaltet, ohne Personen- und Firmennamen, nicht für vertrauliche Ideen und mögliche Erfindungen{{else}}ausgeschaltet{{/if}}.{{else}}Alle KI-Funktionen sind abgeschaltet.{{/if}}

## 3 Empfänger und Unterauftragnehmer

| Name | Zweck | Ort | Vertrag | aktiv |
| --- | --- | --- | --- | --- |
{{#each subprocessors}}| {{.name}} | {{.purpose}} | {{.locationText}} | {{.contractText}} | {{.activeText}} |
{{/each}}

## 4 Notwendigkeit und Verhältnismäßigkeit

| Grundsatz | Umsetzung im Produkt | Bewertung des Verantwortlichen |
| --- | --- | --- |
| Zweckbindung | keine Leistungs- oder Verhaltenskontrolle; kein Training von Modellen mit Kundendaten | [ ] |
| Datenminimierung | Pflichtfelder nur Name und E-Mail; anonyme Einreichung gegenüber der Community; Suche ohne Personenbezug | [ ] |
| Speicherbegrenzung | Löschfristen je Arbeitsbereich, automatischer Löschjob | [ ] |
| Transparenz | Datenschutzhinweis im Arbeitsbereich, Kennzeichnung von KI-Ergebnissen, Übersicht Mitbestimmung | [ ] |
| Betroffenenrechte | Auskunft und Export je Person, Anonymisierung, Berichtigung unter „Mein Konto“ | [ ] |

## 5 Risiken und Maßnahmen

| Nr. | Risiko | Maßnahme im Produkt | Restrisiko |
| --- | --- | --- | --- |
| R1 | Leistungs- und Verhaltenskontrolle | Auswertungen nur zusammengefasst ab {{minGroupSize}} Personen; keine Ranglisten von Personen; Betriebsrat sieht Rollen, Auswertungen und KI-Funktionen | [niedrig/mittel/hoch] |
| R2 | KI bewertet oder benachteiligt Personen | KI entscheidet nichts und bewertet keine Personen; Ergebnisse sind Entwürfe; Protokoll jeder KI-Aktion | [ ] |
| R3 | Abfluss vertraulicher Inhalte an Dritte | vertrauliche Ideen nur an lokale Modelle; keine Websuche für vertrauliche Ideen und mögliche Erfindungen | [ ] |
| R4 | Fehlgeleitete Hinweise auf Rechtsverstöße | Abgrenzungsprüfung mit Weiterleitung an Zielkanäle; Portal ist kein Meldekanal nach HinSchG | [ ] |
| R5 | Unbefugter Zugriff, Datenleck zwischen Mandanten | siehe TOM (Anlage 1 zum AVV) | [ ] |
| R6 | Offenlegung einer Erfindung vor der Anmeldung | Prüfschritt „mögliche Erfindung?“ in der Triage; Weiterleitung an die Patentstelle setzt die Idee vertraulich | [ ] |

## 6 Ergebnis

- Stellungnahme der oder des Datenschutzbeauftragten: [ ]
- Beteiligung der Arbeitnehmervertretung: [ ]
- Entscheidung des Verantwortlichen und Datum: [ ]
- Nächste Überprüfung: [spätestens nach 12 Monaten oder bei Änderung der KI-Funktionen]
