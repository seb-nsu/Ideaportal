import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureAllTenantKeys, migrate } from '../src/db/migrate.js';
import { closePool, withSystem, withTenant } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/crypto.js';
import { isSealed } from '../src/lib/secretbox.js';
import { client, login, PASSWORD } from './helpers.js';

// Upgrade test (docs/enterprise/qualitaet-und-lieferkette.md): a database in the state of the
// last release is filled with data of two tenants, then every later migration is applied the
// way a deployment does it (migrate() on start). The data must survive, row-level security must
// still separate the tenants and the app must work on the upgraded data.
//
// When a release is cut, bump PREVIOUS_RELEASE_MIGRATION to the last migration file of that
// release. The test works with any number of later migrations.
export const PREVIOUS_RELEASE_MIGRATION = '030_learning.sql';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const TOTP_PLAIN = 'JBSWY3DPEHPK3PXP';

let files: string[];
let later: string[];
let app: FastifyInstance;
const ids: Record<string, string> = {};

/** Applies the migrations up to and including the release boundary, like the release's migrate(). */
async function migrateToRelease(): Promise<void> {
  await withSystem(async (c) => {
    await c.query('DROP SCHEMA public CASCADE');
    await c.query('CREATE SCHEMA public');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const file of files.filter((f) => f <= PREVIOUS_RELEASE_MIGRATION)) {
      await c.query(await readFile(path.join(migrationsDir, file), 'utf8'));
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    }
  });
}

