-- Search and scale (AP-14, R3-28, completes R1-19).
-- 1. Full-text index: generated tsvector with the German configuration plus 'simple' as fallback
--    (proper names, abbreviations, words the German stemmer handles badly). Weights: title A,
--    problem and solution B, benefit C.
-- 2. Sort indexes for cursor pagination.
-- 3. Semantic duplicates: table idea_embeddings per tenant (RLS). The column type becomes
--    vector(256) with an HNSW index only when the extension pgvector can be created. Without it the
--    table stays empty and the duplicate check keeps the trigram similarity (pg_trgm).

ALTER TABLE ideas ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('german'::regconfig, coalesce(title, '')), 'A') ||
  setweight(to_tsvector('simple'::regconfig, coalesce(title, '')), 'A') ||
  setweight(to_tsvector('german'::regconfig, coalesce(problem, '') || ' ' || coalesce(solution, '')), 'B') ||
  setweight(to_tsvector('simple'::regconfig, coalesce(problem, '') || ' ' || coalesce(solution, '')), 'B') ||
  setweight(to_tsvector('german'::regconfig, coalesce(benefit, '')), 'C')
) STORED;

CREATE INDEX ideas_search_fts ON ideas USING gin (search_vector);

-- Keyset pagination: (tenant, sort key, id). RLS adds tenant_id = current_tenant() to every query.
CREATE INDEX ideas_page_new ON ideas (tenant_id, (coalesce(submitted_at, created_at)) DESC, id DESC);
CREATE INDEX ideas_page_updated ON ideas (tenant_id, updated_at DESC, id DESC);
-- Lookups per idea that lists and the board run for every row (found in the load test).
CREATE INDEX IF NOT EXISTS deadlines_idea_open ON deadlines (idea_id, created_at DESC) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS comments_idea ON comments (idea_id);

-- Index access under row-level security: PostgreSQL uses a query condition as index condition
-- only if its operator is leakproof, which @@, ILIKE and the trigram operators are not. Queries of
-- ideenportal_app would therefore scan the whole table. These functions run as the owner, filter
-- explicitly by the tenant of the request (current_tenant(), the same setting RLS uses) and return
-- only ids and scores; the calling query joins them back to ideas under RLS and the visibility rules.
CREATE OR REPLACE FUNCTION search_idea_ids(term text, pattern text)
  RETURNS TABLE (idea_id uuid, rank float8)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.id, ts_rank(i.search_vector, q.query)::float8
    FROM ideas i,
         (SELECT websearch_to_tsquery('german'::regconfig, term) || websearch_to_tsquery('simple'::regconfig, term) AS query) q
   WHERE i.tenant_id = current_tenant()
     AND (i.search_vector @@ q.query OR (i.title || ' ' || i.problem || ' ' || i.solution) ILIKE pattern)
$$;

-- Word similarity (pg_trgm) for typos in the search and for the duplicate check without pgvector.
CREATE OR REPLACE FUNCTION similar_idea_ids(term text, threshold real)
  RETURNS TABLE (idea_id uuid, score float8)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM set_config('pg_trgm.word_similarity_threshold', threshold::text, true);
  RETURN QUERY
    SELECT i.id, word_similarity(term, i.title || ' ' || i.problem || ' ' || i.solution)::float8
      FROM ideas i
     WHERE i.tenant_id = current_tenant()
       AND term <% (i.title || ' ' || i.problem || ' ' || i.solution);
END $$;

REVOKE ALL ON FUNCTION search_idea_ids(text, text), similar_idea_ids(text, real) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION search_idea_ids(text, text), similar_idea_ids(text, real) TO ideenportal_app;

CREATE TABLE idea_embeddings (
  idea_id uuid PRIMARY KEY REFERENCES ideas(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  model text NOT NULL,
  -- real[] until pgvector is available; enable_vector_search() converts it to vector(256).
  embedding real[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idea_embeddings_tenant ON idea_embeddings (tenant_id);

ALTER TABLE idea_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE idea_embeddings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idea_embeddings USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
DO $$
BEGIN
  EXECUTE format('CREATE POLICY owner_all ON idea_embeddings TO %I USING (true) WITH CHECK (true)', current_user);
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON idea_embeddings TO ideenportal_app;

-- A changed text makes the stored embedding stale: delete it, the next duplicate check or job run
-- computes it again.
CREATE OR REPLACE FUNCTION idea_embedding_invalidate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.title IS DISTINCT FROM OLD.title OR NEW.problem IS DISTINCT FROM OLD.problem
     OR NEW.solution IS DISTINCT FROM OLD.solution THEN
    DELETE FROM idea_embeddings WHERE idea_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ideas_embedding_invalidate AFTER UPDATE OF title, problem, solution ON ideas
  FOR EACH ROW EXECUTE FUNCTION idea_embedding_invalidate();

-- Tries to create pgvector and switches the embedding column to vector(256) with an HNSW index.
-- Returns false when the extension is not installed or the database user may not create it
-- (managed Postgres without the extension, CI image postgres:16, non-superuser owner).
-- Runs here and again on every start (server/src/db/migrate.ts), so enabling the extension later
-- needs no new migration.
CREATE OR REPLACE FUNCTION enable_vector_search() RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  coltype text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
      RETURN false;
    END IF;
    BEGIN
      CREATE EXTENSION IF NOT EXISTS vector;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'pgvector not enabled (%), duplicate check uses trigram similarity', SQLERRM;
      RETURN false;
    END;
  END IF;
  SELECT format_type(atttypid, atttypmod) INTO coltype
    FROM pg_attribute WHERE attrelid = 'idea_embeddings'::regclass AND attname = 'embedding' AND NOT attisdropped;
  IF coltype IS DISTINCT FROM 'vector(256)' THEN
    -- Stored values of another type or dimension are recomputed lazily.
    DELETE FROM idea_embeddings;
    EXECUTE 'ALTER TABLE idea_embeddings ALTER COLUMN embedding TYPE vector(256) USING NULL';
  END IF;
  IF to_regclass('idea_embeddings_hnsw') IS NULL THEN
    EXECUTE 'CREATE INDEX idea_embeddings_hnsw ON idea_embeddings USING hnsw (embedding vector_cosine_ops)';
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION enable_vector_search() FROM PUBLIC;

SELECT enable_vector_search();
