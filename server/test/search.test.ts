import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, withSystem, withTenant } from '../src/db/pool.js';
import type { SessionUser } from '../src/lib/context.js';
import { cosine, hashedEmbedding } from '../src/search/embedding.js';
import { findSimilar, syncEmbeddings, vectorAvailable } from '../src/search/similar.js';
import { asUser, client, createTenant, createUser, login, resetDb, testApp, validIdea } from './helpers.js';

// Search and scale (R3-28, completes R1-19): full-text ranking, cursor pagination,
// tenant separation of search and duplicates, trigram fallback without pgvector.
// Runs with and without the extension: CI tests both images (postgres:16, pgvector/pgvector:pg16).

let app: FastifyInstance;
let tenantA: string;
let tenantB: string;
let users: Record<string, SessionUser>;
let api: Record<string, ReturnType<typeof client>>;
let vector = false;

beforeAll(async () => {
  await resetDb();
  app = await testApp();
  tenantA = await createTenant('such-a');
  tenantB = await createTenant('such-b');
  users = {
    mia: await createUser(tenantA, 'mia@a.example'),
    max: await createUser(tenantA, 'max@a.example'),
    triage: await createUser(tenantA, 'triage@a.example', ['submitter', 'triage']),
    bea: await createUser(tenantB, 'bea@b.example'),
  };
  api = {
    mia: client(app, await login(app, 'such-a', users.mia.email)),
    max: client(app, await login(app, 'such-a', users.max.email)),
    triage: client(app, await login(app, 'such-a', users.triage.email)),
    bea: client(app, await login(app, 'such-b', users.bea.email)),
  };
  vector = await withSystem((c) => vectorAvailable(c));
  // The CI job with the image pgvector/pgvector:pg16 must really test the semantic path.
  if (process.env.EXPECT_PGVECTOR === 'true') expect(vector).toBe(true);
});

afterAll(async () => {
  await app.close();
  await closePool();
});

async function submitted(by: string, extra: Record<string, unknown>): Promise<string> {
  const created = await api[by].post('/api/ideas', { ...validIdea, ...extra });
  expect(created.status).toBe(201);
  const sub = await api[by].post(`/api/ideas/${created.body.id}/submit`, { confirmNotReport: true });
  expect(sub.status).toBe(200);
  return created.body.id;
}

describe('local embedding model', () => {
  it('is deterministic, normalised and ranks paraphrases above unrelated texts', () => {
    const a = hashedEmbedding('Wartezeit an der Kantine verkürzen');
    expect(a).toHaveLength(256);
    expect(hashedEmbedding('Wartezeit an der Kantine verkürzen')).toEqual(a);
    expect(Math.abs(cosine(a, a) - 1)).toBeLessThan(1e-9);
    const close = hashedEmbedding('Lange Wartezeiten in der Kantine zur Mittagszeit');
    const far = hashedEmbedding('Solaranlage auf dem Dach des Lagers installieren');
    expect(cosine(a, close)).toBeGreaterThan(cosine(a, far) + 0.2);
  });
});

