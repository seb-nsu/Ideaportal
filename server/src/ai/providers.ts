import Anthropic from '@anthropic-ai/sdk';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { m, tr, type Text } from '../i18n/index.js';
import { Agent, fetch as undiciFetch } from 'undici';
import { config } from '../config.js';
import type { ProviderConfig } from './settings.js';

// Model providers behind the AI gateway (R2-09). The builtin provider is handled by the
// gateway itself (rule-based, per agent); here are the providers that call a model.

export interface GenerateRequest {
  model: string;
  system: string;
  prompt: string;
  /** JSON schema of the expected answer (structured output). */
  schema: Record<string, unknown>;
  maxTokens: number;
  images?: { mime: string; base64: string }[];
  deep: boolean;
  /** Server-side fallback to another model on a refusal (tenant setting ai.fallback.serverSide); default on. */
  allowFallback?: boolean;
}

export interface GenerateResult {
  json: unknown;
  inputTokens: number;
  outputTokens: number;
  /** Model that actually answered (differs when a server-side fallback ran). */
  servedBy: string;
  refused: boolean;
}

export interface ModelProvider {
  generate(req: GenerateRequest): Promise<GenerateResult>;
  /** Speech to text; language is the speaker's (ISO 639-1, R3-22). */
  transcribe?(audio: { mime: string; base64: string; filename: string }, model: string, language?: string): Promise<{ text: string; seconds: number }>;
}

/** Error of a model or search provider; the text is a catalogue entry (German as reference). */
export class ProviderError extends Error {
  constructor(readonly text: Text, readonly retryable = false) {
    super(tr('de', text));
  }
}

// ---------------------------------------------------------------- URL guard (SSRF)

export function privateIp(ip: string): boolean {
  if (ip.includes(':')) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) {
      const rest = v.slice(7);
      // IPv4-mapped in hex form (::ffff:7f00:1) is refused as a whole.
      return rest.includes('.') ? privateIp(rest) : true;
    }
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || /^fe[89ab]/.test(v) || v.startsWith('ff') || v.startsWith('64:ff9b:');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
    || (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0 && Number(ip.split('.')[2]) === 0) || a >= 224;
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

/** DNS resolution used by the URL guards; tests replace it with a fake (setDnsLookup). */
export type DnsLookup = (host: string) => Promise<ResolvedAddress[]>;
const systemLookup: DnsLookup = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family }));
let dnsLookup: DnsLookup = systemLookup;

/** Tests replace the resolver; without argument the system resolver is restored. */
export function setDnsLookup(fn?: DnsLookup): void {
  dnsLookup = fn ?? systemLookup;
}

async function resolveHost(host: string): Promise<ResolvedAddress[]> {
  const family = isIP(host);
  if (family) return [{ address: host, family }];
  return dnsLookup(host).catch(() => []);
}

/** The checked URL and the address it was checked against; the request must go to exactly this address. */
export interface CheckedUrl {
  url: URL;
  address: ResolvedAddress;
}

async function checkProviderUrl(raw: string | URL): Promise<CheckedUrl> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderError(m('aigw.err.invalidUrl'));
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ProviderError(m('aigw.err.httpOnly'));
  if (!config.aiAllowPrivateUrls && url.protocol !== 'https:') throw new ProviderError(m('aigw.err.httpsRequired'));
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const ips = await resolveHost(host);
  if (!ips.length) throw new ProviderError(m('aigw.err.hostUnreachable', { host }));
  if (!config.aiAllowPrivateUrls && ips.some((a) => privateIp(a.address))) {
    throw new ProviderError(m('aigw.err.privateBlocked'));
  }
  return { url, address: ips[0] };
}

/** Tenant-configured URLs must not reach the private network unless the operator allows it. */
export async function assertAllowedUrl(raw: string): Promise<URL> {
  return (await checkProviderUrl(raw)).url;
}

export type UrlRefusal = 'protocol' | 'private' | 'unresolved' | 'invalid';

async function checkPublic(raw: string | URL): Promise<CheckedUrl | { refused: UrlRefusal }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { refused: 'invalid' };
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return { refused: 'protocol' };
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return { refused: 'private' };
  const ips = await resolveHost(host);
  if (!ips.length) return { refused: 'unresolved' };
  if (ips.some((a) => privateIp(a.address))) return { refused: 'private' };
  return { url, address: ips[0] };
}

