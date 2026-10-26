CREATE TABLE IF NOT EXISTS plugin_social_publisher_f5a795450a.social_metric_snapshots (
 id uuid PRIMARY KEY,
 company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
 post_id uuid NOT NULL REFERENCES plugin_social_publisher_f5a795450a.social_posts(id),
 platform text NOT NULL,
 account_id uuid,
 external_post_id text NOT NULL,
 metrics jsonb NOT NULL,
 status text NOT NULL,
 collected_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS social_metrics_post_idx ON plugin_social_publisher_f5a795450a.social_metric_snapshots(company_id, post_id, collected_at DESC);
CREATE TABLE IF NOT EXISTS plugin_social_publisher_f5a795450a.social_metric_read_budgets (
 company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
 account_id uuid NOT NULL,
 day date NOT NULL,
 reads integer NOT NULL DEFAULT 0,
 reserved_cost_cents integer NOT NULL DEFAULT 0,
 PRIMARY KEY(company_id,account_id,day)
);
