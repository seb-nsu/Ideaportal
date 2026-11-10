# Tenants and administration (enterprise)

[Deutsch](mandanten-und-administration.md) | English

As of 13 Oct 2026. This document describes the life cycle of workspaces (tenants), the full export, personal operator accounts, exceptions per tenant and delegated people management. Migration: `server/migrations/032_tenant_lifecycle_admin.sql`. Tests: `server/test/enterprise-admin.test.ts`.

## Overview

| Topic | Who | Where |
| --- | --- | --- |
| Suspend / resume | Operator (role owner or technical) | Operator console › Workspaces |
| Deletion with grace period (offboarding) | Admin of the workspace or operator | Settings › Data or operator console |
| Full export (ZIP) | Admin | Settings › Data |
| Operator accounts | Operator (role owner), command line | Operator console › Operator accounts |
| Functions and limits per tenant | Operator (owner or technical) | Operator console › Workspaces |
| People management | Admin and the new role `user_admin` | Settings › People |
| CSV import and bulk actions | Admin and `user_admin` | Settings › People |

## Status of a workspace

Every tenant has a status in `tenants.status`:

- **active** (`active`): normal operation.
- **suspended** (`suspended`): nobody can sign in, existing sessions get error 403 (`TENANT_SUSPENDED`). Jobs (deadlines, AI tasks, webhooks) and SCIM do not run for this tenant. The data stays unchanged.
- **being deleted** (`deleting`): deletion requested, grace period running. Only admins can sign in. Reading, sign-in, export and cancelling the deletion are allowed; everything else gets error 403 (`TENANT_DELETING`).

Suspending and resuming need a reason (3–300 characters). Both are recorded in the operator log and in the workspace's audit log (`tenant.suspend`, `tenant.resume`).

Enforcement happens in three places:

1. The database trigger `sessions_tenant_status` prevents new sessions. It reports SQLSTATE `IPT01` (suspended) or `IPT02` (being deleted).
2. `enforceTenantStatus()` checks every request before the package check.
3. Jobs, AI worker and webhook delivery only process active tenants.

The trigger `tenants_lifecycle_guard` prevents the application role `ideenportal_app` from changing the status columns itself.

## Deletion with grace period (offboarding)

1. An admin requests the deletion under Settings › Data. For this, they must confirm their identity again (see below) and type the short name of the workspace. An operator can also request the deletion, with a reason and an own grace period (0–365 days).
2. The status becomes `deleting`, `delete_after` = now + grace period. The grace period is 30 days by default (`TENANT_DELETE_GRACE_DAYS`). All people except admins are signed out.
3. Until the period ends, an admin or operator can cancel the deletion. The status then becomes `active` again.
4. After the period, the deadline job (`purgeDueTenants`) deletes all data of the tenant permanently.
5. A **deletion certificate** remains in the system table `tenant_deletions`, outside the tenant. It contains:
   - short name and name
   - time of request and deletion
   - who requested it: operator name, or `user-<hash>` as a pseudonym for admins
   - number of deleted rows per table

   It contains no content. Operators see the certificates in the console.

The former immediate deletion `DELETE` in `server/src/routes/pilot.ts` has been removed. Deletion only happens via this process.

### Confirming again

- **Accounts with password:** password and current code from the authenticator app. The code must not have been used before.
- **Company login (OIDC/SAML):** the session may be at most `REAUTH_SSO_MINUTES` minutes old (default 10), plus the short name. If the session is older, sign in again.

## Full export

Admins request the export under Settings › Data. A background worker creates it every `EXPORT_WORKER_SECONDS` seconds (default 10). When it is ready, the admin gets a notification and the audit log an entry `tenant.export_ready`. The file can be downloaded for `EXPORT_RETENTION_DAYS` days (default 7). After that it is deleted and marked as expired.

**Format** (ZIP, streamed with `yazl`):

- `tables/<table>.csv` and `tables/<table>.jsonl`: one file per tenant table. The list of tables comes from `information_schema`, so new tables are included automatically. CSV is UTF-8 with BOM, separator `;`, and protected against formula injection: texts starting with `=`, `+`, `-` or `@` get a leading `'`.
- `files/<table>/<id>/<file name>`: attachments and other binary data.
- `manifest.json` as the last entry: time, tenant, tables with columns and row count, excluded tables and columns, number and size of files. The SHA-256 checksum of the whole ZIP file is shown in the export list.

**Not in the export:**

- the tables `sessions`, `tenant_keys`, `tenant_secrets`, `oidc_login_states`, `outbox` and the export tables themselves
- columns with secrets, e.g. password hashes, MFA keys, token hashes and encrypted values (`*_enc`, `ciphertext`)

The export runs with `withTenant()` as `ideenportal_app`, i.e. under row-level security. It only contains data of the own tenant. The file is stored in blocks of about 1 MB in `tenant_export_chunks` and streamed on download.

The old immediate export `GET /api/admin/export` as JSON (without attachments) remains for now. It is **deprecated** and is to be removed with the next release.

## Operator accounts

