ALTER TABLE plugin_social_publisher_f5a795450a.social_accounts ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'CONNECTED_UNVERIFIED';
ALTER TABLE plugin_social_publisher_f5a795450a.social_accounts ADD COLUMN IF NOT EXISTS verified_at timestamptz;
ALTER TABLE plugin_social_publisher_f5a795450a.social_accounts ADD COLUMN IF NOT EXISTS allowed_agent_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE plugin_social_publisher_f5a795450a.social_accounts ADD COLUMN IF NOT EXISTS api_cost_approved boolean NOT NULL DEFAULT false;
ALTER TABLE plugin_social_publisher_f5a795450a.social_accounts ADD COLUMN IF NOT EXISTS estimated_post_cost_cents integer;
ALTER TABLE plugin_social_publisher_f5a795450a.social_accounts ADD COLUMN IF NOT EXISTS daily_cost_limit_cents integer NOT NULL DEFAULT 0;
ALTER TABLE plugin_social_publisher_f5a795450a.social_accounts ADD COLUMN IF NOT EXISTS cost_today_cents integer NOT NULL DEFAULT 0;
ALTER TABLE plugin_social_publisher_f5a795450a.social_posts ALTER COLUMN idempotency_key TYPE text;
ALTER TABLE plugin_social_publisher_f5a795450a.social_posts DROP CONSTRAINT IF EXISTS social_posts_status_check;
ALTER TABLE plugin_social_publisher_f5a795450a.social_posts ADD CONSTRAINT social_posts_status_check CHECK(status IN ('draft','pending_approval','approved','scheduled','publishing','published','partially_published','failed','cancelled','rejected','revision_requested','superseded','dry_run_completed','retry','unknown'));
ALTER TABLE plugin_social_publisher_f5a795450a.social_posts ADD COLUMN IF NOT EXISTS root_post_id uuid;
UPDATE plugin_social_publisher_f5a795450a.social_posts SET root_post_id=id WHERE root_post_id IS NULL;
ALTER TABLE plugin_social_publisher_f5a795450a.social_posts ALTER COLUMN root_post_id SET NOT NULL;
ALTER TABLE plugin_social_publisher_f5a795450a.social_posts ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE plugin_social_publisher_f5a795450a.social_posts ADD COLUMN IF NOT EXISTS content_hash text NOT NULL DEFAULT '';
ALTER TABLE plugin_social_publisher_f5a795450a.social_posts ADD COLUMN IF NOT EXISTS semantic_hash text NOT NULL DEFAULT '';
ALTER TABLE plugin_social_publisher_f5a795450a.social_posts ADD COLUMN IF NOT EXISTS targets jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE plugin_social_publisher_f5a795450a.social_posts ADD COLUMN IF NOT EXISTS link_url text;
ALTER TABLE plugin_social_publisher_f5a795450a.social_posts ADD COLUMN IF NOT EXISTS dry_run boolean NOT NULL DEFAULT true;
ALTER TABLE plugin_social_publisher_f5a795450a.social_posts ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
ALTER TABLE plugin_social_publisher_f5a795450a.social_posts ADD COLUMN IF NOT EXISTS approval_hash text;
ALTER TABLE plugin_social_publisher_f5a795450a.social_posts ADD COLUMN IF NOT EXISTS approval_expires_at timestamptz;
ALTER TABLE plugin_social_publisher_f5a795450a.social_posts ADD COLUMN IF NOT EXISTS approval_request_id text;
ALTER TABLE plugin_social_publisher_f5a795450a.social_posts ADD COLUMN IF NOT EXISTS decision_reason text;
CREATE UNIQUE INDEX IF NOT EXISTS social_posts_root_version ON plugin_social_publisher_f5a795450a.social_posts(company_id,root_post_id,version);
CREATE UNIQUE INDEX IF NOT EXISTS social_posts_live_content_dedup ON plugin_social_publisher_f5a795450a.social_posts(company_id,semantic_hash) WHERE dry_run=false AND semantic_hash<>'' AND status NOT IN ('cancelled','rejected','superseded');
ALTER TABLE plugin_social_publisher_f5a795450a.social_receipts DROP CONSTRAINT IF EXISTS social_receipts_status_check;
ALTER TABLE plugin_social_publisher_f5a795450a.social_receipts ADD CONSTRAINT social_receipts_status_check CHECK(status IN ('published','failed','reconciled','processing','retry','unknown','blocked','dry_run'));
ALTER TABLE plugin_social_publisher_f5a795450a.social_receipts ADD COLUMN IF NOT EXISTS destination_key text NOT NULL DEFAULT '';
UPDATE plugin_social_publisher_f5a795450a.social_receipts SET destination_key=platform||':'||COALESCE(account_id::text,'unconnected') WHERE destination_key='';
ALTER TABLE plugin_social_publisher_f5a795450a.social_receipts ADD COLUMN IF NOT EXISTS error_code text;
ALTER TABLE plugin_social_publisher_f5a795450a.social_receipts ADD COLUMN IF NOT EXISTS checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE plugin_social_publisher_f5a795450a.social_receipts ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
ALTER TABLE plugin_social_publisher_f5a795450a.social_receipts ADD COLUMN IF NOT EXISTS cost_cents integer;
CREATE UNIQUE INDEX IF NOT EXISTS social_receipts_post_destination ON plugin_social_publisher_f5a795450a.social_receipts(post_id,destination_key);

CREATE TABLE IF NOT EXISTS plugin_social_publisher_f5a795450a.social_content_claims (
 id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
 account_id uuid NOT NULL, content_digest text NOT NULL, post_id uuid NOT NULL REFERENCES plugin_social_publisher_f5a795450a.social_posts(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(company_id,account_id,content_digest)
);
