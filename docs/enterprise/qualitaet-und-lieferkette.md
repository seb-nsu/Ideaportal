# Qualität, CI/CD und Lieferkette

Deutsch | [English](qualitaet-und-lieferkette.en.md)

Stand: 13.10.2026, Version 0.4.0. Dieses Dokument beschreibt, wie Code geprüft, getestet, gebaut und ausgeliefert wird. Es wird später in README und `docs/betrieb.md` übernommen.

## Überblick

| Bereich | Was | Wo |
| --- | --- | --- |
| Lint | ESLint (Flat Config, typescript-eslint, react-hooks für `web/`) | `eslint.config.mjs`, `npm run lint` |
| Format | Prettier, in der CI nur für geänderte Dateien | `.prettierrc.json`, `.prettierignore`, `tools/format-changed.mjs` |
| Testabdeckung | `@vitest/coverage-v8` mit Mindestwerten | `server/vitest.config.ts`, `npm run test:coverage` |
| Frontend-Tests | Vitest, Testing Library, jsdom | `web/vitest.config.ts`, `web/test/`, `npm test -w web` |
| RLS-Wächter | Jede Tabelle mit `tenant_id` hat RLS, FORCE und eine Mandanten-Policy | `server/test/rls-guard.test.ts` |
| Upgrade-Test | Datenbank im Stand des letzten Release, Daten von zwei Mandanten, dann alle neuen Migrationen | `server/test/upgrade.test.ts` |
| Endpunkt-Tests | Bisher ungetestete Endpunkte, mit 401/403/404 | `server/test/endpoints-coverage.test.ts` |
| Bibliothekstests | `ratelimit`, `pdf`, `importer`, `attachments`, `boundary` | `server/test/lib-units.test.ts` |
| CI | Statische Prüfungen, Secret-Scan, Tests, Image, Trivy, SBOM, Smoke-, Browser- und Lasttest | `.github/workflows/ci.yml` |
| CodeQL | Statische Codeanalyse, wöchentlich, bei Push auf `main` und bei Pull Requests mit Änderungen an Code oder Abhängigkeiten | `.github/workflows/codeql.yml` |
| Abhängigkeiten | Dependabot, npm wöchentlich, GitHub Actions und Docker monatlich, Minor und Patch gebündelt | `.github/dependabot.yml` |
| Release | Tag `v*.*.*` → Image in ghcr.io, Signatur, SBOM, GitHub-Release | `.github/workflows/release.yml` |
| Version | `GET /api/version` mit Version und Commit | `server/src/lib/version.ts`, `Dockerfile` |
| Deploy | Render deployt erst nach grüner CI | `render.yaml` (`autoDeployTrigger: checksPass`) |
| Meldungen | Sicherheitslücken melden | `SECURITY.md` |
| Pull Requests | Vorlage mit Prüfliste (Definition of Done) | `.github/pull_request_template.md` |

## Befehle

| Befehl | Zweck |
| --- | --- |
| `npm run lint` | ESLint über `server/`, `web/` und `tools/`. Fehler brechen ab, Warnungen nicht. |
| `npm run format` | Formatiert die gegenüber `origin/main` neuen und geänderten Dateien. |
| `npm run format:check` | Prüft wie die CI: neue Dateien müssen formatiert sein, geänderte erzeugen eine Warnung. |
| `npm run format:all` | Formatiert das ganze Repository (siehe unten, bewusst noch nicht ausgeführt). |
| `npm test` | Server-Tests (braucht PostgreSQL) und Frontend-Tests. |
| `npm run test:coverage` | Server-Tests mit Abdeckung; Bericht in `server/coverage/` (HTML, LCOV, JSON). |
| `npm test -w web` | Nur die Frontend-Tests (ohne Datenbank). |
| `npm run check:texts` | Textkatalog: keine sichtbaren Texte außerhalb des Katalogs (auch Fehler und Warnhinweise in `server/src/ai/`), jeder deutsche Schlüssel hat einen englischen Text. |

## Lint

