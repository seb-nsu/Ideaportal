-- AP-08: AI quality and fairness (R2-44, R2-45, R2-46, R2-49).

-- Fairness between workspaces (R2-49): when a tenant last got a job started.
ALTER TABLE ai_jobs ADD COLUMN started_at timestamptz;
CREATE INDEX ai_jobs_started_idx ON ai_jobs (tenant_id, started_at DESC);

-- Skipped building blocks and skipped web searches are part of the AI log (R2-45).
ALTER TABLE ai_actions DROP CONSTRAINT IF EXISTS ai_actions_status_check;
ALTER TABLE ai_actions ADD CONSTRAINT ai_actions_status_check CHECK (status IN ('ok', 'error', 'blocked', 'budget', 'refused', 'skipped'));

-- Review status per AI building block (R2-44). No row means "ungeprüft".
CREATE TABLE ai_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  result_id uuid NOT NULL REFERENCES ai_results(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('checked', 'corrected')),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (result_id)
);

-- One-click rating "hilfreich?" (R2-44). The person is stored only so that each person
-- counts once; reports show aggregated figures only, never who rated.
CREATE TABLE ai_ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  result_id uuid NOT NULL REFERENCES ai_results(id) ON DELETE CASCADE,
  kind text NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  helpful boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (result_id, user_id)
);
CREATE INDEX ai_ratings_tenant ON ai_ratings (tenant_id, kind);

-- Shown and opened AI blocks for the expand rate (R2-44). Without person and without idea.
CREATE TABLE ai_usage_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind text NOT NULL,
  event text NOT NULL CHECK (event IN ('view', 'open')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_events_tenant ON ai_usage_events (tenant_id, created_at DESC);

-- Monthly sample of five results, rated by a mentor (R2-46).
CREATE TABLE ai_samples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  month text NOT NULL CHECK (month ~ '^\d{4}-\d{2}$'),
  result_id uuid NOT NULL REFERENCES ai_results(id) ON DELETE CASCADE,
  assignee_id uuid REFERENCES users(id) ON DELETE SET NULL,
  verdict text CHECK (verdict IN ('correct', 'minor', 'wrong')),
  note text,
  rated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, month, result_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_reviews', 'ai_ratings', 'ai_usage_events', 'ai_samples']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('CREATE POLICY owner_all ON %I TO %I USING (true) WITH CHECK (true)', t, current_user);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_reviews, ai_ratings, ai_samples TO ideenportal_app;
GRANT SELECT, INSERT, DELETE ON ai_usage_events TO ideenportal_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ideenportal_app;
