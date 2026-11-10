# Security and observability (enterprise readiness)

[Deutsch](sicherheit-und-beobachtbarkeit.md) | English

As of 13 Oct 2026. This document describes what was built for security, logging and operations, which environment variables are new and what admins and operations need to do. It will later be merged into `docs/betrieb.md` and the implementation status.

Migration: `server/migrations/031_security_observability.sql`. New dependencies: `prom-client` (metrics), `undici` (pinning connections to checked addresses).

## 1. Sign-in log

The audit log (`audit_log`) now also contains sign-ins:

| Action | When | Tenant |
| --- | --- | --- |
| `auth.login` | Successful sign-in with password (`mfaPending` if the second factor is still missing) | Tenant of the account |
| `auth.login_failed` | Wrong password for an **existing** account | Tenant of this account |
| `auth.mfa_failed` / `auth.mfa_verified` | Wrong or correct second factor | Tenant of the account |
| `auth.logout` | Sign-out | Tenant of the session |
| `auth.sso_login` / `auth.sso_refused` | Company login (existed before, unchanged) | Tenant of the company login |
| `auth.locked`, `auth.rate_limited` | Lock after 5 failed attempts, rate limit (existed before) | Tenant of the account |

Unknown addresses create no entry (there is no tenant for them). People with accounts in several workspaces who sign in without naming the workspace get no failure entry as long as the password matches one account.

Every log row has three new columns:

- `request_id`: the request ID (see section 4) or, for background runs, `jobs:<uuid>`, `ai:<uuid>`, `webhooks:<uuid>`.
- `ip_hash`: HMAC-SHA256 of the client address, key derived from `SECRET_KEY` via HKDF, shortened to 32 hex characters. The same address gives the same hash; the address itself is not stored. A plain SHA-256 (as used for the rate limits) would be reversible for IPv4 by trying all addresses and was therefore not used.
- `user_agent`: browser identifier, shortened to 200 characters.

The database layer (`server/src/db/pool.ts`) sets the values for every transaction of a request; a trigger copies them into every new log row. This covers all write paths, including older direct `INSERT`s.

## 2. Tamper-evident log (hash chain)

Every log row belongs to a chain per tenant:

- `chain_seq`: consecutive number per tenant (1, 2, 3 …, without gaps),
- `prev_hash`: checksum of the previous row (the first row has 64 zeros),
- `row_hash = sha256(prev_hash || audit_canonical(row))`.

`audit_canonical` is a JSON array in fixed order: `[chain_seq, id, tenant_id, actor_id, action, entity, entity_id, before, after, created_at (UTC, microseconds), ip_hash, user_agent, request_id]`. The calculation runs in the database trigger `audit_log_chain`, i.e. for every write path. The head of the chain per tenant is stored in `audit_chain_heads`; its row lock serialises a tenant's entries until commit (under `REPEATABLE READ` there is a serialisation error instead of a fork). Existing entries were chained in the migration in the order of their IDs.

**Checking:** `GET /api/admin/audit/verify` (admins only) or the button “Check chain” under Settings › Audit log. Answer: `ok`, number of checked entries, range (`firstSeq`, `lastSeq`) and, for a break, the first affected entry with a reason:

- `row_hash`: content changed,
- `prev_hash`: link does not match (entry replaced or reordered),
- `gap`: an entry is missing,
- `tail`: the newest entries are missing (the chain head does not match the last entry).

The check itself is logged as `audit.verify`.

**Limits:** whoever has owner rights on the database can recalculate chain and head together. A copy of the checksums outside the portal protects against this: the SIEM forwarding (section 3) delivers `prevHash`, `rowHash` and the canonical text for every entry. The append-only trigger remains in place.

**Deleting a workspace:** the existing path (`purgeTenant`, migration 003) still works: all entries and the chain head of the tenant are deleted together. Individual entries remain undeletable. Should a retention period delete the oldest entries in future, the check starts at the first remaining entry (its `prev_hash` counts as the anchor, `firstSeq` shows the start). Deleting the oldest entries would then not be detectable on its own, only via the SIEM copy.

## 3. Viewing, exporting and forwarding the log

