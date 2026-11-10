import { X509Certificate, randomBytes } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import { SAML, ValidateInResponseTo, generateServiceProviderMetadata, type CacheItem, type CacheProvider, type Profile } from '@node-saml/node-saml';
import { z } from 'zod';
import { config } from '../config.js';
import { withSystem } from '../db/pool.js';
import { assertIdpUrl } from './oidc.js';

// SAML 2.0 service provider for the company login (R3-26), alternative to OpenID Connect.
// Signature, audience, time and InResponseTo checks come from @node-saml/node-saml (xml-crypto,
// xmldom); this module adds what the library leaves to the application: request IDs in the
// database (single use, bound to the browser), assertion replay protection, Recipient and
// Destination checks, metadata parsing without DTDs and certificate checks.

export const SAML_NS = 'urn:oasis:names:tc:SAML:2.0:assertion';
export const SAMLP_NS = 'urn:oasis:names:tc:SAML:2.0:protocol';
export const MD_NS = 'urn:oasis:names:tc:SAML:2.0:metadata';
export const DSIG_NS = 'http://www.w3.org/2000/09/xmldsig#';
const REDIRECT_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
const POST_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';
const TRANSIENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient';

export const CLOCK_SKEW_MS = 2 * 60 * 1000;
export const REQUEST_MINUTES = 10;
const MAX_XML_BYTES = 1024 * 1024;
export const CERT_WARN_DAYS = 30;

