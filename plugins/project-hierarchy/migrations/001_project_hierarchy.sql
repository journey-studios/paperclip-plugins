-- One row per sub-project: the project and the parent it sits under. Top-level
-- projects have no row. Paperclip core keeps no parent column, so the relation
-- lives here and the worker enforces same-company and acyclic links.
CREATE TABLE IF NOT EXISTS plugin_project_hierarchy_f21f3d006f.project_parents (
  project_id uuid PRIMARY KEY REFERENCES public.projects(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- Deleting a parent drops the link, which promotes its sub-projects to top level.
  parent_project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  updated_by_kind text NOT NULL CHECK (updated_by_kind IN ('agent', 'user', 'system')),
  updated_by_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_project_id <> project_id)
);

CREATE INDEX IF NOT EXISTS project_parents_parent_idx
  ON plugin_project_hierarchy_f21f3d006f.project_parents (company_id, parent_project_id);
