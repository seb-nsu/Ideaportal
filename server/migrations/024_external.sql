-- AP-21: external participation (R3-19), moderation (R3-21) and feature requests (R3-20).

-- Ideas of external people (customers, partners). origin marks them; moderation decides when
-- they are published to others: NULL = no moderation (internal ideas), 'pending' = waits for
-- release, 'approved' = published, 'hidden' = withdrawn by the moderation (spam, report).
ALTER TABLE ideas ADD COLUMN origin text NOT NULL DEFAULT 'internal' CHECK (origin IN ('internal', 'external'));
ALTER TABLE ideas ADD COLUMN moderation text CHECK (moderation IN ('pending', 'approved', 'hidden'));
CREATE INDEX ideas_moderation ON ideas (tenant_id, moderation) WHERE moderation IS NOT NULL;
-- Comments hidden by the moderation after a report.
ALTER TABLE comments ADD COLUMN hidden_at timestamptz;

-- Challenges open to external people: portal link (code) and moderation mode per challenge
-- ('pre' = release before publication, 'post' = publish at once; NULL = tenant default).
ALTER TABLE challenges ADD COLUMN external_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE challenges ADD COLUMN external_code text UNIQUE;
ALTER TABLE challenges ADD COLUMN moderation text CHECK (moderation IN ('pre', 'post'));

-- Consent texts, versioned: terms of use per tenant ('terms') and the text on usage rights and
-- confidentiality per challenge ('challenge'). A new text is a new version; old versions stay.
CREATE TABLE consent_texts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('terms', 'challenge')),
  challenge_id uuid REFERENCES challenges(id) ON DELETE CASCADE,
  version int NOT NULL CHECK (version >= 1),
  body text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'terms') = (challenge_id IS NULL))
);
CREATE UNIQUE INDEX consent_texts_version ON consent_texts (tenant_id, kind, coalesce(challenge_id, '00000000-0000-0000-0000-000000000000'::uuid), version);

-- Consent log: who accepted which version when. Append-only for the application.
CREATE TABLE consents (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  consent_text_id uuid NOT NULL REFERENCES consent_texts(id) ON DELETE CASCADE,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, consent_text_id)
);

-- Which challenges an external person may take part in, and how they got access.
CREATE TABLE external_access (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge_id uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  via text NOT NULL CHECK (via IN ('link', 'invite')),
  invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, challenge_id)
);
CREATE INDEX external_access_challenge ON external_access (challenge_id);

-- Reports ("Melden") of ideas and comments; the moderation works them off in a queue.
CREATE TABLE content_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  comment_id uuid REFERENCES comments(id) ON DELETE CASCADE,
  reporter_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reason text NOT NULL CHECK (reason IN ('spam', 'offensive', 'confidential', 'other')),
  note text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'hidden')),
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX content_reports_open ON content_reports (reporter_id, idea_id, coalesce(comment_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE status = 'open';
CREATE INDEX content_reports_queue ON content_reports (tenant_id, status);

-- Feature requests with voting and a public status page (R3-20).
CREATE TABLE feature_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number int NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'planned', 'in_progress', 'done', 'declined')),
  status_note text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);

-- One vote per person and request.
CREATE TABLE feature_votes (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES feature_requests(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, user_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['consent_texts', 'consents', 'external_access', 'content_reports', 'feature_requests', 'feature_votes']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('CREATE POLICY owner_all ON %I TO %I USING (true) WITH CHECK (true)', t, current_user);
  END LOOP;
END $$;

-- Consent texts and the consent log are never changed or deleted by the application.
GRANT SELECT, INSERT ON consent_texts, consents TO ideenportal_app;
GRANT USAGE ON SEQUENCE consents_id_seq TO ideenportal_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON external_access, feature_votes TO ideenportal_app;
GRANT SELECT, INSERT, UPDATE ON content_reports, feature_requests TO ideenportal_app;
