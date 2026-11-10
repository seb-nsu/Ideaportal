-- AP-28 Wirkung und Lernen: before/after metrics from connected systems (R4-04), effort estimate
-- from similar implemented ideas (R4-06) and calibration of forecasts (R4-07).

-- Actual effort, recorded optionally when an implementation is closed (R4-06, R4-07). The
-- estimates stay in ideas.effort_person_days / effort_euro.
ALTER TABLE implementations ADD COLUMN actual_effort_person_days numeric CHECK (actual_effort_person_days >= 0);
ALTER TABLE implementations ADD COLUMN actual_effort_euro numeric CHECK (actual_effort_euro >= 0);

-- Metric of an idea, fixed at Gate 2 (R4-04): name, unit, direction, source and baseline period.
-- Source 'connector' counts items in Jira, ServiceNow or Azure DevOps with a stored query;
-- 'api' takes values from another system with an API token; 'manual' is entered by people.
CREATE TABLE impact_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  name text NOT NULL,
  unit text NOT NULL,
  -- Which way is better: more (e.g. orders) or less (e.g. tickets, minutes).
  direction text NOT NULL DEFAULT 'decrease' CHECK (direction IN ('increase', 'decrease')),
  source text NOT NULL CHECK (source IN ('manual', 'api', 'connector')),
  connector_id uuid REFERENCES connectors(id) ON DELETE SET NULL,
  -- JQL, ServiceNow encoded query or WIQL; {from} and {to} are replaced by the period dates.
  query text,
  -- ServiceNow table to count in (default: the connector's item table).
  query_table text,
  baseline_from date NOT NULL,
  baseline_to date NOT NULL CHECK (baseline_to >= baseline_from),
  -- Days between two automatic after-measurements.
  interval_days int NOT NULL DEFAULT 30 CHECK (interval_days BETWEEN 1 AND 365),
  next_measure_on date,
  last_measured_at timestamptz,
  last_error text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source <> 'connector' OR query IS NOT NULL)
);
CREATE INDEX impact_metrics_idea ON impact_metrics (idea_id);

-- Measured values: 'baseline' (before) and 'after' (after the implementation), each for a period.
CREATE TABLE impact_metric_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  metric_id uuid NOT NULL REFERENCES impact_metrics(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  period text NOT NULL CHECK (period IN ('baseline', 'after')),
  period_from date,
  period_to date,
  value numeric NOT NULL,
  source text NOT NULL CHECK (source IN ('manual', 'api', 'connector')),
  note text,
  recorded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX impact_metric_values_metric ON impact_metric_values (metric_id, period, created_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['impact_metrics', 'impact_metric_values']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('CREATE POLICY owner_all ON %I TO %I USING (true) WITH CHECK (true)', t, current_user);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON impact_metrics, impact_metric_values TO ideenportal_app;
