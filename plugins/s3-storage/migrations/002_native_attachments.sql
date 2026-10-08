CREATE TABLE IF NOT EXISTS plugin_s3_storage_ebdcdaf770.native_objects (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  native_key text NOT NULL,
  physical_key text NOT NULL UNIQUE,
  staging_key text NOT NULL,
  staging_version_id text,
  physical_version_id text,
  etag text,
  last_modified timestamptz,
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  content_type text NOT NULL CHECK (length(content_type) BETWEEN 1 AND 160),
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('pending', 'ready', 'deleted')),
  storage_fingerprint char(64) NOT NULL CHECK (storage_fingerprint ~ '^[a-f0-9]{64}$'),
  provider text NOT NULL CHECK (provider IN ('s3', 'aws', 'r2', 'backblaze')),
  bucket text NOT NULL,
  endpoint text,
  region text NOT NULL,
  key_prefix text NOT NULL,
  upload_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  deleted_at timestamptz,
  PRIMARY KEY (company_id, native_key),
  CHECK (native_key <> ''),
  CHECK (octet_length(native_key) <= 1024)
);

CREATE INDEX IF NOT EXISTS native_objects_company_status_idx
  ON plugin_s3_storage_ebdcdaf770.native_objects (company_id, status, updated_at DESC);
