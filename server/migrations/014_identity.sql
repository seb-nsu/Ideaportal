-- AP-11: company login with OpenID Connect (R3-26) and SCIM 2.0 provisioning (R3-27).

-- Identity settings per tenant (Einstellungen › Anmeldung). The client secret is not stored
-- here but encrypted in tenant_secrets (name 'oidc_client_secret').
CREATE TABLE tenant_identity (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  oidc_enabled boolean NOT NULL DEFAULT false,
  issuer text,
  client_id text,
  -- E-mail domains whose people may sign in with the company login; also used to find the
  -- workspace on the login page. A domain belongs to at most one tenant (checked on save).
  allowed_domains text[] NOT NULL DEFAULT '{}',
  -- [{group, roles[]}]: a group (name or object ID) of the identity provider grants roles.
  group_roles jsonb NOT NULL DEFAULT '[]'::jsonb,
  jit_provisioning boolean NOT NULL DEFAULT true,
  local_login_disabled boolean NOT NULL DEFAULT false,
  -- Claim names {email, name, department, groups}; empty = defaults.
  claims jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_identity_domains ON tenant_identity USING gin (allowed_domains);

-- Accounts managed by the identity provider: roles follow the group mapping, the name and
-- department follow the directory.
ALTER TABLE users ADD COLUMN idp_managed boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN oidc_subject text;
ALTER TABLE users ADD COLUMN external_id text;
ALTER TABLE users ADD COLUMN idp_groups text[] NOT NULL DEFAULT '{}';
-- Name parts as sent by SCIM ({givenName, familyName, formatted, displayName}).
ALTER TABLE users ADD COLUMN scim_name jsonb;
-- Deleted via SCIM: invisible to SCIM, locked, anonymised after the retention period.
ALTER TABLE users ADD COLUMN scim_deleted_at timestamptz;
CREATE UNIQUE INDEX users_oidc_subject ON users (tenant_id, oidc_subject) WHERE oidc_subject IS NOT NULL;

-- How the session was created: 'password' (own account, MFA applies) or 'oidc' (the identity
-- provider is responsible for the second factor).
ALTER TABLE sessions ADD COLUMN auth_method text NOT NULL DEFAULT 'password' CHECK (auth_method IN ('password', 'oidc'));

-- Running OIDC logins (state, nonce, PKCE verifier). Only the hash of the state is stored;
-- browser_hash binds the login to the browser that started it. Owner connection only.
CREATE TABLE oidc_login_states (
  state_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nonce text NOT NULL,
  code_verifier text NOT NULL,
  browser_hash text NOT NULL,
  return_to text NOT NULL DEFAULT '/',
  expires_at timestamptz NOT NULL
);

-- SCIM bearer tokens per tenant; only the SHA-256 hash is stored, the token is shown once.
CREATE TABLE scim_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  label text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE scim_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  external_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scim_groups_name ON scim_groups (tenant_id, lower(display_name));

CREATE TABLE scim_group_members (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES scim_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX scim_group_members_user ON scim_group_members (user_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_identity', 'oidc_login_states', 'scim_tokens', 'scim_groups', 'scim_group_members']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('CREATE POLICY owner_all ON %I TO %I USING (true) WITH CHECK (true)', t, current_user);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON tenant_identity, scim_tokens TO ideenportal_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON scim_groups, scim_group_members TO ideenportal_app;
REVOKE ALL ON oidc_login_states FROM ideenportal_app;
