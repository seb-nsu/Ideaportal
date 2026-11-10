# Security and data protection – overview for procurement and IT security

[Deutsch](sicherheit-whitepaper.md) | English

As of 13 Oct 2026, version 0.4.0. Summary for security questionnaires and customer audits. Details and evidence (in German): [security concept](../sicherheit/sicherheitskonzept.md) (structured along ISO/IEC 27001:2022 Annex A), [threat model](../adr/bedrohungsmodell.md), [data flow](../adr/datenfluss.md), [pentest preparation](../sicherheit/pentest-vorbereitung.md). No certification and no legal advice.

## At a glance

| Topic | Status |
| --- | --- |
| Hosting | EU (Render, Frankfurt) or self-hosted as a container at the customer |
| Tenant isolation | PostgreSQL row-level security on all tables (ENABLE and FORCE), tenant context in every request, automatic guard test |
| Sign-in | Company login via OIDC or SAML 2.0, SCIM 2.0, own accounts with TOTP, local accounts can be switched off |
| Encryption | TLS in transit, HSTS; stored secrets with AES-256-GCM and a key per tenant (HKDF, rotation); disks encrypted at the hosting provider |
| Logging | Append-only audit log, hash chain per tenant with a check function, export and SIEM forwarding |
| AI | Own gateway, confidential content never goes to external services, log of every AI action, quality check before going live |
| Development | Code review per pull request, CI with tests, CodeQL, dependency, secret and image scans, SBOM, signed images |
| Pentest | Prepared, execution by an external party open |

## 1 Architecture

A web application (Node.js, Fastify, React) with PostgreSQL 16. All interfaces and connectors use the same API (`/api/openapi.json`). Background jobs (deadlines, mails, AI queue, export) run in the app with database locks, only once even with several instances. The container image runs without root rights and without npm.

## 2 Tenant isolation

- Every request runs in a transaction as the database role `ideenportal_app` without `BYPASSRLS`, with the tenant of the signed-in person.
- Every table with `tenant_id` has a policy; a test fails the CI when a new table does not meet this (`server/test/rls-guard.test.ts`).
- Tests with two tenants check reading, writing, export and sign-in across tenant boundaries.
- The operator only sees a tenant's content with a time-limited approval by its admin; every access is recorded in the tenant's log with the name of the person at the operator.

## 3 Identity and access

- **Company login:** OIDC (PKCE, nonce, signature check) or SAML 2.0 (signed assertion, audience, recipient, validity, protection against replay and XML signature wrapping). Groups are mapped to roles.
- **SCIM 2.0** creates, changes and deactivates people.
- **Own accounts:** scrypt hashes, minimum length per tenant, check against common passwords, optionally with Have I Been Pwned; lock after 5 failed attempts; rate limits across all instances; TOTP, can be enforced for admins; sign-out after inactivity configurable.
- **Roles** with minimal rights, restriction to areas, a separate role for people management without access to settings.
- **API tokens** with roles, expiry (at most 365 days) and revocation.

## 4 Application security

- Inputs are validated with schemas; SQL only with parameters.
- Content security policy without `unsafe-inline`, `frame-ancestors 'none'`, SameSite cookies, CSRF rule.
- Outgoing connections (webhooks, AI providers, connectors, SIEM) only to public addresses and bound to the checked IP (protection against SSRF and DNS rebinding).
- Attachments: size limit, type check based on the file content, optional virus scan (ClamAV).
- Requests carry a request ID; logs contain no idea texts, no search terms and no passwords (with a test).

## 5 Logging and monitoring

- **Audit log:** sign-ins and failed attempts, roles, settings, exports, deletions, support access, AI exceptions, with IP hash and browser identifier. Append-only, chained per tenant with a hash chain and verifiable. Filters, export without a row limit, forwarding to a SIEM (signed webhook).
- **Operations:** Prometheus metrics (`/api/metrics`, with token), health checks `live` and `ready`, alerts by mail or webhook, public status page with availability.

## 6 Data protection

- Processing on behalf (DPA template, list of subprocessors in the product), draft data protection impact assessment and record of processing activities in [`../release-0/datenschutz/`](../release-0/datenschutz/) (German).
- Reports only aggregated and only from 5 people upwards; the AI does not assess people.
- Retention periods per tenant; access and export per person; anonymisation of deactivated accounts.
- Full export of the tenant as ZIP; deletion of the tenant with re-authentication, a 30-day grace period and a deletion certificate.
- The portal is not a reporting channel under the German Whistleblower Protection Act (HinSchG); possible reports are recognised and never passed to external services.

## 7 AI

- All model calls run through a gateway: provider and model per tenant and task, cost limit per idea and month, log of every action with model, prompt version, cost and sources.
- Confidential ideas only go to models on own infrastructure.
- Inputs are marked as data and separated from instructions (prompt injection); attacks are part of the test set.
- A building block only goes live when it passes the test set (90 cases); every change to model or prompt triggers a new check. If an unchecked fallback model answers, the result is clearly marked.
- The page “AI in the portal” shows all users the purpose, model, data path and last check per building block (transparency in the sense of the EU AI Act). The AI never decides; people decide at the gates.

## 8 Secure development and supply chain

- Changes only via pull request with CI: lint, type check, more than 690 automatic tests with minimum coverage, browser test with accessibility check, upgrade test.
- CodeQL, `npm audit`, check of package signatures, gitleaks, Trivy scan of the image, CycloneDX SBOM, Dependabot.
- Releases as signed container images (cosign, keyless) with SBOM; versions follow SemVer ([`versionen-und-upgrades.en.md`](versionen-und-upgrades.en.md)).
- Reporting security vulnerabilities: [`SECURITY.md`](../../SECURITY.md).

## 9 Availability and backup

Commitments per package in [`sla-und-support.en.md`](sla-und-support.en.md). Daily backup, restore rehearsed monthly, incident process with information to customers.

## 10 Open

- External pentest, review by a data protection officer and a lawyer, test with real Entra ID and Okta.
- Certification (e.g. ISO/IEC 27001 or BSI C5) has not started.
- Redundancy of app and database depends on the hosting provider's plan.
