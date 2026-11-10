import { z } from 'zod';
import { config } from '../config.js';
import { ROLES } from '../lib/context.js';
import { m, tr, type Locale, type MessageKey } from '../i18n/index.js';
import { challengeInput } from '../routes/misc.js';
import { commentInput, listQuery, submitInput } from '../routes/ideas.js';
import { tokenInput } from './apitokens.js';
import { STATUSES, decisionInput, ideaInput, triageInput } from './workflow.js';
import { SIGNATURE_HEADER, WEBHOOK_EVENTS, webhookInput, webhookUpdate } from './webhooks.js';
import { valueInput as metricValueInput } from './impactMetrics.js';

// OpenAPI 3.1 description of the public, stable endpoints (R3-17), generated from the same zod
// schemas the routes validate with (z.toJSONSchema, JSON Schema 2020-12 = OpenAPI 3.1).
// All other /api endpoints serve the web app and are internal: they may change without notice.

export const API_VERSION = '1.0.0';

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';
type Tag = 'ideas' | 'challenges' | 'integrations';

export interface Operation {
  id: string;
  method: Method;
  path: string;
  tag: Tag;
  /** Roles needed beyond a valid login or token; undefined = every role. */
  roles?: readonly string[];
  /** Only with a session (cookie): token and webhook management. */
  sessionOnly?: boolean;
  query?: z.ZodObject;
  body?: z.ZodType;
  response?: z.ZodType;
  status?: number;
}

// ---------------------------------------------------------------- response schemas (documentation)

const ok = z.object({ ok: z.literal(true) });
const status = z.enum(STATUSES);
const ideaSummary = z.looseObject({
  id: z.uuid(),
  number: z.number().int(),
  title: z.string(),
  status,
  topic: z.string().nullable(),
  confidential: z.boolean(),
});
const ideaDetail = z.looseObject({
  id: z.uuid(),
  number: z.number().int(),
  title: z.string(),
  problem: z.string(),
  solution: z.string(),
  benefit: z.string(),
  status,
  topic: z.string().nullable(),
  ideaType: z.enum(['internal', 'product']),
  confidential: z.boolean(),
  comments: z.array(z.looseObject({ id: z.uuid(), body: z.string(), createdAt: z.string() })),
});
const ideaStatus = z.object({
  id: z.uuid(),
  number: z.number().int(),
  status,
  lane: z.string().nullable(),
  updatedAt: z.string(),
  history: z.array(z.object({ kind: z.string(), from: status.nullable(), to: status.nullable(), at: z.string() })),
});
const challenge = z.looseObject({
  id: z.uuid(),
  title: z.string(),
  question: z.string(),
  startsOn: z.iso.date(),
  endsOn: z.iso.date(),
  phase: z.string().nullable(),
  acceptsIdeas: z.boolean().optional(),
});
const token = z.object({
  id: z.uuid(),
  name: z.string(),
  prefix: z.string(),
  roles: z.array(z.enum(ROLES)),
  expiresAt: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  state: z.enum(['active', 'expired', 'revoked']),
});
const createdToken = z.object({ id: z.uuid(), token: z.string().describe('ipt_<prefix>_<secret>; shown only once'), prefix: z.string(), roles: z.array(z.enum(ROLES)), expiresAt: z.string() });
const webhook = z.object({
  id: z.uuid(),
  name: z.string(),
  url: z.url(),
  events: z.array(z.enum(WEBHOOK_EVENTS)),
  active: z.boolean(),
  failureCount: z.number().int(),
  disabledAt: z.string().nullable(),
  pending: z.number().int(),
});
const delivery = z.object({
  id: z.uuid(),
  event: z.string(),
  status: z.enum(['pending', 'delivered', 'failed']),
  attempts: z.number().int(),
  responseStatus: z.number().int().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  nextAttemptAt: z.string(),
});

