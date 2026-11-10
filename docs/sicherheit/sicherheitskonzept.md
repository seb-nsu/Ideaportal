# Sicherheitskonzept Ideenportal

Stand 13.10.2026 · AP-25 (R3-09) · Entwurf · Gliederung nach ISO/IEC 27001:2022, Anhang A (nur die für das Produkt und seinen Betrieb relevanten Maßnahmen)

> **Hinweis:** Keine Zertifizierung und keine Rechtsberatung. Das Konzept beschreibt den Stand der Software und des Betriebs als Grundlage für Kundenaudits, den AVV (Anlage 1 TOM im Produkt) und den externen Penetrationstest (`pentest-vorbereitung.md`). Ein Informationssicherheits-Managementsystem (ISMS) mit Risikobehandlung, Erklärung zur Anwendbarkeit und internem Audit ist nicht aufgebaut; das ist eine Entscheidung des PO vor dem Marktstart.

Verwandte Dokumente: `../adr/bedrohungsmodell.md` (STRIDE, Bedrohungs-IDs `T-…`), `../adr/datenfluss.md`, `../adr/0001-technik-und-mandantenmodell.md`, `../adr/0002-anmeldung.md`, `../adr/0004-ki-gateway.md`, `../adr/0008-oeffentliche-api-und-webhooks.md`, `../betrieb.md`, TOM-Vorlage `server/templates/legal/tom.de.md`.

Status: **umgesetzt** (im Code oder Betrieb nachweisbar), **teilweise** (Kern umgesetzt, Lücke benannt), **offen**, **Hoster** (liegt beim Hosting-Anbieter, Nachweis dort).

## 1 Geltungsbereich und Schutzziele

- **Gegenstand:** Webanwendung und API des Ideenportals (`server/`, `web/`), PostgreSQL-Datenbank, Hintergrundjobs, Anbindungen (KI-Gateway, Websuche, Mail, Webhooks, Slack/Teams, OIDC, SCIM), Betrieb auf Render (EU, Frankfurt) und auf Kunden-VMs.
- **Nicht Gegenstand:** Infrastruktur des Hosters, Systeme der KI- und Suchanbieter, Identitätsanbieter der Kunden.
- **Schutzziele** (Bedrohungsmodell, schützenswerte Güter): Trennung der Mandanten, Vertraulichkeit vertraulicher Ideen, möglicher Meldungen und möglicher Erfindungen, Integrität von Entscheidungen, Fristen und Audit-Log, Schutz der Konten und Schlüssel, Verfügbarkeit des Ideenflusses.

## 2 Organisatorische Maßnahmen (A.5)

