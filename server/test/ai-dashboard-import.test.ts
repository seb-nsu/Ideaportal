import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanRow, suggestTopic } from '../src/ai/importCleanup.js';
import { setProviderFactory, type GenerateRequest, type ModelProvider } from '../src/ai/providers.js';
import { checkQualityAlarm, periodLabel, periodStarts, qualityDashboard } from '../src/ai/qualityDashboard.js';
import { defaultAiSettings, type AiSettings } from '../src/ai/settings.js';
import { closePool, withSystem, withTenant } from '../src/db/pool.js';
import type { SessionUser } from '../src/lib/context.js';
import { asUser, client, createTenant, createUser, login, resetDb, testApp, validIdea } from './helpers.js';

// AP-26: AI quality dashboard with alarm (R4-08) and import of old ideas with AI support (R4-12).

let app: FastifyInstance;
let tenant: string;
let other: string;
let users: Record<string, SessionUser>;
let api: Record<string, ReturnType<typeof client>>;
let today: string;

beforeAll(async () => {
  await resetDb();
  app = await testApp();
  tenant = await createTenant('kiqd', { holidays: [] });
  other = await createTenant('kiqd-nachbar', { holidays: [] });
  users = {
    author: await createUser(tenant, 'author@kiqd.example', ['submitter']),
    triage: await createUser(tenant, 'triage@kiqd.example', ['submitter', 'triage']),
    admin: await createUser(tenant, 'admin@kiqd.example', ['submitter', 'admin']),
    otherAdmin: await createUser(other, 'admin@nachbar.example', ['submitter', 'admin', 'triage']),
  };
  api = {};
  for (const [k, u] of Object.entries(users)) api[k] = client(app, await login(app, k === 'otherAdmin' ? 'kiqd-nachbar' : 'kiqd', u.email));
  today = (await api.admin.get('/api/settings')).body.today;
});

afterEach(() => setProviderFactory(null));

afterAll(async () => {
  await app.close();
  await closePool();
});

async function setAi(who: ReturnType<typeof client>, patch: Partial<AiSettings>): Promise<void> {
  const current = (await who.get('/api/admin/ai')).body.settings as AiSettings;
  const res = await who.put('/api/admin/ai', { ...current, ...patch });
  expect(res.status).toBe(200);
}

const mid = (period: string) => `${period.slice(0, 8)}15T10:00:00Z`;

// ---------------------------------------------------------------- R4-08

