# Sicherheit und Beobachtbarkeit (Enterprise-Reife)

Deutsch | [English](sicherheit-und-beobachtbarkeit.en.md)

Stand: 13.10.2026. Dieses Dokument beschreibt, was für Sicherheit, Protokollierung und Betrieb gebaut wurde, welche Umgebungsvariablen neu sind und was Admins und Betrieb tun müssen. Es wird später in `docs/betrieb.md` und den Umsetzungsstand übernommen.

Migration: `server/migrations/031_security_observability.sql`. Neue Abhängigkeiten: `prom-client` (Metriken), `undici` (Verbindungen auf geprüfte Adressen festlegen).

## 1. Anmeldeprotokoll

Das Protokoll (`audit_log`) enthält jetzt auch die Anmeldungen:

| Aktion | Wann | Mandant |
| --- | --- | --- |
| `auth.login` | Erfolgreiche Anmeldung mit Passwort (`mfaPending`, wenn noch der zweite Faktor fehlt) | Mandant des Kontos |
| `auth.login_failed` | Falsches Passwort für ein **bestehendes** Konto | Mandant dieses Kontos |
| `auth.mfa_failed` / `auth.mfa_verified` | Falscher bzw. richtiger zweiter Faktor | Mandant des Kontos |
| `auth.logout` | Abmeldung | Mandant der Sitzung |
| `auth.sso_login` / `auth.sso_refused` | Firmen-Login (gab es schon, unverändert) | Mandant des Firmen-Logins |
| `auth.locked`, `auth.rate_limited` | Sperre nach 5 Fehlversuchen, Ratenlimit (gab es schon) | Mandant des Kontos |

Unbekannte Adressen erzeugen keinen Eintrag (es gibt keinen Mandanten dafür). Wer Konten in mehreren Arbeitsbereichen hat und sich ohne Angabe des Arbeitsbereichs anmeldet, bekommt keinen Fehleintrag, solange das Passwort zu einem Konto passt.

Jede Protokollzeile hat drei neue Spalten:

- `request_id`: die Anfrage-ID (siehe Abschnitt 4) oder bei Hintergrundläufen `jobs:<uuid>`, `ai:<uuid>`, `webhooks:<uuid>`.
- `ip_hash`: HMAC-SHA256 der Client-Adresse, Schlüssel per HKDF aus `SECRET_KEY` abgeleitet, gekürzt auf 32 Hex-Zeichen. Gleiche Adresse ergibt gleichen Hash, die Adresse selbst wird nicht gespeichert. Ein einfacher SHA-256 (wie bei den Ratenlimits) wäre bei IPv4 durch Ausprobieren umkehrbar und wurde deshalb nicht übernommen.
- `user_agent`: Browserkennung, auf 200 Zeichen gekürzt.

Die Werte setzt die Datenbankschicht (`server/src/db/pool.ts`) für jede Transaktion einer Anfrage; ein Trigger übernimmt sie in jede neue Protokollzeile. Damit sind alle Schreibwege abgedeckt, auch ältere direkte `INSERT`s.

## 2. Manipulationssicheres Protokoll (Hash-Kette)

Jede Protokollzeile gehört zu einer Kette je Mandant:

- `chain_seq`: fortlaufende Nummer je Mandant (1, 2, 3 …, ohne Lücken),
- `prev_hash`: Prüfsumme der vorigen Zeile (die erste Zeile hat 64 Nullen),
- `row_hash = sha256(prev_hash || audit_canonical(zeile))`.

`audit_canonical` ist ein JSON-Array in fester Reihenfolge: `[chain_seq, id, tenant_id, actor_id, action, entity, entity_id, before, after, created_at (UTC, Mikrosekunden), ip_hash, user_agent, request_id]`. Die Berechnung läuft im Datenbank-Trigger `audit_log_chain`, also für jeden Schreibweg. Der Kopf der Kette je Mandant steht in `audit_chain_heads`; seine Zeilensperre reiht die Einträge eines Mandanten bis zum Commit hintereinander (unter `REPEATABLE READ` gibt es einen Serialisierungsfehler statt einer Gabelung). Bestehende Einträge wurden in der Migration in der Reihenfolge ihrer IDs verkettet.