export class SamlError extends Error {
  constructor(
    public reason: string,
    message = reason,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- settings

export const samlAttributesSchema = z.object({
  email: z.string().trim().max(300).default(''),
  name: z.string().trim().max(300).default(''),
  department: z.string().trim().max(300).default(''),
  groups: z.string().trim().max(300).default(''),
});
export type SamlAttributes = z.infer<typeof samlAttributesSchema>;

export const samlSettingsSchema = z.object({
  metadataUrl: z.string().trim().max(1000).default(''),
  idpEntityId: z.string().trim().max(500).default(''),
  ssoUrl: z.string().trim().max(1000).default(''),
  // Up to two signing certificates of the identity provider (current and next, for rollover).
  certs: z.array(z.string().trim().max(20_000)).max(2).default([]),
  attributes: samlAttributesSchema.default({ email: '', name: '', department: '', groups: '' }),
  // Logins started at the identity provider (without AuthnRequest). Off by default.
  allowIdpInitiated: z.boolean().default(false),
});
export type SamlSettings = z.infer<typeof samlSettingsSchema>;

export const EMPTY_SAML: SamlSettings = samlSettingsSchema.parse({});

/** Attribute names tried after the configured one: Entra ID and ADFS (claim URIs), Okta and others (short names). */
export const DEFAULT_ATTRIBUTES: Record<keyof SamlAttributes, string[]> = {
  email: [
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
    'email',
    'mail',
    'Email',
    'urn:oid:0.9.2342.19200300.100.1.3',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn',
  ],
  name: ['http://schemas.microsoft.com/identity/claims/displayname', 'displayName', 'displayname', 'name', 'urn:oid:2.16.840.1.113730.3.1.241'],
  department: ['department', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/department', 'urn:oid:2.5.4.11'],
  groups: ['http://schemas.microsoft.com/ws/2008/06/identity/claims/groups', 'groups', 'http://schemas.xmlsoap.org/claims/Group', 'memberOf'],
};
const GIVEN = ['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname', 'firstName', 'givenName', 'urn:oid:2.5.4.42'];
const SURNAME = ['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname', 'lastName', 'sn', 'surname', 'urn:oid:2.5.4.4'];

// ---------------------------------------------------------------- SP URLs

export const spBase = (tenantId: string) => `${config.publicUrl}/api/auth/saml/${tenantId}`;
export const spEntityId = (tenantId: string) => `${spBase(tenantId)}/metadata`;
export const acsUrl = (tenantId: string) => `${spBase(tenantId)}/acs`;

export function spMetadata(tenantId: string): string {
  return generateServiceProviderMetadata({
    issuer: spEntityId(tenantId),
    callbackUrl: acsUrl(tenantId),
    identifierFormat: null,
    wantAssertionsSigned: true,
  });
}

// ---------------------------------------------------------------- XML helpers

/** Parses XML without DTDs: a DOCTYPE (and with it any entity, internal or external) is refused. */
export function parseXml(xml: string): Document {
  if (xml.length > MAX_XML_BYTES) throw new SamlError('too_large');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new SamlError('dtd');
  let failed = false;
  const doc = new DOMParser({
    locator: {},
    errorHandler: {
      warning: () => undefined,
      error: () => {
        failed = true;
      },
      fatalError: () => {
        failed = true;
      },
    },
  }).parseFromString(xml, 'text/xml');
  if (failed || !doc?.documentElement) throw new SamlError('malformed');
  return doc as unknown as Document;
}

function elements(node: Document | Element, ns: string, local: string): Element[] {
  return Array.from(node.getElementsByTagNameNS(ns, local) as unknown as ArrayLike<Element>);
}

function children(node: Element, ns: string, local: string): Element[] {
  return Array.from(node.childNodes as unknown as ArrayLike<Node>).filter(
    (n): n is Element => n.nodeType === 1 && (n as Element).localName === local && (n as Element).namespaceURI === ns,
  );
}

// ---------------------------------------------------------------- certificates

export interface CertInfo {
  subject: string;
  validFrom: string;
  validTo: string;
  daysLeft: number;
  fingerprint: string;
}

/** Accepts PEM or the bare base64 body (as in metadata); returns normalized PEM. */
export function normalizeCert(raw: string): string {
  const body = raw.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]{100,}$/.test(body)) throw new SamlError('cert_invalid');
  try {
    new X509Certificate(Buffer.from(body, 'base64'));
  } catch {
    throw new SamlError('cert_invalid');
  }
  return `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`;
}

export function certInfo(pem: string, now = Date.now()): CertInfo {
  const c = new X509Certificate(pem);
  const to = new Date(c.validTo).getTime();
  return {
    subject: c.subject.replace(/\n/g, ', '),
    validFrom: new Date(c.validFrom).toISOString(),
    validTo: new Date(to).toISOString(),
    daysLeft: Math.floor((to - now) / 86_400_000),
    fingerprint: c.fingerprint256,
  };
}

// ---------------------------------------------------------------- IdP metadata

export interface IdpMetadata {
  idpEntityId: string;
  ssoUrl: string;
  certs: string[];
}

/** Reads entity ID, SSO URL (HTTP-Redirect binding) and signing certificates from IdP metadata. */
export function parseIdpMetadata(xml: string): IdpMetadata {
  const doc = parseXml(xml.trim());
  const root = doc.documentElement;
  const entity = root.localName === 'EntityDescriptor' && root.namespaceURI === MD_NS ? root : elements(doc, MD_NS, 'EntityDescriptor')[0];
  if (!entity) throw new SamlError('metadata_no_entity');
  const idp = children(entity, MD_NS, 'IDPSSODescriptor')[0];
  if (!idp) throw new SamlError('metadata_no_idp');
  const sso = children(idp, MD_NS, 'SingleSignOnService');
  const redirect = sso.find((s) => s.getAttribute('Binding') === REDIRECT_BINDING) ?? sso.find((s) => s.getAttribute('Binding') === POST_BINDING);
  const certs: string[] = [];
  for (const kd of children(idp, MD_NS, 'KeyDescriptor')) {
    const use = kd.getAttribute('use');
    if (use && use !== 'signing') continue;
    for (const x of elements(kd, DSIG_NS, 'X509Certificate')) {
      const pem = normalizeCert(x.textContent ?? '');
      if (!certs.includes(pem)) certs.push(pem);
    }
  }
  const entityId = entity.getAttribute('entityID') ?? '';
  if (!entityId) throw new SamlError('metadata_no_entity');
  if (!redirect?.getAttribute('Location')) throw new SamlError('metadata_no_sso');
  if (!certs.length) throw new SamlError('metadata_no_cert');
  return { idpEntityId: entityId, ssoUrl: redirect.getAttribute('Location')!, certs: certs.slice(0, 2) };
}

/** Fetches metadata from the identity provider; the URL passes the SSRF guard of the company login. */
export async function fetchIdpMetadata(raw: string): Promise<IdpMetadata> {
  let url: URL;
  try {
    url = await assertIdpUrl(raw);
  } catch (err) {
    throw new SamlError('metadata_url', (err as Error).message);
  }
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: { accept: 'application/samlmetadata+xml, application/xml, text/xml' },
    });
  } catch (err) {
    throw new SamlError('metadata_fetch', (err as Error).name);
  }
  const text = await res.text();
  if (!res.ok) throw new SamlError('metadata_fetch', `status ${res.status}`);
  return parseIdpMetadata(text);
}

