# Versionen und Upgrades

Deutsch | [English](versionen-und-upgrades.en.md)

## Versionsschema

Das Portal folgt [Semantic Versioning](https://semver.org/lang/de/): `MAJOR.MINOR.PATCH`.

| Teil | Wann | Beispiel |
| --- | --- | --- |
| PATCH | Fehler- und Sicherheitskorrekturen, keine neuen Einstellungen | 0.4.1 |
| MINOR | neue Funktionen, neue Migrationen, abwärtskompatible API | 0.5.0 |
| MAJOR | Änderungen, die Kund:innen anpassen müssen (API, Konfiguration) | 1.0.0 |

Vor 1.0.0 kann eine MINOR-Version Umgebungsvariablen ändern; das steht dann im Abschnitt „Upgrade-Hinweise“ des [CHANGELOG](../../CHANGELOG.md). Jede Version hat ein Git-Tag `v<Version>`, ein Container-Image `ghcr.io/seb-nsu/ideaportal:<Version>` mit SBOM und Signatur (Workflow `release.yml`).

Die laufende Version zeigt `GET /api/version`.

## SaaS

Der Betreiber spielt Versionen nach grüner CI zuerst auf Staging, dann auf Produktion ein. Wartungen mit Ausfallzeit werden auf der Statusseite angekündigt ([`sla-und-support.md`](sla-und-support.md)).

## Eigener Betrieb (VM oder Container beim Kunden)

1. Hinweise im CHANGELOG lesen (neue Pflicht-Umgebungsvariablen, Upgrade-Hinweise).
2. Datenbank sichern: `pg_dump -Fc "$DATABASE_URL" > vor-upgrade.dump`.
3. Neues Image ziehen und starten. Die Migrationen laufen beim Start (`MIGRATE_ON_START=true`) in einer Transaktion mit Datenbanksperre; bei mehreren Instanzen migriert nur eine.
4. `GET /api/health/ready` prüfen, mit einem Testkonto anmelden.

Versionen nicht überspringen ist nicht nötig: Migrationen laufen der Reihe nach von jedem älteren Stand. Ein Test prüft das Upgrade vom letzten Release mit Daten (`server/test/upgrade.test.ts`).

## Zurückrollen

Migrationen laufen nur vorwärts. Bei einem Fehler nach dem Upgrade:

1. **Bevorzugt vorwärts korrigieren:** Patch-Version mit Korrektur-Migration.
2. **Wenn nötig zurück:** App stoppen, Sicherung aus Schritt 2 in eine neue Datenbank zurückspielen (`pg_restore`), alte Image-Version mit dieser Datenbank starten. Daten seit dem Upgrade gehen dabei verloren.

## API

- Stabile Endpunkte stehen in `/api/openapi.json`. Sie ändern sich innerhalb einer MAJOR-Version nur abwärtskompatibel (neue Felder, neue Endpunkte).
- Ein Endpunkt, der entfällt, wird mindestens **6 Monate** vorher im CHANGELOG und im OpenAPI-Dokument als `deprecated` markiert.
- Webhook-Ereignisse bekommen neue Felder ohne Ankündigung; Empfänger ignorieren unbekannte Felder.

## Unterstützte Versionen

Sicherheitskorrekturen gibt es für die aktuelle MINOR-Version und die Version davor. Siehe [`../../SECURITY.md`](../../SECURITY.md).
