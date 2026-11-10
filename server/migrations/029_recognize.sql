-- AP-27 Erkennen: trend and technology radar (R4-11), weekly trend hints for sponsors (R4-02),
-- white spots (R4-03, no table: computed from topics and ideas) and the problem radar from
-- tickets and feedback (R4-01).
-- There is no signal database (R4-11): web hits live only inside a weekly digest and inside the
-- open suggestions made from it; raw tickets and feedback rows are never stored, only clusters
-- with their frequency and a few redacted examples.

-- Sponsors per topic field (R4-02): they get the weekly trend hints of their topic fields.
CREATE TABLE topic_sponsors (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  topic text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, topic, user_id)
);
CREATE INDEX topic_sponsors_user ON topic_sponsors (user_id);

-- Weekly summary per topic field (R4-02) with its sources; "week" is the ISO week (2026-W42).
CREATE TABLE trend_digests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  topic text NOT NULL,
  week text NOT NULL,
  content jsonb NOT NULL,
  ai_action_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, topic, week)
);

-- Elements of the radar (R4-11): manual or adopted from a weekly digest.
CREATE TABLE trend_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 2 AND 140),
  description text NOT NULL DEFAULT '',
  topic text NOT NULL,
  -- now = 0-1 year, next = 1-3 years, later = more than 3 years
  horizon text NOT NULL CHECK (horizon IN ('now', 'next', 'later')),
  maturity text NOT NULL CHECK (maturity IN ('emerging', 'growing', 'established')),
  origin text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'digest')),
  digest_id uuid REFERENCES trend_digests(id) ON DELETE SET NULL,
  -- [{title, url}] from the web search, confirmed by a person
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trend_items_tenant ON trend_items (tenant_id, topic);

-- Confirmed link between an idea and a trend (R4-11).
CREATE TABLE trend_links (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  trend_id uuid NOT NULL REFERENCES trend_items(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trend_id, idea_id)
);
CREATE INDEX trend_links_idea ON trend_links (idea_id);

-- Suggestions of the AI (R4-11): an idea or a web hit of a digest belongs to a trend. A person
-- accepts (link or source) or dismisses; the AI never links on its own.
CREATE TABLE trend_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  trend_id uuid NOT NULL REFERENCES trend_items(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('idea', 'web')),
  idea_id uuid REFERENCES ideas(id) ON DELETE CASCADE,
  digest_id uuid REFERENCES trend_digests(id) ON DELETE CASCADE,
  source jsonb,
  reason text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'dismissed')),
  ai_action_id uuid,
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'idea' AND idea_id IS NOT NULL) OR (kind = 'web' AND source IS NOT NULL))
);
CREATE INDEX trend_suggestions_trend ON trend_suggestions (trend_id, status);
CREATE UNIQUE INDEX trend_suggestions_idea_once ON trend_suggestions (trend_id, idea_id) WHERE kind = 'idea';
CREATE UNIQUE INDEX trend_suggestions_web_once ON trend_suggestions (trend_id, (source->>'url')) WHERE kind = 'web';

-- Problem radar (R4-01): a source is a connector (AP-20) with a query; CSV feedback has no source row.
CREATE TABLE problem_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id uuid NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  -- Jira: JQL; ServiceNow: encoded query; Azure DevOps: work item type
  query text NOT NULL DEFAULT '',
  -- ServiceNow table (incident, sn_customerservice_case …); unused otherwise
  table_name text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One clustering run: how many items were read, never the items themselves.
CREATE TABLE problem_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_id uuid REFERENCES problem_sources(id) ON DELETE SET NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('connector', 'csv')),
  source_name text NOT NULL,
  items integer NOT NULL DEFAULT 0,
  min_cluster_size integer NOT NULL,
  ai_action_id uuid,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX problem_runs_tenant ON problem_runs (tenant_id, created_at DESC);

-- Recurring problems with frequency and redacted examples; never per person.
CREATE TABLE problem_clusters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES problem_runs(id) ON DELETE CASCADE,
  label text NOT NULL,
  summary text NOT NULL DEFAULT '',
  frequency integer NOT NULL CHECK (frequency > 0),
  examples jsonb NOT NULL DEFAULT '[]'::jsonb,
  idea_id uuid REFERENCES ideas(id) ON DELETE SET NULL,
  challenge_id uuid REFERENCES challenges(id) ON DELETE SET NULL,
  dismissed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX problem_clusters_run ON problem_clusters (run_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['topic_sponsors', 'trend_digests', 'trend_items', 'trend_links', 'trend_suggestions',
                           'problem_sources', 'problem_runs', 'problem_clusters']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('CREATE POLICY owner_all ON %I TO %I USING (true) WITH CHECK (true)', t, current_user);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO ideenportal_app', t);
  END LOOP;
END $$;
