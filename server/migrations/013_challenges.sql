-- AP-09: challenge phases with templates (R2-52) and crowd rating by fixed criteria (R2-51).

-- Phase plan: start dates of the phases collect, rate, elaborate, jury and result (R2-52).
-- NULL = challenge without phases (behaviour as in R1-34). The current phase is set by the
-- deadline job; NULL with a plan means "not started yet".
ALTER TABLE challenges ADD COLUMN phase_plan jsonb;
ALTER TABLE challenges ADD COLUMN phase text CHECK (phase IN ('collect', 'rate', 'elaborate', 'jury', 'result'));
ALTER TABLE challenges ADD COLUMN phase_changed_at timestamptz;
ALTER TABLE challenges ADD COLUMN template text;
-- Criteria of the crowd rating (R2-51): [{id, label}], scale 1 to 5. Empty = default criteria.
ALTER TABLE challenges ADD COLUMN rating_criteria jsonb NOT NULL DEFAULT '[]'::jsonb;

-- One rating per person and idea (R2-51). The person is stored only to keep it unique and
-- changeable; the API never returns who rated what, only aggregates from the minimum group size.
CREATE TABLE challenge_ratings (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  challenge_id uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scores jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (idea_id, user_id)
);
CREATE INDEX challenge_ratings_challenge ON challenge_ratings (challenge_id);

ALTER TABLE challenge_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE challenge_ratings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON challenge_ratings USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
DO $$
BEGIN
  EXECUTE format('CREATE POLICY owner_all ON challenge_ratings TO %I USING (true) WITH CHECK (true)', current_user);
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON challenge_ratings TO ideenportal_app;
