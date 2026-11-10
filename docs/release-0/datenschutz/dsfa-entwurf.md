# Datenschutz-Folgenabschätzung (Entwurf)

Stand 13.10.2026 · Release 0, abgeglichen mit R3-12 (AP-15) · Entwurf nach Art. 35 DSGVO

> **Hinweis:** Dieses Dokument ist keine Rechtsberatung. Es ist ein Arbeitsentwurf und muss von der bzw. dem Datenschutzbeauftragten und bei SaaS-Kunden vom jeweiligen Verantwortlichen geprüft und angepasst werden.

## 1 Anlass und Abgrenzung

Eine DSFA ist erforderlich, wenn eine Verarbeitung voraussichtlich ein hohes Risiko für Rechte und Freiheiten natürlicher Personen hat. Für das Ideenportal sprechen dafür: Beschäftigtendaten, Einsatz neuer Technologien (KI-Analysen ab Release 2), mögliche Rückschlüsse auf Leistung und Verhalten über Dashboards. Die DSFA wird vor Release 2 abgeschlossen (Umsetzungskonzept Abschnitt 5).

| Rolle | Intern | SaaS |
| --- | --- | --- |
| Verantwortlicher | eigenes Unternehmen | Kunde |
| Auftragsverarbeiter | – (Betrieb durch eigene IT) bzw. Hoster | Betreiber des Ideenportals |
| Unterauftragsverarbeiter | Hoster, Mail, ggf. KI- und Suchanbieter | dito, Liste in `rechtsgrundlagen.md` |

**Offen (Product Owner):** Namen der bzw. des Datenschutzbeauftragten intern und Termin für die Prüfung.

## 2 Systematische Beschreibung

| Bereich | Beschreibung |
| --- | --- |
| Zweck | Ideen sammeln, in Fristen beantworten, ausarbeiten, entscheiden, umsetzen und Nutzen belegen; Wettbewerbs- und Marktanalyse je Idee (ab Release 2) |
| Betroffene | Beschäftigte (Ideengebende, Kommentierende, Paten, Triage, Gremium, Owner, Admins); ab Release 3 externe Einreichende (Kunden, Partner) |
| Daten | Konto (Name, E-Mail, Organisationseinheit, Rollen, Sicherheitsdaten), Ideen und Kommentare (frei formulierte Texte, Anhänge), Entscheidungen, Zufriedenheitswerte, Abwesenheiten mit Vertretung, Protokolle, KI-Analysen |
| Besondere Kategorien (Art. 9) | nicht vorgesehen; können in Freitexten vorkommen (z. B. Gesundheit in einer Arbeitsplatz-Idee). Hinweis im Formular; Löschung durch Triage möglich |
| Empfänger | berechtigte Rollen im Mandanten; Mail-Dienst; KI- und Suchanbieter nur nach Konfiguration (siehe `../../adr/datenfluss.md`) |
| Speicherorte | PostgreSQL in der EU (Render Frankfurt) oder interne VM |
| Speicherdauer | konfigurierbar: abgeschlossene Ideen 24 Monate, Benachrichtigungen 12 Monate, deaktivierte Konten nach 30 Tagen anonymisiert, KI-Protokolle 24 Monate (`settings.retention`) |
| Technik | Web-App, Row-Level-Security je Mandant, MFA, Audit-Log, KI-Gateway mit Protokoll |

### Verarbeitungen mit KI (Release 2)

