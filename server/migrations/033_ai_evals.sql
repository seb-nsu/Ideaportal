-- KI-Evals und Transparenz (R2-12, Enterprise): prompt version and fallback model per AI action,
-- per-case results of evaluation runs and the comparison with the previous run.

-- Prompt version of the agent (hash of system text, schema and prompt template) and the model
-- that actually answered when a server-side fallback ran; model_checked says whether that model
-- passed the test set for the agent (false = "unchecked model").
ALTER TABLE ai_actions ADD COLUMN prompt_version text;
ALTER TABLE ai_actions ADD COLUMN served_by text;
ALTER TABLE ai_actions ADD COLUMN model_checked boolean;

-- Run metadata for reports and the regression check.
ALTER TABLE ai_eval_runs ADD COLUMN testset_version int;
ALTER TABLE ai_eval_runs ADD COLUMN prompt_versions jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE ai_eval_runs ADD COLUMN previous_run_id uuid REFERENCES ai_eval_runs(id) ON DELETE SET NULL;
ALTER TABLE ai_eval_runs ADD COLUMN comparison jsonb;

-- Score per agent and test case of a run (deterministic score, optional judge score, failed checks).
CREATE TABLE ai_eval_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES ai_eval_runs(id) ON DELETE CASCADE,
  agent text NOT NULL,
  case_id text NOT NULL,
  score numeric NOT NULL CHECK (score >= 0 AND score <= 1),
  deterministic numeric NOT NULL CHECK (deterministic >= 0 AND deterministic <= 1),
  judge numeric CHECK (judge >= 0 AND judge <= 1),
  failed jsonb NOT NULL DEFAULT '[]'::jsonb,
  checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  note text,
  blocked boolean NOT NULL DEFAULT false,
  served_by text,
  cost_eur numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, agent, case_id)
);
CREATE INDEX ai_eval_cases_run ON ai_eval_cases (run_id, agent);

ALTER TABLE ai_eval_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_eval_cases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_eval_cases USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
DO $$
BEGIN
  EXECUTE format('CREATE POLICY owner_all ON ai_eval_cases TO %I USING (true) WITH CHECK (true)', current_user);
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_eval_cases TO ideenportal_app;
