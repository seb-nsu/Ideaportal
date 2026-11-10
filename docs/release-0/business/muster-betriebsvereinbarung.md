# Muster-Betriebsvereinbarung Ideenportal (Entwurf)

Stand 13.10.2026 · Vorlage 2026-10-13.1 · Arbeitspakete AP-10, AP-15 (R3-12) und AP-19 (R3-29) · **Entwurf, keine Rechtsberatung, anwaltliche Prüfung offen**

> **Hinweis:** Keine Rechtsberatung. Dieser Text ist ein Entwurf als Gesprächsgrundlage zwischen Arbeitgeber und Betriebsrat. Er ersetzt weder die Prüfung durch eine Kanzlei noch die Verhandlung im Betrieb. Die anwaltliche Prüfung ist Exit-Kriterium von Phase 3 (Umsetzungskonzept Abschnitt 4) und liegt beim Product Owner. Für Personalräte im öffentlichen Dienst gelten andere Gesetze; der Text passt dort nicht ohne Anpassung.

**Verwendung:**

- **Im Produkt (R3-12):** Die Seite **Mitbestimmung** (`/mitbestimmung`, Rollen Admin und „Betriebsrat (lesend)“) erzeugt diese Vereinbarung aus den Einstellungen des Arbeitsbereichs als PDF und als Markdown. Maßgeblich ist die Vorlage `server/templates/codetermination/betriebsvereinbarung.de.md`; der Text unten ist diese Vorlage, mit den Platzhaltern statt der Werte eines Arbeitsbereichs. Die Zuordnung der Platzhalter zu den Einstellungen steht in Anlage 6. Jedes erzeugte Dokument trägt die Vorlagenversion, das Erzeugungsdatum und den Hinweis „Entwurf, keine Rechtsberatung, anwaltliche Prüfung offen“.
- **Zweite Vorlage:** Duldungsvereinbarung für den Pilot (Anlage 8), Vorlage `server/templates/codetermination/duldungsvereinbarung.de.md`.
- **Versionierung:** Wer den Vertragstext ändert, ändert die Vorlage im Produkt und diese Datei gemeinsam und erhöht die Version in der ersten Zeile der Vorlage (`<!-- template: …, version JJJJ-MM-TT.n -->`). Ein Test prüft, dass die erzeugten Dokumente die Einstellungen wiedergeben (`server/test/codetermination.test.ts`).
- **Vertriebsunterlage:** Download gegen Kontakt (Produktkonzept Teil B, Go-to-Market); Bestandteil des Einführungspakets ab Business.
- **Rechtlicher Rahmen (Einordnung, keine Rechtsberatung):** Das Ideenportal ist eine technische Einrichtung, die objektiv geeignet ist, Verhalten oder Leistung zu überwachen (§ 87 Abs. 1 Nr. 6 BetrVG; BAG 2022 zu Microsoft 365). Bei Prämien berührt es die Grundsätze des betrieblichen Vorschlagswesens (§ 87 Abs. 1 Nr. 12 BetrVG). Beim Einsatz von KI hat der Betriebsrat Unterrichtungs- und Beratungsrechte (§ 90 BetrVG) und kann eine sachverständige Person hinzuziehen (§ 80 Abs. 3 BetrVG). Quellen: Review V3, Abschnitt 10 „Recht und Mitbestimmung“.

**Lesart der Platzhalter:** `[Wert]` in eckigen Klammern. Platzhalter mit einer Einstellung (z. B. „[Mindestgruppe, Voreinstellung 5]“) füllt das Produkt automatisch; Platzhalter ohne Einstellung (z. B. „[Datum]“, „[Kostenübernahme regeln.]“) bleiben im erzeugten Dokument stehen und werden im Betrieb ausgehandelt. Tabellen in den Anlagen 1, 2, 4 und 5 sind im Beispiel mit einer Zeile dargestellt; das Produkt erzeugt eine Zeile je Auswertung, KI-Funktion, Rolle und Protokoll.

---