| Funktion | Eingabe | Ausgabe | Personenbezug |
| --- | --- | --- | --- |
| Kurzanalyse, Vollanalyse | Ideentext ohne Namen | Wettbewerb, Markt, Business Case als Entwurf | gering; Ideentext kann Personen nennen |
| Triage-Vorschlag | Ideentext, Kurzanalyse | Spur und Themenfeld mit Begründung | Bezug zur Idee, nicht zur Person |
| Rückmeldungsentwurf | Entscheidung, Begründung | Text an Ideengebende | adressiert eine Person, bewertet sie nicht |
| Abgrenzung | Text beim Absenden | Kategorie (Meldung, Störung, Beschwerde, Sicherheit) | potenziell sehr sensibel → nur lokal |
| Diskussionszusammenfassung | Kommentare | Konsens, Einwände | Kommentierende sind erkennbar → keine Aussagen über Personen |
| Quellenprüfung mit Seitenabruf (R2-46) | Adresse eines Websuchtreffers (höchstens 5 je Analyse) | Seite erreichbar, Zitat gefunden; Auszug nur im Prompt | keiner in der Anfrage; die Webseite sieht die IP-Adresse des Servers, nicht die der Nutzenden |
| Prüfstatus, Bewertung „hilfreich?“, Aufklappquote, Stichprobe (R2-44, R2-46) | Klick der Person | Status mit Person und Datum; Bewertung je Person nur zur Vermeidung doppelter Stimmen gespeichert; Aufklappen ohne Person | gering; Auswertung nur zusammengefasst ab 5, nie je Person |

## 3 Notwendigkeit und Verhältnismäßigkeit

| Grundsatz | Umsetzung |
| --- | --- |
| Zweckbindung | Daten nur für den Ideenprozess; keine Leistungs- oder Verhaltenskontrolle; kein Training von Modellen mit Kundendaten |
| Datenminimierung | Pflichtfelder nur Name und E-Mail; Organisationseinheit optional; anonyme Einreichung gegenüber der Community (R1-14); Websuche ohne Personen- und Firmenbezug (R2-14) |
| Richtigkeit | Personen pflegen eigene Daten unter „Mein Konto“; KI-Aussagen korrigierbar (R2-15) |
| Speicherbegrenzung | Löschfristen je Mandant (R1-40), Löschjob alle 15 Minuten |
| Transparenz | Datenschutzhinweis je Mandant (R1-41), KI-Kennzeichnung (R2-11), FAQ |
| Betroffenenrechte | Auskunft und Export je Person (selbst und durch Admin), Anonymisierung, Berichtigung |
| Notwendigkeit KI | Ohne KI ist die Analyse je Idee zu aufwendig (Ausgangswert K8); KI ist je Mandant und je Funktion abschaltbar |

## 4 Risiken für Betroffene

| Nr. | Risiko | Ursache | Eintritt | Schwere | Bewertung |
| --- | --- | --- | --- | --- | --- |
| R1 | Leistungs- und Verhaltenskontrolle von Beschäftigten | Dashboards nach Person, Auswertung von Beteiligung | mittel | hoch | hoch |
| R2 | Bewertung von Personen durch KI | Modell urteilt über Ideengebende, Prompt-Injection | mittel | hoch | hoch |
| R3 | Offenlegung vertraulicher Ideen oder Meldungen an Dritte | KI- oder Suchanbieter, Mail-Betreff | mittel | hoch | hoch |
| R4 | Datenleck zwischen Mandanten | Programmierfehler | niedrig | hoch | mittel |
| R5 | Rückschluss auf anonyme Ideengebende | kleine Gruppen, Schreibstil, Metadaten | mittel | mittel | mittel |
| R6 | Nachteile durch abgelehnte Ideen | Ablehnung wird als Leistungsbewertung gelesen | niedrig | mittel | niedrig |
| R7 | Fehlgeleitete Meldungen nach HinSchG | Portal wird als Meldekanal genutzt | mittel | hoch | hoch |
| R8 | Zu lange Speicherung | fehlende Löschung, KI-Protokolle | mittel | mittel | mittel |
| R9 | Drittlandübermittlung | KI-Anbieter mit Sitz außerhalb der EU | mittel | mittel | mittel |
| R10 | Kontoübernahme | schwache Passwörter, kein MFA | mittel | mittel | mittel |

## 5 Maßnahmen