**Prüfen:** `GET /api/admin/audit/verify` (nur Admins) bzw. Knopf „Kette prüfen“ unter Verwaltung › Protokoll. Antwort: `ok`, Anzahl geprüfter Einträge, Bereich (`firstSeq`, `lastSeq`) und bei einem Bruch der erste betroffene Eintrag mit Grund:

- `row_hash`: Inhalt verändert,
- `prev_hash`: Verknüpfung passt nicht (Eintrag ersetzt oder umsortiert),
- `gap`: ein Eintrag fehlt,
- `tail`: die neuesten Einträge fehlen (der Kettenkopf passt nicht zum letzten Eintrag).

Die Prüfung selbst wird als `audit.verify` protokolliert.

**Grenzen:** Wer Eigentümerrechte an der Datenbank hat, kann Kette und Kopf zusammen neu berechnen. Schutz dagegen bietet eine Kopie der Prüfsummen außerhalb des Portals: Die SIEM-Weiterleitung (Abschnitt 3) liefert zu jedem Eintrag `prevHash`, `rowHash` und den kanonischen Text. Der Append-only-Trigger bleibt bestehen.

**Löschen eines Arbeitsbereichs:** Der bestehende Weg (`purgeTenant`, Migration 003) funktioniert weiter: Alle Einträge und der Kettenkopf des Mandanten werden gemeinsam gelöscht. Einzelne Einträge bleiben unlöschbar. Falls künftig eine Aufbewahrungsfrist die ältesten Einträge löscht, beginnt die Prüfung beim ersten verbliebenen Eintrag (dessen `prev_hash` gilt als Anker, `firstSeq` zeigt den Anfang). Ein Löschen ältester Einträge wäre dann für sich allein nicht erkennbar, nur über die SIEM-Kopie.

## 3. Protokoll ansehen, exportieren, weiterleiten

**Ansicht** (`GET /api/admin/audit`): neue Filter `from`, `to` (Kalendertage in der Zeitzone des Arbeitsbereichs, `to` einschließlich, oder ISO-Zeitpunkte), `actor` (`system`, eine Nutzer-ID oder ein Teil von Name/E-Mail) und `action` (Präfix, z. B. `auth.`). Mit `paged=true` oder `cursor=…` lautet die Antwort `{ items, nextCursor }` (Cursor-Paginierung, höchstens 500 je Seite); ohne beides bleibt die bisherige Array-Antwort.

**Export** (`GET /api/admin/audit/export?format=csv|jsonl`, dieselben Filter): Der Export wird gestreamt und hat keine Obergrenze mehr (bisher 5.000 Zeilen). Er liest in Blöcken zu 1.000 Zeilen in jeweils eigener kurzer Transaktion. CSV mit BOM, Schutz gegen Formel-Injektion (Zellen mit `= + - @` bekommen ein `'` davor), zusätzliche Spalten Nr. in der Kette, E-Mail, Adress-Hash, Browser, Anfrage-ID, Prüfsumme. Jeder Export wird als `audit.export` protokolliert.

**SIEM-Weiterleitung:** Gewählt wurde Push per Webhook, weil die vorhandene Webhook-Technik (Signatur, SSRF-Schutz, Sender, Backoff) wiederverwendet werden kann und der Betrieb keinen zusätzlichen Pull-Zugang absichern muss.

