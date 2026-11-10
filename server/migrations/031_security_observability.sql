-- Enterprise security and observability (docs/enterprise/sicherheit-und-beobachtbarkeit.md).
--
-- 1. Audit rows carry the request id, a keyed hash of the client address and the user agent.
--    The values come from transaction settings the server sets for every transaction of a
--    request (db/pool.ts), so every insert path is covered without changing it.
-- 2. Tamper-evident audit log: a hash chain per tenant. Each row stores its position in the
--    chain (chain_seq), the hash of the previous row (prev_hash) and its own hash
--    row_hash = sha256(prev_hash || audit_canonical(row)). The chain head per tenant lives in
--    audit_chain_heads; its row lock serializes the inserts of one tenant.
-- 3. SIEM forwarding per tenant (siem_settings): batches of audit rows, HMAC-signed.
-- 4. Session idle timeout: last_seen_at on sessions.

ALTER TABLE audit_log
  ADD COLUMN ip_hash text,
  ADD COLUMN user_agent text,
  ADD COLUMN request_id text,
  ADD COLUMN chain_seq bigint,
  ADD COLUMN prev_hash text,
  ADD COLUMN row_hash text;

CREATE TABLE audit_chain_heads (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  last_seq bigint NOT NULL,
  last_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE audit_chain_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_chain_heads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_chain_heads USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
DO $$ BEGIN EXECUTE format('CREATE POLICY owner_all ON audit_chain_heads TO %I USING (true) WITH CHECK (true)', current_user); END $$;
-- The app role reads the head of its own tenant (verification); only the trigger writes it.
GRANT SELECT ON audit_chain_heads TO ideenportal_app;

-- Canonical text of an audit row: a JSON array in fixed order. jsonb has one text form, the
-- time is UTC with microseconds. External verifiers (SIEM) rebuild the same text.
CREATE OR REPLACE FUNCTION audit_canonical(r audit_log) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_array(
    r.chain_seq, r.id, r.tenant_id, r.actor_id, r.action, r.entity, r.entity_id, r.before, r.after,
    to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    r.ip_hash, r.user_agent, r.request_id
  )::text
$$;

CREATE OR REPLACE FUNCTION audit_row_hash(prev text, r audit_log) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(prev || audit_canonical(r), 'UTF8')), 'hex')
$$;

-- Before every insert: request values from the transaction settings, then the chain link.
-- SECURITY DEFINER so the app role needs no write right on the chain heads.
CREATE OR REPLACE FUNCTION audit_log_chain() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  seq bigint;
  prev text;
BEGIN
  NEW.ip_hash := coalesce(NEW.ip_hash, nullif(current_setting('app.ip_hash', true), ''));
  NEW.user_agent := left(coalesce(NEW.user_agent, nullif(current_setting('app.user_agent', true), '')), 200);
  NEW.request_id := left(coalesce(NEW.request_id, nullif(current_setting('app.request_id', true), '')), 140);
  -- The row lock on the head serializes the inserts of one tenant until commit. Under
  -- REPEATABLE READ a concurrent insert raises a serialization error instead of forking the chain.
  INSERT INTO audit_chain_heads AS h (tenant_id, last_seq, last_hash) VALUES (NEW.tenant_id, 1, '')
  ON CONFLICT (tenant_id) DO UPDATE SET last_seq = h.last_seq + 1, updated_at = now()
  RETURNING h.last_seq, h.last_hash INTO seq, prev;
  IF prev = '' THEN
    prev := repeat('0', 64);
  END IF;
  NEW.chain_seq := seq;
  NEW.prev_hash := prev;
  NEW.row_hash := audit_row_hash(prev, NEW);
  UPDATE audit_chain_heads SET last_hash = NEW.row_hash WHERE tenant_id = NEW.tenant_id;
  RETURN NEW;
END $$;

-- Existing rows join the chain in the order of their ids (the append-only trigger is paused
-- for this one-time update inside the migration transaction).
ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update;
DO $$
DECLARE
  t uuid;
  r audit_log;
  seq bigint;
  prev text;
  h text;
