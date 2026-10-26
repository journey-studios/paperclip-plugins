CREATE TABLE IF NOT EXISTS plugin_social_publisher_f5a795450a.social_accounts (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('instagram', 'facebook_page', 'threads', 'x')),
  account_name text NOT NULL,
  account_id_external text NOT NULL,
  credentials_ref jsonb NOT NULL,
  scopes text NOT NULL DEFAULT '',
  policy text NOT NULL CHECK (policy IN ('disabled', 'approval_required', 'autonomous')),
  autonomous_opt_in boolean NOT NULL DEFAULT false,
  kill_switch boolean NOT NULL DEFAULT false,
  daily_limit integer NOT NULL DEFAULT 10 CHECK (daily_limit >= 0),
  posts_today integer NOT NULL DEFAULT 0 CHECK (posts_today >= 0),
  last_reset_date text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'expired', 'revoked', 'rate_limited', 'error')),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS social_accounts_company_platform_external_idx
  ON plugin_social_publisher_f5a795450a.social_accounts (company_id, platform, account_id_external);

CREATE INDEX IF NOT EXISTS social_accounts_company_platform_status_idx
  ON plugin_social_publisher_f5a795450a.social_accounts (company_id, platform, status);

CREATE TABLE IF NOT EXISTS plugin_social_publisher_f5a795450a.social_posts (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  project_id uuid,
  idempotency_key uuid NOT NULL,
  campaign text,
  default_text text NOT NULL,
  platforms jsonb NOT NULL,
  platform_customizations jsonb NOT NULL DEFAULT '{}'::jsonb,
  media_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL CHECK (status IN ('draft', 'pending_approval', 'approved', 'scheduled', 'publishing', 'published', 'partially_published', 'failed', 'cancelled')),
  scheduled_at timestamptz,
  published_at timestamptz,
  approved_at timestamptz,
  approved_by text,
  created_by_type text NOT NULL CHECK (created_by_type IN ('user', 'agent')),
  created_by_id text NOT NULL,
  created_by_run_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS social_posts_company_idempotency_idx
  ON plugin_social_publisher_f5a795450a.social_posts (company_id, idempotency_key);

CREATE INDEX IF NOT EXISTS social_posts_company_status_idx
  ON plugin_social_publisher_f5a795450a.social_posts (company_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS social_posts_company_scheduled_idx
  ON plugin_social_publisher_f5a795450a.social_posts (company_id, scheduled_at)
  WHERE status = 'scheduled';

CREATE TABLE IF NOT EXISTS plugin_social_publisher_f5a795450a.social_receipts (
  id uuid PRIMARY KEY,
  post_id uuid NOT NULL REFERENCES plugin_social_publisher_f5a795450a.social_posts(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('instagram', 'facebook_page', 'threads', 'x')),
  account_id uuid,
  status text NOT NULL CHECK (status IN ('published', 'failed', 'reconciled')),
  platform_post_id text,
  platform_post_url text,
  error_message text,
  raw_response jsonb,
  attempt_count integer NOT NULL DEFAULT 1,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  reconciled_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS social_receipts_post_platform_idx
  ON plugin_social_publisher_f5a795450a.social_receipts (post_id, platform);

CREATE TABLE IF NOT EXISTS plugin_social_publisher_f5a795450a.social_audit_log (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  post_id uuid,
  account_id uuid,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  run_id text,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS social_audit_log_company_created_idx
  ON plugin_social_publisher_f5a795450a.social_audit_log (company_id, created_at DESC);