- Ein Ziel je Arbeitsbereich (`siem_settings`), nur `https` und keine Adressen im internen Netz (gleiche Prüfung wie Webhooks, Verbindung auf die geprüfte Adresse festgelegt, siehe Abschnitt 8).
- Signaturschlüssel `siemsec_…` wird einmal angezeigt und mit dem Mandantenschlüssel verschlüsselt gespeichert (`secret_enc`, Secretbox).
- Versand in Paketen zu höchstens 500 Einträgen (bis zu 10 Pakete je Lauf), älteste zuerst, in der Webhook-Schleife (`WEBHOOK_SECONDS`, Standard 15 s) und im Job-Lauf.
- Body: `{ type: "audit.batch", tenantId, sentAt, fromSeq, toSeq, events: [...] }`, jedes Ereignis mit `seq, id, createdAt, actorId, actorEmail, action, entity, entityId, before, after, ipHash, userAgent, requestId, prevHash, rowHash, canonical`.
- Header wie bei Webhooks: `X-Ideenportal-Signature: t=<unix>,v1=<HMAC-SHA256 über "<t>.<body>">`, `X-Ideenportal-Event: audit.batch`, `X-Ideenportal-Delivery: <tenant>:<von>-<bis>` (gleich bei Wiederholung, Empfänger können Doppelte verwerfen).
- Die Position (`forwarded_seq`) rückt erst nach einer 2xx-Antwort vor. Fehler: erneuter Versuch nach 1 min, 5 min, 30 min, 2 h, dann alle 12 h. Es geht nichts verloren und das Ziel wird nicht abgeschaltet; nach 10 Fehlern in Folge bekommen die Admins einmal eine Benachrichtigung.
- Prüfen auf Empfängerseite: `sha256(prevHash + canonical) == rowHash` und `prevHash` gleich dem `rowHash` des vorigen Ereignisses.
- Datenschutz: Die Ereignisse enthalten, was im Protokoll steht, inklusive E-Mail der handelnden Person und `before`/`after`. Das SIEM ist damit ein weiterer Empfänger personenbezogener Daten (Verzeichnis der Verarbeitungen ergänzen).

API (nur Admins; Änderungen nur durch Personen, nicht per API-Token): `GET/PUT/PATCH/DELETE /api/admin/audit/siem`, `POST /api/admin/audit/siem/rotate`. `PUT` nimmt `{ url, active?, backfill? }`; `backfill: true` sendet zuerst das ganze vorhandene Protokoll, sonst beginnt die Weiterleitung mit dem nächsten Eintrag.

**Oberfläche:** Verwaltung › Protokoll (Filter, „Weitere laden“, Export CSV/JSON Lines, „Kette prüfen“, SIEM-Ziel) und neuer Reiter Verwaltung › Sicherheit (Passwort-Mindestlänge, Abmeldung bei Inaktivität). Code: `web/src/pages/SecurityAdmin.tsx`.

## 4. Beobachtbarkeit

- **Anfrage-IDs:** Ein mitgeschickter Header `X-Request-Id` wird übernommen, wenn er 8–128 Zeichen aus `A-Z a-z 0-9 . _ : -` hat; sonst erzeugt der Server eine UUID. Die ID steht in jeder Logzeile (`reqId`), im Antwort-Header `X-Request-Id`, in Protokolleinträgen (`request_id`) und bei 500-Fehlern in der Antwort (`requestId`).
- **Fehler:** Unerwartete Fehler werden auf Level `error` mit Anfrage-ID und Stack (ohne Inhalte, bestehende Serializer) geloggt. Sentry o. Ä. ist bewusst nicht eingebaut.
- **Log-Level:** `LOG_LEVEL` (Standard `info`).
- **Hintergrundläufe:** Job-, KI- und Webhook-Schleife loggen mit `loop` und `runId`; Protokolleinträge aus diesen Läufen tragen `jobs:<runId>` usw.
- **Metriken:** `GET /api/metrics` im Prometheus-Format, nur mit `Authorization: Bearer <METRICS_TOKEN>`. Ohne gesetztes `METRICS_TOKEN` antwortet der Endpunkt mit 404. Inhalt:
  - Prozessmetriken (`ideenportal_process_*`, `ideenportal_nodejs_*`),
  - `ideenportal_http_request_duration_seconds` nach Methode, Routenmuster (z. B. `/api/ideas/:id`, nie konkrete IDs) und Status,
  - `ideenportal_ai_queue_jobs{state}`, `ideenportal_outbox_pending`, `ideenportal_webhook_deliveries_pending`, `ideenportal_job_last_run_age_seconds{loop}` (−1 = noch nie),
  - `ideenportal_ai_calls_total{agent,status,local}`, `ideenportal_ai_cost_eur_total{agent}`, `ideenportal_background_runs_total{loop,outcome}`, `ideenportal_siem_batches_total{outcome}`.
  - Keine Mandantennamen, IDs, Personen oder Ideeninhalte in Labels. Zähler gelten je Instanz (in Prometheus summieren).

## 5. Health-Checks

