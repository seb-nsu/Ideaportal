// Duplicate check (R1-19, R3-28): semantic similarity with pgvector when the extension is enabled,
// otherwise the trigram similarity of pg_trgm. Both run on the tenant-scoped connection, so
// row-level security keeps the index of each tenant separate.
import type { Db } from '../db/pool.js';
import { isTriage, isTriageEverywhere, type Ctx } from '../lib/context.js';
import { VISIBLE_SQL } from '../services/workflow.js';
import { embeddingModel, ideaText, toVectorLiteral } from './embedding.js';

export interface SimilarIdea {
  id: string;
  number: number;
  title: string;
  status: string;
  score: number;
}

export type SimilarMode = 'auto' | 'semantic' | 'trigram';

/** Minimum cosine similarity of the built-in model that counts as "similar". */
export const SEMANTIC_THRESHOLD = 0.3;
/** Ideas embedded on the fly per duplicate check; the background job catches up with the rest. */
const SYNC_PER_REQUEST = 200;

/** True when pgvector is installed in this database and the embedding column uses it. */
export async function vectorAvailable(db: Db): Promise<boolean> {
  const r = await db.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
        WHERE a.attrelid = to_regclass('idea_embeddings') AND a.attname = 'embedding' AND t.typname = 'vector'
     ) AS ok`,
  );
  return r.rows[0].ok;
}

/**
 * Computes missing or stale embeddings of the tenant (submitted, not confidential ideas only).
 * Returns the number of ideas embedded. Does nothing without pgvector. recentOnly limits the
 * check to ideas changed in the last two days (cheap enough for every duplicate check); the
 * background job runs the full check.
 */
export async function syncEmbeddings(db: Db, tenantId: string, limit = 1000, opts: { recentOnly?: boolean; completedOnly?: boolean } = {}): Promise<number> {
  if (!(await vectorAvailable(db))) return 0;
  const model = embeddingModel();
  const r = await db.query<{ id: string; title: string; problem: string; solution: string }>(
    `SELECT i.id, i.title, i.problem, i.solution FROM ideas i
       LEFT JOIN idea_embeddings e ON e.idea_id = i.id AND e.model = $1
      WHERE e.idea_id IS NULL AND i.status NOT IN ('draft', 'merged') AND NOT i.confidential
        ${opts.recentOnly ? "AND i.updated_at > now() - interval '2 days'" : ''}
        ${opts.completedOnly ? "AND i.status = 'completed'" : ''}
      ORDER BY i.number LIMIT $2`,
    [model.id, limit],
  );
  if (!r.rows.length) return 0;
  const vectors = await model.embed(r.rows.map(ideaText));
  // One statement per batch keeps the round trips low for large backfills.
  for (let start = 0; start < r.rows.length; start += 200) {
    const rows = r.rows.slice(start, start + 200);
    const params: unknown[] = [tenantId, model.id];
    const values = rows.map((row, i) => {
      params.push(row.id, toVectorLiteral(vectors[start + i]));
      return `($${params.length - 1}::uuid, $1::uuid, $2, $${params.length}::vector)`;
    });
    await db.query(
      `INSERT INTO idea_embeddings (idea_id, tenant_id, model, embedding) VALUES ${values.join(', ')}
       ON CONFLICT (idea_id) DO UPDATE SET model = EXCLUDED.model, embedding = EXCLUDED.embedding, created_at = now()`,
      params,
    );
  }
  return r.rows.length;
}

/**
 * Up to `limit` visible, submitted, non-confidential ideas similar to `text`.
 * mode 'auto' uses pgvector when available and falls back to trigrams otherwise.
 */
export async function findSimilar(
  ctx: Ctx,
  text: string,
  opts: { exclude?: string | null; limit?: number; mode?: SimilarMode } = {},
): Promise<{ mode: 'semantic' | 'trigram'; items: SimilarIdea[] }> {
  const limit = opts.limit ?? 5;
  const want = opts.mode ?? 'auto';
  const semantic = want !== 'trigram' && (await vectorAvailable(ctx.db));
  const base = [ctx.user!.id, isTriageEverywhere(ctx.user), opts.exclude ?? null];
  if (semantic) {
    await syncEmbeddings(ctx.db, ctx.tenantId, SYNC_PER_REQUEST, { recentOnly: true });
    const model = embeddingModel();
    const [vector] = await model.embed([text]);
    // The HNSW index returns ef_search candidates before RLS and visibility filter them;
    // a larger candidate list keeps five results available in workspaces sharing the index.
    await ctx.db.query("SELECT set_config('hnsw.ef_search', '200', true)");
    const r = await ctx.db.query<SimilarIdea>(
      `SELECT * FROM (
         SELECT i.id, i.number, i.title, i.status, round((1 - (e.embedding <=> $4::vector))::numeric, 2)::float AS score
           FROM idea_embeddings e JOIN ideas i ON i.id = e.idea_id
          WHERE e.model = $5 AND ${VISIBLE_SQL} AND i.status NOT IN ('draft', 'merged') AND NOT i.confidential
            AND i.id IS DISTINCT FROM $3
          ORDER BY e.embedding <=> $4::vector
          LIMIT $6
       ) s WHERE s.score >= $7`,
      [...base, toVectorLiteral(vector), model.id, limit, SEMANTIC_THRESHOLD],
    );
    return { mode: 'semantic', items: r.rows };
  }
  // Trigram fallback (behaviour of Release 1: word similarity above 0.3), computed in
  // similar_idea_ids so the trigram index works under row-level security (migration 017).
  const r = await ctx.db.query<SimilarIdea>(
    `SELECT i.id, i.number, i.title, i.status, round(t.score::numeric, 2)::float AS score
       FROM similar_idea_ids($4, 0.3) t JOIN ideas i ON i.id = t.idea_id
      WHERE ${VISIBLE_SQL} AND i.status NOT IN ('draft', 'merged') AND NOT i.confidential AND i.id IS DISTINCT FROM $3
      ORDER BY t.score DESC, i.number DESC LIMIT $5`,
    [...base, text, limit],
  );
  return { mode: 'trigram', items: r.rows };
}
