-- R3-26: company login with SAML 2.0 as an alternative to OpenID Connect.

-- Protocol per tenant. oidc_enabled stays the master switch "company login on" for both
-- protocols (the name is kept for compatibility with existing code and data).
ALTER TABLE tenant_identity ADD COLUMN protocol text NOT NULL DEFAULT 'oidc' CHECK (protocol IN ('oidc', 'saml'));
-- SAML settings {metadataUrl, idpEntityId, ssoUrl, certs[] (PEM, public), attributes{email,
-- name, department, groups}, allowIdpInitiated}. Nothing secret is stored here.
ALTER TABLE tenant_identity ADD COLUMN saml jsonb NOT NULL DEFAULT '{}'::jsonb;
COMMENT ON COLUMN tenant_identity.oidc_enabled IS 'Company login switched on (protocol OIDC or SAML, see column protocol)';

-- Sessions from a SAML login: the identity provider is responsible for the second factor.
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_auth_method_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_auth_method_check CHECK (auth_method IN ('password', 'oidc', 'saml'));

-- Running SP-initiated logins: the ID of the AuthnRequest, single use (InResponseTo), bound to
-- the browser that started it. claimed_by marks the one validation that may use the row, so
-- two parallel posts of the same response cannot both succeed. Owner connection only.
CREATE TABLE saml_requests (
  request_id text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  browser_hash text,
  return_to text NOT NULL DEFAULT '/',
  claimed_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX saml_requests_expiry ON saml_requests (expires_at);

-- Assertion IDs already used, kept until the assertion expires (replay protection, also for
-- IdP-initiated logins without InResponseTo). Owner connection only.
CREATE TABLE saml_used_assertions (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  assertion_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, assertion_id)
);
CREATE INDEX saml_used_assertions_expiry ON saml_used_assertions (expires_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['saml_requests', 'saml_used_assertions']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('CREATE POLICY owner_all ON %I TO %I USING (true) WITH CHECK (true)', t, current_user);
  END LOOP;
END $$;

REVOKE ALL ON saml_requests, saml_used_assertions FROM ideenportal_app;
