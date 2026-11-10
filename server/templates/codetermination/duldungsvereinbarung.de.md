<!-- template: duldungsvereinbarung, version 2026-10-12.1 -->
# Duldungsvereinbarung für den Pilotbetrieb des Ideenportals

> **Entwurf, keine Rechtsberatung, anwaltliche Prüfung offen.** Vorlage {{template.version}}, erzeugt am {{generatedOn}} aus den Einstellungen des Arbeitsbereichs „{{workspace}}“. Die Vereinbarung regelt nur den befristeten Pilot bis zum Abschluss der Betriebsvereinbarung. Werte in eckigen Klammern sind noch festzulegen.

zwischen

**{{#if employer}}{{employer}}{{else}}[Name des Arbeitgebers]{{/if}}** – nachfolgend „Arbeitgeber“ –

und

**{{#if worksCouncil}}{{worksCouncil}}{{else}}dem Betriebsrat [Name]{{/if}}** – nachfolgend „Betriebsrat“ –

## § 1 Gegenstand und Befristung

1. Der Betriebsrat duldet den Pilotbetrieb des Ideenportals im Bereich {{#if pilotArea}}{{pilotArea}}{{else}}[Pilotbereich]{{/if}} für höchstens {{pilotMonths}} Monate ab [Startdatum].
2. Die Duldung ist keine Zustimmung zur dauerhaften Einführung und kein Verzicht auf Mitbestimmungsrechte. Sie präjudiziert die Betriebsvereinbarung nicht.
3. Der Pilot endet automatisch mit Fristablauf oder mit Abschluss der Betriebsvereinbarung. Eine Verlängerung bedarf der schriftlichen Zustimmung des Betriebsrats.

## § 2 Grundsätze im Pilot

1. Daten aus dem Pilot werden nicht zur Leistungs- oder Verhaltenskontrolle und nicht für arbeitsrechtliche Maßnahmen genutzt.
2. Auswertungen über Personengruppen erfolgen nur aggregiert und erst ab {{minGroupSize}} Personen je Gruppe.
3. KI bewertet keine Personen und entscheidet nichts. Vertrauliche Ideen und mögliche Meldungen gehen nur an das Modell für vertrauliche Inhalte ({{ai.confidential.provider}}{{#if ai.confidential.hosting}}, {{ai.confidential.hosting}}{{/if}}).
4. Die Teilnahme ist freiwillig. Teilnehmende werden vor dem Start über Zweck, KI-Funktionen und ihre Rechte informiert.

## § 3 KI-Funktionen im Pilot

{{#if ai.enabled}}Im Pilot sind diese KI-Funktionen aktiv:

{{#each ai.active}}- {{.label}}: {{.providerText}}{{#if .hostingText}} ({{.hostingText}}){{/if}}
{{/each}}
{{#if ai.inactive}}Abgeschaltet sind: {{ai.inactiveText}}.

{{/if}}Weitere KI-Funktionen werden im Pilot nur nach Zustimmung des Betriebsrats eingeschaltet.{{else}}Im Pilot sind alle KI-Funktionen abgeschaltet.{{/if}}

## § 4 Kontrolle und Änderungen

1. Mindestens ein Mitglied des Betriebsrats erhält die Rolle „Betriebsrat (lesend)“. Damit sieht es Rollen und Rechte, Auswertungen, KI-Funktionen, Löschfristen, Protokolle, KI-Nachweise und den Änderungsverlauf der Einstellungen.
2. Änderungen an Rollen, Auswertungen, KI-Funktionen oder Löschfristen kündigt der Arbeitgeber mindestens {{announceWeeks}} Wochen vorher an; im Pilot werden sie erst nach Zustimmung des Betriebsrats aktiviert.

## § 5 Daten nach Ende des Pilots

1. Es gelten die eingestellten Löschfristen: {{retention.periodsText}}.
2. Kommt keine Betriebsvereinbarung zustande, werden die Pilotdaten innerhalb von [3] Monaten nach Pilotende gelöscht oder anonymisiert. Kommt sie zustande, gelten ihre Regeln.

## § 6 Evaluation

1. Arbeitgeber und Betriebsrat werten den Pilot spätestens [4] Wochen vor Ende gemeinsam aus: Antwortzeiten, Zufriedenheit der Teilnehmenden, Erfahrungen mit den KI-Funktionen, Einhaltung dieser Vereinbarung.
2. Die Auswertung ist Grundlage für die Verhandlung der Betriebsvereinbarung.

## § 7 Einspruch

Teilnehmende können gegen Entscheidungen über ihre Ideen innerhalb von {{objectionWeeks}} Wochen Einspruch einlegen bei {{#if objectionBody}}{{objectionBody}}{{else}}[Stelle]{{/if}}.

## § 8 Kündigung

Der Betriebsrat kann die Duldung bei einem Verstoß gegen diese Vereinbarung mit sofortiger Wirkung schriftlich beenden. Der Pilot wird dann eingestellt.

[Ort, Datum] · [Unterschrift Arbeitgeber] · [Unterschrift Betriebsrat]