/** The SSO URL is only a browser redirect target; still https (unless OIDC_ALLOW_PRIVATE_URLS) and no credentials. */
export function validSsoUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.username || u.password) return false;
    return u.protocol === 'https:' || (config.oidcAllowPrivateUrls && u.protocol === 'http:');
  } catch {
    return false;
  }
}

export interface CheckReport {
  ok: boolean;
  problems: string[];
  warnings: string[];
  certs: CertInfo[];
  metadata?: { idpEntityId: string; ssoUrl: string; newCerts: number };
}

/** "Verbindung prüfen": settings complete, certificates valid and not expiring soon, metadata consistent. */
export async function checkSettings(s: SamlSettings, now = Date.now()): Promise<CheckReport> {
  const problems: string[] = [];
  const warnings: string[] = [];
  const certs: CertInfo[] = [];
  if (!s.idpEntityId) problems.push('entity_missing');
  if (!s.ssoUrl) problems.push('sso_missing');
  else if (!validSsoUrl(s.ssoUrl)) problems.push('sso_invalid');
  if (!s.certs.length) problems.push('cert_missing');
  for (const raw of s.certs) {
    try {
      const info = certInfo(normalizeCert(raw), now);
      certs.push(info);
      if (info.daysLeft < 0) problems.push('cert_expired');
      else if (info.daysLeft < CERT_WARN_DAYS) warnings.push('cert_expiring');
      if (new Date(info.validFrom).getTime() > now) warnings.push('cert_not_yet_valid');
    } catch {
      problems.push('cert_invalid');
    }
  }
  if (certs.length && certs.every((c) => c.daysLeft < 0)) problems.push('cert_all_expired');
  let metadata: CheckReport['metadata'];
  if (s.metadataUrl) {
    try {
      const md = await fetchIdpMetadata(s.metadataUrl);
      const configured = new Set(
        s.certs.map((c) => {
          try {
            return normalizeCert(c);
          } catch {
            return c;
          }
        }),
      );
      const newCerts = md.certs.filter((c) => !configured.has(c)).length;
      metadata = { idpEntityId: md.idpEntityId, ssoUrl: md.ssoUrl, newCerts };
      if (s.idpEntityId && md.idpEntityId !== s.idpEntityId) problems.push('metadata_entity_mismatch');
      if (s.ssoUrl && md.ssoUrl !== s.ssoUrl) warnings.push('metadata_sso_differs');
      if (newCerts) warnings.push('metadata_new_cert');
    } catch (err) {
      problems.push(err instanceof SamlError ? err.reason : 'metadata_fetch');
    }
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)], warnings: [...new Set(warnings)], certs, metadata };
}

// ---------------------------------------------------------------- request IDs in the database