| Risiko | Maßnahmen | Story / Code | Restrisiko |
| --- | --- | --- | --- |
| R1 | Auswertungen nur aggregiert und erst ab 5 Personen (`minGroupSize`, Minimum 5 im Schema); keine Ranglisten von Personen (einzige Ausnahme: Rangliste je Challenge nur mit Einwilligung der Person, Abschnitt 6b); keine personenbezogenen Leistungsauswertungen; Leserolle „Betriebsrat (lesend)“ mit Mitbestimmungsübersicht: alle Auswertungen mit Zweck, Verdichtung und berechtigten Rollen, Rollen und Rechte erzeugt aus der Rechteprüfung des Servers; die drei personenbezogenen Auswertungen (Auslastung eines Paten bei der Zuweisung, Audit-Log, KI-Protokoll) sind mit Zweck benannt und nur für Triage bzw. Admin | R1-37, R1-41, R3-12 | niedrig |
| R2 | Regel „keine Bewertung von Personen“ in Prompts und Ausgabeprüfung; KI entscheidet und lehnt nie ab; Testsatz mit verbotenen Formulierungen; Mitstreiter-Finder bewusst geparkt | R2-12, R2-13, ADR 0004 | niedrig |
| R3 | Vertrauliche Ideen und erkannte Meldungen nur an Anbieter mit `hosting: local`; nie Websuche und nie Seitenabruf; Anonymisierung von Suchanfragen (auch Namensteile); Seitenabruf nur mit der Adresse des Treffers, ohne Ideentext; Websuche je Ideentyp abschaltbar (Standard: interne Ideen ohne Websuche in der Kurzanalyse); Betreff vertraulicher Ideen nur mit Nummer; Datenschutz-Nachweis je Idee macht jede Übermittlung prüfbar | R2-14, R2-20, R1-45, R2-42, R2-45, R2-46, ADR 0004/0005 | niedrig |
| R4 | Row-Level-Security, Test mit zwei Mandanten, Code-Regel für neue Tabellen | R1-03 | niedrig |
| R5 | Anonym nur gegenüber der Community; Triage sieht Namen; Hinweis im Formular; Gruppen unter 5 zusammengefasst | R1-14 | mittel |
| R6 | Wertschätzende Textvorlagen; Ablehnung mit Begründung und Gesprächsangebot; keine Speicherung in Personalakten | R1-24, `../ux/textvorlagen.md` | niedrig |
| R7 | Pflicht-Bestätigung „Idee, keine Meldung“; lokale Begriffserkennung; Link zur Meldestelle; bei Abbruch nichts gespeichert; Triage kann löschen | R1-18, R1-28 | mittel |
| R8 | Löschfristen je Mandant inkl. KI-Protokolle (`retention.aiActionsMonths`), Anonymisierung deaktivierter Konten; alle Fristen und Protokolle mit ihrer Frist in der Mitbestimmungsübersicht und in Anlage 5 der erzeugten Betriebsvereinbarung. Offen: Audit-Log und umgesetzte Ideen ohne automatische Löschung (Muster-BV § 8) | R1-40, R2-10, R3-12 | niedrig |
| R9 | Standard ohne externe KI (`builtin`); EU-Anbieter bevorzugt; bei US-Anbietern Angemessenheitsbeschluss bzw. Standardvertragsklauseln prüfen; Kunde wählt selbst | R2-09, R3-08 | mittel |
| R10 | scrypt, Sperre, MFA-Pflicht für Admins, Rate-Limits je IP und Konto, TOTP-Geheimnis verschlüsselt | R1-09, R1-44, R1-45, ADR 0002 | niedrig |

## 6 KI-spezifische Prüfpunkte

