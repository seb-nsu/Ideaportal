// Load test for R3-28: 10 000 ideas in a scratch tenant, latency of search, list pages, board and
// duplicate check through the full HTTP stack (Fastify inject, session, RLS).
// Usage (never against production):
//   DATABASE_URL=postgres://ideenportal:ideenportal@localhost:5432/ideenportal_load npm run loadtest --workspace server
// Options: IDEAS=10000 (count), RUNS=40 (requests per scenario), KEEP=1 (reuse existing scratch data).
import { performance } from 'node:perf_hooks';
import { buildApp } from '../app.js';
import { hashPassword } from '../lib/crypto.js';
import { syncEmbeddings, vectorAvailable } from '../search/similar.js';
import { migrate } from './migrate.js';
import { closePool, withSystem, withTenant } from './pool.js';

const SLUG = 'lasttest';
const IDEAS = Number(process.env.IDEAS ?? 10_000);
const RUNS = Number(process.env.RUNS ?? 40);
const PASSWORD = 'lasttest-passwort-123';

// Deterministic pseudo-random numbers, so every run builds the same data.
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];

const SUBJECTS = ['Kantine', 'Lager', 'Schichtplan', 'Rechnungsprüfung', 'Onboarding', 'Kundenservice', 'Solaranlage', 'Druckluft',
  'Ersatzteile', 'Reisekosten', 'Besprechungsräume', 'Parkplätze', 'Wissensdatenbank', 'Angebotserstellung', 'Retouren',
  'Wartung', 'Energieverbrauch', 'Papierformulare', 'Urlaubsplanung', 'Lieferantenportal', 'Abfalltrennung', 'Fuhrpark',
  'Schulungen', 'Intranet', 'Vertragsablage', 'Messeplanung', 'Qualitätsprüfung', 'Verpackung', 'Kühlung', 'Beleuchtung'];
const PROBLEMS = ['dauert zu lange und kostet jede Woche viele Stunden', 'ist unübersichtlich und führt zu Fehlern',
  'verursacht hohe Kosten ohne erkennbaren Nutzen', 'wird von vielen Teams doppelt gepflegt', 'ist für neue Kolleginnen schwer zu verstehen',
  'läuft noch mit Papier und E-Mails', 'führt regelmäßig zu Beschwerden von Kunden', 'verbraucht unnötig viel Energie'];
const SOLUTIONS = ['ein digitales Formular mit automatischer Prüfung', 'eine gemeinsame Übersicht für alle Standorte',
  'feste Zuständigkeiten und eine kurze Checkliste', 'eine App mit Benachrichtigung bei Änderungen', 'ein monatlicher Bericht mit Kennzahlen',
  'Sensoren und eine automatische Steuerung', 'eine Vorlage mit Beispielen und Schulung', 'ein Pilot in einem Werk mit anschließender Auswertung'];
const STATUSES: [string, number][] = [['completed', 30], ['rejected', 15], ['forwarded', 10], ['submitted', 15], ['in_question', 3],
  ['elaboration', 7], ['implementing', 8], ['fast_lane', 2], ['parked', 5], ['draft', 5]];
const TOPICS = ['Arbeitsumfeld', 'Prozesse', 'Kunden', 'Nachhaltigkeit', 'Digitalisierung'];

function status(): string {
  let x = rnd() * 100;
  for (const [s, w] of STATUSES) if ((x -= w) < 0) return s;
  return 'submitted';
}

