# Konnektor Azure DevOps (R3-15)

Legt aus einer freigegebenen Idee ein **Work Item** (Epic, Feature oder User Story) über die REST API (JSON Patch, `api-version=7.1`) an. User Stories des Umsetzungspakets werden als untergeordnete Work Items angelegt (Beziehung `System.LinkTypes.Hierarchy-Reverse`). Jedes Work Item bekommt einen Hyperlink zur Idee und das Tag `Ideenportal`. Allgemeines: [README](README.md).

## In Azure DevOps vorbereiten

1. Personal Access Token (PAT) eines technischen Kontos mit dem Bereich **Work Items: Read & Write** erzeugen (Benutzereinstellungen › Personal access tokens). Ablaufdatum notieren und rechtzeitig erneuern.
2. Projektname und Prozess (Agile, Scrum, Basic) prüfen: Die Typen `Epic`, `Feature`, `User Story` (Scrum: `Product Backlog Item`, Basic: `Issue`) müssen existieren.

## Im Portal einrichten

| Feld | Wert |
| --- | --- |
| Zielsystem | Azure DevOps |
| Adresse | `https://dev.azure.com/<organisation>` |
| Projekt | Name des Projekts |
| Work-Item-Typ der Idee | `Epic`, `Feature` oder `User Story` |
| Typ der User Stories | Standard `User Story` (Scrum: `Product Backlog Item`) |
| Zugangsdaten | Personal Access Token |
| Feldzuordnung | z. B. Zieltermin → `Microsoft.VSTS.Scheduling.TargetDate` |
| Status-Zuordnung | Standard: New 10 %, Active 50 %, In Progress 50 %, Resolved 80 %, Closed 100 %, Done 100 % |

„Verbindung prüfen“ liest `/_apis/projects/<projekt>`.

## Anfrage an Azure DevOps

`POST /<projekt>/_apis/wit/workitems/$Feature?api-version=7.1`, `Content-Type: application/json-patch+json`, Basic-Authentifizierung mit leerem Benutzernamen und dem PAT:

```json
[
  { "op": "add", "path": "/fields/System.Title", "value": "<Titel>" },
  { "op": "add", "path": "/fields/System.Description", "value": "<p>…</p>" },
  { "op": "add", "path": "/fields/System.Tags", "value": "Ideenportal" },
  { "op": "add", "path": "/relations/-", "value": { "rel": "Hyperlink", "url": "<Link zur Idee>" } }
]
```

Stories zusätzlich mit `{ "rel": "System.LinkTypes.Hierarchy-Reverse", "url": ".../_apis/wit/workItems/<id>" }`.

## Status zurück

**Service Hook (empfohlen):** Projekteinstellungen › Service hooks › „Web Hooks“ › Ereignis „Work item updated“ (Filter: Feld `State`, optional Tag `Ideenportal`). URL = Rückmelde-Adresse, Basic-Authentifizierung mit beliebigem Benutzernamen und dem Rückmelde-Geheimnis als Passwort, Ressourcendetails „All“. Das Portal liest `resource.workItemId` und `resource.fields["System.State"].newValue`.

**Abfrage:** Schalter „Status zusätzlich regelmäßig abfragen“; das Portal liest `GET /<projekt>/_apis/wit/workItems/<id>?fields=System.State&api-version=7.1`.
