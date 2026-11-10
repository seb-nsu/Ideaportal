-- AP-25: compliance (R3-11) and invention disclosure check (R3-25).

-- Acceptance of a legal document version by an admin of the workspace (R3-11). One row per
-- document and version; a new version needs a new acceptance. The audit log has the same event.
CREATE TABLE legal_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document text NOT NULL CHECK (document IN ('agb', 'avv')),
  version text NOT NULL,
  accepted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, document, version)
);

ALTER TABLE legal_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_acceptances FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON legal_acceptances USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
DO $$ BEGIN
  EXECUTE format('CREATE POLICY owner_all ON legal_acceptances TO %I USING (true) WITH CHECK (true)', current_user);
END $$;
-- Append only: acceptances are evidence and are never changed or deleted by the app.
GRANT SELECT, INSERT ON legal_acceptances TO ideenportal_app;

-- Invention disclosure check at triage (R3-25): the triage team answers "possible invention?".
-- A possible invention gets no web search; forwarding it to a patent channel makes it
-- confidential and notes the claim period (German employee inventions act, 4 months by default).
ALTER TABLE ideas
  ADD COLUMN invention_check text CHECK (invention_check IN ('possible', 'no')),
  ADD COLUMN invention_checked_at timestamptz,
  ADD COLUMN invention_checked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN invention_forwarded_on date,
  ADD COLUMN invention_claim_until date;
