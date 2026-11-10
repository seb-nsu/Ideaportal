-- Hardening before the public demo and the pilot (AP-01: R1-44, R1-45).
-- Rate limits and security events are platform data, not tenant data: they hold no idea
-- content, only hashed keys (IP address or e-mail). The app role gets no access; only the
-- owner connection (login, sign-up, demo) reads and writes them.

CREATE TABLE rate_limits (
  bucket text NOT NULL,
  key_hash text NOT NULL,
  window_start timestamptz NOT NULL DEFAULT now(),
  hits int NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, key_hash)
);
CREATE INDEX rate_limits_window ON rate_limits (window_start);

CREATE TABLE security_events (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  bucket text,
  key_hash text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX security_events_time ON security_events (created_at DESC);

ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limits FORCE ROW LEVEL SECURITY;
ALTER TABLE security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_events FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  EXECUTE format('CREATE POLICY owner_all ON rate_limits TO %I USING (true) WITH CHECK (true)', current_user);
  EXECUTE format('CREATE POLICY owner_all ON security_events TO %I USING (true) WITH CHECK (true)', current_user);
END $$;
REVOKE ALL ON rate_limits, security_events FROM ideenportal_app;
