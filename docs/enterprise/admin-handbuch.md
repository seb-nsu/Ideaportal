# Admin-Handbuch

Deutsch | [English](admin-handbuch.en.md)

Für Admins eines Arbeitsbereichs: Einrichtung und Pflege des Portals ohne Technikkenntnisse. Technischer Betrieb (Server, Umgebungsvariablen, Sicherungen) steht in [`../betrieb.md`](../betrieb.md). Alle Einstellungen liegen unter **Einstellungen** (nur für Admins sichtbar); jede Änderung steht im Protokoll.

## 1 Erste Schritte (Reihenfolge)

1. **Prozess** prüfen: Fristen für Gate 1 und Gate 2 in Arbeitstagen, Schwellen, Sprache des Arbeitsbereichs, Löschfristen.
2. **Themen und Kalender**: Themenfelder anlegen, Feiertage des Bundeslands wählen.
3. **Bereiche** anlegen, wenn Triage oder Gremium nur für einen Teil der Ideen zuständig sind (Abschnitt 3).
4. **Personen** einladen und Rollen vergeben (Abschnitt 2) oder **Anmeldung** mit Firmen-Login und SCIM einrichten (Abschnitt 4).
5. **KI** einrichten: Anbieter, Modelle, Kostenlimits; Qualitätsprüfung abwarten (Abschnitt 5).
6. **Texte** und **Zielkanäle** anpassen: Gate-1-Antworten, FAQ, Datenschutzhinweis, Weiterleitungsziele.
7. **Rechtliches** prüfen: Datenschutzhinweis, Rechtstexte, Unterauftragnehmer.

## 2 Personen und Rollen

| Rolle | Darf |
| --- | --- |
| Ideengeber:in | Ideen einreichen, kommentieren, eigene Ideen verfolgen |
| Pate | eine Idee in der Ausarbeitung begleiten |
| Triage | Gate 1 entscheiden (Spur wählen), Rückfragen stellen, weiterleiten |
| Gremium | Gate 2 entscheiden, Sitzungen vorbereiten |
| Bereichsleitung | Portfolio und Dashboard eines Bereichs, Gate 3 |
| Umsetzer:in | Umsetzung dokumentieren, Ist-Nutzen eintragen |
| Controlling | Ist-Nutzen bestätigen oder korrigieren |
| Betriebsrat (lesend) | KI-Nachweise und Mitbestimmungsübersicht, keine Ideentexte |
| Externe:r | nur eigene und freigegebene Ideen (Kunden, Partner) |
| Personenverwaltung (`user_admin`) | Personen einladen, deaktivieren, Rollen vergeben (außer Admin); keine Einstellungen |
| Admin | alle Einstellungen |

- **Einladen:** Einstellungen › Personen › E-Mail und Rollen, oder Einladungslink teilen.
- **Deaktivieren:** beendet sofort alle Sitzungen der Person. Nach der eingestellten Frist wird das Konto anonymisiert.
- **Eigene Admin-Rolle** kann niemand sich selbst entziehen; so bleibt immer mindestens eine Admin.
- **Auskunft und Anonymisieren** (DSGVO): Einstellungen › Personen › Person wählen.
- **Viele Personen auf einmal:** Import aus CSV oder Excel mit Vorschau (bis 2.000 Zeilen) und Sammelaktionen in der Liste (deaktivieren, aktivieren, Rolle hinzufügen oder entfernen). Beides steht im Protokoll.

## 3 Bereiche

Triage, Gremium und Bereichsleitung können auf Bereiche beschränkt werden. Eine Idee gehört über Themenfeld und Organisationseinheit zu einem Bereich. Wer eine Rolle nur für Bereich A hat, sieht und entscheidet nur Ideen aus A. Anleitung: [`../betrieb.md`](../betrieb.md), Abschnitt „Rollen je Bereich einrichten“.

## 4 Anmeldung

