-- Self-service for workspaces without a company login: join links and sign-up metadata.
ALTER TABLE tenants ADD COLUMN join_code text UNIQUE;
ALTER TABLE tenants ADD COLUMN created_via text NOT NULL DEFAULT 'admin' CHECK (created_via IN ('admin', 'signup', 'demo'));