describe('AI quality dashboard (R4-08)', () => {
  const months = () => periodStarts(today, 'month');

  beforeAll(async () => {
    const p = months();
    const evaluated = p[10];
    await withSystem(async (c) => {
      const action = (tenantId: string, status: string, cost: number, at: string) =>
        c.query(
          `INSERT INTO ai_actions (tenant_id, agent, provider, model, local, status, input, cost_eur, created_at)
           VALUES ($1, 'short_analysis', 'anthropic', 'claude-haiku-5-5', false, $2, '{}'::jsonb, $3, $4)`,
          [tenantId, status, cost, at],
        );
      // Baseline: three months with 10 good calls at 1 cent each.
      for (const period of p.slice(7, 10)) for (let i = 0; i < 10; i++) await action(tenant, 'ok', 0.01, mid(period));
      // Evaluated month: half of the calls fail, three times the cost per call.
      for (let i = 0; i < 10; i++) await action(tenant, i < 5 ? 'error' : 'ok', 0.03, mid(evaluated));
      // The neighbour has steady quality in the same months.
      for (const period of p.slice(7, 11)) for (let i = 0; i < 10; i++) await action(other, 'ok', 0.01, mid(period));

      // A result with a corrected statement and a failed source check, and three ratings (below 5).
      const result = (
        await c.query<{ id: string }>(
          `INSERT INTO ai_results (tenant_id, kind, content, created_at) VALUES ($1, 'short_analysis', $2, $3) RETURNING id`,
          [tenant, JSON.stringify({
            sections: [{ heading: 'A', claims: [
              { id: 'c1', text: 'Markt von 10 Mio. €', kind: 'fact', sources: [1], confidence: null, check: 'not_found' },
              { id: 'c2', text: 'Annahme', kind: 'assumption', sources: [], confidence: null },
            ] }],
            sources: [{ id: 1, title: 'x', url: 'https://example.org', snippet: 's', origin: 'web', retrievedAt: evaluated, check: { reachable: false, status: 404, quoteFound: false, checkedAt: evaluated } }],
          }), mid(evaluated)],
        )
      ).rows[0].id;
      await c.query(
        `INSERT INTO ai_corrections (tenant_id, result_id, claim_id, action, original_text, corrected_text, reason, created_at)
         VALUES ($1, $2, 'c1', 'correct', 'Markt von 10 Mio. €', 'Markt von 8 Mio. €', 'Quelle nennt 8', $3)`,
        [tenant, result, mid(evaluated)],
      );
      for (const u of [users.author, users.triage, users.admin]) {
        await c.query(`INSERT INTO ai_ratings (tenant_id, result_id, kind, user_id, helpful, created_at) VALUES ($1, $2, 'short_analysis', $3, true, $4)`, [tenant, result, u.id, mid(evaluated)]);
      }
    });
  });

  it('is only for admins', async () => {
    expect((await api.author.get('/api/admin/ai/quality/dashboard')).status).toBe(403);
    expect((await api.triage.get('/api/admin/ai/quality/dashboard')).status).toBe(403);
    expect((await api.author.put('/api/admin/ai/quality/alarm', defaultAiSettings.qualityAlarm)).status).toBe(403);
    expect((await api.admin.get('/api/admin/ai/quality/dashboard')).status).toBe(200);
  });

  it('shows metrics per agent and month with the history of twelve periods', async () => {
    const res = await api.admin.get('/api/admin/ai/quality/dashboard?granularity=month');
    expect(res.status).toBe(200);
    expect(res.body.periods).toEqual(months());
    expect(res.body.evaluated).toBe(months()[10]);
    const agent = res.body.agents.find((a: { agent: string }) => a.agent === 'short_analysis');
    expect(agent.label).toBe('Kurzanalyse');
    expect(agent.series).toHaveLength(12);
    expect(agent.latest).toMatchObject({ calls: 10, errors: 5, errorRate: 0.5, costPerCall: 0.03, claims: 2, corrected: 1, correctionRate: 0.5, sourceChecks: 2, sourceErrors: 2, sourceErrorRate: 1 });
    // Three ratings are below the minimum group size: no count, no rate.
    expect(agent.latest).toMatchObject({ ratings: 3, helpful: null, helpfulRate: null });
    expect(agent.baseline).toMatchObject({ calls: 30, errors: 0, errorRate: 0, costPerCall: 0.01 });
    expect(agent.series[9]).toMatchObject({ calls: 10, costEur: 0.1 });
    const metrics = agent.findings.map((f: { metric: string }) => f.metric).sort();
    expect(metrics).toEqual(['costPerCall', 'errorRate']);
  });

  it('groups by week as well', async () => {
    const res = await api.admin.get('/api/admin/ai/quality/dashboard?granularity=week');
    expect(res.status).toBe(200);
    expect(res.body.periods).toHaveLength(12);
    for (const p of res.body.periods) expect(new Date(`${p}T12:00:00Z`).getUTCDay()).toBe(1);
    expect(periodLabel('2026-10-12', 'week')).toBe('2026-W42');
    expect(periodLabel('2026-01-01', 'week')).toBe('2026-W01');
    expect(periodLabel('2026-09-01', 'month')).toBe('2026-09');
  });

  it('keeps workspaces apart', async () => {
    const res = await api.otherAdmin.get('/api/admin/ai/quality/dashboard?granularity=month');
    const agent = res.body.agents.find((a: { agent: string }) => a.agent === 'short_analysis');
    expect(agent.latest).toMatchObject({ calls: 10, errors: 0, costPerCall: 0.01, claims: 0, ratings: 0 });
    expect(res.body.findings).toEqual([]);
  });

  it('raises the alarm once per period and tells only the admins of the workspace', async () => {
    const run = (tenantId: string) => asUser(null, tenantId, (ctx) => checkQualityAlarm(ctx), today);
    expect(await run(tenant)).toBe(1);
    expect(await run(tenant)).toBe(0);
    expect(await run(other)).toBe(0);
    const mails = await withSystem((c) =>
      c.query<{ user_id: string; subject: string; body: string }>(`SELECT user_id, subject, body FROM outbox WHERE subject LIKE 'KI-Qualität%'`),
    );
    expect(mails.rows).toHaveLength(1);
    expect(mails.rows[0].user_id).toBe(users.admin.id);
    expect(mails.rows[0].subject).toContain(periodLabel(months()[10], 'month'));
    expect(mails.rows[0].body).toContain('Kurzanalyse: Fehlerquote der Aufrufe von 0 % auf 50 % gestiegen');
    expect(mails.rows[0].body).toContain('Kosten je Aufruf von 0.0100 € auf 0.0300 € gestiegen');
    // Row-level security: the alarm belongs to its workspace.
    expect((await withTenant(other, (db) => db.query('SELECT 1 FROM ai_quality_alarms'))).rowCount).toBe(0);
    expect((await withTenant(tenant, (db) => db.query('SELECT 1 FROM ai_quality_alarms'))).rowCount).toBe(1);
    const res = await api.admin.get('/api/admin/ai/quality/dashboard');
    expect(res.body.alarms).toHaveLength(1);
    expect(res.body.alarms[0]).toMatchObject({ granularity: 'month', period: months()[10] });
  });

  it('has a configurable threshold', async () => {
    expect((await api.admin.put('/api/admin/ai/quality/alarm', { ...defaultAiSettings.qualityAlarm, dropPoints: 0 })).status).toBe(400);
    const res = await api.admin.put('/api/admin/ai/quality/alarm', { enabled: true, period: 'month', dropPoints: 60, costRisePercent: 500, minCases: 5 });
    expect(res.status).toBe(200);
    const d = await asUser(users.admin, tenant, (ctx) => qualityDashboard(ctx, 'month'), today);
    expect(d.alarm.dropPoints).toBe(60);
    expect(d.findings).toEqual([]);
    // The neighbour keeps its own setting.
    const n = await asUser(users.otherAdmin, other, (ctx) => qualityDashboard(ctx, 'month'), today);
    expect(n.alarm.dropPoints).toBe(10);
    // Switched off: no alarm at all.
    await api.admin.put('/api/admin/ai/quality/alarm', { enabled: false, period: 'week', dropPoints: 1, costRisePercent: 1, minCases: 1 });
    expect(await asUser(null, tenant, (ctx) => checkQualityAlarm(ctx), today)).toBe(0);
    const audit = await withTenant(tenant, (db) => db.query("SELECT 1 FROM audit_log WHERE action = 'settings.ai.qualityAlarm'"));
    expect(audit.rowCount).toBe(2);
  });
});

