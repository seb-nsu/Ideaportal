# Sicherheit und Datenschutz – Überblick für Einkauf und IT-Sicherheit

Deutsch | [English](sicherheit-whitepaper.en.md)

Stand 13.10.2026, Version 0.4.0. Kurzfassung für Sicherheitsfragebögen und Kundenaudits. Details und Nachweise: [Sicherheitskonzept](../sicherheit/sicherheitskonzept.md) (gegliedert nach ISO/IEC 27001:2022 Anhang A), [Bedrohungsmodell](../adr/bedrohungsmodell.md), [Datenfluss](../adr/datenfluss.md), [Pentest-Vorbereitung](../sicherheit/pentest-vorbereitung.md). Keine Zertifizierung und keine Rechtsberatung.

## Auf einen Blick

| Thema | Stand |
| --- | --- |
| Hosting | EU (Render, Frankfurt) oder eigener Betrieb als Container beim Kunden |
| Mandantentrennung | PostgreSQL Row-Level-Security auf allen Tabellen (ENABLE und FORCE), Mandantenkontext in jeder Anfrage, automatischer Wächter-Test |
| Anmeldung | Firmen-Login per OIDC oder SAML 2.0, SCIM 2.0, eigene Konten mit TOTP, lokale Konten abschaltbar |
| Verschlüsselung | TLS auf dem Transportweg, HSTS; gespeicherte Geheimnisse mit AES-256-GCM und eigenem Schlüssel je Mandant (HKDF, Rotation); Datenträger beim Hoster verschlüsselt |
| Protokoll | Audit-Log nur anhängbar, Hash-Kette je Mandant mit Prüffunktion, Export und SIEM-Weiterleitung |
| KI | eigenes Gateway, vertrauliche Inhalte nie an externe Dienste, Protokoll jeder KI-Aktion, Qualitätsprüfung vor dem Livegang |
| Entwicklung | Code-Review per Pull Request, CI mit Tests, CodeQL, Abhängigkeits-, Secret- und Image-Scan, SBOM, signierte Images |
| Pentest | vorbereitet, Durchführung durch Externe offen |

## 1 Architektur

Eine Web-Anwendung (Node.js, Fastify, React) mit PostgreSQL 16. Alle Oberflächen und Konnektoren nutzen dieselbe API (`/api/openapi.json`). Hintergrundjobs (Fristen, Mails, KI-Warteschlange, Export) laufen in der App mit Datenbanksperren, auch bei mehreren Instanzen nur einmal. Das Container-Image läuft ohne Root-Rechte und ohne npm.

## 2 Mandantentrennung

- Jede Anfrage läuft in einer Transaktion als Datenbankrolle `ideenportal_app` ohne `BYPASSRLS`, mit dem Mandanten der angemeldeten Person.
- Jede Tabelle mit `tenant_id` hat eine Policy; ein Test bricht die CI ab, wenn eine neue Tabelle das nicht erfüllt (`server/test/rls-guard.test.ts`).
- Tests mit zwei Mandanten prüfen Lesen, Schreiben, Export und Anmeldung über Mandantengrenzen.
- Der Betreiber sieht Inhalte eines Mandanten nur mit zeitlich begrenzter Freigabe der Admin; jeder Zugriff steht im Protokoll des Mandanten mit dem Namen der Person beim Betreiber.

## 3 Identität und Zugriff

- **Firmen-Login:** OIDC (PKCE, Nonce, Signaturprüfung) oder SAML 2.0 (signierte Assertion, Audience, Empfänger, Gültigkeit, Schutz vor Wiederholung und XML-Signature-Wrapping). Gruppen werden auf Rollen abgebildet.
- **SCIM 2.0** legt Personen an, ändert und deaktiviert sie.
- **Eigene Konten:** scrypt-Hashes, Mindestlänge je Mandant, Abgleich mit häufigen Passwörtern, optional mit Have I Been Pwned; Sperre nach 5 Fehlversuchen; Rate-Limits über alle Instanzen; TOTP, für Admins erzwingbar; Abmeldung nach Inaktivität einstellbar.
- **Rollen** mit minimalen Rechten, Beschränkung auf Bereiche, eigene Rolle für die Personenverwaltung ohne Zugriff auf Einstellungen.
- **API-Tokens** mit Rollen, Ablauf (höchstens 365 Tage) und Widerruf.

## 4 Anwendungssicherheit

