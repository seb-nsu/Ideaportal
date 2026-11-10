# Mandanten und Administration (Enterprise)

Deutsch | [English](mandanten-und-administration.en.md)

Stand: 13.10.2026. Dieses Dokument beschreibt den Lebenszyklus der Arbeitsbereiche (Mandanten), den vollständigen Export, die persönlichen Betreiberkonten, Ausnahmen je Mandant und die delegierte Personenverwaltung. Migration: `server/migrations/032_tenant_lifecycle_admin.sql`. Tests: `server/test/enterprise-admin.test.ts`.

## Überblick

| Thema | Wer | Wo |
| --- | --- | --- |
| Status sperren / entsperren | Betreiber (Rolle Inhaber oder Technik) | Betreiberkonsole › Arbeitsbereiche |
| Löschung mit Frist (Offboarding) | Admin des Arbeitsbereichs oder Betreiber | Verwaltung › Daten bzw. Betreiberkonsole |
| Vollständiger Export (ZIP) | Admin | Verwaltung › Daten |
| Betreiberkonten | Betreiber (Rolle Inhaber), Kommandozeile | Betreiberkonsole › Betreiberkonten |
| Funktionen und Grenzen je Mandant | Betreiber (Inhaber oder Technik) | Betreiberkonsole › Arbeitsbereiche |
| Personenverwaltung | Admin und neue Rolle `user_admin` | Verwaltung › Personen |
| CSV-Import und Sammelaktionen | Admin und `user_admin` | Verwaltung › Personen |

## Status eines Arbeitsbereichs

Jeder Mandant hat einen Status in `tenants.status`:

- **aktiv** (`active`): normaler Betrieb.
- **gesperrt** (`suspended`): niemand kann sich anmelden, bestehende Sitzungen bekommen Fehler 403 (`TENANT_SUSPENDED`). Jobs (Fristen, KI-Aufträge, Webhooks) und SCIM laufen für diesen Mandanten nicht. Die Daten bleiben unverändert.
- **wird gelöscht** (`deleting`): Löschung beantragt, Frist läuft. Nur Admins können sich anmelden. Erlaubt sind Lesen, Anmeldung, Export und Abbruch der Löschung; alles andere bekommt Fehler 403 (`TENANT_DELETING`).

Sperren und Entsperren brauchen einen Grund (3–300 Zeichen). Beides steht im Betreiberprotokoll und im Protokoll des Arbeitsbereichs (`tenant.suspend`, `tenant.resume`).

Die Durchsetzung liegt an drei Stellen:

1. Der Datenbank-Trigger `sessions_tenant_status` verhindert neue Sitzungen. Er meldet SQLSTATE `IPT01` (gesperrt) bzw. `IPT02` (wird gelöscht).
2. `enforceTenantStatus()` prüft jede Anfrage vor der Paketprüfung.
3. Jobs, KI-Worker und Webhook-Zustellung verarbeiten nur aktive Mandanten.

Der Trigger `tenants_lifecycle_guard` verhindert, dass die Anwendungsrolle `ideenportal_app` die Statusspalten selbst ändert.

## Löschung mit Frist (Offboarding)

1. Ein Admin beantragt die Löschung unter Verwaltung › Daten. Dafür muss er sich erneut bestätigen (siehe unten) und die Kurzbezeichnung des Arbeitsbereichs eintippen. Ein Betreiber kann die Löschung ebenfalls beantragen, mit Grund und eigener Frist (0–365 Tage).
2. Status wird `deleting`, `delete_after` = jetzt + Frist. Die Frist ist standardmäßig 30 Tage (`TENANT_DELETE_GRACE_DAYS`). Alle Personen außer Admins werden abgemeldet.
3. Bis zum Ablauf kann ein Admin oder Betreiber die Löschung abbrechen. Der Status wird dann wieder `active`.
4. Nach Ablauf löscht der Fristen-Job (`purgeDueTenants`) alle Daten des Mandanten endgültig.
5. Es bleibt ein **Löschnachweis** in der Systemtabelle `tenant_deletions`, außerhalb des Mandanten. Er enthält:
   - Kurzbezeichnung und Name
   - Antrags- und Löschzeitpunkt
   - wer beantragt hat: Betreibername oder `user-<Hash>` als Pseudonym für Admins
   - Anzahl der gelöschten Zeilen je Tabelle

   Inhalte stehen nicht darin. Betreiber sehen die Nachweise in der Konsole.

Der frühere Sofort-Löschweg `DELETE` in `server/src/routes/pilot.ts` ist entfernt. Gelöscht wird nur noch über diesen Ablauf.

### Erneute Bestätigung

- **Konten mit Passwort:** Passwort und aktueller Code aus der Authenticator-App. Der Code darf nicht schon einmal verwendet worden sein.
- **Firmenanmeldung (OIDC/SAML):** Die Sitzung darf höchstens `REAUTH_SSO_MINUTES` Minuten alt sein (Standard 10), dazu die Kurzbezeichnung. Ist die Sitzung älter, meldet man sich neu an.

