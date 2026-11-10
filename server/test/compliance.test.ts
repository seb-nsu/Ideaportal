import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setWebSearch } from '../src/ai/search.js';
import { setPageFetcher } from '../src/ai/sourcecheck.js';
import { defaultAiSettings, type AiSettings } from '../src/ai/settings.js';
import { drainAiJobs } from '../src/ai/worker.js';
import { compliance as op, config } from '../src/config.js';
import { closePool, poolSsl, withSystem, withTenant } from '../src/db/pool.js';
import { LEGAL_DOCS, loadLegal, subprocessorList, subprocessorsCsv } from '../src/services/compliance.js';
import { addMonths, textSignals } from '../src/services/invention.js';
import { client, createTenant, createUser, login, resetDb, testApp, validIdea } from './helpers.js';

// AP-25: EU hosting, encryption and sub-processors (R3-08), legal texts in the product (R3-11)
// and the invention disclosure check (R3-25).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let app: FastifyInstance;
let tenant: string;
let other: string;
let api: Record<string, ReturnType<typeof client>>;

beforeAll(async () => {
  await resetDb();
  app = await testApp();
  tenant = await createTenant('recht', {
    holidays: [],
    targetChannels: [
      { id: 'patente', name: 'Patentstelle', kind: 'patent', contact: 'patente@recht.example', url: '' },
      { id: 'personal', name: 'Personal', kind: 'hr', contact: 'hr@recht.example', url: '' },
    ],
  });
  other = await createTenant('recht-nachbar', { holidays: [] });
  const users = {
    author: await createUser(tenant, 'author@recht.example'),
    triage: await createUser(tenant, 'triage@recht.example', ['submitter', 'triage']),
    admin: await createUser(tenant, 'admin@recht.example', ['submitter', 'admin']),
    council: await createUser(tenant, 'br@recht.example', ['works_council']),
    otherAdmin: await createUser(other, 'admin@nachbar.example', ['submitter', 'admin', 'triage']),
  };
  api = {};
  for (const [k, u] of Object.entries(users)) api[k] = client(app, await login(app, k === 'otherAdmin' ? 'recht-nachbar' : 'recht', u.email));
});

afterEach(() => {
  setWebSearch(null);
});

afterAll(async () => {
  setPageFetcher(null);
  await app.close();
  await closePool();
});

async function setAi(tenantId: string, ai: Partial<AiSettings>) {
  await withSystem((c) => c.query(`UPDATE tenants SET settings = jsonb_set(settings, '{ai}', $2::jsonb) WHERE id = $1`, [tenantId, JSON.stringify({ ...defaultAiSettings, ...ai })]));
}

async function submitted(extra: Record<string, unknown> = {}): Promise<string> {
  const created = await api.author.post('/api/ideas', { ...validIdea, ...extra });
  expect(created.status).toBe(201);
  expect((await api.author.post(`/api/ideas/${created.body.id}/submit`, { confirmNotReport: true, boundaryAcknowledged: true })).status).toBe(200);
  return created.body.id;
}

// ---------------------------------------------------------------- R3-08

