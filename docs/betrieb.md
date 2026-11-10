# Betrieb

Kurzanleitung für den Pilotbetrieb als Capstone-Produkt. Keine Rechtsberatung. Unterlagen für Enterprise-Kund:innen (Sicherheit, SLA, Upgrades, Admin-Handbuch, SAML, Audit-Log, Betreiberkonten, KI-Evals) stehen in [`enterprise/`](enterprise/README.md).

## Varianten

| Variante | Wofür | Start |
| --- | --- | --- |
| Render (EU, Frankfurt) | öffentliche Demo und Pilot | Repository in Render als Blueprint verbinden; `render.yaml` legt App und PostgreSQL an |
| Docker Compose | lokal oder auf einer eigenen VM | `docker compose up --build` |
| Ohne Docker | Entwicklung, VM ohne Container | Node.js 22 und PostgreSQL 16; `npm ci && npm run build && npm start` |

Die App braucht nur PostgreSQL 16 mit den Erweiterungen `pgcrypto` und `pg_trgm`; `vector` (pgvector) ist optional (Abschnitt „Suche und Dubletten“). Beim Start laufen die Migrationen (`MIGRATE_ON_START=true`). Die Migration legt die Rolle `ideenportal_app` an, über die jede Anfrage mit Row-Level-Security läuft. Dafür braucht der Datenbanknutzer das Recht `CREATEROLE`. Bei verwalteten Datenbanken vor dem ersten Start prüfen (nicht bei jedem Anbieter getestet).

