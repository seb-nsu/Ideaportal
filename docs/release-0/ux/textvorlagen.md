# Textvorlagen

Stand 12.10.2026 · Release 0 · Entwurf

Vorlagen für Rückmeldungen an Gates, Erinnerungen und KI-Kennzeichnungen. Die IDs werden in `benachrichtigungsmatrix.md` verwendet. Gate-1-Texte sind je Mandant unter Einstellungen > Texte änderbar (`settings.texts`); die Standardtexte aus `server/src/lib/settings.ts` sind unten übernommen und ergänzt.

**Englisch (R3-22):** Alle Vorlagen gibt es auf Englisch in [`textvorlagen.en.md`](textvorlagen.en.md). Maßgeblich ist der Textkatalog (`server/src/i18n/<de|en>/`, `web/src/i18n/<de|en>/`). Mails gehen in der Sprache der Empfängerin, Datumsangaben im Format ihrer Sprache. Ein neuer Arbeitsbereich bekommt Themenfelder, Gate-1-Texte, FAQ, Datenschutzhinweis und Scorecard in der Sprache der Person, die ihn anlegt (`server/src/i18n/<de|en>/defaults.ts`); bestehende Texte bleiben unverändert.

**Grundsätze:** Wir duzen. Kurze Sätze. Jede Rückmeldung dankt, nennt die Entscheidung, begründet sie und sagt, was als Nächstes passiert. Nie über die Person urteilen, nur über die Idee. Platzhalter in `{geschweiften Klammern}`.

## Gate 1: Spur

### `G1-SCHNELL` – Schnellspur

> Danke für deine Idee! Sie ist klein genug, um direkt umgesetzt zu werden. Der Fachbereich übernimmt die Umsetzung, und du wirst über den Fortschritt informiert.
>
> Verantwortlich: {owner} · Zieltermin: {zieltermin}
> {begruendung}

### `G1-AUSARB` – Ausarbeiten

> Danke für deine Idee! Sie hat Potenzial und wird jetzt ausgearbeitet. Anschließend wird an Gate 2 über die Umsetzung entschieden.
>
> Deine Patin bzw. dein Pate: {pate}. Die Ausarbeitung dauert höchstens {timebox} Wochen. Du kannst am Steckbrief mitarbeiten.

### `G1-WEITER` – Weiterleiten

> Danke für dein Anliegen! Es wird an anderer Stelle bearbeitet. Unten findest du, wohin es weitergeleitet wurde und wer dein Ansprechpartner ist.
>
> Zuständig: {kanal} · Kontakt: {kontakt} · {link}
> {begruendung}

### `G1-ABLEHN` – Ablehnen

> Danke für deine Idee! Wir setzen sie nicht um. Die Begründung findest du unten. Gerne erklären wir dir die Entscheidung auch im Gespräch.
>
> Begründung: {begruendung}
> Ansprechperson: {triage_person}. Wenn sich etwas ändert, kannst du die Idee jederzeit neu einreichen.

**Bausteine für Begründungen beim Ablehnen** (Auswahl im Formular, frei ergänzbar):

| Baustein | Text |
| --- | --- |
| Gibt es schon | „Eine ähnliche Lösung gibt es bereits: {verweis}. Magst du dort mitmachen?“ |
| Kein Fit | „Die Idee passt aktuell nicht zu unseren Themenfeldern und Zielen für {jahr}.“ |
| Aufwand zu hoch | „Der Aufwand steht derzeit in keinem guten Verhältnis zum erwarteten Nutzen.“ |
| Rechtlich/regulatorisch | „Rechtliche Vorgaben lassen die Umsetzung so nicht zu. {fachstelle} hat das geprüft.“ |
| Zu unkonkret | „Uns fehlt ein konkretes Problem, an dem wir ansetzen können. Beschreib gern ein Beispiel aus deinem Alltag.“ |

## Gate 2: Entscheidung