/**
 * Guard for the page fetch of the source check (R2-46): only http(s), never the private
 * network, whatever AI_ALLOW_PRIVATE_URLS says. Returns the reason when the URL is refused.
 */
export async function checkPublicUrl(raw: string): Promise<{ url: URL } | { refused: UrlRefusal }> {
  const r = await checkPublic(raw);
  return 'refused' in r ? r : { url: r.url };
}

/**
 * Connection pinned to the checked address (DNS rebinding): the name is not resolved a second
 * time when connecting, so it cannot point somewhere else between check and request. The URL
 * stays unchanged, so the Host header and the TLS server name (SNI, certificate check) are the
 * ones of the original host name.
 */
export function pinnedAgent(address: ResolvedAddress): Agent {
  const lookupPinned = (_host: string, opts: unknown, cb: (...args: unknown[]) => void) => {
    if (opts && typeof opts === 'object' && (opts as { all?: boolean }).all) cb(null, [{ address: address.address, family: address.family }]);
    else cb(null, address.address, address.family);
  };
  return new Agent({ connect: { lookup: lookupPinned as never } });
}

export type FetchInit = RequestInit & { redirect?: RequestRedirect };

async function fetchPinned(checked: CheckedUrl, init: FetchInit): Promise<Response> {
  const agent = pinnedAgent(checked.address);
  try {
    const res = await undiciFetch(checked.url, { ...(init as object), dispatcher: agent } as never);
    return res as unknown as Response;
  } finally {
    // Graceful: waits until the response body has been read, then frees the socket.
    void agent.close().catch(() => undefined);
  }
}

/** Fetch to a tenant-configured AI or search provider (rules of assertAllowedUrl), pinned to the checked address. */
export async function providerFetch(raw: string | URL, init: FetchInit = {}): Promise<Response> {
  return fetchPinned(await checkProviderUrl(raw), init);
}

export class UrlRefusedError extends Error {
  constructor(readonly reason: UrlRefusal) {
    super(`url refused: ${reason}`);
  }
}

/** Fetch to a public address only (rules of checkPublicUrl), pinned to the checked address. Throws UrlRefusedError. */
export async function publicFetch(raw: string | URL, init: FetchInit = {}): Promise<Response> {
  const r = await checkPublic(raw);
  if ('refused' in r) throw new UrlRefusedError(r.refused);
  return fetchPinned(r, init);
}

// ---------------------------------------------------------------- Anthropic

// Models that accept the server-side fallback chain; other models reject the parameter.
const FALLBACK_MODELS = /^claude-(opus-5-5|opus-5|sonnet-5-5|fable-5-1)$/;

export class AnthropicProvider implements ModelProvider {
  private client: Anthropic;
  constructor(apiKey: string, baseUrl?: string) {
    // A tenant-configured base URL gets the same guard as other providers, pinned per request.
    this.client = new Anthropic({
      apiKey, baseURL: baseUrl || undefined, timeout: config.aiTimeoutSeconds * 1000, maxRetries: 2,
      ...(baseUrl ? { fetch: ((url: string | URL | Request, init?: RequestInit) => providerFetch(url instanceof Request ? url.url : url, init)) as typeof fetch } : {}),
    });
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const content: Anthropic.Beta.Messages.BetaContentBlockParam[] = [
      ...(req.images ?? []).map((img) => ({
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: img.mime as 'image/png', data: img.base64 },
      })),
      { type: 'text', text: req.prompt },
    ];
    const fallback = req.allowFallback !== false && FALLBACK_MODELS.test(req.model);
    try {
      const stream = this.client.beta.messages.stream({
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: 'user', content }],
        output_config: { format: { type: 'json_schema', schema: req.schema }, ...(req.deep ? {} : { effort: 'low' as const }) },
        ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      });
      const msg = await stream.finalMessage();
      const usage = { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens };
      if (msg.stop_reason === 'refusal') return { json: null, ...usage, servedBy: msg.model, refused: true };
      if (msg.stop_reason === 'max_tokens') throw new ProviderError(m('aigw.err.truncated'));
      const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      return { json: JSON.parse(text), ...usage, servedBy: msg.model, refused: false };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (err instanceof Anthropic.AuthenticationError) throw new ProviderError(m('aigw.err.anthropicKey'));
      if (err instanceof Anthropic.RateLimitError) throw new ProviderError(m('aigw.err.anthropicRateLimit'), true);
      if (err instanceof Anthropic.APIConnectionError) throw new ProviderError(m('aigw.err.anthropicUnreachable'), true);
      if (err instanceof Anthropic.APIError) throw new ProviderError(m('aigw.err.anthropicError', { status: err.status ?? '?' }), (err.status ?? 0) >= 500);
      if (err instanceof SyntaxError) throw new ProviderError(m('aigw.err.invalidJson'));
      throw err;
    }
  }
}

