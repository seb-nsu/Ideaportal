# Versions and upgrades

[Deutsch](versionen-und-upgrades.md) | English

## Version scheme

The portal follows [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.

| Part | When | Example |
| --- | --- | --- |
| PATCH | Bug and security fixes, no new settings | 0.4.1 |
| MINOR | New functions, new migrations, backwards-compatible API | 0.5.0 |
| MAJOR | Changes customers have to adapt to (API, configuration) | 1.0.0 |

Before 1.0.0, a MINOR version can change environment variables; this is then stated in the section “Upgrade-Hinweise” (upgrade notes) of the [CHANGELOG](../../CHANGELOG.md). Every version has a Git tag `v<version>` and a container image `ghcr.io/seb-nsu/ideaportal:<version>` with SBOM and signature (workflow `release.yml`).

`GET /api/version` shows the running version.

## SaaS

After a green CI, the operator deploys versions to staging first, then to production. Maintenance with downtime is announced on the status page ([`sla-und-support.en.md`](sla-und-support.en.md)).

## Self-hosted operation (VM or container at the customer)

1. Read the notes in the CHANGELOG (new mandatory environment variables, upgrade notes).
2. Back up the database: `pg_dump -Fc "$DATABASE_URL" > before-upgrade.dump`.
3. Pull and start the new image. The migrations run at start (`MIGRATE_ON_START=true`) in a transaction with a database lock; with several instances, only one migrates.
4. Check `GET /api/health/ready` and sign in with a test account.

There is no need to avoid skipping versions: migrations run in order from any older state. A test checks the upgrade from the last release with data (`server/test/upgrade.test.ts`).

## Rolling back

Migrations only run forwards. If an error occurs after the upgrade:

1. **Preferably fix forwards:** a patch version with a correcting migration.
2. **If necessary, go back:** stop the app, restore the backup from step 2 into a new database (`pg_restore`), start the old image version with this database. Data since the upgrade is lost in the process.

## API

- Stable endpoints are listed in `/api/openapi.json`. Within a MAJOR version they only change in a backwards-compatible way (new fields, new endpoints).
- An endpoint that is removed is marked as `deprecated` in the CHANGELOG and in the OpenAPI document at least **6 months** in advance.
- Webhook events get new fields without notice; receivers ignore unknown fields.

## Supported versions

Security fixes are provided for the current MINOR version and the one before. See [`../../SECURITY.md`](../../SECURITY.md).