/**
 * CacheProvider of node-saml backed by saml_requests. One instance per login start (with the
 * browser binding and target) or per ACS post (with a claim value: only this validation may
 * use the request ID, so a replayed or parallel post fails).
 */
export class DbRequestCache implements CacheProvider {
  row: { browserHash: string | null; returnTo: string } | null = null;
  private readonly claim = randomBytes(16).toString('hex');
  constructor(
    private tenantId: string,
    private start?: { browserHash: string | null; returnTo: string },
  ) {}

  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    await withSystem(async (c) => {
      await c.query('DELETE FROM saml_requests WHERE expires_at < now()');
      await c.query(
        `INSERT INTO saml_requests (request_id, tenant_id, browser_hash, return_to, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))`,
        [key, this.tenantId, this.start?.browserHash ?? null, this.start?.returnTo ?? '/', REQUEST_MINUTES],
      );
    });
    return { value, createdAt: Date.now() };
  }

  async getAsync(key: string): Promise<string | null> {
    const r = await withSystem(
      async (c) =>
        (
          await c.query<{ created_at: Date; browser_hash: string | null; return_to: string }>(
            `UPDATE saml_requests SET claimed_by = $3
        WHERE request_id = $1 AND tenant_id = $2 AND expires_at > now() AND (claimed_by IS NULL OR claimed_by = $3)
        RETURNING created_at, browser_hash, return_to`,
            [key, this.tenantId, this.claim],
          )
        ).rows[0],
    );
    if (!r) return null;
    this.row = { browserHash: r.browser_hash, returnTo: r.return_to };
    return r.created_at.toISOString();
  }

  async removeAsync(key: string | null): Promise<string | null> {
    if (!key) return null;
    const r = await withSystem(
      async (c) =>
        (
          await c.query<{ request_id: string }>(
            'DELETE FROM saml_requests WHERE request_id = $1 AND tenant_id = $2 AND (claimed_by IS NULL OR claimed_by = $3) RETURNING request_id',
            [key, this.tenantId, this.claim],
          )
        ).rows[0],
    );
    return r?.request_id ?? null;
  }
}

// ---------------------------------------------------------------- the service provider

export function serviceProvider(tenantId: string, s: SamlSettings, cache: CacheProvider): SAML {
  return new SAML({
    issuer: spEntityId(tenantId),
    callbackUrl: acsUrl(tenantId),
    audience: spEntityId(tenantId),
    entryPoint: s.ssoUrl,
    idpIssuer: s.idpEntityId,
    idpCert: s.certs.map(normalizeCert),
    // Either the assertion or the whole response (containing the assertion) must be signed.
    wantAssertionsSigned: false,
    wantAuthnResponseSigned: false,
    acceptedClockSkewMs: CLOCK_SKEW_MS,
    validateInResponseTo: s.allowIdpInitiated ? ValidateInResponseTo.ifPresent : ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: REQUEST_MINUTES * 60 * 1000,
    cacheProvider: cache,
    identifierFormat: null,
    // No RequestedAuthnContext: the identity provider decides about MFA (conditional access).
    disableRequestedAuthnContext: true,
    signatureAlgorithm: 'sha256',
    authnRequestBinding: 'HTTP-Redirect',
  });
}

export interface AssertionFacts {
  assertionId: string;
  expiresAt: Date;
}

/**
 * Checks the application leaves to us, on the verified assertion XML only (never on the
 * unverified rest of the response, XSW): issuer, Recipient of the bearer confirmation and ID.
 * The Destination of the response, when present, must be this ACS.
 */
