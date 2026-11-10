import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/pool.js';
import { AGENTS } from '../src/ai/settings.js';
import { compileTemplate } from '../src/lib/template.js';
import { PERMISSIONS } from '../src/lib/context.js';
import { markdownToBlocks } from '../src/services/codetermination.js';
import { client, createTenant, createUser, login, resetDb, testApp } from './helpers.js';

// Co-determination (AP-15, R3-12): read-only overview for the works council, AI switches for
// admins with change history, model works agreement and pilot toleration agreement generated
// from the settings, two tenants.

let app: FastifyInstance;
const cookies: Record<string, string> = {};
let api: Record<'council' | 'admin' | 'triage' | 'submitter' | 'otherAdmin' | 'otherCouncil', ReturnType<typeof client>>;

beforeAll(async () => {
  await resetDb();
  app = await testApp();
  const tenant = await createTenant('mitbestimmung');
  const other = await createTenant('anderswo');
  const users = {
    council: await createUser(tenant, 'betriebsrat@mitbestimmung.example', ['works_council']),
    admin: await createUser(tenant, 'admin@mitbestimmung.example', ['submitter', 'admin']),
    triage: await createUser(tenant, 'triage@mitbestimmung.example', ['submitter', 'triage']),
    submitter: await createUser(tenant, 'erika@mitbestimmung.example', ['submitter']),
    otherAdmin: await createUser(other, 'admin@anderswo.example', ['submitter', 'admin']),
    otherCouncil: await createUser(other, 'betriebsrat@anderswo.example', ['works_council']),
  };
  api = {} as typeof api;
  for (const [k, u] of Object.entries(users)) {
    cookies[k] = await login(app, k.startsWith('other') ? 'anderswo' : 'mitbestimmung', u.email);
    api[k as keyof typeof api] = client(app, cookies[k]);
  }
});

afterAll(async () => {
  await app.close();
  await closePool();
});

function raw(who: keyof typeof api, url: string) {
  return app.inject({ method: 'GET', url, headers: { cookie: cookies[who] } });
}