## Betriebsvereinbarung über die Einführung und Nutzung des Ideenportals

> **Entwurf, keine Rechtsberatung, anwaltliche Prüfung offen.** Vorlage [Vorlagenversion], erzeugt am [Datum der Erzeugung] aus den Einstellungen des Arbeitsbereichs „[Arbeitsbereich]“. Der Text ist eine Gesprächsgrundlage zwischen Arbeitgeber und Betriebsrat. Er ersetzt weder die Prüfung durch eine Kanzlei noch die Verhandlung im Betrieb. Werte in eckigen Klammern sind noch festzulegen. Für Personalräte im öffentlichen Dienst gelten andere Gesetze.

zwischen

**[Name des Arbeitgebers]**, vertreten durch [Name, Funktion] – nachfolgend „Arbeitgeber“ –

und

**dem Betriebsrat [des Betriebs / Gesamtbetriebsrat / Konzernbetriebsrat] [Name]**, vertreten durch [Vorsitz] – nachfolgend „Betriebsrat“ –

### Präambel

Arbeitgeber und Betriebsrat wollen, dass Ideen der Beschäftigten schnell eine Antwort bekommen, fair geprüft werden und ihr Nutzen sichtbar wird. Dafür wird das Ideenportal eingeführt. Jede Idee bekommt innerhalb von [Frist erste Antwort, Voreinstellung 10] Arbeitstagen eine erste Antwort. Beide Seiten sind sich einig, dass das System dem Ideenprozess dient und nicht der Kontrolle von Leistung oder Verhalten. Künstliche Intelligenz (KI) unterstützt die Ausarbeitung von Ideen; sie bewertet keine Menschen und entscheidet nichts.

### § 1 Geltungsbereich

1. Räumlich: [Betrieb(e) / Standorte].
2. Persönlich: alle Beschäftigten im Sinne von § 5 Abs. 1 BetrVG, einschließlich Auszubildender. Leitende Angestellte nach § 5 Abs. 3 BetrVG sind ausgenommen, soweit nicht anders geregelt.
3. Sachlich: das Ideenportal in der jeweils gültigen Version mit den Funktionen laut Anlage 1, den KI-Funktionen laut Anlage 2 und den Schnittstellen laut Anlage 3.
4. Externe Einreichende (Kunden, Partner) fallen nicht unter diese Vereinbarung. Ihre Daten werden nicht zur Auswertung von Beschäftigten genutzt.

### § 2 Zweck

1. Das Ideenportal dient ausschließlich diesen Zwecken: Ideen einreichen, beantworten, ausarbeiten, entscheiden, umsetzen und anerkennen; Fristen für Antworten und Entscheidungen überwachen und Vertretungen regeln; den Nutzen umgesetzter Ideen erfassen und bestätigen; den Ideenprozess aggregiert steuern und verbessern.
2. Eine Nutzung zu anderen Zwecken, insbesondere zur Leistungs- oder Verhaltenskontrolle, ist unzulässig (§ 3).

### § 3 Grundsätze

1. **Keine Leistungs- und Verhaltenskontrolle.** Daten aus dem Ideenportal werden nicht genutzt, um Leistung oder Verhalten einzelner Beschäftigter zu beurteilen. Das gilt auch für Bearbeitungszeiten von Paten, Triage, Gremium und Gutachter:innen. Fristüberschreitungen lösen Erinnerungen, Vertretung und Eskalation an die zuständige Rolle aus, nicht an Vorgesetzte als Leistungsinformation.
2. **Keine arbeitsrechtlichen Maßnahmen.** Erkenntnisse aus dem Ideenportal werden nicht für arbeitsrechtliche Maßnahmen (Abmahnung, Kündigung, Versetzung, Beurteilung, Vergütung außerhalb der Prämienregeln) verwendet.
3. **KI bewertet keine Personen.** Keine KI-Funktion beurteilt, vergleicht oder rangiert Beschäftigte, ihre Fähigkeiten oder ihr Verhalten. KI-Ausgaben beziehen sich auf Ideen, nicht auf Menschen.
4. **KI entscheidet nicht.** Entscheidungen an den Gates und über Prämien treffen Menschen. KI liefert Entwürfe und Vorschläge, die als KI-Inhalt gekennzeichnet sind. KI lehnt keine Idee ab.
5. **Freiwilligkeit.** Die Teilnahme ist freiwillig. Wer keine Ideen einreicht, hat keine Nachteile.
6. **Transparenz.** Jede Person kann sehen, was mit ihrer Idee passiert (Status, Frist, Begründung der Entscheidung).
7. **Abgrenzung zu Meldekanälen.** Das Ideenportal ist kein Meldekanal nach dem Hinweisgeberschutzgesetz. Erkennt das System eine mögliche Meldung, verweist es auf die zuständige Meldestelle.