## Vollständiger Export

Admins fordern den Export unter Verwaltung › Daten an. Ein Worker im Hintergrund erstellt ihn alle `EXPORT_WORKER_SECONDS` Sekunden (Standard 10). Ist er fertig, bekommt der Admin eine Benachrichtigung und das Protokoll einen Eintrag `tenant.export_ready`. Die Datei kann `EXPORT_RETENTION_DAYS` Tage lang heruntergeladen werden (Standard 7). Danach wird sie gelöscht und als abgelaufen markiert.

**Format** (ZIP, gestreamt mit `yazl`):

- `tables/<tabelle>.csv` und `tables/<tabelle>.jsonl`: eine Datei je Mandantentabelle. Die Liste der Tabellen kommt aus `information_schema`, neue Tabellen sind also automatisch dabei. CSV ist UTF-8 mit BOM, Trennzeichen `;`, und gegen Formel-Injektion geschützt: Texte, die mit `=`, `+`, `-` oder `@` beginnen, bekommen ein `'` vorangestellt.
- `files/<tabelle>/<id>/<dateiname>`: Anhänge und andere Binärdaten.
- `manifest.json` als letzter Eintrag: Zeitpunkt, Mandant, Tabellen mit Spalten und Zeilenzahl, ausgeschlossene Tabellen und Spalten, Zahl und Größe der Dateien. Die SHA-256-Prüfsumme der ganzen ZIP-Datei steht in der Exportliste.

**Nicht im Export:**

- die Tabellen `sessions`, `tenant_keys`, `tenant_secrets`, `oidc_login_states`, `outbox` sowie die Exporttabellen selbst
- Spalten mit Geheimnissen, z. B. Passwort-Hashes, MFA-Schlüssel, Token-Hashes und verschlüsselte Werte (`*_enc`, `ciphertext`)

Der Export läuft mit `withTenant()` als `ideenportal_app`, also unter Row-Level-Security. Er enthält nur Daten des eigenen Mandanten. Die Datei liegt in Blöcken von etwa 1 MB in `tenant_export_chunks` und wird beim Herunterladen gestreamt.

Der alte Sofort-Export `GET /api/admin/export` als JSON (ohne Anhänge) bleibt vorerst erhalten. Er ist **abgekündigt** und soll mit dem nächsten Release entfallen.

## Betreiberkonten

Jede Person im Betrieb hat ein eigenes Konto in `operator_accounts`: E-Mail, Name, scrypt-Passwort (mindestens 12 Zeichen), Pflicht-TOTP (verschlüsselt gespeichert) und eine Rolle. Nach 5 Fehlversuchen ist das Konto 15 Minuten gesperrt. Ein TOTP-Code kann nur einmal verwendet werden. Startpasswörter müssen bei der ersten Anmeldung geändert werden.

| Rolle | Rechte |
| --- | --- |
| Inhaber (`owner`) | alles, auch Betreiberkonten |
| Support (`support`) | Übersicht, Support-Zugriff, Statusmeldungen |
| Abrechnung (`billing`) | Übersicht, Pakete, Rechnungen, Kontingente |
| Technik (`technical`) | Übersicht, Arbeitsbereiche anlegen, Status, Funktionen und Grenzen |

Jede Aktion steht im Betreiberprotokoll mit `operator_id`. Bei Mandantenaktionen steht sie zusätzlich im Protokoll des Arbeitsbereichs, mit dem Namen der Betreiberperson.

Schutzregeln: Der letzte aktive Inhaber kann nicht deaktiviert oder herabgestuft werden. Niemand kann die eigene Rolle oder den eigenen Aktivstatus ändern.

### Erstes Konto anlegen

**Weg A, Kommandozeile (empfohlen):**

```
npm run operator -w server -- create --email ops@example.com --name "Vera Betrieb" --role owner
npm run operator -w server -- list
npm run operator -w server -- reset --email ops@example.com
npm run operator -w server -- deactivate --email ops@example.com
```

`create` und `reset` zeigen Startpasswort und TOTP-Schlüssel einmal an. Im Container (ohne npm) heißt der Aufruf `node server/dist/db/operator-cli.js create …`, z. B. `docker exec -it <container> node server/dist/db/operator-cli.js list`.

**Weg B, Startanmeldung:**

1. `OPERATOR_TOKEN` und `OPERATOR_TOTP_SECRET` setzen; die Werte erzeugt `npm run operator -w server -- setup`.
2. In der Konsole mit dem Zugangsschlüssel anmelden. Die Konsole meldet sich als Inhaber „operator“ an.
3. Unter Betreiberkonten ein persönliches Inhaberkonto anlegen.

