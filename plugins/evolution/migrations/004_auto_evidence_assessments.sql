-- Keep automatically captured run references idempotent without rewriting manually curated evidence.
CREATE UNIQUE INDEX evolution_auto_run_evidence_uq
  ON plugin_evolution_4399b11512.change_evidence (company_id, change_set_id, evidence_type, reference_id)
  WHERE evidence_type = 'run' AND reference_id IS NOT NULL AND metadata->>'capture' = 'automatic';

-- An automatic assessment is advisory, never a human conclusion and never causal proof.
CREATE TABLE plugin_evolution_4399b11512.change_assessments (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  change_set_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('improved', 'regressed', 'inconclusive')),
  confidence text NOT NULL CHECK (confidence IN ('low', 'moderate')),
  reason_code text NOT NULL,
  summary text NOT NULL,
  signals jsonb NOT NULL DEFAULT '{}'::jsonb,
  baseline_run_count integer NOT NULL DEFAULT 0,
  current_run_count integer NOT NULL DEFAULT 0,
  evidence_count integer NOT NULL DEFAULT 0,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evolution_assessment_company_set_fk
    FOREIGN KEY (company_id, change_set_id)
    REFERENCES plugin_evolution_4399b11512.change_sets(company_id, id) ON DELETE CASCADE,
  CONSTRAINT evolution_assessment_company_set_uq UNIQUE (company_id, change_set_id)
);
CREATE INDEX evolution_assessment_company_outcome_idx
  ON plugin_evolution_4399b11512.change_assessments(company_id, outcome, evaluated_at DESC);
