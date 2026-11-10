-- Privacy proof per AI analysis (AP-04, R2-42): hosting of the provider at the time of the
-- call, so the proof stays correct when the configuration changes later.
ALTER TABLE ai_actions ADD COLUMN hosting text CHECK (hosting IN ('local', 'eu', 'other'));
