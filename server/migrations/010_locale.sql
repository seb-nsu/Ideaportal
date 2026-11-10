-- Text catalogue (AP-06, R2-50): language per person for the interface, API errors and mails.
ALTER TABLE users ADD COLUMN locale text NOT NULL DEFAULT 'de' CHECK (locale IN ('de', 'en'));
