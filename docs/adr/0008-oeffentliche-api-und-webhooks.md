# ADR 0008 – Öffentliche API und Webhooks

**Status:** angenommen (13.10.2026), gebaut mit AP-12 (R3-17)

## Kontext

Konnektoren (Teams/Slack R3-16, ServiceNow, Jira, CRM R3-13 bis R3-18) und eigene Integrationen der Kunden sollen auf derselben API laufen wie die Oberfläche (Leitplanke „API zuerst“). Dafür braucht es eine Anmeldung ohne Browser, eine Beschreibung der stabilen Endpunkte und Meldungen bei Änderungen, damit niemand die API abfragen muss. Mandantentrennung, Rollen, Vertraulichkeit und Audit gelten unverändert.

## Entscheidung

### API-Tokens

- **Je Mandant, mit Rollen.** Ein Admin legt unter Einstellungen › Integrationen einen Token mit Name, Rollen (Teilmenge der bestehenden Rollen) und Ablauf (1 bis 365 Tage, Standard 90) an. Die Rolle Admin braucht eine zweite, ausdrückliche Bestätigung (`allowAdmin`), sonst lehnt der Server ab.
- **Technischer Benutzer.** Jeder Token bekommt einen eigenen Eintrag in `users` (`technical = true`, inaktiv, ohne Passwort, Name „<Token> (API)“). Ideen, Kommentare und Entscheidungen über die API tragen ihn als Handelnden; er erscheint nicht in der Personenliste, bekommt keine Mails und kann sich nicht anmelden.
- **Format und Speicherung.** `ipt_<prefix>_<geheim>`: 12 Hex-Zeichen Präfix (öffentliche Kennung zum Nachschlagen) und 256 Bit Zufall. Gespeichert wird nur `sha256(token)`; der Vergleich läuft zeitkonstant. Der Token wird genau einmal angezeigt.
- **Anfrage.** `Authorization: Bearer <token>` auf `/api/*`. `sessionFromRequest()` erkennt den Bearer und liefert den technischen Benutzer; danach läuft alles wie bei einer Sitzung über `tenantHandler()` → `withTenant()` als `ideenportal_app` mit Row-Level-Security und den Rollenprüfungen der Fachlogik.
- **Bearer und Cookie nie zusammen.** Eine Anfrage mit Bearer und Sitzungs-Cookie wird mit 400 `BEARER_WITH_COOKIE` abgelehnt. Bearer-Anfragen tragen kein Cookie, darum gilt die CSRF-Regel (JSON-Inhaltstyp oder `X-Requested-With`) für sie nicht.
- **Gesperrte Pfade.** Tokens dürfen nicht an `/api/auth/*`, `/api/me/*`, `/api/demo/*`, die Token- und Webhook-Verwaltung und das Löschen des Arbeitsbereichs (403 `TOKEN_NOT_ALLOWED`). Ein Token kann also keine weiteren Tokens erzeugen.
- **Ablauf, Widerruf, Audit.** Abgelaufene und widerrufene Tokens geben 401 `TOKEN_INVALID`. Audit-Log: `api_token.create`, `api_token.revoke` und `api_token.use` (höchstens einmal je Stunde und Token, damit das Log nicht überläuft); `last_used_at` bei jeder Anfrage.
- **Rate-Limit.** 300 Anfragen je Minute und Token (Bucket `apiToken` in `lib/ratelimit.ts`, skaliert mit `RATE_LIMIT_FACTOR`).

### OpenAPI

- `GET /api/openapi.json` liefert OpenAPI 3.1, erzeugt zur Laufzeit aus denselben zod-Schemas, mit denen die Routen prüfen (`z.toJSONSchema`, JSON Schema 2020-12 = Dialekt von OpenAPI 3.1). Keine neue Abhängigkeit.
- `GET /api/docs` ist eine statische HTML-Seite ohne Skripte (CSP `script-src 'self'` bleibt streng), Stylesheet unter `/api/docs.css`. Texte aus dem Katalog (`server/src/i18n/*/api.ts`) in der Sprache der Anfrage.
- **Stabil** sind die beschriebenen Endpunkte: Ideen (Liste, Detail, Anlegen, Ändern, Einreichen, Status, Kommentar, Gate 1, Gate 2), Challenges (Liste, Detail, Anlegen), Tokens und Webhooks. **Alle anderen** `/api`-Endpunkte dienen der Oberfläche, sind intern und können sich ohne Ankündigung ändern; das steht in der Beschreibung.
- Neu für Konnektoren: `GET /api/ideas/{id}/status` mit Status und Statusverlauf, Sichtbarkeit wie die Detailansicht.
- Antwortschemas sind Dokumentationsschemas in `services/openapi.ts` (lockere Objekte mit den wichtigsten Feldern); Anfrageschemas sind die echten Prüfschemas.

### Webhooks