describe('EU hosting, encryption and sub-processors (R3-08)', () => {
  it('deploys every service and database of the Render blueprint in the EU region', () => {
    const yaml = readFileSync(path.join(root, 'render.yaml'), 'utf8');
    const entries = yaml.split(/\n\s+- (?:type|name):/).slice(1);
    expect(entries.length).toBeGreaterThanOrEqual(4);
    for (const e of entries) expect(e).toMatch(/region: frankfurt/);
    expect(yaml).not.toMatch(/region: (?!frankfurt)/);
    // The legal texts take the hosting details from the blueprint.
    expect(yaml).toMatch(/HOSTING_REGION/);
  });

  it('switches TLS to the database on with DATABASE_SSL', () => {
    expect(poolSsl('off')).toBeUndefined();
    expect(poolSsl('require')).toEqual({ rejectUnauthorized: true });
    expect(poolSsl('require', '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----')).toMatchObject({ rejectUnauthorized: true, ca: expect.stringContaining('BEGIN CERTIFICATE') });
    expect(poolSsl('no-verify')).toEqual({ rejectUnauthorized: false });
  });

  it('lists hosting plus every external AI and search provider of the workspace', () => {
    const ai: AiSettings = {
      ...defaultAiSettings,
      providers: [
        ...defaultAiSettings.providers,
        { id: 'anthropic', name: 'Anthropic Claude', kind: 'anthropic', baseUrl: '', hosting: 'other', keySource: 'tenant' },
        { id: 'mistral', name: 'Mistral (EU)', kind: 'openai_compatible', baseUrl: 'https://api.mistral.ai/v1', hosting: 'eu', keySource: 'platform' },
        { id: 'ollama', name: 'Eigenes Modell', kind: 'openai_compatible', baseUrl: 'http://localhost:11434/v1', hosting: 'local', keySource: 'none' },
      ],
      models: { ...defaultAiSettings.models, fast: { provider: 'mistral', model: 'mistral-small-latest' }, deep: { provider: 'anthropic', model: 'claude-sonnet-5-5' }, confidential: { provider: 'ollama', model: 'llama3.3' } },
      search: { ...defaultAiSettings.search, kind: 'brave' },
    };
    const list = subprocessorList('de', ai, []);
    expect(list.map((s) => s.key)).toEqual(['hosting', 'ai:anthropic', 'ai:mistral', 'ai:ollama', 'search:brave']);
    const by = Object.fromEntries(list.map((s) => [s.key, s]));
    expect(by['ai:anthropic']).toMatchObject({ contract: 'customer', location: 'other', active: true });
    expect(by['ai:anthropic'].purpose).toMatch(/Wettbewerbs- und Lösungsanalyse/);
    expect(by['ai:mistral']).toMatchObject({ contract: 'operator', location: 'eu', active: true });
    expect(by['ai:mistral'].purpose).toMatch(/Ideen-Coach/);
    expect(by['ai:ollama']).toMatchObject({ contract: 'none', location: 'local' });
    expect(by['ai:ollama'].data).toMatch(/auch vertrauliche/);
    // Search key of the workspace: the customer's own contract; without: the operator's.
    expect(by['search:brave'].contract).toBe('operator');
    expect(subprocessorList('de', ai, ['search']).find((s) => s.kind === 'search')!.contract).toBe('customer');
    // English labels for the export in English.
    expect(subprocessorList('en', ai, [])[0].locationText).toBe('EU/EEA');
    const csv = subprocessorsCsv('de', list);
    expect(csv.split('\r\n')[0]).toBe('﻿Name;Art;Zweck;Daten;Ort der Verarbeitung;Vertragsverhältnis;aktiv');
    expect(csv).toMatch(/Anthropic Claude;KI-Anbieter;/);
  });

  it('serves the list for admins as JSON and CSV and follows the AI settings of the workspace', async () => {
    expect((await api.triage.get('/api/admin/compliance/subprocessors')).status).toBe(403);
    let r = await api.admin.get('/api/admin/compliance/subprocessors');
    expect(r.status).toBe(200);
    expect(r.body.subprocessors.map((s: { kind: string }) => s.kind)).toEqual(['hosting']);
    await setAi(tenant, {
      providers: [...defaultAiSettings.providers, { id: 'mistral', name: 'Mistral (EU)', kind: 'openai_compatible', baseUrl: 'https://api.mistral.ai/v1', hosting: 'eu', keySource: 'tenant' }],
      models: { ...defaultAiSettings.models, fast: { provider: 'mistral', model: 'mistral-small-latest' } },
    });
    r = await api.admin.get('/api/admin/compliance/subprocessors');
    expect(r.body.subprocessors.map((s: { name: string }) => s.name)).toContain('Mistral (EU)');
    // The other workspace keeps its own list.
    const o = await api.otherAdmin.get('/api/admin/compliance/subprocessors');
    expect(o.body.subprocessors.map((s: { name: string }) => s.name)).not.toContain('Mistral (EU)');
    const csv = await app.inject({ method: 'GET', url: '/api/admin/compliance/subprocessors?format=csv', headers: { cookie: (await login(app, 'recht', 'admin@recht.example')) } });
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.body).toMatch(/Mistral \(EU\)/);
    await setAi(tenant, {});
  });

  it('shows the state of encryption and hosting to admins', async () => {
    const r = await api.admin.get('/api/admin/compliance');
    expect(r.status).toBe(200);
    expect(r.body.security).toMatchObject({ secretKey: true, databaseTls: 'off', hostingLocation: 'eu' });
  });
});