| Control | Thema | Umsetzung | Status |
| --- | --- | --- | --- |
| A.5.1 | Richtlinien | Leitplanken in `CLAUDE.md` (Mandantenfähigkeit, KI nur über das Gateway, Datenschutz, Definition of Done mit Tests für Rechte und Mandantentrennung); dieses Konzept | teilweise (keine freigegebene Sicherheitsleitlinie) |
| A.5.2, A.5.3 | Rollen, Aufgabentrennung | Produkt: Rollen mit minimalen Rechten, Rechtetabelle `PERMISSIONS` (`server/src/lib/context.ts`), Einsicht für den Betriebsrat (R3-12). Betrieb: Verantwortliche Person für Sicherheit ist der PO; Vertretung offen | teilweise |
| A.5.7 | Bedrohungsinformationen | `npm audit` in der CI, GitHub-Hinweise zu Abhängigkeiten; OWASP Top 10 und ASVS als Prüfrahmen | umgesetzt |
| A.5.9, A.5.12 | Inventar, Klassifizierung | Datenkategorien im Verarbeitungsverzeichnis (`../release-0/datenschutz/verarbeitungsverzeichnis.md`); Klassen im Produkt: normal, vertraulich, mögliche Meldung, mögliche Erfindung (R3-25) | umgesetzt |
| A.5.14 | Informationsübertragung | Nur HTTPS; Webhooks signiert (HMAC-SHA256); Mail-Betreff vertraulicher Ideen ohne Titel; Datenexport nur für Admins mit Audit | umgesetzt |
| A.5.15 – A.5.18 | Zugangssteuerung, Identitäten, Authentisierung, Zugriffsrechte | Siehe 4.1; Rollenvergabe nur durch Admins mit Audit; Gruppen → Rollen über OIDC/SCIM (R3-26, R3-27); Deaktivierung beendet Sitzungen | umgesetzt |
| A.5.19 – A.5.22 | Lieferanten | Liste der Unterauftragnehmer aus der Konfiguration (Einstellungen › Rechtliches, R3-08); KI- und Suchanbieter je Arbeitsbereich wählbar, vertrauliche Inhalte nur an lokale Modelle; Prüfung der AVV und Zertifikate der Hoster vor dem Marktstart | teilweise (Lieferantenbewertung Render, Mail-Dienst offen) |
| A.5.23 | Cloud-Dienste | Render, Region Frankfurt (`render.yaml`, Test prüft die Region); Ausstieg: Docker-Image läuft auf jeder VM, Datenexport je Arbeitsbereich | umgesetzt |
| A.5.24 – A.5.28 | Vorfallmanagement | Alarme bei Ausfall, Rückstau und Jobs (`ALERT_EMAIL`, `ALERT_WEBHOOK_URL`, R1-05); Sicherheitsereignisse 90 Tage (`security_events`); Audit-Log nur anhängbar. Ablauf siehe Abschnitt 6 | teilweise (Ablauf nicht geübt) |
| A.5.29, A.5.30 | Betrieb bei Störungen, IKT-Bereitschaft | Ideenfluss hängt nicht an KI (Fallback `builtin`); Staging mit eigenem Datenbestand; Wiederherstellung aus Sicherung (Abschnitt 5.3) | teilweise (kein Notfallhandbuch) |
| A.5.31, A.5.34 | Recht, Datenschutz | Rechtstexte im Produkt (R3-11), DSFA-Muster, AVV, Löschfristen je Arbeitsbereich, Auswertungen erst ab 5 Personen; Abgrenzung HinSchG | umgesetzt (anwaltliche Prüfung offen) |
| A.5.35, A.5.36 | Unabhängige Überprüfung, Einhaltung | Automatische Sicherheitstests in der CI; externer Penetrationstest vorbereitet | offen (externer Test, Entscheidung PO) |

## 3 Personelle Maßnahmen (A.6)

| Control | Thema | Umsetzung | Status |
| --- | --- | --- | --- |
| A.6.3 | Sensibilisierung | Entwickler:innen arbeiten nach den Leitplanken und der Definition of Done; Review-Regel „keine Systemverbindung in Anfragen“ (T-E2) | teilweise |
| A.6.6 | Vertraulichkeit | Vertraulichkeitsklausel im AVV § 4; Support-Zugriff nur mit Freigabe des Kunden und Protokoll (R3-07) | umgesetzt |
| A.6.8 | Meldung von Ereignissen | Kontakt `security@[Domain]` und Hinweis in `SECURITY.md` vorgesehen | offen |

## 4 Technische Maßnahmen (A.8)

### 4.1 Zugang und Identität

| Control | Umsetzung | Nachweis | Status |
| --- | --- | --- | --- |
| A.8.2 Privilegierte Zugänge | Keine Plattform-Rolle in der App (T-E3); Admin je Arbeitsbereich mit MFA-Pflicht (einstellbar, Standard an); Zugang zu Render und GitHub nur mit Zwei-Faktor; Notfallzugang für lokale Konten nur per CLI mit Audit | `requireMfaForAdmins`, `identity-cli.ts` | umgesetzt (Render/GitHub-MFA organisatorisch) |
| A.8.3 Zugriffsbeschränkung | Rollen serverseitig in jeder Anfrage; Row-Level-Security mit `FORCE` auf allen Mandantentabellen, App-Rolle ohne Tabelleneigentum | `tenant-isolation.test.ts`, `security-selfcheck.test.ts` (IDOR) | umgesetzt |
| A.8.5 Sichere Authentisierung | scrypt, Sperre nach 5 Fehlversuchen, Rate-Limits je IP und Konto, TOTP verschlüsselt, OIDC mit PKCE/State/Nonce und RS256, Sitzung `httpOnly`/`Secure`/`SameSite=Strict`, nur Hash gespeichert, 12 h | `auth.test.ts`, `identity.test.ts`, `security.test.ts` | umgesetzt |

### 4.2 Schutz von Systemen und Daten