- **Keine automatisierte Einzelentscheidung (Art. 22 DSGVO):** Alle Entscheidungen an Gates treffen Menschen; KI-Ergebnisse sind Entwürfe.
- **EU-KI-Verordnung:** Systeme zur Bewertung von Beschäftigten können als Hochrisiko gelten. Das Portal bewertet Ideen, nicht Personen; diese Abgrenzung ist zu dokumentieren und vor dem Marktstart rechtlich zu prüfen. Kennzeichnung von KI-Inhalten ist umgesetzt (R2-11).
- **Protokoll und Nachvollziehbarkeit:** jede KI-Aktion in `ai_actions` mit Eingabe, Modell, Hosting, Quellen, Freigabe.
- **Datenschutz-Nachweis (R2-42):** Je Idee zeigt ein Nachweis (Seite und PDF), welcher Dienst in welcher Region mit welchem Modell welche Daten erhielt, welche Suchanfragen gesendet wurden und was es kostete. Der Nachweis enthält keine Eingaben, Antworten oder Ideentexte, bei vertraulichen Ideen nicht einmal den Titel. Der Betriebsrat sieht ihn über die Leserolle „Betriebsrat“, ohne die Analysen selbst lesen zu können.
- **Qualität:** Kein Agent geht ohne bestandenen Testsatz live (R2-12). Im Einsatz prüft das Gateway Quellen (R2-46), Paten setzen je Baustein einen Prüfstatus (R2-44), eine monatliche Stichprobe wird von Paten bewertet.
- **Seitenabruf (R2-46, Ergänzung AP-08):** Für höchstens 5 Treffer je Analyse ruft der Server die Trefferseite ab. Übermittelt wird nur die Adresse aus der Trefferliste (HTTP-GET ohne Cookies und ohne Ideentext); die Betreiber der Seiten erfahren die IP-Adresse des Servers und den Zeitpunkt, nicht die Person oder die Idee. Nur öffentliche http/https-Adressen, nie das interne Netz (Schutz vor SSRF), Zeitlimit und Längenbegrenzung. Der Seitentext ist nicht vertrauenswürdig: Er geht nur eingezäunt und bereinigt an das Modell und wird nicht gespeichert; gespeichert wird nur das Prüfergebnis. Vertrauliche Ideen und mögliche Meldungen: kein Abruf. Jeder Abruf steht im KI-Protokoll und im Datenschutz-Nachweis. Je Mandant abschaltbar, für die Instanz mit `AI_PAGE_FETCH=false`. Restrisiko: Aus der Abfolge abgerufener Seiten könnte ein Seitenbetreiber auf ein Thema schließen, das im Unternehmen bearbeitet wird; das entspricht dem Risiko der Suchanfrage selbst und ist durch die Anonymisierung der Anfrage begrenzt.
- **Bewertungen ohne Personenbezug in der Auswertung (R2-44):** Die Bewertung „hilfreich?“ wird je Person gespeichert, damit jede Person einmal zählt; ausgewertet und angezeigt wird sie nur zusammengefasst je Baustein und erst ab der Mindestgruppengröße (5). Das Aufklappen von KI-Bausteinen wird ohne Person und ohne Idee gezählt. Der Prüfstatus nennt Person und Datum, weil das Gremium wissen muss, wer einen Baustein geprüft hat; er bewertet die Analyse, nicht die Person.
- **Abschaltbar (R3-12, umgesetzt):** KI je Mandant (Einstellungen › KI) und je Funktion abschaltbar. Die Seite Mitbestimmung zeigt jede KI-Funktion mit Zustand, Anbieter, Modell, Hosting-Region, erhaltenen Daten und Websuche; Admins schalten dort jede Funktion einzeln, das Gateway lehnt abgeschaltete Funktionen ab. Jede Schaltung steht im Audit-Log (`codetermination.ai_function`) und im Änderungsverlauf, den der Betriebsrat liest. Der Betriebsrat kann so einzelne Funktionen ablehnen, ohne die übrigen zu verlieren.

## 6a Abgleich mit der Muster-Betriebsvereinbarung (AP-15)

Die Muster-Betriebsvereinbarung (`../business/muster-betriebsvereinbarung.md`) wird im Produkt aus den Einstellungen erzeugt (R3-12). DSFA und Vereinbarung beschreiben dieselben Maßnahmen:

