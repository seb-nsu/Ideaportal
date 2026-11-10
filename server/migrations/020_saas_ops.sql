-- SaaS operations (AP-17): tenant keys (R3-01), settings version (R3-41), support access and
-- operator console (R3-07), status page (R3-10).

-- R3-01: one random data key per tenant, stored wrapped with SECRET_KEY (envelope encryption).
-- The app reads only the key of its own tenant (RLS) and may create it once; only the owner
-- connection (rotation) re-wraps keys.
CREATE TABLE tenant_keys (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  wrapped_key text NOT NULL,
  -- Fingerprint of the SECRET_KEY that wrapped the key; the rotation skips rows already on the new key.
  master_fp text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  rewrapped_at timestamptz
);

-- R3-41: every change of the settings raises the version; PUT /api/admin/settings compares it.
ALTER TABLE tenants ADD COLUMN settings_version int NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION tenants_settings_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.settings IS DISTINCT FROM OLD.settings THEN
    NEW.settings_version := OLD.settings_version + 1;
  ELSE
    NEW.settings_version := OLD.settings_version;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenants_settings_version BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenants_settings_version();

-- R3-07: time-limited support access granted by an admin of the tenant.
CREATE TABLE support_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reason text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_grants_tenant ON support_grants (tenant_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_keys', 'support_grants'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('CREATE POLICY owner_all ON %I TO %I USING (true) WITH CHECK (true)', t, current_user);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON tenant_keys TO ideenportal_app;
GRANT SELECT, INSERT, UPDATE ON support_grants TO ideenportal_app;

-- Operator platform data (R3-07, R3-10): no tenant_id, owner connection only.
CREATE TABLE operator_sessions (
  token_hash text PRIMARY KEY,
  operator text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Actions of the operator on the platform (tenant created, incident written). Accesses to the
-- data of a tenant are logged in that tenant's audit log as well.
CREATE TABLE operator_log (
  id bigserial PRIMARY KEY,
  operator text NOT NULL,
  action text NOT NULL,
  tenant_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Recorded health checks for the availability history of the status page (R3-10).
CREATE TABLE status_checks (
  id bigserial PRIMARY KEY,
  checked_at timestamptz NOT NULL DEFAULT now(),
  api text NOT NULL CHECK (api IN ('operational', 'degraded', 'outage')),
  jobs text NOT NULL CHECK (jobs IN ('operational', 'degraded', 'outage')),
  ai text NOT NULL CHECK (ai IN ('operational', 'degraded', 'outage')),
  mail text NOT NULL CHECK (mail IN ('operational', 'degraded', 'outage'))
);
CREATE INDEX status_checks_time ON status_checks (checked_at);

-- Incidents and maintenance notes written by the operator.
CREATE TABLE status_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('incident', 'maintenance')),
  severity text NOT NULL DEFAULT 'minor' CHECK (severity IN ('minor', 'major')),
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  components text[] NOT NULL DEFAULT '{}',
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['operator_sessions', 'operator_log', 'status_checks', 'status_incidents'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY owner_all ON %I TO %I USING (true) WITH CHECK (true)', t, current_user);
  END LOOP;
END $$;
REVOKE ALL ON operator_sessions, operator_log, status_checks, status_incidents FROM ideenportal_app;
