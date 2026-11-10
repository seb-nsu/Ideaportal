# Enterprise-Unterlagen

Deutsch | [English](README.en.md)

Unterlagen für Enterprise-Kund:innen, Einkauf, IT-Sicherheit und Betrieb. Grundlage ist die Enterprise-Prüfung vom 13.10.2026; alle Lücken daraus sind mit Version 0.4.0 geschlossen. Jedes Dokument gibt es auf Deutsch (Referenz) und Englisch (`*.en.md`).

## Für Kund:innen und Einkauf

| Dokument | Inhalt |
| --- | --- |
| [Sicherheit und Datenschutz](sicherheit-whitepaper.md) | Überblick für Sicherheitsfragebögen und Audits |
| [Service Level und Support](sla-und-support.md) | Verfügbarkeit, Reaktionszeiten, RPO/RTO, Störungsklassen |
| [Versionen und Upgrades](versionen-und-upgrades.md) | SemVer, Upgrade im eigenen Betrieb, Zurückrollen, API-Zusagen |
| [Admin-Handbuch](admin-handbuch.md) | Einrichtung und Pflege eines Arbeitsbereichs ohne Technikkenntnisse |

## Technik je Bereich

| Dokument | Inhalt |
| --- | --- |
| [Sicherheit und Beobachtbarkeit](sicherheit-und-beobachtbarkeit.md) | Anmeldeprotokoll, Hash-Kette, Audit-Export und SIEM, Request-ID, Metriken, Health-Checks, sichere Voreinstellungen, Passwortregeln, DNS-Rebinding |
| [Mandanten und Administration](mandanten-und-administration.md) | Sperren, Löschen mit Frist, ZIP-Export, Betreiberkonten, Übersteuerungen je Mandant, Personenverwaltung, Import und Sammelaktionen |
| [SAML 2.0](saml.md) | Firmen-Login mit SAML für Entra ID, Okta und ADFS |
| [KI-Evals und Transparenz](ki-evals-und-transparenz.md) | Bewertung je Baustein, Testsatz Version 2, Berichte, CI-Lauf, Prompt-Versionen, Ausweichmodell, Seite „KI im Portal“ |
| [Qualität und Lieferkette](qualitaet-und-lieferkette.md) | Lint, Format, Testabdeckung, Frontend-Tests, RLS-Wächter, Upgrade-Test, CI, Release, SBOM, Signatur |
