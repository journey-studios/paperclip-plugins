-- Captures can race with a multi-statement merge. Parent deletion must never
-- cascade into a newly captured row. Composite keys also enforce company scope.
ALTER TABLE plugin_evolution_4399b11512.change_sets
  ADD CONSTRAINT evolution_change_sets_company_id_id_uq UNIQUE (company_id, id);

ALTER TABLE plugin_evolution_4399b11512.change_sets
  ADD COLUMN merge_target_id uuid,
  ADD CONSTRAINT evolution_change_sets_merge_target_fkey
    FOREIGN KEY (company_id, merge_target_id)
    REFERENCES plugin_evolution_4399b11512.change_sets (company_id, id)
    ON DELETE NO ACTION;

CREATE TABLE plugin_evolution_4399b11512.change_context_aliases (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  source_context_key text NOT NULL,
  change_set_id uuid NOT NULL,
  PRIMARY KEY (company_id, source_context_key),
  CONSTRAINT evolution_change_context_aliases_company_set_fkey
    FOREIGN KEY (company_id, change_set_id)
    REFERENCES plugin_evolution_4399b11512.change_sets (company_id, id)
    ON DELETE NO ACTION
);
CREATE INDEX evolution_change_context_aliases_set_idx
  ON plugin_evolution_4399b11512.change_context_aliases(company_id, change_set_id);

ALTER TABLE plugin_evolution_4399b11512.change_items
  DROP CONSTRAINT change_items_change_set_id_fkey,
  ADD CONSTRAINT evolution_change_items_company_set_fkey
    FOREIGN KEY (company_id, change_set_id)
    REFERENCES plugin_evolution_4399b11512.change_sets (company_id, id)
    ON DELETE NO ACTION;

ALTER TABLE plugin_evolution_4399b11512.change_evidence
  DROP CONSTRAINT change_evidence_change_set_id_fkey,
  ADD CONSTRAINT evolution_change_evidence_company_set_fkey
    FOREIGN KEY (company_id, change_set_id)
    REFERENCES plugin_evolution_4399b11512.change_sets (company_id, id)
    ON DELETE NO ACTION;

ALTER TABLE plugin_evolution_4399b11512.change_links
  DROP CONSTRAINT change_links_change_set_id_fkey,
  ADD CONSTRAINT evolution_change_links_company_set_fkey
    FOREIGN KEY (company_id, change_set_id)
    REFERENCES plugin_evolution_4399b11512.change_sets (company_id, id)
    ON DELETE NO ACTION;

ALTER TABLE plugin_evolution_4399b11512.change_metrics
  DROP CONSTRAINT change_metrics_change_set_id_fkey,
  ADD CONSTRAINT evolution_change_metrics_company_set_fkey
    FOREIGN KEY (company_id, change_set_id)
    REFERENCES plugin_evolution_4399b11512.change_sets (company_id, id)
    ON DELETE NO ACTION;

ALTER TABLE plugin_evolution_4399b11512.change_conclusions
  DROP CONSTRAINT change_conclusions_change_set_id_fkey,
  ADD CONSTRAINT evolution_change_conclusions_company_set_fkey
    FOREIGN KEY (company_id, change_set_id)
    REFERENCES plugin_evolution_4399b11512.change_sets (company_id, id)
    ON DELETE NO ACTION;
