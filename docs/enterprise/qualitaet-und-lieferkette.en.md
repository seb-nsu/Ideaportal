# Quality, CI/CD and supply chain

[Deutsch](qualitaet-und-lieferkette.md) | English

As of 13 Oct 2026, version 0.4.0. This document describes how code is checked, tested, built and delivered. It will later be merged into the README and `docs/betrieb.md`.

## Overview

| Area | What | Where |
| --- | --- | --- |
| Lint | ESLint (flat config, typescript-eslint, react-hooks for `web/`) | `eslint.config.mjs`, `npm run lint` |
| Format | Prettier, in CI only for changed files | `.prettierrc.json`, `.prettierignore`, `tools/format-changed.mjs` |
| Test coverage | `@vitest/coverage-v8` with minimum values | `server/vitest.config.ts`, `npm run test:coverage` |
| Frontend tests | Vitest, Testing Library, jsdom | `web/vitest.config.ts`, `web/test/`, `npm test -w web` |
| RLS guard | Every table with `tenant_id` has RLS, FORCE and a tenant policy | `server/test/rls-guard.test.ts` |
| Upgrade test | Database in the state of the last release, data of two tenants, then all new migrations | `server/test/upgrade.test.ts` |
| Endpoint tests | Previously untested endpoints, with 401/403/404 | `server/test/endpoints-coverage.test.ts` |
| Library tests | `ratelimit`, `pdf`, `importer`, `attachments`, `boundary` | `server/test/lib-units.test.ts` |
| CI | Static checks, secret scan, tests, image, Trivy, SBOM, smoke, browser and load test | `.github/workflows/ci.yml` |
| CodeQL | Static code analysis, weekly, on push to `main` and on pull requests with changes to code or dependencies | `.github/workflows/codeql.yml` |
| Dependencies | Dependabot, npm weekly, GitHub Actions and Docker monthly, minor and patch grouped | `.github/dependabot.yml` |
| Release | Tag `v*.*.*` → image in ghcr.io, signature, SBOM, GitHub release | `.github/workflows/release.yml` |
| Version | `GET /api/version` with version and commit | `server/src/lib/version.ts`, `Dockerfile` |
| Deploy | Render only deploys after a green CI | `render.yaml` (`autoDeployTrigger: checksPass`) |
| Reports | Reporting security vulnerabilities | `SECURITY.md` |
| Pull requests | Template with a checklist (definition of done) | `.github/pull_request_template.md` |

## Commands

| Command | Purpose |
| --- | --- |
| `npm run lint` | ESLint over `server/`, `web/` and `tools/`. Errors fail, warnings do not. |
| `npm run format` | Formats the files that are new or changed compared with `origin/main`. |
| `npm run format:check` | Checks like the CI: new files must be formatted, changed files create a warning. |
| `npm run format:all` | Formats the whole repository (see below, deliberately not run yet). |
| `npm test` | Server tests (needs PostgreSQL) and frontend tests. |
| `npm run test:coverage` | Server tests with coverage; report in `server/coverage/` (HTML, LCOV, JSON). |
| `npm test -w web` | Only the frontend tests (without a database). |
| `npm run check:texts` | Text catalogue: no visible texts outside the catalogue (also errors and warnings in `server/src/ai/`), every German key has an English text. |

## Lint

- Rules: `@eslint/js` recommended, `typescript-eslint` recommended, `react-hooks/rules-of-hooks` (error) and `react-hooks/exhaustive-deps` (warning).
- Adapted to the existing style without rewriting the code: `no-unused-vars`, `no-useless-assignment`, `no-useless-escape` and `no-explicit-any` are **warnings** for now (status: 38 warnings, 0 errors). Reason: parallel work on the same files; removing unused imports can break code during merges that has started using them in the meantime.
- Next step: reduce the warnings, then set these rules to `error` and use `--max-warnings 0`.
- `no-irregular-whitespace` ignores regular expressions and strings (deliberate checks for narrow spaces and BOM).

## Format: only changed files

