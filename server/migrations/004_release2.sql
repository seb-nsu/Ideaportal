-- Release 2: elaboration, decision and impact (epic J), AI platform and agents (K-N),
-- challenges and recognition (O). Every new table is tenant-owned with row-level security.

-- ---------------------------------------------------------------- J: elaboration and decision

ALTER TABLE ideas ADD COLUMN mentor_id uuid REFERENCES users(id);
ALTER TABLE ideas ADD COLUMN timebox_until date;
ALTER TABLE ideas ADD COLUMN horizon int CHECK (horizon BETWEEN 1 AND 3);
-- Estimates from the dossier; they drive the delegation threshold (R2-05) and the portfolio sums (R2-08).
ALTER TABLE ideas ADD COLUMN effort_person_days numeric CHECK (effort_person_days >= 0);
ALTER TABLE ideas ADD COLUMN effort_euro numeric CHECK (effort_euro >= 0);
ALTER TABLE ideas ADD COLUMN plan_benefit_euro numeric CHECK (plan_benefit_euro >= 0);
ALTER TABLE ideas ADD COLUMN sponsor_id uuid REFERENCES users(id);
-- Original wording from the AI coach dialog (R2-16) and custom challenge fields (R2-35).
ALTER TABLE ideas ADD COLUMN original_text text;
ALTER TABLE ideas ADD COLUMN custom_values jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE ideas ADD COLUMN team_name text;

ALTER TABLE decisions ADD COLUMN delegated boolean NOT NULL DEFAULT false;
ALTER TABLE decisions ADD COLUMN meeting_id uuid;

-- Dossier (R2-02): one row per section, with a soft lock while someone edits it.
CREATE TABLE dossier_sections (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  section text NOT NULL CHECK (section IN ('summary', 'benefit', 'effort', 'risks', 'affected', 'path', 'analyses')),
  content text NOT NULL DEFAULT '',
  open_points text[] NOT NULL DEFAULT '{}',
  version int NOT NULL DEFAULT 0,
  locked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  locked_until timestamptz,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (idea_id, section)
);

CREATE TABLE dossier_history (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  section text NOT NULL,
  version int NOT NULL,
  content text NOT NULL,
  source text NOT NULL DEFAULT 'human' CHECK (source IN ('human', 'ai')),
  changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dossier_history_idea ON dossier_history (idea_id, section, version);

-- Weighted scorecard (R2-03) and jury scorecard (R2-35): scores per criterion id, 1-5.
CREATE TABLE scorecards (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  context text NOT NULL DEFAULT 'gate2' CHECK (context IN ('gate2', 'jury')),
  scores jsonb NOT NULL,
  total numeric NOT NULL,
  comment text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (idea_id, user_id, context)
);

-- Committee meetings (R2-04).
CREATE TABLE meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title text NOT NULL,
  meets_on date NOT NULL,
  pack_due_on date NOT NULL,
  pack_sent_at timestamptz,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'sent', 'held')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE meeting_items (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  position int NOT NULL,
  PRIMARY KEY (meeting_id, idea_id)
);

-- Experiments (R2-06).
CREATE TABLE experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  hypothesis text NOT NULL,
  smallest_test text NOT NULL DEFAULT '',
  metric text NOT NULL,
  success_criteria text NOT NULL DEFAULT '',
  starts_on date NOT NULL,
  ends_on date NOT NULL CHECK (ends_on >= starts_on),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done')),
  outcome text CHECK (outcome IN ('confirmed', 'refuted', 'inconclusive')),
  result text,
  reminded_at timestamptz,
  ai_result_id uuid,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

-- Impact review at Gate 3 (R2-07).
CREATE TABLE impact_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL UNIQUE REFERENCES ideas(id) ON DELETE CASCADE,
  reviewer_id uuid REFERENCES users(id) ON DELETE SET NULL,
  due_on date NOT NULL,
  notified_at timestamptz,
  plan_value numeric,
  actual_value numeric,
  outcome text CHECK (outcome IN ('close', 'scale', 'adjust', 'stop')),
  notes text,
  done_at timestamptz,
  confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- O: challenges and recognition

ALTER TABLE challenges ADD COLUMN custom_fields jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE challenges ADD COLUMN teams_allowed boolean NOT NULL DEFAULT false;
ALTER TABLE challenges ADD COLUMN jury_criteria jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE challenges ADD COLUMN ranking_published_at timestamptz;

