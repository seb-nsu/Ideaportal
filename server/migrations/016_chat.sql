-- Chat channels Slack and Microsoft Teams (R3-16): one more delivery channel of the outbox.
-- Workspace configuration per tenant (secrets encrypted with SECRET_KEY) and the opt-in of
-- each person with the same categories as e-mail (R1-36).

CREATE TABLE chat_workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('slack', 'teams')),
  enabled boolean NOT NULL DEFAULT false,
  -- Slack: workspace id (team_id) the requests must come from; Teams: Microsoft app id of the bot.
  external_id text,
  -- Slack: signing secret; Teams: security token of the outgoing webhook (base64).
  signing_secret_enc text,
  -- Slack only: bot token (xoxb-…) for direct messages, modals and the e-mail lookup.
  bot_token_enc text,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider)
);

CREATE TABLE chat_subscriptions (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel text NOT NULL DEFAULT 'off' CHECK (channel IN ('off', 'slack', 'teams')),
  muted text[] NOT NULL DEFAULT '{}',
  -- Personal incoming webhook (Teams Workflows or Slack), encrypted.
  webhook_url_enc text,
  -- Slack member id, found by e-mail with the bot token and cached.
  slack_user_id text,
  -- Teams: Entra object id of the person, linked once with a code from the portal.
  teams_aad_id text,
  link_code_hash text,
  link_code_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX chat_subscriptions_teams ON chat_subscriptions (tenant_id, teams_aad_id) WHERE teams_aad_id IS NOT NULL;

-- Chat delivery has its own marker: e-mail digests keep rows unsent for a day.
ALTER TABLE outbox ADD COLUMN chat_sent_at timestamptz;
UPDATE outbox SET chat_sent_at = now();
CREATE INDEX outbox_chat_pending ON outbox (id) WHERE chat_sent_at IS NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['chat_workspaces', 'chat_subscriptions']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('CREATE POLICY owner_all ON %I TO %I USING (true) WITH CHECK (true)', t, current_user);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON chat_workspaces, chat_subscriptions TO ideenportal_app;
