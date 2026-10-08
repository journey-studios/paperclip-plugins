CREATE TABLE IF NOT EXISTS plugin_s3_storage_ebdcdaf770.objects (
  object_id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  project_id uuid,
  idempotency_key uuid NOT NULL,
  object_key text NOT NULL,
  staging_key text NOT NULL,
  staging_version_id text,
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  content_type text NOT NULL CHECK (length(content_type) BETWEEN 1 AND 160),
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('pending', 'ready')),
  storage_fingerprint char(64) NOT NULL CHECK (storage_fingerprint ~ '^[a-f0-9]{64}$'),
  provider text NOT NULL CHECK (provider IN ('s3', 'aws', 'r2', 'backblaze')),
  bucket text NOT NULL,
  endpoint text,
  region text NOT NULL,
  key_prefix text NOT NULL,
  upload_expires_at timestamptz NOT NULL,
  created_by_type text NOT NULL CHECK (created_by_type IN ('user', 'agent')),
  created_by_id text NOT NULL,
  created_by_run_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz
);

ALTER TABLE plugin_s3_storage_ebdcdaf770.objects
  ADD COLUMN IF NOT EXISTS staging_version_id text;

CREATE UNIQUE INDEX IF NOT EXISTS objects_company_project_idempotency_idx
  ON plugin_s3_storage_ebdcdaf770.objects (
    company_id,
    COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid),
    idempotency_key
  );

CREATE INDEX IF NOT EXISTS objects_company_status_created_idx
  ON plugin_s3_storage_ebdcdaf770.objects (company_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS objects_company_project_created_idx
  ON plugin_s3_storage_ebdcdaf770.objects (company_id, project_id, created_at DESC);