// Webhook payloads (R3-17): confidential ideas carry id, number, status and confidential=true only.
const ideaRef = z.object({
  id: z.uuid(),
  number: z.number().int(),
  status,
  confidential: z.boolean(),
  title: z.string().optional().describe('missing for confidential ideas'),
  topic: z.string().nullable().optional(),
  ideaType: z.string().nullable().optional(),
  challengeId: z.uuid().nullable().optional(),
  url: z.url().optional(),
});
const envelope = (type: string, data: z.ZodType) => z.object({ id: z.uuid(), type: z.literal(type), createdAt: z.string(), data });
const WEBHOOK_PAYLOADS: Record<(typeof WEBHOOK_EVENTS)[number], z.ZodType> = {
  'idea.submitted': envelope('idea.submitted', z.object({ idea: ideaRef })),
  'idea.status_changed': envelope('idea.status_changed', z.object({ idea: ideaRef, from: status, to: status, kind: z.string() })),
  'idea.gate_decided': envelope('idea.gate_decided', z.object({ idea: ideaRef, gate: z.union([z.literal(1), z.literal(2), z.literal(3)]), outcome: z.string(), delegated: z.boolean().optional() })),
  'challenge.phase_changed': envelope('challenge.phase_changed', z.object({ challenge: z.object({ id: z.uuid(), title: z.string(), phase: z.string().nullable(), previousPhase: z.string().nullable() }) })),
};

// ---------------------------------------------------------------- operations

const ADMIN = ['admin'] as const;

export const OPERATIONS: Operation[] = [
  { id: 'listIdeas', method: 'get', path: '/api/ideas', tag: 'ideas', query: listQuery, response: z.union([z.array(ideaSummary), z.object({ items: z.array(ideaSummary), nextCursor: z.string().nullable() })]) },
  { id: 'createIdea', method: 'post', path: '/api/ideas', tag: 'ideas', body: ideaInput.extend({ onBehalfOf: z.uuid().optional() }), response: z.object({ id: z.uuid(), number: z.number().int() }), status: 201 },
  { id: 'getIdea', method: 'get', path: '/api/ideas/{id}', tag: 'ideas', response: ideaDetail },
  { id: 'updateIdea', method: 'patch', path: '/api/ideas/{id}', tag: 'ideas', body: ideaInput.partial(), response: ok },
  { id: 'submitIdea', method: 'post', path: '/api/ideas/{id}/submit', tag: 'ideas', body: submitInput, response: ok },
  { id: 'getIdeaStatus', method: 'get', path: '/api/ideas/{id}/status', tag: 'ideas', response: ideaStatus },
  { id: 'commentIdea', method: 'post', path: '/api/ideas/{id}/comments', tag: 'ideas', body: commentInput, response: ok, status: 201 },
  { id: 'triageIdea', method: 'post', path: '/api/ideas/{id}/triage', tag: 'ideas', roles: ['triage', 'admin'], body: triageInput, response: z.object({ ok: z.literal(true), warning: z.string().nullable() }) },
  { id: 'decideIdea', method: 'post', path: '/api/ideas/{id}/decision', tag: 'ideas', roles: ['committee', 'admin', 'lead'], body: decisionInput, response: ok },
  { id: 'listChallenges', method: 'get', path: '/api/challenges', tag: 'challenges', response: z.array(challenge) },
  { id: 'getChallenge', method: 'get', path: '/api/challenges/{id}', tag: 'challenges', response: challenge },
  { id: 'createChallenge', method: 'post', path: '/api/challenges', tag: 'challenges', roles: ['admin', 'triage', 'committee'], body: challengeInput, response: z.object({ id: z.uuid() }), status: 201 },
  { id: 'listApiTokens', method: 'get', path: '/api/admin/api-tokens', tag: 'integrations', roles: ADMIN, sessionOnly: true, response: z.array(token) },
  { id: 'createApiToken', method: 'post', path: '/api/admin/api-tokens', tag: 'integrations', roles: ADMIN, sessionOnly: true, body: tokenInput, response: createdToken, status: 201 },
  { id: 'revokeApiToken', method: 'post', path: '/api/admin/api-tokens/{id}/revoke', tag: 'integrations', roles: ADMIN, sessionOnly: true, response: ok },
  { id: 'listWebhooks', method: 'get', path: '/api/admin/webhooks', tag: 'integrations', roles: ADMIN, sessionOnly: true, response: z.array(webhook) },
  { id: 'createWebhook', method: 'post', path: '/api/admin/webhooks', tag: 'integrations', roles: ADMIN, sessionOnly: true, body: webhookInput, response: z.object({ id: z.uuid(), secret: z.string().describe('whsec_…; shown only once') }), status: 201 },
  { id: 'updateWebhook', method: 'patch', path: '/api/admin/webhooks/{id}', tag: 'integrations', roles: ADMIN, sessionOnly: true, body: webhookUpdate, response: ok },
  { id: 'deleteWebhook', method: 'delete', path: '/api/admin/webhooks/{id}', tag: 'integrations', roles: ADMIN, sessionOnly: true, response: ok },
  { id: 'rotateWebhookSecret', method: 'post', path: '/api/admin/webhooks/{id}/rotate-secret', tag: 'integrations', roles: ADMIN, sessionOnly: true, response: z.object({ secret: z.string() }) },
  { id: 'testWebhook', method: 'post', path: '/api/admin/webhooks/{id}/test', tag: 'integrations', roles: ADMIN, sessionOnly: true, response: ok },
  { id: 'listWebhookDeliveries', method: 'get', path: '/api/admin/webhooks/{id}/deliveries', tag: 'integrations', roles: ADMIN, sessionOnly: true, response: z.array(delivery) },
  // Metric value from another system (R4-04): before or after, for a metric fixed at Gate 2.
  { id: 'recordMetricValue', method: 'post', path: '/api/impact-metrics/{metricId}/values', tag: 'integrations', roles: ['implementer', 'triage', 'admin'], body: metricValueInput, response: z.object({ id: z.uuid(), source: z.enum(['manual', 'api']) }), status: 201 },
];