- **Abonnements je Mandant** (`webhook_subscriptions`): Name, URL, Ereignisse, verschlüsseltes Geheimnis (`lib/secretbox.ts`, `SECRET_KEY` nötig), Zustand, Fehlerzähler.
- **Ereignisse:** `idea.submitted`, `idea.status_changed` (jeder Statuswechsel über `setStatus`), `idea.gate_decided` (Gate 1, 2 und 3 mit Ergebnis), `challenge.phase_changed`. Dazu `webhook.test` auf Knopfdruck.
- **Outbox.** Das Ereignis wird in derselben Transaktion wie die Änderung in `webhook_deliveries` geschrieben (kein Verlust, keine Meldung bei Rollback). Zugestellt wird außerhalb der Anfrage: in einer kurzen Schleife der App (`WEBHOOK_SECONDS`, Standard 15) und in der Job-Schleife (`runTenantJobs`), mit `FOR UPDATE SKIP LOCKED`.
- **Signatur.** Kopf `X-Ideenportal-Signature: t=<Unix-Zeit>,v1=<hex HMAC-SHA256 über "<t>.<Rohtext>">`, dazu `X-Ideenportal-Event` und `X-Ideenportal-Delivery` (Kennung zum Entdoppeln). Empfänger prüfen die Signatur zeitkonstant und lehnen Zeitstempel ab, die mehr als 5 Minuten abweichen (Replay-Fenster); Referenz `verifySignature()` in `services/webhooks.ts`.
- **Wiederholung.** Antwort ohne 2xx, Zeitüberschreitung (10 s) oder Netzfehler: bis zu 6 Versuche, Abstände 1 min, 5 min, 30 min, 2 h, 12 h. Weiterleitungen werden nicht verfolgt (Schutz vor Umleitung ins interne Netz).
- **Abschalten.** Nach 10 Fehlversuchen in Folge wird das Abonnement abgeschaltet, offene Zustellungen werden als fehlgeschlagen markiert, die Admins bekommen eine Benachrichtigung, das Audit-Log `webhook.disabled`. Ein Erfolg setzt den Zähler zurück; Wiedereinschalten ebenso.
- **Adressen.** Nur `https`, nie das interne Netz: `checkPublicUrl()` aus `ai/providers.ts` beim Anlegen, Ändern und vor jedem Versand (DNS kann sich ändern). `AI_ALLOW_PRIVATE_URLS` gilt hier nicht.
- **Datensparsamkeit.** Nutzlast enthält keine Ideentexte und keine Personen. Nicht vertrauliche Ideen: Kennung, Nummer, Status, Titel, Themenfeld, Ideentyp, Challenge, Link. **Vertrauliche Ideen: nur Kennung, Nummer, Status und `confidential: true`.** Wer mehr braucht, liest mit einem Token und dessen Rollen nach.
- **Protokoll.** Admins sehen je Webhook die letzten 50 Zustellungen mit Ergebnis, Versuchen und nächstem Versuch (ohne Nutzlast). Erledigte Zustellungen werden nach 30 Tagen gelöscht.
- **Testbarkeit.** Der HTTP-Versand ist austauschbar (`setWebhookSender()` bzw. `send`-Parameter); Tests laufen mit einer Fälschung ohne Netz.

## Alternativen

- **OAuth 2.0 Client Credentials** statt eigener Tokens: sauberer für Marktplatz-Apps, aber mehr Aufwand und ein Autorisierungsserver. Kommt, wenn Konnektoren Dritter (R3-18) es brauchen; die Tokens bleiben für eigene Skripte.
- **Token an eine Person binden** (persönlicher Zugriffstoken): verwischt, wer gehandelt hat, und erbt Rechte, die der Konnektor nicht braucht. Verworfen zugunsten technischer Benutzer mit eigenen Rollen.
- **OpenAPI-Bibliothek** (z. B. `zod-openapi`, `@fastify/swagger`): `z.toJSONSchema` reicht für 3.1 und vermeidet Abhängigkeiten; Swagger UI bräuchte Skripte und eine weichere CSP.
- **Versand direkt in der Anfrage:** schneller, aber verliert Ereignisse bei Ausfällen und verlängert Anfragen. Verworfen zugunsten der Outbox.

## Folgen

- Die eigenen Konnektoren (Teams/Slack R3-16, ServiceNow/Jira R3-13 ff.) melden sich mit denselben Tokens an und abonnieren dieselben Webhooks.
- Neue stabile Endpunkte werden in `OPERATIONS` (`services/openapi.ts`) eingetragen; ihr Anfrageschema muss exportiert sein. Brechende Änderungen an stabilen Endpunkten nur mit neuer Version.
- Restrisiko DNS-Rebinding zwischen Prüfung und Versand (siehe Bedrohungsmodell T-I12).
- Ohne `SECRET_KEY` lassen sich keine Webhooks anlegen.
