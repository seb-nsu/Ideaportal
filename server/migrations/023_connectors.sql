-- AP-20 (R3-13, R3-14, R3-15, R3-18): connectors to Jira, ServiceNow and Azure DevOps, links
-- between ideas and external items, and the implementation package.

-- One row per configured connector of a tenant. Credentials and the callback secret are
-- encrypted with SECRET_KEY (lib/secretbox.ts) and never returned by the API.
CREATE TABLE connectors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('jira', 'servicenow', 'azure_devops')),
  name text NOT NULL,
  base_url text NOT NULL,
  -- Target (project, table, work item type), field mapping, status mapping, polling.
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  credentials_enc text,
  -- Secret for status callbacks (HMAC signature or basic auth), shown once.
  callback_secret_enc text NOT NULL,
  -- Activated per click by an admin; a new connector starts switched off.
  enabled boolean NOT NULL DEFAULT false,
  last_poll_at timestamptz,
  last_error text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX connectors_tenant ON connectors (tenant_id, created_at);

-- Link between an idea and an external item: the main item (epic, demand, work item) and the
-- child items created from the user stories of the implementation package.
CREATE TABLE connector_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id uuid NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('main', 'story')),
  -- Position of the story in the package; -1 for the main item.
  story_index int NOT NULL DEFAULT -1,
  external_id text NOT NULL,
  external_key text,
  external_url text,
  external_status text,
  mapped_progress int CHECK (mapped_progress BETWEEN 0 AND 100),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz,
  UNIQUE (connector_id, idea_id, role, story_index)
);
CREATE INDEX connector_links_idea ON connector_links (idea_id);
CREATE INDEX connector_links_external ON connector_links (connector_id, external_id);

-- Implementation package (R3-18): project brief and user stories, drafted by the AI gateway
-- and edited by people. One package per idea.
CREATE TABLE implementation_packages (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idea_id uuid PRIMARY KEY REFERENCES ideas(id) ON DELETE CASCADE,
  brief jsonb NOT NULL,
  stories jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- 'ai' while the draft is unchanged, 'human' after the first edit.
  source text NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'human')),
  ai_action_id uuid,
  version int NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['connectors', 'connector_links', 'implementation_packages']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('CREATE POLICY owner_all ON %I TO %I USING (true) WITH CHECK (true)', t, current_user);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON connectors, connector_links, implementation_packages TO ideenportal_app;
