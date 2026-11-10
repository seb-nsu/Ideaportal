-- AP-26: AI quality dashboard (R4-08) and AI-assisted import (R4-12).

-- Alarm on deterioration of the AI quality (R4-08): one row per workspace and period. The unique
-- key makes sure the admins are told only once per period, however often the daily job runs.
CREATE TABLE ai_quality_alarms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  granularity text NOT NULL CHECK (granularity IN ('week', 'month')),
  -- First day of the evaluated period (ISO date).
  period date NOT NULL,
  -- Aggregated findings per agent and metric; no persons, no idea content.
  findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, granularity, period)
);
CREATE INDEX ai_quality_alarms_tenant ON ai_quality_alarms (tenant_id, created_at DESC);

ALTER TABLE ai_quality_alarms ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_quality_alarms FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_quality_alarms USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
DO $$ BEGIN
  EXECUTE format('CREATE POLICY owner_all ON ai_quality_alarms TO %I USING (true) WITH CHECK (true)', current_user);
END $$;
GRANT SELECT, INSERT ON ai_quality_alarms TO ideenportal_app;
