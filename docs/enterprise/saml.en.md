# Company login with SAML 2.0 (R3-26)

[Deutsch](saml.md) | English

As of 13 Oct 2026. SAML 2.0 is an alternative to the company login with OpenID Connect (OIDC). **One** protocol applies per workspace. Groups → roles, allowed email domains, just-in-time creation, “switch off local accounts” and SCIM work the same for both protocols (ADR 0002, section company login).

## What is built

| Building block | Implementation | File |
| --- | --- | --- |
| Settings | Settings › Sign-in: protocol OIDC or SAML; entity ID and sign-in URL of the identity provider, up to two signing certificates (certificate rollover), attribute names with presets for Entra ID, Okta and ADFS, switch “IdP-initiated sign-in” (off by default) | `web/src/pages/SamlSettings.tsx`, `web/src/pages/IdentityAdmin.tsx` |
| Identity provider metadata | Load via URL (SSRF protection as with OIDC: https only, no internal addresses unless `OIDC_ALLOW_PRIVATE_URLS=true`) or paste as XML. Documents with DOCTYPE/ENTITY are rejected (no XXE) | `POST /api/admin/identity/saml/metadata`, `server/src/lib/saml.ts` |
| Check connection | Mandatory fields, certificates readable and valid, warning if they expire in less than 30 days, comparison with the metadata URL (different entity ID, different sign-in URL, new certificate at the provider) | `POST /api/admin/identity/saml/check` |
| Service provider per workspace | Entity ID `<PUBLIC_URL>/api/auth/saml/<tenant ID>/metadata`, ACS URL `<PUBLIC_URL>/api/auth/saml/<tenant ID>/acs` (tenant ID or slug), SP metadata as XML (`…/metadata?download` to download) | `server/src/routes/saml.ts` |
| SP-initiated sign-in | `GET /api/auth/saml/<slug>/login?weiter=/path` sends an AuthnRequest with HTTP redirect binding (without RequestedAuthnContext; the provider decides on MFA). The request ID is kept for 10 minutes in `saml_requests`, bound to the browser (cookie `ip_saml`) | `server/src/routes/saml.ts` |
| ACS | HTTP POST binding. The library `@node-saml/node-saml` (xml-crypto, xmldom) checks signature, audience, NotBefore/NotOnOrAfter (2 minutes tolerance), issuer and InResponseTo. In addition: recipient (bearer) and destination equal to the ACS URL, issuer of the signed assertion, assertion ID usable only once (`saml_used_assertions`), request ID usable only once and only by one check at a time (`claimed_by`), browser binding | `server/src/lib/saml.ts` |
| Signatures | Signed assertion **or** a signed response that contains the assertion. Unsigned, with a foreign key, altered, with two assertions or nested (XSW) → rejected | Tests `server/test/saml.test.ts` |
| Sign-in page | “Sign in with company login” starts OIDC or SAML depending on the protocol (`GET /api/auth/sso` returns `protocol`) | `web/src/pages/Login.tsx` |
| Accounts | Same rules as OIDC (`provision()`): lookup by NameID (stored in `users.oidc_subject`; transient NameIDs are not stored), otherwise by email address, otherwise just-in-time creation. Without an email attribute, the NameID applies if it is an address | `server/src/routes/identity.ts` |
| Session | `auth_method = 'saml'`; as with OIDC no own two-factor sign-in, the identity provider is responsible | `server/src/http.ts` |
| Audit log | `auth.sso_login` with `protocol: 'saml'` (and `idpInitiated`), `auth.sso_failed` with `protocol: 'saml'` and a short reason (e.g. `signature`, `audience`, `time`, `in_response_to`, `recipient`, `replay`, `browser`, `domain`), `user.jit_create` with `source: 'saml'`. No content of the assertion in the log | `server/src/routes/saml.ts` |

Migration: `server/migrations/034_saml.sql` (columns `tenant_identity.protocol` and `tenant_identity.saml`, extended check `sessions.auth_method`, tables `saml_requests` and `saml_used_assertions` with row-level security, system connection only).

Note on naming: the column `tenant_identity.oidc_enabled` (API field `oidcEnabled`) is the main switch “company login on” for **both** protocols. The name stays for compatibility.

New dependencies: `@node-saml/node-saml` 5.1, `@xmldom/xmldom` 0.8 (both server), `xml-crypto` 6 (tests only, signs the responses of the test provider).

New environment variables: none. `PUBLIC_URL` (determines entity ID and ACS URL – after a change, the values must be updated at the identity provider), `COOKIE_SECURE` and `OIDC_ALLOW_PRIVATE_URLS` apply.

## Setup by the admin

1. Open Settings › Sign-in and choose the protocol **SAML 2.0**.
2. Under “Values for the identity provider”, copy entity ID and ACS URL or download the metadata.
3. Create the application at the identity provider (see below), then enter the provider's metadata URL and “Load metadata” (or paste the XML).
4. Enter allowed email domains and groups → roles, “Switch on company login”, save.
5. “Check connection”, then sign in with a test account in a private window.
6. Only when this works and the admin has signed in with SAML can local accounts be switched off. Emergency access as with OIDC: `npm run identity -w server -- local-login <slug> on`.