| Risiko | Regelung in der Muster-BV | Im Produkt geprüft durch |
| --- | --- | --- |
| R1 Leistungs- und Verhaltenskontrolle | § 2, § 3 Nr. 1–2, § 6 mit Anlage 1 (alle Auswertungen mit Verdichtung und Rollen), § 4 mit Anlage 4 (Rollen und Rechte aus dem Code) | Mitbestimmungsübersicht, Test `codetermination.test.ts` |
| R2 Bewertung von Personen durch KI | § 3 Nr. 3–4, § 7 Nr. 7 | Testsatz (R2-12), Ausgabeprüfung |
| R3 Offenlegung vertraulicher Ideen | § 7 Nr. 3–5 (Modell für vertrauliche Inhalte, Websuche, Datenschutz-Nachweis) | Gateway, KI-Nachweise |
| R5 Rückschluss auf anonyme Ideengebende | § 5 Nr. 2, § 6 Nr. 1 | Mindestgruppe |
| R7 Fehlgeleitete Meldungen | § 3 Nr. 7 | Abgrenzungsprüfung (R1-18) |
| R8 Zu lange Speicherung | § 8 und Anlage 5 (Fristen aus den Einstellungen) | Löschjob, Mitbestimmungsübersicht |
| R9 Drittlandübermittlung | § 7 Nr. 1 und 6, Anlage 2 (Hosting-Region je Funktion), Anlage 3 (externe Anbieter) | Seite Mitbestimmung, KI-Nachweise |
| Änderungen am System | § 11 (Ankündigungsfrist aus den Einstellungen), § 13 (Änderungsverlauf) | Audit-Log, Änderungsverlauf |
| Rechte der Beschäftigten | § 14 (Einspruchsstelle und Frist aus den Einstellungen) | – (Einspruch als Ablauf noch nicht abgebildet) |

Für den Pilot gilt die Duldungsvereinbarung (Anlage 8 der Muster-BV) mit denselben Grundsätzen, Befristung und gemeinsamer Evaluation. Abweichungen zwischen DSFA und Vereinbarung: keine bekannt. Offen bleibt die anwaltliche Prüfung beider Vorlagen.

## 6b Gamification, Fragen an das Portfolio, Übersetzung und öffentliche Benchmark (AP-24)

**Rangliste je Challenge (R2-53).** Punkte für Einreichen, Kommentieren und Bewerten und Abzeichen sind eine Verarbeitung von Beteiligungsdaten je Person und berühren R1 (Leistungs- und Verhaltenskontrolle). Maßnahmen:

- Punkte werden nicht gespeichert, sondern bei jedem Aufruf aus Ideen, Kommentaren und Bewertungen **einer** Challenge berechnet; es gibt keine Summe über Challenges und keine Historie.
- Die eigenen Punkte sieht nur die Person selbst. In der Rangliste erscheint nur, wer für diese Challenge ausdrücklich zugestimmt hat (Einwilligung nach Art. 6 Abs. 1 lit. a und § 26 Abs. 2 BDSG, Tabelle `gamification_consents`); der Widerruf wirkt sofort. Die Rangliste zeigt Name, Punkte und Abzeichen, keine Kennungen und keine E-Mail-Adressen.
- Anonyme und vertrauliche Ideen bringen keine Punkte (auch Kommentare der Autorin unter der eigenen anonymen Idee nicht), damit die Rangliste die Urheberschaft nicht verrät (R5).
- Nie im Dashboard, kein Export je Person, keine Schnittstelle über mehrere Challenges. Die Rangliste steht als Auswertung mit Verdichtung „nur Personen mit Einwilligung“ in der Mitbestimmungsübersicht (`REPORTS`, Schlüssel `leaderboard`) und damit in Anlage 1 der erzeugten Betriebsvereinbarung.
- Admins schalten je Challenge Punkte und Abzeichen und getrennt die Rangliste ab; das Abschalten löscht alle Zustimmungen der Challenge (Audit `gamification.switch`, Zustimmungen als `gamification.consent`/`gamification.revoke` ohne weitere Inhalte).
- Restrisiko: Wer zustimmt, macht seine Beteiligung in dieser Challenge sichtbar; Gruppendruck zur Zustimmung ist organisatorisch zu vermeiden (Hinweis in der Kommunikation, Regelung in der Betriebsvereinbarung). Bewertung: niedrig.

