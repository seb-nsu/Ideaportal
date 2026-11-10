-- AP-07 Bedienbarkeit: first start per role and screen and the "first week" checklist (R2-48),
-- state of the response guarantee notice (R1-46).

-- Screens whose first-start steps the person has seen or skipped (board, steckbrief, gremium).
ALTER TABLE users ADD COLUMN intros_seen text[] NOT NULL DEFAULT '{}';
-- Ticked items of the "first week" checklist under "Meine Aufgaben" and whether it is hidden.
ALTER TABLE users ADD COLUMN first_week_done text[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN first_week_hidden boolean NOT NULL DEFAULT false;

-- One row per tenant: last quota of the response guarantee and whether the idea management has
-- already been told that it is below the threshold (notice once per drop, no repeats).
CREATE TABLE guarantee_alerts (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  below boolean NOT NULL DEFAULT false,
  quota numeric,
  checked_on date,
  alerted_at timestamptz
);

ALTER TABLE guarantee_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE guarantee_alerts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON guarantee_alerts USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
DO $$
BEGIN
  EXECUTE format('CREATE POLICY owner_all ON guarantee_alerts TO %I USING (true) WITH CHECK (true)', current_user);
END $$;
GRANT SELECT, INSERT, UPDATE ON guarantee_alerts TO ideenportal_app;
