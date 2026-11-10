-- Enterprise: tenant lifecycle and administration.
-- Tenant status (suspend, offboarding with grace period), deletion proof outside the tenant,
-- background export as ZIP, individual operator accounts with roles, per-tenant overrides of
-- feature switches and limits by the operator. Delegated people administration needs no table
-- (role 'user_admin' lives in users.roles).

-- ---------------------------------------------------------------- tenant status
ALTER TABLE tenants ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleting'));
ALTER TABLE tenants ADD COLUMN suspended_at timestamptz;
ALTER TABLE tenants ADD COLUMN suspended_reason text;
ALTER TABLE tenants ADD COLUMN suspended_by text;
ALTER TABLE tenants ADD COLUMN deletion_requested_at timestamptz;
ALTER TABLE tenants ADD COLUMN deletion_requested_by text;
ALTER TABLE tenants ADD COLUMN deletion_reason text;
ALTER TABLE tenants ADD COLUMN delete_after timestamptz;
CREATE INDEX tenants_delete_after ON tenants (delete_after) WHERE status = 'deleting';

-- The app role may update settings and names of its own tenant, never the lifecycle columns:
-- status changes go through the owner connection (services/tenantLifecycle.ts).
CREATE OR REPLACE FUNCTION tenants_lifecycle_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'ideenportal_app' AND (
       NEW.status IS DISTINCT FROM OLD.status OR NEW.suspended_at IS DISTINCT FROM OLD.suspended_at
    OR NEW.suspended_reason IS DISTINCT FROM OLD.suspended_reason OR NEW.suspended_by IS DISTINCT FROM OLD.suspended_by
    OR NEW.deletion_requested_at IS DISTINCT FROM OLD.deletion_requested_at OR NEW.deletion_requested_by IS DISTINCT FROM OLD.deletion_requested_by
    OR NEW.deletion_reason IS DISTINCT FROM OLD.deletion_reason OR NEW.delete_after IS DISTINCT FROM OLD.delete_after) THEN
    RAISE EXCEPTION 'tenant lifecycle columns are managed by the platform';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenants_lifecycle_guard BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenants_lifecycle_guard();

-- No new session in a suspended tenant; while it is being deleted only admins may sign in
-- (to export the data or cancel the deletion). Covers password, company login and demo login.
CREATE OR REPLACE FUNCTION sessions_tenant_status() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  SELECT status INTO s FROM tenants WHERE id = NEW.tenant_id;
  IF s = 'suspended' THEN
    RAISE EXCEPTION 'tenant suspended' USING ERRCODE = 'IPT01';
  ELSIF s = 'deleting' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.user_id AND 'admin' = ANY(u.roles)) THEN
    RAISE EXCEPTION 'tenant being deleted' USING ERRCODE = 'IPT02';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sessions_tenant_status BEFORE INSERT ON sessions
  FOR EACH ROW EXECUTE FUNCTION sessions_tenant_status();

-- Proof of deletion, kept after the tenant is gone. No content: a hash of the tenant id, the
-- slug, who asked, the dates and how many rows each table held.
CREATE TABLE tenant_deletions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id_hash text NOT NULL,
  slug text NOT NULL,
  requested_by_kind text NOT NULL CHECK (requested_by_kind IN ('admin', 'operator', 'system')),
  requested_by text NOT NULL,
  reason text,
  requested_at timestamptz NOT NULL,
  delete_after timestamptz NOT NULL,
  purged_at timestamptz NOT NULL DEFAULT now(),
  row_counts jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- ---------------------------------------------------------------- operator accounts
CREATE TABLE operator_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  name text NOT NULL,
  password_hash text NOT NULL,
  -- TOTP is mandatory; encrypted with SECRET_KEY when it is set.
  totp_secret text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'support', 'billing', 'technical')),
  active boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT true,
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX operator_accounts_email ON operator_accounts (lower(email));

ALTER TABLE operator_sessions ADD COLUMN operator_id uuid REFERENCES operator_accounts(id) ON DELETE CASCADE;
ALTER TABLE operator_sessions ADD COLUMN role text NOT NULL DEFAULT 'owner';
ALTER TABLE operator_log ADD COLUMN operator_id uuid;
CREATE INDEX operator_log_operator ON operator_log (operator_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_deletions', 'operator_accounts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY owner_all ON %I TO %I USING (true) WITH CHECK (true)', t, current_user);
  END LOOP;
END $$;
REVOKE ALL ON tenant_deletions, operator_accounts FROM ideenportal_app;

-- ---------------------------------------------------------------- overrides by the operator
-- On top of the package (tenant_plans): a feature switched on or off, or a limit, per tenant,
-- with reason and optional expiry. Expired rows are ignored.
CREATE TABLE tenant_overrides (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('feature', 'limit')),
  bool_value boolean,
  int_value int CHECK (int_value IS NULL OR int_value >= 0),
  reason text NOT NULL,
  expires_at timestamptz,
  set_by text NOT NULL,
  set_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key),
  CHECK ((kind = 'feature' AND bool_value IS NOT NULL) OR (kind = 'limit' AND int_value IS NOT NULL))
);

-- ---------------------------------------------------------------- tenant export (ZIP)
CREATE TABLE tenant_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  expires_at timestamptz,
  size_bytes bigint,
  sha256 text,
  manifest jsonb,
  error text,
  downloads int NOT NULL DEFAULT 0
);
CREATE INDEX tenant_exports_tenant ON tenant_exports (tenant_id, created_at DESC);
CREATE INDEX tenant_exports_queue ON tenant_exports (created_at) WHERE status = 'queued';

-- The ZIP is stored in pieces of about 1 MB, so writing and downloading stream.
CREATE TABLE tenant_export_chunks (
  export_id uuid NOT NULL REFERENCES tenant_exports(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  seq int NOT NULL,
  data bytea NOT NULL,
  PRIMARY KEY (export_id, seq)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_overrides', 'tenant_exports', 'tenant_export_chunks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('CREATE POLICY owner_all ON %I TO %I USING (true) WITH CHECK (true)', t, current_user);
  END LOOP;
END $$;
-- The workspace reads its overrides (request context); only the operator writes them.
GRANT SELECT ON tenant_overrides TO ideenportal_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_exports, tenant_export_chunks TO ideenportal_app;
