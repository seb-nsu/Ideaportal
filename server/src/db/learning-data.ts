import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, withSystem, type Db } from './pool.js';

// Test data for AP-28 (R4-04, R4-06, R4-07): closed ideas with planned and actual benefit,
// estimated and actual effort, idea type and kind. Real workspaces do not have 20 closed ideas
// yet; the product owner decided that the learning features are built and tested with such
// data. Used by the tests and, on request, for a demo or pilot workspace:
//
//   npm run seed:learning -w server -- <slug> [count]
//
// The generator is deterministic (same seed, same data) and marks every idea as test data in
// the benefit text and the evidence, so it can be found and deleted again.

export interface LearningDataOptions {
  /** Number of closed ideas (default 24). */
  count?: number;
  /** Author and implementation owner; default: the first admin (else any active person) of the workspace. */
  authorId?: string;
  /** Day of the last closing; the ideas are spread over the four quarters before it. */
  today?: string;
  seed?: number;
  /** Only ideas of this type (default: alternating internal and product). */
  ideaType?: 'internal' | 'product';
}

export const TEST_DATA_MARK = 'Testdaten (AP-28)';

/** Clusters of similar ideas, so that the effort estimate finds references. */
export const LEARNING_CLUSTERS = [
  {
    title: 'Rechnungseingang automatisch erfassen',
    problem: 'Eingangsrechnungen werden von Hand abgetippt und geprüft. Das kostet Zeit und führt zu Tippfehlern bei Rechnungsnummer und Betrag.',
    solution: 'Rechnungen per Texterkennung auslesen, mit der Bestellung abgleichen und nur Abweichungen zur Prüfung vorlegen.',
  },
  {
    title: 'Wartezeit in der Kundenhotline verkürzen',
    problem: 'Anrufende warten in der Kundenhotline oft lange, weil einfache Fragen dieselben Leitungen belegen wie schwierige Fälle.',
    solution: 'Einfache Fragen zur Kundenhotline über einen Rückrufdienst und Antworten im Kundenportal abfangen.',
  },
  {
    title: 'Ersatzteilbestellung in der Instandhaltung digitalisieren',
    problem: 'Ersatzteile für die Instandhaltung werden per Papierformular bestellt. Bestellungen gehen verloren und Maschinen stehen still.',
    solution: 'Ersatzteile direkt an der Maschine per Tablet bestellen, mit Lagerbestand und Freigabe in einem Schritt.',
  },
  {
    title: 'Onboarding neuer Mitarbeitender vereinfachen',
    problem: 'Neue Mitarbeitende warten in der ersten Woche auf Laptop, Zugänge und Ansprechpersonen.',
    solution: 'Eine Onboarding-Checkliste mit festen Terminen für Laptop, Zugänge und Patenschaft vor dem ersten Arbeitstag.',
  },
] as const;

/** Small deterministic random generator (mulberry32). */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * Creates closed ideas (status completed, implementation done, Gate 3 recorded and confirmed)
 * on the owner connection. Returns the ids of the new ideas.
 */
export async function seedLearningData(db: Db, tenantId: string, opts: LearningDataOptions = {}): Promise<string[]> {
  const count = opts.count ?? 24;
  const rnd = random(opts.seed ?? 4711);
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const authorId = opts.authorId ?? (await db.query<{ id: string }>(
    `SELECT id FROM users WHERE tenant_id = $1 AND active AND NOT coalesce(technical, false)
      ORDER BY ('admin' = ANY(roles)) DESC, created_at LIMIT 1`,
    [tenantId],
  )).rows[0]?.id;
  if (!authorId) throw new Error('no person in this workspace');
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [tenantId]);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const cluster = LEARNING_CLUSTERS[i % LEARNING_CLUSTERS.length];
    const ideaType = opts.ideaType ?? (i % 2 === 0 ? 'internal' : 'product');
    const ideaKind = i % 3 === 2 ? 'problem' : 'idea';
    // Forecast 10.000 to 120.000 euro; internal ideas reach 60-110 %, product ideas 40-130 %.
    const plan = Math.round((10 + rnd() * 110)) * 1000;
    const ratio = ideaType === 'internal' ? 0.6 + rnd() * 0.5 : 0.4 + rnd() * 0.9;
    const actual = Math.round((plan * ratio) / 100) * 100;
    const estDays = Math.round(5 + rnd() * 40);
    const actDays = Math.round(estDays * (1.05 + rnd() * 0.5));
    const closedOn = addDays(today, -Math.round(5 + (i / count) * 360));
    const created = addDays(closedOn, -120);
    const idea = (await db.query<{ id: string }>(
      `INSERT INTO ideas (tenant_id, number, title, problem, solution, benefit, topic, idea_type, idea_kind, status, lane, author_id,
                          created_at, submitted_at, updated_at, effort_person_days, effort_euro, plan_benefit_euro, horizon)
       VALUES ($1, (SELECT coalesce(max(number), 0) + 1 FROM ideas WHERE tenant_id = $1), $2, $3, $4, $5, NULL, $6, $7, 'completed', 'elaborate', $8,
               $9::date, $9::date, $10::date, $11, $12, $13, 1)
       RETURNING id`,
      [tenantId, `${cluster.title} (${TEST_DATA_MARK} ${i + 1})`, cluster.problem, cluster.solution, TEST_DATA_MARK, ideaType, ideaKind, authorId,
       created, closedOn, estDays, estDays * 800, plan],
    )).rows[0];
    await db.query(
      `INSERT INTO implementations (tenant_id, idea_id, owner_id, channel, target_date, progress, status, accepted_at, benefit_kind, benefit_value,
                                    benefit_evidence, closed_at, actual_effort_person_days, actual_effort_euro)
       VALUES ($1, $2, $3, 'project', $4, 100, 'done', $5::date, 'euro', $6, $7, $4::date + time '12:00', $8, $9)`,
      [tenantId, idea.id, authorId, closedOn, created, actual, TEST_DATA_MARK, actDays, actDays * 800],
    );
    await db.query(
      `INSERT INTO impact_reviews (tenant_id, idea_id, reviewer_id, due_on, plan_value, actual_value, outcome, notes, done_at, confirmed_by, confirmed_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'close', $7, $4::date + time '12:00', $3, $4::date + time '12:00')`,
      [tenantId, idea.id, authorId, closedOn, plan, actual, TEST_DATA_MARK],
    );
    await db.query(
      `INSERT INTO idea_events (tenant_id, idea_id, actor_id, kind, from_status, to_status, message) VALUES ($1, $2, NULL, 'completed', 'implementing', 'completed', $3)`,
      [tenantId, idea.id, TEST_DATA_MARK],
    );
    ids.push(idea.id);
  }
  return ids;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [slug, n] = process.argv.slice(2);
  const run = async () => {
    if (!slug) {
      console.error('usage: seed:learning <slug> [count]');
      process.exitCode = 2;
      return;
    }
    const ids = await withSystem(async (c) => {
      const t = (await c.query<{ id: string }>('SELECT id FROM tenants WHERE slug = $1', [slug])).rows[0];
      if (!t) return null;
      return seedLearningData(c, t.id, { count: n ? Math.max(1, Number(n)) : 24 });
    });
    console.log(ids ? `${ids.length} closed test ideas created in ${slug}` : `workspace ${slug} not found`);
    if (!ids) process.exitCode = 1;
  };
  run().finally(() => closePool());
}