**Fragen an das Portfolio (R3-23).** An das Modell gehen nur die Frage, die Themenfelder und die Titel der Challenges, keine Ideeninhalte; die Antwort ist ein Filter aus einer festen Liste von Feldern (Status, Themenfeld, Ideentyp, Challenge, Zeitraum, Nutzen, Suchbegriff, Sortierung). Ein Feld für Personen gibt es nicht; Fragen nach Personen werden ohne diesen Teil beantwortet und mit Hinweis gekennzeichnet. Die Liste läuft mit den Leserechten der fragenden Person (Row-Level-Security und Sichtbarkeitsregel), enthält keine Namen und gruppiert nie nach Personen. Jede Frage steht im KI-Protokoll.

**Übersetzung (R3-30).** Übersetzt wird nur auf Knopfdruck und nur, was die Person lesen darf. Vertrauliche Ideen und ihre Kommentare gehen nur an ein Modell mit `hosting: local`; ohne ein solches Modell lehnt das Portal ab. Die Übersetzung wird je Text und Zielsprache gespeichert (`translations`, mit der Idee bzw. dem Kommentar gelöscht) und steht im KI-Protokoll; das Original bleibt maßgeblich.

**Öffentliche Benchmark (R3-40).** Ein Arbeitsbereich nimmt nur mit Zustimmung der Administration teil (Einstellung `benchmark.share`, Standard aus). Je abgeschlossenem Quartal berechnet der Job vier Kennzahlen je teilnehmendem Arbeitsbereich (Fristtreue, Durchlaufzeit bis Gate 1, Realisierungsquote, KI-Korrekturrate) und speichert nur den gerundeten Durchschnitt über alle teilnehmenden Arbeitsbereiche (Plattformtabelle `benchmark_snapshots` ohne Mandantenbezug, für die App-Rolle gesperrt). Eine Kennzahl erscheint erst, wenn mindestens 5 Arbeitsbereiche mit mindestens 3 Fällen beitragen; keine Spannweite, kein Median über Arbeitsbereiche (er wäre der Wert eines einzelnen Kunden), Zahl der Arbeitsbereiche auf ein Vielfaches von 5 abgerundet, ein Schnappschuss je Quartal, der nicht neu berechnet wird. Personenbezogene Daten enthält die Benchmark nicht; Beschäftigte sind nicht betroffen. Restrisiko: Ein Anbieter mit genau 5 teilnehmenden Kunden, von denen 4 einander ihre Werte offenlegen, könnte den fünften Wert errechnen; die Rundung begrenzt das. Bewertung: niedrig.

## 6c Externe Beteiligung, Moderation und Feature-Wünsche (AP-21)

**Neue Betroffenengruppe.** Mit R3-19 reichen Kundinnen, Kunden und Partner (Externe) Ideen zu einzelnen Challenges ein. Verarbeitet werden Name, E-Mail-Adresse, Passwort-Hash, Sprache, Zugang je Challenge (Portal-Link oder Einladung), eingereichte Ideen, Antworten auf Rückfragen, Meldungen, Stimmen für Feature-Wünsche und das Protokoll der Zustimmungen. Rechtsgrundlage für das Konto und die Bearbeitung der Ideen ist Art. 6 Abs. 1 lit. b DSGVO (Nutzungsverhältnis nach den Nutzungsbedingungen), für das Protokoll der Zustimmungen Art. 6 Abs. 1 lit. c und f (Nachweis der eingeräumten Rechte). Die Einwilligung zu Nutzungsrechten und Vertraulichkeit je Challenge ist vor allem eine urheber- und vertragsrechtliche Erklärung, keine datenschutzrechtliche Einwilligung. Entwürfe der Texte: `docs/release-0/business/rechtstexte-externe.md` (Entwurf, keine Rechtsberatung).

**Risiken und Maßnahmen.**

