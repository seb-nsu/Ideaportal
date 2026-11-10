<!-- template: tom, version 2026-10-13.1 -->
# Technische und organisatorische Maßnahmen (Art. 32 DSGVO)

> **Entwurf, keine Rechtsberatung, anwaltliche Prüfung offen.** Fassung {{template.version}} vom {{template.date}}, erzeugt am {{generatedOn}}{{#if workspace}} für den Arbeitsbereich „{{workspace}}“{{/if}}. Anlage 1 zum Vertrag zur Auftragsverarbeitung. Die Maßnahmen beschreiben den Stand der Software; Nachweise im Sicherheitskonzept (`docs/sicherheit/sicherheitskonzept.md`).

## 1 Vertraulichkeit

### 1.1 Zutrittskontrolle

- Betrieb in Rechenzentren des Hosting-Anbieters{{#if hosting.provider}} {{hosting.provider}}{{/if}}{{#if hosting.region}}, Region {{hosting.region}}{{/if}}; Zutrittskontrolle nach dessen Zertifizierung (ISO 27001 oder SOC 2, Nachweis beim Anbieter anfordern).
- Keine eigenen Server in Büroräumen.

### 1.2 Zugangskontrolle

- Anmeldung mit Passwort (scrypt-Hash, Sperre nach 5 Fehlversuchen) oder Firmen-Login (OpenID Connect mit PKCE).
- Zwei-Faktor-Anmeldung (TOTP), Pflicht für Admins einstellbar; das TOTP-Geheimnis ist verschlüsselt gespeichert.
- Rate-Limits je IP-Adresse und je Konto für Anmeldung, Registrierung, Reset und Demo; Ereignisse im Audit-Log.
- Sitzungs-Cookie `httpOnly`, `SameSite=Strict`{{#if security.cookieSecure}}, `Secure`{{/if}}; in der Datenbank nur als Hash; Ablauf nach höchstens 12 Stunden.
- Administrativer Zugang zur Plattform nur für benannte Personen des Anbieters mit Zwei-Faktor-Anmeldung beim Hosting-Anbieter.

### 1.3 Zugriffskontrolle

- Rollen mit minimalen Rechten (Ideengebende, Pate, Triage, Gremium, Bereichsleitung, Umsetzung, Admin, Betriebsrat lesend); Prüfung serverseitig in jeder Anfrage.
- Trennung der Mandanten durch Row-Level-Security in PostgreSQL: jede Anfrage läuft als eingeschränkte Datenbankrolle mit gesetztem Mandantenkontext; automatische Tests mit zwei Mandanten.
- Vertrauliche Ideen sehen nur Einreichende, Triage und Umsetzungsverantwortliche.
- Auswertungen über Personengruppen nur zusammengefasst und erst ab {{minGroupSize}} Personen.
- API-Tokens und SCIM-Tokens nur als Hash gespeichert, mit Ablauf und Widerruf.

### 1.4 Trennungskontrolle

- Mandantentrennung wie in 1.3; getrennte Such- und Dublettenindizes je Mandant (Tabelle mit Mandantenkennung und RLS).
- Getrennte Umgebungen für Staging und Produktion mit eigenen Datenbanken; keine Echtdaten in Tests.

### 1.5 Pseudonymisierung und Datenminimierung

- KI- und Suchanfragen ohne Namen der Personen; interne Begriffe werden vor einer Websuche entfernt.
- Vertrauliche Ideen und mögliche Meldungen gehen nie an externe KI- oder Suchdienste{{#if ai}} (Modell für vertrauliche Inhalte: {{ai.confidential.provider}}{{#if ai.confidential.hosting}}, {{ai.confidential.hosting}}{{/if}}){{/if}}; mögliche Erfindungen bekommen keine Websuche.
- Protokolle der Anwendung ohne Ideeninhalte und ohne Suchbegriffe.

## 2 Integrität

### 2.1 Weitergabekontrolle (Verschlüsselung bei der Übertragung)

- Zugriff nur über HTTPS (TLS 1.2 oder höher am Rand des Hosting-Anbieters){{#if security.hsts}}; HTTP Strict Transport Security mit einem Jahr Gültigkeit{{/if}}.
- Verbindung zur Datenbank {{#if security.databaseTlsOn}}verschlüsselt (TLS, Einstellung `{{security.databaseTls}}`){{else}}im privaten Netz des Hosting-Anbieters; TLS über `DATABASE_SSL=require` einschaltbar{{/if}}.
- Webhooks nur an `https`-Adressen mit HMAC-Signatur; ausgehende Verbindungen nicht in interne Netze.
- E-Mails über SMTP mit TLS; Betreff vertraulicher Ideen ohne Titel.

### 2.2 Eingabekontrolle

- Audit-Log mit handelnder Person, Zeitpunkt, Wert vorher und nachher für Entscheidungen, Fristen, Rollen, Einstellungen und Datenexporte; nur anhängbar.
- Verlauf je Idee; Protokoll jeder KI-Aktion mit Eingabe, Modell, Quellen und Kosten.

## 3 Verfügbarkeit und Belastbarkeit

- Tägliche Sicherung der Datenbank durch den Hosting-Anbieter (bezahlter Plan) mit [7] Tagen Aufbewahrung, auf eigener Infrastruktur mit `pg_dump`; die Wiederherstellung wird monatlich geprobt.
- Gesundheitsprüfung, Alarme bei Rückstau von Jobs, KI-Warteschlange und E-Mails.
- Fristen-Engine unabhängig von KI-Diensten; Ausfall eines KI-Anbieters hält den Ideenfluss nicht an.
- Schutz vor Überlast durch Rate-Limits und Kostenlimits für KI je Idee und Monat.

## 4 Verschlüsselung gespeicherter Daten

- Datenträgerverschlüsselung der Datenbank und der Sicherungen durch den Hosting-Anbieter (AES-256, Nachweis beim Anbieter).
- Zusätzlich auf Anwendungsebene mit AES-256-GCM verschlüsselt: Schlüssel der KI- und Suchanbieter, Client-Geheimnisse des Firmen-Logins, Webhook- und Chat-Geheimnisse, TOTP-Geheimnisse{{#if security.secretKey}} (Server-Schlüssel gesetzt){{else}} (**Server-Schlüssel `SECRET_KEY` fehlt**){{/if}}.
- Passwörter nur als scrypt-Hash; Sitzungen, API- und SCIM-Tokens nur als SHA-256-Hash.

## 5 Verfahren zur regelmäßigen Überprüfung

- Abhängigkeitsprüfung (`npm audit`) und statische Sicherheitsprüfung blockieren die CI bei hohen Befunden.
- Automatische Sicherheitstests (Header, Cookies, CSRF, Rate-Limits, Mandantentrennung) bei jeder Änderung.
- Externer Penetrationstest vor dem Marktstart (offen); danach jährlich.
- Löschfristen je Arbeitsbereich{{#if retention}}: {{retention.periodsText}}{{/if}}.
- Meldung von Datenschutzverletzungen an den Kunden unverzüglich, Ziel innerhalb von 24 Stunden.