Every person in operations has an own account in `operator_accounts`: email, name, scrypt password (at least 12 characters), mandatory TOTP (stored encrypted) and a role. After 5 failed attempts the account is locked for 15 minutes. A TOTP code can only be used once. Initial passwords must be changed at the first sign-in.

| Role | Rights |
| --- | --- |
| Owner (`owner`) | Everything, including operator accounts |
| Support (`support`) | Overview, support access, status messages |
| Billing (`billing`) | Overview, packages, invoices, quotas |
| Technical (`technical`) | Overview, create workspaces, status, functions and limits |

Every action is recorded in the operator log with `operator_id`. For tenant actions it is also recorded in the workspace's audit log, with the name of the operator person.

Protection rules: the last active owner cannot be deactivated or downgraded. Nobody can change their own role or own active status.

### Creating the first account

**Option A, command line (recommended):**

```
npm run operator -w server -- create --email ops@example.com --name "Vera Ops" --role owner
npm run operator -w server -- list
npm run operator -w server -- reset --email ops@example.com
npm run operator -w server -- deactivate --email ops@example.com
```

`create` and `reset` show the initial password and TOTP key once. In the container (without npm), the call is `node server/dist/db/operator-cli.js create …`, e.g. `docker exec -it <container> node server/dist/db/operator-cli.js list`.

**Option B, bootstrap sign-in:**

1. Set `OPERATOR_TOKEN` and `OPERATOR_TOTP_SECRET`; `npm run operator -w server -- setup` creates the values.
2. Sign in to the console with the access key. The console signs in as owner “operator”.
3. Create a personal owner account under Operator accounts.

As soon as an active owner exists, the bootstrap sign-in is blocked and existing bootstrap sessions become invalid. For emergencies (break glass), `OPERATOR_BREAK_GLASS=true` enables the bootstrap sign-in again. Switch it off again immediately afterwards.

## Functions and limits per tenant

Operators set exceptions per tenant in `tenant_overrides`:

- **Function** (`feature`): a package switch is turned on or off.
- **Limit** (`limit`): `fullAnalysesPerMonth` or `maxChallenges` gets a value from 0 to 100,000.

Every exception needs a reason and can have an expiry date. Expired exceptions no longer apply; they stay visible until someone removes them. Setting and removing (with reason) are recorded in the operator log and in the workspace's audit log (`tenant.override_set`, `tenant.override_removed`).

**Precedence:** package → overrides on the package (`tenant_plans`) → `tenant_overrides`. So the exceptions per tenant always win. The application may only read `tenant_overrides`.

## People management

### Role `user_admin`

The new role `user_admin` only has the right `managePeople`. It may:

- create, invite, change and deactivate people and assign roles
- import and run bulk actions

It may **not**:

- assign or remove the admin role
- change or deactivate admins
- access export, deletion, settings or audit log

In the interface it only sees the section “People”.

### CSV import

CSV or Excel file with the columns email (mandatory), name, roles, department and area. There are synonyms in German and English for the column names. Roles can be given as ID or as a label in any language. At most 2,000 rows.

The import runs in two steps: first a preview (`dryRun`) with a result per row, then the confirmation. New people get an invitation, existing people get the roles added. Triage, committee and department head with an area only apply to this area. Audit log entry: `users.import`.

### Bulk actions

Up to 500 selected people at once: deactivate, activate, add role or remove role. Skipped, each with a reason:

- unknown people
- admins, if a `user_admin` acts
- the own person
- people without a change

Audit log entry: `users.bulk`.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `TENANT_DELETE_GRACE_DAYS` | 30 | Grace period until final deletion |
| `EXPORT_RETENTION_DAYS` | 7 | How long an export can be downloaded |
| `EXPORT_WORKER_SECONDS` | 10 | Interval of the export worker |
| `REAUTH_SSO_MINUTES` | 10 | Maximum age of an SSO session for confirming again |
| `OPERATOR_BREAK_GLASS` | false | Allow bootstrap sign-in with `OPERATOR_TOKEN` although an owner account exists |

## API (excerpt)

- Workspace:
  - `GET /api/admin/workspace/lifecycle`
  - `POST /api/admin/workspace/delete`
  - `POST /api/admin/workspace/delete/cancel`
  - `GET|POST /api/admin/exports`
  - `GET /api/admin/exports/:id/download`
  - `POST /api/admin/users/import`
  - `POST /api/admin/users/bulk`
- Operator:
  - `POST /api/operator/tenants/:id/{suspend,resume,offboarding,offboarding/cancel}`
  - `GET /api/operator/deletions`
  - `GET|PUT /api/operator/tenants/:id/overrides`
  - `DELETE /api/operator/tenants/:id/overrides/:key`
  - `GET|POST /api/operator/operators`
  - `PATCH /api/operator/operators/:id`
  - `POST /api/operator/operators/:id/reset`
  - `POST /api/operator/me/password`

## Deliberately open

- Incoming chat commands (Teams/Slack) are not yet rejected specifically for suspended tenants. They only fail at the rights check.
- Operators cannot download a tenant's export themselves. That is only possible via the workspace's admin.
- The command line for operator accounts has no automatic tests.
