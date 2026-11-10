// Reference ideas for the effort estimate (R4-06): implemented ideas similar to a given idea,
// found with the same local embedding model as the duplicate check (R3-28). With pgvector the
// stored vectors are used; without it the candidates are compared in memory. Texts never leave
// the server. Only ideas the person may see, never confidential ones.
import { isTriageEverywhere, type Ctx } from '../lib/context.js';
import { VISIBLE_SQL } from '../services/workflow.js';
import { cosine, embeddingModel, ideaText, toVectorLiteral } from './embedding.js';
import { syncEmbeddings, vectorAvailable } from './similar.js';

export interface ReferenceIdea {
  id: string;
  number: number;
  title: string;
  ideaType: string;
  score: number;
  /** Effort in person days and euro: the actual effort when recorded, else the estimate. */
  personDays: number | null;
  euro: number | null;
  /** True when at least one of the two values is the recorded actual effort. */
  actual: boolean;
}

/** Minimum cosine similarity for a reference (a bit lower than for duplicates). */
export const REFERENCE_THRESHOLD = 0.2;
/** Candidates compared in memory when pgvector is not available. */
const MAX_CANDIDATES = 2000;

interface Row {
  id: string;
  number: number;
  title: string;
  problem: string;
  solution: string;
  idea_type: string;
  days: string | null;
  euro: string | null;
  actual: boolean;
  score?: number;
}

const COLUMNS = `i.id, i.number, i.title, i.problem, i.solution, i.idea_type,
  coalesce(im.actual_effort_person_days, i.effort_person_days) AS days,
  coalesce(im.actual_effort_euro, i.effort_euro) AS euro,
  (im.actual_effort_person_days IS NOT NULL OR im.actual_effort_euro IS NOT NULL) AS actual`;

const WHERE = `${VISIBLE_SQL} AND i.status = 'completed' AND NOT i.confidential AND i.id IS DISTINCT FROM $3
  AND (coalesce(im.actual_effort_person_days, i.effort_person_days) IS NOT NULL OR coalesce(im.actual_effort_euro, i.effort_euro) IS NOT NULL)`;

const toRef = (r: Row, score: number): ReferenceIdea => ({
  id: r.id,
  number: r.number,
  title: r.title,
  ideaType: r.idea_type,
  score: Math.round(score * 100) / 100,
  personDays: r.days == null ? null : Number(r.days),
  euro: r.euro == null ? null : Number(r.euro),
  actual: r.actual,
});

/** Up to `limit` completed ideas with effort, most similar first. */
export async function findReferences(
  ctx: Ctx,
  idea: { id: string; title: string; problem: string; solution: string },
  limit = 10,
): Promise<ReferenceIdea[]> {
  const base = [ctx.user!.id, isTriageEverywhere(ctx.user), idea.id];
  const model = embeddingModel();
  const [vector] = await model.embed([ideaText(idea)]);
  if (await vectorAvailable(ctx.db)) {
    // References are completed ideas, often older than the recent window: embed those that lack a vector.
    await syncEmbeddings(ctx.db, ctx.tenantId, 200, { completedOnly: true });
    await ctx.db.query("SELECT set_config('hnsw.ef_search', '200', true)");
    const r = await ctx.db.query<Row>(
      `SELECT * FROM (
         SELECT ${COLUMNS}, (1 - (e.embedding <=> $4::vector))::float AS score
           FROM idea_embeddings e JOIN ideas i ON i.id = e.idea_id JOIN implementations im ON im.idea_id = i.id AND im.status = 'done'
          WHERE e.model = $5 AND ${WHERE}
          ORDER BY e.embedding <=> $4::vector
          LIMIT $6
       ) s WHERE s.score >= $7`,
      [...base, toVectorLiteral(vector), model.id, limit, REFERENCE_THRESHOLD],
    );
    return r.rows.map((x) => toRef(x, Number(x.score)));
  }
  const r = await ctx.db.query<Row>(
    `SELECT ${COLUMNS} FROM ideas i JOIN implementations im ON im.idea_id = i.id AND im.status = 'done'
      WHERE ${WHERE} ORDER BY im.closed_at DESC NULLS LAST LIMIT ${MAX_CANDIDATES}`,
    base,
  );
  if (!r.rows.length) return [];
  const vectors = await model.embed(r.rows.map(ideaText));
  return r.rows
    .map((row, i) => ({ row, score: cosine(vector, vectors[i]) }))
    .filter((x) => x.score >= REFERENCE_THRESHOLD)
    .sort((a, b) => b.score - a.score || b.row.number - a.row.number)
    .slice(0, limit)
    .map((x) => toRef(x.row, x.score));
}