| Pfad | Zweck | Antwort |
| --- | --- | --- |
| `GET /api/health/live` | Prozess läuft (ohne Datenbank) | immer `200 {"status":"ok"}` |
| `GET /api/health/ready` | Datenbank erreichbar | `200 {"status":"ok"}` oder `503 {"status":"unavailable"}` |
| `GET /api/health` | wie bisher, 503 nur ohne Datenbank | öffentlich nur `{"status":"ok"|"degraded"|"unavailable"}`; Kennzahlen und Alarm-Schlüssel nur mit `METRICS_TOKEN` als Bearer |

`Dockerfile` (HEALTHCHECK) und `render.yaml` (`healthCheckPath`) nutzen jetzt `/api/health/ready`. Die CI wartet weiter auf `/api/health` (200 bleibt gleich). Wer die Kennzahlen bisher öffentlich abgefragt hat, braucht jetzt den Token.

## 6. Sichere Voreinstellungen und Schlüsselableitung

- Mit `NODE_ENV=production` (Standard im Docker-Image) startet der Server nicht ohne `SECRET_KEY` mit mindestens 32 Zeichen (klare Fehlermeldung, Exit-Code 1). Ein gesetztes `METRICS_TOKEN` muss mindestens 24 Zeichen haben. `docker-compose.yml` setzt für den lokalen Test `NODE_ENV=development`, damit vorhandene lokale Daten mit dem bisherigen Testschlüssel lesbar bleiben.
- Ist `PUBLIC_URL` eine https-Adresse, sind Sitzungs-Cookies immer `Secure` (auch HSTS), `COOKIE_SECURE=false` wird dann ignoriert (Warnung im Log). `COOKIE_SECURE=true` erzwingt `Secure` zusätzlich hinter einem TLS-Proxy mit http-`PUBLIC_URL`.
- **HKDF:** Mandantenschlüssel werden jetzt als `k2.` gespeichert; der Schlüssel zum Einpacken entsteht per HKDF-SHA256 aus `SECRET_KEY` (Salt `ideenportal-secretbox`, Info `tenant-key-wrap:v2`). Ältere `k1.`-Werte (einfacher SHA-256) bleiben lesbar und werden beim Start automatisch als `k2.` neu eingepackt (`upgradeKeyWrapping`, gleiche Datenschlüssel, gespeicherte Geheimnisse bleiben unverändert). Auch die Schlüsselrotation (`npm run rotate-key`) schreibt `k2.`. Getestet in `server/test/security-hardening.test.ts`.

## 7. Anmeldung härten

- **Gleiche Antwortzeit:** Für unbekannte Adressen und Konten ohne Passwort prüft der Server gegen einen Dummy-scrypt-Hash, damit die Antwortzeit nicht verrät, ob es das Konto gibt.
- **Passwortregeln** (`server/src/lib/password.ts`) bei Registrierung, Beitritt per Link, Beitritt von Externen und Passwort-Reset:
  - Mindestlänge je Arbeitsbereich (`security.passwordMinLength`, Standard 10, nie unter 10, höchstens 128),
  - Sperre sehr verbreiteter Passwörter: 1.000 häufigste Passwörter mit mindestens 10 Zeichen und 1.000 häufige Grundwörter (SecLists, MIT-Lizenz) plus einige deutsche Wörter; ein Grundwort mit nur Ziffern/Zeichen davor oder danach („Passwort2024!“) gilt als verbreitet; dazu Wiederholungen („abcabcabcabc“) und Folgen („1234567890“),
  - E-Mail-Name bzw. Name des Arbeitsbereichs als Passwort sind gesperrt,
  - optional Prüfung gegen bekannte Datenlecks mit `PASSWORD_BREACH_CHECK=hibp` (Have I Been Pwned, k-Anonymität: nur die ersten 5 Zeichen des SHA-1-Hashes verlassen den Server, Antwort mit Padding). Standard aus, in Tests nie. Ist der Dienst nicht erreichbar, wird das Passwort nicht blockiert (Warnung im Log).
  - Fehlercode `PASSWORD_POLICY` mit `details.reason` (`tooShort`, `tooLong`, `common`, `personal`, `breached`).
- **Abmeldung bei Inaktivität** je Arbeitsbereich (`security.sessionIdleMinutes`, Standard 0 = aus, sonst 5–1440 Minuten). Standard aus, um den Pilotbetrieb nicht zu verändern. Die Sitzung merkt sich `last_seen_at` (höchstens einmal pro Minute geschrieben); ist sie länger inaktiv, wird sie gelöscht und die Anfrage gilt als nicht angemeldet. Die feste Höchstdauer `SESSION_HOURS` bleibt zusätzlich.