describe('full-text search (R3-28)', () => {
  let inTitle: string;
  let inSolution: string;
  beforeAll(async () => {
    inTitle = await submitted('mia', {
      title: 'Solaranlage auf dem Lagerdach',
      problem: 'Der Strom für das Lager ist teuer und kommt nicht aus erneuerbaren Quellen.',
      solution: 'Eine Photovoltaik-Anlage auf dem Dach liefert einen Teil des Bedarfs.',
    });
    inSolution = await submitted('max', {
      title: 'Energiekosten im Werk senken',
      problem: 'Die Energiekosten steigen jedes Jahr deutlich an und belasten das Budget.',
      solution: 'Prüfen, ob Solaranlagen auf den Hallen und LED-Beleuchtung sich lohnen.',
    });
    await submitted('max', {
      title: 'Kantine mit Vorbestellung',
      problem: 'Mittags stehen alle gleichzeitig an der Kantine und warten lange.',
      solution: 'Eine Vorbestellung per App mit festen Abholzeiten je Abteilung.',
    });
  });

  it('ranks title hits above hits in the solution and stems German words', async () => {
    const res = await api.mia.get(`/api/ideas?scope=all&q=${encodeURIComponent('Solaranlagen')}&limit=10`);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i: { id: string }) => i.id);
    expect(ids).toEqual([inTitle, inSolution]);
    expect(res.body.nextCursor).toBeNull();
  });

  it('supports websearch syntax (exclusion)', async () => {
    const res = await api.mia.get(`/api/ideas?scope=all&q=${encodeURIComponent('Solaranlage -Lager')}`);
    expect(res.body.map((i: { id: string }) => i.id)).toEqual([inSolution]);
  });

  it('keeps substring search for short terms and finds typos via trigrams', async () => {
    const short = await api.mia.get('/api/ideas?scope=all&q=Kant');
    expect(short.body.map((i: { title: string }) => i.title)).toEqual(['Kantine mit Vorbestellung']);
    const typo = await api.mia.get(`/api/ideas?scope=all&q=${encodeURIComponent('Vorbestelung')}`);
    expect(typo.body.map((i: { title: string }) => i.title)).toContain('Kantine mit Vorbestellung');
  });

  it('keeps the array response and the sort parameter for existing clients', async () => {
    const res = await api.mia.get('/api/ideas?scope=feed&sort=new');
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(3);
  });

  it('separates the search per tenant', async () => {
    await submitted('bea', { title: 'Solaranlage im Mandanten B', problem: 'Solaranlage fehlt bei uns komplett im Werk.', solution: 'Solaranlage auf das Dach bauen und betreiben.' });
    const a = await api.mia.get(`/api/ideas?scope=all&q=Solaranlage`);
    expect(a.body.map((i: { title: string }) => i.title)).not.toContain('Solaranlage im Mandanten B');
    const b = await api.bea.get(`/api/ideas?scope=all&q=Solaranlage`);
    expect(b.body.map((i: { title: string }) => i.title)).toEqual(['Solaranlage im Mandanten B']);
  });
});

