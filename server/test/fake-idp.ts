import Fastify, { type FastifyInstance } from 'fastify';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

// In-process OpenID Connect provider for the company-login tests (R3-26): discovery, JWKS and
// a token endpoint that checks client authentication and the PKCE verifier. The test decides
// which claims the ID token carries for each authorization code. No real identity provider.

export interface FakeIdp {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Registers an authorization code as if the person had signed in at the provider. */
  issueCode(authorizeUrl: string, claims: Record<string, unknown>, opts?: TokenOpts): string;
  /** Signs any payload with the provider's key (or another key). */
  sign(payload: Record<string, unknown>, opts?: TokenOpts): string;
  close(): Promise<void>;
  tokenRequests: number;
}

export interface TokenOpts {
  key?: KeyObject;
  alg?: string;
  kid?: string;
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

export function signJwt(payload: Record<string, unknown>, key: KeyObject, opts: TokenOpts = {}): string {
  const header = { alg: opts.alg ?? 'RS256', typ: 'JWT', kid: opts.kid ?? 'k1' };
  const data = `${b64(header)}.${b64(payload)}`;
  if (header.alg === 'none') return `${data}.`;
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), key).toString('base64url')}`;
}

export const otherKey = () => generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;

export async function startFakeIdp(clientId = 'portal-client', clientSecret = 'portal-secret'): Promise<FakeIdp> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
  const codes = new Map<string, { challenge: string; redirectUri: string; token: string }>();
  const app: FastifyInstance = Fastify({ logger: false });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });
  let issuer = '';
  const state = { tokenRequests: 0 };
  const PREFIX = '/tenant-1/v2.0'; // like Entra ID: https://login.microsoftonline.com/<tenant>/v2.0

  await app.register(async (idp) => {
    idp.get('/.well-known/openid-configuration', async () => ({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/keys`,
      response_types_supported: ['code'],
      subject_types_supported: ['pairwise'],
      id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      code_challenge_methods_supported: ['S256'],
    }));
    idp.get('/keys', async () => ({ keys: [jwk] }));
    idp.post('/token', async (req, reply) => {
      state.tokenRequests++;
      const body = req.body as Record<string, string>;
      const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const [id, secret] = basic ? Buffer.from(basic, 'base64').toString().split(':').map(decodeURIComponent) : [body.client_id, body.client_secret];
      if (id !== clientId || secret !== clientSecret) return reply.status(401).send({ error: 'invalid_client' });
      const entry = codes.get(body.code);
      codes.delete(body.code);
      if (!entry || body.grant_type !== 'authorization_code' || body.redirect_uri !== entry.redirectUri) return reply.status(400).send({ error: 'invalid_grant' });
      const challenge = createHash('sha256').update(body.code_verifier ?? '').digest('base64url');
      if (challenge !== entry.challenge) return reply.status(400).send({ error: 'invalid_grant', error_description: 'pkce' });
      return { access_token: 'at', token_type: 'Bearer', expires_in: 3600, id_token: entry.token };
    });
  }, { prefix: PREFIX });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  issuer = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}${PREFIX}`;

  return {
    issuer,
    clientId,
    clientSecret,
    get tokenRequests() {
      return state.tokenRequests;
    },
    issueCode(authorizeUrl, claims, opts) {
      const u = new URL(authorizeUrl);
      const code = `code-${Math.random().toString(36).slice(2)}`;
      const now = Math.floor(Date.now() / 1000);
      const payload = { iss: issuer, aud: clientId, iat: now, exp: now + 600, nonce: u.searchParams.get('nonce'), ...claims };
      codes.set(code, { challenge: u.searchParams.get('code_challenge') ?? '', redirectUri: u.searchParams.get('redirect_uri') ?? '', token: signJwt(payload, opts?.key ?? privateKey, opts) });
      return code;
    },
    sign: (payload, opts) => signJwt(payload, opts?.key ?? privateKey, opts),
    close: () => app.close(),
  };
}