- **Eigene Konten** mit Passwort und optionaler Zwei-Faktor-Anmeldung (TOTP). Unter Prozess lässt sich die Zwei-Faktor-Anmeldung für Admins verpflichtend machen.
- **Firmen-Login per OIDC** und **SCIM** für Microsoft Entra ID, Okta und andere: Schritt-für-Schritt in [`../betrieb.md`](../betrieb.md), Abschnitt „Einrichtung für die Kunden-IT“.
- **Firmen-Login per SAML 2.0** (Entra ID, Okta, ADFS): [`saml.md`](saml.md).
- **Einstellungen › Sicherheit:** Mindestlänge der Passwörter und Abmeldung nach Inaktivität.
- **Lokale Konten abschalten** erst, wenn sich eine Admin per Firmen-Login angemeldet hat; das Portal prüft das.
- Bei Firmen-Login erzwingt die Firma die Mehr-Faktor-Anmeldung in ihrem Identitätsdienst.

## 5 KI

- Ohne Einrichtung arbeitet ein eingebauter, regelbasierter Anbieter; nichts verlässt den Server.
- Unter **Einstellungen › KI** Anbieter, Modell je Aufgabe, Kostenlimits je Idee und Monat und die Websuche festlegen.
- **Vertrauliche Ideen** gehen nur an Modelle mit Hosting „eigene Infrastruktur“.
- Ein Baustein geht erst live, wenn er die **Qualitätsprüfung** mit dem Testsatz besteht. Eine Ausnahme braucht eine Begründung und steht im Protokoll.
- Unter **KI › Qualität** stehen Prüfstatus, Rückmeldungen der Nutzer:innen und Alarme, zusammengefasst und erst ab 5 Personen.
- Unter **KI › Qualität** lassen sich Prüfberichte je Lauf als JSON oder Markdown herunterladen, mit Vergleich zum Lauf davor. Optional bewertet ein Prüfmodell die Ergebnisse zusätzlich.
- Die Seite **„KI im Portal“** (Link in der Fußzeile) zeigt allen Nutzer:innen, welche KI wofür läuft, wohin Daten gehen und wann zuletzt geprüft wurde.
- Die KI entscheidet nie und lehnt nie ab; sie bewertet keine Personen.

## 6 Protokoll und Nachweise

- **Einstellungen › Protokoll** zeigt alle sicherheitsrelevanten Aktionen (Anmeldungen und Fehlversuche, Rollen, Einstellungen, Exporte, Löschungen, KI-Ausnahmen) mit Filtern nach Zeitraum, Person und Aktion und exportiert sie als CSV oder JSONL.
- **Kette prüfen** zeigt, ob das Protokoll seit dem Anlegen unverändert ist.
- **SIEM:** Unter Protokoll lässt sich ein Ziel (https-Webhook) eintragen; neue Einträge gehen signiert dorthin.
- **KI-Nachweise** zeigen jede KI-Aktion mit Modell, Kosten und Quellen; der Betriebsrat sieht sie lesend.

## 7 Daten

- **Export** des ganzen Arbeitsbereichs unter Einstellungen › Daten: Das Portal erstellt im Hintergrund ein ZIP mit einer Datei je Tabelle und allen Anhängen und benachrichtigt die Admin. Der Download gilt 7 Tage.
- **Löschfristen** unter Prozess; der nächtliche Lauf löscht abgeschlossene Ideen und anonymisiert deaktivierte Konten.
- **Arbeitsbereich löschen** unter Einstellungen › Daten: nur nach erneuter Anmeldung (Passwort und zweiter Faktor oder frischer Firmen-Login). Danach gilt eine Frist von 30 Tagen, in der sich nur Admins anmelden und die Löschung abbrechen können. Ein Löschnachweis ohne Inhalte bleibt beim Betreiber.

## 8 Integrationen

- **API-Tokens und Webhooks:** Einstellungen › Integrationen; Beschreibung der API unter `/api/docs`.
- **Jira, ServiceNow, Azure DevOps:** [`../konnektoren/`](../konnektoren/README.md).
- **Slack und Teams:** [`../betrieb.md`](../betrieb.md), Abschnitt „Slack und Microsoft Teams“.

## 9 Support

- **Support-Zugriff** erteilt die Admin unter Einstellungen › Support-Zugriff für eine begrenzte Zeit. Jeder Zugriff des Betreibers steht im Protokoll des Arbeitsbereichs.
- Störungen und Wartungen stehen auf der Statusseite `/status`. Zusagen zu Verfügbarkeit und Reaktionszeiten: [`sla-und-support.md`](sla-und-support.md).
