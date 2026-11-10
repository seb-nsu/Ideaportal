-- Pilot features: deputies and absences (R1-11), notification preferences (R1-36),
-- co-authors (R1-15), merging (R1-20), attachments (R1-13), retention (R1-40).

CREATE TABLE absences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deputy_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_on date NOT NULL,
  ends_on date NOT NULL CHECK (ends_on >= starts_on),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (user_id <> deputy_id)
);
CREATE INDEX absences_user ON absences (user_id, starts_on, ends_on);

ALTER TABLE users ADD COLUMN notify_email text NOT NULL DEFAULT 'immediate' CHECK (notify_email IN ('immediate', 'daily', 'off'));
ALTER TABLE users ADD COLUMN notify_muted text[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN last_digest_on date;
ALTER TABLE users ADD COLUMN anonymized_at timestamptz;
ALTER TABLE users ADD COLUMN deactivated_at timestamptz;

ALTER TABLE outbox ADD COLUMN category text NOT NULL DEFAULT 'tasks';
ALTER TABLE outbox ADD COLUMN on_behalf_of uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE idea_coauthors (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (idea_id, user_id)
);

ALTER TABLE ideas ADD COLUMN merged_into uuid REFERENCES ideas(id) ON DELETE SET NULL;
ALTER TABLE ideas ADD COLUMN imported boolean NOT NULL DEFAULT false;

CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  filename text NOT NULL,
  mime text NOT NULL,
  size int NOT NULL,
  data bytea NOT NULL,
  scan_status text NOT NULL CHECK (scan_status IN ('clean', 'type_checked')),
  uploaded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_idea ON attachments (idea_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['absences', 'idea_coauthors', 'attachments']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('CREATE POLICY owner_all ON %I TO %I USING (true) WITH CHECK (true)', t, current_user);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON absences, idea_coauthors, attachments TO ideenportal_app;

-- Deleting a whole workspace (R1-43) must be able to remove its audit trail; everything
-- else keeps the log append-only.
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.purge_tenant', true) = OLD.tenant_id::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only';
END $$;