| Risiko | Maßnahme im Produkt |
| --- | --- |
| Externe sehen interne Inhalte (Ideen, Kommentare, Namen, Auswertungen, KI-Analysen) | Eigene Rolle `external`; jeder Endpunkt ist für Externe gesperrt, außer den ausdrücklich geöffneten (Start, eigene und freigegebene Ideen, Einreichen, Rückfragen beantworten, Melden, Benachrichtigungen, Sprache, Datenauskunft, Feature-Wünsche). Freigegeben sind nur externe, nicht vertrauliche, von der Moderation freigegebene Ideen derselben Challenge. Benachrichtigungen der Kategorie „Community“ (Kommentare, Unterstützungen mit Namen) erhalten Externe nie. Tests: `server/test/external.test.ts`. |
| Beschäftigte werden gegenüber Externen sichtbar | Externe sehen keine Namen von Beschäftigten: keine Kommentare, keine Personenliste, keine Verlaufseinträge, in Entscheidungen nur Ergebnis und Begründung. |
| Unklare Rechte an Ideen, Streit über Nutzung | Versionierte Texte (Nutzungsbedingungen je Arbeitsbereich, Einwilligung je Challenge); eine neue Fassung muss vor dem nächsten Einreichen angenommen werden; Protokoll „wer, welche Fassung, wann“ (Tabelle `consents`, für die App nur lesen und anfügen) plus Audit-Eintrag. |
| Erfindungen werden durch Veröffentlichung neuheitsschädlich | Hinweis auf die Erfindungsprüfung (R3-25) bei Anmeldung, Zustimmung und Einreichung; Freigabe vor Veröffentlichung als Standard. |
| Spam, Missbrauch, rechtswidrige Inhalte | Freigabe vor Veröffentlichung je Challenge oder Arbeitsbereich, Honeypot-Feld, Höchstzahl Links, Rate-Limits (Anmeldung je IP, Beiträge und Meldungen je Konto, öffentliche Seite je IP), Melden-Funktion mit Moderationsliste. Wer meldet, wird der Moderation nicht angezeigt. |
| Konten Externer bleiben ewig bestehen | Datenauskunft (`/api/me/export`, mit Zustimmungen, Zugängen, Stimmen und Meldungen) und Anonymisierung wie bei internen Konten. Das Zustimmungsprotokoll bleibt als Nachweis erhalten, verweist nach der Anonymisierung aber auf kein erkennbares Konto mehr. Offen: eigene Löschfrist für inaktive externe Konten. |
| Öffentliche Status-Seite verrät Personen | Die Seite zeigt nur Nummer, Titel, Beschreibung, Status, Hinweis des Produktteams und die Zahl der Stimmen; keine Namen, keine E-Mail-Adressen, nur geprüfte Wünsche (nicht Status „neu“). Abschaltbar je Arbeitsbereich. Restrisiko: Externe schreiben personenbezogene Angaben in Titel oder Beschreibung; das Produktteam prüft neue Wünsche vor der Veröffentlichung. |
| Leistungs- und Verhaltenskontrolle über Meldungen und Stimmen | Meldungen und Stimmen werden nicht je Person ausgewertet; die Moderationsliste zeigt keine meldende Person, Feature-Wünsche zeigen keine abstimmenden Personen. |

**KI.** Ideen Externer durchlaufen wie interne Ideen die Kurzanalyse über das KI-Gateway; vertrauliche Ideen nur mit lokalem Modell. Externe sehen keine KI-Ergebnisse. In den Nutzungsbedingungen ist der KI-Einsatz zu nennen (offen im Entwurf, Abschnitt 4).

**Bewertung.** Mit den Maßnahmen niedrig bis mittel. Bedingungen vor dem Einschalten: Texte anwaltlich geprüft, Datenschutzhinweis für Externe ergänzt (Name des Verantwortlichen, Speicherdauer, Empfänger), AV-Vertrag deckt externe Personen ab.

## 6d Erkennen: Problem-Radar, Trendhinweise und Trendradar (AP-27)