// ---------------------------------------------------------------- R4-12

describe('import of old ideas with AI support (R4-12)', () => {
  const csv = [
    'Titel;Problem;Lösung;Nutzen;Themenfeld;E-Mail;Vertraulich',
    'DIGITALE URLAUBSANTRÄGE;"Hallo zusammen,\nAnträge auf Papier gehen verloren und brauchen Ã¤rgerlich lange.\n\nViele Grüße\nPeter Muster";Formular im Intranet;Schnellere Freigabe;Prozesse und Effizienz;author@kiqd.example;',
    'Solaranlage auf dem Parkhaus;Hohe Stromkosten;Photovoltaik auf das Dach;Weniger CO2;nachhaltigkeit;unbekannt@kiqd.example;',
    'Rückrufservice für Kunden;Kunden warten lange in der Hotline;Rückruf anbieten;Zufriedenere Kunden;;author@kiqd.example;',
    'Weniger Wartezeit an der Kantine;Doppelt;;;;;',
    'Solaranlage auf dem Parkhaus;Noch einmal in der Datei;;;;;',
    'Geheimes Projekt Falke;Vertrauliche Details zum Projekt Falke;Neues Produkt;Umsatz;;author@kiqd.example;ja',
    'x;;;;;;',
  ].join('\n');
  const data = Buffer.from(csv, 'utf8').toString('base64');

  beforeAll(async () => {
    // An idea in the portal of each workspace; the neighbour's must not count as a duplicate.
    const created = await api.author.post('/api/ideas', validIdea);
    expect((await api.author.post(`/api/ideas/${created.body.id}/submit`, { confirmNotReport: true, boundaryAcknowledged: true })).status).toBe(200);
    const theirs = await api.otherAdmin.post('/api/ideas', { ...validIdea, title: 'Rückrufservice für Kunden' });
    expect((await api.otherAdmin.post(`/api/ideas/${theirs.body.id}/submit`, { confirmNotReport: true, boundaryAcknowledged: true })).status).toBe(200);
    // The settings of the dashboard tests above leave the alarm off; the import does not depend on it.
    await setAi(api.admin, { enabled: true });
  });

  it('cleans rows with fixed rules (builtin)', () => {
    const topics = ['Prozesse und Effizienz', 'Kundenerlebnis', 'Nachhaltigkeit'];
    const r = cleanRow({ row: 2, title: '  PAPIERLOSE   REISEKOSTEN ', problem: 'Sehr geehrte Damen und Herren,\n<p>Belege&nbsp;gehen verloren</p>\nMit freundlichen Grüßen\nAnna', solution: '', benefit: '', topic: 'prozesse  und effizienz' }, topics);
    expect(r.title).toBe('Papierlose reisekosten');
    expect(r.problem).toBe('Belege gehen verloren');
    expect(r.topic).toBe('Prozesse und Effizienz');
    expect(r.changes).toEqual(expect.arrayContaining(['html', 'greeting', 'whitespace', 'caps', 'topic_mapped']));
    const long = cleanRow({ row: 3, title: '', problem: '', solution: 'Ein Rückrufservice für alle Kunden der Hotline. Mehr Text.', benefit: '', topic: '' }, topics);
    expect(long.title).toBe('Ein Rückrufservice für alle Kunden der Hotline');
    expect(long.topic).toBe('Kundenerlebnis');
    expect(long.changes).toEqual(['title_from_text', 'topic_suggested']);
    expect(suggestTopic('Nichts Passendes hier', topics)).toBeNull();
  });

  it('shows a preview with AI suggestions and the duplicate check, and creates nothing', async () => {
    expect((await api.author.post('/api/admin/import/ai/preview', { filename: 'alt.csv', data })).status).toBe(403);
    const res = await api.admin.post('/api/admin/import/ai/preview', { filename: 'alt.csv', data });
    expect(res.status).toBe(200);
    expect(res.body.mapping).toMatchObject({ title: 0, problem: 1, solution: 2, benefit: 3, topic: 4, email: 5, confidential: 6 });
    const rows = res.body.rows as { row: number; suggestion: { title: string; problem: string; topic: string | null; changes: string[]; fields: string[] } | null; duplicate: unknown; similar: { title: string }[]; include: boolean; skipReason: string | null; confidential: boolean; authorKnown: boolean }[];
    const byRow = (n: number) => rows.find((r) => r.row === n)!;
    expect(byRow(2).suggestion).toMatchObject({ title: 'Digitale urlaubsanträge', topic: 'Prozesse und Effizienz' });
    expect(byRow(2).suggestion!.problem).toBe('Anträge auf Papier gehen verloren und brauchen ärgerlich lange.');
    expect(byRow(2).suggestion!.changes).toEqual(expect.arrayContaining(['encoding', 'greeting', 'caps']));
    expect(byRow(2).suggestion!.fields).toEqual(['title', 'problem']);
    expect(byRow(3).suggestion).toMatchObject({ topic: 'Nachhaltigkeit', fields: ['topic'] });
    expect(byRow(3).authorKnown).toBe(false);
    expect(byRow(4).suggestion).toMatchObject({ topic: 'Kundenerlebnis' });
    expect(byRow(4).suggestion!.changes).toContain('topic_suggested');
    // Same title as the neighbour's idea: no duplicate here.
    expect(byRow(4).duplicate).toBeNull();
    expect(byRow(4).include).toBe(true);
    // Duplicates: in the portal, and earlier in the file.
    expect(byRow(5)).toMatchObject({ duplicate: { kind: 'portal' }, include: false, skipReason: 'duplicate' });
    expect(byRow(5).similar.map((s) => s.title)).toContain(validIdea.title);
    expect(byRow(6)).toMatchObject({ duplicate: { kind: 'file', row: 3 }, include: false });
    expect(byRow(7).confidential).toBe(true);
    expect(byRow(8)).toMatchObject({ include: false, skipReason: 'title' });
    expect(res.body.report).toMatchObject({ total: 7, included: 4, duplicates: 2, confidential: 1 });
    expect(res.body.ai.used).toBe(true);
    const log = await withTenant(tenant, (db) => db.query<{ provider: string; input: { confidential: boolean } }>("SELECT provider, input FROM ai_actions WHERE agent = 'import_cleanup'"));
    expect(log.rowCount).toBe(2);
    expect(log.rows.every((r) => r.provider === 'builtin')).toBe(true);
    const n = await withTenant(tenant, (db) => db.query("SELECT 1 FROM ideas WHERE imported"));
    expect(n.rowCount).toBe(0);
  });

  it('sends confidential rows only to a local model and checks the AI answer', async () => {
    const calls: GenerateRequest[] = [];
    setProviderFactory((p) => {
      if (p.kind === 'builtin') throw new Error('builtin');
      const provider: ModelProvider = {
        async generate(req) {
          calls.push(req);
          return {
            json: { rows: [{ row: 2, title: 'Digitale Urlaubsanträge', problem: 'Anträge gehen verloren.', solution: 'Formular im Intranet', benefit: 'Schnellere Freigabe', topic: 'Erfundenes Themenfeld', changes: ['caps'] }] },
            inputTokens: 100, outputTokens: 50, servedBy: req.model, refused: false,
          };
        },
      };
      return provider;
    });
    await setAi(api.admin, {
      providers: [
        { id: 'builtin', name: 'Eingebaut', kind: 'builtin', baseUrl: '', hosting: 'local', keySource: 'none' },
        { id: 'anthropic', name: 'Anthropic Claude', kind: 'anthropic', baseUrl: '', hosting: 'other', keySource: 'tenant' },
      ],
      models: { ...defaultAiSettings.models, fast: { provider: 'anthropic', model: 'claude-haiku-5-5' } },
    });
    const res = await api.admin.post('/api/admin/import/ai/preview', { filename: 'alt.csv', data });
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0].prompt).not.toContain('Falke');
    expect(calls[0].prompt).toContain('<untrusted');
    const rows = res.body.rows as { row: number; suggestion: { title: string; topic: string | null } | null }[];
    // The model's topic is not in the list: it is dropped.
    expect(rows.find((r) => r.row === 2)!.suggestion).toMatchObject({ title: 'Digitale Urlaubsanträge', topic: null });
    // Rows the model left out keep no suggestion; the confidential row is cleaned by the builtin rules.
    expect(rows.find((r) => r.row === 3)!.suggestion).toBeNull();
    expect(rows.find((r) => r.row === 7)!.suggestion).not.toBeNull();
    const log = await withTenant(tenant, (db) =>
      db.query<{ provider: string; local: boolean; input: { confidential: boolean } }>("SELECT provider, local, input FROM ai_actions WHERE agent = 'import_cleanup' ORDER BY created_at DESC LIMIT 2"),
    );
    const conf = log.rows.find((r) => r.input.confidential)!;
    expect(conf).toMatchObject({ provider: 'builtin', local: true });
    await setAi(api.admin, { providers: defaultAiSettings.providers, models: defaultAiSettings.models });
  });

  it('works without AI and says why', async () => {
    await setAi(api.admin, { enabled: false });
    const res = await api.admin.post('/api/admin/import/ai/preview', { filename: 'alt.csv', data });
    expect(res.status).toBe(200);
    expect(res.body.ai.used).toBe(false);
    expect(res.body.ai.errors.length).toBeGreaterThan(0);
    expect(res.body.rows.every((r: { suggestion: unknown }) => r.suggestion === null)).toBe(true);
    await setAi(api.admin, { enabled: true });
  });

  it('imports only the confirmed rows and marks the AI suggestions', async () => {
    const preview = await api.admin.post('/api/admin/import/ai/preview', { filename: 'alt.csv', data });
    const theirs = await api.otherAdmin.post('/api/admin/import/ai/preview', { filename: 'alt.csv', data });
    const theirAction = theirs.body.ai.actionIds[0] as string;
    const rows = [
      { row: 2, title: 'Digitale urlaubsanträge', problem: 'Anträge auf Papier gehen verloren.', solution: 'Formular im Intranet', benefit: 'Schnellere Freigabe', topic: 'Prozesse und Effizienz', email: 'author@kiqd.example', confidential: false, aiFields: ['title', 'problem'] },
      { row: 4, title: 'Rückrufservice für Kunden', problem: 'Kunden warten lange', solution: 'Rückruf', benefit: '', topic: 'Kundenerlebnis', email: 'author@kiqd.example', confidential: false, aiFields: ['topic'] },
      { row: 5, title: 'Weniger Wartezeit an der Kantine', problem: 'Doppelt', topic: null, email: '', confidential: false },
      { row: 7, title: 'Geheimes Projekt Falke', problem: 'Vertraulich', topic: 'Erfundenes Themenfeld', email: 'author@kiqd.example', confidential: true, aiFields: ['topic'] },
    ];
    expect((await api.author.post('/api/admin/import/ai/commit', { filename: 'alt.csv', rows })).status).toBe(403);
    const res = await api.admin.post('/api/admin/import/ai/commit', { filename: 'alt.csv', rows, actionIds: [...preview.body.ai.actionIds, theirAction] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ imported: 3, duplicates: [5], aiMarked: 2 });
    const ideas = await withTenant(tenant, (db) =>
      db.query<{ title: string; status: string; topic: string | null; confidential: boolean; message: string; author: string }>(
        `SELECT i.title, i.status, i.topic, i.confidential, e.message, u.email AS author FROM ideas i
           JOIN idea_events e ON e.idea_id = i.id AND e.kind = 'imported' JOIN users u ON u.id = i.author_id
          WHERE i.imported ORDER BY i.number`,
      ),
    );
    expect(ideas.rows).toHaveLength(3);
    expect(ideas.rows[0]).toMatchObject({ title: 'Digitale urlaubsanträge', status: 'submitted', topic: 'Prozesse und Effizienz', confidential: false, author: 'author@kiqd.example' });
    expect(ideas.rows[0].message).toBe('Importiert aus alt.csv, Zeile 2. KI-Vorschlag übernommen: Titel, Problem.');
    expect(ideas.rows[1].message).toContain('KI-Vorschlag übernommen: Themenfeld.');
    // A topic outside the list is dropped, so the AI mark for the topic is dropped too.
    expect(ideas.rows[2]).toMatchObject({ title: 'Geheimes Projekt Falke', confidential: true, topic: null, message: 'Importiert aus alt.csv, Zeile 7.' });
    const deadlines = await withTenant(tenant, (db) => db.query("SELECT 1 FROM deadlines d JOIN ideas i ON i.id = d.idea_id WHERE i.imported AND d.phase = 'gate1'"));
    expect(deadlines.rowCount).toBe(3);
    // Only the workspace's own log entries are kept as proof.
    const audit = await withTenant(tenant, (db) => db.query<{ after: { actionIds: string[] } }>("SELECT after FROM audit_log WHERE action = 'ideas.import'"));
    expect(audit.rows[0].after.actionIds).not.toContain(theirAction);
    expect(audit.rows[0].after.actionIds.length).toBe(preview.body.ai.actionIds.length);
    // Nothing reached the neighbour.
    expect((await withTenant(other, (db) => db.query('SELECT 1 FROM ideas WHERE imported'))).rowCount).toBe(0);
    // A second commit of the same rows finds them as duplicates.
    const again = await api.admin.post('/api/admin/import/ai/commit', { filename: 'alt.csv', rows: rows.slice(0, 1) });
    expect(again.body).toMatchObject({ imported: 0, duplicates: [2] });
  });

  it('refuses files that are too large for the AI import', async () => {
    const big = ['Titel', ...Array.from({ length: 501 }, (_, i) => `Idee Nummer ${i}`)].join('\n');
    const res = await api.admin.post('/api/admin/import/ai/preview', { filename: 'gross.csv', data: Buffer.from(big).toString('base64') });
    expect(res.status).toBe(400);
  });
});
