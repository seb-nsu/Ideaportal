import type { FastifyInstance } from 'fastify';
import { createHmac, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withTenant } from '../src/db/pool.js';
import type { SessionUser } from '../src/lib/context.js';
import { dispatchChat, setChatHttp, validWebhookUrl, type ChatHttp, type ChatRequest } from '../src/services/chat.js';
import { setJwksSource, slackSignature, verifySlack, verifyTeamsHmac, parseCommand, type JwksSource } from '../src/services/chatInbound.js';
import { asUser, client, createTenant, createUser, login, resetDb, testApp, validIdea } from './helpers.js';

// Chat channels Slack and Teams (R3-16): signatures, mapping by e-mail within the tenant,
// confidential titles, categories, two tenants. No network: all HTTP goes to a fake.

let app: FastifyInstance;
let tenant: string;
let other: string;
let users: Record<string, SessionUser>;
let api: Record<string, ReturnType<typeof client>>;
let sent: ChatRequest[] = [];
let prevHttp: ChatHttp;
let prevJwks: JwksSource;

const SLACK_SECRET = 'slack-signing-secret-a';
const SLACK_SECRET_B = 'slack-signing-secret-b';
const TEAMS_TOKEN = Buffer.from('teams-outgoing-webhook-token-a').toString('base64');
const BOT_APP_ID = '11111111-2222-3333-4444-555555555555';
/** Slack member id -> e-mail address as Slack would answer users.info. */
const slackEmails: Record<string, string> = {
  U_MIA: 'mia@chat.example',
  U_MAX: 'max@chat.example',
  U_SAME: 'same@chat.example',
  U_FOREIGN: 'foreign@nachbar.example',
};

const fake: ChatHttp = async (req) => {
  sent.push(req);
  const url = new URL(req.url);
  if (url.hostname === 'slack.com') {
    const method = url.pathname.replace('/api/', '');
    if (method === 'users.info') {
      const email = slackEmails[url.searchParams.get('user') ?? ''];
      return { status: 200, body: email ? { ok: true, user: { profile: { email } } } : { ok: false, error: 'user_not_found' } };
    }
    if (method === 'users.lookupByEmail') {
      const id = Object.entries(slackEmails).find(([, e]) => e === url.searchParams.get('email'))?.[0];
      return { status: 200, body: id ? { ok: true, user: { id } } : { ok: false, error: 'users_not_found' } };
    }
    return { status: 200, body: { ok: true } };
  }
  return { status: 200, body: '1' };
};

let slackA: { commands: string; interactions: string };
let slackB: { commands: string };
let teamsA: string;

beforeAll(async () => {
  await resetDb();
  prevHttp = setChatHttp(fake);
  app = await testApp();
  tenant = await createTenant('chat');
  other = await createTenant('nachbar');
  users = {
    mia: await createUser(tenant, 'mia@chat.example'),
    max: await createUser(tenant, 'max@chat.example'),
    same: await createUser(tenant, 'same@chat.example'),
    triage: await createUser(tenant, 'triage@chat.example', ['submitter', 'triage']),
    admin: await createUser(tenant, 'admin@chat.example', ['submitter', 'admin']),
    foreign: await createUser(other, 'foreign@nachbar.example'),
    sameB: await createUser(other, 'same@chat.example'),
    adminB: await createUser(other, 'adminb@nachbar.example', ['submitter', 'admin']),
  };
  api = {};
  for (const [k, u] of Object.entries(users)) api[k] = client(app, await login(app, u.tenantId === other ? 'nachbar' : 'chat', u.email));

  const s = await api.admin.put('/api/admin/chat/slack', { enabled: true, externalId: 'T_A', signingSecret: SLACK_SECRET, botToken: 'xoxb-fake-a' });
  expect(s.status).toBe(200);
  slackA = { commands: s.body.slack.commandsUrl.replace(/^https?:\/\/[^/]+/, ''), interactions: s.body.slack.interactionsUrl.replace(/^https?:\/\/[^/]+/, '') };
  const t = await api.admin.put('/api/admin/chat/teams', { enabled: true, externalId: BOT_APP_ID, signingSecret: TEAMS_TOKEN });
  teamsA = t.body.teams.messagesUrl.replace(/^https?:\/\/[^/]+/, '');
  const b = await api.adminB.put('/api/admin/chat/slack', { enabled: true, externalId: 'T_B', signingSecret: SLACK_SECRET_B, botToken: 'xoxb-fake-b' });
  slackB = { commands: b.body.slack.commandsUrl.replace(/^https?:\/\/[^/]+/, '') };
});

