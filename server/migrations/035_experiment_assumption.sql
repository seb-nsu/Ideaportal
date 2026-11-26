-- Experiment result feeds the business case (after founder-skill "launch": a real test beats an
-- estimate). The experiment names the assumption it measures; the measured value is taken over
-- into the business case only by a person's click (applied_at).
ALTER TABLE experiments
  ADD COLUMN assumption_id text CHECK (assumption_id ~ '^[a-z0-9_]{1,40}$'),
  ADD COLUMN measured_value numeric,
  ADD COLUMN applied_at timestamptz;
