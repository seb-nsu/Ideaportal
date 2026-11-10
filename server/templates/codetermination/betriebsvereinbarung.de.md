<!-- template: betriebsvereinbarung, version 2026-10-13.1 -->
# Betriebsvereinbarung über die Einführung und Nutzung des Ideenportals

> **Entwurf, keine Rechtsberatung, anwaltliche Prüfung offen.** Vorlage {{template.version}}, erzeugt am {{generatedOn}} aus den Einstellungen des Arbeitsbereichs „{{workspace}}“. Der Text ist eine Gesprächsgrundlage zwischen Arbeitgeber und Betriebsrat. Er ersetzt weder die Prüfung durch eine Kanzlei noch die Verhandlung im Betrieb. Werte in eckigen Klammern sind noch festzulegen. Für Personalräte im öffentlichen Dienst gelten andere Gesetze.

zwischen

**{{#if employer}}{{employer}}{{else}}[Name des Arbeitgebers]{{/if}}**, vertreten durch [Name, Funktion] – nachfolgend „Arbeitgeber“ –

und

**{{#if worksCouncil}}{{worksCouncil}}{{else}}dem Betriebsrat [des Betriebs / Gesamtbetriebsrat / Konzernbetriebsrat] [Name]{{/if}}**, vertreten durch [Vorsitz] – nachfolgend „Betriebsrat“ –

## Präambel

Arbeitgeber und Betriebsrat wollen, dass Ideen der Beschäftigten schnell eine Antwort bekommen, fair geprüft werden und ihr Nutzen sichtbar wird. Dafür wird das Ideenportal eingeführt. Jede Idee bekommt innerhalb von {{gate1Workdays}} Arbeitstagen eine erste Antwort. Beide Seiten sind sich einig, dass das System dem Ideenprozess dient und nicht der Kontrolle von Leistung oder Verhalten. Künstliche Intelligenz (KI) unterstützt die Ausarbeitung von Ideen; sie bewertet keine Menschen und entscheidet nichts.

## § 1 Geltungsbereich

1. Räumlich: {{#if scope}}{{scope}}{{else}}[Betrieb(e) / Standorte]{{/if}}.
2. Persönlich: alle Beschäftigten im Sinne von § 5 Abs. 1 BetrVG, einschließlich Auszubildender. Leitende Angestellte nach § 5 Abs. 3 BetrVG sind ausgenommen, soweit nicht anders geregelt.
3. Sachlich: das Ideenportal in der jeweils gültigen Version mit den Funktionen laut Anlage 1, den KI-Funktionen laut Anlage 2 und den Schnittstellen laut Anlage 3.
4. Externe Einreichende (Kunden, Partner) fallen nicht unter diese Vereinbarung. Ihre Daten werden nicht zur Auswertung von Beschäftigten genutzt.

## § 2 Zweck

1. Das Ideenportal dient ausschließlich diesen Zwecken: Ideen einreichen, beantworten, ausarbeiten, entscheiden, umsetzen und anerkennen; Fristen für Antworten und Entscheidungen überwachen und Vertretungen regeln; den Nutzen umgesetzter Ideen erfassen und bestätigen; den Ideenprozess aggregiert steuern und verbessern.
2. Eine Nutzung zu anderen Zwecken, insbesondere zur Leistungs- oder Verhaltenskontrolle, ist unzulässig (§ 3).

## § 3 Grundsätze

1. **Keine Leistungs- und Verhaltenskontrolle.** Daten aus dem Ideenportal werden nicht genutzt, um Leistung oder Verhalten einzelner Beschäftigter zu beurteilen. Das gilt auch für Bearbeitungszeiten von Paten, Triage, Gremium und Gutachter:innen. Fristüberschreitungen lösen Erinnerungen, Vertretung und Eskalation an die zuständige Rolle aus, nicht an Vorgesetzte als Leistungsinformation.
2. **Keine arbeitsrechtlichen Maßnahmen.** Erkenntnisse aus dem Ideenportal werden nicht für arbeitsrechtliche Maßnahmen (Abmahnung, Kündigung, Versetzung, Beurteilung, Vergütung außerhalb der Prämienregeln) verwendet.
3. **KI bewertet keine Personen.** Keine KI-Funktion beurteilt, vergleicht oder rangiert Beschäftigte, ihre Fähigkeiten oder ihr Verhalten. KI-Ausgaben beziehen sich auf Ideen, nicht auf Menschen.
4. **KI entscheidet nicht.** Entscheidungen an den Gates und über Prämien treffen Menschen. KI liefert Entwürfe und Vorschläge, die als KI-Inhalt gekennzeichnet sind. KI lehnt keine Idee ab.
5. **Freiwilligkeit.** Die Teilnahme ist freiwillig. Wer keine Ideen einreicht, hat keine Nachteile.
6. **Transparenz.** Jede Person kann sehen, was mit ihrer Idee passiert (Status, Frist, Begründung der Entscheidung).
7. **Abgrenzung zu Meldekanälen.** Das Ideenportal ist kein Meldekanal nach dem Hinweisgeberschutzgesetz. Erkennt das System eine mögliche Meldung, verweist es auf die zuständige Meldestelle.

## § 4 Rollen und Zugriffsrechte

1. Zugriffe richten sich nach Rollen. Rollen und Rechte stehen in Anlage 4; sie sind aus der Rechteprüfung des Systems erzeugt. Der Arbeitgeber vergibt Rollen nur im dort beschriebenen Umfang.
2. Vorgesetzte haben allein aufgrund ihrer Vorgesetztenstellung keinen Zugriff auf Daten einzelner Beschäftigter im Ideenportal.
3. Der Betriebsrat benennt bis zu [Anzahl] Mitglieder für die Rolle „Betriebsrat (lesend)“. Diese Rolle sieht keine Ideentexte.

## § 5 Verarbeitete Daten

1. Verarbeitet werden nur diese Datenarten: Kontodaten (Name, E-Mail, optional Organisationseinheit, Rollen, Sicherheitsdaten der Anmeldung); Inhalte (Ideen, Kommentare, Anhänge, Entscheidungen mit Begründung, Nutzenangaben); Prozessdaten (Status, Fristen, Abwesenheiten mit Vertretung, Zufriedenheitswerte nach Abschluss); Protokolle laut Anlage 5.
2. Beschäftigte können Ideen vertraulich einreichen (nur zuständige Rollen sehen sie) oder anonym gegenüber der Community (Triage sieht den Namen).
3. Nicht verarbeitet werden: Standortdaten, Tastatur- oder Bildschirmaufzeichnungen, Daten aus anderen Systemen über Leistung oder Anwesenheit.

## § 6 Auswertungen

1. Auswertungen über Personengruppen erfolgen nur aggregiert und erst ab {{minGroupSize}} Personen je Gruppe. Kleinere Gruppen werden zusammengefasst. Der Mindestwert ist im System auf {{minGroupSize}} eingestellt und kann nicht unter 5 gesenkt werden.
2. Unzulässig sind insbesondere: Ranglisten von Personen, Auswertungen von Beteiligung, Bearbeitungszeit oder Entscheidungsverhalten je Person, Vergleiche von Teams unter der Mindestgruppe.
3. Alle Auswertungen des Systems mit Zweck, Verdichtung und berechtigten Rollen stehen in Anlage 1. Personenbezogene Auswertungen dort dienen nur dem genannten Zweck.
4. {{#if crowdRating}}Die Crowd-Bewertung in Challenges ist eingeschaltet. Ein Durchschnitt wird erst ab {{minGroupSize}} Bewertungen angezeigt; einzelne Bewertungen sieht niemand.{{else}}Die Crowd-Bewertung in Challenges ist abgeschaltet.{{/if}} Eine Auswertung je Person über Challenges hinweg findet nicht statt.

## § 7 Einsatz von KI

{{#if ai.enabled}}1. Die aktiven KI-Funktionen, Anbieter, Modelle und Hosting-Region stehen in Anlage 2. Jede KI-Funktion ist einzeln abschaltbar; abgeschaltete Funktionen sind dort ebenfalls aufgeführt.{{else}}1. Die KI-Funktionen sind in diesem Arbeitsbereich vollständig abgeschaltet. Das Einschalten gilt als Änderung nach § 11.{{/if}}
2. KI-Inhalte sind im System als solche gekennzeichnet. Jede Zahl in einer KI-Analyse hat eine Quelle oder ist als Schätzung markiert. Beschäftigte können KI-Aussagen korrigieren.
3. Vertrauliche Ideen und Texte, bei denen das System eine mögliche Meldung erkennt, werden nur mit dem Modell für vertrauliche Inhalte verarbeitet: {{ai.confidential.provider}}{{#if ai.confidential.model}}, {{ai.confidential.model}}{{/if}}{{#if ai.confidential.hosting}} ({{ai.confidential.hosting}}){{/if}}. Sie gehen nie an externe KI- oder Suchdienste.
4. Websuche: {{ai.search.label}}.{{#if ai.search.enabled}} Suchanfragen werden anonymisiert: ohne Namen von Personen, ohne Firmenbezug und ohne Ideentext. In der Kurzanalyse interner Ideen ist die Websuche {{#if ai.search.internalShort}}eingeschaltet{{else}}abgeschaltet{{/if}}.{{/if}}
5. Jede KI-Aktion wird protokolliert. Für jede Idee gibt es einen Datenschutz-Nachweis (Dienst, Region, Modell, Kosten, gesendete Suchanfragen, ohne Ideentexte), den der Betriebsrat jederzeit einsehen und als PDF exportieren kann.
6. Kundendaten werden nicht zum Training von KI-Modellen verwendet. Der Arbeitgeber stellt dies vertraglich mit den Anbietern sicher (Anlage 3).
7. Funktionen, die Personen vorschlagen (z. B. Mitstreiter- oder Expertensuche), werden nur nach Zustimmung des Betriebsrats eingeführt.

## § 8 Löschfristen

1. Es gelten diese Löschfristen (eingestellt im System):

| Daten | Frist |
| --- | --- |
{{#each retention.periods}}| {{.label}} | {{.text}} |
{{/each}}| Audit-Log | [Frist festlegen; im System ohne automatische Löschung] |
| Umgesetzte Ideen mit Nutzen | [Frist festlegen; Personenbezug nach [x] Monaten anonymisieren] |

2. Die Löschung läuft automatisch. Die Fristen für Protokolle stehen in Anlage 5. Beschäftigte können jederzeit Auskunft und einen Export ihrer Daten verlangen.

## § 9 Prämien und Anerkennung

1. [Variante A, kein betriebliches Vorschlagswesen:] Das Ideenportal vergibt keine Geldprämien. Anerkennung erfolgt über Rückmeldung, Nennung (nur mit Zustimmung) und [Maßnahmen].
2. [Variante B, mit betrieblichem Vorschlagswesen:] Prämien richten sich nach der Betriebsvereinbarung zum betrieblichen Vorschlagswesen vom [Datum]. Prämien werden nie durch KI festgelegt.
3. Für mögliche Erfindungen gilt das Arbeitnehmererfindungsgesetz; das Ideenportal weist auf die Meldung an [Stelle] hin.

## § 10 Schnittstellen

Schnittstellen zu anderen Systemen (Anlage 3) übertragen nur die dort genannten Daten. Neue Schnittstellen gelten als Änderung nach § 11.

## § 11 Änderungen am System

1. Der Arbeitgeber kündigt Änderungen, die Rollen, Auswertungen, Protokolle, Löschfristen, KI-Funktionen, KI-Anbieter oder Schnittstellen betreffen, dem Betriebsrat mindestens {{announceWeeks}} Wochen vorher schriftlich an und beschreibt die Auswirkungen.
2. Solche Änderungen werden erst nach Zustimmung des Betriebsrats aktiviert. Jede Änderung dieser Einstellungen wird im System protokolliert und ist für den Betriebsrat in der Mitbestimmungsübersicht als Änderungsverlauf sichtbar.
3. Reine Fehlerbehebungen und Sicherheitsupdates ohne neue Funktionen oder Daten sind nicht zustimmungspflichtig; sie werden im Änderungsprotokoll des Herstellers dokumentiert.
4. Ein Pilotbetrieb vor Abschluss dieser Vereinbarung ist nur auf Grundlage einer Duldungsvereinbarung mit Befristung und Evaluation zulässig.

## § 12 Schulung und Information

1. Beschäftigte erhalten vor dem Start eine Information über Zweck, Rollen, KI-Funktionen, Auswertungen und ihre Rechte (Datenschutzhinweis im System).
2. Personen mit den Rollen Pate, Triage, Gremium, Bereichsleitung und Admin werden vor der ersten Nutzung geschult, insbesondere zu § 3, § 6 und § 7.
3. Mitglieder des Betriebsrats mit der Rolle „Betriebsrat (lesend)“ erhalten eine Einweisung in die Mitbestimmungsübersicht, die KI-Nachweise und den Änderungsverlauf.

## § 13 Kontrollrechte des Betriebsrats

1. Der Betriebsrat kann jederzeit über die Rolle „Betriebsrat (lesend)“ prüfen: Rollen und Rechte, Auswertungen, aktive KI-Funktionen, Löschfristen, Protokolle, KI-Nachweise je Idee und den Änderungsverlauf der Einstellungen.
2. Auf Verlangen legt der Arbeitgeber Auszüge aus dem Audit-Log vor, soweit sie zur Prüfung dieser Vereinbarung nötig sind.
3. Der Betriebsrat kann zur Prüfung eine sachverständige Person hinzuziehen (§ 80 Abs. 3 BetrVG). [Kostenübernahme regeln.]
4. Arbeitgeber und Betriebsrat werten den Betrieb [nach 6 Monaten, danach jährlich] gemeinsam aus.

## § 14 Rechte der Beschäftigten und Einspruchsverfahren

1. Beschäftigte können sich bei Verstößen gegen diese Vereinbarung an den Betriebsrat oder die bzw. den Datenschutzbeauftragten wenden, ohne Nachteile befürchten zu müssen.
2. Gegen Entscheidungen über ihre Ideen können Beschäftigte innerhalb von {{objectionWeeks}} Wochen nach der Mitteilung Einspruch einlegen bei {{#if objectionBody}}{{objectionBody}}{{else}}[Stelle]{{/if}}. Der Einspruch wird von Personen geprüft, die an der ersten Entscheidung nicht beteiligt waren; das Ergebnis wird begründet.
3. Rechte nach der DSGVO (Auskunft, Berichtigung, Löschung, Widerspruch) bleiben unberührt.

## § 15 Streitigkeiten

Bei Meinungsverschiedenheiten über Auslegung oder Anwendung dieser Vereinbarung verhandeln die Parteien zuerst miteinander. Kommt keine Einigung zustande, entscheidet die Einigungsstelle.

## § 16 Inkrafttreten, Kündigung, Nachwirkung

1. Die Vereinbarung tritt am [Datum] in Kraft.
2. Sie kann mit einer Frist von [3] Monaten zum [Monatsende / Quartalsende] gekündigt werden, frühestens zum [Datum].
3. Bis zum Abschluss einer neuen Vereinbarung wirkt sie nach.
4. Sind einzelne Regelungen unwirksam, bleiben die übrigen wirksam.

[Ort, Datum] · [Unterschrift Arbeitgeber] · [Unterschrift Betriebsrat]

---

## Anlage 1: Auswertungen

| Auswertung | Zweck | Verdichtung | Rollen |
| --- | --- | --- | --- |
{{#each reports}}| {{.label}} | {{.purpose}} | {{.aggregationText}} | {{.rolesText}} |
{{/each}}

## Anlage 2: KI-Funktionen

{{#if ai.enabled}}Aktive KI-Funktionen:

| KI-Funktion | Anbieter und Modell | Hosting | erhält | Websuche |
| --- | --- | --- | --- | --- |
{{#each ai.active}}| {{.label}}{{#if .typesText}} ({{.typesText}}){{/if}} | {{.providerText}} | {{.hostingText}} | {{.data}} | {{#if .webSearch}}ja, anonymisiert{{else}}nein{{/if}} |
{{/each}}
{{else}}Die KI-Funktionen sind vollständig abgeschaltet.
{{/if}}
{{#if ai.inactive}}Abgeschaltete KI-Funktionen:

{{#each ai.inactive}}- {{.label}}
{{/each}}{{/if}}

Kostenlimit: {{ai.budget.perIdeaEur}} € je Idee, {{ai.budget.perMonthEur}} € je Monat.

## Anlage 3: Schnittstellen und Auftragsverarbeitung

{{#if ai.external}}Externe KI-Anbieter mit aktiven Funktionen:

{{#each ai.external}}- {{.name}} ({{.hosting}})
{{/each}}{{else}}Keine aktive KI-Funktion nutzt einen externen Anbieter.{{/if}}

[Firmen-Login, Microsoft Teams, Jira, ServiceNow und weitere Schnittstellen eintragen; Auftragsverarbeitungsvertrag und Unterauftragnehmer beifügen.]

## Anlage 4: Rollen und Rechte

Erzeugt aus der Rechteprüfung des Systems. Zusätzlich zu den Rollen gelten Rechte aus der Beziehung zu einer Idee:

{{#each relations}}- {{.}}
{{/each}}

| Rolle | Rechte laut System | Schnittstellen mit Rollenbindung |
| --- | --- | --- |
{{#each roles}}| {{.label}} | {{#if .rightsText}}{{.rightsText}}{{else}}keine Rechte über die Rechte aller Beschäftigten (einreichen, kommentieren, unterstützen, eigene Daten einsehen und exportieren) und die Rechte aus der Beziehung zu einer Idee hinaus{{/if}} | {{.endpointCount}} |
{{/each}}

{{#if scopedAreas}}Die Rollen Triage, Gremium und Bereichsleitung können für einzelne Bereiche vergeben werden. Sie gelten dann nur für die Ideen des Bereichs (Board, Aufgaben, Fristen, Benachrichtigungen, Dashboard und Entscheidungen). Eine Idee gehört zu einem Bereich über ihr Themenfeld oder die Organisationseinheit der einreichenden Person.

| Bereich | Zuordnung | Rollen mit Bereich |
| --- | --- | --- |
{{#each scopedAreas}}| {{.name}} | {{.rule}} | {{.rolesText}} |
{{/each}}{{/if}}

## Anlage 5: Protokolle und Löschfristen

| Protokoll | Inhalt | Löschfrist |
| --- | --- | --- |
{{#each protocols}}| {{.label}} | {{.content}} | {{.retention}} |
{{/each}}
