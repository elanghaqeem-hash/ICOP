-- 003 Scoping, pricing, quotation, approval, AI
CREATE TABLE policies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  kind            text NOT NULL CHECK (kind IN ('PRICING','DOA')),
  code            text NOT NULL,
  version         int  NOT NULL,
  title           text NOT NULL,
  params          jsonb NOT NULL,
  status          text NOT NULL CHECK (status IN ('DRAFT','PENDING_OWNER_APPROVAL','ACTIVE','RETIRED')),
  is_current      boolean NOT NULL DEFAULT false,
  effective_from  date NOT NULL,
  source_note     text,
  created_by      uuid REFERENCES users(id),
  approved_by     uuid REFERENCES users(id),
  approved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code, version)
);
-- Hanya satu kebijakan "current" per jenis per tenant
CREATE UNIQUE INDEX policies_current_uq ON policies (tenant_id, kind) WHERE is_current;

CREATE TABLE assessments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  customer_id     uuid NOT NULL REFERENCES customers(id),
  opportunity_id  uuid REFERENCES opportunities(id),
  service_type    text NOT NULL CHECK (service_type IN ('VAPT','SOC')),
  answers         jsonb NOT NULL DEFAULT '{}',
  result          jsonb,
  completeness    int NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ENGINEER_REVIEW_REQUIRED','REVIEWED')),
  reviewed_by     uuid REFERENCES users(id),
  reviewed_at     timestamptz,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assessments_opp_idx ON assessments (tenant_id, opportunity_id);

-- Snapshot kalkulasi (immutable) untuk reproducibility
CREATE TABLE pricing_scenarios (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  opportunity_id  uuid REFERENCES opportunities(id),
  assessment_id   uuid REFERENCES assessments(id),
  policy_id       uuid NOT NULL REFERENCES policies(id),
  label           text NOT NULL,
  input           jsonb NOT NULL,
  result          jsonb NOT NULL,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER pricing_scenarios_immutable BEFORE UPDATE OR DELETE ON pricing_scenarios
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE quotations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  number            text NOT NULL,
  revision          int  NOT NULL DEFAULT 0,
  opportunity_id    uuid NOT NULL REFERENCES opportunities(id),
  customer_id       uuid NOT NULL REFERENCES customers(id),
  scenario_id       uuid REFERENCES pricing_scenarios(id),
  title             text NOT NULL,
  status            text NOT NULL DEFAULT 'DRAFT' CHECK (status IN
                      ('DRAFT','IN_APPROVAL','APPROVED','ISSUED','SENT','ACCEPTED','REJECTED','EXPIRED','REVISION_REQUESTED','CANCELLED')),
  currency          text NOT NULL DEFAULT 'IDR',
  subtotal          numeric(18,2) NOT NULL DEFAULT 0,
  discount_pct      numeric(6,3)  NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct < 100),
  discount_amount   numeric(18,2) NOT NULL DEFAULT 0,
  total_before_tax  numeric(18,2) NOT NULL DEFAULT 0,
  tax_rate          numeric(6,3)  NOT NULL DEFAULT 11,
  tax_amount        numeric(18,2) NOT NULL DEFAULT 0,
  grand_total       numeric(18,2) NOT NULL DEFAULT 0,
  -- INTERNAL ONLY (tidak pernah dikirim ke role customer)
  internal_cost     numeric(18,2) NOT NULL DEFAULT 0,
  floor_price       numeric(18,2) NOT NULL DEFAULT 0,
  gross_margin_pct  numeric(7,3),
  validity_days     int NOT NULL DEFAULT 30,
  payment_terms     text NOT NULL DEFAULT '30% DP, 50% progress, 20% BAST',
  delivery_terms    text,
  exclusions        text,
  issued_at         timestamptz,
  issued_by         uuid REFERENCES users(id),
  sent_at           timestamptz,
  customer_response text,
  customer_responded_at timestamptz,
  row_version       int NOT NULL DEFAULT 1,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);
CREATE INDEX quotations_opp_idx ON quotations (tenant_id, opportunity_id);

CREATE TABLE quotation_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  quotation_id     uuid NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  line_no          int NOT NULL,
  catalog_item_id  uuid REFERENCES catalog_items(id),
  description      text NOT NULL,
  qty              numeric(12,2) NOT NULL CHECK (qty > 0),
  unit             text NOT NULL,
  unit_price       numeric(18,2) NOT NULL CHECK (unit_price >= 0),
  amount           numeric(18,2) NOT NULL,
  UNIQUE (quotation_id, line_no)
);

CREATE TABLE quotation_revisions (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  quotation_id  uuid NOT NULL REFERENCES quotations(id),
  revision      int NOT NULL,
  row_version   int NOT NULL,
  snapshot      jsonb NOT NULL,
  reason        text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER quotation_revisions_append_only BEFORE UPDATE OR DELETE ON quotation_revisions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE approval_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  entity_type     text NOT NULL,
  entity_id       uuid NOT NULL,
  entity_version  int  NOT NULL,
  policy_id       uuid NOT NULL REFERENCES policies(id),
  requested_by    uuid NOT NULL REFERENCES users(id),
  required_level  int  NOT NULL,
  reasons         jsonb NOT NULL,
  summary         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','REVISION_REQUESTED','SUPERSEDED')),
  due_at          timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz
);
CREATE INDEX approval_requests_status_idx ON approval_requests (tenant_id, status, created_at);
CREATE UNIQUE INDEX approval_requests_open_uq ON approval_requests (tenant_id, entity_type, entity_id) WHERE status = 'PENDING';

CREATE TABLE approval_steps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  request_id   uuid NOT NULL REFERENCES approval_requests(id),
  seq          int  NOT NULL,
  level        int  NOT NULL,
  level_label  text NOT NULL,
  status       text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','REVISION_REQUESTED','SKIPPED','SUPERSEDED')),
  decided_by   uuid REFERENCES users(id),
  decided_at   timestamptz,
  UNIQUE (request_id, seq)
);

CREATE TABLE approval_decisions (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  request_id  uuid NOT NULL REFERENCES approval_requests(id),
  step_id     uuid NOT NULL REFERENCES approval_steps(id),
  decided_by  uuid NOT NULL REFERENCES users(id),
  decision    text NOT NULL CHECK (decision IN ('APPROVE','REJECT','REQUEST_REVISION')),
  comment     text,
  evidence    jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER approval_decisions_append_only BEFORE UPDATE OR DELETE ON approval_decisions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- AI gateway configuration (API key TIDAK disimpan di DB; hanya nama env var)
CREATE TABLE ai_providers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  provider     text NOT NULL CHECK (provider IN ('anthropic','openai','gemini','mistral','groq','openrouter','custom')),
  model        text NOT NULL,
  priority     int  NOT NULL,
  enabled      boolean NOT NULL DEFAULT true,
  api_key_env  text NOT NULL,
  base_url     text,
  timeout_ms   int NOT NULL DEFAULT 30000,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider)
);

CREATE TABLE ai_calls (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  user_id       uuid,
  feature       text NOT NULL,
  provider      text,
  model         text,
  status        text NOT NULL,
  attempts      jsonb NOT NULL DEFAULT '[]',
  latency_ms    int,
  input_tokens  int,
  output_tokens int,
  redactions    int NOT NULL DEFAULT 0,
  prompt_sha256 text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_calls_tenant_idx ON ai_calls (tenant_id, created_at DESC);
CREATE TRIGGER ai_calls_append_only BEFORE UPDATE OR DELETE ON ai_calls
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