## Umgebungsvariablen

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `DATABASE_URL` | lokal | Verbindung zu PostgreSQL |
| `PUBLIC_URL` | `http://localhost:3000` | Adresse für Links in E-Mails |
| `COOKIE_SECURE` | `false` | hinter HTTPS auf `true` setzen; beginnt `PUBLIC_URL` mit `https://`, sind Cookies immer Secure |
| `SIGNUP_ENABLED` | `true` | Selbstregistrierung neuer Arbeitsbereiche |
| `DEMO_MODE` | `false` | öffentliche Demo mit Rollenwechsel; legt den Arbeitsbereich `demo` an und setzt ihn täglich zurück |
| `MAIL_TRANSPORT` | `log` (mit `SMTP_URL`: `smtp`) | `log` schreibt Mails ins Protokoll, `none` verwirft sie |
| `SMTP_URL`, `MAIL_FROM` | – | SMTP-Zugang, z. B. `smtps://user:passwort@smtp.example.com:465` |
| `CLAMAV_HOST`, `CLAMAV_PORT` | – | Virenscan für Anhänge über clamd; ohne Angabe nur Typprüfung |
| `SESSION_HOURS` | `12` | Gültigkeit einer Anmeldung |
| `JOB_INTERVAL_MINUTES` | `15` | Takt für Fristen, Erinnerungen, Löschfristen und Mailversand |
| `SECRET_KEY` | – | Pflicht im Betrieb: verpackt den eigenen Datenschlüssel jedes Arbeitsbereichs (R3-01), mit dem KI- und Suchschlüssel, TOTP-Geheimnisse, Chat- und Webhook-Geheimnisse und das Client-Geheimnis des Firmen-Logins verschlüsselt sind (AES-256-GCM). Langen Zufallswert (mind. 16, besser 32 Zeichen) setzen und sicher aufbewahren; ohne ihn sind gespeicherte Schlüssel unbrauchbar. Wechsel nur mit der Rotation (Abschnitt „SaaS-Betrieb“). Fehlt er, bleiben TOTP-Geheimnisse lesbar gespeichert (nur für lokale Entwicklung) |
| `SECRET_KEY_PREVIOUS` | – | nur während einer Rotation (R3-41): der alte `SECRET_KEY`, damit noch nicht neu verpackte Schlüssel lesbar bleiben; danach entfernen |
| `OPERATOR_TOKEN`, `OPERATOR_TOTP_SECRET` | – | Startanmeldung der Betreiberkonsole `/betrieb` (R3-07), gilt nur, bis ein persönliches Inhaberkonto existiert ([Betreiberkonten](enterprise/mandanten-und-administration.md#betreiberkonten)): Zugangsschlüssel (mind. 32 Zeichen) und TOTP-Geheimnis (Base32); erzeugen mit `npm run operator -w server -- setup`. Ohne beide ist die Konsole aus |
| `OPERATOR_NAME`, `OPERATOR_SESSION_HOURS` | `operator`, `4` | Name des Betreibers in den Protokollen der Arbeitsbereiche; Gültigkeit der Konsolen-Sitzung |
| `STATUS_HISTORY_DAYS` | `90` | Tage der Verfügbarkeitshistorie auf der Statusseite (R3-10) |
| `RATE_LIMIT_FACTOR` | `1` | skaliert alle Rate-Limits; `0` schaltet sie aus (nur für Lasttests) |
| `TRUST_PROXY_HOPS` | `1` | Anzahl der Proxys vor der App (Render: 1). Die Client-Adresse für Rate-Limits stammt aus `X-Forwarded-For`, aber nur so weit, wie Proxys vertraut wird. Ohne Proxy `0` setzen |
| `ANTHROPIC_API_KEY` | – | Plattform-Schlüssel für Anthropic; Arbeitsbereiche nutzen ihn mit „Schlüssel der Plattform“ |
| `OPENAI_COMPATIBLE_API_KEY` | – | Plattform-Schlüssel für einen OpenAI-kompatiblen Anbieter |
| `BRAVE_API_KEY` | – | Plattform-Schlüssel für die Websuche über Brave |
| `OIDC_ALLOW_PRIVATE_URLS` | `false` | erlaubt für den Firmen-Login (R3-26) Issuer-Adressen ohne `https` oder im eigenen Netz (z. B. Keycloak oder ADFS im Intranet); für SaaS aus lassen |
| `AI_ALLOW_PRIVATE_URLS` | `false` | erlaubt Anbieter-Adressen im eigenen Netz (z. B. Ollama auf `localhost`); nur bei eigenem Betrieb |
| `AI_WORKER_SECONDS` | `5` | Takt der KI-Warteschlange |
| `WEBHOOK_SECONDS` | `15` | Takt der Webhook-Zustellung (R3-17); Wiederholungen laufen zusätzlich in den Hintergrundregeln |
| `AI_TIMEOUT_SECONDS` | `300` | Höchstdauer eines Modellaufrufs |
| `AI_CONCURRENCY` | `2` | KI-Aufträge, die diese Instanz gleichzeitig bearbeitet (R2-49) |
| `AI_TENANT_CONCURRENCY` | `1` | höchstens so viele KI-Aufträge je Arbeitsbereich gleichzeitig; die Arbeitsbereiche kommen reihum dran (R2-49) |
| `AI_PAGE_FETCH` | `true` | Seitenabruf der Quellenprüfung (R2-46); `false` schaltet ihn für die ganze Instanz ab |
| `ALERT_EMAIL` | – | Adresse für Betriebsalarme (R1-05); nutzt den Mailversand der App |
| `ALERT_WEBHOOK_URL` | – | Webhook für Betriebsalarme, z. B. eingehender Webhook in Teams oder Slack; erhält JSON mit `text` |
| `ALERT_CHECK_MINUTES`, `ALERT_REPEAT_HOURS` | `5`, `6` | Takt der Prüfung und Wiederholung offener Alarme |
| `ALERT_JOB_MAX_AGE_MINUTES` | `45` (mind. 3 × Job-Takt) | Alarm, wenn die Hintergrundregeln so lange nicht liefen |
| `ALERT_AI_QUEUE_MAX`, `ALERT_AI_OLDEST_MINUTES` | `50`, `30` | Alarm bei langer KI-Warteschlange oder altem Auftrag |
| `ALERT_OUTBOX_MAX`, `ALERT_OUTBOX_OLDEST_MINUTES` | `200`, `60` | Alarm bei Mail-Rückstau (nur sofort zu versendende Mails) |
| `DATABASE_SSL` | `off` | TLS zur Datenbank (R3-08): `require` verschlüsselt mit Zertifikatsprüfung (System-CAs oder `DATABASE_SSL_CA`), `no-verify` verschlüsselt ohne Prüfung (nur bei selbstsignierten Zertifikaten); `off` lässt `sslmode` in `DATABASE_URL` gelten |
| `DATABASE_SSL_CA` | – | CA-Zertifikat der Datenbank als PEM-Text oder Pfad zu einer PEM-Datei |
| `OPERATOR_NAME`, `OPERATOR_ADDRESS`, `OPERATOR_EMAIL`, `PRIVACY_CONTACT` | – | Anbieterangaben in AGB, Datenschutzerklärung und AVV (R3-11); ohne Angabe stehen Platzhalter in eckigen Klammern |
| `HOSTING_PROVIDER`, `HOSTING_REGION`, `HOSTING_LOCATION` | –, –, `eu` | Hosting in den Rechtstexten und der Liste der Unterauftragnehmer (R3-08); `HOSTING_LOCATION` ist `eu`, `other` oder `local` |
| `MAIL_PROVIDER`, `MAIL_LOCATION` | –, `eu` | Mail-Dienst als Unterauftragnehmer (nur bei `MAIL_TRANSPORT=smtp`) |
| `NODE_ENV` | `production` im Image | `production` verlangt `SECRET_KEY` mit mindestens 32 Zeichen, sonst startet die App nicht (0.4.0) |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` oder `silent` |
| `METRICS_TOKEN` | – | Bearer-Token für `/api/metrics` (Prometheus) und die Kennzahlen von `/api/health`; ohne ist `/api/metrics` aus |
| `PASSWORD_BREACH_CHECK` | aus | `hibp` prüft neue Passwörter gegen Have I Been Pwned (k-Anonymität, nur Hash-Präfix verlässt den Server) |
| `TENANT_DELETE_GRACE_DAYS` | `30` | Frist bis zur endgültigen Löschung eines Arbeitsbereichs |
| `EXPORT_RETENTION_DAYS`, `EXPORT_WORKER_SECONDS` | `7`, `10` | Aufbewahrung der ZIP-Exporte und Takt des Export-Workers |
| `REAUTH_SSO_MINUTES` | `10` | Höchstalter einer Firmen-Login-Sitzung für die erneute Bestätigung vor dem Löschen |
| `OPERATOR_BREAK_GLASS` | `false` | gibt die Anmeldung mit `OPERATOR_TOKEN` wieder frei, obwohl ein Inhaberkonto existiert (nur im Notfall) |
| `GIT_COMMIT` | – | Commit des Builds für `GET /api/version`; im Image per `--build-arg GIT_COMMIT=…` |

## KI einrichten

Ohne Einrichtung läuft der eingebaute, regelbasierte Anbieter: nichts verlässt den Server. Er liefert Struktur, Kennzeichnung und Leitfragen, aber **keine Beträge und keine Marktzahlen**. Offene Werte stehen als „zu klären“; Business Case, Marktgröße und interner Hebel werden erst gerechnet, wenn das Team die Werte einträgt. Solange kein Modell eingerichtet ist, zeigt jede Ideenseite das Banner „Kein KI-Modell eingerichtet“. Die öffentliche Demo zeigt für zwei Beispielideen vorab erstellte Ergebnisse, gekennzeichnet als „vorab erstellt“.

Den Triage-Vorschlag und den Rückmeldungsentwurf sehen nur Triage-Team, Gremium und der Pate der Idee, nicht die Ideengebenden.

Für echte Analysen unter **Einstellungen › KI**:

1. **Anbieter hinzufügen**, z. B. Anthropic, Mistral (EU), ein eigenes Modell über Ollama oder jeder Dienst mit OpenAI-kompatibler Schnittstelle. „Hosting“ ehrlich angeben: Nur „eigene Infrastruktur“ darf vertrauliche Ideen sehen.
2. **Schlüssel hinterlegen** (wird verschlüsselt gespeichert und nie wieder angezeigt) oder den Plattform-Schlüssel nutzen. „Verbindung testen“ prüft ihn.
3. **Modell je Aufgabe wählen:** schnell (Kurzanalyse, Coach, Rückmeldung), gründlich (Vollanalyse, Business Case, Gate-2-Vorlage), Bild, Sprache und vertraulich. Einzelne Bausteine können ein eigenes Modell bekommen.
4. **Qualitätsprüfung abwarten:** Nach jeder Modelländerung läuft der Testsatz. Bausteine gehen erst live, wenn sie den Mindestwert erreichen; eine begründete Ausnahme ist möglich und wird protokolliert.
5. **Kostenlimits und Preise** prüfen; Preise sind Listenpreise und gegen den eigenen Vertrag abzugleichen.
6. Optional **Websuche** (Brave oder eigenes SearXNG) mit Monatslimit und Liste interner Begriffe, die nie in Suchanfragen gelangen.
7. **Websuche und Bausteine je Ideentyp** (R2-45): Standard ist für interne Ideen keine Websuche in der Kurzanalyse und für beide Typen „Patente“ aus. Übersprungene Schritte stehen im KI-Protokoll mit Status „übersprungen“ und Grund.
8. **Quellenprüfung** (R2-46): Für höchstens 5 Treffer je Analyse ruft das Portal die Seite ab (nur http/https, nie das interne Netz, Zeitlimit, höchstens 20.000 Zeichen) und prüft Erreichbarkeit und Zitat. Für vertrauliche Ideen wird nichts abgerufen.
9. **Prüfpflicht vor Gate 2** (R2-44): Mit „Vor der Entscheidung an Gate 2 müssen alle KI-Bausteine geprüft sein“ lehnt das Portal die Entscheidung ab, solange ein Baustein „ungeprüft“ ist.

**Kostenschätzung vor jedem Aufruf (R2-49):** Vor jedem Modellaufruf schätzt das Gateway die Kosten aus der Prompt-Länge (etwa 4 Zeichen je Token, ein Bild 1.600 Token) und der Token-Obergrenze des Bausteins als Ausgabe, mit den Preisen unter Einstellungen › KI. Würden bisherige Kosten plus Schätzung das Budget je Idee oder je Monat überschreiten, bricht der Aufruf vorher ab (Status „Budget“ im KI-Protokoll, mit der Schätzung als Hinweis). Die Schätzung ist eine Obergrenze; echte Aufrufe kosten meist weniger.

**Qualität im Einsatz (R2-44, R2-46):** Unter Einstellungen › KI › Qualität stehen je Baustein Prüfstatus, Anteil „hilfreich“, Aufklappquote, Anteil der Zahlen mit Quelle und das Ergebnis der Quellenprüfung, alles zusammengefasst und erst ab der Mindestgruppengröße. Einmal im Monat zieht der Fristenlauf 5 Ergebnisse als Stichprobe und benachrichtigt den Paten der Idee (ohne Pate das Triage-Team).

**Qualitäts-Dashboard und Alarm (R4-08):** Unter Einstellungen › KI steht unter dem Formular das Qualitäts-Dashboard: je Agent und Woche oder Monat Aufrufe, Trefferquote (Prüfstatus „geprüft“, Stichprobe „korrekt“, Triage-Vorschlag gleich Entscheidung), Anteil „hilfreich“ (erst ab der Mindestgruppengröße), Korrekturrate, Quellenfehler, Fehlerquote und Kosten, mit dem Verlauf der letzten zwölf Zeiträume. Der tägliche Fristenlauf vergleicht den letzten abgeschlossenen Zeitraum mit den drei Zeiträumen davor; verschlechtert sich eine Quote um die eingestellte Schwelle (Standard 10 Prozentpunkte) oder steigen die Kosten je Aufruf um den eingestellten Anteil (Standard 50 %), bekommen die Admins **einmal je Zeitraum** eine Benachrichtigung (Tabelle `ai_quality_alarms`, Zähler `aiQualityAlarms` im Job-Ergebnis). Zeiträume mit weniger Fällen als „Mindestzahl Fälle“ werden nicht bewertet. Alles ist je Agent zusammengefasst, nie je Person.

**Import mit KI-Unterstützung (R4-12):** Unter Einstellungen › Import gibt es unter dem bisherigen Import (R1-39) den Import mit KI-Unterstützung (höchstens 500 Zeilen je Datei). Der Agent „Import alter Ideen“ (`import_cleanup`, Slot „schnell“) bereinigt die Texte und schlägt Themenfelder aus der Liste des Arbeitsbereichs vor; der eingebaute Anbieter macht das regelbasiert ohne Netz. Zeilen mit „Vertraulich = ja“ gehen nur an das Modell für vertrauliche Inhalte (eigenes Hosting oder eingebaut). Die Vorschau zeigt KI-Vorschläge gekennzeichnet, Dubletten (gleicher Titel im Portal oder in der Datei, ähnliche Ideen aus der Dublettensuche) und legt nichts an; erst die Bestätigung importiert. Übernommene KI-Vorschläge stehen in der Historie der Idee („KI-Vorschlag übernommen: …“), der Import im Audit-Log mit den Kennungen der KI-Protokolleinträge.

Bei Anthropic-Modellen ist die serverseitige Ausweichlösung eingeschaltet (Opus 5.5, Opus 5, Sonnet 5.5, Fable 5.1): Ist das Modell überlastet, antwortet ein gleichwertiges Modell. Das KI-Protokoll zeigt, welches Modell geantwortet hat.

## Schutz der öffentlichen Demo

Seit AP-01 (R1-44, R1-45) gelten:

| Schutz | Wert | Hinweis |
| --- | --- | --- |
| Anmeldung je IP-Adresse | 30 Versuche in 15 Minuten | Antwort 429 mit Wartezeit (`Retry-After`) |
| Anmeldung je Konto (E-Mail) | 10 Versuche in 15 Minuten | gilt über alle IP-Adressen; Ereignis `auth.rate_limited` im Audit-Log des Arbeitsbereichs; zusätzlich Sperre nach 5 Fehlversuchen |
| Zweiter Faktor je Anmeldung | 10 Versuche in 15 Minuten | |
| Registrierung je IP-Adresse | 5 in der Stunde | |
| Beitritt per Link je IP-Adresse | 20 in der Stunde | |
| Passwort-Reset | 10 je IP-Adresse, 3 je Konto in der Stunde | |
| Demo-Anmeldung je IP-Adresse | 60 in 10 Minuten | |

Zähler liegen in der Datenbank (`rate_limits`, nur Hashes von IP-Adresse oder E-Mail) und gelten damit für alle Instanzen. Jede erste Überschreitung steht in `security_events`; beides ist nur für die Systemverbindung lesbar und wird nach einem Tag bzw. 90 Tagen gelöscht.

Weitere Header: Content-Security-Policy ohne `unsafe-inline`, `frame-ancestors 'none'`, HSTS (ein Jahr) sobald `COOKIE_SECURE=true` oder `PUBLIC_URL` mit `https://` beginnt. Mails zu vertraulichen Ideen tragen im Betreff nur „Idee #Nummer“; in der App bleibt der volle Betreff sichtbar. Die CI bricht bei Abhängigkeiten mit Befund ab Stufe „high“ ab.

## Kennzahlen und Alarme

Health-Checks (0.4.0): `GET /api/health/live` (Prozess läuft) und `GET /api/health/ready` (Datenbank erreichbar, sonst 503) für Load Balancer und Container. `GET /api/health` liefert ohne Token nur `status`; mit `Authorization: Bearer <METRICS_TOKEN>` den Zustand über alle Arbeitsbereiche, ohne Namen oder Inhalte. Kennzahlen für Prometheus unter `/api/metrics` (gleiches Token); Request-IDs und Logs in [Sicherheit und Beobachtbarkeit](enterprise/sicherheit-und-beobachtbarkeit.md).

Felder von `GET /api/health` (mit Token):

| Feld | Bedeutung |
| --- | --- |
| `status` | `ok`, `degraded` (Schwelle überschritten, Liste in `alerts`) oder `unavailable` (HTTP 503, keine Datenbank) |
| `jobs.lastRunAgeSeconds`, `jobs.lastRunOk` | Alter und Ergebnis des letzten Laufs der Hintergrundregeln (Fristen, Erinnerungen, Mails, Löschfristen) |
| `aiWorker.lastRunAgeSeconds` | letzter Takt der KI-Warteschlange |
| `aiQueue.queued`, `aiQueue.running`, `aiQueue.oldestQueuedAgeSeconds`, `aiQueue.failedLastHour` | Länge der KI-Warteschlange, laufende Aufträge, ältester fälliger Auftrag, Fehlschläge |
| `aiQueue.tenantsQueued`, `aiQueue.maxQueuedPerTenant` | Arbeitsbereiche mit wartenden Aufträgen und die längste Warteschlange eines einzelnen Arbeitsbereichs (R2-49, ohne Namen) |
| `aiQueue.concurrency.instance`, `aiQueue.concurrency.perTenant` | eingestellte Parallelität (`AI_CONCURRENCY`, `AI_TENANT_CONCURRENCY`) |
| `outbox.pending`, `outbox.oldestPendingAgeSeconds` | Mails, die sofort hätten versendet werden sollen |

„degraded“ antwortet weiter mit HTTP 200, damit Render die App nicht wegen eines Mail-Rückstaus neu startet. Alarme gehen an `ALERT_EMAIL` und `ALERT_WEBHOOK_URL` (siehe Betriebshandbuch Abschnitt 4).

**Logs ohne Ideentexte:** Anfragen erscheinen ohne Query-String (keine Suchbegriffe), Fehler nur mit Typ, Code und einer Meldung ohne Werte in Anführungszeichen, der Mail-Transport `log` nur mit maskierter Adresse und Länge. Ein Test (`test/ops.test.ts`) legt eine Idee mit einem Merkwort an und prüft, dass es in keinem Log steht.

**Durchlaufzeiten (R2-41):** Das Dashboard zeigt Median und 90. Perzentil je Abschnitt (Einreichung, Gate 1, Gate 2, Umsetzung, Gate 3), eine Zeitreihe je Monat und den Ausgangswert vor dem Pilot als gestrichelte Linie. Ausgangswerte trägt die Administration unter Einstellungen › Prozess ein. Der Challenge-Bericht zeigt je Challenge Ideen, Entscheidungen, Umsetzungen und Ist-Nutzen; beides als CSV.

## Slack und Microsoft Teams (R3-16)

Chat ist ein zusätzlicher Kanal für Benachrichtigungen. Er nutzt dieselbe Outbox und dieselben Kategorien wie E-Mail. Jede Person schaltet ihn selbst unter **Mein Konto › Benachrichtigungen in Slack oder Teams** ein. Titel vertraulicher Ideen und Texte möglicher Meldungen stehen nie im Chat, nur „Idee #Nummer“ mit Link. Es fallen keine Kosten an: Slack-App und Teams-Webhooks sind kostenlos; ein Eintrag im Teams Store ist nicht nötig.

Voraussetzungen: `PUBLIC_URL` zeigt auf die öffentliche HTTPS-Adresse (Slack und Teams rufen die App von außen auf) und `SECRET_KEY` ist gesetzt (Token, Signing Secret und Webhook-Adressen werden damit verschlüsselt). Die Benachrichtigungen gehen im Takt der Hintergrundregeln (`JOB_INTERVAL_MINUTES`) raus.

### Slack einrichten (Admin des Arbeitsbereichs)

1. Im Portal **Einstellungen › Slack und Teams › Slack**: „Aktiv“ ankreuzen und speichern. Danach stehen dort die Adressen für den Slash-Befehl und für Interaktivität (`…/api/integrations/slack/<ID>/commands` und `…/interactions`).
2. Unter <https://api.slack.com/apps> › *Create New App* › *From an app manifest* den Workspace wählen und `integrations/slack/manifest.yml` einfügen. `{{PUBLIC_URL}}` und `{{WORKSPACE_ID}}` durch die Werte aus Schritt 1 ersetzen. Scopes: `chat:write`, `commands`, `users:read`, `users:read.email`, `im:write`.
3. App im Workspace installieren. Aus *Basic Information* das **Signing Secret** und aus *OAuth & Permissions* den **Bot User OAuth Token** (`xoxb-…`) kopieren.
4. Im Portal Signing Secret, Bot-Token und die **Workspace-ID** (`team_id`, beginnt mit `T`) eintragen und speichern. Anfragen aus anderen Workspaces werden dann abgewiesen.
5. Test: In Slack `/idee hilfe` eingeben. `/idee` allein öffnet das Kurzformular (Titel, Problem, Lösung), `/idee Titel | Problem | Lösung` legt direkt einen Entwurf an, `/idee antwort #12 Text` beantwortet eine Rückfrage.

So funktioniert es: Jede Anfrage von Slack wird mit dem Signing Secret geprüft (Signatur v0, höchstens 5 Minuten alt). Die Person wird über ihre E-Mail-Adresse in Slack einer aktiven Person **desselben Arbeitsbereichs** zugeordnet; ohne Treffer passiert nichts. Befehle laufen über dieselben Funktionen und Rechte wie die API. Aus dem Chat entsteht ein **Entwurf**; Nutzen, Themenfeld und die Bestätigung „kein Hinweis auf einen Verstoß“ ergänzt die Person im Portal und reicht dort ein. Benachrichtigungen kommen als Direktnachricht vom Bot, bei einer Rückfrage mit dem Knopf „Rückfrage beantworten“. Ohne Bot-Token können Personen einen eigenen eingehenden Webhook eintragen; dann gibt es nur Benachrichtigungen, keine Befehle.

### Microsoft Teams einrichten (ohne Teams Store)

Für Benachrichtigungen braucht der Arbeitsbereich nichts außer „Aktiv“. Jede Person legt sich in Teams einen Workflow an und trägt dessen Adresse im Portal ein:

1. Admin: **Einstellungen › Slack und Teams › Microsoft Teams** „Aktiv“ ankreuzen und speichern.
2. Person: In Teams *Workflows* › Vorlage „Beim Empfang einer Webhookanforderung im Chat posten“ (bzw. „Post to a chat when a webhook request is received“) anlegen, als Chat „Flow bot“ mit sich selbst wählen, die erzeugte Adresse kopieren.
3. Person: Im Portal unter **Mein Konto** Teams wählen, die Adresse einfügen, Themen wählen, speichern. Erlaubt sind nur Adressen von Microsoft (`*.logic.azure.com`, `*.powerplatform.com`, `*.powerautomate.com`, `*.webhook.office.com`) und `hooks.slack.com`.

Benachrichtigungen kommen als Adaptive Card mit Link zur Idee; bei einer Rückfrage als Rückfrage-Karte mit Antwortweg.

Ideen einreichen und Rückfragen beantworten aus Teams (zwei Wege, beide ohne Store):

- **Ausgehender Webhook (einfach, kostenlos):** Ein Team-Besitzer legt im Team unter *Apps verwalten › Ausgehenden Webhook erstellen* den Namen „Ideenportal“ und als Rückrufadresse die Adresse aus dem Portal (`…/api/integrations/teams/<ID>/messages`) an. Teams zeigt danach ein **Sicherheitstoken**; dieses im Portal eintragen. Personen schreiben im Kanal `@Ideenportal einreichen Titel | Problem | Lösung` oder `@Ideenportal antwort #12 Text`. Jede Anfrage wird per HMAC-SHA256 mit dem Token geprüft.
- **App-Paket mit Nachrichtenerweiterung (Bot):** `integrations/teams/` enthält `manifest.json` und zwei Platzhalter-Symbole. Dafür braucht es eine Bot-Registrierung in Azure (Azure Bot, Tarif F0 kostenlos, aber ein Azure-Konto). Die Microsoft-App-ID des Bots im Portal eintragen; die App prüft jede Anfrage als Bot-Framework-Token (Signatur mit den veröffentlichten Schlüsseln, Aussteller, Zielgruppe = App-ID, Ablauf). Platzhalter im Manifest ersetzen (`{{TEAMS_APP_ID}}` neue GUID, `{{BOT_APP_ID}}`, `{{PUBLIC_URL}}`, `{{PUBLIC_HOST}}`, `{{PUBLISHER_NAME}}`), als Messaging-Endpunkt des Bots die Portal-Adresse eintragen, die drei Dateien zippen und im Teams Admin Center unter *Teams-Apps › Apps verwalten › Hochladen* **für die eigene Organisation** hochladen. Die Erweiterung bietet „Idee einreichen“ (Kurzformular), „Rückfrage beantworten“ und „Konto verbinden“.

Zuordnung in Teams: Teams liefert keine E-Mail-Adresse. Jede Person verbindet ihr Teams-Konto deshalb einmal: Im Portal unter **Mein Konto** „Code erzeugen“ (10 Minuten gültig) und in Teams `verbinden CODE` schreiben (bzw. „Konto verbinden“ in der Erweiterung). Gespeichert wird nur die Entra-Objekt-ID.

### Was für den Teams Store noch fehlt (offen, Produktverantwortung)

Der Teams Store ist **nicht** umgesetzt und bewusst offen. Für eine Veröffentlichung muss der Product Owner:

1. ein Partner-Center-Konto (Microsoft 365 und Copilot Program) anlegen und den Herausgeber verifizieren (Microsoft Partner Network ID),
2. eine mehrmandantenfähige Bot-Registrierung (Entra-App, Azure Bot) im eigenen Azure-Konto anlegen und die Platzhalter im Manifest final setzen,
3. echte Symbole (Farbe 192 × 192, Umriss 32 × 32), Datenschutzerklärung, Nutzungsbedingungen und Support-Adresse bereitstellen,
4. die Store-Anforderungen prüfen (Validierung im Developer Portal, Testkonto mit Anleitung für die Prüfer, Beschreibung und Screenshots, Barrierefreiheit),
5. optional die Publisher Attestation bzw. Microsoft 365 Certification durchlaufen (für Unternehmenskunden üblich),
6. für Antworten des Bots auf normale Chatnachrichten und proaktive Rückfrage-Karten mit Antwortfeld den Bot-Connector (Token des Bots, `serviceUrl`) anbinden; heute antwortet der Bot nur in der Nachrichtenerweiterung, Textbefehle laufen über den ausgehenden Webhook.

## API und Webhooks (R3-17)

Entscheidung und Details: ADR 0008. Beschreibung der stabilen Endpunkte unter `/api/docs` (lesbar) und `/api/openapi.json` (OpenAPI 3.1); beide ohne Anmeldung erreichbar, sie enthalten keine Daten.

- **Tokens anlegen:** Admin › Einstellungen › Integrationen › API-Tokens. Name, Rollen und Gültigkeit (30 bis 365 Tage) wählen. Der Token (`ipt_…`) wird nur einmal angezeigt; im Konnektor als Geheimnis ablegen. Admin-Rechte nur, wenn sie wirklich nötig sind, und nur mit ausdrücklicher Bestätigung.
- **Aufruf:** `curl -H "Authorization: Bearer ipt_…" https://<portal>/api/ideas`. Ohne Cookie senden; Bearer und Cookie zusammen werden abgelehnt. Grenze: 300 Anfragen je Minute und Token (429 mit `Retry-After`).
- **Widerruf und Wechsel:** Token unter Integrationen widerrufen (sofort wirksam), neuen Token anlegen, Konnektor umstellen. Vor Ablauf rechtzeitig erneuern; die Liste zeigt Ablauf und letzte Nutzung. Anlage, Nutzung (stündlich) und Widerruf stehen im Protokoll.
- **Webhooks anlegen:** Integrationen › Webhooks. Nur `https`-Adressen, die aus dem Internet erreichbar sind; Adressen im internen Netz sind gesperrt (auch mit `AI_ALLOW_PRIVATE_URLS`). Braucht `SECRET_KEY`, weil das Geheimnis verschlüsselt gespeichert wird. Das Geheimnis (`whsec_…`) wird nur einmal angezeigt; „Neues Geheimnis“ ersetzt es sofort.
- **Prüfung beim Empfänger:** Kopf `X-Ideenportal-Signature: t=…,v1=…`; `v1` = HMAC-SHA256 (hex) über `<t>.<Rohtext>` mit dem Geheimnis. Zeitstempel älter als 5 Minuten ablehnen, `X-Ideenportal-Delivery` zum Entdoppeln nutzen und schnell mit 2xx antworten (Zeitlimit 10 s).
- **Zustellung:** Die App sendet alle `WEBHOOK_SECONDS` (Standard 15 s). Fehlschläge werden bis zu 6-mal wiederholt (1 min, 5 min, 30 min, 2 h, 12 h). Nach 10 Fehlversuchen in Folge schaltet das Portal den Webhook ab und benachrichtigt die Admins; nach der Reparatur unter Integrationen wieder einschalten. Das Zustellprotokoll je Webhook zeigt Ergebnis und nächsten Versuch; erledigte Einträge werden nach 30 Tagen gelöscht.
- **Ausgehende Verbindungen:** Für Webhooks muss die Instanz `https` ins Internet aufbauen dürfen (Firewall/Proxy der Kunden-IT freigeben).

## Konnektoren Jira, ServiceNow, Azure DevOps (R3-13 bis R3-15, R3-18)

- Einrichtung je Arbeitsbereich unter Einstellungen › Integrationen › Konnektoren; Anleitung je Zielsystem in `docs/konnektoren/` ([Jira](konnektoren/jira.md), [ServiceNow](konnektoren/servicenow.md), [Azure DevOps](konnektoren/azure-devops.md)).
- Braucht `SECRET_KEY` (Zugangsdaten und Rückmelde-Geheimnis werden verschlüsselt) und eine korrekte `PUBLIC_URL` (Rückmelde-Adresse und Links zur Idee).
- Ziele nur über `https` und nicht im internen Netz. Ein Jira oder ServiceNow im Firmennetz ist so nicht erreichbar; dafür braucht es einen öffentlich erreichbaren Endpunkt oder einen eigenen Betrieb mit Freigabe (offen).
- Rückmeldungen kommen an `/api/integrations/connectors/<id>/status`; die Plattform muss diesen Pfad von außen erreichbar lassen. Statusabfrage läuft im Regel-Job (`JobResult.connectors`); Fehler stehen am Konnektor („Letzter Fehler“).

## Einrichtung für die Kunden-IT: Firmen-Login und SCIM (R3-26, R3-27)

Entscheidung und Details: ADR 0002. Eingerichtet wird alles von einer Admin des Arbeitsbereichs unter **Einstellungen › Anmeldung**, ohne Entwickler. Die Seite zeigt die Umleitungs-URI und die SCIM-Adresse zum Kopieren. Voraussetzung im Betrieb: `SECRET_KEY` ist gesetzt (das Client-Geheimnis wird verschlüsselt gespeichert) und `PUBLIC_URL` ist die öffentliche `https`-Adresse.

### Microsoft Entra ID: App-Registrierung für den Firmen-Login

1. Entra Admin Center › **App-Registrierungen › Neue Registrierung**. Name z. B. „Ideenportal“, unterstützte Kontotypen: **nur Konten in diesem Organisationsverzeichnis** (Single Tenant).
2. **Umleitungs-URI:** Plattform „Web“, Adresse `https://<portal>/api/auth/oidc/callback` (genau wie unter Einstellungen › Anmeldung angezeigt; eine Adresse für alle Arbeitsbereiche).
3. **Zertifikate & Geheimnisse › Neuer geheimer Clientschlüssel**. Den Wert (nicht die ID) kopieren. Ablaufdatum notieren: vor Ablauf einen neuen Schlüssel anlegen und im Portal eintragen.
4. **Übersicht:** Anwendungs-ID (Client-ID) und Verzeichnis-ID (Tenant-ID) kopieren. Issuer im Portal: `https://login.microsoftonline.com/<Verzeichnis-ID>/v2.0` (nicht `common` oder `organizations`; das Portal prüft den Aussteller exakt).
5. **API-Berechtigungen:** Microsoft Graph, delegiert: `openid`, `profile`, `email` (Standard). Administratorzustimmung erteilen.
6. **Tokenkonfiguration** (Claims im ID-Token):
   - Optionaler Claim `email`. Ohne ihn nutzt das Portal `preferred_username` (UPN). Empfehlung: Wenn Mitarbeitende ihr `mail`-Attribut selbst ändern können, im Portal unter „Namen der Claims“ bei E-Mail `preferred_username` eintragen (Schutz vor Kontoübernahme über eine geänderte Adresse).
   - **Gruppen-Claim hinzufügen:** „Sicherheitsgruppen“ oder besser „Der Anwendung zugewiesene Gruppen“ (vermeidet die Überschreitung bei mehr als 200 Gruppen; dann sendet Entra keine Gruppen und das Portal lässt die Rollen unverändert). Entra sendet Objekt-IDs; diese im Portal unter „Gruppen und Rollen“ eintragen. Für synchronisierte Gruppen ist auch `sAMAccountName` möglich.
   - **Abteilung:** Entra legt `department` nicht standardmäßig ins ID-Token. Entweder über eine Claims-Zuordnung (Unternehmensanwendung › Einmaliges Anmelden › Attribute & Ansprüche, `user.department` als `department`) oder über SCIM (unten), das die Abteilung zuverlässig liefert.
7. **Unternehmensanwendungen › Ideenportal › Eigenschaften:** „Zuweisung erforderlich“ auf **Ja**, dann Benutzer und Gruppen zuweisen. So kommen nur freigegebene Personen ins Portal.
8. **Zweiter Faktor:** Das Portal verlangt bei Firmen-Login keine eigene Zwei-Faktor-Anmeldung, auch nicht für Admins. Die MFA muss in Entra erzwungen werden (Richtlinie für bedingten Zugriff für die App „Ideenportal“, mindestens für die Admin-Gruppe).
9. **Im Portal** (Einstellungen › Anmeldung): Firmen-Login einschalten, Issuer, Client-ID, Client-Geheimnis, erlaubte E-Mail-Domains (z. B. `firma.de`) eintragen, „Verbindung prüfen“, Gruppen → Rollen eintragen, speichern. Danach mit einem Testkonto über „Mit Firmen-Login anmelden“ testen.
10. **Lokale Konten abschalten** (optional, zuletzt): erst, wenn sich eine Admin mit dem Firmen-Login angemeldet hat. Das Portal erzwingt das.

Auf der Anmeldeseite erscheint „Mit Firmen-Login anmelden“, sobald die E-Mail-Domain bekannt ist oder der Link `https://<portal>/login?mandant=<slug>` genutzt wird. Konten entstehen bei der ersten Anmeldung (Just-in-time; abschaltbar, dann nur über SCIM oder Einladung). Ist mindestens eine Zuordnung Gruppe → Rollen eingetragen, bestimmt Entra die Rollen aller Konten aus Firmen-Login und SCIM; Änderungen wirken bei der nächsten Anmeldung bzw. SCIM-Synchronisierung.

### Microsoft Entra ID: Bereitstellung per SCIM

1. Im Portal unter Einstellungen › Anmeldung › Bereitstellung per SCIM ein **Token erzeugen** (Bezeichnung z. B. „Entra ID“). Das Token (`scim_…`) wird nur einmal angezeigt.
2. Entra Admin Center › **Unternehmensanwendungen › Ideenportal › Bereitstellung**: Modus „Automatisch“. **Mandanten-URL** `https://<portal>/scim/v2`, **Geheimes Token** = das Token aus Schritt 1. „Verbindung testen“.
3. **Zuordnungen:** Standard lassen. Wichtig: `userPrincipalName` → `userName` (die Adresse muss zu den erlaubten Domains passen; ist der UPN keine Mailadresse, nimmt das Portal `emails[type eq "work"].value`), `Switch([IsSoftDeleted]…)` → `active`, `department` → `urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department`, `displayName`, `givenName`, `surname`. Weitere Attribute (Telefon, Titel, Vorgesetzte) nimmt das Portal an, speichert sie aber nicht.
4. Gruppen bereitstellen: Zuordnung für Gruppen aktiv lassen, `displayName` und `members`. Im Portal unter „Gruppen und Rollen“ den **Gruppennamen** eintragen (SCIM liefert Namen, der Firmen-Login Objekt-IDs; beide Schreibweisen können nebeneinander stehen).
5. Bereich „Nur zugewiesene Benutzer und Gruppen synchronisieren“, Bereitstellung starten. Entra synchronisiert etwa alle 40 Minuten.
6. **Austritte:** Deaktivieren oder Entfernen der Zuweisung in Entra sperrt das Konto im Portal beim nächsten Zyklus sofort, beendet alle Sitzungen und startet die Frist bis zur Anonymisierung (Einstellungen › Prozess › Löschfristen, Standard 30 Tage). Innerhalb der Frist kann Entra das Konto wieder aktivieren.
7. **Token wechseln:** neues Token erzeugen, in Entra eintragen, altes Token im Portal widerrufen. Ein widerrufenes Token wirkt sofort nicht mehr.

### Okta

- **Firmen-Login:** Applications › Create App Integration › OIDC › Web Application. Sign-in redirect URI wie oben, Grant type „Authorization Code“ (PKCE wird vom Portal immer gesendet), Client authentication „Client secret“. Issuer: `https://<org>.okta.com/oauth2/default` (Custom Authorization Server) oder `https://<org>.okta.com` (Org Authorization Server). Gruppen: im Authorization Server einen Claim `groups` (Typ ID-Token, Filter z. B. „Starts with: Ideenportal“) anlegen; Okta sendet Gruppennamen.
- **SCIM:** Die App-Integration als SCIM-App einrichten (Provisioning › SCIM 2.0, Base URL `https://<portal>/scim/v2`, Unique identifier `userName`, Authentication „HTTP Header“ mit `Bearer <Token>`). Aktionen „Push New Users“, „Push Profile Updates“, „Push Groups“, „Deactivate Users“ einschalten. Okta deaktiviert mit `PATCH active=false`; das Portal behandelt das wie Entra.

### Grenzen, Fehlersuche und Notfallzugang

- **Rate-Limits:** Anmeldeseite und Firmen-Login 60 Anfragen je 15 min und IP (`ssoIp`), SCIM 2.000 Anfragen je Minute und Token, 20 fehlgeschlagene SCIM-Anmeldungen je 15 min und IP. Bei 429 wartet Entra und wiederholt.
- **Fehlermeldungen beim Anmelden** (`/login?sso=…`): `state` (abgelaufen, anderer Browser), `provider` (Token-Tausch oder Prüfung des ID-Tokens fehlgeschlagen; Grund ohne Tokeninhalt im Server-Log „oidc login failed“), `domain` (Adresse nicht freigegeben oder nicht bestätigt), `no_account` (Just-in-time aus, kein Konto), `inactive` (deaktiviert), `not_configured`. Abgelehnte Anmeldungen stehen als `auth.sso_refused`, erfolgreiche als `auth.sso_login` im Protokoll.
- **Domains:** Eine E-Mail-Domain gehört höchstens einem Arbeitsbereich. Ist sie schon vergeben, meldet sich die Kunden-IT beim Betrieb (vor dem SaaS-Betrieb ist ein Domain-Nachweis per DNS-TXT geplant).
- **Notfallzugang (Break-Glass):** Fällt der Identitätsanbieter aus oder hat keine Admin mehr die Rolle, schaltet der Betrieb die lokalen Konten wieder ein: `npm run identity -w server -- local-login <slug> on` (auf dem Server bzw. in der Render-Shell, mit `DATABASE_URL`). Danach meldet sich ein lokales Admin-Konto mit Passwort und Zwei-Faktor-Code an. Empfehlung: ein lokales Admin-Konto mit Adresse außerhalb der Firmen-Domains und MFA anlegen und sicher verwahren. Der Schalter steht als `identity.break_glass` im Protokoll des Arbeitsbereichs.

## Rollen je Bereich einrichten (R3-29)

Für Arbeitsbereiche mit mehreren Triage-Teams oder Gremien, z. B. je Geschäftsbereich oder Standort. Ohne Bereiche gelten alle Rollen wie bisher für den ganzen Arbeitsbereich. Keine Umgebungsvariable nötig; Migration `022_scoped_roles.sql` läuft beim Start.

1. **Bereiche anlegen** (Admin, Einstellungen › Bereiche): Name, optional Beschreibung, Themenfelder und Organisationseinheiten (eine je Zeile, wie im Feld „Organisationseinheit“ der Personen bzw. der Abteilung aus Firmen-Login und SCIM; Groß- und Kleinschreibung egal). Eine Idee gehört zu jedem Bereich, dessen Themenfelder ihr Themenfeld enthalten oder dessen Einheiten die Einheit der einreichenden Person enthalten. Ideen ohne Bereich sehen nur mandantenweite Rollen; deshalb mindestens eine Person mit mandantenweiter Triage behalten.
2. **Rollen vergeben** (Einstellungen › Bereiche › Rollen je Bereich): Person, Rolle (Triage, Gremium, Bereichsleitung) und Bereich wählen. Eine Person kann mehrere Bereiche haben. Mandantenweite Rollen bleiben unter Einstellungen › Personen; hat jemand dieselbe Rolle mandantenweit und mit Bereich, gilt die mandantenweite.
3. **Mit Firmen-Login oder SCIM** (Einstellungen › Anmeldung › Gruppen und Rollen): je Zeile in der Spalte „Bereich“ einen Bereich wählen. Die Gruppe vergibt dann nur Triage, Gremium oder Bereichsleitung und nur für diesen Bereich (z. B. `GRP-Ideen-Triage-Nord` → Triage, Bereich „Werk Nord“). Diese Rollen werden bei jeder Anmeldung und SCIM-Synchronisierung neu berechnet und erscheinen unter Einstellungen › Bereiche mit dem Hinweis „aus Gruppe“; von Hand vergebene Bereichsrollen bleiben daneben bestehen.
4. **Prüfen:** Mit einem Testkonto das Board öffnen (Hinweis „Du siehst die Ideen deiner Bereiche“) und das Dashboard (Filter „Bereich“). Die Seite Mitbestimmung und die erzeugte Betriebsvereinbarung (Anlage 4) zeigen die Bereiche mit der Zahl der Personen je Rolle.

Wirkung: Board, Gate 1 und 2, vertrauliche Ideen, „Meine Aufgaben“, Benachrichtigungen an Rollen, Erinnerungen und Eskalationen der Fristen und das Dashboard folgen dem Bereich. Hinweise ohne Bezug zu einer Idee (z. B. Antwortgarantie unterschritten, Sitzungsunterlagen) gehen an alle Personen der Rolle. Änderungen an Bereichen stehen im Protokoll (`area.create`, `area.update`, `area.delete`, `user.scoped_roles`) und im Änderungsverlauf der Seite Mitbestimmung. Ändert sich das Themenfeld einer Idee oder die Einheit einer Person, ändert sich die Zuordnung sofort (sie wird nicht gespeichert, sondern bei jeder Abfrage berechnet).

## Suche und Dubletten (R3-28)

- **Volltextsuche** und **Cursor-Paginierung** brauchen keine Einrichtung (Migration `017_search.sql`). Listen der API liefern mit `limit` (höchstens 200) und `cursor` die Form `{ items, nextCursor }`; ohne diese Parameter bleibt die bisherige Antwort.
- **Erweiterung `vector` (pgvector)** schaltet die semantische Dublettenprüfung ein. Ohne sie nutzt die Dublettenprüfung die Trigramm-Ähnlichkeit; das reicht bis einige tausend Ideen je Arbeitsbereich, ab etwa 5.000 Ideen wird sie spürbar langsamer (Lasttest: 0,5 s statt 12 ms, `docs/release-3/lasttest.md`).
- **Einschalten:** Die Erweiterung muss auf dem Datenbankserver installiert sein und von einem Nutzer mit ausreichenden Rechten angelegt werden: `CREATE EXTENSION IF NOT EXISTS vector;` in der Datenbank des Portals. Beim nächsten Start stellt die App die Spalte `idea_embeddings.embedding` auf `vector(256)` um und legt den HNSW-Index an (Funktion `enable_vector_search()`); die Hintergrundregeln berechnen die Embeddings (bis 2.000 Ideen je Lauf und Arbeitsbereich). Kontrolle: `SELECT extversion FROM pg_extension WHERE extname = 'vector';` und das Feld `embeddings` im Ergebnis von „Hintergrundregeln ausführen“.
- **Render:** PostgreSQL bei Render unterstützt `vector`. In der Render-Shell oder per `psql` mit der externen Verbindungs-URL als Datenbanknutzer des Dienstes `CREATE EXTENSION IF NOT EXISTS vector;` ausführen, dann den Dienst neu starten (nicht auf Render getestet).
- **Andere verwaltete Datenbanken:** Bei AWS RDS/Aurora, Azure Database for PostgreSQL (Flexible Server: zuerst `vector` im Serverparameter `azure.extensions` freigeben), Google Cloud SQL und Supabase ist pgvector verfügbar; anlegen mit dem Administrationsnutzer der Datenbank.
- **Eigene VM oder Docker:** Paket `postgresql-16-pgvector` installieren oder in `docker-compose.yml` das Image `pgvector/pgvector:pg16` statt `postgres:16-alpine` verwenden (bei vorhandenem Datenvolumen vorher mit `pg_dump` sichern und zurückspielen, weil sich die Sortierregeln von Alpine und Debian unterscheiden). Ist der App-Nutzer Superuser (wie im Docker-Compose-Beispiel), legt die Migration die Erweiterung selbst an.
- **Lasttest:** `npm run loadtest --workspace server` gegen eine eigene, leere Datenbank (`docs/release-3/lasttest.md`).

## Compliance: EU-Hosting, Verschlüsselung, Rechtstexte (R3-08, R3-11)

Keine Rechtsberatung. Alle Rechtstexte sind Entwürfe; die Prüfung durch eine Kanzlei ist offen (PO).

- **EU-Region:** `render.yaml` legt alle Dienste und Datenbanken in `frankfurt` an; ein Test (`server/test/compliance.test.ts`) bricht die CI, wenn eine andere Region auftaucht. Bei anderen Anbietern eine EU-Region wählen und `HOSTING_PROVIDER`, `HOSTING_REGION`, `HOSTING_LOCATION` setzen.
- **Verschlüsselung bei der Übertragung:** HTTPS am Rand des Hosters, HSTS ab `COOKIE_SECURE=true` oder `PUBLIC_URL` mit `https`. Zur Datenbank: Bei Render läuft die interne Verbindung im privaten Netz; für Datenbanken über das Internet oder bei anderen Anbietern `DATABASE_SSL=require` setzen (mit `DATABASE_SSL_CA`, wenn der Anbieter eine eigene CA nutzt).
- **Verschlüsselung gespeicherter Daten:** Datenträger und Sicherungen verschlüsselt der Hoster (bei Render laut Anbieter; Nachweis im AVV des Hosters prüfen). Zusätzlich verschlüsselt die App alle gespeicherten Geheimnisse mit `SECRET_KEY` (AES-256-GCM). Ohne `SECRET_KEY` zeigt Einstellungen › Rechtliches „nein“.
- **Rechtstexte im Produkt:** Vorlagen unter `server/templates/legal/` (AGB, Datenschutzerklärung, TOM, DSFA-Muster, AVV), versioniert über die Kopfzeile `<!-- template: name, version JJJJ-MM-TT.n -->`. AGB und Datenschutzerklärung sind öffentlich unter `/rechtliches` (API `GET /api/legal`, `GET /api/legal/{name}?format=json|md|pdf`). TOM, DSFA-Muster und AVV füllt die App mit den Einstellungen des Arbeitsbereichs; Admins finden sie unter Einstellungen › Rechtliches (`GET /api/admin/compliance/documents/{name}`).
- **Neue Fassung veröffentlichen:** Text ändern, Version in der Kopfzeile erhöhen (Datum und laufende Nummer), deployen. Admins sehen „aktuelle Fassung noch nicht bestätigt“ und bestätigen AGB (und auf Wunsch den AVV) mit einem Klick; die Bestätigung steht mit Version, Person und Zeit in `legal_acceptances` und im Audit-Log (`legal.accept`).
- **Unterauftragnehmer:** Liste aus Hosting, Mail-Dienst und den KI- und Suchanbietern des Arbeitsbereichs, mit Ort und Vertragsverhältnis (Unterauftragnehmer des Anbieters bei Plattform-Schlüssel, eigener Vertrag des Kunden bei eigenem Schlüssel, kein Unterauftragnehmer bei eigenem Betrieb). Export als CSV oder JSON (`GET /api/admin/compliance/subprocessors?format=csv`). Die Liste ist zugleich Anlage 2 des AVV.

## Erfindungsmeldungen (R3-25)

- Zielkanal der Art „Patentstelle“ unter Einstellungen › Zielkanäle anlegen (Kontakt der Patent- oder IP-Abteilung).
- In der Idee sieht das Triage-Team die Prüffrage „Mögliche Erfindung?“ mit Hinweisen aus Patentrecherche (R2-24), Risiko-Check (R2-29) und dem Text. „Ja“ stoppt die Websuche für die Idee (Protokoll „übersprungen“ im KI-Protokoll).
- Weiterleiten an die Patentstelle setzt die Idee vertraulich und vermerkt den Fristhinweis (Standard 4 Monate nach § 6 Abs. 2 ArbnErfG ab Eingang einer ordnungsgemäßen Meldung; Einstellung `invention.claimMonths`, Schalter `invention.enabled`). Die Frist führt die Patentstelle; das Portal erinnert nicht selbst. Keine Rechtsberatung.

## Sicherheitsprüfungen (R3-09)

- CI: `npm audit --audit-level=high`, `npm audit signatures` (Signaturen der Pakete aus der Registry), `npm run check:security` (statische Prüfung ohne Abhängigkeiten, `tools/check-security.mjs`; `--list` zeigt dynamisches SQL zur Durchsicht).
- Selbsttest im Stil von OWASP: `server/test/security-selfcheck.test.ts` (Header, Cookies, CSRF, CORS, Rate-Limits, Fehlermeldungen, Rechte, IDOR zwischen zwei Mandanten) läuft mit `npm test`.
- Sicherheitskonzept: `docs/sicherheit/sicherheitskonzept.md`; Vorbereitung des externen Penetrationstests: `docs/sicherheit/pentest-vorbereitung.md`. Der externe Test selbst ist offen (Entscheidung PO).

## SaaS-Betrieb: Schlüssel, Support und Statusseite (R3-01, R3-41, R3-07, R3-10)

### Eigener Schlüssel je Arbeitsbereich (R3-01)

Jeder Arbeitsbereich hat einen eigenen zufälligen Datenschlüssel (AES-256, Tabelle `tenant_keys`). Er wird mit `SECRET_KEY` verpackt gespeichert („Envelope-Verschlüsselung“) und verschlüsselt alle Geheimnisse des Arbeitsbereichs (`lib/secretbox.ts`, Format `v2.`): KI- und Suchschlüssel, TOTP-Geheimnisse, Slack- und Teams-Geheimnisse, Webhook-Geheimnisse, Client-Geheimnis des Firmen-Logins. Die Mandanten-ID ist in jeden Wert eingebunden; ein in einen anderen Arbeitsbereich kopierter Wert lässt sich dort nicht öffnen. Die App-Rolle liest per RLS nur den eigenen Schlüssel und kann ihn nicht ändern.

- Neue Arbeitsbereiche bekommen den Schlüssel bei der Anlage (Betreiberkonsole) oder beim ersten Geheimnis; bestehende beim Start.
- Ältere Werte (`v1.`, direkt mit `SECRET_KEY` verschlüsselt) stellt der Start auf den Mandantenschlüssel um (Log `secrets moved to tenant keys`).
- Neue Spalten mit Geheimnissen: Namen auf `_enc` enden lassen (werden dann automatisch erkannt) oder in `SECRET_COLUMNS` eintragen, und `sealSecret`/`openSecret` verwenden.

### `SECRET_KEY` wechseln (R3-41)

Die Rotation verpackt nur die Datenschlüssel neu; die Geheimnisse selbst bleiben unverändert. Sie läuft in Stapeln zu 100 Arbeitsbereichen, jeder Stapel in einer Transaktion, und überspringt bereits umgestellte Schlüssel (Fingerabdruck `master_fp`): Ein Abbruch schadet nicht, ein zweiter Lauf macht weiter.

1. Neuen Wert erzeugen, z. B. `openssl rand -base64 48`.
2. In Render (oder der Umgebung) setzen: `SECRET_KEY=<neu>`, `SECRET_KEY_PREVIOUS=<alt>`; neu starten. Die App liest jetzt beide Schlüssel, es gibt keinen Ausfall.
3. Rotation starten (Render: Shell; lokal mit derselben `DATABASE_URL`):
   `SECRET_KEY_OLD=<alt> SECRET_KEY_NEW=<neu> npm run rotate-key -w server`
   Ausgabe: `rotation finished: N re-wrapped, M already on the new key, K older values converted`.
4. In der Betreiberkonsole prüfen, dass kein Arbeitsbereich mehr „alter SECRET_KEY“ zeigt (Hinweis „Schlüsselwechsel nicht abgeschlossen“ verschwindet).
5. `SECRET_KEY_PREVIOUS` entfernen und neu starten. Den alten Wert vernichten.

Bricht der Lauf mit „wrapped with an unknown key“ ab, wurde dieser Schlüssel mit einem dritten Wert verpackt; dann mit dem richtigen alten Wert erneut starten. Ein Restrisiko bleibt: Wer den alten `SECRET_KEY` und eine alte Datenbanksicherung hat, kann die alten Datenschlüssel öffnen. Neue Datenschlüssel je Arbeitsbereich mit Neuverschlüsselung sind als Folge-Maßnahme offen (Bedrohungsmodell T-I19).

### Versionierte Einstellungen (R3-41)

`GET /api/admin/settings` liefert `version` und den Header `ETag`. `PUT` mit `If-Match: "<version>"` oder dem Feld `version` im Inhalt antwortet mit 409 `SETTINGS_CONFLICT`, wenn inzwischen jemand anders geändert hat; die Oberfläche zeigt die Meldung und lädt die aktuelle Fassung. Jede Änderung von `tenants.settings` erhöht die Version per Trigger, auch über KI-Einstellungen und Mitbestimmung. Skripte ohne Versionsangabe ändern wie bisher.

### Betreiberkonsole (R3-07)

Unter `/betrieb` (eigene Anmeldung, unabhängig von den Arbeitsbereichen):

1. `npm run operator -w server -- setup` erzeugt `OPERATOR_TOKEN` und `OPERATOR_TOTP_SECRET` (mit `otpauth://`-Adresse für die Authenticator-App). Beide als geheime Umgebungsvariablen setzen und neu starten. Es gibt keine Standardwerte; ohne beide ist die Konsole aus.
2. Anmelden mit Zugangsschlüssel und aktuellem Code. Ein Code gilt nur einmal; 10 Versuche je 15 Minuten und IP. Die Sitzung gilt 4 Stunden (`OPERATOR_SESSION_HOURS`) und nur für `/api/operator`.

Die Konsole zeigt:

- **Übersicht:** Zustand der Plattform (Bestandteile, offene Alarme aus `/api/health`, Hinweis auf fehlenden `SECRET_KEY` oder unvollständige Rotation) und je Arbeitsbereich Nutzung (Personen, Ideen, letzte Anmeldung), KI-Warteschlange, Kosten im laufenden Monat, Fehler der letzten 24 Stunden (KI-Aufträge und -Aufrufe, Webhooks), offene Mails, Stand des Schlüssels und eine laufende Support-Freigabe. Keine Inhalte.
- **Neuer Arbeitsbereich:** Name, optional Kurzbezeichnung, erste Admin und Sprache. Der Arbeitsbereich bekommt sofort seinen Schlüssel; die Admin erhält eine Einladung (24 h) und muss die Zwei-Faktor-Anmeldung einrichten. Ohne Mailversand zeigt die Konsole den Einladungslink.
- **Statusmeldungen** für die Statusseite (siehe unten) und das **Protokoll** der Betreiberaktionen (`operator_log`).

### Support-Zugriff nur mit Freigabe (R3-07)

Kundendaten sieht der Support nur, wenn eine Admin des Arbeitsbereichs unter **Einstellungen › Support-Zugriff** eine befristete Freigabe erteilt (1 Stunde bis 7 Tage, mit Grund, jederzeit beendbar). Ablauf im Support:

1. Kundin bittet um Hilfe; Support bittet um Freigabe mit der Nummer der Anfrage als Grund.
2. In der Übersicht erscheint „Daten ansehen (bis …)“. Die Support-Ansicht zeigt Personen (Name, Adresse, Rollen, Zustand), die letzten 50 Ideen (vertrauliche nur mit Nummer), fehlgeschlagene KI-Aufträge, Webhooks und die letzten Einträge im Protokoll. Sie liest über die Row-Level-Security des Arbeitsbereichs.
3. Jeder Aufruf steht im Protokoll des Arbeitsbereichs (`support.access`, mit Betreiber und Freigabe) und unter Einstellungen › Support-Zugriff.
4. Nach Ende der Freigabe oder Widerruf antwortet die Konsole mit 403.

Änderungen an Kundendaten macht der Support nicht über die Konsole; die Kundin ändert selbst oder beauftragt schriftlich.

### Statusseite und Verfügbarkeit (R3-10)

`/status` ist öffentlich (ohne Anmeldung) und nutzt `GET /api/status`:

- **Zustand je Bestandteil:** Anwendung und Schnittstelle, Fristen und Erinnerungen, KI-Analysen, E-Mail-Versand; abgeleitet aus `/api/health` (Hintergrundregeln überfällig = Ausfall, letzter Lauf fehlgeschlagen = eingeschränkt; KI-Takt seit 10 Minuten still = Ausfall, Warteschlange über Schwelle = eingeschränkt; Mail-Rückstau = eingeschränkt). Keine Zahlen, keine Namen. 30 Sekunden zwischengespeichert.
- **Meldungen:** Störungen (Einschränkung oder Ausfall) und Wartungen schreibt der Betrieb in der Konsole; eine aktive Meldung setzt die betroffenen Bestandteile auf „eingeschränkt“, „Ausfall“ oder „Wartung“. Angekündigte Wartungen und behobene Meldungen der letzten 14 Tage stehen darunter.
- **Verfügbarkeit:** Die App speichert im Takt `ALERT_CHECK_MINUTES` (Standard 5) eine Messung (`status_checks`, eine je Takt auch bei mehreren Instanzen, Aufbewahrung 121 Tage). Je Tag (UTC) gilt: verfügbar = Messungen mit erreichbarer Anwendung ÷ erwartete Messungen; **fehlende Messungen zählen als nicht verfügbar**, angekündigte Wartungen werden aus der Messzeit herausgerechnet, vor der ersten Messung gibt es keine Daten. Angezeigt werden 90 Tage, der Gesamtwert und der laufende Monat (Grundlage der SLA-Berechnung).

Einschränkung: Die Messung läuft in der App selbst. Fällt die ganze App aus, fehlen Messungen und der Tag sinkt, aber die Statusseite ist in dieser Zeit selbst nicht erreichbar. Für den Marktstart einen externen Prüfdienst (z. B. Uptime-Kuma auf einer zweiten Maschine oder ein Dienst mit EU-Standort) auf `/api/health` richten und bei Ausfall eine Meldung anlegen. Die Zusage steht in `docs/release-0/business/vertragsgrundlagen.md` (Abschnitt 4).

## Pakete und Abrechnung (R3-05, R3-06, R3-02, R3-03, R3-39)

Abgerechnet wird **ohne Zahlungsanbieter**: Das Portal kennt Pakete, Funktionsschalter, KI-Kontingent und Testphase und erzeugt Rechnungs**entwürfe**. Der Betreiber prüft sie und versendet sie selbst. Welcher Zahlungsanbieter später angebunden wird, ist offen (Produktverantwortung).

- **Pakete** (`server/src/lib/plans.ts`): Team 590 € (bis 500 MA), Business 1.490 € (bis 1.000 MA) und 2.490 € (bis 2.500 MA), Enterprise ab 3.990 € (Staffel +500 € je weitere angefangene 1.000 MA über 5.000, Annahme), Challenge-Paket 2.500 € einmalig. Preise netto pro Monat, zzgl. 19 % USt. Arbeitsbereiche ohne Paket (eigener Betrieb, Demo) gelten als „Intern“: alle Funktionen, kein Kontingent.
- **Paket setzen:** Betreiberkonsole `/betrieb` › Pakete und Abrechnung › Bearbeiten. Paket, Mitarbeitende, Beginn, eigenes KI-Kontingent und Abweichungen bei einzelnen Funktionen (z. B. SSO für einen Team-Kunden) lassen sich einstellen. Anfragen der Admins (Einstellungen › Paket) erscheinen in der Spalte „Anfrage“. Jede Änderung steht im Betreiberprotokoll und in `plan_changes`.
- **Funktionsschalter:** API, Webhooks, SSO, SCIM, Slack/Teams, Konnektoren, externe Beteiligung, Feature-Wünsche, Crowd-Bewertung und **Modul Z** (immer aus, ohne Code dahinter). Server-Routen prüfen den Schalter zentral (`enforcePlan` in `server/src/services/billing.ts`, Fehler `FEATURE_UNAVAILABLE`); die Oberfläche blendet nicht enthaltene Funktionen aus und zeigt einen Upgrade-Hinweis. Nach einem Wechsel in ein kleineres Paket werden bestehende Chat- und Webhook-Zustellungen nicht abgeschaltet, nur neue Einrichtungen gesperrt.
- **KI-Kontingent:** Vollanalysen je Monat (Team 5, Business 20/40, Enterprise 80, Challenge 10 für die Laufzeit, Testphase 5). Gezählt werden nur Vollanalysen mit externen Modellen; eingebaute und eigene (lokale) Modelle sind frei. Bei 80 % und 100 % bekommen die Admins einmal im Monat eine Mail. Bei 100 % startet keine weitere Vollanalyse mit externem Modell (`AI_QUOTA`); die Idee läuft ohne KI weiter. **Aufstockung** bucht der Betreiber in der Konsole (Anzahl und Preis); sie gilt für den laufenden Monat und erscheint auf der Rechnung.
- **Rechnungsentwürfe:** Der Hintergrundjob erzeugt am Monatsanfang Entwürfe für den Vormonat (Lizenz voller Monat ohne anteilige Berechnung, plus Aufstockungen). Nummern `IP-JJJJ-NNNNN`. In der Konsole lassen sich Entwürfe für einen Monat neu berechnen. Admins sehen ihre Entwürfe unter Einstellungen › Paket, beide als PDF.
- **Testphase:** Selbstregistrierung startet 30 Tage mit Beispieldaten und allen Funktionen außer Modul Z. Banner mit Resttagen, Mails 7 Tage und 1 Tag vor dem Ende. Danach ist der Arbeitsbereich **nur lesbar** (`READ_ONLY`), bis der Betreiber ein Paket setzt; Export, Anmeldung und „Mein Konto“ bleiben möglich.
- **Challenge-Paket:** eine Challenge, 8 Wochen, Jury. Am Ende wird der Arbeitsbereich nur lesbar, die Admins bekommen Export (CSV/PDF unter Einstellungen › Paket) und das Angebot für die Jahreslizenz. Die Konsole zeigt die Umwandlungsquote für Challenge-Paket und Testphase.
- **KI-Vorschlag für den Prozess (R3-03):** Einstellungen › Prozess mit KI. Ohne externes Modell antwortet ein regelbasierter Vorschlag; übernommen wird erst nach Bestätigung, alle Werte bleiben unter Prozess änderbar.

## Wirkung und Lernen (R4-04, R4-06, R4-07)

- **Kennzahlen vorher und nachher (R4-04):** Pate, Einreichende, Triage oder Gremium legen sie an Gate 2 fest (Steckbrief › Wirkung, solange die Idee in Ausarbeitung ist): Name, Einheit, Richtung, Quelle, Vorher-Zeitraum. Quellen: **Konnektor** (Anzahl der Treffer einer JQL, ServiceNow-Abfrage oder WIQL; `{from}` und `{to}` werden durch die Daten des Zeitraums ersetzt; braucht das Paketmerkmal Konnektoren), **API** (anderes System meldet Werte an `POST /api/impact-metrics/<id>/values` mit einem API-Token der Rolle Umsetzung) oder **von Hand**. Der Regel-Job misst den Vorher-Wert, sobald der Zeitraum vorbei ist, und nach dem Abschluss der Umsetzung alle `learning.measureEveryDays` Tage (Standard 30) einen gleich langen Nachher-Zeitraum (`JobResult.metrics`). Fehler stehen an der Kennzahl. Im Reiter Wirkung steht daraus der Entwurf für den Wirkungsbericht an Gate 3.
- **Aufwandsschätzung (R4-06):** Referenzen sind abgeschlossene, nicht vertrauliche Ideen mit Aufwand (Ist-Aufwand beim Abschluss der Umsetzung, sonst Schätzung), gefunden mit dem lokalen Ähnlichkeitsmodell der Dublettensuche. Spanne erst ab `learning.effortMinReferences` (mindestens 5) Referenzen.
- **Kalibrierung (R4-07):** Seite `/kalibrierung` (Link im Portfolio) und Trefferband in der Gremiumssitzung. Erst ab `learning.calibrationMinClosed` (mindestens 20) abgeschlossenen Ideen mit Plan- und Ist-Nutzen in Euro; Quartale und Gruppen unter der Mindestgruppengröße (5) nur mit Anzahl. Treffer = Ist höchstens `learning.hitTolerancePercent` (Standard 20 %) neben der Prognose.
- **Testdaten:** `npm run seed:learning -w server -- <slug> [Anzahl]` legt abgeschlossene Ideen mit Plan- und Ist-Nutzen, Aufwand und Ideentyp an (Kennzeichen „Testdaten (AP-28)“ im Nutzen-Text). Nur für Demo, Pilotvorbereitung und Tests, nicht in produktiven Arbeitsbereichen.

## Erkennen: Trendradar, Trendhinweise, weiße Flecken, Problem-Radar (R4-11, R4-02, R4-03, R4-01)

- **Seite `/radar`** (Navigation „Radar“ für Innovationsleitung, Triage, Gremium, Admin; Sponsor:innen ohne diese Rollen sehen nur ihre Trendhinweise). Einstellungen `settings.radar` über `PUT /api/radar/settings` (Admin): `trendHints` (an/aus), `weekday` (1 = Montag), `queriesPerTopic` (1–5), `whiteSpotMonths`, `minClusterSize` (Problem-Radar, Standard 3; für Beschäftigtendaten 5 empfohlen), `maxTickets` (je Lauf), `ticketDays`.
- **Trendhinweise (R4-02):** brauchen eine Websuche (Einstellungen › KI › Websuche: Brave oder SearXNG). Ohne Websuche stellt der Job nichts ein. Sponsor:innen je Themenfeld pflegt die Innovationsleitung unter `/radar` › Trendhinweise. Der Regel-Job stellt einmal je ISO-Woche den KI-Auftrag `trend_digest` ein (`JobResult.trendHints`), der Worker sucht, fasst zusammen und verschickt (Kategorie `trends`). Kosten: `queriesPerTopic` Suchanfragen je Themenfeld mit Empfänger:innen und Woche plus ein Aufruf des Agenten `trend_digest` (Slot „schnell“).
- **Problem-Radar (R4-01):** Ticket-Quelle = aktiver Konnektor (Einstellungen › Integrationen) plus Filter (Jira: JQL; ServiceNow: Tabelle, Standard `incident`, und Encoded Query; Azure DevOps: Arbeitselementtyp). Das Zugangskonto des Konnektors braucht **Leserechte** auf diese Tickets; gelesen werden nur Titel und Beschreibung. Abruf nur per Klick („Abrufen und auswerten“), nicht im Hintergrund; braucht das Paketmerkmal Konnektoren. CSV-Feedback geht ohne Konnektor (Spalten Titel/Text). Clustering immer über das Modell „Vertraulich“ (eigenes Hosting) oder das eingebaute Verfahren. Rohdaten werden nicht gespeichert.
- **KI-Bausteine:** `trend_digest`, `trend_assign`, `problem_clusters` sind unter Einstellungen › KI einzeln abschaltbar und ohne Testsatz freigegeben (Ergebnisse sind Vorschläge bzw. Zählungen).

## Staging

`render.yaml` legt neben der Demo einen zweiten Dienst `ideenportal-staging` mit eigener Datenbank an. Er baut aus dem Branch `staging`, hat keine Selbstregistrierung und schreibt Mails nur ins Protokoll. Ablauf: Änderung nach `staging` mergen, dort prüfen, dann nach `main`. Hinweis: Render erlaubt je Konto nur eine kostenlose Datenbank; für Staging einen bezahlten Datenbankplan wählen oder Staging in einem zweiten Konto anlegen (nicht getestet).

## Laufende Aufgaben

- **KI-Warteschlange:** Analysen laufen im Hintergrund (alle `AI_WORKER_SECONDS`), mit Datenbanksperre, drei Versuchen und Rückfall auf „nicht ausgeführt“, wenn ein Limit greift. Bis zu `AI_CONCURRENCY` Aufträge laufen je Instanz gleichzeitig, je Arbeitsbereich höchstens `AI_TENANT_CONCURRENCY`; der nächste freie Platz geht an den Arbeitsbereich, der am längsten keinen Auftrag mehr gestartet hat (Round-Robin). Ein Arbeitsbereich mit vielen Aufträgen blockiert so die anderen nicht.
- **Hintergrundregeln** laufen in der App alle 15 Minuten, mit Datenbanksperre auch bei mehreren Instanzen nur einmal.
- **Löschfristen** stellt jeder Arbeitsbereich unter Einstellungen > Prozess ein; der Job löscht abgeschlossene Ideen, alte Benachrichtigungen und anonymisiert deaktivierte Konten.
- **Sicherung:** Bei Render übernimmt der Anbieter tägliche Sicherungen der Datenbank (je nach Plan; der kostenlose Plan sichert nicht). Auf einer eigenen VM `pg_dump -Fc` täglich sichern. Die Rücksicherung ist einmal getestet (Protokoll im [Betriebshandbuch](release-0/technik/betriebshandbuch.md), Abschnitt 3) und wird monatlich wiederholt.
- **Prüfung:** `npm test` (API, Mandantentrennung, Fristen, Rechte) und `e2e/smoke.mjs` (Browser, Barrierefreiheit) laufen in der CI.

## Datenschutz im Pilot

- Arbeitsbereiche sind per Row-Level-Security getrennt; jeder Arbeitsbereich kann alle Daten exportieren und sich selbst löschen (Einstellungen > Daten).
- Personen laden ihre Daten unter „Mein Konto“ herunter; Admins erteilen Auskunft und anonymisieren Konten unter Einstellungen > Personen.
- In der öffentlichen Demo keine echten Daten eingeben; sie wird täglich zurückgesetzt.