CREATE TABLE challenge_jury (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  challenge_id uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (challenge_id, user_id)
);

CREATE TABLE success_stories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL UNIQUE REFERENCES ideas(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_author', 'published', 'declined')),
  name_authors boolean NOT NULL DEFAULT true,
  ai_result_id uuid,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  published_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Authors decide whether they are named on the success page (R2-38).
ALTER TABLE users ADD COLUMN show_on_success_page boolean NOT NULL DEFAULT true;

-- ---------------------------------------------------------------- K: AI platform

-- Provider credentials per tenant, encrypted with the server secret (never returned by the API).
CREATE TABLE tenant_secrets (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  ciphertext text NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, name)
);

-- Log of every AI action (R2-10).
CREATE TABLE ai_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idea_id uuid REFERENCES ideas(id) ON DELETE CASCADE,
  agent text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  local boolean NOT NULL,
  status text NOT NULL CHECK (status IN ('ok', 'error', 'blocked', 'budget', 'refused')),
  input jsonb NOT NULL,
  output jsonb,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  tools jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  input_tokens int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  search_queries int NOT NULL DEFAULT 0,
  cost_eur numeric NOT NULL DEFAULT 0,
  duration_ms int NOT NULL DEFAULT 0,
  error text,
  triggered_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approval text CHECK (approval IN ('approved', 'rejected')),
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_actions_tenant_time ON ai_actions (tenant_id, created_at DESC);
CREATE INDEX ai_actions_idea ON ai_actions (idea_id);

-- Results of AI agents shown to people (analyses, drafts, suggestions), versioned per kind.
CREATE TABLE ai_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idea_id uuid REFERENCES ideas(id) ON DELETE CASCADE,
  subject text,
  kind text NOT NULL,
  version int NOT NULL DEFAULT 1,
  content jsonb NOT NULL,
  changes jsonb,
  action_id uuid REFERENCES ai_actions(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_results_idea_kind ON ai_results (idea_id, kind, version DESC);

-- Corrections of single AI statements (R2-15).
CREATE TABLE ai_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  result_id uuid NOT NULL REFERENCES ai_results(id) ON DELETE CASCADE,
  claim_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('correct', 'discard')),
  original_text text NOT NULL,
  corrected_text text,
  reason text NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (result_id, claim_id)
);

-- Queue for longer AI work (analyses, evaluation runs); workers lock rows with SKIP LOCKED.
CREATE TABLE ai_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idea_id uuid REFERENCES ideas(id) ON DELETE CASCADE,
  kind text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  attempts int NOT NULL DEFAULT 0,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  error text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX ai_jobs_pending ON ai_jobs (run_after) WHERE status = 'queued';
CREATE UNIQUE INDEX ai_jobs_one_open ON ai_jobs (tenant_id, coalesce(idea_id, '00000000-0000-0000-0000-000000000000'::uuid), kind)
  WHERE status IN ('queued', 'running');

-- Quality measurement against the AI test set (R2-12).
CREATE TABLE ai_eval_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  config_hash text NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('manual', 'config_change', 'initial')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  config jsonb NOT NULL,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  details jsonb NOT NULL DEFAULT '[]'::jsonb,
  cost_eur numeric NOT NULL DEFAULT 0,
  error text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX ai_eval_runs_hash ON ai_eval_runs (tenant_id, config_hash, created_at DESC);

-- ---------------------------------------------------------------- row-level security

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['dossier_sections', 'dossier_history', 'scorecards', 'meetings', 'meeting_items', 'experiments',
                           'impact_reviews', 'challenge_jury', 'success_stories', 'tenant_secrets', 'ai_actions', 'ai_results',
                           'ai_corrections', 'ai_jobs', 'ai_eval_runs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('CREATE POLICY owner_all ON %I TO %I USING (true) WITH CHECK (true)', t, current_user);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON dossier_sections, scorecards, meetings, meeting_items, experiments, impact_reviews,
  challenge_jury, success_stories, tenant_secrets, ai_results, ai_corrections, ai_jobs, ai_eval_runs, ai_actions TO ideenportal_app;
GRANT SELECT, INSERT ON dossier_history TO ideenportal_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ideenportal_app;
