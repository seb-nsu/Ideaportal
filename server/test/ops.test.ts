import type { FastifyInstance } from 'fastify';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp, LOG_SERIALIZERS } from '../src/app.js';
import { drainAiJobs } from '../src/ai/worker.js';
import { config } from '../src/config.js';
import { closePool, withSystem, withTenant } from '../src/db/pool.js';
import { runAllJobs } from '../src/jobs/deadlines.js';
import type { SessionUser } from '../src/lib/context.js';
import { maskEmail } from '../src/services/mailer.js';
import { checkAlerts, setAlertSender, type AlertMessage } from '../src/services/ops.js';
import { client, createTenant, createUser, login, resetDb, validIdea } from './helpers.js';

// Operations and measurement (AP-03): health figures and alerts (R1-05), logs without idea
// content, throughput times per section with baseline and challenge report (R2-41).

let app: FastifyInstance;
let logs = '';
let tenant: string;
let other: string;
let users: Record<string, SessionUser>;
let api: Record<string, ReturnType<typeof client>>;
const MARKER = 'Zebrastreifen-Quokka-4711';

beforeAll(async () => {
  await resetDb();
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logs += chunk.toString();
      cb();
    },
  });
  app = await buildApp({ logStream: stream });
  tenant = await createTenant('betrieb');
  other = await createTenant('nachbar');
  users = {
    author: await createUser(tenant, 'autorin@betrieb.example', ['submitter']),
    triage: await createUser(tenant, 'triage@betrieb.example', ['submitter', 'triage']),
    admin: await createUser(tenant, 'admin@betrieb.example', ['submitter', 'admin', 'triage']),
    otherAdmin: await createUser(other, 'admin@nachbar.example', ['submitter', 'admin']),
  };
  api = {};
  for (const [k, u] of Object.entries(users)) api[k] = client(app, await login(app, k === 'otherAdmin' ? 'nachbar' : 'betrieb', u.email));
});

afterAll(async () => {
  config.metricsToken = undefined;
  setAlertSender(null);
  await app.close();
  await closePool();
});

// The figures of /api/health need the METRICS_TOKEN (enterprise security); publicly only the status.
const METRICS = 'metrics-token-for-the-ops-test-0123456789';
const health = async () => {
  config.metricsToken = METRICS;
  return (await app.inject({ method: 'GET', url: '/api/health', headers: { authorization: `Bearer ${METRICS}` } })).json();
};

describe('health figures and alerts (R1-05)', () => {
  it('reports job age, AI queue and outbox backlog', async () => {
    const before = await health();
    expect(before.status).toBe('ok');
    expect(before.jobs.lastRunAgeSeconds).toBeNull();
    await runAllJobs();
    await drainAiJobs();
    const after = await health();
    expect(after.jobs).toMatchObject({ lastRunOk: true });
    expect(after.jobs.lastRunAgeSeconds).toBeLessThan(60);
    expect(after.aiQueue).toMatchObject({ queued: 0, running: 0 });
    expect(after.outbox.pending).toBe(0);
    // Aggregated over all workspaces: no slugs, titles or names.
    expect(JSON.stringify(after)).not.toMatch(/betrieb|nachbar/);
  });

  it('raises an alert once, repeats nothing while it stays and sends the all-clear', async () => {
    const sent: AlertMessage[] = [];
    setAlertSender(async (m) => void sent.push(m));
    await withSystem((c) => c.query(`UPDATE job_heartbeats SET finished_at = now() - interval '3 hours' WHERE kind = 'jobs'`));
    const old = await withSystem(async (c) => {
      await c.query(`INSERT INTO ai_jobs (tenant_id, kind, created_at) VALUES ($1, 'eval_run', now() - interval '2 hours')`, [tenant]);
      return c.query(`INSERT INTO outbox (tenant_id, to_email, subject, body, created_at) VALUES ($1, 'x@betrieb.example', $2, 'b', now() - interval '3 hours') RETURNING id`, [tenant, MARKER]);
    });
    const h = await health();
    expect(h.status).toBe('degraded');
    expect(h.alerts).toEqual(expect.arrayContaining(['jobs_stale', 'ai_oldest', 'outbox_oldest']));

    const first = await checkAlerts();
    expect(first.raised.sort()).toEqual(['ai_oldest', 'jobs_stale', 'outbox_oldest']);
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe('raised');
    expect(sent[0].text).not.toContain(MARKER);
    expect((await checkAlerts()).raised).toEqual([]);
    expect(sent).toHaveLength(1);

    await withSystem(async (c) => {
      await c.query(`DELETE FROM ai_jobs WHERE kind = 'eval_run' AND status = 'queued'`);
      await c.query('UPDATE outbox SET sent_at = now() WHERE id = $1', [old.rows[0].id]);
    });
    await runAllJobs();
    const cleared = await checkAlerts();
    expect(cleared.cleared.sort()).toEqual(['ai_oldest', 'jobs_stale', 'outbox_oldest']);
    expect(sent[1].kind).toBe('cleared');
    expect((await health()).status).toBe('ok');
  });

  it('keeps heartbeats and alerts away from the app role', async () => {
    await expect(withTenant(tenant, (db) => db.query('SELECT * FROM job_heartbeats'))).rejects.toThrow();
    await expect(withTenant(tenant, (db) => db.query('SELECT * FROM ops_alerts'))).rejects.toThrow();
  });
});