/** Representative data of the release, written with plain SQL against the release schema. */
async function fillReleaseData(): Promise<void> {
  const hash = await hashPassword(PASSWORD);
  await withSystem(async (c) => {
    for (const slug of ['upgrade-a', 'upgrade-b']) {
      const t = (
        await c.query<{ id: string }>('INSERT INTO tenants (slug, name, settings) VALUES ($1, $2, $3) RETURNING id', [
          slug,
          `Mandant ${slug}`,
          JSON.stringify({ requireMfaForAdmins: false, topics: ['Arbeitsumfeld', 'Kunden'] }),
        ])
      ).rows[0].id;
      ids[slug] = t;
      const admin = (
        await c.query<{ id: string }>(
          `INSERT INTO users (tenant_id, email, display_name, org_unit, roles, password_hash) VALUES ($1, $2, 'Admin', 'Innovation', $3, $4) RETURNING id`,
          [t, `admin@${slug}.example`, ['submitter', 'admin', 'triage'], hash],
        )
      ).rows[0].id;
      const author = (
        await c.query<{ id: string }>(
          `INSERT INTO users (tenant_id, email, display_name, org_unit, roles, password_hash, mfa_secret) VALUES ($1, $2, 'Autorin', 'Vertrieb', $3, $4, $5) RETURNING id`,
          [t, `autorin@${slug}.example`, ['submitter'], hash, TOTP_PLAIN],
        )
      ).rows[0].id;
      ids[`${slug}:author`] = author;
      const challenge = (
        await c.query<{ id: string }>(
          `INSERT INTO challenges (tenant_id, title, question, contact, starts_on, ends_on) VALUES ($1, 'Weniger Papier', 'Wo sparen wir Papier?', 'Team Innovation', '2026-01-01', '2099-12-31') RETURNING id`,
          [t],
        )
      ).rows[0].id;
      for (let n = 1; n <= 3; n++) {
        const idea = (
          await c.query<{ id: string }>(
            `INSERT INTO ideas (tenant_id, number, title, problem, solution, benefit, topic, status, author_id, challenge_id, submitted_at)
           VALUES ($1, $2, $3, 'Problem', 'Lösung', 'Nutzen', 'Arbeitsumfeld', $4, $5, $6, now()) RETURNING id`,
            [t, n, `Idee ${n} von ${slug} – Umlaute äöü €`, n === 1 ? 'draft' : 'submitted', author, n === 3 ? challenge : null],
          )
        ).rows[0].id;
        ids[`${slug}:idea${n}`] = idea;
        await c.query(`INSERT INTO idea_events (tenant_id, idea_id, actor_id, kind, to_status) VALUES ($1, $2, $3, 'created', 'draft')`, [t, idea, author]);
        await c.query(`INSERT INTO comments (tenant_id, idea_id, author_id, body) VALUES ($1, $2, $3, $4)`, [t, idea, admin, `Kommentar zu ${n}`]);
      }
      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_id, action, entity, entity_id, after) VALUES ($1, $2, 'tenant.create', 'tenant', $3, '{"via":"upgrade-test"}')`,
        [t, admin, t],
      );
    }
    // Post-migration steps the release ran on start: data key per tenant (R3-01).
    await ensureAllTenantKeys(c);
  });
}

async function counts(): Promise<Record<string, number>> {
  return withSystem(async (c) => {
    const out: Record<string, number> = {};
    for (const table of ['tenants', 'users', 'challenges', 'ideas', 'idea_events', 'comments', 'audit_log', 'tenant_keys']) {
      out[table] = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
    }
    return out;
  });
}

let before: Record<string, number>;

beforeAll(async () => {
  files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  later = files.filter((f) => f > PREVIOUS_RELEASE_MIGRATION);
  await migrateToRelease();
  await fillReleaseData();
  before = await counts();
  // The upgrade itself: exactly what the server does on start.
  await migrate(() => undefined);
  app = await buildApp({ logger: false });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await closePool();
});

describe(`upgrade from the last release (${PREVIOUS_RELEASE_MIGRATION})`, () => {
  it('the release boundary exists and every migration is recorded after the upgrade', async () => {
    expect(files).toContain(PREVIOUS_RELEASE_MIGRATION);
    const applied = await withSystem(async (c) =>
      (await c.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name),
    );
    expect(applied).toEqual(files);
    // Later migrations may be none (right after a release); then the test checks the restart path.
    expect(later.every((f) => applied.includes(f))).toBe(true);
  });

  it('keeps every row and every value', async () => {
    const after = await counts();
    // Later migrations may add rows (e.g. defaults per tenant) but must never lose any.
    for (const [table, n] of Object.entries(before)) expect(after[table], table).toBeGreaterThanOrEqual(n);
    expect(after.ideas).toBe(before.ideas);
    expect(after.comments).toBe(before.comments);
    const idea = await withSystem(
      async (c) => (await c.query('SELECT title, problem, solution, benefit, status, challenge_id FROM ideas WHERE id = $1', [ids['upgrade-a:idea3']])).rows[0],
    );
    expect(idea).toEqual({
      title: 'Idee 3 von upgrade-a – Umlaute äöü €',
      problem: 'Problem',
      solution: 'Lösung',
      benefit: 'Nutzen',
      status: 'submitted',
      challenge_id: expect.any(String),
    });
  });

  it('runs the data migrations on start: legacy TOTP secrets are encrypted', async () => {
    const secret = await withSystem(
      async (c) => (await c.query<{ mfa_secret: string }>('SELECT mfa_secret FROM users WHERE id = $1', [ids['upgrade-a:author']])).rows[0].mfa_secret,
    );
    expect(secret).not.toBe(TOTP_PLAIN);
    expect(isSealed(secret)).toBe(true);
  });

  it('row-level security still separates the tenants', async () => {
    const seenByA = await withTenant(ids['upgrade-a'], async (db) => (await db.query<{ id: string }>('SELECT id FROM ideas')).rows.map((r) => r.id));
    expect(seenByA.sort()).toEqual([ids['upgrade-a:idea1'], ids['upgrade-a:idea2'], ids['upgrade-a:idea3']].sort());
    const crossRead = await withTenant(
      ids['upgrade-a'],
      async (db) => (await db.query('SELECT 1 FROM comments WHERE idea_id = $1', [ids['upgrade-b:idea1']])).rowCount,
    );
    expect(crossRead).toBe(0);
    await expect(
      withTenant(ids['upgrade-a'], (db) =>
        db.query(`INSERT INTO comments (tenant_id, idea_id, author_id, body) VALUES ($1, $2, $3, 'x')`, [
          ids['upgrade-b'],
          ids['upgrade-b:idea1'],
          ids['upgrade-b:author'],
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('the app works on the upgraded data', async () => {
    const api = client(app, await login(app, 'upgrade-a', 'autorin@upgrade-a.example'));
    const list = await api.get('/api/ideas');
    expect(list.status).toBe(200);
    const items = (Array.isArray(list.body) ? list.body : list.body.items) as { id: string }[];
    expect(items.map((i) => i.id)).toEqual(expect.arrayContaining([ids['upgrade-a:idea2'], ids['upgrade-a:idea3']]));
    expect(items.some((i) => i.id === ids['upgrade-b:idea2'])).toBe(false);
    const detail = await api.get(`/api/ideas/${ids['upgrade-a:idea2']}`);
    expect(detail.status).toBe(200);
    expect((await api.get(`/api/ideas/${ids['upgrade-b:idea2']}`)).status).toBe(404);
  });

  it('a second start applies nothing (idempotent)', async () => {
    const log: string[] = [];
    await migrate((msg) => log.push(msg));
    expect(log.filter((l) => l.startsWith('migration applied'))).toEqual([]);
  });
});