### § 4 Rollen und Zugriffsrechte

1. Zugriffe richten sich nach Rollen. Rollen und Rechte stehen in Anlage 4; sie sind aus der Rechteprüfung des Systems erzeugt. Der Arbeitgeber vergibt Rollen nur im dort beschriebenen Umfang.
2. Vorgesetzte haben allein aufgrund ihrer Vorgesetztenstellung keinen Zugriff auf Daten einzelner Beschäftigter im Ideenportal.
3. Der Betriebsrat benennt bis zu [Anzahl] Mitglieder für die Rolle „Betriebsrat (lesend)“. Diese Rolle sieht keine Ideentexte.

### § 5 Verarbeitete Daten

1. Verarbeitet werden nur diese Datenarten: Kontodaten (Name, E-Mail, optional Organisationseinheit, Rollen, Sicherheitsdaten der Anmeldung); Inhalte (Ideen, Kommentare, Anhänge, Entscheidungen mit Begründung, Nutzenangaben); Prozessdaten (Status, Fristen, Abwesenheiten mit Vertretung, Zufriedenheitswerte nach Abschluss); Protokolle laut Anlage 5.
2. Beschäftigte können Ideen vertraulich einreichen (nur zuständige Rollen sehen sie) oder anonym gegenüber der Community (Triage sieht den Namen).
3. Nicht verarbeitet werden: Standortdaten, Tastatur- oder Bildschirmaufzeichnungen, Daten aus anderen Systemen über Leistung oder Anwesenheit.

### § 6 Auswertungen

1. Auswertungen über Personengruppen erfolgen nur aggregiert und erst ab [Mindestgruppe, Voreinstellung 5] Personen je Gruppe. Kleinere Gruppen werden zusammengefasst. Der Mindestwert ist im System auf [Mindestgruppe, Voreinstellung 5] eingestellt und kann nicht unter 5 gesenkt werden.
2. Unzulässig sind insbesondere: Ranglisten von Personen, Auswertungen von Beteiligung, Bearbeitungszeit oder Entscheidungsverhalten je Person, Vergleiche von Teams unter der Mindestgruppe.
3. Alle Auswertungen des Systems mit Zweck, Verdichtung und berechtigten Rollen stehen in Anlage 1. Personenbezogene Auswertungen dort dienen nur dem genannten Zweck.
4. Die Crowd-Bewertung in Challenges ist eingeschaltet. Ein Durchschnitt wird erst ab [Mindestgruppe, Voreinstellung 5] Bewertungen angezeigt; einzelne Bewertungen sieht niemand. Eine Auswertung je Person über Challenges hinweg findet nicht statt.

### § 7 Einsatz von KI

