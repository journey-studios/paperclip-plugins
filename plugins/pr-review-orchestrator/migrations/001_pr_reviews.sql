-- Durable, per-commit review work. Every PR SHA is reviewed at most once
-- unless explicitly retried after a documented failure.
CREATE TABLE IF NOT EXISTS plugin_pr_review_orchestrator_167e9509eb.review_jobs (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  project_id uuid NOT NULL,
  reviewer_agent_id uuid NOT NULL,
  repository text NOT NULL,
  pr_number integer NOT NULL CHECK (pr_number > 0),
  head_sha text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}
  pr_url text NOT NULL,
  pr_title text NOT NULL,
  base_ref text NOT NULL,
  author_login text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','dispatching','running','awaiting_publication','failed','superseded','closed')),
  issue_id uuid,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  priority integer NOT NULL DEFAULT 50,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  dispatch_lease_until timestamptz,
  wake_run_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, repository, pr_number, head_sha)
);
CREATE INDEX IF NOT EXISTS review_jobs_ready_idx
  ON plugin_pr_review_orchestrator_167e9509eb.review_jobs
  (company_id, status, next_attempt_at, priority DESC, created_at ASC);

-- The database, not a worker process Map, serializes work for one agent.
-- The index prevents two workers/webhooks/jobs from dispatching concurrently.
CREATE UNIQUE INDEX IF NOT EXISTS review_jobs_active_reviewer_idx
  ON plugin_pr_review_orchestrator_167e9509eb.review_jobs
  (company_id, reviewer_agent_id)
  WHERE status IN ('dispatching','running');
),
  remote_updated_at timestamptz NOT NULL,
  pr_url text NOT NULL,
  pr_title text NOT NULL,
  base_ref text NOT NULL,
  author_login text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','dispatching','running','awaiting_publication','failed','superseded','closed')),
  issue_id uuid,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  priority integer NOT NULL DEFAULT 50,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  dispatch_lease_until timestamptz,
  wake_run_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, repository, pr_number, head_sha)
);
CREATE INDEX IF NOT EXISTS review_jobs_ready_idx
  ON plugin_pr_review_orchestrator_167e9509eb.review_jobs
  (company_id, status, next_attempt_at, priority DESC, created_at ASC);

-- The database, not a worker process Map, serializes work for one agent.
-- The index prevents two workers/webhooks/jobs from dispatching concurrently.
CREATE UNIQUE INDEX IF NOT EXISTS review_jobs_active_reviewer_idx
  ON plugin_pr_review_orchestrator_167e9509eb.review_jobs
  (company_id, reviewer_agent_id)
  WHERE status IN ('dispatching','running');