| ID | Ergebnis | Text |
| --- | --- | --- |
| `G2-UMSETZEN` | Umsetzen | „Gute Nachricht: Deine Idee wird umgesetzt. Owner ist {owner}, Zieltermin {zieltermin}. Begründung: {begruendung}“ |
| `G2-ERPROBEN` | Erproben | „Deine Idee wird zuerst in einem Experiment erprobt: {hypothese}. Danach entscheiden wir erneut. Owner: {owner}.“ |
| `G2-INTEGRIEREN` | Integrieren | „Deine Idee fließt in das laufende Vorhaben {vorhaben} ein. Ansprechperson: {owner}.“ |
| `G2-PARKEN` | Parken | „Wir parken deine Idee bis {datum}. Dann kommt sie automatisch zurück auf den Tisch. Begründung: {begruendung}“ |
| `G2-ABLEHN` | Ablehnen | „Wir setzen deine Idee nach der Ausarbeitung nicht um. Begründung: {begruendung}. Danke für deine Mitarbeit am Steckbrief – {pate} erklärt dir die Entscheidung gern persönlich.“ |

## Gate 3 und Anerkennung (Release 2)

| ID | Text |
| --- | --- |
| `N-UMGESETZT` | „Deine Idee {titel} ist umgesetzt! Erfasster Nutzen: {nutzen}. Danke, dass du sie eingebracht hast.“ |
| `N-WIRKUNG` | „Der Wirkungsreview für {titel} ist fällig. Bitte vergleiche Plan und Ist bis {datum}.“ |
| `N-ERFOLG` | „Wir möchten deine Idee als Erfolgsgeschichte zeigen. Bitte prüfe den Entwurf und gib ihn frei – oder sag uns, wenn du nicht genannt werden möchtest.“ |

## Aufgaben und Erinnerungen

| ID | Betreff | Text |
| --- | --- | --- |
| `N-NEU` | Neue Idee {nr} {titel} | Eine neue Idee wartet auf die Triage: {nr} {titel}. |
| `N-DELEGIERT` | Idee in deinem Namen eingereicht: … | {person} hat die Idee in deinem Namen eingereicht. Bitte bestätige deine Urheberschaft in der Idee. |
| `N-RUECKFRAGE` | Rückfrage zu deiner Idee … | Das Triage-Team hat eine Rückfrage: {frage} Die Frist ist angehalten, bis du antwortest. |
| `N-ANTWORT` | Antwort auf Rückfrage zu … | {antwort} |
| `N-UEBERGABE` | Übergabe zur Umsetzung: … | Die Idee wurde dir zur direkten Umsetzung übergeben (Zieltermin {datum}). Bitte bestätige die Übernahme. |
| `N-OWNER` | Du bist Owner der Umsetzung … | Entscheidung an Gate 2: {ergebnis}. Bitte pflege Fortschritt und Ist-Nutzen bis {datum}. |
| `N-START` | Umsetzung gestartet: … | {person} hat die Umsetzung deiner Idee übernommen. |
| `N-GESCHLOSSEN` | Idee geschlossen: … | Wir haben 15 Arbeitstage keine Antwort auf die Rückfrage erhalten und die Idee geschlossen. Du kannst sie jederzeit neu einreichen. |
| `N-WIEDERVORLAGE` | Wiedervorlage: … | Die geparkte Idee ist zur Wiedervorlage fällig und wartet auf eine Entscheidung an Gate 2. |
| `N-ZUSAMMEN-Q` / `-Z` | Idee zusammengeführt: … | Deine Idee wurde mit {ziel} zusammengeführt. Du bist dort Co-Autor:in; Kommentare und Unterstützung sind mitgewandert. |
| `N-COAUTOR` | Du bist Co-Autor:in von … | {person} hat dich als Co-Autor:in eingetragen. Du hast dieselben Rechte wie die Ideengeberin bzw. der Ideengeber. |
| `N-KOMMENTAR` | Neuer Kommentar zu … | {person}: {kommentar} |
| `N-UNTERSTUETZT` | Neue Unterstützung für … | {person} unterstützt deine Idee. |
| `E-ERINNERUNG` | Erinnerung: Frist für … | Die Frist endet in {n} Arbeitstag(en) am {datum}. |
| `E-ESKALATION` | Frist überschritten: … | Die Frist ist seit {n} Arbeitstag(en) überschritten (fällig {datum}). Bitte kümmere dich um eine Entscheidung. |
| `E-VERZUG` | Umsetzung im Verzug: … | Der Zieltermin {datum} ist überschritten. Bitte aktualisiere Fortschritt und Zieltermin oder schließe die Umsetzung mit dem Ist-Nutzen ab. |
| `E-TIMEBOX` | Ausarbeitung endet bald: … | Die Timebox für {titel} endet am {datum}. Ist der Steckbrief bereit für Gate 2? |
| `K-EINLADUNG` | Einladung ins Ideenportal | {person} lädt dich in den Arbeitsbereich {name} ein. Leg hier dein Passwort fest: {link} |
| `K-RESET` | Passwort zurücksetzen | Mit diesem Link legst du ein neues Passwort fest. Er gilt 24 Stunden: {link} |

