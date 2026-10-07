ALTER TABLE plugin_evolution_4399b11512.change_sets
  ADD CONSTRAINT evolution_change_sets_company_id_uq UNIQUE (company_id, id);

ALTER TABLE plugin_evolution_4399b11512.change_snapshots
  ADD CONSTRAINT evolution_snapshots_company_id_uq UNIQUE (company_id, id);

ALTER TABLE plugin_evolution_4399b11512.change_items
  ADD CONSTRAINT evolution_items_company_set_fk
  FOREIGN KEY (company_id, change_set_id)
  REFERENCES plugin_evolution_4399b11512.change_sets(company_id, id) ON DELETE CASCADE;

ALTER TABLE plugin_evolution_4399b11512.change_items
  ADD CONSTRAINT evolution_items_company_before_snapshot_fk
  FOREIGN KEY (company_id, before_snapshot_id)
  REFERENCES plugin_evolution_4399b11512.change_snapshots(company_id, id);

ALTER TABLE plugin_evolution_4399b11512.change_items
  ADD CONSTRAINT evolution_items_company_after_snapshot_fk
  FOREIGN KEY (company_id, after_snapshot_id)
  REFERENCES plugin_evolution_4399b11512.change_snapshots(company_id, id);

ALTER TABLE plugin_evolution_4399b11512.change_links
  ADD CONSTRAINT evolution_links_company_set_fk
  FOREIGN KEY (company_id, change_set_id)
  REFERENCES plugin_evolution_4399b11512.change_sets(company_id, id) ON DELETE CASCADE;

ALTER TABLE plugin_evolution_4399b11512.change_evidence
  ADD CONSTRAINT evolution_evidence_company_set_fk
  FOREIGN KEY (company_id, change_set_id)
  REFERENCES plugin_evolution_4399b11512.change_sets(company_id, id) ON DELETE CASCADE;

ALTER TABLE plugin_evolution_4399b11512.change_metrics
  ADD CONSTRAINT evolution_metrics_company_set_fk
  FOREIGN KEY (company_id, change_set_id)
  REFERENCES plugin_evolution_4399b11512.change_sets(company_id, id) ON DELETE CASCADE;

ALTER TABLE plugin_evolution_4399b11512.change_conclusions
  ADD CONSTRAINT evolution_conclusions_company_set_fk
  FOREIGN KEY (company_id, change_set_id)
  REFERENCES plugin_evolution_4399b11512.change_sets(company_id, id) ON DELETE CASCADE;

ALTER TABLE plugin_evolution_4399b11512.change_conclusions
  ADD COLUMN idempotency_key text;

CREATE UNIQUE INDEX evolution_conclusions_idempotency_uq
  ON plugin_evolution_4399b11512.change_conclusions(company_id, change_set_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE plugin_evolution_4399b11512.merge_operations (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  source_change_set_id uuid NOT NULL,
  target_change_set_id uuid NOT NULL,
  merged_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, source_change_set_id),
  CONSTRAINT evolution_merges_company_target_fk
    FOREIGN KEY (company_id, target_change_set_id)
    REFERENCES plugin_evolution_4399b11512.change_sets(company_id, id) ON DELETE CASCADE,
  CONSTRAINT evolution_merges_source_target_ck
    CHECK (source_change_set_id <> target_change_set_id)
);

CREATE INDEX evolution_merges_target_idx
  ON plugin_evolution_4399b11512.merge_operations(company_id, target_change_set_id);