Sobald ein aktiver Inhaber existiert, ist die Startanmeldung gesperrt, und bestehende Startsitzungen werden ungültig. Für Notfälle (Break-Glass) gibt `OPERATOR_BREAK_GLASS=true` die Startanmeldung wieder frei. Danach sofort wieder abschalten.

## Funktionen und Grenzen je Mandant

Betreiber setzen in `tenant_overrides` Ausnahmen je Mandant:

- **Funktion** (`feature`): ein Paket-Schalter wird ein- oder ausgeschaltet.
- **Grenze** (`limit`): `fullAnalysesPerMonth` oder `maxChallenges` bekommt einen Wert von 0 bis 100.000.

Jede Ausnahme braucht einen Grund und kann ein Ablaufdatum haben. Abgelaufene Ausnahmen gelten nicht mehr; sie bleiben sichtbar, bis jemand sie entfernt. Setzen und Entfernen (mit Grund) stehen im Betreiberprotokoll und im Protokoll des Arbeitsbereichs (`tenant.override_set`, `tenant.override_removed`).

**Vorrang:** Paket → Überschreibungen am Paket (`tenant_plans`) → `tenant_overrides`. Die Ausnahmen je Mandant gewinnen also immer. Die Anwendung darf `tenant_overrides` nur lesen.

## Personenverwaltung

### Rolle `user_admin`

Die neue Rolle `user_admin` hat nur das Recht `managePeople`. Sie darf:

- Personen anlegen, einladen, ändern, deaktivieren und Rollen vergeben
- importieren und Sammelaktionen ausführen

Sie darf **nicht**:

- die Rolle Admin vergeben oder entziehen
- Admins ändern oder deaktivieren
- auf Export, Löschung, Einstellungen oder Protokoll zugreifen

In der Oberfläche sieht sie nur den Bereich „Personen“.

### CSV-Import

CSV- oder Excel-Datei mit den Spalten E-Mail (Pflicht), Name, Rollen, Abteilung und Bereich. Für die Spaltennamen gibt es Synonyme auf Deutsch und Englisch. Rollen können als ID oder als Bezeichnung in jeder Sprache angegeben werden. Höchstens 2.000 Zeilen.

Der Import läuft in zwei Schritten: zuerst eine Vorschau (`dryRun`) mit Ergebnis je Zeile, dann die Bestätigung. Neue Personen bekommen eine Einladung, bestehende Personen bekommen die Rollen dazu. Triage, Gremium und Bereichsleitung gelten mit Bereich nur für diesen Bereich. Protokolleintrag: `users.import`.

### Sammelaktionen

Bis zu 500 ausgewählte Personen auf einmal: deaktivieren, aktivieren, Rolle hinzufügen oder Rolle entfernen. Übersprungen werden, jeweils mit Grund:

- unbekannte Personen
- Admins, wenn ein `user_admin` handelt
- die eigene Person
- Personen ohne Änderung

Protokolleintrag: `users.bulk`.

## Umgebungsvariablen

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `TENANT_DELETE_GRACE_DAYS` | 30 | Frist bis zur endgültigen Löschung |
| `EXPORT_RETENTION_DAYS` | 7 | Wie lange ein Export heruntergeladen werden kann |
| `EXPORT_WORKER_SECONDS` | 10 | Takt des Export-Workers |
| `REAUTH_SSO_MINUTES` | 10 | Höchstalter einer SSO-Sitzung für die erneute Bestätigung |
| `OPERATOR_BREAK_GLASS` | false | Startanmeldung mit `OPERATOR_TOKEN` trotz vorhandenem Inhaberkonto erlauben |

## API (Auszug)

- Arbeitsbereich:
  - `GET /api/admin/workspace/lifecycle`
  - `POST /api/admin/workspace/delete`
  - `POST /api/admin/workspace/delete/cancel`
  - `GET|POST /api/admin/exports`
  - `GET /api/admin/exports/:id/download`
  - `POST /api/admin/users/import`
  - `POST /api/admin/users/bulk`
- Betreiber:
  - `POST /api/operator/tenants/:id/{suspend,resume,offboarding,offboarding/cancel}`
  - `GET /api/operator/deletions`
  - `GET|PUT /api/operator/tenants/:id/overrides`
  - `DELETE /api/operator/tenants/:id/overrides/:key`
  - `GET|POST /api/operator/operators`
  - `PATCH /api/operator/operators/:id`
  - `POST /api/operator/operators/:id/reset`
  - `POST /api/operator/me/password`

## Bewusst offen

- Eingehende Chat-Befehle (Teams/Slack) werden für gesperrte Mandanten noch nicht eigens abgewiesen. Sie scheitern erst bei der Rechteprüfung.
- Betreiber können den Export eines Mandanten nicht selbst herunterladen. Das geht nur über den Admin des Arbeitsbereichs.
- Die Kommandozeile für Betreiberkonten hat keine automatischen Tests.