The code is older than Prettier. A one-off `prettier --write .` would change almost every file (measured: about 315 of 390 TypeScript files in `server/` and `web/`) and collide with parallel work. Therefore:

- **New files** (added in the pull request or push) must be formatted. Otherwise the CI fails.
- **Changed files** create a warning in CI (annotation on the pull request) but do not fail. Whoever changes a file heavily anyway formats it with `npm run format`.
- Base: in a pull request the base commit, on push the previous state of the branch, otherwise the common ancestor with `origin/main`.
- Switching later: on a quiet day, run `npm run format:all` in its own commit, add the commit to `.git-blame-ignore-revs` and set `node tools/format-changed.mjs <base> --strict` in CI (then changed files block as well).
- Style (`.prettierrc.json`): single quotes, semicolons, `trailingComma: all`, line width 160 (compromise: the existing code uses very long lines).

## Test coverage

- Measured on 13 Oct 2026 (585 server tests): statements 90.1 %, branches 77.6 %, functions 94.0 %, lines 94.0 %.
- Minimum values in `server/vitest.config.ts`: statements 88, branches 75, functions 92, lines 92. If coverage falls below, `npm run test:coverage` (and the CI) fails.
- Only raise the minimum values, never lower them silently. Pure command line entry points are excluded (`main.ts`, seed, load test, CLIs).
- The CI uploads the report as the artefact `coverage-server` (14 days).

## Frontend tests

- Stored in `web/test/`, not in `web/src/`: this keeps the text and security checks limited to the app code, and test texts do not have to go into the catalogue.
- Covered: `t()` with fallback to German and to the key, variables, plural, formatting, language switch; API client (headers, JSON, `ApiError` with status, code, details, catalogue text for an empty answer); building blocks from `components.tsx` (ErrorBox, StatusBadge, DeadlineLight, IdeaList, Field, LoadMore, Dialog with Escape and focus, `useLoad`, `useAction`, UserPicker); sign-in page with a mocked `fetch` (sign-in, errors, choice of workspace, forgotten password, company login).
- Tests read expected texts from the catalogue (`t('login.email')`) so that text changes do not break tests.

## RLS guard

`server/test/rls-guard.test.ts` checks after all migrations:

1. Every table in the schema `public` with a column `tenant_id` has `relrowsecurity` **and** `relforcerowsecurity`.
2. Every such table that `ideenportal_app` may access has a policy for `ideenportal_app` (or PUBLIC) whose `USING` (and, if present, `WITH CHECK`) uses the tenant context (`current_tenant()` or `current_setting('app.tenant_id')`).
3. Tables with `tenant_id` without access for the app role (e.g. `operator_log`) are pure system tables and still have a policy.
4. `ideenportal_app` reaches no table without `tenant_id` except `tenants` (which itself has RLS).
5. `ideenportal_app` has no `BYPASSRLS`, is not a superuser and owns no table.
6. Views the app role may read run with `security_invoker`.

A self-test creates a table without a policy and checks that the guard detects it. A new migration that forgets the rule from CLAUDE.md turns the test red. Not checked: functions with `SECURITY DEFINER` (`search_idea_ids`, `similar_idea_ids`); they must be checked in review.

## Upgrade test and way back

### Test

`server/test/upgrade.test.ts`:

1. Empties the test database and applies the migrations **up to and including** `PREVIOUS_RELEASE_MIGRATION` (currently `030_learning.sql`, state of release 0.3.0).
2. Writes data of two tenants with plain SQL (users, challenge, ideas, events, comments, audit log, a TOTP secret in the old format) and creates the tenant keys.
3. Calls `migrate()`, exactly like the server at start.
4. Checks: all migrations recorded, no row lost, values unchanged (including umlauts), TOTP secret encrypted, RLS separates the tenants (reading and writing), the app delivers the ideas via the API, a second start changes nothing.

The test works with any number of later migrations (checked locally with the limit `020_saas_ops.sql` and ten following migrations).

**At release:** set `PREVIOUS_RELEASE_MIGRATION` to the last migration file of the published release. Why no seed: the seed uses the services in their current state and therefore does not fit the old schema. Plain SQL against the core columns stays stable.

