import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { SignedXml } from 'xml-crypto';

// Fake SAML identity provider for the tests (R3-26): builds and signs SAML responses with
// xml-crypto. The keys and certificates under fixtures/saml are self-signed and only for tests
// (generated with openssl, no real system trusts them).

const dir = new URL('./fixtures/saml/', import.meta.url);
export interface KeyPair {
  key: string;
  cert: string;
}
const pair = (name: string): KeyPair => ({ key: readFileSync(new URL(`${name}.key`, dir), 'utf8'), cert: readFileSync(new URL(`${name}.crt`, dir), 'utf8') });
export const IDP_A = pair('idp-a');
export const IDP_B = pair('idp-b');
export const ATTACKER = pair('attacker');

export const IDP_ENTITY = 'https://idp.example/saml/metadata';
export const IDP_SSO = 'https://idp.example/saml/sso';

const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';
const EXC_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';

const iso = (offsetSeconds: number) => new Date(Date.now() + offsetSeconds * 1000).toISOString();
export const newId = () => `_${randomBytes(16).toString('hex')}`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface ResponseOpts {
  audience: string;
  recipient: string;
  destination?: string | null;
  inResponseTo?: string | null;
  issuer?: string;
  nameId?: string;
  nameIdFormat?: string;
  attributes?: Record<string, string | string[]>;
  notBefore?: number;
  notOnOrAfter?: number;
  assertionId?: string;
  signer?: KeyPair;
  signAssertion?: boolean;
  signResponse?: boolean;
  /** Change the XML after signing (tampering, wrapping attacks). */
  after?: (xml: string) => string;
}

function sign(xml: string, id: string, issuerXpath: string, signer: KeyPair): string {
  const sig = new SignedXml({ privateKey: signer.key, publicCert: signer.cert, signatureAlgorithm: RSA_SHA256, canonicalizationAlgorithm: EXC_C14N });
  sig.addReference({ xpath: `//*[@ID='${id}']`, digestAlgorithm: SHA256, transforms: [ENVELOPED, EXC_C14N] });
  sig.computeSignature(xml, { location: { reference: issuerXpath, action: 'after' } });
  return sig.getSignedXml();
}

export function buildResponse(o: ResponseOpts): { xml: string; base64: string; assertionId: string } {
  const assertionId = o.assertionId ?? newId();
  const responseId = newId();
  const issuer = o.issuer ?? IDP_ENTITY;
  const irt = o.inResponseTo ? ` InResponseTo="${o.inResponseTo}"` : '';
  const dest = o.destination === null ? '' : ` Destination="${esc(o.destination ?? o.recipient)}"`;
  const attrs = Object.entries(o.attributes ?? {})
    .map(
      ([name, v]) =>
        `<saml:Attribute Name="${esc(name)}">${(Array.isArray(v) ? v : [v]).map((x) => `<saml:AttributeValue>${esc(x)}</saml:AttributeValue>`).join('')}</saml:Attribute>`,
    )
    .join('');
  const assertion =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" Version="2.0" IssueInstant="${iso(0)}">` +
    `<saml:Issuer>${esc(issuer)}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="${o.nameIdFormat ?? 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent'}">${esc(o.nameId ?? 'nameid-1')}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${irt} NotOnOrAfter="${iso(o.notOnOrAfter ?? 300)}" Recipient="${esc(o.recipient)}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(o.notBefore ?? -60)}" NotOnOrAfter="${iso(o.notOnOrAfter ?? 300)}"><saml:AudienceRestriction><saml:Audience>${esc(o.audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(-5)}" SessionIndex="${newId()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    (attrs ? `<saml:AttributeStatement>${attrs}</saml:AttributeStatement>` : '') +
    `</saml:Assertion>`;
  let xml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${responseId}" Version="2.0" IssueInstant="${iso(0)}"${dest}${irt}>` +
    `<saml:Issuer>${esc(issuer)}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    assertion +
    `</samlp:Response>`;
  const signer = o.signer ?? IDP_A;
  if (o.signAssertion ?? true) xml = sign(xml, assertionId, `//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']`, signer);
  if (o.signResponse) xml = sign(xml, responseId, `/*[local-name(.)='Response']/*[local-name(.)='Issuer']`, signer);
  if (o.after) xml = o.after(xml);
  return { xml, base64: Buffer.from(xml, 'utf8').toString('base64'), assertionId };
}

/** Reads the AuthnRequest from the redirect URL of an SP-initiated login. */
export function readAuthnRequest(location: string): { id: string; xml: string; url: URL } {
  const url = new URL(location);
  const xml = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64')).toString('utf8');
  const id = /\bID="([^"]+)"/.exec(xml)![1];
  return { id, xml, url };
}

export function idpMetadata(certs: string[] = [IDP_A.cert], extra = ''): string {
  const body = (pem: string) => pem.replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, '');
  return (
    `<?xml version="1.0"?>${extra}<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${IDP_ENTITY}">` +
    `<md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">` +
    certs
      .map(
        (c) =>
          `<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${body(c)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`,
      )
      .join('') +
    `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${IDP_SSO}/post"/>` +
    `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${IDP_SSO}"/>` +
    `</md:IDPSSODescriptor></md:EntityDescriptor>`
  );
}