afterAll(async () => {
  setChatHttp(prevHttp);
  if (prevJwks) setJwksSource(prevJwks);
  await app.close();
  await closePool();
});

beforeEach(() => {
  sent = [];
});

const now = () => String(Math.floor(Date.now() / 1000));

function slackPost(url: string, form: Record<string, string>, opts: { secret?: string; ts?: string; signature?: string } = {}) {
  const body = new URLSearchParams(form).toString();
  const ts = opts.ts ?? now();
  return app.inject({
    method: 'POST',
    url,
    payload: body,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-slack-request-timestamp': ts,
      'x-slack-signature': opts.signature ?? slackSignature(opts.secret ?? SLACK_SECRET, ts, body),
    },
  });
}

const command = (user: string, text: string, team = 'T_A') => ({ team_id: team, user_id: user, command: '/idee', text, trigger_id: 'trig-1' });

async function submitted(by: string, extra: Record<string, unknown> = {}): Promise<{ id: string; number: number }> {
  const created = await api[by].post('/api/ideas', { ...validIdea, ...extra });
  expect(created.status).toBe(201);
  expect((await api[by].post(`/api/ideas/${created.body.id}/submit`, { confirmNotReport: true, boundaryAcknowledged: true })).status).toBe(200);
  return { id: created.body.id, number: created.body.number };
}

const ideaCount = (tenantId: string, title: string) =>
  withTenant(tenantId, async (db) => Number((await db.query('SELECT count(*) FROM ideas WHERE title = $1', [title])).rows[0].count));

describe('configuration (R3-16)', () => {
  it('stores secrets encrypted and never returns them; only admins', async () => {
    const view = await api.admin.get('/api/admin/chat');
    expect(view.body.slack).toMatchObject({ enabled: true, teamId: 'T_A', signingSecretSet: true, botTokenSet: true });
    expect(JSON.stringify(view.body)).not.toContain(SLACK_SECRET);
    expect(JSON.stringify(view.body)).not.toContain('xoxb');
    const stored = await withTenant(tenant, async (db) => (await db.query('SELECT signing_secret_enc, bot_token_enc FROM chat_workspaces WHERE provider = $1', ['slack'])).rows[0]);
    expect(stored.signing_secret_enc).toMatch(/^v2\./);
    expect(stored.bot_token_enc).not.toContain('xoxb');
    expect((await api.mia.get('/api/admin/chat')).status).toBe(403);
    // Keeping a secret: leaving it out does not delete it.
    await api.admin.put('/api/admin/chat/slack', { enabled: true, externalId: 'T_A' });
    expect((await api.admin.get('/api/admin/chat')).body.slack.signingSecretSet).toBe(true);
  });

  it('keeps the tenants apart (row-level security)', async () => {
    const b = await api.adminB.get('/api/admin/chat');
    expect(b.body.slack.teamId).toBe('T_B');
    expect(b.body.teams.secretSet).toBe(false);
    const rows = await withTenant(other, async (db) => (await db.query('SELECT tenant_id FROM chat_workspaces')).rows);
    expect(rows.every((r) => r.tenant_id === other)).toBe(true);
    await api.mia.put('/api/me/chat', { channel: 'slack', muted: [] });
    const subs = await withTenant(other, async (db) => (await db.query('SELECT user_id FROM chat_subscriptions')).rows);
    expect(subs.map((s) => s.user_id)).not.toContain(users.mia.id);
  });

  it('accepts personal webhooks only for Slack and Teams hosts', async () => {
    expect(validWebhookUrl('https://hooks.slack.com/services/T/B/x')).toBe(true);
    expect(validWebhookUrl('https://prod-12.westeurope.logic.azure.com/workflows/abc')).toBe(true);
    expect(validWebhookUrl('https://firma.webhook.office.com/webhookb2/abc')).toBe(true);
    expect(validWebhookUrl('http://hooks.slack.com/services/x')).toBe(false);
    expect(validWebhookUrl('https://169.254.169.254/latest')).toBe(false);
    expect(validWebhookUrl('https://evil.example/hooks.slack.com')).toBe(false);
    expect((await api.max.put('/api/me/chat', { channel: 'teams', muted: [], webhookUrl: 'https://intranet.local/x' })).status).toBe(400);
    // Teams without a personal webhook has no destination.
    expect((await api.max.put('/api/me/chat', { channel: 'teams', muted: [] })).status).toBe(400);
  });
});