- Regeln: `@eslint/js` recommended, `typescript-eslint` recommended, `react-hooks/rules-of-hooks` (Fehler) und `react-hooks/exhaustive-deps` (Warnung).
- An den bestehenden Stil angepasst, ohne den Code umzuschreiben: `no-unused-vars`, `no-useless-assignment`, `no-useless-escape` und `no-explicit-any` sind vorerst **Warnungen** (Stand: 38 Warnungen, 0 Fehler). Grund: parallele Arbeit an denselben Dateien; das Entfernen ungenutzter Importe kann beim Zusammenführen Code brechen, der sie inzwischen nutzt.
- Nächster Schritt: Warnungen abbauen, dann diese Regeln auf `error` stellen und `--max-warnings 0` setzen.
- `no-irregular-whitespace` ignoriert reguläre Ausdrücke und Strings (bewusste Prüfung auf schmale Leerzeichen und BOM).

## Format: nur geänderte Dateien

Der Code ist älter als Prettier. Ein einmaliges `prettier --write .` würde fast jede Datei ändern (gemessen: rund 315 von 390 TypeScript-Dateien in `server/` und `web/`) und mit paralleler Arbeit kollidieren. Deshalb:

- **Neue Dateien** (im Pull Request oder Push hinzugefügt) müssen formatiert sein. Sonst schlägt die CI fehl.
- **Geänderte Dateien** erzeugen in der CI eine Warnung (Annotation am Pull Request), brechen aber nicht ab. Wer eine Datei ohnehin stark ändert, formatiert sie mit `npm run format` mit.
- Basis: im Pull Request der Basis-Commit, beim Push der vorherige Stand des Branches, sonst der gemeinsame Vorfahr mit `origin/main`.
- Umstellung später: an einem ruhigen Tag `npm run format:all` in einem eigenen Commit, den Commit in `.git-blame-ignore-revs` eintragen und in der CI `node tools/format-changed.mjs <basis> --strict` setzen (dann blockieren auch geänderte Dateien).
- Stil (`.prettierrc.json`): einfache Anführungszeichen, Semikolons, `trailingComma: all`, Zeilenbreite 160 (Kompromiss: der bestehende Code nutzt sehr lange Zeilen).

## Testabdeckung

- Gemessen am 13.10.2026 (585 Server-Tests): Anweisungen 90,1 %, Zweige 77,6 %, Funktionen 94,0 %, Zeilen 94,0 %.
- Mindestwerte in `server/vitest.config.ts`: Anweisungen 88, Zweige 75, Funktionen 92, Zeilen 92. Liegt die Abdeckung darunter, schlägt `npm run test:coverage` (und die CI) fehl.
- Mindestwerte nur anheben, nie stillschweigend senken. Ausgenommen sind reine Kommandozeilen-Einstiege (`main.ts`, Seed, Lasttest, CLIs).
- Die CI lädt den Bericht als Artefakt `coverage-server` hoch (14 Tage).

## Frontend-Tests

- Ablage in `web/test/`, nicht in `web/src/`: so bleiben Text- und Sicherheitsprüfung auf den App-Code beschränkt, und Testtexte müssen nicht in den Katalog.
- Abgedeckt: `t()` mit Rückfall auf Deutsch und auf den Schlüssel, Variablen, Plural, Formatierung, Sprachwechsel; API-Client (Header, JSON, `ApiError` mit Status, Code, Details, Katalogtext bei leerer Antwort); Bausteine aus `components.tsx` (ErrorBox, StatusBadge, DeadlineLight, IdeaList, Field, LoadMore, Dialog mit Escape und Fokus, `useLoad`, `useAction`, UserPicker); Login-Seite mit gemocktem `fetch` (Anmeldung, Fehler, Auswahl des Arbeitsbereichs, Passwort vergessen, Firmen-Login).
- Tests lesen erwartete Texte aus dem Katalog (`t('login.email')`), damit Textänderungen keine Tests brechen.

## RLS-Wächter

`server/test/rls-guard.test.ts` prüft nach allen Migrationen:

1. Jede Tabelle im Schema `public` mit Spalte `tenant_id` hat `relrowsecurity` **und** `relforcerowsecurity`.
2. Jede solche Tabelle, auf die `ideenportal_app` zugreifen darf, hat eine Policy für `ideenportal_app` (oder PUBLIC), deren `USING` (und ggf. `WITH CHECK`) den Mandantenkontext nutzt (`current_tenant()` bzw. `current_setting('app.tenant_id')`).
3. Tabellen mit `tenant_id` ohne Zugriff der App-Rolle (z. B. `operator_log`) sind reine Systemtabellen und haben trotzdem eine Policy.
4. `ideenportal_app` erreicht keine Tabelle ohne `tenant_id` außer `tenants` (die selbst RLS hat).
5. `ideenportal_app` hat kein `BYPASSRLS`, ist kein Superuser und besitzt keine Tabelle.
6. Sichten, die die App-Rolle lesen darf, laufen mit `security_invoker`.

