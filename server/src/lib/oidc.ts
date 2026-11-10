import { createHash, createPublicKey, randomBytes, verify as verifySignature, type webcrypto } from 'node:crypto';
import { config } from '../config.js';
import { checkPublicUrl } from '../ai/providers.js';

type JsonWebKey = webcrypto.JsonWebKey & { kid?: string };

// OpenID Connect client for the company login (R3-26): discovery, authorization code flow
// with PKCE (S256), state and nonce, and verification of the ID token (RS256 against the
// provider's JWKS, issuer, audience, expiry). Built on node:crypto only; no other algorithm
// than RS256 is accepted (no "none", no HMAC with a public key).

export type OidcFailure = 'config' | 'discovery' | 'token' | 'id_token';

export class OidcError extends Error {
  constructor(public reason: OidcFailure, message: string) {
    super(message);
  }
}

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
  id_token_signing_alg_values_supported?: string[];
}

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  [claim: string]: unknown;
}

const CACHE_SECONDS = 3600;
const JWKS_REFRESH_SECONDS = 60;
const MAX_BYTES = 512 * 1024;
const discoveryCache = new Map<string, { doc: Discovery; at: number }>();
const jwksCache = new Map<string, { keys: JsonWebKey[]; at: number }>();

export function clearOidcCache(): void {
  discoveryCache.clear();
  jwksCache.clear();
}

const b64url = (buf: Buffer) => buf.toString('base64url');
export const randomValue = () => b64url(randomBytes(32));
export const pkceChallenge = (verifier: string) => b64url(createHash('sha256').update(verifier).digest());
export const normalizeIssuer = (issuer: string) => issuer.trim().replace(/\/+$/, '');

/**
 * Tenant-configured URLs must not reach the private network (SSRF) and need https, unless the
 * operator allows it with OIDC_ALLOW_PRIVATE_URLS (own provider in the intranet, tests).
 */
export async function assertIdpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OidcError('config', 'invalid url');
  }
  if (url.username || url.password) throw new OidcError('config', 'credentials in url');
  if (config.oidcAllowPrivateUrls) {
    if (!['http:', 'https:'].includes(url.protocol)) throw new OidcError('config', 'protocol');
    return url;
  }
  if (url.protocol !== 'https:') throw new OidcError('config', 'https required');
  const check = await checkPublicUrl(raw);
  if ('refused' in check) throw new OidcError('config', `url refused: ${check.refused}`);
  return url;
}