1. Die aktiven KI-Funktionen, Anbieter, Modelle und Hosting-Region stehen in Anlage 2. Jede KI-Funktion ist einzeln abschaltbar; abgeschaltete Funktionen sind dort ebenfalls aufgeführt.
2. KI-Inhalte sind im System als solche gekennzeichnet. Jede Zahl in einer KI-Analyse hat eine Quelle oder ist als Schätzung markiert. Beschäftigte können KI-Aussagen korrigieren.
3. Vertrauliche Ideen und Texte, bei denen das System eine mögliche Meldung erkennt, werden nur mit dem Modell für vertrauliche Inhalte verarbeitet: [Anbieter für vertrauliche Inhalte], [Modell] ([Hosting]). Sie gehen nie an externe KI- oder Suchdienste.
4. Websuche: [Websuche laut Einstellung]. Suchanfragen werden anonymisiert: ohne Namen von Personen, ohne Firmenbezug und ohne Ideentext. In der Kurzanalyse interner Ideen ist die Websuche abgeschaltet.
5. Jede KI-Aktion wird protokolliert. Für jede Idee gibt es einen Datenschutz-Nachweis (Dienst, Region, Modell, Kosten, gesendete Suchanfragen, ohne Ideentexte), den der Betriebsrat jederzeit einsehen und als PDF exportieren kann.
6. Kundendaten werden nicht zum Training von KI-Modellen verwendet. Der Arbeitgeber stellt dies vertraglich mit den Anbietern sicher (Anlage 3).
7. Funktionen, die Personen vorschlagen (z. B. Mitstreiter- oder Expertensuche), werden nur nach Zustimmung des Betriebsrats eingeführt.

### § 8 Löschfristen

1. Es gelten diese Löschfristen (eingestellt im System):

| Daten | Frist |
| --- | --- |
| [Datenart] | [Frist laut Einstellung] |
| Audit-Log | [Frist festlegen; im System ohne automatische Löschung] |
| Umgesetzte Ideen mit Nutzen | [Frist festlegen; Personenbezug nach [x] Monaten anonymisieren] |

2. Die Löschung läuft automatisch. Die Fristen für Protokolle stehen in Anlage 5. Beschäftigte können jederzeit Auskunft und einen Export ihrer Daten verlangen.

### § 9 Prämien und Anerkennung

1. [Variante A, kein betriebliches Vorschlagswesen:] Das Ideenportal vergibt keine Geldprämien. Anerkennung erfolgt über Rückmeldung, Nennung (nur mit Zustimmung) und [Maßnahmen].
2. [Variante B, mit betrieblichem Vorschlagswesen:] Prämien richten sich nach der Betriebsvereinbarung zum betrieblichen Vorschlagswesen vom [Datum]. Prämien werden nie durch KI festgelegt.
3. Für mögliche Erfindungen gilt das Arbeitnehmererfindungsgesetz; das Ideenportal weist auf die Meldung an [Stelle] hin.

### § 10 Schnittstellen

Schnittstellen zu anderen Systemen (Anlage 3) übertragen nur die dort genannten Daten. Neue Schnittstellen gelten als Änderung nach § 11.

### § 11 Änderungen am System

1. Der Arbeitgeber kündigt Änderungen, die Rollen, Auswertungen, Protokolle, Löschfristen, KI-Funktionen, KI-Anbieter oder Schnittstellen betreffen, dem Betriebsrat mindestens [Ankündigungsfrist in Wochen, Voreinstellung 4] Wochen vorher schriftlich an und beschreibt die Auswirkungen.
2. Solche Änderungen werden erst nach Zustimmung des Betriebsrats aktiviert. Jede Änderung dieser Einstellungen wird im System protokolliert und ist für den Betriebsrat in der Mitbestimmungsübersicht als Änderungsverlauf sichtbar.
3. Reine Fehlerbehebungen und Sicherheitsupdates ohne neue Funktionen oder Daten sind nicht zustimmungspflichtig; sie werden im Änderungsprotokoll des Herstellers dokumentiert.
4. Ein Pilotbetrieb vor Abschluss dieser Vereinbarung ist nur auf Grundlage einer Duldungsvereinbarung mit Befristung und Evaluation zulässig.

### § 12 Schulung und Information

1. Beschäftigte erhalten vor dem Start eine Information über Zweck, Rollen, KI-Funktionen, Auswertungen und ihre Rechte (Datenschutzhinweis im System).
2. Personen mit den Rollen Pate, Triage, Gremium, Bereichsleitung und Admin werden vor der ersten Nutzung geschult, insbesondere zu § 3, § 6 und § 7.
3. Mitglieder des Betriebsrats mit der Rolle „Betriebsrat (lesend)“ erhalten eine Einweisung in die Mitbestimmungsübersicht, die KI-Nachweise und den Änderungsverlauf.

