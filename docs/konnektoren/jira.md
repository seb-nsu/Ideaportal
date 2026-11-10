# Konnektor Jira Cloud (R3-13)

Legt aus einer freigegebenen Idee ein **Epic** (oder eine Story bzw. Task) über die Jira Cloud REST API v3 an; User Stories des Umsetzungspakets werden als Unterelemente (`parent`) angelegt. Allgemeines zu Übergabe, Rückmeldung und Audit: [README](README.md).

## In Jira vorbereiten

1. Technisches Konto anlegen (z. B. `ideenportal@firma.de`) mit dem Recht, im Zielprojekt Vorgänge anzulegen und zu lesen.
2. API-Token des Kontos erzeugen: <https://id.atlassian.com/manage-profile/security/api-tokens>.
3. Projektschlüssel notieren (z. B. `INNO`) und prüfen, ob die Vorgangstypen `Epic` und `Story` im Projekt aktiv sind.
4. Optional: IDs zusätzlicher Felder ermitteln (z. B. `customfield_10010` für die Ideennummer, `duedate` für den Zieltermin).

## Im Portal einrichten

Einstellungen › Integrationen › Konnektoren › „Konnektor anlegen“:

| Feld | Wert |
| --- | --- |
| Zielsystem | Jira Cloud |
| Adresse | `https://<firma>.atlassian.net` |
| Projektschlüssel | z. B. `INNO` (Großbuchstaben) |
| Vorgangstyp der Idee | `Epic`, `Story` oder `Task` |
| Typ der User Stories | Standard `Story` |
| Zugangsdaten | E-Mail-Adresse des Kontos und API-Token |
| Feldzuordnung | z. B. Ideennummer → `customfield_10010`, Zieltermin → `duedate` |
| Status-Zuordnung | Standard: To Do 10 %, In Progress 50 %, In Review 80 %, Done 100 %; dazu die Status-Kategorien `new`, `indeterminate`, `done` für eigene Workflows |

Danach „Verbindung prüfen“ (liest `/rest/api/3/myself`) und „Aktivieren“. Rückmelde-Geheimnis und Rückmelde-Adresse notieren.

## Anfrage an Jira

`POST /rest/api/3/issue` mit Basic-Authentifizierung (E-Mail und API-Token):

```json
{ "fields": {
  "project": { "key": "INNO" },
  "issuetype": { "name": "Epic" },
  "summary": "<Titel der Idee>",
  "description": { "type": "doc", "version": 1, "content": [ … Absätze … ] },
  "labels": ["ideenportal"],
  "customfield_10010": 42
} }
```

Stories zusätzlich mit `"parent": { "key": "INNO-123" }`. Gespeichert werden `id`, `key` und der Link `https://<firma>.atlassian.net/browse/INNO-123`.

## Status zurück

**Webhook (empfohlen):** Jira › Einstellungen › System › WebHooks › „WebHook erstellen“: URL = Rückmelde-Adresse, Geheimnis = Rückmelde-Geheimnis, Ereignis „Vorgang aktualisiert“, JQL z. B. `project = INNO AND labels = ideenportal`. Jira signiert mit `X-Hub-Signature: sha256=…`; das Portal liest `issue.key` und `issue.fields.status.name` (bzw. die Status-Kategorie).

**Abfrage:** Schalter „Status zusätzlich regelmäßig abfragen“; das Portal liest `GET /rest/api/3/issue/<key>?fields=status` für laufende Umsetzungen.

Alternativ (Automation for Jira): Aktion „Webrequest senden“ an die Rückmelde-Adresse mit Header `Authorization: Bearer <API-Token des Portals mit Rolle Umsetzung>` und Inhalt `{"externalId": "{{issue.key}}", "status": "{{issue.status.name}}"}`.
