ALTER TABLE plugin_social_publisher_f5a795450a.social_posts ADD COLUMN IF NOT EXISTS media_refs jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE TABLE IF NOT EXISTS plugin_social_publisher_f5a795450a.social_media (
 id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
 project_id uuid NOT NULL, object_id uuid NOT NULL, sha256 text NOT NULL CHECK(length(sha256)=64),
 byte_size integer NOT NULL CHECK(byte_size>0 AND byte_size<=8388608),
 content_type text NOT NULL CHECK(content_type='image/jpeg'), filename text NOT NULL,
 width integer NOT NULL, height integer NOT NULL, storage_fingerprint text NOT NULL,
 physical_version_id text, etag text NOT NULL, enrolled_by text NOT NULL,
 enrolled_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,object_id)
);