// ---------------------------------------------------------------- R3-11

describe('legal texts and compliance documents in the product (R3-11)', () => {
  it('versions every document with version and date and marks it as a draft', () => {
    for (const name of LEGAL_DOCS) {
      const tpl = loadLegal(name);
      expect(tpl.version).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
      expect(tpl.render({})).toMatch(/Entwurf, keine Rechtsberatung, anwaltliche Prüfung offen/);
    }
  });

  it('serves terms and privacy policy without an account, the other documents not', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/legal' });
    expect(list.statusCode).toBe(200);
    expect(JSON.parse(list.body).documents.map((d: { name: string }) => d.name)).toEqual(['agb', 'datenschutz']);
    const agb = JSON.parse((await app.inject({ method: 'GET', url: '/api/legal/agb' })).body);
    expect(agb).toMatchObject({ name: 'agb', version: loadLegal('agb').version });
    expect(agb.blocks[0]).toMatchObject({ kind: 'title' });
    expect(agb.markdown).toMatch(/\[Name des Anbieters\]/);
    const md = await app.inject({ method: 'GET', url: '/api/legal/datenschutz?format=md' });
    expect(md.headers['content-type']).toMatch(/text\/markdown/);
    const pdf = await app.inject({ method: 'GET', url: '/api/legal/agb?format=pdf' });
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    for (const name of ['tom', 'dsfa', 'avv', 'unbekannt']) expect((await app.inject({ method: 'GET', url: `/api/legal/${name}` })).statusCode).toBe(404);
    // English page labels, German document.
    const en = JSON.parse((await app.inject({ method: 'GET', url: '/api/legal', headers: { 'accept-language': 'en' } })).body);
    expect(en.documents[0].title).toBe('Terms and conditions (SaaS, B2B)');
  });

  it('fills the operator details from the configuration', async () => {
    const before = { ...op };
    Object.assign(op, { operatorName: 'Beispiel Software GmbH', hostingProvider: 'Beispiel-Hoster', hostingRegion: 'Frankfurt am Main' });
    try {
      const doc = JSON.parse((await app.inject({ method: 'GET', url: '/api/legal/datenschutz' })).body);
      expect(doc.markdown).toMatch(/Beispiel Software GmbH/);
      expect(doc.markdown).toMatch(/in der EU bei Beispiel-Hoster \(Frankfurt am Main\)/);
    } finally {
      Object.assign(op, before);
    }
  });

  it('gives admins TOM, DSFA template and AVV filled with the workspace; others get 403', async () => {
    for (const k of ['author', 'triage', 'council']) expect((await api[k].get('/api/admin/compliance/documents/avv')).status).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/admin/compliance' })).statusCode).toBe(401);
    await setAi(tenant, {
      providers: [...defaultAiSettings.providers, { id: 'anthropic', name: 'Anthropic Claude', kind: 'anthropic', baseUrl: '', hosting: 'other', keySource: 'platform' }],
      models: { ...defaultAiSettings.models, deep: { provider: 'anthropic', model: 'claude-sonnet-5-5' } },
    });
    const avv = await api.admin.get('/api/admin/compliance/documents/avv');
    expect(avv.status).toBe(200);
    expect(avv.body.markdown).toMatch(/Arbeitsbereich „Mandant recht“/);
    expect(avv.body.markdown).toMatch(/\| Anthropic Claude \| KI-Funktionen: .*Unterauftragnehmer des Anbieters \| ja \|/);
    const tom = await api.admin.get('/api/admin/compliance/documents/tom');
    expect(tom.body.markdown).toMatch(/erst ab 5 Personen/);
    expect(tom.body.markdown).toMatch(/Server-Schlüssel gesetzt/);
    const dsfa = await api.admin.get('/api/admin/compliance/documents/dsfa');
    expect(dsfa.body.markdown).toMatch(/Aktive KI-Funktionen: /);
    const overview = await api.admin.get('/api/admin/compliance');
    expect(overview.body.documents.map((d: { name: string }) => d.name)).toEqual([...LEGAL_DOCS]);
    await setAi(tenant, {});
  });

  it('logs the acceptance of the current terms by an admin, per workspace', async () => {
    const version = loadLegal('agb').version;
    expect((await api.triage.post('/api/admin/compliance/accept', { document: 'agb', version })).status).toBe(403);
    const old = await api.admin.post('/api/admin/compliance/accept', { document: 'agb', version: '2020-01-01.1' });
    expect(old.status).toBe(400);
    expect(old.body.error).toMatch(/nicht mehr aktuell/);
    expect((await api.admin.post('/api/admin/compliance/accept', { document: 'agb', version })).status).toBe(200);
    // Twice is fine and logs once.
    expect((await api.admin.post('/api/admin/compliance/accept', { document: 'agb', version })).status).toBe(200);
    const overview = await api.admin.get('/api/admin/compliance');
    const agb = overview.body.documents.find((d: { name: string }) => d.name === 'agb');
    expect(agb.accepted).toMatchObject({ version, acceptedBy: 'admin' });
    const audits = await withSystem(async (c) => (await c.query(`SELECT tenant_id, after FROM audit_log WHERE action = 'legal.accept'`)).rows);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ tenant_id: tenant, after: { document: 'agb', version } });
    // The neighbour has accepted nothing and cannot see the acceptance.
    const o = await api.otherAdmin.get('/api/admin/compliance');
    expect(o.body.acceptances).toEqual([]);
    expect(o.body.documents.find((d: { name: string }) => d.name === 'agb').accepted).toBeNull();
  });

  it('isolates legal_acceptances by row-level security and keeps them append-only', async () => {
    const rows = await withTenant(other, async (db) => (await db.query('SELECT * FROM legal_acceptances')).rows);
    expect(rows).toEqual([]);
    await expect(withTenant(other, (db) => db.query(`INSERT INTO legal_acceptances (tenant_id, document, version) VALUES ($1, 'agb', 'x')`, [tenant]))).rejects.toThrow(/row-level security/);
    await expect(withTenant(tenant, (db) => db.query(`DELETE FROM legal_acceptances`))).rejects.toThrow(/permission denied/);
    await expect(withTenant(tenant, (db) => db.query(`UPDATE legal_acceptances SET version = 'y'`))).rejects.toThrow(/permission denied/);
  });
});