**Problem-Radar aus Tickets und Feedback (R4-01).** Neu ist die Verarbeitung von Ticket- und Feedbacktexten aus angebundenen Systemen (Jira, ServiceNow, Azure DevOps) und aus hochgeladenen CSV-Dateien. Diese Texte können Namen, Kontaktdaten und Hinweise auf das Verhalten einzelner Beschäftigter enthalten (R1 Leistungs- und Verhaltenskontrolle) und vereinzelt Inhalte, die in einen Meldekanal gehören.

| Risiko | Maßnahme im Produkt |
| --- | --- |
| Auswertung einzelner Beschäftigter (wer meldet viel, wer bearbeitet langsam) | Personenfelder (Melder, Bearbeiter, Anrufer) werden beim Zielsystem nicht angefragt und beim Einlesen verworfen; die Cluster gruppieren nur nach Inhalt, nie nach Person, Team oder Abteilung (Regel im Prompt, eingebautes Verfahren nur über Begriffe); es gibt keine Kennzahl je Person. |
| Namen und Kontaktdaten Dritter im Freitext | Schwärzung vor der KI: E-Mail, Telefon, Links, @-Erwähnungen, „Reporter: …“, Anreden mit Namen, Namen der Personen des Arbeitsbereichs; gespeicherte Beispiele erneut geschwärzt und auf 240 Zeichen gekürzt. Restrisiko: Namen Externer ohne Anrede bleiben möglich. |
| Inhalte für einen Meldekanal oder vertrauliche Inhalte | Agent `problem_clusters` läuft immer als vertraulich: nur Modell mit eigenem Hosting oder eingebautes Verfahren, nie externe KI-Anbieter. |
| Kleine Gruppen machen Einzelfälle erkennbar | Mindestgröße eines Clusters (Standard 3, einstellbar 2 bis 50); kleinere Gruppen werden verworfen. Für Beschäftigtendaten empfiehlt sich 5 (wie `minGroupSize`). |
| Vorratsdatenhaltung | Rohtickets und CSV-Dateien werden nicht gespeichert, nur Anzahl und Cluster; Abruf nur per Klick, nicht im Hintergrund; nur mit Paket-Merkmal „Konnektoren“ und aktivem Konnektor. |

**Trendhinweise (R4-02) und Trendradar (R4-11).** Suchanfragen entstehen aus dem Namen des Themenfelds (anonymisiert wie bei der Ideenanalyse), es gehen keine Ideen an den Suchanbieter. Die Wochenmail erhalten nur Sponsor:innen eines Themenfelds oder einer laufenden Challenge im Themenfeld; die Kategorie „Trendhinweise“ ist abbestellbar und beendet auch die Erstellung für diese Person. Für die Zuordnung zum Radar sieht die KI Titel und Problem nicht vertraulicher Ideen (wie bei der Kurzanalyse, F5); vertrauliche Ideen, Entwürfe und mögliche Erfindungen nie. Die KI verknüpft nichts selbst; jede Verknüpfung bestätigt ein Mensch. Es gibt keine eigene Signal-Datenbank.

**Weiße Flecken (R4-03).** Nur Mengen je Themenfeld (Ideen, Challenges, Trends), keine Personen.

**Bewertung.** Problem-Radar mit den Maßnahmen niedrig bis mittel; Bedingung vor dem Einsatz mit Beschäftigtendaten: Betriebsrat beteiligen (Zweck, Quellen, Mindestgröße), Mindestgröße 5 einstellen, lokales Modell oder eingebautes Verfahren. Trendhinweise und weiße Flecken niedrig.

## 7 Ergebnis (vorläufig)

Mit den Maßnahmen ist das Restrisiko voraussichtlich **vertretbar**. Bedingungen: Maßnahmen zu R3 und R10 vor dem Einschalten externer KI-Anbieter umgesetzt (Stand AP-04: umgesetzt, Prüfung durch den DSB offen); Dashboard-Grenze von 5 Personen nicht unterschreitbar; Anbieterwahl je Mandant dokumentiert.

**Offen (Product Owner):** Stellungnahme der bzw. des DSB einholen; bei Pilotkunden mit Betriebsrat dessen Beteiligung einplanen.