### § 13 Kontrollrechte des Betriebsrats

1. Der Betriebsrat kann jederzeit über die Rolle „Betriebsrat (lesend)“ prüfen: Rollen und Rechte, Auswertungen, aktive KI-Funktionen, Löschfristen, Protokolle, KI-Nachweise je Idee und den Änderungsverlauf der Einstellungen.
2. Auf Verlangen legt der Arbeitgeber Auszüge aus dem Audit-Log vor, soweit sie zur Prüfung dieser Vereinbarung nötig sind.
3. Der Betriebsrat kann zur Prüfung eine sachverständige Person hinzuziehen (§ 80 Abs. 3 BetrVG). [Kostenübernahme regeln.]
4. Arbeitgeber und Betriebsrat werten den Betrieb [nach 6 Monaten, danach jährlich] gemeinsam aus.

### § 14 Rechte der Beschäftigten und Einspruchsverfahren

1. Beschäftigte können sich bei Verstößen gegen diese Vereinbarung an den Betriebsrat oder die bzw. den Datenschutzbeauftragten wenden, ohne Nachteile befürchten zu müssen.
2. Gegen Entscheidungen über ihre Ideen können Beschäftigte innerhalb von [Einspruchsfrist in Wochen, Voreinstellung 2] Wochen nach der Mitteilung Einspruch einlegen bei [Stelle]. Der Einspruch wird von Personen geprüft, die an der ersten Entscheidung nicht beteiligt waren; das Ergebnis wird begründet.
3. Rechte nach der DSGVO (Auskunft, Berichtigung, Löschung, Widerspruch) bleiben unberührt.

### § 15 Streitigkeiten

Bei Meinungsverschiedenheiten über Auslegung oder Anwendung dieser Vereinbarung verhandeln die Parteien zuerst miteinander. Kommt keine Einigung zustande, entscheidet die Einigungsstelle.

### § 16 Inkrafttreten, Kündigung, Nachwirkung

1. Die Vereinbarung tritt am [Datum] in Kraft.
2. Sie kann mit einer Frist von [3] Monaten zum [Monatsende / Quartalsende] gekündigt werden, frühestens zum [Datum].
3. Bis zum Abschluss einer neuen Vereinbarung wirkt sie nach.
4. Sind einzelne Regelungen unwirksam, bleiben die übrigen wirksam.

[Ort, Datum] · [Unterschrift Arbeitgeber] · [Unterschrift Betriebsrat]

---

### Anlage 1: Auswertungen

| Auswertung | Zweck | Verdichtung | Rollen |
| --- | --- | --- | --- |
| [Auswertung] | [Zweck] | [Verdichtung mit Mindestgruppe] | [Rollen laut Schnittstelle] |

### Anlage 2: KI-Funktionen

Aktive KI-Funktionen:

| KI-Funktion | Anbieter und Modell | Hosting | erhält | Websuche |
| --- | --- | --- | --- | --- |
| [KI-Funktion] ([Ideentypen]) | [Anbieter, Modell] | [Hosting] | [erhaltene Daten] | ja, anonymisiert |

Abgeschaltete KI-Funktionen:

- [abgeschaltete KI-Funktion]

Kostenlimit: [Limit je Idee] € je Idee, [Limit je Monat] € je Monat.

### Anlage 3: Schnittstellen und Auftragsverarbeitung

Externe KI-Anbieter mit aktiven Funktionen:

- [externer Anbieter] ([Region])

[Firmen-Login, Microsoft Teams, Jira, ServiceNow und weitere Schnittstellen eintragen; Auftragsverarbeitungsvertrag und Unterauftragnehmer beifügen.]

### Anlage 4: Rollen und Rechte

