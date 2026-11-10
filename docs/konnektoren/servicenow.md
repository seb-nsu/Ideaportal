# Konnektor ServiceNow (R3-14)

Legt aus einer freigegebenen Idee einen **Demand** (`dmn_demand`) oder ein **Projekt** (`pm_project`) über die Table API an. User Stories des Umsetzungspakets werden in einer Story-Tabelle (Standard `rm_story`) mit Verweis auf den Datensatz angelegt (Feld Standard `parent`). Die Verknüpfung gilt in beide Richtungen: Das Portal speichert `sys_id`, Nummer und Link; der Datensatz in ServiceNow trägt die Ideen-ID in `correlation_id`, „Ideenportal #Nummer“ in `correlation_display` und den Link zur Idee in der Beschreibung. Allgemeines: [README](README.md).

## In ServiceNow vorbereiten

1. Technischen Benutzer anlegen (nur Web-Service-Zugriff), Rollen zum Anlegen und Lesen in `dmn_demand` bzw. `pm_project` (z. B. `demand_manager` bzw. `it_project_manager`) und, für Stories, in `rm_story`.
2. Prüfen, ob die Plugins Demand Management bzw. Project Portfolio Management aktiv sind.
3. Optional: eigene Felder für die Zuordnung (z. B. `u_benefit`).

## Im Portal einrichten

| Feld | Wert |
| --- | --- |
| Zielsystem | ServiceNow |
| Adresse | `https://<instanz>.service-now.com` |
| Tabelle der Idee | `dmn_demand` oder `pm_project` |
| Typ der User Stories | Tabelle, Standard `rm_story` |
| Zugangsdaten | Benutzername und Passwort des technischen Benutzers |
| Status-Zuordnung | Anzeigewerte des Felds `state`, Standard: Draft 0 %, Submitted 10 %, Screening 20 %, Qualified 30 %, Approved 40 %, Pending 10 %, Open 20 %, Work in Progress 50 %, Completed 100 %, Closed Complete 100 % |

„Verbindung prüfen“ liest einen Datensatz aus `sys_user`.

## Anfrage an ServiceNow

`POST /api/now/table/dmn_demand` mit Basic-Authentifizierung:

```json
{ "short_description": "<Titel>", "description": "<Text mit Link zur Idee>",
  "correlation_id": "<Ideen-ID>", "correlation_display": "Ideenportal #42", "u_benefit": "…" }
```

Antwort `result.sys_id` und `result.number`; Link `https://<instanz>.service-now.com/nav_to.do?uri=dmn_demand.do?sys_id=…`.

## Status zurück

**Business Rule mit REST-Nachricht (empfohlen):** Im Portal unter Einstellungen › Integrationen einen API-Token mit Rolle „Umsetzung“ anlegen. In ServiceNow eine REST-Nachricht (POST an die Rückmelde-Adresse, Header `Authorization: Bearer <Token>`, `Content-Type: application/json`) und eine Business Rule „after update“ auf `dmn_demand` (bzw. `pm_project`), Bedingung „State ändert sich“ und `correlation_id` nicht leer:

```javascript
(function executeRule(current, previous) {
  var r = new sn_ws.RESTMessageV2('Ideenportal Status', 'post');
  r.setRequestBody(JSON.stringify({ externalId: current.getUniqueValue(), status: current.state.getDisplayValue() }));
  r.executeAsync();
})(current, previous);
```

Statt des Tokens geht auch die Signatur `X-Ideenportal-Signature` mit dem Rückmelde-Geheimnis (siehe README).

**Abfrage:** Schalter „Status zusätzlich regelmäßig abfragen“; das Portal liest `GET /api/now/table/<tabelle>/<sys_id>?sysparm_fields=state&sysparm_display_value=true`.