### Microsoft Entra ID (enterprise application, SAML)

1. Entra admin center › Enterprise applications › New application › Create your own application (“Non-gallery”).
2. Single sign-on › SAML. Basic SAML configuration: **Identifier (Entity ID)** = entity ID from the portal, **Reply URL** = ACS URL. Sign-on URL optional: `<PUBLIC_URL>/api/auth/saml/<slug>/login`.
3. Attributes & Claims: the default is enough (email via `emailaddress`, name from given name and surname). For roles: “Add a group claim” (security groups, source “Group ID” or `sAMAccountName` for synchronised groups). For the department, add a claim `department` (without namespace) with `user.department`. In the portal, choose “Presets: Entra ID”.
4. SAML certificates: copy the “App Federation Metadata Url” and load it in the portal. Signing option “Sign SAML assertion” (default) or “Sign SAML response and assertion”; both are accepted. Algorithm SHA-256.
5. Assign users and groups. MFA via conditional access policies.
6. Limit: with more than 150 groups, Entra ID sends only a reference instead of the groups. The account's groups then stay unchanged (e.g. from SCIM). Remedy: “Groups assigned to the application” in the group claim.

### Okta

1. Admin Console › Applications › Create App Integration › SAML 2.0.
2. **Single sign-on URL** = ACS URL (“Use this for Recipient URL and Destination URL” ticked), **Audience URI (SP Entity ID)** = entity ID. Name ID format: `EmailAddress` or `Persistent`; application username: email.
3. Attribute statements: `email` = `user.email`, `firstName` = `user.firstName`, `lastName` = `user.lastName`, `department` = `user.department`. Group attribute statements: `groups`, filter e.g. “Starts with” `ideenportal-`. In the portal, choose “Presets: Okta” (name `displayName`, alternatively leave the field empty; then first plus last name applies).
4. Response and assertion signature: “Signed” (default), SHA-256.
5. Under “Sign On”, copy the **Metadata URL** and load it in the portal. Assign people or groups.

### ADFS

1. AD FS management › Relying Party Trusts › Add › “Import data about the relying party” with the portal's SP metadata URL (or file). Alternatively manually: SAML 2.0 WebSSO, URL = ACS URL, identifier = entity ID.
2. Claim issuance policy: “Send LDAP attributes as claims”: `E-Mail-Addresses` → E-Mail Address, `Display-Name` → Name, `department` → `department` (enter the outgoing type freely), `Token-Groups – Unqualified Names` → Group. In addition, a rule “Transform an incoming claim” E-Mail Address → Name ID (format email) if the NameID should be the address.
3. In the portal, choose “Presets: ADFS”. The metadata URL of ADFS is `https://<adfs-host>/FederationMetadata/2007-06/FederationMetadata.xml`.
4. By default, ADFS signs the assertion with SHA-256. With automatic certificate rollover (AutoCertificateRollover), enter the new certificate as the second certificate in good time; “Check connection” points this out.

## Limits (deliberately not built)

- **No signed AuthnRequests and no encrypted assertions.** That would need an own SP certificate per workspace; Node.js cannot create X.509 certificates without a further library. Entra ID, Okta and ADFS require neither. Transport encryption via HTTPS.
- **No single logout (SLO).** Signing out only ends the session in the portal.
- **No automatic reloading of certificates** from the metadata URL at sign-in. Rollover works via the second certificate field; “Check connection” warns 30 days before expiry and reports new certificates in the metadata.
- **Only HTTP redirect for the AuthnRequest and HTTP POST for the response** (no artifact binding).
- **Browser binding without HTTPS:** the ACS receives a cross-site POST; the cookie `ip_saml` only arrives there with `SameSite=None; Secure`. With `COOKIE_SECURE=true` (production), the binding is mandatory. Without HTTPS (local development), the cookie is `Lax` and is only checked if it arrives.
- **IdP-initiated sign-in** (off by default) has no binding to a request; protection is then only via signature, time window and the one-time assertion ID. The target is always the start page (RelayState is ignored, no open redirect).
- After more than one switch of protocol (OIDC ↔ SAML), the account is linked again via the email address, because the OIDC `sub` and the SAML NameID differ.
- The migration replaces the check `sessions_auth_method_check`. If further sign-in methods are added, the list there must be extended.

## Tests

`server/test/saml.test.ts` (34 tests) with an in-process test provider (`server/test/fake-saml-idp.ts`, signs with xml-crypto). Keys and certificates under `server/test/fixtures/saml/` are self-signed and for tests only. Covered: settings and rights, SP metadata, metadata import (XML, URL with SSRF protection, XXE rejected), certificate check (expiry within 30 days), AuthnRequest, sign-in with just-in-time creation, name, department and roles from groups (Entra and Okta attribute names), linking by address, signed response instead of assertion, second certificate, wrong audience, expired and not yet valid assertion, unsigned, foreign key, wrong recipient/destination/issuer, manipulated assertion, comment injection, XSW (two assertions, nested), DTD, replay of the response and of InResponseTo, foreign browser, IdP-initiated off/on with replay protection, domain not allowed, inactive account, just-in-time off, ACS of another tenant, tenant isolation with two tenants, no access of the app role to the new tables, switching off local accounts.