## KI-Kennzeichnungen (Release 2, R2-11)

| ID | Wo | Text / Darstellung |
| --- | --- | --- |
| `KI-BADGE` | über jedem KI-Inhalt | „KI-Entwurf · nicht geprüft“ bzw. „KI-Entwurf · geprüft von {person} am {datum}“ |
| `KI-BELEG` | je Aussage | „Beleg“ + Quelle (Titel, Link) + „abgerufen am {datum}“ |
| `KI-ANNAHME` | je Aussage | „Annahme“ – bitte prüfen |
| `KI-SCHAETZUNG` | je Aussage | „Schätzung · Konfidenz {niedrig/mittel/hoch}“; Zahlen ohne Quelle werden automatisch hierher herabgestuft |
| `KI-VORSCHLAG` | Triage, Gremium | „Vorschlag der KI – die Entscheidung triffst du.“ |
| `KI-LOKAL` | vertrauliche Idee | „Diese Analyse lief nur auf internen Systemen. Es wurde nicht im Web gesucht.“ |
| `KI-PATENT` | Patentrecherche | „Hinweis, keine Freigabe. Schutzrechte prüfen Patentfachleute.“ |
| `KI-AUS` | KI abgeschaltet / Budget erreicht | „Für diese Idee gibt es keine KI-Analyse ({grund}).“ |
| `KI-FERTIG-KURZ` | Benachrichtigung | „Die Kurzanalyse zu {titel} ist fertig.“ |
| `KI-FERTIG-VOLL` | Benachrichtigung | „Der Steckbrief-Entwurf zu {titel} ist fertig. Bitte prüfe die markierten Aussagen.“ |
| `KI-BUDGET` | Admin | „Das KI-Budget für {monat} ist zu {prozent} % verbraucht.“ |
| `KI-QUALITAET` | Admin | „Der Agent {agent} hat den Testsatz nicht bestanden ({wert} < {min}). Er bleibt abgeschaltet.“ |
| `KI-INJECTION` | Admin | „In {anzahl} Texten wurden mögliche versteckte Anweisungen an die KI gefunden. Die KI hat sie nicht ausgeführt.“ |
| `N-PATE` / `N-PATE-IG` | Pate / IG | „Du bist Patin bzw. Pate für {titel}. Timebox bis {datum}.“ / „{pate} begleitet deine Idee bis Gate 2.“ |
| `N-PATE-LAST` | Triage | „{pate} betreut bereits {n} Ideen. Trotzdem zuweisen?“ |
| `N-GREMIUM` | Gremium | „Die Unterlagen für die Sitzung am {datum} sind da ({n} Ideen, ca. 10 Minuten je Idee).“ |
| `E-EXPERIMENT` | Owner | „Das Experiment zu {titel} endet am {datum}. Bitte trage das Ergebnis ein.“ |

## Challenge-Phasen (Release 2, R2-52)

Betreff je Phase: „Challenge „{titel}“: …“. Wortlaut im Katalog unter `challenges.phase.<phase>.subject|sponsor|participants|jury` (`server/src/i18n/de/challenges.ts`).