describe('logs without idea content (R1-05)', () => {
  it('writes no title, text or search term of an idea into the log', async () => {
    const consoleLines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void consoleLines.push(args.join(' ')));
    try {
      const created = await api.author.post('/api/ideas', { ...validIdea, title: `Idee ${MARKER}`, problem: `${MARKER} im Lager stört alle seit Monaten.` });
      expect(created.status).toBe(201);
      expect((await api.author.post(`/api/ideas/${created.body.id}/submit`, { confirmNotReport: true })).status).toBe(200);
      await api.triage.get(`/api/ideas?q=${encodeURIComponent(MARKER)}`);
      await api.author.post(`/api/ideas/${created.body.id}/comments`, { body: `Kommentar ${MARKER}` });
      await api.author.post('/api/ideas', { ...validIdea, title: MARKER.repeat(20) }); // validation error
      await drainAiJobs();
      await runAllJobs(); // sends mails with the "log" transport
    } finally {
      spy.mockRestore();
    }
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain(MARKER);
    expect(consoleLines.join('\n')).not.toContain(MARKER);
    expect(consoleLines.join('\n')).not.toContain('autorin@');
  });

  it('masks quoted values in error messages and e-mail addresses in mail logs', () => {
    const err = Object.assign(new Error(`invalid input syntax for type uuid: "${MARKER}"`), { code: '22P02' });
    expect(LOG_SERIALIZERS.err(err).message).not.toContain(MARKER);
    expect(LOG_SERIALIZERS.req({ method: 'GET', url: `/api/ideas?q=${MARKER}` }).url).toBe('/api/ideas');
    expect(maskEmail('erika.mustermann@firma.de')).toBe('e***@firma.de');
  });
});

