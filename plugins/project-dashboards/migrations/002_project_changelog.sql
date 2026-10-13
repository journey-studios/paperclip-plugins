CREATE TABLE IF NOT EXISTS plugin_project_dashboards_54173784c0.changelog_entries (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('milestone', 'release', 'feature', 'fix', 'improvement', 'decision', 'incident', 'note', 'issue')),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  body text CHECK (body IS NULL OR length(body) <= 20000),
  version text CHECK (version IS NULL OR length(version) BETWEEN 1 AND 64),
  refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(refs) = 'array'),
  links jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(links) = 'array'),
  occurred_at timestamptz NOT NULL,
  issue_id uuid,
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('agent', 'user', 'system')),
  created_by_id text,
  updated_by_kind text NOT NULL CHECK (updated_by_kind IN ('agent', 'user', 'system')),
  updated_by_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK ((kind = 'issue') = (issue_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS changelog_issue_uidx
  ON plugin_project_dashboards_54173784c0.changelog_entries (company_id, issue_id)
  WHERE issue_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS changelog_project_idx
  ON plugin_project_dashboards_54173784c0.changelog_entries (company_id, project_id, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS changelog_company_idx
  ON plugin_project_dashboards_54173784c0.changelog_entries (company_id, occurred_at DESC, id DESC);
