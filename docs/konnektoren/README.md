# Konnektoren zu Umsetzungswerkzeugen

Stand 13.10.2026 · AP-20 · Stories R3-13 (Jira), R3-14 (ServiceNow), R3-15 (Azure DevOps), R3-18 (Umsetzungspaket)

Eine freigegebene Idee (nach Gate 2: Status „In Umsetzung“, „Pilot“ oder „Integriert“) wird per Klick an das Werkzeug übergeben, in dem das Umsetzungsteam arbeitet. Der Status fließt in die Umsetzung des Portals zurück (Fortschritt, R1-31). Anleitungen je Zielsystem:

- [Jira Cloud](jira.md)
- [ServiceNow](servicenow.md)
- [Azure DevOps](azure-devops.md)

## So funktioniert es

1. **Einrichten (Admin):** Einstellungen › Integrationen › Konnektoren › „Konnektor anlegen“. Zielsystem, Adresse (nur `https`, keine Adressen im internen Netz), Ziel (Projekt, Tabelle, Typ), Zugangsdaten, Feldzuordnung und Status-Zuordnung. Zugangsdaten werden mit `SECRET_KEY` verschlüsselt gespeichert und nie wieder angezeigt. Nach dem Anlegen zeigt das Portal einmal das **Rückmelde-Geheimnis** und die **Rückmelde-Adresse**.
2. **Aktivieren per Klick:** Ein neuer Konnektor ist aus. „Verbindung prüfen“ liest im Zielsystem (nichts wird angelegt), „Aktivieren“ schaltet ihn für die Übergabe frei.
3. **Übergeben (Owner):** In der Idee unter „Übergabe an Umsetzungswerkzeuge“ wählt die verantwortliche Person der Umsetzung (oder ihre Vertretung, oder das Triage-Team) den Konnektor und klickt „Übergeben“. Das Portal legt das Element an, speichert Schlüssel und Link an der Idee und trägt den Verweis in die Umsetzung ein. Mit Umsetzungspaket werden die User Stories als Unterelemente angelegt; später ergänzte Stories lassen sich nachreichen, ohne das Hauptelement doppelt anzulegen.
4. **Status zurück:** Das Zielsystem meldet Statuswechsel an die Rückmelde-Adresse (Webhook, Service Hook, Business Rule), oder das Portal fragt den Status ab (Schalter „Status zusätzlich regelmäßig abfragen“, im Regel-Job und per Klick „Status jetzt abfragen“). Die Status-Zuordnung übersetzt den Status in Prozent Fortschritt. Bei 100 % bekommt die verantwortliche Person einen Hinweis; **abgeschlossen wird die Umsetzung weiter im Portal mit dem tatsächlichen Nutzen** (R1-32, Gate 3).

## Rückmeldung absichern

`POST <Portal>/api/integrations/connectors/<id>/status`, Inhaltstyp `application/json`. Eine dieser Prüfungen muss passen, sonst antwortet das Portal mit 401:

| Verfahren | Header | Geeignet für |
| --- | --- | --- |
| API-Token aus Einstellungen › Integrationen (AP-12) mit Rolle „Umsetzung“, „Triage“ oder „Admin“, aus demselben Arbeitsbereich | `Authorization: Bearer ipt_…` | ServiceNow, eigene Skripte |
| HMAC-SHA256 über den Rohinhalt mit dem Rückmelde-Geheimnis | `X-Hub-Signature: sha256=<hex>` | Jira-Webhooks mit Geheimnis |
| Signatur des Portals mit Zeitstempel (5 Minuten) | `X-Ideenportal-Signature: t=<unix>,v1=<hex HMAC von "<t>.<body>">` | eigene Skripte |
| Basic-Authentifizierung, Passwort = Rückmelde-Geheimnis (Benutzername beliebig) | `Authorization: Basic …` | Azure-DevOps-Service-Hooks |

Akzeptierte Inhalte: Jira-Webhook (`issue.key`, `issue.fields.status.name`), Azure-DevOps-Service-Hook (`resource.workItemId`, `System.State`) und die allgemeine Form `{"externalId": "<Kennung oder Schlüssel>", "status": "<Statusname>"}`. Andere Ereignisse beantwortet das Portal mit `{"ok": true, "matched": false}`. „Neues Rückmelde-Geheimnis“ macht das alte sofort ungültig.

## Was übergeben wird

- Titel; Beschreibung aus Problem, Lösung und Nutzen oder aus dem Projektsteckbrief des Umsetzungspakets; Zieltermin; Link zur Idee; im Feld der Zuordnung zusätzlich Ideennummer, Link, Themenfeld, Zieltermin, Nutzen, Aufwand (Personentage, Euro), Plan-Nutzen oder Kanal.
- **Keine Personen**: weder Ideengebende noch Owner. Im Zielsystem ist der technische Benutzer der Zugangsdaten der Ersteller.
- **Vertrauliche Ideen** nur nach ausdrücklicher Bestätigung im Übergabedialog („Ich bestätige, dass sie an dieses externe Werkzeug übergeben werden darf“). Ohne Bestätigung antwortet die API mit 409 `CONFIDENTIAL_CONFIRM`.
- Jede Übergabe steht im Audit-Log (`connector.handover` mit Konnektor, Element, Anzahl Stories, vertraulich und bestätigt), Fehlversuche ebenfalls (`connector.handover_failed`, die Übergabe legt dann nichts an). Statuswechsel aus dem Zielsystem: `connector.status`. Einrichtung: `connector.create`, `connector.update`, `connector.enable`, `connector.disable`, `connector.rotate_secret`, `connector.delete`.

## Umsetzungspaket (R3-18)

In der Idee unter „Umsetzungspaket“ erzeugt der KI-Baustein „Umsetzungspaket“ (Agent `implementation_package`, über das KI-Gateway) einen Entwurf: Projektsteckbrief (Ziel, Umfang, Nicht im Umfang, Nutzen, Aufwand, Risiken, Meilensteine, offene Fragen) und User Stories mit Akzeptanzkriterien. Der eingebaute Anbieter übernimmt Steckbrief und Idee ohne neue Zahlen und schlägt eine Story „Wirkung messen“ vor. Vertrauliche Ideen gehen nur an ein Modell mit eigenem Hosting. Der Entwurf ist als „KI-Entwurf, bitte prüfen“ gekennzeichnet, bis ihn ein Mensch bearbeitet; ein neuer Entwurf überschreibt Bearbeitungen nur nach Rückfrage. Export als Markdown oder PDF; Übergabe mit „User Stories … als Unterelemente anlegen“.

## Technik

`server/src/services/connectors.ts` (Rahmen, Übergabe, Rückmeldung, Abfrage), `server/src/services/connectorKinds.ts` (Anfragen je Zielsystem), `server/src/services/implpackage.ts` und `server/src/ai/package.ts` (Umsetzungspaket), `server/src/routes/connectors.ts`, Migration `023_connectors.sql` (Tabellen `connectors`, `connector_links`, `implementation_packages` mit RLS). Der HTTP-Client ist austauschbar (`setConnectorHttp`); die Tests laufen gegen nachgebildete APIs ohne Netz (`server/test/connectors.test.ts`).
