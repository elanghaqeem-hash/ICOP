-- 006 Phase 3: FlexGuard wallet & ledger, service request, contract lifecycle, signature, project handover

ALTER TABLE policies DROP CONSTRAINT policies_kind_check;
ALTER TABLE policies ADD CONSTRAINT policies_kind_check CHECK (kind IN ('PRICING','DOA','FLEXGUARD'));

/* ───── Contract lifecycle ───── */
CREATE TABLE contracts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  number            text NOT NULL,
  customer_id       uuid NOT NULL REFERENCES customers(id),
  opportunity_id    uuid REFERENCES opportunities(id),
  quotation_id      uuid REFERENCES quotations(id),
  tender_id         uuid REFERENCES tenders(id),
  contract_type     text NOT NULL CHECK (contract_type IN ('PROJECT','MANAGED_SERVICE','FLEXGUARD','LICENSE')),
  title             text NOT NULL,
  value             numeric(18,2) NOT NULL CHECK (value >= 0),
  tax_rate          numeric(6,3) NOT NULL DEFAULT 11,
  start_date        date NOT NULL,
  end_date          date NOT NULL,
  payment_terms     text NOT NULL,
  sla_terms         text,
  penalty_terms     text NOT NULL DEFAULT 'Denda keterlambatan 1‰ per hari, maksimal 5% dari nilai termin terkait',
  flexguard         jsonb,
  status            text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','LEGAL_REVIEW','IN_APPROVAL','APPROVED','PENDING_SIGNATURE','ACTIVE','COMPLETED','TERMINATED','EXPIRED','CANCELLED')),
  legal_checklist   jsonb,
  legal_reviewed_by uuid REFERENCES users(id),
  legal_reviewed_at timestamptz,
  activated_at      timestamptz,
  row_version       int NOT NULL DEFAULT 1,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  CHECK (end_date >= start_date)
);
CREATE UNIQUE INDEX contracts_quotation_uq ON contracts (quotation_id) WHERE quotation_id IS NOT NULL AND status <> 'CANCELLED';
CREATE UNIQUE INDEX contracts_tender_uq ON contracts (tender_id) WHERE tender_id IS NOT NULL AND status <> 'CANCELLED';

CREATE TABLE contract_obligations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  contract_id  uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('PAYMENT','DELIVERABLE','SLA','RENEWAL','REPORT')),
  description  text NOT NULL,
  due_date     date,
  amount       numeric(18,2),
  percent      numeric(6,3),
  status       text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','DONE','WAIVED','OVERDUE')),
  done_at      timestamptz,
  seq          int NOT NULL
);

CREATE TABLE contract_signatures (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  contract_id      uuid NOT NULL REFERENCES contracts(id),
  party            text NOT NULL CHECK (party IN ('INTERNAL','CUSTOMER')),
  method           text NOT NULL CHECK (method IN ('INTERNAL_AUTHORIZATION','UPLOADED_SIGNED','ESIGN_PROVIDER')),
  provider         text,
  provider_ref     text,
  signer_name      text NOT NULL,
  signer_title     text,
  signer_user_id   uuid REFERENCES users(id),
  document_id      uuid REFERENCES documents(id),
  document_sha256  text,
  status           text NOT NULL CHECK (status IN ('PENDING','SIGNED','VERIFIED','REJECTED','EXPIRED')),
  evidence         jsonb NOT NULL DEFAULT '{}',
  verified_by      uuid REFERENCES users(id),
  verified_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  signed_at        timestamptz
);
CREATE UNIQUE INDEX contract_signatures_provider_uq ON contract_signatures (provider, provider_ref) WHERE provider_ref IS NOT NULL;

/* ───── Project handover ───── */
CREATE TABLE projects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  code             text NOT NULL,
  name             text NOT NULL,
  contract_id      uuid NOT NULL REFERENCES contracts(id),
  customer_id      uuid NOT NULL REFERENCES customers(id),
  opportunity_id   uuid REFERENCES opportunities(id),
  pm_id            uuid REFERENCES users(id),
  status           text NOT NULL DEFAULT 'HANDOVER' CHECK (status IN ('HANDOVER','KICKOFF','IN_PROGRESS','ON_HOLD','CLOSING','CLOSED')),
  start_date       date,
  end_date         date,
  contract_value   numeric(18,2) NOT NULL,
  budget_cost      numeric(18,2),
  budget_md        numeric(10,1),
  handover         jsonb NOT NULL,
  kickoff_at       timestamptz,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (contract_id)
);

CREATE TABLE project_milestones (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq           int NOT NULL,
  name          text NOT NULL,
  due_date      date,
  billing_pct   numeric(6,3),
  billing_amount numeric(18,2),
  status        text NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','IN_PROGRESS','DONE','ACCEPTED')),
  obligation_id uuid REFERENCES contract_obligations(id)
);