describe('co-determination overview (R3-12)', () => {
  it('is readable for the works council and admins only', async () => {
    expect((await api.council.get('/api/codetermination')).status).toBe(200);
    expect((await api.admin.get('/api/codetermination')).status).toBe(200);
    expect((await api.triage.get('/api/codetermination')).status).toBe(403);
    expect((await api.submitter.get('/api/codetermination')).status).toBe(403);
  });

  it('lists roles and rights from the code, reports with threshold, AI functions, retention and logs', async () => {
    const { body } = await api.council.get('/api/codetermination');
    expect(body.canEdit).toBe(false);
    // Rights come from the permission table and the route registry.
    const council = body.roles.find((r: { role: string }) => r.role === 'works_council');
    expect(council.permissions.map((p: { key: string }) => p.key).sort()).toEqual(
      Object.entries(PERMISSIONS).filter(([, roles]) => (roles as readonly string[]).includes('works_council')).map(([k]) => k).sort(),
    );
    expect(council.endpoints).toContain('GET /api/ai/proofs');
    expect(council.endpoints).toContain('GET /api/codetermination');
    expect(council.endpoints).not.toContain('PUT /api/codetermination/ai-functions/:agent');
    const admin = body.roles.find((r: { role: string }) => r.role === 'admin');
    expect(admin.endpoints).toContain('PUT /api/codetermination/ai-functions/:agent');
    expect(admin.endpoints).toContain('GET /api/admin/audit');
    expect(body.endpoints.restricted).toBeGreaterThan(20);
    // Reports with the roles that the endpoint really requires and the minimum group.
    const dashboard = body.reports.find((r: { key: string }) => r.key === 'dashboard');
    expect(dashboard.roles.sort()).toEqual(['admin', 'committee', 'lead', 'triage']);
    expect(dashboard.minGroupSize).toBe(5);
    expect(body.reports.every((r: { roles: unknown; endpoint: string }) => /^(GET|POST) \/api\//.test(r.endpoint))).toBe(true);
    // Every AI function with state, provider, hosting and data.
    expect(body.ai.functions).toHaveLength(AGENTS.length);
    const coach = body.ai.functions.find((f: { agent: string }) => f.agent === 'coach');
    expect(coach).toMatchObject({ switchedOn: true, active: true, model: { hostingKey: 'local' } });
    expect(coach.data).toMatch(/Entwurf/);
    expect(body.ai.functions.find((f: { agent: string }) => f.agent === 'patents').active).toBe(false); // off by idea type default
    expect(body.retention.periods.map((p: { key: string }) => p.key)).toEqual(['closedIdeasMonths', 'notificationsMonths', 'anonymizeDeactivatedAfterDays', 'aiActionsMonths']);
    expect(body.retention.protocols.map((p: { key: string }) => p.key)).toContain('audit');
    expect(body.agreement.templates.map((t: { name: string; version: string }) => t.name)).toEqual(['betriebsvereinbarung', 'duldungsvereinbarung']);
  });

  it('the works council cannot switch AI functions or change agreement details', async () => {
    expect((await api.council.put('/api/codetermination/ai-functions/coach', { enabled: false })).status).toBe(403);
    expect((await api.council.put('/api/codetermination/agreement-settings', {
      employer: 'X', worksCouncil: '', scope: '', objectionBody: '', objectionWeeks: 2, announceWeeks: 4, pilotArea: '', pilotMonths: 6,
    })).status).toBe(403);
    expect((await api.triage.put('/api/codetermination/ai-functions/coach', { enabled: false })).status).toBe(403);
    expect((await api.admin.put('/api/codetermination/ai-functions/nonsense', { enabled: false })).status).toBe(400);
  });

  it('admins switch an AI function; the change is audited, shown as history and enforced by the gateway', async () => {
    const before = await raw('council', '/api/codetermination/agreements/betriebsvereinbarung?format=md');
    expect(before.statusCode).toBe(200);
    expect(before.body).toMatch(/\| Ideen-Coach \|/);

    const res = await api.admin.put('/api/codetermination/ai-functions/coach', { enabled: false });
    expect(res.status).toBe(200);
    const { body } = await api.council.get('/api/codetermination');
    const coach = body.ai.functions.find((f: { agent: string }) => f.agent === 'coach');
    expect(coach).toMatchObject({ switchedOn: false, active: false });
    const entry = body.history.find((h: { action: string }) => h.action === 'codetermination.ai_function');
    expect(entry.actorName).toBe('admin');
    expect(entry.changes).toEqual([{ path: 'ai.agents.coach.enabled', before: 'true', after: 'false' }]);
    const audit = (await api.admin.get('/api/admin/audit')).body;
    expect(audit.some((a: { action: string }) => a.action === 'codetermination.ai_function')).toBe(true);

    // The gateway refuses the switched-off function.
    const coachCall = await api.submitter.post('/api/ai/coach', { title: 'Kantine', problem: 'Lange Schlange mittags.', solution: 'Gestaffelte Pausen.', benefit: '' });
    expect(coachCall.status).toBeGreaterThanOrEqual(400);

    // The generated agreement no longer lists it as active.
    const after = await raw('council', '/api/codetermination/agreements/betriebsvereinbarung?format=md');
    const [active, rest] = after.body.split('Abgeschaltete KI-Funktionen:');
    expect(active).not.toMatch(/\| Ideen-Coach \|/);
    expect(rest).toMatch(/- Ideen-Coach/);

    await api.admin.put('/api/codetermination/ai-functions/coach', { enabled: true });
  });

  it('fills the model works agreement from the settings and offers it as Markdown and PDF', async () => {
    const saved = await api.admin.put('/api/codetermination/agreement-settings', {
      employer: 'Muster GmbH', worksCouncil: 'Betriebsrat der Muster GmbH', scope: 'Standort Köln', objectionBody: 'Ideenkommission',
      objectionWeeks: 3, announceWeeks: 6, pilotArea: 'Vertrieb Nord', pilotMonths: 4,
    });
    expect(saved.status).toBe(200);
    const settings = (await api.admin.get('/api/admin/settings')).body;
    await api.admin.put('/api/admin/settings', { ...settings, minGroupSize: 7, retention: { ...settings.retention, aiActionsMonths: 18 } });

    const md = (await raw('council', '/api/codetermination/agreements/betriebsvereinbarung?format=md'));
    expect(md.headers['content-type']).toMatch(/text\/markdown/);
    expect(md.headers['content-disposition']).toMatch(/betriebsvereinbarung-\d{4}-\d{2}-\d{2}\.md/);
    const text = md.body;
    expect(text).toMatch(/Entwurf, keine Rechtsberatung, anwaltliche Prüfung offen/);
    expect(text).toMatch(/Vorlage 2026-10-13\.1, erzeugt am/);
    expect(text).toMatch(/\*\*Muster GmbH\*\*/);
    expect(text).toMatch(/Räumlich: Standort Köln\./);
    expect(text).toMatch(/erst ab 7 Personen je Gruppe/);
    expect(text).toMatch(/\| KI-Protokoll und KI-Ergebnisse \| 18 Monate \|/);
    expect(text).toMatch(/innerhalb von 3 Wochen nach der Mitteilung Einspruch einlegen bei Ideenkommission/);
    expect(text).toMatch(/mindestens 6 Wochen vorher/);
    expect(text).toMatch(/\| Dashboard \(Kennzahlen/);
    expect(text).toMatch(/\| Audit-Log \| Wer hat wann was geändert/);
    expect(text).toMatch(/\| Betriebsrat \(lesend\) \|/);
    expect(text).not.toMatch(/\{\{|\}\}/);

    const pilot = (await raw('council', '/api/codetermination/agreements/duldungsvereinbarung?format=md')).body;
    expect(pilot).toMatch(/im Bereich Vertrieb Nord für höchstens 4 Monate/);
    expect(pilot).toMatch(/Entwurf, keine Rechtsberatung/);

    const pdf = await raw('council', '/api/codetermination/agreements/betriebsvereinbarung?format=pdf');
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
    expect(pdf.rawPayload.toString('latin1')).toContain('Muster GmbH');

    expect((await raw('submitter', '/api/codetermination/agreements/betriebsvereinbarung?format=pdf')).statusCode).toBe(403);
    expect((await raw('council', '/api/codetermination/agreements/unbekannt')).statusCode).toBe(400);

    // Changes of the general settings appear in the history as well.
    const history = (await api.council.get('/api/codetermination')).body.history;
    expect(history.some((h: { action: string; changes: { path: string }[] }) => h.action === 'settings.update' && h.changes.some((c) => c.path === 'minGroupSize'))).toBe(true);
    expect(history.some((h: { action: string }) => h.action === 'codetermination.settings')).toBe(true);
  });

  it('keeps tenants apart', async () => {
    await api.otherAdmin.put('/api/codetermination/ai-functions/short_analysis', { enabled: false });
    const mine = (await api.council.get('/api/codetermination')).body;
    expect(mine.ai.functions.find((f: { agent: string }) => f.agent === 'short_analysis').switchedOn).toBe(true);
    expect(mine.history.some((h: { changes: { path: string }[] }) => h.changes.some((c) => c.path.includes('short_analysis')))).toBe(false);
    const theirs = (await api.otherCouncil.get('/api/codetermination')).body;
    expect(theirs.ai.functions.find((f: { agent: string }) => f.agent === 'short_analysis').switchedOn).toBe(false);
    expect(theirs.history).toHaveLength(1);
    expect(theirs.agreement.settings.employer).toBe('');
    expect(theirs.minGroupSize).toBe(5);
    const md = (await raw('otherCouncil', '/api/codetermination/agreements/betriebsvereinbarung?format=md')).body;
    expect(md).not.toMatch(/Muster GmbH/);
    expect(md).toMatch(/\[Name des Arbeitgebers\]/);
  });
});

describe('template engine and PDF blocks', () => {
  it('renders values, conditions and loops and keeps the version', () => {
    const tpl = compileTemplate('<!-- template: probe, version 1.2 -->\n# {{title}}\n{{#if on}}an{{else}}aus{{/if}}\n{{#each items}}- {{.name}}{{#if .x}} x{{/if}}\n{{/each}}| {{cell}} |\n');
    expect(tpl.version).toBe('1.2');
    expect(tpl.render({ title: 'Titel', on: false, items: [{ name: 'a', x: true }, { name: 'b' }], cell: 'a|b\nc' })).toBe('# Titel\naus\n- a x\n- b\n| a/b c |\n');
    expect(() => compileTemplate('<!-- template: x, version 1 -->\n{{#if a}}')).toThrow();
  });

  it('turns the Markdown subset into PDF blocks', () => {
    const blocks = markdownToBlocks('# T\n\n## § 1\n\n1. Erster Satz.\n- Punkt\n\n| A | B |\n| --- | --- |\n| x | **y** |\n\n> Hinweis\n\nText\nweiter');
    expect(blocks).toEqual([
      { kind: 'title', text: 'T' },
      { kind: 'heading', text: '§ 1' },
      { kind: 'text', text: '1. Erster Satz.' },
      { kind: 'bullet', text: 'Punkt' },
      { kind: 'row', label: 'x', value: 'B: y' },
      { kind: 'text', text: 'Hinweis', small: true },
      { kind: 'text', text: 'Text weiter' },
    ]);
  });
});