**View** (`GET /api/admin/audit`): new filters `from`, `to` (calendar days in the workspace's time zone, `to` inclusive, or ISO timestamps), `actor` (`system`, a user ID or part of a name/email) and `action` (prefix, e.g. `auth.`). With `paged=true` or `cursor=…`, the answer is `{ items, nextCursor }` (cursor pagination, at most 500 per page); without either, the previous array answer stays.

**Export** (`GET /api/admin/audit/export?format=csv|jsonl`, same filters): the export is streamed and no longer has an upper limit (previously 5,000 rows). It reads in blocks of 1,000 rows, each in its own short transaction. CSV with BOM, protection against formula injection (cells starting with `= + - @` get a leading `'`), additional columns number in the chain, email, address hash, browser, request ID, checksum. Every export is logged as `audit.export`.

**SIEM forwarding:** push via webhook was chosen because the existing webhook technology (signature, SSRF protection, sender, backoff) can be reused and operations need not secure an additional pull access.

- One target per workspace (`siem_settings`), `https` only and no addresses in the internal network (same check as for webhooks, connection pinned to the checked address, see section 8).
- The signing key `siemsec_…` is shown once and stored encrypted with the tenant key (`secret_enc`, secretbox).
- Sent in batches of at most 500 entries (up to 10 batches per run), oldest first, in the webhook loop (`WEBHOOK_SECONDS`, default 15 s) and in the job run.
- Body: `{ type: "audit.batch", tenantId, sentAt, fromSeq, toSeq, events: [...] }`, every event with `seq, id, createdAt, actorId, actorEmail, action, entity, entityId, before, after, ipHash, userAgent, requestId, prevHash, rowHash, canonical`.
- Headers as for webhooks: `X-Ideenportal-Signature: t=<unix>,v1=<HMAC-SHA256 over "<t>.<body>">`, `X-Ideenportal-Event: audit.batch`, `X-Ideenportal-Delivery: <tenant>:<from>-<to>` (the same on retry; receivers can drop duplicates).
- The position (`forwarded_seq`) only advances after a 2xx answer. Errors: retry after 1 min, 5 min, 30 min, 2 h, then every 12 h. Nothing is lost and the target is not switched off; after 10 failures in a row, the admins get one notification.
- Checking on the receiver side: `sha256(prevHash + canonical) == rowHash` and `prevHash` equal to the `rowHash` of the previous event.
- Data protection: the events contain what is in the log, including the email of the acting person and `before`/`after`. The SIEM is therefore a further recipient of personal data (add it to the record of processing activities).

API (admins only; changes only by people, not via API token): `GET/PUT/PATCH/DELETE /api/admin/audit/siem`, `POST /api/admin/audit/siem/rotate`. `PUT` takes `{ url, active?, backfill? }`; `backfill: true` first sends the whole existing log, otherwise forwarding starts with the next entry.

**Interface:** Settings › Audit log (filters, “Load more”, export CSV/JSON Lines, “Check chain”, SIEM target) and the new tab Settings › Security (minimum password length, sign-out after inactivity). Code: `web/src/pages/SecurityAdmin.tsx`.

## 4. Observability

- **Request IDs:** an incoming header `X-Request-Id` is used if it has 8–128 characters from `A-Z a-z 0-9 . _ : -`; otherwise the server creates a UUID. The ID is in every log line (`reqId`), in the response header `X-Request-Id`, in audit entries (`request_id`) and, for 500 errors, in the answer (`requestId`).
- **Errors:** unexpected errors are logged at level `error` with request ID and stack (without content, existing serialisers). Sentry or similar is deliberately not built in.
- **Log level:** `LOG_LEVEL` (default `info`).
- **Background runs:** job, AI and webhook loops log with `loop` and `runId`; audit entries from these runs carry `jobs:<runId>` etc.
- **Metrics:** `GET /api/metrics` in Prometheus format, only with `Authorization: Bearer <METRICS_TOKEN>`. Without `METRICS_TOKEN` set, the endpoint answers 404. Content:
  - process metrics (`ideenportal_process_*`, `ideenportal_nodejs_*`),
  - `ideenportal_http_request_duration_seconds` by method, route pattern (e.g. `/api/ideas/:id`, never concrete IDs) and status,
  - `ideenportal_ai_queue_jobs{state}`, `ideenportal_outbox_pending`, `ideenportal_webhook_deliveries_pending`, `ideenportal_job_last_run_age_seconds{loop}` (−1 = never),
  - `ideenportal_ai_calls_total{agent,status,local}`, `ideenportal_ai_cost_eur_total{agent}`, `ideenportal_background_runs_total{loop,outcome}`, `ideenportal_siem_batches_total{outcome}`.
  - No tenant names, IDs, people or idea content in labels. Counters apply per instance (sum them in Prometheus).

## 5. Health checks

| Path | Purpose | Answer |
| --- | --- | --- |
| `GET /api/health/live` | Process is running (without database) | always `200 {"status":"ok"}` |
| `GET /api/health/ready` | Database reachable | `200 {"status":"ok"}` or `503 {"status":"unavailable"}` |
| `GET /api/health` | as before, 503 only without database | publicly only `{"status":"ok"|"degraded"|"unavailable"}`; figures and alarm keys only with `METRICS_TOKEN` as bearer |

`Dockerfile` (HEALTHCHECK) and `render.yaml` (`healthCheckPath`) now use `/api/health/ready`. CI still waits for `/api/health` (200 stays the same). Whoever queried the figures publicly before now needs the token.

## 6. Secure defaults and key derivation

- With `NODE_ENV=production` (default in the Docker image), the server does not start without a `SECRET_KEY` of at least 32 characters (clear error message, exit code 1). A set `METRICS_TOKEN` must have at least 24 characters. `docker-compose.yml` sets `NODE_ENV=development` for local testing so that existing local data stays readable with the previous test key.
- If `PUBLIC_URL` is an https address, session cookies are always `Secure` (HSTS as well), and `COOKIE_SECURE=false` is then ignored (warning in the log). `COOKIE_SECURE=true` additionally enforces `Secure` behind a TLS proxy with an http `PUBLIC_URL`.
- **HKDF:** tenant keys are now stored as `k2.`; the wrapping key is derived via HKDF-SHA256 from `SECRET_KEY` (salt `ideenportal-secretbox`, info `tenant-key-wrap:v2`). Older `k1.` values (plain SHA-256) stay readable and are automatically re-wrapped as `k2.` at start (`upgradeKeyWrapping`, same data keys, stored secrets stay unchanged). Key rotation (`npm run rotate-key`) also writes `k2.`. Tested in `server/test/security-hardening.test.ts`.

## 7. Hardening sign-in

- **Same response time:** for unknown addresses and accounts without a password, the server checks against a dummy scrypt hash so that the response time does not reveal whether the account exists.
- **Password rules** (`server/src/lib/password.ts`) at registration, joining by link, joining as an external person and password reset:
  - minimum length per workspace (`security.passwordMinLength`, default 10, never below 10, at most 128),
  - block of very common passwords: the 1,000 most common passwords with at least 10 characters and 1,000 common base words (SecLists, MIT licence) plus some German words; a base word with only digits/characters before or after it (“Password2024!”) counts as common; also repetitions (“abcabcabcabc”) and sequences (“1234567890”),
  - the email name or the name of the workspace as password are blocked,
  - optional check against known data breaches with `PASSWORD_BREACH_CHECK=hibp` (Have I Been Pwned, k-anonymity: only the first 5 characters of the SHA-1 hash leave the server, answer with padding). Off by default, never in tests. If the service is not reachable, the password is not blocked (warning in the log).
  - error code `PASSWORD_POLICY` with `details.reason` (`tooShort`, `tooLong`, `common`, `personal`, `breached`).
- **Sign-out after inactivity** per workspace (`security.sessionIdleMinutes`, default 0 = off, otherwise 5–1440 minutes). Off by default so as not to change pilot operation. The session remembers `last_seen_at` (written at most once a minute); if it has been inactive for longer, it is deleted and the request counts as not signed in. The fixed maximum duration `SESSION_HOURS` stays in addition.

## 8. SSRF: protection against DNS rebinding

Previously, an address was checked and then resolved again by `fetch`; an attacker with their own DNS could switch to an internal address between check and connection. Now the server connects exactly to the checked address (`undici` agent with a pinned `lookup`, `server/src/ai/providers.ts`: `providerFetch`, `publicFetch`, `pinnedAgent`). URL, `Host` header and TLS server name (SNI, certificate check) stay those of the original name.

Used for: OpenAI-compatible AI providers, Anthropic with its own base URL, SearXNG search, page fetching of the source check, webhooks and SIEM forwarding. The list of blocked address ranges was extended (among others 198.18.0.0/15, multicast, IPv4-mapped addresses in hex form, `fe80::/10` completely, NAT64). **Not switched over** (other work areas, own check per request in place): OIDC discovery (`lib/oidc.ts`), connectors (`services/connectors.ts`), chat messages (`services/chat.ts`). They can use `publicFetch` later as well.

## New environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | Log level (`fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`) |
| `METRICS_TOKEN` | – | Bearer token for `/api/metrics` and the figures of `/api/health`; without a token, `/api/metrics` is off (404). At least 24 characters in production |
| `PASSWORD_BREACH_CHECK` | off | `hibp` = check new passwords against Have I Been Pwned (k-anonymity) |
| `COOKIE_SECURE` | (changed) | `true` enforces secure cookies; with an https `PUBLIC_URL` they are always secure |
| `NODE_ENV` | – | `production` requires `SECRET_KEY` ≥ 32 characters |

## Steps for operations and admins

1. Before the update, check that `SECRET_KEY` has at least 32 characters in production; otherwise the server does not start. Replace shorter keys by rotation (`docs/betrieb.md`, R3-41): first update with the old key and temporarily do not set `NODE_ENV` to `production`, then rotate.
2. Optionally set `METRICS_TOKEN` and point Prometheus with `bearer_token` at `/api/metrics`.
3. Switch the load balancer/platform to `/api/health/ready` (Render and the Docker image are adapted).
4. Admins: under Settings › Audit log, run “Check chain” once; if needed, enter a SIEM target and store the signing key in the SIEM. Under Settings › Security, set the minimum length and the sign-out after inactivity.
5. Record of processing activities: add the address hash and browser identifier in the log and, if applicable, the SIEM as a recipient.

## Tests

`server/test/security-audit.test.ts` (sign-in log, hash chain with manipulation, gap and missing end, parallel entries, tenant isolation, deleting a workspace, filters and cursor, streaming export over 5,000 rows, formula injection, SIEM with signature, backoff, rights and RLS) and `server/test/security-hardening.test.ts` (request IDs, error logs, LOG_LEVEL, run identifier, health, metrics, secure defaults, HKDF with old keys, same response time, inactivity, settings check, password rules with an HIBP fake, DNS rebinding with a fake resolver and a local server).
