# Betriebshandbuch (Gerüst)

Stand 12.10.2026 · Release 0 · Entwurf · ergänzt `docs/betrieb.md` (Varianten, Umgebungsvariablen, laufende Aufgaben)

Dieses Gerüst legt fest, **was** im Betrieb geregelt sein muss. Abschnitte mit „TODO“ werden vor dem Pilotstart gefüllt. Bezug: R1-01, R1-02, R1-05, R3-09, R3-10, ADR 0001–0005.

## 1 Systemübersicht

| Komponente | Intern (VM) | Extern (EU-Cloud) |
| --- | --- | --- |
| App (API, Oberfläche, Jobs, KI-Worker) | Docker-Container aus demselben Image | Render Web Service (Frankfurt), `render.yaml` |
| Datenbank | PostgreSQL 16 (`pgcrypto`, `pg_trgm`), Rolle `ideenportal_app` | Render PostgreSQL (Frankfurt) |
| Mail | Firmen-Relay über `SMTP_URL` | EU-Mail-Dienst über `SMTP_URL` |
| Virenscan | ClamAV (`CLAMAV_HOST`) | ClamAV als eigener Dienst (TODO) |
| KI | `builtin`; optional Ollama/vLLM intern | Anbieter je Mandant (ADR 0004) |
| Suche | optional SearXNG | Brave oder SearXNG (ADR 0005) |

Verantwortlich: **Offen (Product Owner):** Betriebsverantwortliche Person und Vertretung benennen; interne IT für die VM einbinden.

## 2 Deployment

| Schritt | Beschreibung |
| --- | --- |
| Build | CI (`.github/workflows/ci.yml`): `npm audit --audit-level=critical`, Typprüfung, Tests gegen PostgreSQL, Build, Browser-Test mit axe, Image-Build |
| Staging | TODO: eigener Render-Service bzw. VM mit Testdaten; jede Version zuerst dort (R1-02) |
| Produktion | Render: Auto-Deploy vom Hauptzweig nach grüner CI; VM: `docker compose pull && docker compose up -d` |
| Migrationen | laufen beim Start (`MIGRATE_ON_START=true`), geschützt durch Advisory-Sperre 4711; nur vorwärts, Rückweg über Backup |
| Prüfung danach | `GET /api/health`, Anmeldung mit Testkonto, Job-Log „background jobs finished“ |
| Rollback | vorheriges Image erneut ausrollen; bei Schemaänderung Wiederherstellung (Abschnitt 3) |
| Updates | Abhängigkeiten monatlich; Sicherheitsupdates innerhalb von 7 Tagen (kritisch: 48 h) |

## 3 Backups und Wiederherstellung

| Thema | Regel |
| --- | --- |
| Häufigkeit | täglich vollständig; Render: Sicherung des Anbieters (Plan prüfen, ggf. Point-in-Time-Recovery); VM: `pg_dump -Fc` täglich per Cron |
| Aufbewahrung | 30 Tage täglich, 12 Monate monatlich (Vorschlag) |
| Ort | EU, getrennt vom Produktionssystem; verschlüsselt |
| Geheimnisse | `SECRET_KEY` getrennt vom Backup sichern (Passwort-Tresor); ohne ihn sind Anbieterschlüssel im Backup unbrauchbar |
| Wiederherstellungstest | **monatlich**: Backup in eine leere Datenbank laden, App gegen sie starten, Stichprobe (Mandantenzahl, letzte Idee, Anmeldung), Ergebnis protokollieren |
| Ziele | RPO 24 h, RTO 8 h (Business-SLA, Annahme) |

Protokoll Wiederherstellungstest (Vorlage): Datum · Backup-Zeitpunkt · Dauer · Prüfungen ok/nicht ok · Befunde · Person.

### Protokoll Wiederherstellungstest