// ---------------------------------------------------------------- generation

type Json = Record<string, unknown>;

function schema(s: z.ZodType, io: 'input' | 'output'): Json {
  const out = z.toJSONSchema(s, { io, unrepresentable: 'any' }) as Json;
  delete out.$schema;
  return out;
}

function parameters(op: Operation): Json[] {
  const params: Json[] = [...op.path.matchAll(/\{(\w+)\}/g)].map((p) => ({
    name: p[1], in: 'path', required: true, schema: { type: 'string', format: 'uuid' },
  }));
  if (op.query) {
    for (const [name, field] of Object.entries(op.query.shape)) {
      const f = field as z.ZodType;
      params.push({ name, in: 'query', required: !f.safeParse(undefined).success, schema: schema(f, 'input') });
    }
  }
  return params;
}

const t = (locale: Locale, key: string, vars?: Record<string, string | number>) => tr(locale, m(key as MessageKey, vars));

export function buildOpenApi(locale: Locale): Json {
  const paths: Record<string, Json> = {};
  for (const op of OPERATIONS) {
    const roles = op.roles ? t(locale, 'api.docs.rolesNeeded', { roles: op.roles.join(', ') }) : t(locale, 'api.docs.rolesAny');
    const entry: Json = {
      operationId: op.id,
      tags: [op.tag],
      summary: t(locale, `api.op.${op.id}`),
      description: op.sessionOnly ? `${roles} ${t(locale, 'api.docs.sessionOnly')}` : roles,
      parameters: parameters(op),
      security: op.sessionOnly ? [{ cookieAuth: [] }] : [{ bearerAuth: [] }, { cookieAuth: [] }],
      responses: {
        [String(op.status ?? 200)]: { description: 'OK', content: { 'application/json': { schema: op.response ? schema(op.response, 'output') : {} } } },
        '400': { $ref: '#/components/responses/Error' },
        '401': { $ref: '#/components/responses/Error' },
        '403': { $ref: '#/components/responses/Error' },
        '404': { $ref: '#/components/responses/Error' },
        '429': { $ref: '#/components/responses/Error' },
      },
    };
    if (op.body) entry.requestBody = { required: true, content: { 'application/json': { schema: schema(op.body, 'input') } } };
    (paths[op.path] ??= {})[op.method] = entry;
  }
  const webhooks: Record<string, Json> = {};
  for (const ev of WEBHOOK_EVENTS) {
    webhooks[ev] = {
      post: {
        summary: t(locale, `api.event.${ev}`),
        parameters: [
          { name: SIGNATURE_HEADER, in: 'header', required: true, schema: { type: 'string' }, description: t(locale, 'api.docs.signature') },
          { name: 'x-ideenportal-event', in: 'header', required: true, schema: { type: 'string' } },
          { name: 'x-ideenportal-delivery', in: 'header', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: { content: { 'application/json': { schema: schema(WEBHOOK_PAYLOADS[ev], 'output') } } },
        responses: { '2XX': { description: t(locale, 'api.docs.webhookAnswer') } },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: t(locale, 'api.docs.title'), version: API_VERSION, description: `${t(locale, 'api.docs.intro')}\n\n${t(locale, 'api.docs.internal')}` },
    servers: [{ url: config.publicUrl }],
    tags: (['ideas', 'challenges', 'integrations'] as const).map((name) => ({ name, description: t(locale, `api.tag.${name}`) })),
    paths,
    webhooks,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: t(locale, 'api.docs.bearer') },
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'ip_session' },
      },
      responses: {
        Error: {
          description: t(locale, 'api.docs.error'),
          content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' }, code: { type: 'string' }, details: {} }, required: ['error'] } } },
        },
      },
    },
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Readable page without scripts (strict CSP): list of the stable endpoints and the webhook events. */
export function docsHtml(locale: Locale): string {
  const spec = buildOpenApi(locale) as { info: { title: string }; paths: Record<string, Record<string, Json>> };
  const rows = OPERATIONS.map((op) => {
    const e = spec.paths[op.path][op.method];
    return `<tr><td><code class="m-${op.method}">${op.method.toUpperCase()}</code></td><td><code>${esc(op.path)}</code></td><td>${esc(String(e.summary))}<br><small>${esc(String(e.description))}</small></td></tr>`;
  });
  const sections = (['ideas', 'challenges', 'integrations'] as const).map((tag) => {
    const body = OPERATIONS.map((op, i) => (op.tag === tag ? rows[i] : '')).join('');
    return `<h2>${esc(t(locale, `api.tag.${tag}`))}</h2><table><thead><tr><th>${esc(t(locale, 'api.docs.method'))}</th><th>${esc(t(locale, 'api.docs.path'))}</th><th>${esc(t(locale, 'api.docs.description'))}</th></tr></thead><tbody>${body}</tbody></table>`;
  });
  const events = WEBHOOK_EVENTS.map((ev) => `<li><code>${ev}</code>: ${esc(t(locale, `api.event.${ev}`))}</li>`).join('');
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(spec.info.title)}</title><link rel="stylesheet" href="/api/docs.css"></head>
<body><main>
<h1>${esc(spec.info.title)}</h1>
<p>${esc(t(locale, 'api.docs.intro'))}</p>
<p>${esc(t(locale, 'api.docs.bearer'))}</p>
<p><a href="/api/openapi.json">${esc(t(locale, 'api.docs.json'))}</a></p>
<p class="note">${esc(t(locale, 'api.docs.internal'))}</p>
${sections.join('\n')}
<h2>${esc(t(locale, 'api.docs.webhooks'))}</h2>
<p>${esc(t(locale, 'api.docs.signature'))}</p>
<p>${esc(t(locale, 'api.docs.retry'))}</p>
<ul>${events}</ul>
</main></body></html>`;
}

export const DOCS_CSS = `body{font:16px/1.5 system-ui,sans-serif;margin:0;color:#1a1a1a;background:#fff}
main{max-width:960px;margin:0 auto;padding:16px}
table{border-collapse:collapse;width:100%;margin-bottom:24px}
th,td{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}
code{font-family:ui-monospace,monospace;word-break:break-all}
small{color:#555}.note{background:#fff6dd;padding:8px;border-radius:4px}
.m-get{color:#05603a}.m-post{color:#0b4f9c}.m-patch,.m-put{color:#7a4b00}.m-delete{color:#a01818}
@media (prefers-color-scheme:dark){body{background:#151515;color:#eee}th,td{border-color:#333}small{color:#aaa}.note{background:#3a3220}}`;
