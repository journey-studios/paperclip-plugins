CREATE TABLE IF NOT EXISTS plugin_artifact_library_ca55530627.folders (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  parent_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  CHECK (parent_id IS DISTINCT FROM id),
  FOREIGN KEY (company_id, parent_id) REFERENCES plugin_artifact_library_ca55530627.folders(company_id, id) ON DELETE SET NULL (parent_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS folders_sibling_name_idx
  ON plugin_artifact_library_ca55530627.folders (company_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

CREATE TABLE IF NOT EXISTS plugin_artifact_library_ca55530627.tags (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 50),
  color text NOT NULL DEFAULT 'slate' CHECK (color IN ('slate', 'blue', 'green', 'amber', 'rose', 'violet')),
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS tags_active_name_idx
  ON plugin_artifact_library_ca55530627.tags (company_id, lower(name)) WHERE archived = false;

CREATE TABLE IF NOT EXISTS plugin_artifact_library_ca55530627.artifact_metadata (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  artifact_id text NOT NULL CHECK (length(artifact_id) BETWEEN 1 AND 500),
  folder_id uuid,
  tag_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  starred boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, artifact_id),
  FOREIGN KEY (company_id, folder_id) REFERENCES plugin_artifact_library_ca55530627.folders(company_id, id) ON DELETE SET NULL (folder_id)
);

CREATE INDEX IF NOT EXISTS artifact_metadata_folder_idx
  ON plugin_artifact_library_ca55530627.artifact_metadata (company_id, folder_id);
CREATE INDEX IF NOT EXISTS artifact_metadata_starred_idx
  ON plugin_artifact_library_ca55530627.artifact_metadata (company_id) WHERE starred = true;
CREATE INDEX IF NOT EXISTS artifact_metadata_tags_idx
  ON plugin_artifact_library_ca55530627.artifact_metadata USING gin (tag_ids);

CREATE TABLE IF NOT EXISTS plugin_artifact_library_ca55530627.saved_views (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  filters jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(filters) = 'object'),
  layout text NOT NULL DEFAULT 'grid' CHECK (layout IN ('grid', 'list')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS saved_views_name_idx
  ON plugin_artifact_library_ca55530627.saved_views (company_id, lower(name));