| Datum | Umgebung | Backup | Dauer | Prüfungen | Ergebnis | Befunde | Person |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 12.10.2026 | Entwicklungsumgebung, PostgreSQL 16.15, Datenbank mit Demo-Seed (Mandanten `demo` und `beispiel`) | `pg_dump -Fc` (410 KB), unmittelbar vor dem Test | unter 1 Minute | Zeilenzahl in `tenants` (2), `users` (9), `ideas` (7), `ai_results` (14), `audit_log` (20) gleich; 70 Policies und 7 Migrationen vorhanden; Rolle `ideenportal_app` ohne Mandantenkontext sieht 0 Ideen (Row-Level-Security greift nach der Rücksicherung); App gegen die Rücksicherung gestartet, ausstehende Migration lief nach, `/api/health` meldet `ok` | ok | `pg_restore` braucht Lesezugriff des Datenbanknutzers auf die Datei (sonst „Permission denied“); die Rolle `ideenportal_app` muss im Ziel-Cluster existieren (legt die erste Migration an) | Claude Code (AP-03) |

Offen: Test auf Render mit der Sicherung des Anbieters, sobald der bezahlte Plan aktiv ist (der kostenlose Plan hat keine Sicherungen).

Ablauf für den monatlichen Test:

```bash
pg_dump -Fc "$DATABASE_URL" > backup.dump
createdb ideenportal_restore
pg_restore -d ideenportal_restore < backup.dump
DATABASE_URL=postgres://…/ideenportal_restore PORT=3001 npm start   # App startet, Migrationen laufen leer durch
curl -s http://localhost:3001/api/health                              # status ok
```

## 4 Monitoring und Alarme

| Signal | Quelle | Schwelle | Alarm an |
| --- | --- | --- | --- |
| Erreichbarkeit | externer Check auf `/api/health` | 2 Fehlversuche in 5 Min. | Bereitschaft |
| Fehlerrate | Logs (5xx) | > 2 % über 10 Min. | Bereitschaft |
| Job-Lauf | `/api/health` → `jobs.lastRunAgeSeconds`, App-Alarm `jobs_stale` / `jobs_failed` | kein Lauf seit 45 Min. (`ALERT_JOB_MAX_AGE_MINUTES`) oder letzter Lauf fehlgeschlagen | `ALERT_EMAIL`, `ALERT_WEBHOOK_URL` |
| Mail-Outbox | `/api/health` → `outbox`, Alarm `outbox_backlog` / `outbox_oldest` | > 200 (`ALERT_OUTBOX_MAX`) oder älter als 60 Min. | wie oben |
| KI-Warteschlange | `/api/health` → `aiQueue`, Alarm `ai_queue` / `ai_oldest` | > 50 Aufträge oder ältester älter als 30 Min. | wie oben |
| KI-Fehler | `ai_actions.status = 'error'` | > 20 % in 1 h je Anbieter | Betrieb |
| KI-Kosten | Summe `cost_eur` je Mandant | 80 % Budget | Admin des Mandanten |
| Datenbank | Speicher, Verbindungen | > 80 % | Betrieb |
| Zertifikat | TLS-Ablauf | < 14 Tage | Betrieb |

Die App prüft die Schwellen selbst alle 5 Minuten (R1-05, `server/src/services/ops.ts`) und meldet neue Alarme einmal, offene alle 6 Stunden erneut und eine Entwarnung, sobald sie weg sind. Die Prüfung läuft unabhängig von der Job-Schleife, damit ein stiller Ausfall der Fristen-Engine auffällt. Fällt die ganze App aus, hilft nur ein externer Check auf `/api/health` (Werkzeug noch festzulegen); öffentliche Statusseite folgt mit R3-10.

## 5 Störungsprozess (Incident)

| Stufe | Beispiel | Reaktion | Kommunikation |
| --- | --- | --- | --- |
| P1 kritisch | App nicht erreichbar, Datenleck zwischen Mandanten | sofort, Bereitschaft | Statusseite, Admins der Mandanten innerhalb 1 h |
| P2 hoch | Jobs laufen nicht (Fristen), Mail fällt aus | 4 h | Statusseite |
| P3 mittel | KI-Anbieter fällt aus (Fallback greift) | nächster Werktag | Hinweis in der App |
| P4 niedrig | Darstellungsfehler | Backlog | – |

Ablauf: erkennen → Ticket/Protokoll anlegen → eindämmen → beheben → Mandanten informieren → Nachbetrachtung innerhalb 5 Werktagen (Ursache, Maßnahmen, Story).