Erzeugt aus der Rechteprüfung des Systems. Zusätzlich zu den Rollen gelten Rechte aus der Beziehung zu einer Idee:

- [Rechte aus der Beziehung zu einer Idee]

| Rolle | Rechte laut System | Schnittstellen mit Rollenbindung |
| --- | --- | --- |
| [Rolle] | [Rechte laut Rechtetabelle] | [Anzahl] |

Die Rollen Triage, Gremium und Bereichsleitung können für einzelne Bereiche vergeben werden. Sie gelten dann nur für die Ideen des Bereichs (Board, Aufgaben, Fristen, Benachrichtigungen, Dashboard und Entscheidungen). Eine Idee gehört zu einem Bereich über ihr Themenfeld oder die Organisationseinheit der einreichenden Person. (Abschnitt erscheint nur, wenn Bereiche angelegt sind.)

| Bereich | Zuordnung | Rollen mit Bereich |
| --- | --- | --- |
| [Bereich] | [Themenfelder; Einheiten] | [Rolle: Anzahl Personen] |

### Anlage 5: Protokolle und Löschfristen

| Protokoll | Inhalt | Löschfrist |
| --- | --- | --- |
| [Protokoll] | [Inhalt] | [Löschfrist] |

---

### Anlage 6: Platzhalter und Einstellungen

Erzeugt von `server/src/services/codetermination.ts` (Funktion `agreementVars`). Einstellungen unter Einstellungen › Prozess und Datenschutz, Einstellungen › KI und auf der Seite Mitbestimmung (Angaben für die Vereinbarungen).

| Platzhalter | Stelle | Quelle im Produkt | Voreinstellung |
| --- | --- | --- | --- |
| Arbeitgeber, Betriebsrat, Geltungsbereich | Kopf, § 1 | Mitbestimmung › Angaben (`codetermination.employer`, `.worksCouncil`, `.scope`) | leer, bleibt Platzhalter |
| Frist erste Antwort | Präambel | `deadlines.gate1Workdays` | 10 Arbeitstage |
| Rollen und Rechte | § 4, Anlage 4 | Rechtetabelle `PERMISSIONS` (`server/src/lib/context.ts`) und Rollenbindung jeder Schnittstelle (Routenregister in `server/src/http.ts`) | aus dem Code |
| Rollen mit Bereich | Anlage 4 | Bereiche (Einstellungen › Bereiche, Tabelle `areas`) mit Zuordnung und Anzahl aktiver Personen je Rolle (`role_assignments`, `scopedRolesOverview` in `server/src/services/areas.ts`) | keine Bereiche, Abschnitt entfällt |
| Mindestgruppe für Auswertungen | § 6, Anlage 1 | `minGroupSize` | 5 |
| Crowd-Bewertung in Challenges | § 6 Nr. 4 | `challenges.crowdRating` | an |
| Auswertungen mit Zweck, Verdichtung und Rollen | Anlage 1 | Liste `REPORTS` mit der Rollenbindung der jeweiligen Schnittstelle | aus dem Code |
| KI ganz an oder aus | § 7 Nr. 1, Anlage 2 | `ai.enabled` | an |
| Aktive und abgeschaltete KI-Funktionen | Anlage 2 | Schalter je Funktion `ai.agents.<funktion>.enabled` (Seite Mitbestimmung) und Bausteine je Ideentyp `ai.ideaTypes` | alle an außer Patente |
| Anbieter, Modell, Hosting je KI-Funktion | Anlage 2 | `ai.providers`, `ai.models`, `ai.agents.<funktion>.model` | eingebauter Anbieter, eigene Infrastruktur |
| Daten, die eine KI-Funktion erhält | Anlage 2 | Textkatalog `codet.agentData.<funktion>` | – |
| Modell für vertrauliche Inhalte | § 7 Nr. 3 | `ai.models.confidential` (muss eigene Infrastruktur sein) | eingebauter Anbieter |
| Websuche, Websuche für interne Ideen | § 7 Nr. 4 | `ai.search.kind`, `ai.ideaTypes.internal.shortWebSearch` | keine Websuche; intern aus |
| Kostenlimit | Anlage 2 | `ai.budget.perIdeaEur`, `ai.budget.perMonthEur` | 5 €, 200 € |
| Externe KI-Anbieter | Anlage 3 | Anbieter mit Hosting „EU“ oder „andere“, die eine aktive Funktion nutzt | keine |
| Löschfrist abgeschlossene Ideen | § 8, Anlage 5 | `retention.closedIdeasMonths` (0 = keine automatische Löschung) | 24 Monate |
| Löschfrist Benachrichtigungen | § 8, Anlage 5 | `retention.notificationsMonths` | 12 Monate |
| Anonymisierung deaktivierter Konten | § 8 | `retention.anonymizeDeactivatedAfterDays` | 30 Tage |
| Löschfrist KI-Protokoll und KI-Ergebnisse | § 8, Anlage 5 | `retention.aiActionsMonths` | 24 Monate |
| Protokolle mit Inhalt und Frist | Anlage 5 | Liste `PROTOCOLS` | aus dem Code |
| Ankündigungsfrist für Änderungen | § 11 | `codetermination.announceWeeks` | 4 Wochen |
| Einspruchsstelle und Einspruchsfrist | § 14 | `codetermination.objectionBody`, `codetermination.objectionWeeks` | leer, 2 Wochen |
| Pilotbereich und Dauer | Anlage 8 | `codetermination.pilotArea`, `codetermination.pilotMonths` | leer, 6 Monate |
| Rolle „Betriebsrat (lesend)“ | § 4, § 13 | Rolle `works_council` | – |
| Vorlagenversion, Erzeugungsdatum, Arbeitsbereich | Kopf | erste Zeile der Vorlage, Tagesdatum des Arbeitsbereichs, Name des Arbeitsbereichs | – |

