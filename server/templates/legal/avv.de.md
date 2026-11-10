<!-- template: avv, version 2026-10-13.1 -->
# Vertrag zur Auftragsverarbeitung (Art. 28 DSGVO)

> **Entwurf, keine Rechtsberatung, anwaltliche Prüfung offen.** Fassung {{template.version}} vom {{template.date}}, erzeugt am {{generatedOn}}{{#if workspace}} für den Arbeitsbereich „{{workspace}}“{{/if}}. Werte in eckigen Klammern sind festzulegen. Anlage 2 (Unterauftragnehmer) ist aus der Konfiguration erzeugt und ändert sich mit den KI-Einstellungen.

zwischen **[Kunde]** – Verantwortlicher – und **{{#if operator.name}}{{operator.name}}{{else}}[Name des Anbieters]{{/if}}**{{#if operator.address}}, {{operator.address}}{{/if}} – Auftragsverarbeiter –

## § 1 Gegenstand und Dauer

1. Der Auftragsverarbeiter betreibt für den Verantwortlichen das Ideenportal als Software as a Service. Gegenstand, Art und Zweck der Verarbeitung ergeben sich aus dem Hauptvertrag und der Leistungsbeschreibung.
2. Der Vertrag gilt für die Laufzeit des Hauptvertrags und darüber hinaus, solange der Auftragsverarbeiter Daten des Verantwortlichen verarbeitet.

## § 2 Art der Daten und Kreis der Betroffenen

- Daten: Kontodaten (Name, E-Mail, Organisationseinheit, Rollen, Sicherheitsdaten), Ideen, Kommentare, Anhänge, Entscheidungen, Bewertungen, Protokolle, KI-Analysen.
- Betroffene: Beschäftigte des Verantwortlichen und von ihm eingeladene Personen; [externe Einreichende, falls genutzt].
- Besondere Kategorien nach Art. 9 DSGVO sind nicht vorgesehen; sie können in Freitexten vorkommen.

## § 3 Weisungen

1. Der Auftragsverarbeiter verarbeitet Daten nur auf dokumentierte Weisung des Verantwortlichen. Einstellungen im Produkt (insbesondere KI-Anbieter, Websuche, Löschfristen, Rollen) gelten als Weisung; Änderungen stehen im Audit-Log.
2. Hält der Auftragsverarbeiter eine Weisung für rechtswidrig, informiert er den Verantwortlichen unverzüglich.

## § 4 Vertraulichkeit

Personen, die beim Auftragsverarbeiter Zugang zu Daten haben, sind zur Vertraulichkeit verpflichtet. Support-Zugriff auf einen Arbeitsbereich erfolgt nur mit Freigabe des Verantwortlichen und wird protokolliert.

## § 5 Technische und organisatorische Maßnahmen

Der Auftragsverarbeiter trifft die Maßnahmen nach Art. 32 DSGVO aus **Anlage 1 (TOM)**. Hosting und Datenbank liegen {{#if hosting.eu}}in der EU{{else}}[Region]{{/if}}{{#if hosting.region}} ({{hosting.region}}){{/if}}. Daten werden bei der Übertragung und bei der Speicherung verschlüsselt.

## § 6 Unterauftragnehmer

1. Der Verantwortliche stimmt den Unterauftragnehmern aus **Anlage 2** zu.
2. Über beabsichtigte Änderungen informiert der Auftragsverarbeiter mindestens [4] Wochen vorher; der Verantwortliche kann aus wichtigem datenschutzrechtlichem Grund widersprechen.
3. KI- und Suchanbieter, die der Verantwortliche mit eigenem Schlüssel und eigenem Vertrag einbindet, sind keine Unterauftragnehmer des Auftragsverarbeiters; sie stehen in Anlage 2 zur Information.
4. Übermittlungen in Drittländer erfolgen nur mit einer Grundlage nach Art. 44 ff. DSGVO (z. B. Angemessenheitsbeschluss oder Standardvertragsklauseln).

## § 7 Unterstützung des Verantwortlichen

Der Auftragsverarbeiter unterstützt bei Betroffenenrechten (Auskunft und Export je Person, Berichtigung, Anonymisierung im Produkt), bei der Datenschutz-Folgenabschätzung (Muster im Produkt) und bei Prüfungen.

## § 8 Meldung von Verletzungen

Der Auftragsverarbeiter meldet Verletzungen des Schutzes personenbezogener Daten unverzüglich, möglichst innerhalb von 24 Stunden nach Kenntnis, mit den Angaben nach Art. 33 Abs. 3 DSGVO.

## § 9 Kontrollen

Der Verantwortliche kann die Einhaltung prüfen, vorrangig durch Nachweise (Sicherheitskonzept, Zertifikate der Unterauftragnehmer, Bericht des Penetrationstests), bei begründetem Anlass vor Ort nach Ankündigung von [14] Tagen.

## § 10 Löschung und Rückgabe

Nach Vertragsende kann der Verantwortliche seine Daten exportieren. Der Auftragsverarbeiter löscht sie innerhalb von [30] Tagen, Sicherungen nach Ablauf ihres Zyklus.

## Anlage 1: Technische und organisatorische Maßnahmen

Siehe Dokument „Technische und organisatorische Maßnahmen (TOM)“, Fassung im Produkt unter Einstellungen › Rechtliches.

## Anlage 2: Unterauftragnehmer und weitere Empfänger

Stand {{generatedOn}}.

| Name | Zweck | Daten | Ort | Vertragsverhältnis | aktiv |
| --- | --- | --- | --- | --- | --- |
{{#each subprocessors}}| {{.name}} | {{.purpose}} | {{.data}} | {{.locationText}} | {{.contractText}} | {{.activeText}} |
{{/each}}