**Datenschutzverletzung:** sofort DSB informieren; Verantwortliche (Kunden) unverzüglich, Ziel 24 h (AVV); Meldung an die Aufsichtsbehörde durch den Verantwortlichen binnen 72 h (Art. 33 DSGVO). Keine Rechtsberatung.

## 6 Ausfall eines KI-Anbieters

1. Gateway erkennt Fehler (Timeout, 5xx, 429) → Wiederholung mit Backoff (ADR 0003).
2. Bei Anthropic greifen zuerst die serverseitigen Modell-Fallbacks des Anbieters.
3. Nach 3 Fehlversuchen: Job `failed`; neue Jobs des Mandanten laufen mit **`builtin`** (regelbasiert) und Hinweis „eingeschränkte Analyse“ (`KI-AUS`).
4. Ideenfluss läuft unverändert weiter; Fristen hängen nie an der KI.
5. Nach Wiederherstellung: fehlgeschlagene Jobs gezielt neu einreihen (Admin oder Betrieb), Budget beachten.
6. Anbieterwechsel über Einstellungen > KI; danach automatischer Testsatz-Lauf (Konfigurations-Hash ändert sich).

## 7 Schlüssel und Geheimnisse

| Geheimnis | Ablage | Rotation |
| --- | --- | --- |
| `DATABASE_URL` | Umgebungsvariable der Plattform | jährlich und bei Personalwechsel |
| `SMTP_URL` | Umgebungsvariable | jährlich |
| `SECRET_KEY` (AES-256-GCM für Anbieterschlüssel, künftig TOTP) | Umgebungsvariable, Kopie im Passwort-Tresor | jährlich oder bei Verdacht |
| Plattform-API-Schlüssel der KI-/Suchanbieter | Umgebungsvariable | halbjährlich |
| Mandantenschlüssel | `tenant_secrets`, verschlüsselt | durch den Kunden-Admin |

**Rotation von `SECRET_KEY`** (TODO: Skript): neuen Schlüssel als `SECRET_KEY` setzen, alten als `SECRET_KEY_PREVIOUS`; App entschlüsselt mit beiden, ein Job verschlüsselt alle `tenant_secrets` neu; danach `SECRET_KEY_PREVIOUS` entfernen. Ergebnis im Audit-Log.

**Rotation von Anbieterschlüsseln:** neuen Schlüssel beim Anbieter erzeugen → in Einstellungen > KI eintragen (bzw. Umgebungsvariable) → Testaufruf → alten Schlüssel beim Anbieter widerrufen.

## 8 Bereitschaft

| Punkt | Regel (Vorschlag) |
| --- | --- |
| Zeiten | Werktags 8–18 Uhr im Pilot; ab Marktstart erweitert laut SLA |
| Besetzung | Entwicklungsteam im Wechsel, benannte Vertretung |
| Erreichbarkeit | Alarm per Mail und Messenger |
| Zugänge | Plattform-Konto mit MFA, Notfallzugang im Tresor |
| Übergabe | wöchentlich kurze Übergabe offener Störungen |

## 9 Löschfristen und Datenpflege

- Der Regel-Job (alle 15 Min.) wendet `settings.retention` an: abgeschlossene Ideen (24 Monate), Benachrichtigungen (12 Monate), Anonymisierung deaktivierter Konten (30 Tage), KI-Protokolle und -Ergebnisse (`aiActionsMonths`, 24 Monate).
- Monatlich prüfen: Job-Ergebnis `retention` im Log, Stichprobe in der Datenbank.
- Demo-Mandant wird täglich gelöscht und neu angelegt (`DEMO_MODE=true`).
- Gelöschte Arbeitsbereiche: Daten inkl. Protokoll sofort; Backups laufen nach Aufbewahrungsfrist aus.

## 10 Übergabe an die interne IT (intern)

TODO: Checkliste für den Sicherheitsreview vor dem Pilot (Netz, Firewall, Reverse Proxy mit TLS, `COOKIE_SECURE=true`, Backups, Monitoring, Zuständigkeit), abgestimmt mit der IT.
