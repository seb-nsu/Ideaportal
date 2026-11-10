-- AP-19 (R3-29): areas as master data and roles with a scope.
--
-- An area (Bereich) is e.g. a business unit or a topic field. An idea belongs to every area
-- whose topic list contains the idea's topic OR whose org unit list contains the org unit of
-- the idea's author (case-insensitive). An idea can belong to several areas or to none; ideas
-- without an area are handled by people with tenant-wide roles only.
--
-- Tenant-wide roles stay in users.roles. role_assignments holds roles that apply to one area
-- only (triage, committee, lead). source = 'idp' marks assignments from the group mapping of
-- the identity provider (R3-26/R3-27); they are recomputed on every sync.

CREATE TABLE areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  topics text[] NOT NULL DEFAULT '{}',
  org_units text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX areas_name ON areas (tenant_id, lower(name));

CREATE TABLE role_assignments (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('triage', 'committee', 'lead')),
  area_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'idp')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role, area_id),
  -- Foreign key checks bypass row-level security: the composite key keeps the area in the same tenant.
  FOREIGN KEY (tenant_id, area_id) REFERENCES areas (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX role_assignments_area ON role_assignments (area_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['areas', 'role_assignments']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('CREATE POLICY owner_all ON %I TO %I USING (true) WITH CHECK (true)', t, current_user);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON areas, role_assignments TO ideenportal_app;

-- Membership rule in one place. SECURITY INVOKER (default): row-level security applies.
CREATE FUNCTION idea_in_area(p_topic text, p_org_unit text, a areas) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT (p_topic IS NOT NULL AND p_topic = ANY(a.topics))
      OR (p_org_unit IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(a.org_units) x WHERE lower(x) = lower(p_org_unit)))
$$;

-- Areas of one idea.
CREATE FUNCTION idea_area_ids(p_idea uuid) RETURNS uuid[]
  LANGUAGE sql STABLE AS $$
  SELECT coalesce(array_agg(a.id), '{}')
    FROM ideas i LEFT JOIN users u ON u.id = i.author_id
    JOIN areas a ON a.tenant_id = i.tenant_id
   WHERE i.id = p_idea AND idea_in_area(i.topic, u.org_unit, a)
$$;

-- Ideas of a set of areas (filters of board, dashboard and tasks).
CREATE FUNCTION ideas_in_areas(p_areas uuid[]) RETURNS TABLE (idea_id uuid)
  LANGUAGE sql STABLE AS $$
  SELECT i.id FROM ideas i LEFT JOIN users u ON u.id = i.author_id
   WHERE EXISTS (SELECT 1 FROM areas a WHERE a.id = ANY(p_areas) AND idea_in_area(i.topic, u.org_unit, a))
$$;

-- True when the person holds one of the roles with a scope that covers the idea.
CREATE FUNCTION has_area_role(p_user uuid, p_roles text[], p_idea uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM role_assignments ra
                  WHERE ra.user_id = p_user AND ra.role = ANY(p_roles) AND ra.area_id = ANY(idea_area_ids(p_idea)))
$$;
