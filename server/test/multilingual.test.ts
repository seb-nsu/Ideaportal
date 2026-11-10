import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { coachCall, replyCall, riskCall, shortAnalysisCall, summaryCall, triageCall, type IdeaFacts } from '../src/ai/agents.js';
import { businessCaseCsv, computeBusinessCase, type Assumption } from '../src/ai/calc.js';
import { AiError, LANGUAGE_RULE, outputLocale, runAgent, systemFor, type AgentCall } from '../src/ai/gateway.js';
import { ProviderError, setProviderFactory, type GenerateRequest, type ModelProvider } from '../src/ai/providers.js';
import { closePool, withSystem } from '../src/db/pool.js';
import { de } from '../src/i18n/de/index.js';
import { en } from '../src/i18n/en/index.js';
import { m, refText, relocalize, relocalizeLines, tr, type MessageKey } from '../src/i18n/index.js';
import { AGENTS, agentLabel, providerTemplates } from '../src/ai/settings.js';
import { errorText } from '../src/lib/errors.js';
import type { Ctx, SessionUser } from '../src/lib/context.js';
import { localizedDefaults } from '../src/lib/default-texts.js';
import { defaultSettings, resolveSettings, settingsSchema } from '../src/lib/settings.js';
import { en as webEn } from '../../web/src/i18n/en/index.js';
import { asUser, createTenant, createUser, resetDb, testApp } from './helpers.js';

// R3-22 multilingual: English catalogue without German leftovers, AI answers in the language of
// the person (dialogue) or of the workspace (results stored at ideas), dates in the reader's
// format, default texts of new workspaces in the creator's language.

let app: FastifyInstance;
let deTenant: string;
let enTenant: string;
let anna: SessionUser;
let bob: SessionUser;

const idea: IdeaFacts = {
  id: null,
  title: 'Weniger Wartezeit an der Kantine',
  problem: 'Mittags stehen alle gleichzeitig in der Schlange und verlieren Zeit.',
  solution: 'Gestaffelte Pausenzeiten je Abteilung und Vorbestellung per App.',
  benefit: 'Etwa 10 Minuten weniger Wartezeit pro Person und Tag.',
  topic: null,
  ideaType: 'internal',
  confidential: false,
};

beforeAll(async () => {
  await resetDb();
  app = await testApp();
  deTenant = await createTenant('sprache-de');
  enTenant = await createTenant('sprache-en', localizedDefaults('en'));
  anna = await createUser(deTenant, 'anna@sprache.example', ['submitter', 'triage']);
  bob = await createUser(enTenant, 'bob@sprache.example', ['submitter', 'triage']);
});

afterEach(() => setProviderFactory(null));

afterAll(async () => {
  await app.close();
  await closePool();
});

// Skips the release check of the quality gate; these tests are about the language only.
const run = <T>(ctx: Ctx, call: AgentCall<T>) => runAgent(ctx, { ...call, evaluation: true });
const english = (u: SessionUser): SessionUser => ({ ...u, locale: 'en' });
// German function words that must not appear in English texts (a slash command like /idee is fine).
const GERMAN = /(?<![/\w])(und|der|das|nicht|bitte|oder|mit|für|wird|keine|werden)(?![\w])/i;

describe('English catalogue (R3-22)', () => {
  it('has no German leftovers in the server and interface texts', () => {
    const all = [...Object.entries(en), ...Object.entries(webEn as Record<string, string>)] as [string, string][];
    expect(all.length).toBeGreaterThan(1000);
    const umlauts = all.filter(([, v]) => /[äöüÄÖÜß]/.test(v)).map(([k]) => k);
    expect(umlauts).toEqual([]);
    const german = all.filter(([, v]) => GERMAN.test(v)).map(([k]) => k);
    expect(german).toEqual([]);
  });

  it('translates every text of the builtin provider and the workspace defaults', () => {
    const keys = Object.keys(de).filter((k) => k.startsWith('aiout.') || k.startsWith('defaults.'));
    expect(keys.length).toBeGreaterThan(150);
    const same = keys.filter((k) => de[k as MessageKey] && en[k as MessageKey] === de[k as MessageKey] && !/^(Problem|Problem: \{text\})$/.test(de[k as MessageKey]));
    expect(same).toEqual([]);
  });

  it('shows calendar dates in the format of the reader', () => {
    const text = m('jobs.reminder.body', { number: 7, title: 'Test', days: 2, date: '2026-10-20' });
    expect(tr('de', text)).toContain('20.10.2026');
    expect(tr('en', text)).toContain('20/10/2026');
  });
});

