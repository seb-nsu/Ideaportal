-- AP-22 Einsatzfelder: problem exchange (R3-31), sustainability challenge with kWh (R3-32),
-- challenge with target value and controlling confirmation (R3-33), hackathon mode (R3-34).

-- R3-31: a submission is an idea or a problem without (or with an optional) solution.
-- The kind is separate from idea_type (internal/product), which keeps steering the AI analysis.
ALTER TABLE ideas ADD COLUMN idea_kind text NOT NULL DEFAULT 'idea' CHECK (idea_kind IN ('idea', 'problem'));
-- Community solutions for problems are comments of kind 'solution'.
ALTER TABLE comments ADD COLUMN kind text NOT NULL DEFAULT 'comment' CHECK (kind IN ('comment', 'solution'));
-- A challenge that triage made from a problem keeps the link to it.
ALTER TABLE challenges ADD COLUMN source_idea_id uuid REFERENCES ideas(id) ON DELETE SET NULL;

-- R3-32: benefit kind kWh (per year).
ALTER TABLE implementations DROP CONSTRAINT IF EXISTS implementations_benefit_kind_check;
ALTER TABLE implementations ADD CONSTRAINT implementations_benefit_kind_check
  CHECK (benefit_kind IN ('euro', 'hours', 'quality', 'revenue', 'co2', 'kwh'));

-- R3-33: target value with benefit kind and period per challenge, optional confirming person.
ALTER TABLE challenges ADD COLUMN target_kind text CHECK (target_kind IN ('euro', 'hours', 'revenue', 'co2', 'kwh'));
ALTER TABLE challenges ADD COLUMN target_value numeric CHECK (target_value IS NULL OR target_value > 0);
ALTER TABLE challenges ADD COLUMN target_from date;
ALTER TABLE challenges ADD COLUMN target_until date;
ALTER TABLE challenges ADD COLUMN confirmer_id uuid REFERENCES users(id) ON DELETE SET NULL;

-- One confirmation per actual benefit (implementation): confirmed as reported or corrected, always with a comment.
CREATE TABLE benefit_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL UNIQUE REFERENCES ideas(id) ON DELETE CASCADE,
  implementation_id uuid NOT NULL REFERENCES implementations(id) ON DELETE CASCADE,
  outcome text NOT NULL CHECK (outcome IN ('confirmed', 'corrected')),
  benefit_kind text NOT NULL,
  estimated_value numeric,
  confirmed_value numeric NOT NULL CHECK (confirmed_value >= 0),
  comment text NOT NULL,
  confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX benefit_confirmations_tenant ON benefit_confirmations (tenant_id);

ALTER TABLE benefit_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE benefit_confirmations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON benefit_confirmations USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
DO $$
BEGIN
  EXECUTE format('CREATE POLICY owner_all ON benefit_confirmations TO %I USING (true) WITH CHECK (true)', current_user);
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON benefit_confirmations TO ideenportal_app;

-- R3-34: hackathon mode with submission window, pitch order, audience voting and combined ranking.
ALTER TABLE challenges ADD COLUMN hackathon boolean NOT NULL DEFAULT false;
ALTER TABLE challenges ADD COLUMN submission_opens_at timestamptz;
ALTER TABLE challenges ADD COLUMN submission_closes_at timestamptz;
ALTER TABLE challenges ADD COLUMN pitch_order uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE challenges ADD COLUMN pitch_minutes integer NOT NULL DEFAULT 5 CHECK (pitch_minutes BETWEEN 1 AND 60);
ALTER TABLE challenges ADD COLUMN audience_voting boolean NOT NULL DEFAULT false;
-- Share of the audience in the combined ranking in percent; the jury has the rest.
ALTER TABLE challenges ADD COLUMN audience_weight integer NOT NULL DEFAULT 30 CHECK (audience_weight BETWEEN 0 AND 100);

-- One audience vote per person and challenge (changeable while voting is open). The person is
-- stored only to keep the vote unique; the API returns counts per idea, never who voted for what.
CREATE TABLE challenge_audience_votes (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  challenge_id uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (challenge_id, user_id)
);
CREATE INDEX challenge_audience_votes_idea ON challenge_audience_votes (idea_id);

ALTER TABLE challenge_audience_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE challenge_audience_votes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON challenge_audience_votes USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
DO $$
BEGIN
  EXECUTE format('CREATE POLICY owner_all ON challenge_audience_votes TO %I USING (true) WITH CHECK (true)', current_user);
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON challenge_audience_votes TO ideenportal_app;