- Eingaben werden mit Schemas geprüft; SQL nur mit Parametern.
- Content-Security-Policy ohne `unsafe-inline`, `frame-ancestors 'none'`, SameSite-Cookies, CSRF-Regel.
- Ausgehende Verbindungen (Webhooks, KI-Anbieter, Konnektoren, SIEM) nur zu öffentlichen Adressen und an die geprüfte IP gebunden (Schutz vor SSRF und DNS-Rebinding).
- Anhänge: Größengrenze, Typprüfung über den Dateiinhalt, optional Virenscan (ClamAV).
- Anfragen tragen eine Request-ID; Logs enthalten keine Ideentexte, keine Suchbegriffe und keine Passwörter (mit Test).

## 5 Protokollierung und Überwachung

- **Audit-Log:** Anmeldungen und Fehlversuche, Rollen, Einstellungen, Exporte, Löschungen, Support-Zugriffe, KI-Ausnahmen, mit IP-Hash und Browserkennung. Nur anhängbar, je Mandant per Hash-Kette verkettet und prüfbar. Filter, Export ohne Zeilengrenze, Weiterleitung an ein SIEM (signierter Webhook).
- **Betrieb:** Prometheus-Kennzahlen (`/api/metrics`, mit Token), Health-Checks `live` und `ready`, Alarme per Mail oder Webhook, öffentliche Statusseite mit Verfügbarkeit.

## 6 Datenschutz

- Verarbeitung im Auftrag (AVV-Vorlage, Liste der Unterauftragnehmer im Produkt), Entwurf der Datenschutz-Folgenabschätzung und Verzeichnis der Verarbeitungen in [`../release-0/datenschutz/`](../release-0/datenschutz/).
- Auswertungen nur zusammengefasst und erst ab 5 Personen; die KI bewertet keine Personen.
- Löschfristen je Mandant; Auskunft und Export je Person; Anonymisieren deaktivierter Konten.
- Vollständiger Export des Mandanten als ZIP; Löschen des Mandanten mit erneuter Anmeldung, 30 Tagen Frist und Löschnachweis.
- Das Portal ist kein Meldekanal nach dem Hinweisgeberschutzgesetz; mögliche Meldungen werden erkannt und nie an externe Dienste gegeben.

## 7 KI

- Alle Modellaufrufe laufen über ein Gateway: Anbieter und Modell je Mandant und Aufgabe, Kostenlimit je Idee und Monat, Protokoll jeder Aktion mit Modell, Prompt-Version, Kosten und Quellen.
- Vertrauliche Ideen gehen nur an Modelle auf eigener Infrastruktur.
- Eingaben werden als Daten gekennzeichnet und von Anweisungen getrennt (Prompt-Injection); Angriffe sind Teil des Testsatzes.
- Ein Baustein geht erst live, wenn er den Testsatz (90 Fälle) besteht; jede Änderung an Modell oder Prompt löst eine neue Prüfung aus. Antwortet ein ungeprüftes Ausweichmodell, ist das Ergebnis deutlich markiert.
- Die Seite „KI im Portal“ zeigt allen Nutzer:innen Zweck, Modell, Datenweg und letzte Prüfung je Baustein (Transparenz im Sinne der KI-Verordnung). Die KI entscheidet nie; Menschen entscheiden an den Gates.

## 8 Sichere Entwicklung und Lieferkette

- Änderungen nur per Pull Request mit CI: Lint, Typprüfung, über 690 automatische Tests mit Mindestabdeckung, Browser-Test mit Barrierefreiheitsprüfung, Upgrade-Test.
- CodeQL, `npm audit`, Prüfung der Paketsignaturen, gitleaks, Trivy-Scan des Images, CycloneDX-SBOM, Dependabot.
- Releases als signierte Container-Images (cosign, keyless) mit SBOM; Versionen nach SemVer ([`versionen-und-upgrades.md`](versionen-und-upgrades.md)).
- Meldung von Sicherheitslücken: [`SECURITY.md`](../../SECURITY.md).

## 9 Verfügbarkeit und Sicherung

Zusagen je Paket in [`sla-und-support.md`](sla-und-support.md). Tägliche Sicherung, monatlich geprobte Rücksicherung, Störungsprozess mit Information der Kund:innen.

## 10 Offen

- Externer Pentest, Prüfung durch Datenschutzbeauftragte und Anwalt, Test mit echtem Entra ID und Okta.
- Zertifizierung (z. B. ISO/IEC 27001 oder BSI C5) ist nicht begonnen.
- Redundanz von App und Datenbank hängt vom Plan des Hosters ab.