describe('workspace default texts (R3-22)', () => {
  it('keeps the German catalogue in sync with the German defaults', () => {
    const d = defaultSettings;
    expect(d.topics.map((_, i) => tr('de', m(`defaults.topic.${i + 1}` as MessageKey)))).toEqual(d.topics);
    expect(tr('de', m('defaults.text.reject'))).toBe(d.texts.reject);
    expect(tr('de', m('defaults.faq.1.a'))).toBe(d.texts.faq[0].a);
    for (const c of d.scorecard.criteria) expect(tr('de', m(`defaults.scorecard.${c.id}.a5` as MessageKey))).toBe(c.anchors[5]);
    expect(localizedDefaults('de')).toEqual({ locale: 'de' });
  });

  it('gives a new English workspace valid English defaults and keeps the German keywords', () => {
    const s = resolveSettings(localizedDefaults('en'));
    expect(settingsSchema.safeParse(s).success).toBe(true);
    expect(s.locale).toBe('en');
    expect(s.topics[0]).toBe('Processes and efficiency');
    expect(s.texts.fast_lane).toMatch(/^Thank you/);
    expect(s.scorecard.criteria.map((c) => c.weight)).toEqual(defaultSettings.scorecard.criteria.map((c) => c.weight));
    const report = s.boundaryRules.find((r) => r.category === 'report')!;
    expect(report.keywords).toEqual(expect.arrayContaining(['korruption', 'corruption']));
    expect(s.ai.tone).toMatch(/^Appreciative/);
    expect(resolveSettings(localizedDefaults('de')).ai.tone).toMatch(/^Wertschätzend/);
  });

  it('creates the workspace in the language of the sign-up page; existing workspaces stay German', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/signup',
      payload: { workspace: 'Acme Ltd', name: 'Jane', email: 'jane@acme.example', password: 'long-enough-123', acceptPrivacy: true, exampleData: true, locale: 'en' },
    });
    expect(res.statusCode).toBe(201);
    const row = await withSystem(async (c) => (await c.query<{ settings: { locale: string; topics: string[] }; locale: string; title: string }>(
      `SELECT t.settings, u.locale, (SELECT title FROM ideas i WHERE i.tenant_id = t.id LIMIT 1) AS title
         FROM tenants t JOIN users u ON u.tenant_id = t.id WHERE t.slug = $1`, [res.json().slug],
    )).rows[0]);
    expect(row.settings.locale).toBe('en');
    expect(row.settings.topics[0]).toBe('Processes and efficiency');
    expect(row.locale).toBe('en');
    expect(row.title).toMatch(/^Example idea/);
    const old = await withSystem(async (c) => (await c.query<{ settings: Record<string, unknown> }>('SELECT settings FROM tenants WHERE id = $1', [deTenant])).rows[0]);
    expect(old.settings.topics).toBeUndefined();
    expect(resolveSettings(old.settings).topics[0]).toBe('Prozesse und Effizienz');
  });

  it('uses the browser language when the page sends none', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/signup', headers: { 'accept-language': 'en-US,en;q=0.9' },
      payload: { workspace: 'Browser Co', name: 'Kim', email: 'kim@browser.example', password: 'long-enough-123', acceptPrivacy: true, exampleData: false },
    });
    expect(res.statusCode).toBe(201);
    const locale = await withSystem(async (c) => (await c.query<{ locale: string }>(`SELECT settings->>'locale' AS locale FROM tenants WHERE slug = $1`, [res.json().slug])).rows[0].locale);
    expect(locale).toBe('en');
  });
});