/* ───── FlexGuard wallet & ledger ───── */
CREATE TABLE flexguard_wallets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  code               text NOT NULL,
  customer_id        uuid NOT NULL REFERENCES customers(id),
  contract_id        uuid REFERENCES contracts(id),
  package            text NOT NULL,
  price_per_token    numeric(18,2) NOT NULL CHECK (price_per_token > 0),
  valid_from         date NOT NULL,
  valid_until        date NOT NULL,
  rollover_allowed   boolean NOT NULL DEFAULT false,
  low_balance_pct    numeric(5,2) NOT NULL DEFAULT 20,
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','EXPIRED','CLOSED','SUSPENDED')),
  complimentary      jsonb NOT NULL DEFAULT '[]',
  -- Saldo cache (selalu = Σ ledger; diverifikasi endpoint rekonsiliasi). CHECK mencegah saldo negatif.
  credited_tokens    numeric(12,2) NOT NULL DEFAULT 0,
  available_tokens   numeric(12,2) NOT NULL DEFAULT 0 CHECK (available_tokens >= 0),
  reserved_tokens    numeric(12,2) NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
  consumed_tokens    numeric(12,2) NOT NULL DEFAULT 0 CHECK (consumed_tokens >= 0),
  expired_tokens     numeric(12,2) NOT NULL DEFAULT 0 CHECK (expired_tokens >= 0),
  low_balance_alerted_at timestamptz,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  CHECK (valid_until >= valid_from)
);

CREATE TABLE wallet_transactions (
  id                 bigserial PRIMARY KEY,
  tenant_id          uuid NOT NULL,
  wallet_id          uuid NOT NULL REFERENCES flexguard_wallets(id),
  type               text NOT NULL CHECK (type IN ('FUND','TOPUP','BONUS','RESERVE','RELEASE','CONSUME','REVERSAL','ADJUSTMENT','EXPIRE','ROLLOVER')),
  d_available        numeric(12,2) NOT NULL DEFAULT 0,
  d_reserved         numeric(12,2) NOT NULL DEFAULT 0,
  d_consumed         numeric(12,2) NOT NULL DEFAULT 0,
  d_expired          numeric(12,2) NOT NULL DEFAULT 0,
  d_credited         numeric(12,2) NOT NULL DEFAULT 0,
  value_idr          numeric(18,2),
  service_request_id uuid,
  reverses_tx_id     bigint REFERENCES wallet_transactions(id),
  approval_request_id uuid REFERENCES approval_requests(id),
  reason             text NOT NULL,
  idempotency_key    text,
  balance_after      jsonb NOT NULL,
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX wallet_tx_idem_uq ON wallet_transactions (wallet_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX wallet_tx_reversal_uq ON wallet_transactions (reverses_tx_id) WHERE reverses_tx_id IS NOT NULL;
CREATE INDEX wallet_tx_wallet_idx ON wallet_transactions (wallet_id, id);
CREATE TRIGGER wallet_transactions_append_only BEFORE UPDATE OR DELETE ON wallet_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE service_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  code              text NOT NULL,
  wallet_id         uuid NOT NULL REFERENCES flexguard_wallets(id),
  customer_id       uuid NOT NULL REFERENCES customers(id),
  service_line      text NOT NULL,
  title             text NOT NULL,
  description       text,
  status            text NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','SCOPED','PENDING_CUSTOMER_APPROVAL','APPROVED','IN_PROGRESS',
                      'DELIVERED','COMPLETED','CANCELLED','DISPUTED','REJECTED')),
  estimate          jsonb,
  estimated_tokens  numeric(10,2),
  reserved_tokens   numeric(10,2) NOT NULL DEFAULT 0,
  actual_tokens     numeric(10,2),
  floor_check       jsonb,
  approval_request_id uuid REFERENCES approval_requests(id),
  customer_approved_by uuid REFERENCES users(id),
  customer_approved_at timestamptz,
  delivery_accepted_by uuid REFERENCES users(id),
  delivery_accepted_at timestamptz,
  dispute_note      text,
  assigned_pm_id    uuid REFERENCES users(id),
  requested_by      uuid REFERENCES users(id),
  row_version       int NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_tx_sr_fk FOREIGN KEY (service_request_id) REFERENCES service_requests(id);

CREATE TABLE service_timesheets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  service_request_id uuid NOT NULL REFERENCES service_requests(id),
  user_id            uuid NOT NULL REFERENCES users(id),
  work_date          date NOT NULL,
  role               text NOT NULL,
  md                 numeric(4,2) NOT NULL CHECK (md > 0 AND md <= 1.5),
  note               text,
  evidence           text,
  status             text NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','APPROVED','REJECTED')),
  approved_by        uuid REFERENCES users(id),
  approved_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_request_id, user_id, work_date, role)
);