### Way back (rollback strategy)

Migrations only run forwards. There are no down migrations because they are rarely tested and can lose data.

1. **Repair forwards (default).** Errors in a migration or in the code are fixed with a new migration or a new release. We write migrations so that the previous app version keeps running with the new schema (add columns first, remove them later; no renaming in one step). Then going back to the old image is possible without a database restore.
2. **Backup before every deploy.** Before deploying a version with new migrations:
   ```
   pg_dump --format=custom --no-owner --file=ideenportal-$(date +%Y%m%d-%H%M)-before-<version>.dump "$DATABASE_URL"
   ```
   Keep the file encrypted and separate from the server (at least until the next successful release). On Render, also use the automatic backup of the paid database plan (point-in-time recovery).
3. **Restore (only if 1. is not enough, e.g. data loss caused by a migration).**
   1. Stop the app or scale it to 0 instances so that nobody writes.
   2. Create a new, empty database (do not overwrite the old one; it stays for analysis).
   3. `pg_restore --no-owner --dbname="$NEW_DATABASE_URL" ideenportal-…-before-<version>.dump`
   4. Check the role `ideenportal_app` (created by migration 001; on a new cluster first run `CREATE ROLE ideenportal_app NOLOGIN` and `GRANT ideenportal_app TO <app user>`).
   5. Start the **previous** image (tag of the old version from ghcr.io) with `DATABASE_URL` pointing at the new database. `MIGRATE_ON_START` stays on; there is nothing to catch up.
   6. Check `GET /api/health` and `GET /api/version`, spot check with two tenants.
   7. Add data created between backup and stop selectively from the old database (the audit log helps to find it). Inform the tenants.
4. **Practise.** Rehearse the restore once a quarter on staging and record the duration.

## CI (`.github/workflows/ci.yml`)

| Job | Content | Depends on |
| --- | --- | --- |
| Static checks | Secret scan with gitleaks (binary with checksum) over the whole history as the first step, exceptions only for test keys and example passwords in tests (`.gitleaks.toml`); then `npm audit` (high), `npm audit signatures`, security check, ESLint, types, text catalogue, format of changed files | – |
| Tests and coverage | Server tests with coverage and minimum values (postgres:16), frontend tests, build; report as artefact | Static checks |
| Tests (pgvector) | Server tests with pgvector | Static checks |
| Image, scan and SBOM | `docker build` with `GIT_COMMIT`, Trivy (HIGH/CRITICAL with an available fix fail), CycloneDX SBOM (artefact `sbom-cyclonedx`) | Static checks |
| Image smoke, browser and load test | Start the built image with PostgreSQL, `/api/health` and `/api/version` (commit must match), browser test with accessibility, short load test (5,000 ideas, 20 measurements, own database) in the same image | Image, tests |

- The CI runs on pull requests and on push to `main` and `staging` (Render deploys both only after green checks). Pushes to other branches do not trigger CI; the pull request checks them. This saves Actions minutes.
- All actions are pinned to the full commit SHA (version in the comment). Dependabot keeps them up to date.
- `permissions: contents: read` for all workflows; only release and CodeQL get additional rights, and only in the relevant job.
- `persist-credentials: false` at checkout so that no token is left in the working directory.
- The browser test now runs against the Docker image instead of `npm start`. As a result, `npm ci` and the root build are no longer needed in the job; only the own package `e2e/` (Playwright, axe) is installed.
- The load test is a smoke test of the run times (table in the job summary). It only fails on errors, not on slow values.

## Supply chain