| ID | Empfänger | Kern der Nachricht |
| --- | --- | --- |
| `CH-SAMMELN` | Sponsor | „Deine Challenge nimmt jetzt Ideen an, bis zum {datum}.“ |
| `CH-BEWERTEN` | Sponsor, IG | „Das Sammeln ist beendet. Bis zum {datum} bewerten alle die Ideen.“ |
| `CH-AUSARBEITEN` | Sponsor, IG | „Die Bewertung ist beendet. Bis zum {datum} werden die Ideen ausgearbeitet.“ |
| `CH-JURY` | Sponsor, Jury, IG | Jury: „Bitte bewerte die Ideen der Challenge bis zum {datum}.“ |
| `CH-ERGEBNIS` | Sponsor, IG | Sponsor: „Veröffentliche jetzt das Ranking und eine Zusammenfassung.“ |

## Challenge-Vorlagen (R2-52, erweitert in AP-22)

Vorlagen füllen eine neue Challenge vor (Einstellungen unter „Challenge starten“ › Vorlage). Wortlaut im Katalog unter `challenges.template.<id>.*` (`server/src/i18n/de/challenges.ts`), Logik in `server/src/services/challenges.ts` (`TEMPLATES`). Zielwert, Bestätigung und Hackathon-Einstellungen pflegt der Sponsor danach auf der Challenge-Seite unter „Zielwert und Hackathon“.

| Vorlage | Titel und Leitfrage (Kern) | Eigene Felder | Crowd-Kriterien | Phasen (Tage) | Zusätzlich |
| --- | --- | --- | --- | --- | --- |
| Ideenwettbewerb | „Welche Idee macht unsere Arbeit oder unsere Angebote besser?“ | – | Nutzen, Machbarkeit, Neuheit | 28 / 10 / 21 / 10 / 14 | Teams erlaubt |
| Nachhaltigkeit (R3-32) | „Wie senken wir Energie-, Material- und Wasserverbrauch oder den CO₂-Ausstoß?“ | Geschätzte CO₂-Einsparung (t pro Jahr), geschätzte Energieeinsparung (kWh pro Jahr) | Umweltwirkung, Machbarkeit, Nutzen | 35 / 10 / 21 / 10 / 14 | Themenfeld „Nachhaltigkeit“, falls vorhanden; Zielwert-Vorschlag CO₂; Wirkung je Nutzenart mit kWh → CO₂ und €; ESG-Export (CSV) |
| Kostensenkung (R3-33) | „Wo können wir Kosten senken, ohne Qualität oder Arbeitsbedingungen zu verschlechtern?“ | Geschätzte Einsparung (€ pro Jahr) | Einsparung, Machbarkeit, geringes Risiko | 28 / 7 / 21 / 7 / 14 | Zielwert-Vorschlag Euro; Controlling bestätigt jeden Ist-Nutzen |
| Hackathon (R3-34) | „Welche Lösung baut ihr als Team in kurzer Zeit?“ | – | Neuheit, Machbarkeit, Nutzen | 2 / 1 / 1 / 1 / 7 | Hackathon-Modus: Einreichfenster mit Sperre, Pitch-Liste, Publikumsvoting, Teamseite, kombinierte Rangliste |

Texte rund um die Einsatzfelder (Katalog `usecases.*`, Server `server/src/i18n/de/usecases.ts`, Oberfläche `web/src/i18n/de/usecases.ts`):

| ID | Empfänger | Kern der Nachricht |
| --- | --- | --- |
| `UC-CHALLENGE` | IG eines Problems | „Danke für dein Problem! Wir suchen die Lösung jetzt gemeinsam in der Challenge „{challenge}“.“ |
| `UC-BESTAETIGT` | Umsetzung | „Ist-Nutzen bestätigt: {wert} {einheit}. Kommentar: …“ bzw. „Ist-Nutzen korrigiert von {alt} auf {wert} …“ |
| `UC-ERFOLG` | Erfolgsgeschichte | „Einsparung, vom Controlling bestätigt: 20.000 kWh pro Jahr (entspricht etwa 7,6 t CO₂ pro Jahr bei 0,38 kg CO₂ je kWh).“ |

**Offen (Product Owner):** Duzen oder Siezen je Mandant als Einstellung? Vorschlag: Standard „du“, Mandant kann die Texte unter Einstellungen > Texte und die KI-Tonalität (`ai.tone`) anpassen.