describe('AI output in the language of the person (R3-22)', () => {
  it('leaves German calls unchanged and adds the language rule for English', () => {
    expect(systemFor('SYSTEM', 'de')).toBe('SYSTEM');
    expect(systemFor('SYSTEM', 'en')).toBe(`SYSTEM${LANGUAGE_RULE.en}`);
    expect(LANGUAGE_RULE.en).toContain('Output language: English');
  });

  it('chooses the person for dialogue agents and the workspace for stored analyses', async () => {
    await asUser(english(anna), deTenant, async (ctx) => {
      expect(outputLocale(ctx, { agent: 'coach' })).toBe('en');
      expect(outputLocale(ctx, { agent: 'reply_draft' })).toBe('en');
      expect(outputLocale(ctx, { agent: 'short_analysis' })).toBe('de');
      expect(outputLocale(ctx, { agent: 'coach', locale: 'de' })).toBe('de');
    });
    await asUser(null, enTenant, async (ctx) => {
      expect(outputLocale(ctx, { agent: 'short_analysis' })).toBe('en');
      expect(outputLocale(ctx, { agent: 'coach' })).toBe('en');
    });
  });

  it('answers with the builtin provider in English or German', async () => {
    const empty = { title: '', problem: '', solution: '', benefit: '' };
    const deTurn = await asUser(anna, deTenant, (ctx) => run(ctx, coachCall([], empty, false)));
    expect(deTurn.output.reply).toBe('Was läuft heute nicht gut? Beschreibe die Situation und woran es liegt.');
    const enTurn = await asUser(english(anna), deTenant, (ctx) => run(ctx, coachCall([], empty, false)));
    expect(enTurn.output.reply).toMatch(/^What is not working well today\?/);

    const settings = (await asUser(anna, deTenant, async (ctx) => ctx.settings));
    const reply = await asUser(english(anna), deTenant, (ctx) => run(ctx, replyCall(idea, 'elaborate', 'Gute Idee.', settings)));
    expect(reply.output.subject).toMatch(/^Feedback on your idea/);
    const summary = await asUser(english(anna), deTenant, (ctx) => run(ctx, summaryCall(idea, [{ n: 1, body: 'Good idea, but who runs it?' }, { n: 2, body: 'I agree.' }])));
    expect(summary.output.summary).toMatch(/^2 comment\(s\)/);

    // Stored analyses follow the workspace: English workspace, job without a person.
    const short = await asUser(null, enTenant, (ctx) => run(ctx, shortAnalysisCall(idea, [])));
    expect(short.output.sections.map((s) => s.heading)).toEqual(['What it is about', 'Similar ideas in the portal', 'Ready-made solutions and how others do it', 'Market and benefit', 'Open questions']);
    const risks = await asUser(english(bob), enTenant, (ctx) => run(ctx, riskCall(idea)));
    expect(risks.output.areas.find((a) => a.area === 'privacy')!.office).toBe('Data protection officer');
    const sign: IdeaFacts = {
      ...idea,
      title: 'Sign for the meeting rooms',
      problem: 'People do not know which meeting room is free and walk around for minutes.',
      solution: 'We put a simple sign with a calendar code at every door.',
      benefit: 'Saves around 5 minutes per meeting for 200 staff.',
    };
    const triage = await asUser(null, enTenant, async (ctx) => run(ctx, triageCall(sign, null, ctx.settings)));
    expect(triage.output).toMatchObject({ lane: 'fast_lane', topic: 'Workplace' });
    expect(triage.output.reason).toMatch(/^The idea looks small/);
    // An English person in a German workspace gets the German analysis that everybody there reads.
    const deShort = await asUser(english(anna), deTenant, (ctx) => run(ctx, shortAnalysisCall(idea, [])));
    expect(deShort.output.sections[0].heading).toBe('Worum es geht');
  });

  it('sends the language rule to the model and logs the language', async () => {
    const calls: GenerateRequest[] = [];
    setProviderFactory(() => {
      const provider: ModelProvider = {
        async generate(req) {
          calls.push(req);
          return { json: { reply: 'Hello', asks: 'problem', fields: { title: null, problem: null, solution: null, benefit: null }, done: false }, inputTokens: 10, outputTokens: 10, servedBy: req.model, refused: false };
        },
      };
      return provider;
    });
    const external = (ctx: Ctx): Ctx => ({
      ...ctx,
      settings: {
        ...ctx.settings,
        ai: {
          ...ctx.settings.ai,
          providers: [...ctx.settings.ai.providers, { id: 'fake', name: 'Fake', kind: 'openai_compatible', baseUrl: 'https://model.example', hosting: 'eu', keySource: 'none' }],
          models: { ...ctx.settings.ai.models, fast: { provider: 'fake', model: 'fake-1' } },
        },
      },
    });
    const empty = { title: '', problem: '', solution: '', benefit: '' };
    await asUser(anna, deTenant, (ctx) => runAgent(external(ctx), { ...coachCall([], empty, false), evaluation: true }));
    await asUser(english(anna), deTenant, (ctx) => runAgent(external(ctx), { ...coachCall([], empty, false), evaluation: true }));
    expect(calls).toHaveLength(2);
    expect(calls[0].system).not.toContain('Output language');
    expect(calls[0].system).toContain('Schreibe auf Deutsch');
    expect(calls[1].system).toContain('Output language: English');
    const logged = await withSystem(async (c) => (await c.query<{ input: { locale?: string } }>(`SELECT input FROM ai_actions WHERE tenant_id = $1 AND provider = 'fake' ORDER BY created_at`, [deTenant])).rows);
    expect(logged.map((r) => r.input.locale ?? 'de').sort()).toEqual(['de', 'en']);
  });
});

