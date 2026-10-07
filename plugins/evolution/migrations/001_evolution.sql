CREATE TABLE plugin_evolution_4399b11512.change_sets (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  hypothesis text,
  status text NOT NULL DEFAULT 'applied',
  causality_level text NOT NULL DEFAULT 'observed',
  source_context_key text,
  applied_at timestamptz NOT NULL DEFAULT now(),
  validation_ends_at timestamptz,
  created_by_type text,
  created_by_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX evolution_change_sets_context_uq
  ON plugin_evolution_4399b11512.change_sets(company_id, source_context_key)
  WHERE source_context_key IS NOT NULL;
CREATE INDEX evolution_change_sets_company_status_idx
  ON plugin_evolution_4399b11512.change_sets(company_id, status, applied_at DESC);

CREATE TABLE plugin_evolution_4399b11512.change_snapshots (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  entity_name text,
  snapshot_hash text NOT NULL,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_type text NOT NULL,
  source_ref text,
  captured_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evolution_snapshots_entity_idx
  ON plugin_evolution_4399b11512.change_snapshots(company_id, entity_type, entity_id, captured_at DESC);
CREATE INDEX evolution_snapshots_hash_idx
  ON plugin_evolution_4399b11512.change_snapshots(company_id, snapshot_hash);

CREATE TABLE plugin_evolution_4399b11512.change_items (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  change_set_id uuid NOT NULL REFERENCES plugin_evolution_4399b11512.change_sets(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  entity_name text,
  change_kind text NOT NULL,
  changed_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
  before_snapshot_id uuid REFERENCES plugin_evolution_4399b11512.change_snapshots(id) ON DELETE SET NULL,
  after_snapshot_id uuid REFERENCES plugin_evolution_4399b11512.change_snapshots(id) ON DELETE SET NULL,
  source_type text NOT NULL,
  source_ref text,
  source_activity_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX evolution_change_items_source_uq
  ON plugin_evolution_4399b11512.change_items(company_id, source_type, source_ref)
  WHERE source_ref IS NOT NULL;
CREATE INDEX evolution_change_items_set_idx
  ON plugin_evolution_4399b11512.change_items(company_id, change_set_id, occurred_at DESC);

CREATE INDEX evolution_change_items_activity_idx
  ON plugin_evolution_4399b11512.change_items(company_id, source_activity_id)
  WHERE source_activity_id IS NOT NULL;

CREATE TABLE plugin_evolution_4399b11512.change_links (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  change_set_id uuid NOT NULL REFERENCES plugin_evolution_4399b11512.change_sets(id) ON DELETE CASCADE,
  link_type text NOT NULL,
  reference_id text NOT NULL,
  label text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX evolution_change_links_uq
  ON plugin_evolution_4399b11512.change_links(company_id, change_set_id, link_type, reference_id);

CREATE TABLE plugin_evolution_4399b11512.change_evidence (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  change_set_id uuid NOT NULL REFERENCES plugin_evolution_4399b11512.change_sets(id) ON DELETE CASCADE,
  evidence_type text NOT NULL,
  reference_id text,
  label text,
  verdict text NOT NULL DEFAULT 'neutral',
  notes text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evolution_evidence_set_idx
  ON plugin_evolution_4399b11512.change_evidence(company_id, change_set_id, created_at DESC);

CREATE INDEX evolution_evidence_reference_idx
  ON plugin_evolution_4399b11512.change_evidence(company_id, evidence_type, reference_id)
  WHERE reference_id IS NOT NULL;

CREATE TABLE plugin_evolution_4399b11512.change_metrics (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  change_set_id uuid NOT NULL REFERENCES plugin_evolution_4399b11512.change_sets(id) ON DELETE CASCADE,
  metric_key text NOT NULL,
  baseline_value numeric,
  current_value numeric,
  delta_value numeric,
  unit text,
  baseline_sample_size integer,
  current_sample_size integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  computed_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX evolution_metrics_set_key_uq
  ON plugin_evolution_4399b11512.change_metrics(company_id, change_set_id, metric_key);

CREATE TABLE plugin_evolution_4399b11512.change_conclusions (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  change_set_id uuid NOT NULL REFERENCES plugin_evolution_4399b11512.change_sets(id) ON DELETE CASCADE,
  outcome text NOT NULL,
  confidence text NOT NULL DEFAULT 'low',
  summary text NOT NULL,
  evidence_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_type text,
  created_by_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evolution_conclusions_set_idx
  ON plugin_evolution_4399b11512.change_conclusions(company_id, change_set_id, created_at DESC);