| Control | Umsetzung | Nachweis | Status |
| --- | --- | --- | --- |
| A.8.7 Schadsoftware | Anhänge: Positivliste, Inhaltsprüfung, 10 MB, ClamAV über `CLAMAV_HOST` | `files`-Tests | teilweise (ClamAV im Betrieb einschalten, T-T6) |
| A.8.8 Schwachstellen | `npm audit --audit-level=high` und `npm audit signatures` blockieren die CI; statische Prüfung `npm run check:security`; monatliche Updates | `.github/workflows/ci.yml` | umgesetzt |
| A.8.9 Konfiguration | Nur Umgebungsvariablen (`config.ts`), sichere Standardwerte (Rate-Limits an, private Adressen für KI/OIDC aus); Einstellungen je Mandant validiert (zod) und im Audit-Log | `betrieb.md` | umgesetzt |
| A.8.10 Löschung | Löschfristen je Arbeitsbereich, Anonymisierung deaktivierter Konten, Löschjob; Datenexport und Löschung des Arbeitsbereichs | `privacy`-Tests | umgesetzt |
| A.8.11, A.8.12 Maskierung, Abflussverhinderung | KI-Anfragen ohne Namen; interne Begriffe vor der Websuche entfernt; vertrauliche Ideen und mögliche Meldungen nie an externe KI, mögliche Erfindungen ohne Websuche (R3-25); Webhooks ohne Ideentexte; Logs ohne Inhalte und Suchbegriffe | `ai.test.ts`, `compliance.test.ts` | umgesetzt |
| A.8.13 Datensicherung | siehe 5.3 | | teilweise |

### 4.3 Protokollierung und Überwachung

| Control | Umsetzung | Status |
| --- | --- | --- |
| A.8.15 Protokollierung | Audit-Log (wer, wann, vorher, nachher; nur anhängbar per Trigger), Verlauf je Idee, KI-Protokoll je Aktion, Sicherheitsereignisse (Rate-Limits), Anwendungsprotokoll ohne Inhalte, IP-Adressen nicht im Anwendungsprotokoll | umgesetzt |
| A.8.16 Überwachung | Gesundheitsprüfung `/api/health` mit Schwellen, Alarme per Mail und Webhook, Statusseite (R3-10) | umgesetzt |
| A.8.17 Zeitsynchronisation | Zeitstempel aus PostgreSQL (`now()`), Fristen in der Zeitzone des Arbeitsbereichs | umgesetzt |

### 4.4 Netz und Kryptografie

| Control | Umsetzung | Status |
| --- | --- | --- |
| A.8.20 – A.8.22 Netze | Datenbank im privaten Netz des Hosters; ausgehende Verbindungen (Webhooks, OIDC, KI, Quellenprüfung) nur `https` und nicht in interne Netze (`checkPublicUrl`), keine Weiterleitungen; Restrisiko DNS-Rebinding (T-I12, T-I14) | teilweise |
| A.8.23 Webfilter | Content Security Policy ohne `unsafe-inline`, `frame-ancestors 'none'`, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, kein CORS | umgesetzt |
| A.8.24 Kryptografie | TLS am Rand des Hosters, HSTS ein Jahr; TLS zur Datenbank mit `DATABASE_SSL=require` (R3-08); AES-256-GCM für gespeicherte Geheimnisse mit `SECRET_KEY` und Rotation (R3-41); scrypt für Passwörter, SHA-256 für Tokens; HMAC-SHA256 für Webhooks und Slack/Teams; Datenträgerverschlüsselung beim Hoster | umgesetzt (Schlüsselverwaltung: `SECRET_KEY` als Render-Geheimnis) |

### 4.5 Sichere Entwicklung