Ein Selbsttest legt eine Tabelle ohne Policy an und prüft, dass der Wächter sie erkennt. Eine neue Migration, die die Regel aus CLAUDE.md vergisst, macht den Test rot. Nicht geprüft: Funktionen mit `SECURITY DEFINER` (`search_idea_ids`, `similar_idea_ids`); sie sind im Review zu prüfen.

## Upgrade-Test und Rückweg

### Test

`server/test/upgrade.test.ts`:

1. Leert die Testdatenbank und spielt die Migrationen **bis einschließlich** `PREVIOUS_RELEASE_MIGRATION` ein (aktuell `030_learning.sql`, Stand von Release 0.3.0).
2. Schreibt mit reinem SQL Daten von zwei Mandanten (Nutzer, Challenge, Ideen, Ereignisse, Kommentare, Audit-Log, ein TOTP-Geheimnis im Altformat) und legt die Mandantenschlüssel an.
3. Ruft `migrate()` auf, genau wie der Server beim Start.
4. Prüft: alle Migrationen eingetragen, keine Zeile verloren, Werte unverändert (inkl. Umlaute), TOTP-Geheimnis verschlüsselt, RLS trennt die Mandanten (Lesen und Schreiben), die App liefert die Ideen über die API, ein zweiter Start ändert nichts.

Der Test funktioniert mit beliebig vielen späteren Migrationen (lokal mit Grenze `020_saas_ops.sql` und zehn Folgemigrationen geprüft).

**Beim Release:** `PREVIOUS_RELEASE_MIGRATION` auf die letzte Migrationsdatei des veröffentlichten Release setzen. Warum kein Seed: Der Seed nutzt die Services im aktuellen Stand und passt deshalb nicht zum alten Schema. Reines SQL gegen die Kernspalten bleibt stabil.

### Rückweg (Rollback-Strategie)

Migrationen laufen nur vorwärts. Es gibt keine Down-Migrationen, weil sie selten getestet sind und Daten verlieren können.

1. **Vorwärts reparieren (Standard).** Fehler in einer Migration oder im Code werden mit einer neuen Migration bzw. einem neuen Release behoben. Migrationen schreiben wir so, dass die vorherige App-Version mit dem neuen Schema weiterläuft (Spalten erst ergänzen, später entfernen; keine Umbenennung in einem Schritt). Dann ist ein Zurück auf das alte Image ohne Datenbank-Restore möglich.
2. **Sicherung vor jedem Deploy.** Vor dem Deploy einer Version mit neuen Migrationen:
   ```
   pg_dump --format=custom --no-owner --file=ideenportal-$(date +%Y%m%d-%H%M)-vor-<version>.dump "$DATABASE_URL"
   ```
   Die Datei verschlüsselt und getrennt vom Server aufbewahren (mindestens bis zum nächsten erfolgreichen Release). Bei Render zusätzlich die automatische Sicherung des bezahlten Datenbankplans nutzen (Point-in-Time-Recovery).
3. **Wiederherstellung (nur wenn 1. nicht reicht, z. B. Datenverlust durch eine Migration).**
   1. App stoppen bzw. auf 0 Instanzen setzen, damit niemand schreibt.
   2. Neue, leere Datenbank anlegen (nicht die alte überschreiben, sie bleibt für die Analyse).
   3. `pg_restore --no-owner --dbname="$NEUE_DATABASE_URL" ideenportal-…-vor-<version>.dump`
   4. Rolle `ideenportal_app` prüfen (wird von Migration 001 angelegt; bei einem neuen Cluster vorher `CREATE ROLE ideenportal_app NOLOGIN` und `GRANT ideenportal_app TO <app-nutzer>`).
   5. Das **vorherige** Image starten (Tag der alten Version aus ghcr.io) mit `DATABASE_URL` auf die neue Datenbank. `MIGRATE_ON_START` bleibt an; es gibt nichts nachzuholen.
   6. `GET /api/health` und `GET /api/version` prüfen, Stichprobe mit zwei Mandanten.
   7. Daten, die zwischen Sicherung und Stopp entstanden sind, aus der alten Datenbank gezielt nachtragen (Audit-Log hilft beim Finden). Mandanten informieren.
