-- Phase 6B2: source-derived tender compliance AI suggestions.
-- Kept separate from uploaded migration 012 to preserve Phase5 MFA and Phase6A schema.
CREATE TABLE tender_ai_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  tender_id uuid NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  requirement_id uuid NOT NULL REFERENCES tender_requirements(id) ON DELETE CASCADE,
  requirement_updated_at timestamptz NOT NULL,
  suggested_status text NOT NULL CHECK(suggested_status IN ('COMPLY','PARTIAL','NON_COMPLY','CLARIFY')),
  evidence_fact_ids uuid[] NOT NULL DEFAULT '{}',
  evidence_text text,
  evidence_quote text,
  rationale text NOT NULL,
  verified boolean NOT NULL DEFAULT false,
  downgraded boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK(status IN ('PENDING','ACCEPTED','REJECTED','SUPERSEDED')),
  provider text,
  created_by uuid REFERENCES users(id),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT verified OR (cardinality(evidence_fact_ids) > 0 AND evidence_quote IS NOT NULL))
);
CREATE INDEX tender_ai_suggestions_idx
  ON tender_ai_suggestions(tenant_id,tender_id,status);
CREATE UNIQUE INDEX tender_ai_suggestions_pending_uq
  ON tender_ai_suggestions(requirement_id) WHERE status='PENDING';
