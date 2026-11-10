-- AI trust (AP-02, R2-43): reading time of the Gate 2 brief, measured in the pilot.
-- Only the duration is stored, never who read it (no evaluation of persons).

CREATE TABLE brief_reads (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  seconds int NOT NULL CHECK (seconds BETWEEN 1 AND 3600),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX brief_reads_tenant ON brief_reads (tenant_id, created_at DESC);

ALTER TABLE brief_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE brief_reads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON brief_reads USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
DO $$ BEGIN
  EXECUTE format('CREATE POLICY owner_all ON brief_reads TO %I USING (true) WITH CHECK (true)', current_user);
END $$;
GRANT SELECT, INSERT ON brief_reads TO ideenportal_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ideenportal_app;