async function prepare(): Promise<{ tenantId: string }> {
  await migrate(() => undefined);
  const existing = await withSystem(async (c) => (await c.query<{ id: string }>('SELECT id FROM tenants WHERE slug = $1', [SLUG])).rows[0]);
  if (existing && process.env.KEEP) return { tenantId: existing.id };
  const hash = await hashPassword(PASSWORD);
  return withSystem(async (c) => {
    if (existing) await c.query('DELETE FROM tenants WHERE id = $1', [existing.id]);
    const tenantId = (await c.query<{ id: string }>(
      "INSERT INTO tenants (slug, name, settings) VALUES ($1, 'Lasttest', $2) RETURNING id",
      [SLUG, JSON.stringify({ requireMfaForAdmins: false, topics: TOPICS })],
    )).rows[0].id;
    const users: string[] = [];
    for (let n = 0; n < 50; n++) {
      const roles = n === 0 ? ['submitter', 'triage'] : ['submitter'];
      users.push((await c.query<{ id: string }>(
        'INSERT INTO users (tenant_id, email, display_name, org_unit, roles, password_hash) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [tenantId, `person${n}@lasttest.example`, `Person ${n}`, `Team ${n % 7}`, roles, hash],
      )).rows[0].id);
    }
    const started = performance.now();
    for (let start = 0; start < IDEAS; start += 500) {
      const params: unknown[] = [tenantId];
      const rows: string[] = [];
      for (let n = start; n < Math.min(IDEAS, start + 500); n++) {
        const subject = pick(SUBJECTS);
        const st = status();
        const created = new Date(Date.UTC(2024, 0, 1) + Math.floor(rnd() * 900) * 86_400_000 + Math.floor(rnd() * 86_400_000));
        const values = [n + 1, `${subject}: ${pick(SOLUTIONS)}`, `${subject} ${pick(PROBLEMS)}. Das betrifft ${pick(SUBJECTS)} und ${pick(SUBJECTS)}.`,
          `Vorschlag: ${pick(SOLUTIONS)} für ${subject}.`, `Spart Zeit und Geld im Bereich ${subject}.`, pick(TOPICS), st, rnd() < 0.08,
          users[Math.floor(rnd() * users.length)], created.toISOString(), st === 'draft' ? null : created.toISOString()];
        const base = params.length;
        params.push(...values);
        rows.push(`($1, ${values.map((_, i) => `$${base + i + 1}`).join(', ')}, $${base + 10})`);
      }
      await c.query(
        `INSERT INTO ideas (tenant_id, number, title, problem, solution, benefit, topic, status, confidential, author_id, created_at, submitted_at, updated_at)
         VALUES ${rows.join(', ')}`,
        params,
      );
    }
    await c.query(
      `INSERT INTO deadlines (tenant_id, idea_id, phase, started_on, due_on)
       SELECT tenant_id, id, CASE WHEN status = 'elaboration' THEN 'elaboration' ELSE 'gate1' END,
              (now() - (number % 20) * interval '1 day')::date, (now() + ((number % 30) - 10) * interval '1 day')::date
         FROM ideas WHERE tenant_id = $1 AND status IN ('submitted', 'in_question', 'elaboration')`,
      [tenantId],
    );
    await c.query(
      `INSERT INTO supports (tenant_id, idea_id, user_id)
       SELECT i.tenant_id, i.id, u.id FROM ideas i JOIN users u ON u.tenant_id = i.tenant_id
        WHERE i.tenant_id = $1 AND i.status <> 'draft' AND (hashtext(i.id::text || u.id::text) % 13) = 0`,
      [tenantId],
    );
    await c.query('ANALYZE');
    console.log(`data: ${IDEAS} ideas in ${Math.round(performance.now() - started)} ms`);
    return { tenantId };
  });
}

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}