describe('downloads in the language of the reader (R3-22)', () => {
  it('writes the business case CSV with English headings', () => {
    const items: Assumption[] = [
      { id: 'benefit', label: 'Benefit', unit: '€', kind: 'benefit', low: 100, base: 200, high: 300, sources: [] },
      { id: 'one_off', label: 'Setup', unit: '€', kind: 'one_off_cost', low: 50, base: 100, high: 150, sources: [] },
    ];
    const bc = computeBusinessCase(items, 3);
    expect(businessCaseCsv(items, bc)).toContain('Pessimistisch');
    const csv = businessCaseCsv(items, bc, 'en');
    expect(csv).toContain('Scenario;Benefit per year');
    expect(csv).toContain('Pessimistic');
    expect(csv).not.toMatch(/[äöüß]/);
  });
});

describe('AI gateway texts in the language of the reader (R3-22)', () => {
  it('names every AI building block and the provider templates in both languages', () => {
    for (const a of AGENTS) {
      expect(agentLabel('de', a)).not.toBe(a);
      expect(agentLabel('en', a)).not.toMatch(/[äöüß]/);
    }
    expect(agentLabel('en', 'coach')).toBe('Idea coach');
    for (const t of providerTemplates('en')) expect(`${t.name} ${t.note}`).not.toMatch(/[äöüß]|Eigene/);
  });

  it('resolves AI and provider errors in the language of the reader', () => {
    const err = new AiError(m('aigw.err.agentOff', { label: agentLabel('en', 'coach') }), 'AI_DISABLED');
    expect(errorText('en', err)).toBe('The AI building block “Idea coach” is switched off.');
    const provider = new ProviderError(m('aigw.err.providerError', { status: 503 }), true);
    expect(provider.message).toBe('Der Anbieter meldet einen Fehler (503).');
    expect(errorText('en', provider)).toBe('The provider reports an error (503).');
  });

  it('relocalizes stored German warnings, notes and job errors, and leaves other texts alone', () => {
    expect(relocalize('en', refText('aigw.warn.person'))).toBe('A statement about people was removed.');
    expect(relocalize('en', refText('aigw.note.noSource'))).toBe('No source, therefore not marked as proven.');
    expect(relocalize('en', refText('aigw.err.evalPending', { label: agentLabel('de', 'business_case') }))).toBe(
      'The quality check for “Business case” is still running. Please try again in a few minutes.',
    );
    expect(relocalize('en', agentLabel('de', 'competition'))).toBe('Competition and solution analysis');
    expect(relocalize('de', refText('aigw.warn.person'))).toBe(refText('aigw.warn.person'));
    expect(relocalize('en', 'Ein Text des Modells.')).toBe('Ein Text des Modells.');
    const job = `competition: ${refText('aigw.err.providerUnreachable', { host: 'api.example' })}\npatents: ${refText('aigw.err.refused')}`;
    expect(relocalizeLines('en', job)).toBe('competition: The provider at api.example cannot be reached.\npatents: The model refused the request.');
  });
});