describe('Slack signature (v0, 5 minutes)', () => {
  it('verifies valid, wrong and expired signatures', () => {
    const ts = now();
    const body = 'a=1';
    expect(verifySlack(SLACK_SECRET, ts, slackSignature(SLACK_SECRET, ts, body), body)).toBe('ok');
    expect(verifySlack(SLACK_SECRET, ts, slackSignature('other', ts, body), body)).toBe('invalid');
    expect(verifySlack(SLACK_SECRET, ts, slackSignature(SLACK_SECRET, ts, body), 'a=2')).toBe('invalid');
    const old = String(Number(ts) - 301);
    expect(verifySlack(SLACK_SECRET, old, slackSignature(SLACK_SECRET, old, body), body)).toBe('expired');
    expect(verifySlack(SLACK_SECRET, undefined, undefined, body)).toBe('invalid');
  });

  it('rejects unsigned, wrongly signed, expired and foreign requests at the endpoint', async () => {
    const title = 'Signierte Idee aus Slack';
    expect((await slackPost(slackA.commands, command('U_MIA', `${title} | P | L`), { secret: 'wrong' })).statusCode).toBe(401);
    const old = String(Math.floor(Date.now() / 1000) - 600);
    expect((await slackPost(slackA.commands, command('U_MIA', `${title} | P | L`), { ts: old })).statusCode).toBe(401);
    // Tenant B's secret does not open tenant A's endpoint, nor does another Slack workspace.
    expect((await slackPost(slackA.commands, command('U_MIA', `${title} | P | L`), { secret: SLACK_SECRET_B })).statusCode).toBe(401);
    expect((await slackPost(slackA.commands, command('U_MIA', `${title} | P | L`, 'T_OTHER'))).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: slackA.commands, payload: 'text=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/integrations/slack/00000000-0000-0000-0000-000000000000/commands', payload: 'text=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).statusCode).toBe(404);
    expect(await ideaCount(tenant, title)).toBe(0);
  });
});

describe('Slack commands (same service functions as the API)', () => {
  it('creates a draft for the person with the same e-mail in this tenant only', async () => {
    const title = 'Kurzform aus Slack';
    const res = await slackPost(slackA.commands, command('U_SAME', `${title} | Zu viele Medienbrüche im Ablauf | Ein Formular für alles`));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.response_type).toBe('ephemeral');
    expect(body.text).toMatch(/Idee #\d+ ist als Entwurf angelegt/);
    expect(body.text).not.toContain(title);
    const idea = await withTenant(tenant, async (db) => (await db.query('SELECT author_id, status, problem FROM ideas WHERE title = $1', [title])).rows[0]);
    expect(idea).toMatchObject({ author_id: users.same.id, status: 'draft', problem: 'Zu viele Medienbrüche im Ablauf' });
    expect(await ideaCount(other, title)).toBe(0);
    // The same address in tenant B posts through B's workspace into B.
    const resB = await slackPost(slackB.commands, command('U_SAME', `${title} B | P | L`, 'T_B'), { secret: SLACK_SECRET_B });
    expect(resB.statusCode).toBe(200);
    const ideaB = await withTenant(other, async (db) => (await db.query('SELECT author_id FROM ideas WHERE title = $1', [`${title} B`])).rows[0]);
    expect(ideaB.author_id).toBe(users.sameB.id);
  });

  it('does not map a person of another tenant', async () => {
    const title = 'Fremde Person aus Slack';
    const res = await slackPost(slackA.commands, command('U_FOREIGN', `${title} | P | L`));
    expect(res.json().text).toMatch(/keine aktive Person/);
    expect(await ideaCount(tenant, title)).toBe(0);
    expect(await ideaCount(other, title)).toBe(0);
  });

  it('opens the short form as a modal and accepts it', async () => {
    const res = await slackPost(slackA.commands, command('U_MIA', ''));
    expect(res.statusCode).toBe(200);
    const open = sent.find((r) => r.url.endsWith('/views.open'));
    expect((open?.body as { view: { callback_id: string } }).view.callback_id).toBe('ip_submit');
    const title = 'Modal-Idee aus Slack';
    const payload = {
      type: 'view_submission', team: { id: 'T_A' }, user: { id: 'U_MIA' },
      view: { callback_id: 'ip_submit', state: { values: { title: { v: { value: title } }, problem: { v: { value: 'Problem' } }, solution: { v: { value: 'Lösung' } } } } },
    };
    const sub = await slackPost(slackA.interactions, { payload: JSON.stringify(payload) });
    expect(sub.statusCode).toBe(200);
    expect(sub.json().response_action).toBe('update');
    expect(await ideaCount(tenant, title)).toBe(1);
  });

  it('answers a question (Rückfrage) only as author', async () => {
    const idea = await submitted('mia', { title: 'Idee mit Rückfrage über Slack' });
    expect((await api.triage.post(`/api/ideas/${idea.id}/question`, { question: 'Für welche Standorte gilt das?' })).status).toBe(200);
    const wrong = await slackPost(slackA.commands, command('U_MAX', `antwort #${idea.number} Ich bin nicht der Autor`));
    expect(wrong.json().text).toMatch(/Das hat nicht geklappt/);
    const ok = await slackPost(slackA.commands, command('U_MIA', `antwort #${idea.number} Für alle drei Standorte.`));
    expect(ok.json().text).toContain(`Idee #${idea.number}`);
    const detail = await api.mia.get(`/api/ideas/${idea.id}`);
    expect(detail.body.idea?.status ?? detail.body.status).toBe('submitted');
  });

  it('answers through the button and modal', async () => {
    const idea = await submitted('mia', { title: 'Zweite Rückfrage über Slack' });
    await api.triage.post(`/api/ideas/${idea.id}/question`, { question: 'Wie viele Personen betrifft das?' });
    await slackPost(slackA.interactions, { payload: JSON.stringify({ type: 'block_actions', trigger_id: 't', team: { id: 'T_A' }, user: { id: 'U_MIA' }, actions: [{ action_id: 'ip_answer', value: idea.id }] }) });
    const open = sent.find((r) => r.url.endsWith('/views.open'));
    expect((open?.body as { view: { private_metadata: string } }).view.private_metadata).toBe(idea.id);
    const res = await slackPost(slackA.interactions, {
      payload: JSON.stringify({ type: 'view_submission', team: { id: 'T_A' }, user: { id: 'U_MIA' }, view: { callback_id: 'ip_answer', private_metadata: idea.id, state: { values: { answer: { v: { value: 'Rund 40 Personen.' } } } } } }),
    });
    expect(res.json().response_action).toBe('update');
    const status = await withTenant(tenant, async (db) => (await db.query('SELECT status FROM ideas WHERE id = $1', [idea.id])).rows[0].status);
    expect(status).toBe('submitted');
  });

  it('parses the commands', () => {
    expect(parseCommand('')).toEqual({ kind: 'help' });
    expect(parseCommand('antwort #12 Ja, gerne')).toEqual({ kind: 'answer', number: 12, answer: 'Ja, gerne' });
    expect(parseCommand('einreichen A | B | C | D')).toEqual({ kind: 'submit', title: 'A', problem: 'B', solution: 'C | D' });
    expect(parseCommand('verbinden ABCD2345')).toEqual({ kind: 'link', code: 'ABCD2345' });
  });
});

describe('delivery from the outbox (same categories as e-mail)', () => {
  const run = () => asUser(null, tenant, (ctx) => dispatchChat(ctx));

  it('sends a direct message with link and answer button, mapped by e-mail', async () => {
    await run(); // clear older rows
    expect((await api.mia.put('/api/me/chat', { channel: 'slack', muted: [] })).status).toBe(200);
    const idea = await submitted('mia', { title: 'Sichtbarer Titel im Chat' });
    await api.triage.post(`/api/ideas/${idea.id}/question`, { question: 'Wer ist betroffen?' });
    sent = [];
    expect(await run()).toBeGreaterThan(0);
    const post = sent.find((r) => r.url.endsWith('/chat.postMessage'));
    const text = JSON.stringify(post?.body);
    expect((post?.body as { channel: string }).channel).toBe('U_MIA');
    expect(text).toContain('Sichtbarer Titel im Chat');
    expect(text).toContain(`/ideen/${idea.id}`);
    expect(text).toContain('ip_answer');
    // Mapped once by e-mail (users.lookupByEmail) and cached.
    const cached = await withTenant(tenant, async (db) => (await db.query('SELECT slack_user_id FROM chat_subscriptions WHERE user_id = $1', [users.mia.id])).rows[0]);
    expect(cached.slack_user_id).toBe('U_MIA');
    // Each row only once.
    sent = [];
    expect(await run()).toBe(0);
  });

  it('never shows the title of a confidential idea', async () => {
    await run();
    const idea = await submitted('mia', { title: 'Geheimes Projekt Falke', confidential: true });
    await api.triage.post(`/api/ideas/${idea.id}/question`, { question: 'Wie teuer wird das Projekt?' });
    sent = [];
    await run();
    const text = JSON.stringify(sent.filter((r) => r.url.endsWith('/chat.postMessage')).map((r) => r.body));
    expect(text).toContain(`Idee #${idea.number}`);
    expect(text).not.toContain('Falke');
    expect(text).not.toContain('teuer');
  });

  it('hides texts that look like a report', async () => {
    await run();
    await withTenant(tenant, async (db) => db.query(
      `INSERT INTO outbox (tenant_id, user_id, to_email, subject, body, category) VALUES ($1, $2, $3, $4, $5, 'my_ideas')`,
      [tenant, users.mia.id, users.mia.email, 'Neuer Kommentar', 'Mein Chef begeht Betrug und Korruption bei der Abrechnung.'],
    ));
    sent = [];
    await run();
    const text = JSON.stringify(sent.map((r) => r.body));
    expect(text).not.toContain('Korruption');
    expect(text).toContain('Neuigkeit im Ideenportal');
  });

  it('honours muted categories', async () => {
    await run();
    await api.mia.put('/api/me/chat', { channel: 'slack', muted: ['my_ideas'] });
    const idea = await submitted('mia', { title: 'Stumm geschaltete Idee' });
    await api.triage.post(`/api/ideas/${idea.id}/question`, { question: 'Gilt das auch nachts?' });
    sent = [];
    expect(await run()).toBe(0);
    expect(sent.filter((r) => r.url.endsWith('/chat.postMessage'))).toHaveLength(0);
    await api.mia.put('/api/me/chat', { channel: 'slack', muted: [] });
  });

  it('posts an Adaptive Card to a personal Teams webhook', async () => {
    await run();
    const hook = 'https://prod-01.westeurope.logic.azure.com/workflows/abc/triggers/manual/paths/invoke';
    expect((await api.max.put('/api/me/chat', { channel: 'teams', muted: [], webhookUrl: hook })).status).toBe(200);
    const view = await api.max.get('/api/me/chat');
    expect(view.body).toMatchObject({ channel: 'teams', webhookSet: true });
    expect(JSON.stringify(view.body)).not.toContain('logic.azure.com');
    const idea = await submitted('max', { title: 'Teams-Karte mit Link' });
    await api.triage.post(`/api/ideas/${idea.id}/question`, { question: 'Welche Abteilung zuerst?' });
    sent = [];
    await run();
    const card = sent.find((r) => r.url === hook)?.body as { attachments: { contentType: string; content: { actions: { url: string }[]; body: { text: string }[] } }[] };
    expect(card.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(card.attachments[0].content.actions[0].url).toContain(`/ideen/${idea.id}`);
    expect(JSON.stringify(card)).toContain('Rückfrage');
  });
});

describe('Teams outgoing webhook (HMAC)', () => {
  const teamsPost = (activity: unknown, token = TEAMS_TOKEN) => {
    const body = JSON.stringify(activity);
    const sig = createHmac('sha256', Buffer.from(token, 'base64')).update(body).digest('base64');
    return app.inject({ method: 'POST', url: teamsA, payload: body, headers: { 'content-type': 'application/json', authorization: `HMAC ${sig}` } });
  };

  it('verifies the HMAC', async () => {
    expect(verifyTeamsHmac(TEAMS_TOKEN, `HMAC ${createHmac('sha256', Buffer.from(TEAMS_TOKEN, 'base64')).update('x').digest('base64')}`, 'x')).toBe('ok');
    expect(verifyTeamsHmac(TEAMS_TOKEN, 'HMAC abc', 'x')).toBe('invalid');
    expect((await teamsPost({ type: 'message', text: 'hilfe' }, Buffer.from('falsch').toString('base64'))).statusCode).toBe(401);
  });

  it('links the account with a code from the portal and submits the short form', async () => {
    const notLinked = await teamsPost({ type: 'message', text: '<at>Ideenportal</at> einreichen A | B | C', from: { aadObjectId: 'aad-mia' } });
    expect(notLinked.json().text).toMatch(/noch nicht verbunden/);
    // A code from tenant B does not link in tenant A.
    const codeB = await api.foreign.post('/api/me/chat/link-code');
    expect((await teamsPost({ type: 'message', text: `verbinden ${codeB.body.code}`, from: { aadObjectId: 'aad-foreign' } })).json().text).toMatch(/ungültig/);
    const code = await api.mia.post('/api/me/chat/link-code');
    expect(code.status).toBe(200);
    expect((await teamsPost({ type: 'message', text: `<at>Ideenportal</at> verbinden ${code.body.code}`, from: { aadObjectId: 'aad-mia' } })).json().text).toMatch(/verbunden/);
    // A code works only once.
    expect((await teamsPost({ type: 'message', text: `verbinden ${code.body.code}`, from: { aadObjectId: 'aad-x' } })).json().text).toMatch(/ungültig/);
    const title = 'Idee aus Teams';
    const res = await teamsPost({ type: 'message', text: `<at>Ideenportal</at> einreichen ${title} | Problem | Lösung`, from: { aadObjectId: 'aad-mia' } });
    expect(res.json().type).toBe('message');
    expect(res.json().text).not.toContain(title);
    const idea = await withTenant(tenant, async (db) => (await db.query('SELECT author_id FROM ideas WHERE title = $1', [title])).rows[0]);
    expect(idea.author_id).toBe(users.mia.id);
  });
});

describe('Teams bot / message extension (Bot Framework JWT)', () => {
  let key: KeyObject;
  let otherKey: KeyObject;

  beforeAll(() => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    key = pair.privateKey;
    otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'k1', endorsements: ['msteams'] };
    prevJwks = setJwksSource(async () => [jwk]);
  });

  const jwt = (claims: Record<string, unknown>, signer = key, kid = 'k1') => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = `${enc({ alg: 'RS256', typ: 'JWT', kid })}.${enc(claims)}`;
    return `${head}.${sign('RSA-SHA256', Buffer.from(head), signer).toString('base64url')}`;
  };
  const valid = () => ({ iss: 'https://api.botframework.com', aud: BOT_APP_ID, exp: Math.floor(Date.now() / 1000) + 600, nbf: Math.floor(Date.now() / 1000) - 10 });
  const submitAction = (title: string) => ({
    type: 'invoke', name: 'composeExtension/submitAction', from: { aadObjectId: 'aad-mia' },
    value: { commandId: 'submitIdea', data: { title, problem: 'Problem aus Teams', solution: 'Lösung aus Teams' } },
  });
  const botPost = (token: string, activity: unknown) =>
    app.inject({ method: 'POST', url: teamsA, payload: JSON.stringify(activity), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });

  it('accepts a valid token and answers in the task dialog', async () => {
    const res = await botPost(jwt(valid()), submitAction('Idee aus der Teams-Erweiterung'));
    expect(res.statusCode).toBe(200);
    expect(res.json().task.type).toBe('message');
    expect(await ideaCount(tenant, 'Idee aus der Teams-Erweiterung')).toBe(1);
  });

  it('rejects wrong signature, audience, issuer and expired tokens', async () => {
    const title = 'Abgelehnter Bot-Aufruf';
    expect((await botPost(jwt(valid(), otherKey), submitAction(title))).statusCode).toBe(401);
    expect((await botPost(jwt({ ...valid(), aud: 'other-app' }), submitAction(title))).statusCode).toBe(401);
    expect((await botPost(jwt({ ...valid(), iss: 'https://evil.example' }), submitAction(title))).statusCode).toBe(401);
    expect((await botPost(jwt({ ...valid(), exp: Math.floor(Date.now() / 1000) - 3600 }), submitAction(title))).statusCode).toBe(401);
    expect((await botPost(jwt(valid(), key, 'unknown'), submitAction(title))).statusCode).toBe(401);
    expect((await botPost('nonsense', submitAction(title))).statusCode).toBe(401);
    expect(await ideaCount(tenant, title)).toBe(0);
  });
});