| Control | Umsetzung | Status |
| --- | --- | --- |
| A.8.25 Lebenszyklus | Arbeitspakete mit Definition of Done (Akzeptanzkriterien, Tests für Fristen, Rechte, Mandantentrennung, Doku) | umgesetzt |
| A.8.26 Anforderungen | Bedrohungsmodell je neuer Vertrauensgrenze nachgeführt; ASVS L2 als Anforderungsliste (`pentest-vorbereitung.md`) | umgesetzt |
| A.8.27 Architektur | API zuerst, `withTenant()` für jede Anfrage, KI nur über das Gateway, Agenten mit minimalen Werkzeugen (ADR 0001, 0004) | umgesetzt |
| A.8.28 Sicheres Programmieren | Parametrisierte SQL-Abfragen; dynamisches SQL nur mit festen Fragmenten, Liste aus `node tools/check-security.mjs --list` zur Durchsicht; Eingaben mit zod; keine HTML-Ausgabe aus Nutzertexten (React, Dokumente als Textblöcke) | umgesetzt |
| A.8.29 Sicherheitstests | `security.test.ts`, `security-selfcheck.test.ts`, `tenant-isolation.test.ts`, Tests je Story mit zwei Mandanten; externer Penetrationstest | teilweise (extern offen) |
| A.8.31 Trennung der Umgebungen | Entwicklung lokal, Staging (Branch `staging`, eigene Datenbank, keine Registrierung), Produktion; keine Echtdaten in Tests | umgesetzt |
| A.8.32 Änderungen | Pull Requests mit CI (Tests, Typprüfung, Textkatalog, Abhängigkeits- und statische Prüfung, Browser-Test); Migrationen versioniert | umgesetzt |
| A.8.33 Testdaten | Testdaten synthetisch (`seed.ts`, Testsatz der KI) | umgesetzt |

## 5 Physische Sicherheit, Betrieb und Sicherung

### 5.1 Physische Sicherheit (A.7)

Liegt beim Hoster (Render, Rechenzentren in Frankfurt). Nachweis: Zertifikate und AVV des Hosters anfordern und ablegen (offen). Bei Kundenbetrieb auf eigener VM beim Kunden.

### 5.2 Kapazität und Verfügbarkeit (A.8.6, A.8.14)

Lasttest mit 10.000 Ideen (`../release-3/lasttest.md`); Rate-Limits und KI-Kostenlimits gegen Überlast; Statusseite und Verfügbarkeitszusage je Paket (R3-10). Redundanz der App-Instanz und der Datenbank hängt vom Plan des Hosters ab (kostenloser Plan: keine).

### 5.3 Datensicherung (A.8.13)

Tägliche Sicherung durch den Hoster (bezahlter Plan) oder `pg_dump -Fc` auf eigener VM; Rücksicherung monatlich geprobt (`betrieb.md`). Ziele für den Pilot: RPO 24 Stunden, RTO 8 Stunden (Vorschlag, PO bestätigt). Sicherungen sind beim Hoster verschlüsselt; eigene Sicherungen verschlüsselt ablegen.

## 6 Ablauf bei Sicherheitsvorfällen

1. **Erkennen:** Alarm (Gesundheit, Rückstau), Sicherheitsereignisse, Hinweis von Kunden oder Forschenden.
2. **Bewerten:** Betroffene Arbeitsbereiche und Daten über Audit-Log, KI-Protokoll und Server-Protokolle eingrenzen.
3. **Eindämmen:** Betroffene Tokens widerrufen (API, SCIM, Webhook-Geheimnisse), Sitzungen beenden (Konto deaktivieren), `SIGNUP_ENABLED=false` oder `DEMO_MODE=false`, bei Schlüsselverdacht `SECRET_KEY` rotieren (R3-41).
4. **Melden:** Kunden als Verantwortliche unverzüglich, Ziel 24 Stunden (AVV § 8); der Kunde meldet binnen 72 Stunden an die Aufsichtsbehörde (Art. 33 DSGVO).
5. **Beheben und lernen:** Fix mit Test, Eintrag im Bedrohungsmodell, Nachbesprechung.

## 7 Offene Punkte

| Punkt | Wer | Bezug |
| --- | --- | --- |
| Externer Penetrationstest beauftragen (nicht vor Marktstart-Entscheidung) | PO | R3-09, `pentest-vorbereitung.md` |
| ISMS-Entscheidung (Zertifizierung nach ISO 27001 oder Testat nach BSI C5) | PO | Marktreife |
| `SECURITY.md` mit Meldeweg für Schwachstellen | Entwicklung | A.6.8 |
| Nachweise der Hoster (Zertifikate, AVV) ablegen; Lieferantenbewertung | PO | A.5.19 – A.5.23 |
| ClamAV im Betrieb, Captcha bei Bedarf, Ablauf des Einladungslinks | Entwicklung | T-T6, T-D2, T-S4 |
| Notfallhandbuch und Übung der Rücksicherung mit Protokoll | Betrieb | A.5.29, A.8.13 |
