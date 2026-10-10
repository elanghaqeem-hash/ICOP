-- 004 Phase 2: tender center, RKS, compliance, bid/no-bid, proposal, vendor, delegation

ALTER TABLE assessments DROP CONSTRAINT assessments_service_type_check;
ALTER TABLE assessments ADD CONSTRAINT assessments_service_type_check CHECK (service_type IN ('VAPT','SOC','CTI','GRC'));
ALTER TABLE approval_requests ADD COLUMN escalated_at timestamptz;
ALTER TABLE approval_requests ADD COLUMN escalation_level int NOT NULL DEFAULT 0;

/* ───── Vendor & distributor ───── */
CREATE TABLE vendors (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  code                 text NOT NULL,
  name                 text NOT NULL,
  vendor_type          text NOT NULL CHECK (vendor_type IN ('vendor','distributor','vendor_distributor','subcontractor')),
  partner_level        text,
  authorization_status text NOT NULL DEFAULT 'NONE' CHECK (authorization_status IN ('NONE','REGISTERED','AUTHORIZED','EXPIRED')),
  authorized_until     date,
  contact_name         text,
  contact_email        text,
  notes                text,
  created_by           uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
CREATE UNIQUE INDEX vendors_name_uq ON vendors (tenant_id, lower(name));

CREATE TABLE vendor_price_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  vendor_id        uuid NOT NULL REFERENCES vendors(id),
  catalog_item_id  uuid REFERENCES catalog_items(id),
  sku              text NOT NULL,
  description      text NOT NULL,
  unit             text NOT NULL,
  currency         text NOT NULL DEFAULT 'IDR',
  unit_cost        numeric(18,2) NOT NULL CHECK (unit_cost >= 0),
  fx_rate_to_idr   numeric(14,4) NOT NULL DEFAULT 1,
  is_special_bid   boolean NOT NULL DEFAULT false,
  valid_from       date NOT NULL,
  valid_until      date,
  source_ref       text,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_until IS NULL OR valid_until >= valid_from)
);
CREATE INDEX vendor_price_items_idx ON vendor_price_items (tenant_id, vendor_id, sku, valid_from DESC);