export function checkAssertion(profile: Profile, opts: { acsUrls: string[]; idpEntityId: string; responseXml: string }): AssertionFacts {
  const xml = profile.getAssertionXml?.();
  if (!xml) throw new SamlError('no_assertion');
  const doc = parseXml(xml);
  const assertion = doc.documentElement;
  if (assertion.localName !== 'Assertion' || assertion.namespaceURI !== SAML_NS) throw new SamlError('no_assertion');
  const issuer = children(assertion, SAML_NS, 'Issuer')[0]?.textContent?.trim();
  if (issuer !== opts.idpEntityId) throw new SamlError('issuer');
  const subject = children(assertion, SAML_NS, 'Subject')[0];
  const confirmations = subject ? children(subject, SAML_NS, 'SubjectConfirmation') : [];
  const recipients = confirmations
    .filter((c) => c.getAttribute('Method') === 'urn:oasis:names:tc:SAML:2.0:cm:bearer')
    .flatMap((c) => children(c, SAML_NS, 'SubjectConfirmationData'))
    .map((d) => d.getAttribute('Recipient'));
  if (!recipients.some((r) => r && opts.acsUrls.includes(r))) throw new SamlError('recipient');

  const response = parseXml(opts.responseXml).documentElement;
  const destination = response.getAttribute('Destination');
  if (destination && !opts.acsUrls.includes(destination)) throw new SamlError('destination');

  const id = assertion.getAttribute('ID');
  if (!id) throw new SamlError('no_assertion');
  const conditions = children(assertion, SAML_NS, 'Conditions')[0];
  const notOnOrAfter = conditions?.getAttribute('NotOnOrAfter');
  const until = notOnOrAfter ? new Date(notOnOrAfter).getTime() : NaN;
  const expiresAt = new Date(Number.isFinite(until) ? Math.min(until + CLOCK_SKEW_MS, Date.now() + 24 * 3600_000) : Date.now() + 3600_000);
  return { assertionId: id, expiresAt };
}

/** Records the assertion ID; false when it was used before (replay). */
export async function consumeAssertion(tenantId: string, facts: AssertionFacts): Promise<boolean> {
  return withSystem(async (c) => {
    await c.query('DELETE FROM saml_used_assertions WHERE expires_at < now()');
    const r = await c.query('INSERT INTO saml_used_assertions (tenant_id, assertion_id, expires_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [
      tenantId,
      facts.assertionId,
      facts.expiresAt,
    ]);
    return r.rowCount === 1;
  });
}

// ---------------------------------------------------------------- attributes → claims

function values(v: unknown): string[] {
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) return v.flatMap(values);
  return [];
}

/**
 * Turns the SAML profile into the claims the shared provisioning understands (sub, email, name,
 * department, groups). Without an e-mail attribute a NameID in e-mail form is used.
 */
export function claimsFromProfile(profile: Profile, names: SamlAttributes): Record<string, unknown> & { sub: string | null } {
  const attrs = (profile.attributes ?? {}) as Record<string, unknown>;
  const pick = (key: keyof SamlAttributes): string[] => {
    for (const n of [names[key], ...DEFAULT_ATTRIBUTES[key]].filter(Boolean)) {
      const v = values(attrs[n]);
      if (v.length) return v;
    }
    return [];
  };
  const first = (list: string[]) => {
    for (const n of list) {
      const v = values(attrs[n]);
      if (v.length) return v[0];
    }
    return null;
  };
  const nameId = typeof profile.nameID === 'string' ? profile.nameID.trim() : '';
  const email = pick('email')[0] ?? (nameId.includes('@') ? nameId : null);
  const given = first(GIVEN);
  const family = first(SURNAME);
  const name = pick('name')[0] ?? ([given, family].filter(Boolean).join(' ') || null);
  const groupsAttr = names.groups || DEFAULT_ATTRIBUTES.groups.find((n) => n in attrs);
  return {
    // A transient NameID changes on every login and identifies nobody.
    sub: nameId && profile.nameIDFormat !== TRANSIENT ? nameId.slice(0, 500) : null,
    email,
    name,
    department: pick('department')[0] ?? null,
    // Entra ID with too many groups sends only a link (groups.link): then groups stay as they are.
    groups: groupsAttr && groupsAttr in attrs ? pick('groups') : null,
    email_verified: true,
  };
}