4. **Üben.** Restore einmal im Quartal auf Staging durchspielen und die Dauer festhalten.

## CI (`.github/workflows/ci.yml`)

| Job | Inhalt | Abhängig von |
| --- | --- | --- |
| Static checks | Secret-Scan mit gitleaks (Binary mit Prüfsumme) über die ganze Historie als erster Schritt, Ausnahmen nur für Testschlüssel und Beispielpasswörter in Tests (`.gitleaks.toml`); dann `npm audit` (high), `npm audit signatures`, Sicherheitsprüfung, ESLint, Typen, Textkatalog, Format geänderter Dateien | – |
| Tests and coverage | Server-Tests mit Abdeckung und Mindestwerten (postgres:16), Frontend-Tests, Build; Bericht als Artefakt | Static checks |
| Tests (pgvector) | Server-Tests mit pgvector | Static checks |
| Image, scan and SBOM | `docker build` mit `GIT_COMMIT`, Trivy (HIGH/CRITICAL mit verfügbarem Fix brechen ab), CycloneDX-SBOM (Artefakt `sbom-cyclonedx`) | Static checks |
| Image smoke, browser and load test | Gebautes Image mit PostgreSQL starten, `/api/health` und `/api/version` (Commit muss passen), Browser-Test mit Barrierefreiheit, kurzer Lasttest (5.000 Ideen, 20 Messungen, eigene Datenbank) im selben Image | Image, Tests |

- Die CI läuft bei Pull Requests und bei Push auf `main` und `staging` (Render deployt beide erst nach grünen Checks). Push auf andere Branches löst keine CI aus; das prüft der Pull Request. Das spart Actions-Minuten.
- Alle Actions sind auf den vollen Commit-SHA festgelegt (Version im Kommentar). Dependabot hält sie aktuell.
- `permissions: contents: read` für alle Workflows; nur Release und CodeQL erhalten zusätzliche Rechte, und nur im jeweiligen Job.
- `persist-credentials: false` beim Checkout, damit kein Token im Arbeitsverzeichnis liegt.
- Der Browser-Test läuft jetzt gegen das Docker-Image statt gegen `npm start`. Dadurch entfallen im Job `npm ci` und Build der Wurzel; nur das eigene Paket `e2e/` (Playwright, axe) wird installiert.
- Der Lasttest ist ein Rauchtest der Laufzeiten (Tabelle im Job-Summary). Er bricht nur bei Fehlern ab, nicht bei langsamen Werten.

## Lieferkette

- **Dependabot** (`.github/dependabot.yml`): npm (Wurzel, `server/`, `web/`, `e2e/`) jeden Montag, GitHub Actions und Docker einmal im Monat. Sicherheitsupdates kommen unabhängig davon sofort. Minor und Patch kommen gebündelt in einem Pull Request, Major-Updates einzeln. Node.js-Major im Docker-Image bewusst ausgenommen.
- **CodeQL** (`.github/workflows/codeql.yml`): `javascript-typescript`, Abfragen `security-extended`, bei Push auf `main`, montags und bei Pull Requests auf `main`, die `server/`, `web/`, `package.json` oder `package-lock.json` ändern. Reine Doku-Änderungen lösen CodeQL nicht aus.
- **SBOM**: CycloneDX-JSON des Images (Syft über `anchore/sbom-action`); in der CI als Artefakt, beim Release als Datei am GitHub-Release und als signierte Attestierung am Image.
- **Signatur**: cosign keyless (Sigstore, OIDC von GitHub Actions). Prüfen:
  ```
  cosign verify ghcr.io/<owner>/<repo>@<digest> \
    --certificate-identity-regexp 'https://github.com/<owner>/<repo>/' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com
  ```

## Release (`.github/workflows/release.yml`)

1. Version in `package.json`, `server/package.json` und `web/package.json` anheben (alle gleich).
2. Abschnitt `## <version> – <datum>` in `CHANGELOG.md` schreiben.
3. `PREVIOUS_RELEASE_MIGRATION` im Upgrade-Test auf die letzte Migration des **vorherigen** Release prüfen.
4. Tag setzen und pushen: `git tag v0.4.0 && git push origin v0.4.0`.