async function fetchJson(raw: string, reason: OidcFailure, init?: RequestInit): Promise<unknown> {
  const url = await assertIdpUrl(raw);
  let res: Response;
  try {
    res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new OidcError(reason, `request failed: ${(err as Error).name}`);
  }
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new OidcError(reason, 'response too large');
  if (!res.ok) throw new OidcError(reason, `status ${res.status}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new OidcError(reason, 'no json');
  }
}

/** Loads /.well-known/openid-configuration; the issuer in the document must match the configured one. */
export async function discover(issuer: string, fresh = false): Promise<Discovery> {
  const base = normalizeIssuer(issuer);
  const cached = discoveryCache.get(base);
  if (!fresh && cached && Date.now() - cached.at < CACHE_SECONDS * 1000) return cached.doc;
  const doc = (await fetchJson(`${base}/.well-known/openid-configuration`, 'discovery')) as Partial<Discovery>;
  for (const k of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    if (typeof doc[k] !== 'string' || !doc[k]) throw new OidcError('discovery', `missing ${k}`);
  }
  if (normalizeIssuer(doc.issuer!) !== base) throw new OidcError('discovery', 'issuer mismatch');
  if (doc.id_token_signing_alg_values_supported && !doc.id_token_signing_alg_values_supported.includes('RS256')) {
    throw new OidcError('discovery', 'RS256 not supported');
  }
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) await assertIdpUrl(doc[k]!);
  discoveryCache.set(base, { doc: doc as Discovery, at: Date.now() });
  return doc as Discovery;
}

export function authorizationUrl(d: Discovery, p: { clientId: string; redirectUri: string; state: string; nonce: string; codeVerifier: string; loginHint?: string }): string {
  const url = new URL(d.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', p.clientId);
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('scope', 'openid profile email');
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('state', p.state);
  url.searchParams.set('nonce', p.nonce);
  url.searchParams.set('code_challenge', pkceChallenge(p.codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  if (p.loginHint) url.searchParams.set('login_hint', p.loginHint);
  return url.toString();
}

/** Exchanges the authorization code at the token endpoint (client_secret_basic, else client_secret_post). */
export async function exchangeCode(d: Discovery, p: { clientId: string; clientSecret: string; redirectUri: string; code: string; codeVerifier: string }): Promise<string> {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri, code_verifier: p.codeVerifier, client_id: p.clientId });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  const methods = d.token_endpoint_auth_methods_supported;
  if (!methods || methods.includes('client_secret_basic')) {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(p.clientId)}:${encodeURIComponent(p.clientSecret)}`).toString('base64')}`;
  } else {
    body.set('client_secret', p.clientSecret);
  }
  const res = (await fetchJson(d.token_endpoint, 'token', { method: 'POST', headers, body: body.toString() })) as { id_token?: unknown };
  if (typeof res.id_token !== 'string') throw new OidcError('token', 'no id_token');
  return res.id_token;
}

async function loadKeys(jwksUri: string, refresh: boolean): Promise<JsonWebKey[]> {
  const cached = jwksCache.get(jwksUri);
  const age = cached ? (Date.now() - cached.at) / 1000 : Infinity;
  if (cached && age < CACHE_SECONDS && !(refresh && age > JWKS_REFRESH_SECONDS)) return cached.keys;
  const doc = (await fetchJson(jwksUri, 'id_token')) as { keys?: unknown };
  if (!Array.isArray(doc.keys)) throw new OidcError('id_token', 'jwks without keys');
  const keys = doc.keys as JsonWebKey[];
  jwksCache.set(jwksUri, { keys, at: Date.now() });
  return keys;
}

function pickKey(keys: JsonWebKey[], kid: string | undefined): JsonWebKey | undefined {
  const usable = keys.filter((k) => k.kty === 'RSA' && (!k.use || k.use === 'sig') && (!k.alg || k.alg === 'RS256'));
  if (kid) return usable.find((k) => k.kid === kid);
  return usable.length === 1 ? usable[0] : undefined;
}

function decodePart(part: string): Record<string, unknown> {
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object');
    return v as Record<string, unknown>;
  } catch {
    throw new OidcError('id_token', 'malformed');
  }
}

/** Verifies signature and claims of an ID token; returns the claims. */
export async function verifyIdToken(
  idToken: string,
  p: { jwksUri: string; issuer: string; clientId: string; nonce: string; now?: number; skewSeconds?: number },
): Promise<IdTokenClaims> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new OidcError('id_token', 'malformed');
  const header = decodePart(parts[0]);
  if (header.alg !== 'RS256') throw new OidcError('id_token', 'algorithm not allowed');
  const kid = typeof header.kid === 'string' ? header.kid : undefined;
  let jwk = pickKey(await loadKeys(p.jwksUri, false), kid);
  // Key rotation: an unknown key ID reloads the key set (at most once a minute).
  if (!jwk) jwk = pickKey(await loadKeys(p.jwksUri, true), kid);
  if (!jwk) throw new OidcError('id_token', 'unknown key');
  let ok = false;
  try {
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    ok = verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  } catch {
    ok = false;
  }
  if (!ok) throw new OidcError('id_token', 'bad signature');

  const c = decodePart(parts[1]) as Partial<IdTokenClaims>;
  const now = p.now ?? Math.floor(Date.now() / 1000);
  const skew = p.skewSeconds ?? 120;
  if (c.iss !== p.issuer) throw new OidcError('id_token', 'issuer');
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(p.clientId)) throw new OidcError('id_token', 'audience');
  if (aud.length > 1 && c.azp !== p.clientId) throw new OidcError('id_token', 'authorized party');
  if (typeof c.exp !== 'number' || c.exp < now - skew) throw new OidcError('id_token', 'expired');
  if (typeof c.iat !== 'number' || c.iat > now + skew) throw new OidcError('id_token', 'issued in the future');
  if (typeof c.nbf === 'number' && c.nbf > now + skew) throw new OidcError('id_token', 'not yet valid');
  if (c.nonce !== p.nonce) throw new OidcError('id_token', 'nonce');
  if (typeof c.sub !== 'string' || !c.sub) throw new OidcError('id_token', 'subject');
  return c as IdTokenClaims;
}