// ---------------------------------------------------------------- R3-25

describe('invention disclosure check (R3-25)', () => {
  it('adds months to the forwarding date like § 188 BGB', () => {
    expect(addMonths('2026-10-13', 4)).toBe('2027-02-13');
    expect(addMonths('2026-10-31', 4)).toBe('2027-02-28');
    expect(addMonths('2027-10-31', 4)).toBe('2028-02-29');
  });

  it('finds signals of a technical novelty in the text', () => {
    expect(textSignals('Ein neuartiger Sensor mit eigenem Verfahren')).toEqual(['neuartiger', 'sensor', 'verfahren']);
    expect(textSignals('Kaffee für alle')).toEqual([]);
  });

  it('asks the triage team "possible invention?" with hints; others may not', async () => {
    const id = await submitted({ title: 'Neuartiger Sensor für Lagerregale', solution: 'Ein Sensor mit eigenem Verfahren misst den Füllstand der Regale automatisch.' });
    for (const k of ['author', 'council']) expect((await api[k].get(`/api/ideas/${id}/invention`)).status).toBe(403);
    expect((await api.otherAdmin.get(`/api/ideas/${id}/invention`)).status).toBe(404);
    const r = await api.triage.get(`/api/ideas/${id}/invention`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, check: null, webSearchBlocked: false, claimMonths: 4, patentChannels: [{ id: 'patente', name: 'Patentstelle' }] });
    expect(r.body.hints.map((h: { source: string }) => h.source)).toEqual(['R2-24', 'R2-29', 'text']);
    expect(r.body.hints[2].text).toMatch(/neuartiger, sensor, verfahren/);
    expect(r.body.notice).toMatch(/keine Rechtsberatung/);

    expect((await api.author.put(`/api/ideas/${id}/invention`, { check: 'possible' })).status).toBe(403);
    const set = await api.triage.put(`/api/ideas/${id}/invention`, { check: 'possible' });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ check: 'possible', checkedBy: 'triage', webSearchBlocked: true });
    const audit = await withSystem(async (c) => (await c.query(`SELECT after FROM audit_log WHERE action = 'idea.invention_check' AND entity_id = $1`, [id])).rows);
    expect(audit[0].after).toEqual({ invention_check: 'possible' });
    expect((await api.triage.put(`/api/ideas/${id}/invention`, { check: null })).body.check).toBeNull();
  });

  it('uses the results of the patent search (R2-24) and the risk check (R2-29) as hints', async () => {
    const id = await submitted({ title: 'Vorrichtung zum Sortieren', ideaType: 'product' });
    await withSystem(async (c) => {
      await c.query(`INSERT INTO ai_results (tenant_id, idea_id, kind, version, content) VALUES ($1, $2, 'patents', 1, $3)`, [tenant, id, JSON.stringify({ agent: 'patents', data: { hits: [{ title: 'A' }, { title: 'B' }] }, sections: [] })]);
      await c.query(`INSERT INTO ai_results (tenant_id, idea_id, kind, version, content) VALUES ($1, $2, 'risk_check', 1, $3)`, [tenant, id, JSON.stringify({
        agent: 'risk_check', sections: [],
        data: { areas: [
          { area: 'privacy', light: 'green', finding: 'ok', office: 'DSB' },
          { area: 'patentability', light: 'yellow', finding: 'Technische Lösung könnte schutzfähig sein.', office: 'Patentstelle' },
          { area: 'employee_invention', light: 'red', finding: 'Diensterfindung wahrscheinlich.', office: 'Patentstelle' },
        ] },
      })]);
    });
    const r = await api.triage.get(`/api/ideas/${id}/invention`);
    const texts = r.body.hints.map((h: { text: string }) => h.text);
    expect(texts[0]).toMatch(/2 Treffer/);
    expect(r.body.hints[1]).toMatchObject({ source: 'R2-29', light: 'yellow' });
    expect(texts[1]).toMatch(/Patentfähigkeit: Technische Lösung/);
    expect(r.body.hints[2]).toMatchObject({ source: 'R2-29', light: 'red' });
  });

  it('runs no web search for a possible invention', async () => {
    const queries: string[] = [];
    setWebSearch(async (_ctx, q) => {
      queries.push(q);
      return [{ title: 'Anbieter', url: 'https://example.org/a', snippet: 'Ein Anbieter.' }];
    });
    setPageFetcher(async () => {
      throw new Error('no network in tests');
    });
    await setAi(tenant, { requireEval: false, search: { ...defaultAiSettings.search, kind: 'searxng', baseUrl: 'https://suche.example' } });
    await drainAiJobs();
    queries.length = 0;
    const id = await submitted({ ideaType: 'product', title: 'Produktidee neuartiger Greifer' });
    await api.triage.put(`/api/ideas/${id}/invention`, { check: 'possible' });
    await drainAiJobs();
    expect(queries).toEqual([]);
    const skipped = await withSystem(async (c) => (await c.query(`SELECT error FROM ai_actions WHERE idea_id = $1 AND agent = 'web_search' AND status = 'skipped'`, [id])).rows);
    expect(skipped[0].error).toMatch(/Mögliche Erfindung, keine Websuche/);
    // Control: the same kind of idea without the mark gets a search.
    await submitted({ ideaType: 'product', title: 'Produktidee Greifer Vergleich' });
    await drainAiJobs();
    expect(queries.length).toBeGreaterThan(0);
    await setAi(tenant, {});
  });

  it('forwarding to the patent office makes the idea confidential and notes the claim period', async () => {
    const id = await submitted({ title: 'Neue Vorrichtung für Paletten' });
    const today = (await api.author.get('/api/settings')).body.today as string;
    const r = await api.triage.post(`/api/ideas/${id}/triage`, { lane: 'forward', channelId: 'patente', reason: 'Mögliche Diensterfindung, Prüfung durch die Patentstelle.' });
    expect(r.status).toBe(200);
    const row = await withSystem(async (c) => (await c.query(`SELECT confidential, status, invention_check, invention_forwarded_on, invention_claim_until FROM ideas WHERE id = $1`, [id])).rows[0]);
    expect(row).toMatchObject({ confidential: true, status: 'forwarded', invention_check: 'possible', invention_forwarded_on: today, invention_claim_until: addMonths(today, 4) });
    const view = await api.triage.get(`/api/ideas/${id}/invention`);
    expect(view.body).toMatchObject({ confidential: true, forwardedOn: today, claimUntil: addMonths(today, 4), checkedBy: 'triage' });
    const events = await withSystem(async (c) => (await c.query(`SELECT kind, message FROM idea_events WHERE idea_id = $1 ORDER BY id`, [id])).rows);
    expect(events.find((e) => e.kind === 'gate1')!.message).toMatch(/mögliche Erfindung behandelt und ist ab jetzt vertraulich/);
    expect(events.find((e) => e.kind === 'invention_forwarded')!.message).toMatch(/Fristhinweis \(keine Rechtsberatung\).*4 Monate/);
    // The author still sees the idea; the neighbour's admin does not.
    expect((await api.author.get(`/api/ideas/${id}`)).body.confidential).toBe(true);
    expect((await api.otherAdmin.get(`/api/ideas/${id}`)).status).toBe(404);
  });

  it('forwarding to another channel changes nothing about confidentiality', async () => {
    const id = await submitted({ title: 'Mehr Weiterbildung' });
    expect((await api.triage.post(`/api/ideas/${id}/triage`, { lane: 'forward', channelId: 'personal', reason: 'Thema der Personalentwicklung, dort weiter.' })).status).toBe(200);
    const row = await withSystem(async (c) => (await c.query(`SELECT confidential, invention_claim_until FROM ideas WHERE id = $1`, [id])).rows[0]);
    expect(row).toEqual({ confidential: false, invention_claim_until: null });
  });

  it('follows the workspace settings: claim period and switch', async () => {
    await withSystem((c) => c.query(`UPDATE tenants SET settings = settings || '{"invention": {"enabled": false, "claimMonths": 3}}'::jsonb WHERE id = $1`, [tenant]));
    const id = await submitted({ title: 'Noch eine Vorrichtung' });
    expect((await api.triage.put(`/api/ideas/${id}/invention`, { check: 'possible' })).status).toBe(400);
    expect((await api.triage.get(`/api/ideas/${id}/invention`)).body).toMatchObject({ enabled: false, claimMonths: 3 });
    await withSystem((c) => c.query(`UPDATE tenants SET settings = settings - 'invention' WHERE id = $1`, [tenant]));
  });

  it('accepts the patent channel kind in the settings', async () => {
    const s = (await api.admin.get('/api/admin/settings')).body;
    expect(s.targetChannels.find((c: { kind: string }) => c.kind === 'patent')).toBeTruthy();
    expect(config.databaseSsl).toBe('off');
  });
});