describe('throughput per section (R2-41)', () => {
  const ids: string[] = [];

  it('computes median and 90th percentile per section and month', async () => {
    for (let i = 0; i < 4; i++) {
      const c = await api.author.post('/api/ideas', { ...validIdea, title: `Durchlauf ${i + 1}` });
      ids.push(c.body.id);
      await api.author.post(`/api/ideas/${c.body.id}/submit`, { confirmNotReport: true });
      expect((await api.triage.post(`/api/ideas/${c.body.id}/triage`, { lane: 'reject', reason: 'Passt nicht in die Strategie.' })).status).toBe(200);
    }
    // Gate 1 took 2, 4, 6 and 8 days; drafts took 1 day each.
    await withSystem(async (c) => {
      for (let i = 0; i < ids.length; i++) {
        await c.query(
          `UPDATE ideas SET created_at = timestamptz '2026-09-01 08:00+00' - interval '1 day', submitted_at = timestamptz '2026-09-01 08:00+00' WHERE id = $1`,
          [ids[i]],
        );
        await c.query(`UPDATE decisions SET decided_at = timestamptz '2026-09-01 08:00+00' + make_interval(days => $2) WHERE idea_id = $1`, [ids[i], 2 * (i + 1)]);
      }
    });
    const d = (await api.admin.get('/api/dashboard?from=2026-08-01&to=2026-09-30')).body;
    const gate1 = d.throughput.find((t: { section: string }) => t.section === 'gate1');
    expect(gate1).toMatchObject({ count: 4, medianDays: 5, p90Days: 7.4 });
    expect(gate1.series).toEqual([{ month: '2026-09', count: 4, medianDays: 5 }]);
    const submission = d.throughput.find((t: { section: string }) => t.section === 'submission');
    expect(submission).toMatchObject({ count: 4, medianDays: 1 });
    expect(d.throughput.map((t: { section: string }) => t.section)).toEqual(['submission', 'gate1', 'gate2', 'implementation', 'gate3']);
  });

  it('shows the baseline from the settings and exports both', async () => {
    const s = (await api.admin.get('/api/admin/settings')).body;
    const put = await api.admin.put('/api/admin/settings', { ...s, baselines: { ...s.baselines, gate1: 21, note: 'Erhebung Juli 2026' } });
    expect(put.status).toBe(200);
    const d = (await api.admin.get('/api/dashboard?from=2026-08-01&to=2026-09-30')).body;
    expect(d.throughput.find((t: { section: string }) => t.section === 'gate1').baselineDays).toBe(21);
    expect(d.baselineNote).toBe('Erhebung Juli 2026');
    const csv = await app.inject({ method: 'GET', url: '/api/dashboard.csv?from=2026-08-01&to=2026-09-30', headers: { cookie: await login(app, 'betrieb', users.admin.email) } });
    expect(csv.body).toContain('Durchlaufzeit');
    expect(csv.body).toContain('2026-09');
  });

  it('reports challenges and hides participation below the minimum group size', async () => {
    const ch = await api.admin.post('/api/challenges', {
      title: 'Energie sparen im Lager', question: 'Wie senken wir den Stromverbrauch im Lager?', topic: null, contact: 'Innovation', startsOn: '2026-09-01', endsOn: '2026-12-31',
    });
    expect(ch.status).toBe(201);
    const idea = await api.author.post('/api/ideas', { ...validIdea, title: 'Bewegungsmelder im Lager', challengeId: ch.body.id });
    expect(idea.status).toBe(201);
    await api.author.post(`/api/ideas/${idea.body.id}/submit`, { confirmNotReport: true });
    const r = (await api.admin.get('/api/dashboard/challenges?from=2026-09-01&to=2026-12-31')).body;
    const line = r.items.find((x: { id: string }) => x.id === ch.body.id);
    expect(line).toMatchObject({ ideas: 1, participants: null, decided: 0, implemented: 0 });
    const csv = await app.inject({ method: 'GET', url: '/api/dashboard/challenges.csv?from=2026-09-01&to=2026-12-31', headers: { cookie: await login(app, 'betrieb', users.admin.email) } });
    expect(csv.body).toContain('Energie sparen im Lager');
    expect(csv.body).toContain('unter 5 Personen');
    expect((await api.author.get('/api/dashboard/challenges')).status).toBe(403);
  });

  it('counts only the own workspace', async () => {
    const d = (await api.otherAdmin.get('/api/dashboard?from=2026-08-01&to=2026-09-30')).body;
    expect(d.throughput.every((t: { count: number }) => t.count === 0)).toBe(true);
    expect((await api.otherAdmin.get('/api/dashboard/challenges?from=2026-01-01&to=2026-12-31')).body.items).toEqual([]);
  });
});