Der Workflow ruft die komplette CI auf. Danach prüft er, dass Tag, Paketversionen und CHANGELOG-Abschnitt zusammenpassen, baut das Image für `linux/amd64` mit Provenienz, pusht nach `ghcr.io/<owner>/<repo>` mit den Tags `<version>` und `latest`, erzeugt die SBOM, signiert das Image, hängt die SBOM als Attestierung an und legt den GitHub-Release mit den CHANGELOG-Notizen, dem Image-Digest und der SBOM-Datei an.

## Version und Commit

- `GET /api/version` (ohne Anmeldung) liefert `{ "version": "0.4.0", "commit": "<sha>" | null }`.
- Version aus `server/package.json`, Commit aus der Umgebungsvariable `GIT_COMMIT`. Nur ein Hex-Wert mit 7 bis 40 Zeichen wird ausgegeben, sonst `null`.
- Das Dockerfile hat das Build-Argument `GIT_COMMIT` (Standard leer) und setzt die Variable sowie das Label `org.opencontainers.image.revision`. CI und Release übergeben `github.sha`.

### Neue Umgebungsvariablen

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `GIT_COMMIT` | leer | Commit des Builds, wird von `GET /api/version` angezeigt. Wird im Image über `--build-arg GIT_COMMIT=…` gesetzt; bei Render ohne Build-Argument bleibt der Wert leer (`commit: null`), außer er wird als Umgebungsvariable gesetzt. |

## Render

Beide Dienste in `render.yaml` haben `autoDeployTrigger: checksPass`: Render deployt einen Commit erst, wenn alle GitHub-Checks dieses Commits grün sind. Voraussetzung: das Repository ist über die GitHub-App von Render verbunden (Checks sichtbar).

## Einmalige Schritte für Admins (GitHub)

- **Branch-Schutz** für `main` (und `staging`): Pull Request erforderlich, Pflicht-Checks „Static checks“, „Tests and coverage“, „Tests (pgvector)“, „Image, scan and SBOM“, „Image smoke, browser and load test“. „Secret scan“ ist seit November 2026 ein Schritt in „Static checks“ und kein eigener Check mehr. „Analyze (javascript-typescript)“ nicht als Pflicht-Check eintragen, weil CodeQL nur bei Pull Requests mit Code-Änderungen läuft und sonst Doku-PRs blockiert.
- **Private vulnerability reporting** einschalten (Settings › Code security), damit der Weg aus `SECURITY.md` funktioniert.
- **Dependabot alerts und security updates** einschalten.
- **Paket in ghcr.io**: nach dem ersten Release Sichtbarkeit festlegen (privat oder öffentlich) und dem Repository Schreibrechte geben.
- **Actions-Einstellungen**: „Allow GitHub Actions to create and approve pull requests“ bleibt aus; Workflow-Rechte standardmäßig „Read repository contents“.

## Grenzen und offene Punkte

- Die Workflows sind lokal nur mit `actionlint` (inkl. shellcheck) und einem YAML-Parser geprüft; der erste echte Lauf passiert auf GitHub.
- Kein lokaler Docker-Daemon in der Entwicklungsumgebung: Image-Build, Trivy und Smoke-Test sind nur in der CI gelaufen bzw. laufen dort zum ersten Mal. Geprüft wurde lokal, dass `node server/dist/main.js` die Version ausgibt und `node server/dist/db/loadtest.js` aus dem Build läuft.
- Trivy kann bei neu veröffentlichten Lücken im Basis-Image (`node:22-alpine`) ohne Codeänderung rot werden. Dann Basis-Image aktualisieren (Dependabot) oder einen begründeten Eintrag in `.trivyignore` mit Ablaufdatum anlegen.
- Lint-Warnungen (38) sind noch abzubauen; Format nur für neue Dateien verbindlich.
- Multi-Arch (arm64) ist bewusst nicht gebaut; bei Bedarf `platforms: linux/amd64,linux/arm64` im Release ergänzen (verdoppelt die Build-Zeit).
- Der Upgrade-Test prüft Kerntabellen; Spezialtabellen späterer Module sind über die übrigen Tests nach allen Migrationen abgedeckt, nicht über alte Daten.
