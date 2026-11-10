-- Ideenportal: initial schema (Release 1 core).
-- Tenant isolation: every tenant-owned table has tenant_id and a row-level security
-- policy bound to the session setting app.tenant_id. The application switches to the
-- non-owner role ideenportal_app for every request, so the policies always apply.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ideenportal_app') THEN
    CREATE ROLE ideenportal_app NOLOGIN;
  END IF;
END $$;
GRANT ideenportal_app TO CURRENT_USER;

CREATE OR REPLACE FUNCTION current_tenant() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,40}$'),
  name text NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email text NOT NULL,
  display_name text NOT NULL,
  org_unit text,
  roles text[] NOT NULL DEFAULT ARRAY['submitter'],
  password_hash text,
  mfa_secret text,
  mfa_enabled boolean NOT NULL DEFAULT false,
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  onboarded boolean NOT NULL DEFAULT false,
  reset_token_hash text,
  reset_expires_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mfa_pending boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title text NOT NULL,
  question text NOT NULL,
  topic text,
  contact text NOT NULL,
  sponsor_id uuid REFERENCES users(id),
  starts_on date NOT NULL,
  ends_on date NOT NULL CHECK (ends_on >= starts_on),
  summary text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ideas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number int NOT NULL,
  title text NOT NULL,
  problem text NOT NULL DEFAULT '',
  solution text NOT NULL DEFAULT '',
  benefit text NOT NULL DEFAULT '',
  topic text,
  idea_type text NOT NULL DEFAULT 'internal' CHECK (idea_type IN ('internal', 'product')),
  confidential boolean NOT NULL DEFAULT false,
  anonymous boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft',
  lane text CHECK (lane IN ('fast_lane', 'elaborate', 'forward', 'reject')),
  challenge_id uuid REFERENCES challenges(id) ON DELETE SET NULL,
  author_id uuid NOT NULL REFERENCES users(id),
  submitted_by_id uuid REFERENCES users(id),
  author_confirmed boolean NOT NULL DEFAULT true,
  forwarded_to text,
  resubmit_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);
CREATE INDEX ideas_tenant_status ON ideas (tenant_id, status);
CREATE INDEX ideas_search_trgm ON ideas USING gin ((title || ' ' || problem || ' ' || solution) gin_trgm_ops);

CREATE TABLE idea_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id),
  kind text NOT NULL,
  from_status text,
  to_status text,
  message text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idea_events_idea ON idea_events (idea_id, id);

CREATE TABLE deadlines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  phase text NOT NULL CHECK (phase IN ('gate1', 'elaboration')),
  started_on date NOT NULL,
  due_on date NOT NULL,
  paused_on date,
  completed_at timestamptz,
  reminded_at timestamptz,
  escalated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deadlines_open ON deadlines (tenant_id) WHERE completed_at IS NULL;

CREATE TABLE questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  round int NOT NULL,
  question text NOT NULL,
  answer text,
  asked_by uuid NOT NULL REFERENCES users(id),
  asked_on date NOT NULL,
  answered_at timestamptz,
  UNIQUE (idea_id, round)
);

CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES comments(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE supports (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (idea_id, user_id)
);

CREATE TABLE decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  gate int NOT NULL CHECK (gate IN (1, 2)),
  outcome text NOT NULL,
  reason text,
  owner_id uuid REFERENCES users(id),
  resubmit_on date,
  decided_by uuid NOT NULL REFERENCES users(id),
  decided_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE implementations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL UNIQUE REFERENCES ideas(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id),
  channel text NOT NULL CHECK (channel IN ('line', 'project', 'backlog', 'experiment')),
  org_unit text,
  external_ref text,
  target_date date NOT NULL,
  progress int NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'active', 'done')),
  accepted_at timestamptz,
  benefit_kind text CHECK (benefit_kind IN ('euro', 'hours', 'quality', 'revenue', 'co2')),
  benefit_value numeric,
  benefit_evidence text,
  closed_at timestamptz,
  overdue_reminded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  phase text NOT NULL,
  score int NOT NULL CHECK (score BETWEEN 1 AND 5),
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idea_id, user_id, phase)
);

CREATE TABLE outbox (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  to_email text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  idea_id uuid REFERENCES ideas(id) ON DELETE CASCADE,
  read_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_user ON outbox (user_id, id DESC);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  entity text NOT NULL,
  entity_id text,
  before jsonb,
  after jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The audit log is append-only (R1-06).
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- Row-level security for every tenant-owned table.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants USING (id = current_tenant()) WITH CHECK (id = current_tenant());

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users', 'sessions', 'challenges', 'ideas', 'idea_events', 'deadlines', 'questions',
                           'comments', 'supports', 'decisions', 'implementations', 'feedback', 'outbox', 'audit_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
  END LOOP;
END $$;

-- The owner role (migrations, login, background jobs) bypasses RLS explicitly;
-- request handling always runs as ideenportal_app.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenants', 'users', 'sessions', 'challenges', 'ideas', 'idea_events', 'deadlines', 'questions',
                           'comments', 'supports', 'decisions', 'implementations', 'feedback', 'outbox', 'audit_log']
  LOOP
    EXECUTE format('CREATE POLICY owner_all ON %I TO %I USING (true) WITH CHECK (true)', t, current_user);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO ideenportal_app;
GRANT SELECT, UPDATE ON tenants TO ideenportal_app;
GRANT SELECT, INSERT, UPDATE ON users TO ideenportal_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON challenges, ideas, deadlines, questions, comments, supports,
  decisions, implementations, feedback, outbox TO ideenportal_app;
GRANT SELECT, INSERT ON idea_events, audit_log TO ideenportal_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ideenportal_app;
GRANT EXECUTE ON FUNCTION current_tenant() TO ideenportal_app;