describe('cursor pagination (R3-28)', () => {
  beforeAll(async () => {
    for (let n = 1; n <= 7; n++) {
      await submitted(n % 2 ? 'mia' : 'max', { title: `Seitenidee ${n} zum Blättern`, problem: `Problem Nummer ${n} beim Blättern durch lange Listen.` });
    }
  });

  async function all(url: string, by = 'mia'): Promise<{ id: string }[]> {
    const out: { id: string }[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const res = await api[by].get(`${url}&limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeLessThanOrEqual(3);
      out.push(...res.body.items);
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  it('returns every idea exactly once in the order of the unpaged list, for every sort', async () => {
    for (const sort of ['new', 'updated', 'supporters']) {
      const full = (await api.mia.get(`/api/ideas?scope=all&sort=${sort}`)).body.map((i: { id: string }) => i.id);
      const paged = (await all(`/api/ideas?scope=all&sort=${sort}`)).map((i) => i.id);
      expect(paged).toEqual(full);
      expect(new Set(paged).size).toBe(paged.length);
    }
    const rel = (await all(`/api/ideas?scope=all&q=Seitenidee`)).map((i) => i.id);
    expect(rel).toHaveLength(7);
    expect(new Set(rel).size).toBe(7);
  });

  it('stays stable when new ideas arrive between pages', async () => {
    const first = await api.mia.get('/api/ideas?scope=all&sort=new&limit=4');
    await submitted('max', { title: 'Neue Idee während des Blätterns' });
    const rest: { id: string }[] = [];
    let cursor = first.body.nextCursor as string | null;
    while (cursor) {
      const res = await api.mia.get(`/api/ideas?scope=all&sort=new&limit=4&cursor=${cursor}`);
      rest.push(...res.body.items);
      cursor = res.body.nextCursor;
    }
    const ids = [...first.body.items, ...rest].map((i: { id: string }) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(rest.map((i) => (i as unknown as { title: string }).title)).not.toContain('Neue Idee während des Blätterns');
  });

  it('rejects broken cursors and cursors of another sort order', async () => {
    expect((await api.mia.get('/api/ideas?scope=all&cursor=kaputt')).status).toBe(400);
    const first = await api.mia.get('/api/ideas?scope=all&sort=new&limit=2');
    expect((await api.mia.get(`/api/ideas?scope=all&sort=updated&cursor=${first.body.nextCursor}`)).status).toBe(400);
  });

  it('pages the triage board with counts per column', async () => {
    const full = (await api.triage.get('/api/triage/board')).body.map((i: { id: string }) => i.id);
    const paged: string[] = [];
    let cursor: string | null = null;
    let counts: Record<string, number> = {};
    do {
      const res: { body: { items: { id: string }[]; nextCursor: string | null; counts: Record<string, number> } } =
        await api.triage.get(`/api/triage/board?limit=4${cursor ? `&cursor=${cursor}` : ''}`);
      paged.push(...res.body.items.map((i) => i.id));
      counts = res.body.counts;
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(paged).toEqual(full);
    expect(counts.submitted).toBe(full.length);
  });
});

describe('duplicate check (R1-19, R3-28)', () => {
  let kantine: string;
  beforeAll(async () => {
    kantine = await submitted('mia', {
      title: 'Wartezeit an der Essensausgabe verkürzen',
      problem: 'Zur Mittagszeit gibt es an der Kantine lange Schlangen und Wartezeiten.',
      solution: 'Gestaffelte Pausen je Abteilung und eine zweite Essensausgabe.',
    });
    await submitted('bea', {
      title: 'Wartezeit an der Essensausgabe verkürzen',
      problem: 'Zur Mittagszeit gibt es an der Kantine lange Schlangen und Wartezeiten.',
      solution: 'Gestaffelte Pausen je Abteilung und eine zweite Essensausgabe.',
    });
  });

  it('finds similar ideas of the own tenant only, at most five', async () => {
    const res = await api.max.get(`/api/ideas/similar?text=${encodeURIComponent('Lange Schlangen an der Essensausgabe zur Mittagszeit')}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.length).toBeLessThanOrEqual(5);
    expect(res.body[0].id).toBe(kantine);
    const b = await api.bea.get(`/api/ideas/similar?text=${encodeURIComponent('Lange Schlangen an der Essensausgabe zur Mittagszeit')}`);
    expect(b.body.map((i: { id: string }) => i.id)).not.toContain(kantine);
    expect(b.body.length).toBe(1);
  });

  it('falls back to trigram similarity without pgvector', async () => {
    const r = await asUser(users.max, tenantA, (ctx) => findSimilar(ctx, 'Wartezeit an der Essensausgabe', { mode: 'trigram' }));
    expect(r.mode).toBe('trigram');
    expect(r.items.map((i) => i.id)).toContain(kantine);
    const auto = await asUser(users.max, tenantA, (ctx) => findSimilar(ctx, 'Wartezeit an der Essensausgabe'));
    expect(auto.mode).toBe(vector ? 'semantic' : 'trigram');
  });

  it('keeps embeddings per tenant (row-level security) and refreshes them after text changes', async () => {
    if (!vector) {
      // Without the extension the table exists with RLS but stays empty.
      expect(await asUser(null, tenantA, (ctx) => syncEmbeddings(ctx.db, tenantA))).toBe(0);
      await expect(withTenant(tenantA, (db) =>
        db.query("INSERT INTO idea_embeddings (idea_id, tenant_id, model, embedding) VALUES ($1, $2, 'x', '{0}')", [kantine, tenantB]),
      )).rejects.toThrow(/row-level security/);
      return;
    }
    await asUser(null, tenantA, (ctx) => syncEmbeddings(ctx.db, tenantA));
    await asUser(null, tenantB, (ctx) => syncEmbeddings(ctx.db, tenantB));
    const seenA = await withTenant(tenantA, async (db) => (await db.query<{ tenant_id: string }>('SELECT DISTINCT tenant_id FROM idea_embeddings')).rows);
    expect(seenA.map((r) => r.tenant_id)).toEqual([tenantA]);
    await expect(withTenant(tenantA, (db) =>
      db.query(`INSERT INTO idea_embeddings (idea_id, tenant_id, model, embedding) VALUES ($1, $2, 'x', $3::vector)`, [kantine, tenantB, `[${new Array(256).fill(0).join(',')}]`]),
    )).rejects.toThrow(/row-level security|duplicate key/);
    // A text change invalidates the stored vector (trigger), the next check recomputes it.
    await withSystem((c) => c.query("UPDATE ideas SET problem = problem || ' Neu.' WHERE id = $1", [kantine]));
    const left = await withSystem(async (c) => (await c.query('SELECT count(*)::int AS n FROM idea_embeddings WHERE idea_id = $1', [kantine])).rows[0].n);
    expect(left).toBe(0);
    const res = await asUser(users.max, tenantA, (ctx) => findSimilar(ctx, 'Lange Schlangen an der Essensausgabe zur Mittagszeit'));
    expect(res.mode).toBe('semantic');
    expect(res.items[0].id).toBe(kantine);
  });
});