// ---------------------------------------------------------------- OpenAI-compatible (EU and own models)

export class OpenAiCompatibleProvider implements ModelProvider {
  constructor(private baseUrl: string, private apiKey: string | null) {}

  private headers(json = true): Record<string, string> {
    return { ...(json ? { 'content-type': 'application/json' } : {}), ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) };
  }

  private async post(path: string, body: BodyInit, json = true): Promise<unknown> {
    const checked = await checkProviderUrl(this.baseUrl.replace(/\/+$/, '') + path);
    const url = checked.url;
    let res: Response;
    try {
      res = await fetchPinned(checked, { method: 'POST', headers: this.headers(json), body, signal: AbortSignal.timeout(config.aiTimeoutSeconds * 1000), redirect: 'error' });
    } catch {
      throw new ProviderError(m('aigw.err.providerUnreachable', { host: url.host }), true);
    }
    if (res.status === 401 || res.status === 403) throw new ProviderError(m('aigw.err.keyRejected'));
    if (!res.ok) throw new ProviderError(m('aigw.err.providerError', { status: res.status }), res.status === 429 || res.status >= 500);
    return res.json();
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const userContent = req.images?.length
      ? [...req.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.base64}` } })), { type: 'text', text: req.prompt }]
      : req.prompt;
    const body = {
      model: req.model,
      max_tokens: req.maxTokens,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: userContent },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: req.schema } },
    };
    const data = (await this.post('/chat/completions', JSON.stringify(body))) as {
      model?: string;
      choices?: { message?: { content?: string; refusal?: string | null }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = data.choices?.[0];
    const usage = { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 };
    if (choice?.message?.refusal) return { json: null, ...usage, servedBy: data.model ?? req.model, refused: true };
    if (choice?.finish_reason === 'length') throw new ProviderError(m('aigw.err.truncated'));
    const text = (choice?.message?.content ?? '').replace(/^```(json)?\s*|\s*```$/g, '');
    try {
      return { json: JSON.parse(text), ...usage, servedBy: data.model ?? req.model, refused: false };
    } catch {
      throw new ProviderError(m('aigw.err.invalidJson'));
    }
  }

  async transcribe(audio: { mime: string; base64: string; filename: string }, model: string, language = 'de'): Promise<{ text: string; seconds: number }> {
    const form = new FormData();
    form.append('model', model);
    form.append('language', language);
    form.append('file', new Blob([Buffer.from(audio.base64, 'base64')], { type: audio.mime }), audio.filename);
    const data = (await this.post('/audio/transcriptions', form, false)) as { text?: string; duration?: number };
    return { text: data.text ?? '', seconds: data.duration ?? 0 };
  }
}

// ---------------------------------------------------------------- factory

export type ProviderFactory = (p: ProviderConfig, apiKey: string | null) => ModelProvider;

const defaultFactory: ProviderFactory = (p, apiKey) => {
  if (p.kind === 'anthropic') {
    if (!apiKey) throw new ProviderError(m('aigw.err.anthropicNoKey'));
    return new AnthropicProvider(apiKey, p.baseUrl);
  }
  if (p.kind === 'openai_compatible') {
    if (!p.baseUrl) throw new ProviderError(m('aigw.err.noBaseUrl'));
    return new OpenAiCompatibleProvider(p.baseUrl, apiKey);
  }
  throw new ProviderError(m('aigw.err.builtinNoModel'));
};

let factory: ProviderFactory = defaultFactory;

/** Tests replace the factory with a fake model; production always uses the default. */
export function setProviderFactory(f: ProviderFactory | null): void {
  factory = f ?? defaultFactory;
}

export function createProvider(p: ProviderConfig, apiKey: string | null): ModelProvider {
  return factory(p, apiKey);
}

export function platformKey(p: ProviderConfig): string | null {
  if (p.kind === 'anthropic') return config.anthropicApiKey ?? null;
  if (p.kind === 'openai_compatible') return config.openaiCompatibleApiKey ?? null;
  return null;
}