### Anlage 7: Muster Datenschutz-Nachweis

Beispiel-PDF eines Datenschutz-Nachweises je Idee: Seite KI-Nachweise (`/ki-nachweise`), Schaltfläche „PDF“.

### Anlage 8: Duldungsvereinbarung für den Pilot

Zweite Vorlage, im Produkt auf der Seite Mitbestimmung als PDF und Markdown. Text der Vorlage:

### Duldungsvereinbarung für den Pilotbetrieb des Ideenportals

> **Entwurf, keine Rechtsberatung, anwaltliche Prüfung offen.** Vorlage [Vorlagenversion], erzeugt am [Datum der Erzeugung] aus den Einstellungen des Arbeitsbereichs „[Arbeitsbereich]“. Die Vereinbarung regelt nur den befristeten Pilot bis zum Abschluss der Betriebsvereinbarung. Werte in eckigen Klammern sind noch festzulegen.

zwischen

**[Name des Arbeitgebers]** – nachfolgend „Arbeitgeber“ –

und

**dem Betriebsrat [Name]** – nachfolgend „Betriebsrat“ –

#### § 1 Gegenstand und Befristung

1. Der Betriebsrat duldet den Pilotbetrieb des Ideenportals im Bereich [Pilotbereich] für höchstens [Dauer des Pilots in Monaten, Voreinstellung 6] Monate ab [Startdatum].
2. Die Duldung ist keine Zustimmung zur dauerhaften Einführung und kein Verzicht auf Mitbestimmungsrechte. Sie präjudiziert die Betriebsvereinbarung nicht.
3. Der Pilot endet automatisch mit Fristablauf oder mit Abschluss der Betriebsvereinbarung. Eine Verlängerung bedarf der schriftlichen Zustimmung des Betriebsrats.

#### § 2 Grundsätze im Pilot

