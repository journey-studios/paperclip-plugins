CREATE TABLE plugin_performance_observatory_27b58b0e8b.runs (
 id uuid PRIMARY KEY,
 company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
 project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
 target_key text NOT NULL, title text NOT NULL,
 environment text NOT NULL CHECK (environment IN ('prod','staging','test')),
 scenario text NOT NULL, profile text NOT NULL,
 status text NOT NULL CHECK (status IN ('queued','running','passed','regression','failed')),
 source text NOT NULL, request_key text NOT NULL,
 target_snapshot jsonb NOT NULL, result jsonb, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 UNIQUE (company_id, request_key)
);
CREATE INDEX performance_runs_company_time ON plugin_performance_observatory_27b58b0e8b.runs (company_id, created_at DESC, id DESC);
CREATE INDEX performance_runs_pending ON plugin_performance_observatory_27b58b0e8b.runs (company_id, status, created_at);
