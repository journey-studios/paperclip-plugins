CREATE TABLE IF NOT EXISTS plugin_project_dashboards_54173784c0.dashboards (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9-]{1,64}$'),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  spec jsonb NOT NULL CHECK (jsonb_typeof(spec) = 'object'),
  revision integer NOT NULL CHECK (revision >= 1),
  updated_by_kind text NOT NULL CHECK (updated_by_kind IN ('agent', 'user', 'system')),
  updated_by_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, slug)
);

CREATE INDEX IF NOT EXISTS dashboards_project_idx
  ON plugin_project_dashboards_54173784c0.dashboards (company_id, project_id);

CREATE TABLE IF NOT EXISTS plugin_project_dashboards_54173784c0.dashboard_revisions (
  dashboard_id uuid NOT NULL REFERENCES plugin_project_dashboards_54173784c0.dashboards(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 1),
  spec jsonb NOT NULL CHECK (jsonb_typeof(spec) = 'object'),
  updated_by_kind text NOT NULL CHECK (updated_by_kind IN ('agent', 'user', 'system')),
  updated_by_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dashboard_id, revision)
);
