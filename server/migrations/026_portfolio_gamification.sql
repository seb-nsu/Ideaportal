-- AP-24: translations of ideas and comments (R3-30), gamification per challenge (R2-53) and the
-- public benchmark across workspaces (R3-40). Questions to the portfolio (R3-23) store nothing
-- besides the AI log.

-- Translation cache (R3-30): one row per idea or comment, target language and source text.
-- A changed source text has another hash, so an old translation is never shown for it.
CREATE TABLE translations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  comment_id uuid REFERENCES comments(id) ON DELETE CASCADE,
  target_locale text NOT NULL CHECK (target_locale ~ '^[a-z]{2}$'),
  source_hash text NOT NULL,
  source_language text,
  content jsonb NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  local boolean NOT NULL,
  ai_action_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX translations_key ON translations
  (idea_id, coalesce(comment_id, '00000000-0000-0000-0000-000000000000'::uuid), target_locale, source_hash);

-- Gamification per challenge (R2-53): the admin switches points and badges, and separately the
-- leaderboard, per challenge. Points are computed from submissions, comments and ratings; they
-- are not stored.
ALTER TABLE challenges
  ADD COLUMN gamification boolean NOT NULL DEFAULT true,
  ADD COLUMN leaderboard boolean NOT NULL DEFAULT true;

-- Consent of a person to appear on the leaderboard of one challenge (opt-in, revocable).
CREATE TABLE gamification_consents (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  challenge_id uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (challenge_id, user_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['translations', 'gamification_consents']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('CREATE POLICY owner_all ON %I TO %I USING (true) WITH CHECK (true)', t, current_user);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON translations, gamification_consents TO ideenportal_app;

-- Public benchmark (R3-40): platform data without tenant_id. One row per quarter with values
-- averaged over the consenting workspaces only; no value per workspace is stored. Only the owner
-- connection (job, public page) reads it.
CREATE TABLE benchmark_snapshots (
  quarter text PRIMARY KEY CHECK (quarter ~ '^\d{4}-Q[1-4]$'),
  period_from date NOT NULL,
  period_to date NOT NULL,
  -- Number of consenting workspaces, rounded down to a multiple of 5 (0 = fewer than 5).
  tenants_bucket int NOT NULL,
  kpis jsonb,
  computed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE benchmark_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE benchmark_snapshots FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  EXECUTE format('CREATE POLICY owner_all ON benchmark_snapshots TO %I USING (true) WITH CHECK (true)', current_user);
END $$;
REVOKE ALL ON benchmark_snapshots FROM ideenportal_app;