/* ───── Tender ───── */
CREATE TABLE tenders (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  code                  text NOT NULL,
  title                 text NOT NULL,
  procuring_entity      text NOT NULL,
  customer_id           uuid REFERENCES customers(id),
  opportunity_id        uuid REFERENCES opportunities(id),
  source                text NOT NULL CHECK (source IN ('sirup','spse','lpse','bumn_portal','private_portal','vendor_portal','email','tender_radar','manual')),
  source_ref            text,
  source_url            text,
  procurement_method    text,
  service_category      text,
  hps_value             numeric(18,2),
  pagu_value            numeric(18,2),
  estimated_value       numeric(18,2),
  announce_date         date,
  aanwijzing_at         timestamptz,
  submission_deadline   timestamptz,
  opening_at            timestamptz,
  status                text NOT NULL DEFAULT 'DISCOVERED' CHECK (status IN ('DISCOVERED','SCREENING','REGISTERED','BID_DECISION','PREPARING',
                          'INTERNAL_REVIEW','APPROVED','SUBMITTED','CLARIFICATION','NEGOTIATION','AWARDED','LOST','CONTRACTING','NO_BID','CANCELLED')),
  relevance_score       int,
  classification        text,
  matched_keywords      text[] NOT NULL DEFAULT '{}',
  competitors           text[] NOT NULL DEFAULT '{}',
  owner_id              uuid REFERENCES users(id),
  outcome_note          text,
  row_version           int NOT NULL DEFAULT 1,
  created_by            uuid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
CREATE UNIQUE INDEX tenders_source_ref_uq ON tenders (tenant_id, source, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX tenders_status_idx ON tenders (tenant_id, status, submission_deadline);

CREATE TABLE tender_status_history (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  tender_id   uuid NOT NULL REFERENCES tenders(id),
  from_status text,
  to_status   text NOT NULL,
  note        text,
  changed_by  uuid REFERENCES users(id),
  changed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tender_documents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  tender_id          uuid NOT NULL REFERENCES tenders(id),
  kind               text NOT NULL CHECK (kind IN ('RKS','KAK','TOR','ADDENDUM','AANWIJZING_MOM','SUBMISSION_PROOF','EVALUATION','AWARD_LETTER','OTHER')),
  filename           text NOT NULL,
  mime               text NOT NULL,
  size_bytes         int NOT NULL,
  sha256             text NOT NULL,
  storage_path       text NOT NULL,
  version            int NOT NULL DEFAULT 1,
  extraction_status  text NOT NULL DEFAULT 'PENDING' CHECK (extraction_status IN ('PENDING','DONE','NEEDS_OCR','FAILED','NOT_APPLICABLE')),
  extracted_text     text,
  page_count         int,
  extraction_note    text,
  uploaded_by        uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tender_documents_hash_uq ON tender_documents (tender_id, sha256);

CREATE TABLE tender_requirements (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  tender_id          uuid NOT NULL REFERENCES tenders(id),
  document_id        uuid REFERENCES tender_documents(id),
  ref_code           text NOT NULL,
  category           text NOT NULL CHECK (category IN ('ADMINISTRATIVE','QUALIFICATION','TECHNICAL','COMMERCIAL')),
  requirement        text NOT NULL,
  mandatory          boolean NOT NULL DEFAULT true,
  source_excerpt     text,
  source_page        int,
  origin             text NOT NULL CHECK (origin IN ('RULE','AI','MANUAL')),
  compliance_status  text NOT NULL DEFAULT 'UNREVIEWED' CHECK (compliance_status IN ('UNREVIEWED','COMPLY','PARTIAL','NON_COMPLY','NOT_APPLICABLE','CLARIFY')),
  response           text,
  evidence           text,
  pic_id             uuid REFERENCES users(id),
  due_date           date,
  risk_level         text NOT NULL DEFAULT 'MEDIUM' CHECK (risk_level IN ('LOW','MEDIUM','HIGH')),
  updated_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tender_id, ref_code)
);
CREATE INDEX tender_requirements_idx ON tender_requirements (tender_id, category, compliance_status);

CREATE TABLE tender_clarifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  tender_id       uuid NOT NULL REFERENCES tenders(id),
  requirement_id  uuid REFERENCES tender_requirements(id),
  question        text NOT NULL,
  status          text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SUBMITTED','ANSWERED','WITHDRAWN')),
  answer          text,
  origin          text NOT NULL DEFAULT 'MANUAL' CHECK (origin IN ('MANUAL','AI')),
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bid_assessments (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id),
  tender_id              uuid NOT NULL REFERENCES tenders(id),
  scores                 jsonb NOT NULL,
  weighted_score         numeric(5,1) NOT NULL,
  knockouts              jsonb NOT NULL DEFAULT '[]',
  recommendation         text NOT NULL CHECK (recommendation IN ('GO','CONDITIONAL_GO','NO_GO')),
  conditions             text,
  conflict_of_interest   boolean NOT NULL,
  coi_note               text,
  status                 text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_APPROVAL','APPROVED','REJECTED','REVISION_REQUESTED','SUPERSEDED')),
  final_decision         text CHECK (final_decision IN ('GO','CONDITIONAL_GO','NO_GO')),
  created_by             uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now()
);

/* ───── Company facts (sumber tunggal klaim proposal) ───── */
CREATE TABLE company_facts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  kind          text NOT NULL CHECK (kind IN ('PROFILE','CERTIFICATION','ACCREDITATION','VENDOR_AUTHORIZATION','PROJECT_REFERENCE','PERSONNEL','METHODOLOGY')),
  title         text NOT NULL,
  detail        text NOT NULL,
  keywords      text[] NOT NULL DEFAULT '{}',
  valid_until   date,
  status        text NOT NULL DEFAULT 'UNVERIFIED' CHECK (status IN ('UNVERIFIED','VERIFIED','EXPIRED')),
  evidence_ref  text,
  verified_by   uuid REFERENCES users(id),
  verified_at   timestamptz,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

/* ───── Proposal ───── */
CREATE TABLE proposals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  number           text NOT NULL,
  opportunity_id   uuid NOT NULL REFERENCES opportunities(id),
  tender_id        uuid REFERENCES tenders(id),
  customer_id      uuid NOT NULL REFERENCES customers(id),
  title            text NOT NULL,
  language         text NOT NULL DEFAULT 'id' CHECK (language IN ('id','en')),
  status           text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_REVIEW','REVIEWED','SUPERSEDED')),
  version          int NOT NULL DEFAULT 1,
  reviewer_id      uuid REFERENCES users(id),
  reviewed_at      timestamptz,
  review_note      text,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);

CREATE TABLE proposal_sections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  proposal_id   uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  seq           int NOT NULL,
  key           text NOT NULL,
  title         text NOT NULL,
  required      boolean NOT NULL DEFAULT true,
  content       text NOT NULL DEFAULT '',
  sources       jsonb NOT NULL DEFAULT '[]',
  missing_info  jsonb NOT NULL DEFAULT '[]',
  flags         jsonb NOT NULL DEFAULT '[]',
  status        text NOT NULL DEFAULT 'EMPTY' CHECK (status IN ('EMPTY','GENERATED','AI_DRAFT','EDITED','FLAGGED')),
  generated_by  text,
  updated_by    uuid REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (proposal_id, key)
);

CREATE TABLE proposal_versions (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  proposal_id  uuid NOT NULL REFERENCES proposals(id),
  version      int NOT NULL,
  reason       text NOT NULL,
  snapshot     jsonb NOT NULL,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER proposal_versions_append_only BEFORE UPDATE OR DELETE ON proposal_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

/* ───── Approval delegation ───── */
CREATE TABLE approval_delegations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  delegator_id  uuid NOT NULL REFERENCES users(id),
  delegate_id   uuid NOT NULL REFERENCES users(id),
  level         int NOT NULL CHECK (level BETWEEN 1 AND 3),
  valid_from    timestamptz NOT NULL,
  valid_until   timestamptz NOT NULL,
  reason        text NOT NULL,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_until > valid_from),
  CHECK (delegator_id <> delegate_id)
);
CREATE INDEX approval_delegations_active_idx ON approval_delegations (tenant_id, delegate_id, valid_until);
