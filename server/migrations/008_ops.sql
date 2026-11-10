-- Operations (AP-03, R1-05): heartbeats of the background loops and the state of alerts.
-- Platform data without idea content; only the owner connection (health check, jobs) uses it.

CREATE TABLE job_heartbeats (
  kind text PRIMARY KEY,
  started_at timestamptz,
  finished_at timestamptz,
  ok boolean NOT NULL DEFAULT true,
  runs bigint NOT NULL DEFAULT 0,
  failures bigint NOT NULL DEFAULT 0
);

CREATE TABLE ops_alerts (
  key text PRIMARY KEY,
  active boolean NOT NULL DEFAULT true,
  message text NOT NULL,
  raised_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  cleared_at timestamptz
);

ALTER TABLE job_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_heartbeats FORCE ROW LEVEL SECURITY;
ALTER TABLE ops_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_alerts FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  EXECUTE format('CREATE POLICY owner_all ON job_heartbeats TO %I USING (true) WITH CHECK (true)', current_user);
  EXECUTE format('CREATE POLICY owner_all ON ops_alerts TO %I USING (true) WITH CHECK (true)', current_user);
END $$;
REVOKE ALL ON job_heartbeats, ops_alerts FROM ideenportal_app;
