-- AP-18: packages with feature switches (R3-05), AI quota and top-ups (R3-06), trial after
-- self-registration (R3-02), challenge package (R3-39) and invoice drafts. No payment
-- provider: invoices are drafts for the operator; payment collection is open.

-- Package of a workspace. No row = internal workspace (own company, demo): every feature
-- except module Z, no quota, no invoice. The operator sets the package; the workspace
-- itself may only change its status (trial end, challenge end by the job) and file a request.
CREATE TABLE tenant_plans (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  plan text NOT NULL CHECK (plan IN ('internal', 'trial', 'team', 'business_1000', 'business_2500', 'enterprise', 'challenge')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('trial', 'active', 'read_only', 'ended')),
  employees int CHECK (employees IS NULL OR employees > 0),
  starts_on date NOT NULL DEFAULT current_date,
  trial_ends_on date,
  ends_on date,
  -- Operator overrides of single feature switches, e.g. {"api": true}.
  feature_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Full analyses per month instead of the package value (NULL = package value).
  quota_override int CHECK (quota_override IS NULL OR quota_override >= 0),
  requested_plan text,
  requested_employees int,
  requested_at timestamptz,
  offer_sent_at timestamptz,
  note text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

-- History of package changes; source of the conversion rates (R3-39, R3-02).
CREATE TABLE plan_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  from_plan text,
  to_plan text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by text
);
CREATE INDEX plan_changes_tenant ON plan_changes (tenant_id, changed_at);

-- AI top-ups booked by the operator for one month (R3-06); they appear on the invoice.
CREATE TABLE ai_topups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period date NOT NULL CHECK (extract(day FROM period) = 1),
  analyses int NOT NULL CHECK (analyses > 0),
  price_eur numeric(10, 2) NOT NULL CHECK (price_eur >= 0),
  note text NOT NULL DEFAULT '',
  booked_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_topups_period ON ai_topups (tenant_id, period);

-- Invoice drafts (R3-05): monthly per package, once for the challenge package.
CREATE SEQUENCE invoice_number_seq;
CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('monthly', 'challenge')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  plan text NOT NULL,
  quantity int,
  lines jsonb NOT NULL,
  net_eur numeric(12, 2) NOT NULL,
  vat_rate numeric(5, 4) NOT NULL,
  vat_eur numeric(12, 2) NOT NULL,
  gross_eur numeric(12, 2) NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind, period_start)
);

-- Notices sent once (quota 80 %/100 % per month, trial reminders, challenge end).
CREATE TABLE billing_notices (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

ALTER TABLE tenant_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_plans FORCE ROW LEVEL SECURITY;
ALTER TABLE plan_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_changes FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_topups ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_topups FORCE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_notices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_plans USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE POLICY tenant_isolation ON plan_changes USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE POLICY tenant_isolation ON ai_topups USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE POLICY tenant_isolation ON invoices USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE POLICY tenant_isolation ON billing_notices USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
DO $$
BEGIN
  EXECUTE format('CREATE POLICY owner_all ON tenant_plans TO %I USING (true) WITH CHECK (true)', current_user);
  EXECUTE format('CREATE POLICY owner_all ON plan_changes TO %I USING (true) WITH CHECK (true)', current_user);
  EXECUTE format('CREATE POLICY owner_all ON ai_topups TO %I USING (true) WITH CHECK (true)', current_user);
  EXECUTE format('CREATE POLICY owner_all ON invoices TO %I USING (true) WITH CHECK (true)', current_user);
  EXECUTE format('CREATE POLICY owner_all ON billing_notices TO %I USING (true) WITH CHECK (true)', current_user);
END $$;

-- The workspace reads its package, top-ups and invoices; it writes only its status (job),
-- its package request and the notices. Package, prices and overrides are operator data.
GRANT SELECT ON tenant_plans, plan_changes, ai_topups, invoices TO ideenportal_app;
GRANT UPDATE (status, requested_plan, requested_employees, requested_at, offer_sent_at) ON tenant_plans TO ideenportal_app;
GRANT SELECT, INSERT ON billing_notices TO ideenportal_app;
REVOKE ALL ON SEQUENCE invoice_number_seq FROM ideenportal_app;