1. Daten aus dem Pilot werden nicht zur Leistungs- oder Verhaltenskontrolle und nicht für arbeitsrechtliche Maßnahmen genutzt.
2. Auswertungen über Personengruppen erfolgen nur aggregiert und erst ab [Mindestgruppe, Voreinstellung 5] Personen je Gruppe.
3. KI bewertet keine Personen und entscheidet nichts. Vertrauliche Ideen und mögliche Meldungen gehen nur an das Modell für vertrauliche Inhalte ([Anbieter für vertrauliche Inhalte], [Hosting]).
4. Die Teilnahme ist freiwillig. Teilnehmende werden vor dem Start über Zweck, KI-Funktionen und ihre Rechte informiert.

#### § 3 KI-Funktionen im Pilot

Im Pilot sind diese KI-Funktionen aktiv:

- [KI-Funktion]: [Anbieter, Modell] ([Hosting])

Abgeschaltet sind: [abgeschaltete KI-Funktionen].

Weitere KI-Funktionen werden im Pilot nur nach Zustimmung des Betriebsrats eingeschaltet.

#### § 4 Kontrolle und Änderungen

1. Mindestens ein Mitglied des Betriebsrats erhält die Rolle „Betriebsrat (lesend)“. Damit sieht es Rollen und Rechte, Auswertungen, KI-Funktionen, Löschfristen, Protokolle, KI-Nachweise und den Änderungsverlauf der Einstellungen.
2. Änderungen an Rollen, Auswertungen, KI-Funktionen oder Löschfristen kündigt der Arbeitgeber mindestens [Ankündigungsfrist in Wochen, Voreinstellung 4] Wochen vorher an; im Pilot werden sie erst nach Zustimmung des Betriebsrats aktiviert.

#### § 5 Daten nach Ende des Pilots

1. Es gelten die eingestellten Löschfristen: [Löschfristen laut Einstellung].
2. Kommt keine Betriebsvereinbarung zustande, werden die Pilotdaten innerhalb von [3] Monaten nach Pilotende gelöscht oder anonymisiert. Kommt sie zustande, gelten ihre Regeln.

#### § 6 Evaluation

1. Arbeitgeber und Betriebsrat werten den Pilot spätestens [4] Wochen vor Ende gemeinsam aus: Antwortzeiten, Zufriedenheit der Teilnehmenden, Erfahrungen mit den KI-Funktionen, Einhaltung dieser Vereinbarung.
2. Die Auswertung ist Grundlage für die Verhandlung der Betriebsvereinbarung.

#### § 7 Einspruch

Teilnehmende können gegen Entscheidungen über ihre Ideen innerhalb von [Einspruchsfrist in Wochen, Voreinstellung 2] Wochen Einspruch einlegen bei [Stelle].

#### § 8 Kündigung

Der Betriebsrat kann die Duldung bei einem Verstoß gegen diese Vereinbarung mit sofortiger Wirkung schriftlich beenden. Der Pilot wird dann eingestellt.

[Ort, Datum] · [Unterschrift Arbeitgeber] · [Unterschrift Betriebsrat]

## Offene Punkte

- **Anwaltliche Prüfung beider Vorlagen (PO, offen).** Exit-Kriterium von Phase 3; Fassung für Gesamt- und Konzernbetriebsrat. Nach der Prüfung Version der Vorlagen erhöhen.
- Löschfrist für das Audit-Log und für umgesetzte Ideen: im Produkt bisher nicht einstellbar, im Text als Platzhalter (§ 8). Entscheidung: im Produkt einstellbar machen oder in der Vereinbarung fest regeln.
- Einspruchsverfahren (§ 14): Das Produkt füllt Stelle und Frist, bildet den Einspruch aber noch nicht als Ablauf ab. Für das Modul Vorschlagswesen ist der Einspruch Teil von R3-35.
- Zugriffsprotokoll für Lesezugriffe auf Ideen: nicht umgesetzt; protokolliert werden Änderungen und Abrufe des Audit-Logs.
- Variante für das Modul Vorschlagswesen (§ 9 Variante B) nach der Segmententscheidung (`interviewleitfaden-vorschlagswesen.md`) ausarbeiten.
- Englische Fassung: Die Vorlagen sind deutsch, weil die Vereinbarung nach deutschem Recht geschlossen wird; die Oberfläche weist darauf hin.
