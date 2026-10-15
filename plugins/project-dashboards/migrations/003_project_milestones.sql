-- Project milestones are planning outcomes, not executable Issues or strategic Goals.
CREATE TABLE IF NOT EXISTS plugin_project_dashboards_54173784c0.milestones (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  description text CHECK (description IS NULL OR length(description) <= 10000),
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_progress', 'completed', 'cancelled')),
  target_date date,
  criteria jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(criteria) = 'array'),
  issue_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(issue_ids) = 'array'),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array'),
  completed_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('agent','user','system')),
  created_by_id text,
  updated_by_kind text NOT NULL CHECK (updated_by_kind IN ('agent','user','system')),
  updated_by_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS milestones_project_idx
  ON plugin_project_dashboards_54173784c0.milestones
  (company_id, project_id, target_date ASC NULLS LAST, created_at ASC);

-- An automatically recorded completion must be idempotent, including after a reopen/recompletion.
ALTER TABLE plugin_project_dashboards_54173784c0.changelog_entries
  ADD COLUMN IF NOT EXISTS milestone_id uuid
  REFERENCES plugin_project_dashboards_54173784c0.milestones(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS changelog_milestone_uidx
  ON plugin_project_dashboards_54173784c0.changelog_entries (company_id, milestone_id)
  WHERE milestone_id IS NOT NULL;
