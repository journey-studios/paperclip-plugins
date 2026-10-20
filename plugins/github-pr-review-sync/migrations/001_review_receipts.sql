CREATE TABLE IF NOT EXISTS plugin_github_pr_review_sync_d11948765a.review_receipts (
  receipt_key text PRIMARY KEY,
  company_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  decision_id text NOT NULL,
  owner text NOT NULL,
  repo text NOT NULL,
  pull_number integer NOT NULL CHECK (pull_number > 0),
  head_sha char(40) NOT NULL,
  github_event text NOT NULL CHECK (github_event IN ('APPROVE', 'REQUEST_CHANGES', 'COMMENT')),
  status text NOT NULL CHECK (status IN ('published', 'pending_identity', 'failed', 'skipped_no_pr', 'skipped_stale')),
  github_review_id text,
  github_review_url text,
  error_code text,
  error_message text,
  marker text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS review_receipts_company_issue_idx
  ON plugin_github_pr_review_sync_d11948765a.review_receipts (company_id, issue_id, created_at DESC);

CREATE INDEX IF NOT EXISTS review_receipts_pending_idx
  ON plugin_github_pr_review_sync_d11948765a.review_receipts (company_id, status)
  WHERE status IN ('pending_identity', 'failed');