## 8. SSRF: Schutz gegen DNS-Rebinding

Bisher wurde eine Adresse geprüft und danach mit `fetch` erneut aufgelöst; ein Angreifer mit eigenem DNS konnte zwischen Prüfung und Verbindung auf eine interne Adresse umschalten. Jetzt verbindet sich der Server genau mit der geprüften Adresse (`undici`-Agent mit festgelegtem `lookup`, `server/src/ai/providers.ts`: `providerFetch`, `publicFetch`, `pinnedAgent`). URL, `Host`-Header und TLS-Servername (SNI, Zertifikatsprüfung) bleiben die des ursprünglichen Namens.

Verwendet für: OpenAI-kompatible KI-Anbieter, Anthropic mit eigener Basis-URL, SearXNG-Suche, Seitenabruf der Quellenprüfung, Webhooks und SIEM-Weiterleitung. Die Liste gesperrter Adressbereiche wurde ergänzt (u. a. 198.18.0.0/15, Multicast, IPv4-gemappte Adressen in Hex-Form, `fe80::/10` vollständig, NAT64). **Nicht umgestellt** (andere Arbeitsbereiche, eigene Prüfung je Anfrage vorhanden): OIDC-Discovery (`lib/oidc.ts`), Konnektoren (`services/connectors.ts`), Chat-Nachrichten (`services/chat.ts`). Sie können `publicFetch` später ebenso nutzen.

## Neue Umgebungsvariablen

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | Log-Level (`fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`) |
| `METRICS_TOKEN` | – | Bearer-Token für `/api/metrics` und die Kennzahlen von `/api/health`; ohne Token ist `/api/metrics` aus (404). Mindestens 24 Zeichen in Produktion |
| `PASSWORD_BREACH_CHECK` | aus | `hibp` = neue Passwörter gegen Have I Been Pwned prüfen (k-Anonymität) |
| `COOKIE_SECURE` | (geändert) | `true` erzwingt Secure-Cookies; bei https-`PUBLIC_URL` sind sie immer Secure |
| `NODE_ENV` | – | `production` verlangt `SECRET_KEY` ≥ 32 Zeichen |

## Schritte für Betrieb und Admins

1. Vor dem Update prüfen, dass `SECRET_KEY` in Produktion mindestens 32 Zeichen hat; sonst startet der Server nicht. Kürzere Schlüssel per Rotation ersetzen (`docs/betrieb.md`, R3-41): erst mit dem alten Schlüssel aktualisieren und `NODE_ENV` vorübergehend nicht auf `production` setzen, dann rotieren.
2. Optional `METRICS_TOKEN` setzen und Prometheus mit `bearer_token` auf `/api/metrics` zeigen lassen.
3. Load Balancer/Plattform auf `/api/health/ready` umstellen (Render und Docker-Image sind angepasst).
4. Admins: unter Verwaltung › Protokoll einmal „Kette prüfen“; bei Bedarf SIEM-Ziel eintragen und den Signaturschlüssel im SIEM hinterlegen. Unter Verwaltung › Sicherheit Mindestlänge und Inaktivitäts-Abmeldung festlegen.
5. Verzeichnis der Verarbeitungen: Adress-Hash und Browserkennung im Protokoll, ggf. SIEM als Empfänger ergänzen.

## Tests

`server/test/security-audit.test.ts` (Anmeldeprotokoll, Hash-Kette mit Manipulation, Lücke und fehlendem Ende, parallele Einträge, Mandantentrennung, Löschen eines Arbeitsbereichs, Filter und Cursor, Streaming-Export über 5.000 Zeilen, Formel-Injektion, SIEM mit Signatur, Backoff, Rechten und RLS) und `server/test/security-hardening.test.ts` (Anfrage-IDs, Fehler-Logs, LOG_LEVEL, Laufkennung, Health, Metriken, sichere Voreinstellungen, HKDF mit alten Schlüsseln, gleiche Antwortzeit, Inaktivität, Einstellungsprüfung, Passwortregeln mit HIBP-Fake, DNS-Rebinding mit Fake-Resolver und lokalem Server).
