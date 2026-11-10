-- AP-12 (R3-17): API tokens per tenant, webhook subscriptions and the webhook outbox.

-- Every API token acts as its own technical user: ideas, comments and decisions made through
-- the API carry this user as actor. Technical users cannot log in (no password, inactive),
-- get no mail and are hidden from the people list.
ALTER TABLE users ADD COLUMN technical boolean NOT NULL DEFAULT false;

CREATE TABLE api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  -- Public lookup part of the token ("ipt_<prefix>_<secret>"); the token itself is stored as SHA-256 only.
  prefix text NOT NULL UNIQUE,
  token_hash text NOT NULL,
  roles text[] NOT NULL,
  expires_at timestamptz NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX api_tokens_tenant ON api_tokens (tenant_id, created_at DESC);

CREATE TABLE webhook_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  url text NOT NULL,
  events text[] NOT NULL,
  -- Signing secret, encrypted with SECRET_KEY (lib/secretbox.ts).
  secret_enc text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  -- Failed attempts in a row; reaching the limit switches the subscription off.
  failure_count int NOT NULL DEFAULT 0,
  disabled_at timestamptz,
  disabled_reason text,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Outbox of webhook deliveries, processed by the job loop with exponential retry.
CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  event text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  response_status int,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_subscription ON webhook_deliveries (subscription_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['api_tokens', 'webhook_subscriptions', 'webhook_deliveries']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('CREATE POLICY owner_all ON %I TO %I USING (true) WITH CHECK (true)', t, current_user);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON api_tokens TO ideenportal_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_subscriptions, webhook_deliveries TO ideenportal_app;