- **Dependabot** (`.github/dependabot.yml`): npm (root, `server/`, `web/`, `e2e/`) every Monday, GitHub Actions and Docker once a month. Security updates arrive immediately regardless. Minor and patch come grouped in one pull request, major updates individually. Node.js major in the Docker image deliberately excluded.
- **CodeQL** (`.github/workflows/codeql.yml`): `javascript-typescript`, queries `security-extended`, on push to `main`, on Mondays and on pull requests to `main` that change `server/`, `web/`, `package.json` or `package-lock.json`. Pure documentation changes do not trigger CodeQL.
- **SBOM**: CycloneDX JSON of the image (Syft via `anchore/sbom-action`); in CI as an artefact, at release as a file on the GitHub release and as a signed attestation on the image.
- **Signature**: cosign keyless (Sigstore, OIDC from GitHub Actions). Verify:
  ```
  cosign verify ghcr.io/<owner>/<repo>@<digest> \
    --certificate-identity-regexp 'https://github.com/<owner>/<repo>/' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com
  ```

## Release (`.github/workflows/release.yml`)

1. Raise the version in `package.json`, `server/package.json` and `web/package.json` (all the same).
2. Write the section `## <version> – <date>` in `CHANGELOG.md`.
3. Check `PREVIOUS_RELEASE_MIGRATION` in the upgrade test against the last migration of the **previous** release.
4. Set and push the tag: `git tag v0.4.0 && git push origin v0.4.0`.

The workflow calls the complete CI. Then it checks that tag, package versions and CHANGELOG section match, builds the image for `linux/amd64` with provenance, pushes to `ghcr.io/<owner>/<repo>` with the tags `<version>` and `latest`, creates the SBOM, signs the image, attaches the SBOM as an attestation and creates the GitHub release with the CHANGELOG notes, the image digest and the SBOM file.

## Version and commit

- `GET /api/version` (without sign-in) returns `{ "version": "0.4.0", "commit": "<sha>" | null }`.
- Version from `server/package.json`, commit from the environment variable `GIT_COMMIT`. Only a hex value with 7 to 40 characters is returned, otherwise `null`.
- The Dockerfile has the build argument `GIT_COMMIT` (empty by default) and sets the variable and the label `org.opencontainers.image.revision`. CI and release pass `github.sha`.

### New environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `GIT_COMMIT` | empty | Commit of the build, shown by `GET /api/version`. Set in the image via `--build-arg GIT_COMMIT=…`; on Render without a build argument the value stays empty (`commit: null`) unless it is set as an environment variable. |

## Render

Both services in `render.yaml` have `autoDeployTrigger: checksPass`: Render only deploys a commit when all GitHub checks of this commit are green. Prerequisite: the repository is connected via Render's GitHub app (checks visible).

## One-off steps for admins (GitHub)

- **Branch protection** for `main` (and `staging`): pull request required, required checks “Static checks”, “Tests and coverage”, “Tests (pgvector)”, “Image, scan and SBOM”, “Image smoke, browser and load test”. Since November 2026, “Secret scan” is a step in “Static checks” and no longer a check of its own. Do not add “Analyze (javascript-typescript)” as a required check, because CodeQL only runs on pull requests with code changes and would otherwise block documentation PRs.
- Switch on **private vulnerability reporting** (Settings › Code security) so that the path from `SECURITY.md` works.
- Switch on **Dependabot alerts and security updates**.
- **Package in ghcr.io**: after the first release, set the visibility (private or public) and give the repository write access.
- **Actions settings**: “Allow GitHub Actions to create and approve pull requests” stays off; workflow permissions by default “Read repository contents”.

## Limits and open points

- The workflows have only been checked locally with `actionlint` (including shellcheck) and a YAML parser; the first real run happens on GitHub.
- No local Docker daemon in the development environment: image build, Trivy and smoke test have only run in CI or run there for the first time. Checked locally: `node server/dist/main.js` prints the version and `node server/dist/db/loadtest.js` runs from the build.
- Trivy can turn red for newly published vulnerabilities in the base image (`node:22-alpine`) without a code change. Then update the base image (Dependabot) or add a justified entry with an expiry date to `.trivyignore`.
- Lint warnings (38) still need to be reduced; format is only binding for new files.
- Multi-arch (arm64) is deliberately not built; if needed, add `platforms: linux/amd64,linux/arm64` in the release (doubles the build time).
- The upgrade test checks core tables; special tables of later modules are covered by the other tests after all migrations, not with old data.