async function main(): Promise<void> {
  const { tenantId } = await prepare();
  const vector = await withSystem((c) => vectorAvailable(c));
  if (vector) {
    const t0 = performance.now();
    let total = 0;
    for (;;) {
      const n = await withTenant(tenantId, (db) => syncEmbeddings(db, tenantId, 2000));
      total += n;
      if (!n) break;
    }
    console.log(`embeddings: ${total} computed in ${Math.round(performance.now() - t0)} ms`);
    await withSystem((c) => c.query('ANALYZE idea_embeddings'));
  }
  const app = await buildApp({ logger: false });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenant: SLUG, email: 'person0@lasttest.example', password: PASSWORD } });
  if (login.statusCode !== 200) throw new Error(`login failed: ${login.body}`);
  const cookie = `ip_session=${login.cookies.find((c) => c.name === 'ip_session')!.value}`;
  const get = async (url: string) => {
    const t = performance.now();
    const res = await app.inject({ method: 'GET', url, headers: { cookie } });
    const ms = performance.now() - t;
    if (res.statusCode !== 200) throw new Error(`${url}: ${res.statusCode} ${res.body}`);
    return { ms, body: JSON.parse(res.body) };
  };
  const terms = ['Kantine', 'Solaranlage', 'Energieverbrauch senken', 'digitales Formular', 'Retouren Kunden', 'Schulung Onboarding',
    '"automatische Steuerung"', 'Fuhrpark -Parkplätze', 'Kühlung', 'Wissensdatenbank Intranet', 'Kantiene', 'Lgaer'];
  const dupTexts = ['Die Urlaubsplanung läuft noch mit Papier und E-Mails', 'Energieverbrauch der Beleuchtung im Lager senken',
    'Retouren führen zu Beschwerden von Kunden', 'Digitales Formular für Reisekosten mit Prüfung'];
  const scenarios: [string, (i: number) => Promise<number>][] = [
    ['Volltextsuche (Seite 1, 50 Treffer, Relevanz)', async (i) => (await get(`/api/ideas?scope=all&limit=50&q=${encodeURIComponent(terms[i % terms.length])}`)).ms],
    ['Ideenliste Seite 1 (50, neueste)', async () => (await get('/api/ideas?scope=all&sort=new&limit=50')).ms],
    ['Ideenliste Folgeseite per Cursor (Seite 2–21)', async () => {
      let r = await get('/api/ideas?scope=all&sort=new&limit=50');
      let total = 0;
      for (let p = 0; p < 20 && r.body.nextCursor; p++) {
        r = await get(`/api/ideas?scope=all&sort=new&limit=50&cursor=${r.body.nextCursor}`);
        total += r.ms;
      }
      return total / 20;
    }],
    ['Ideenliste Seite 1 (50, meiste Unterstützung)', async () => (await get('/api/ideas?scope=all&sort=supporters&limit=50')).ms],
    ['Ideenliste ohne limit (bisherige Antwort, 200)', async () => (await get('/api/ideas?scope=feed&sort=new')).ms],
    ['Board Seite 1 (100)', async () => (await get('/api/triage/board?limit=100')).ms],
    ['Board vollständig (ohne limit)', async () => (await get('/api/triage/board')).ms],
    [`Dublettenprüfung (${vector ? 'pgvector' : 'Trigramme'})`, async (i) => (await get(`/api/ideas/similar?text=${encodeURIComponent(dupTexts[i % dupTexts.length])}`)).ms],
  ];
  const counts = await withSystem(async (c) => (await c.query<{ ideas: number; board: number }>(
    `SELECT count(*)::int AS ideas,
            count(*) FILTER (WHERE status IN ('submitted', 'in_question', 'elaboration', 'fast_lane', 'implementing', 'piloting', 'integrated', 'parked'))::int AS board
       FROM ideas WHERE tenant_id = $1`, [tenantId])).rows[0]);
  const pg = await withSystem(async (c) => (await c.query<{ v: string }>('SELECT current_setting(\'server_version\') AS v')).rows[0].v);
  console.log(`\nIdeen: ${counts.ideas}, davon auf dem Board: ${counts.board}, PostgreSQL ${pg}, pgvector: ${vector ? 'ja' : 'nein'}, ${RUNS} Messungen je Szenario\n`);
  console.log('| Szenario | p50 (ms) | p95 (ms) |');
  console.log('| --- | ---: | ---: |');
  for (const [name, fn] of scenarios) {
    await fn(0); // warm-up
    const times: number[] = [];
    for (let i = 0; i < RUNS; i++) times.push(await fn(i));
    times.sort((a, b) => a - b);
    console.log(`| ${name} | ${quantile(times, 0.5).toFixed(1)} | ${quantile(times, 0.95).toFixed(1)} |`);
  }
  await app.close();
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error(err);
    await closePool();
    process.exit(1);
  });