BEGIN
  FOR t IN SELECT DISTINCT tenant_id FROM audit_log LOOP
    seq := 0;
    prev := repeat('0', 64);
    FOR r IN SELECT * FROM audit_log WHERE tenant_id = t ORDER BY id LOOP
      seq := seq + 1;
      r.chain_seq := seq;
      h := audit_row_hash(prev, r);
      UPDATE audit_log SET chain_seq = seq, prev_hash = prev, row_hash = h WHERE id = r.id;
      prev := h;
    END LOOP;
    INSERT INTO audit_chain_heads (tenant_id, last_seq, last_hash) VALUES (t, seq, prev);
  END LOOP;
END $$;
ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update;

ALTER TABLE audit_log ALTER COLUMN chain_seq SET NOT NULL, ALTER COLUMN prev_hash SET NOT NULL, ALTER COLUMN row_hash SET NOT NULL;
CREATE UNIQUE INDEX audit_log_chain ON audit_log (tenant_id, chain_seq);
CREATE INDEX audit_log_tenant_time ON audit_log (tenant_id, created_at);

CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_chain();

-- Verification of the chain of one tenant. Reports the first broken row: a gap in chain_seq
-- (deleted row), a wrong prev_hash (reordered or replaced row), a wrong row_hash (changed
-- content) or a head that does not match the last row (rows removed at the end).
-- Deleting a whole workspace (purge, migration 003) removes rows and head together; if a
-- future retention ever removes the oldest rows, the first remaining row is the anchor and
-- first_seq shows where the verified range starts.
CREATE OR REPLACE FUNCTION audit_verify(p_tenant uuid)
  RETURNS TABLE (ok boolean, checked bigint, first_seq bigint, last_seq bigint, broken_id bigint, broken_seq bigint, reason text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r audit_log;
  prev text;
  expected bigint;
  n bigint := 0;
  first bigint;
  head audit_chain_heads%ROWTYPE;
BEGIN
  -- The app role may only verify its own tenant (SET ROLE stays visible inside SECURITY DEFINER).
  IF current_setting('role') <> 'none' AND current_tenant() IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION 'audit_verify: tenant mismatch';
  END IF;
  FOR r IN SELECT * FROM audit_log a WHERE a.tenant_id = p_tenant ORDER BY a.chain_seq LOOP
    IF n = 0 THEN
      first := r.chain_seq;
      expected := r.chain_seq;
      prev := CASE WHEN r.chain_seq = 1 THEN repeat('0', 64) ELSE r.prev_hash END;
    END IF;
    IF r.chain_seq <> expected THEN
      RETURN QUERY SELECT false, n, first, expected - 1, r.id, r.chain_seq, 'gap'::text;
      RETURN;
    END IF;
    IF r.prev_hash IS DISTINCT FROM prev THEN
      RETURN QUERY SELECT false, n, first, expected - 1, r.id, r.chain_seq, 'prev_hash'::text;
      RETURN;
    END IF;
    IF r.row_hash IS DISTINCT FROM audit_row_hash(prev, r) THEN
      RETURN QUERY SELECT false, n, first, expected - 1, r.id, r.chain_seq, 'row_hash'::text;
      RETURN;
    END IF;
    prev := r.row_hash;
    expected := expected + 1;
    n := n + 1;
  END LOOP;
  SELECT * INTO head FROM audit_chain_heads h WHERE h.tenant_id = p_tenant;
  IF FOUND AND (n = 0 OR head.last_seq <> expected - 1 OR head.last_hash <> prev) THEN
    RETURN QUERY SELECT false, n, first, CASE WHEN n = 0 THEN NULL ELSE expected - 1 END, NULL::bigint,
      CASE WHEN n = 0 THEN 1 ELSE expected END, 'tail'::text;
    RETURN;
  END IF;
  RETURN QUERY SELECT true, n, first, CASE WHEN n = 0 THEN NULL ELSE expected - 1 END, NULL::bigint, NULL::bigint, NULL::text;
END $$;
GRANT EXECUTE ON FUNCTION audit_verify(uuid) TO ideenportal_app;

-- SIEM forwarding (one target per tenant): forwarded_seq is the last chain position sent.
CREATE TABLE siem_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  url text NOT NULL,
  secret_enc text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  forwarded_seq bigint NOT NULL DEFAULT 0,
  failure_count int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE siem_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE siem_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON siem_settings USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
DO $$ BEGIN EXECUTE format('CREATE POLICY owner_all ON siem_settings TO %I USING (true) WITH CHECK (true)', current_user); END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON siem_settings TO ideenportal_app;

-- Session idle timeout (per tenant setting security.sessionIdleMinutes, 0 = off).
ALTER TABLE sessions ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();
