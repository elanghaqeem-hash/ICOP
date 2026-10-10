-- Phase 6 source migration 011, reconciled as migration 012 to preserve
-- GitHub Gate 4B/4C migrations 010 (MFA) and 011 (dual-admin recovery).
-- No phase6 010_security DDL is applied: incompatible duplicate MFA fields.

CREATE TABLE business_calendar (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
 start_minute int NOT NULL DEFAULT 480 CHECK(start_minute BETWEEN 0 AND 1439),
 end_minute int NOT NULL DEFAULT 1020 CHECK(end_minute BETWEEN 1 AND 1440),
 weekdays int[] NOT NULL DEFAULT '{1,2,3,4,5}',
 CHECK(end_minute > start_minute)
);
CREATE TABLE holidays (
 tenant_id uuid NOT NULL REFERENCES tenants(id), day date NOT NULL,
 name text NOT NULL, PRIMARY KEY(tenant_id,day)
);
ALTER TABLE sla_targets ADD COLUMN calendar text NOT NULL DEFAULT '24x7'
 CHECK(calendar IN ('24x7','BUSINESS'));
CREATE TABLE contract_sla (
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 contract_id uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
 priority text NOT NULL CHECK(priority IN('P1','P2','P3','P4')),
 response_minutes int NOT NULL CHECK(response_minutes > 0),
 resolution_minutes int NOT NULL CHECK(resolution_minutes > 0),
 calendar text NOT NULL DEFAULT '24x7' CHECK(calendar IN('24x7','BUSINESS')),
 PRIMARY KEY(contract_id,priority),
 CHECK(resolution_minutes>=response_minutes)
);
ALTER TABLE tickets ADD COLUMN contract_id uuid REFERENCES contracts(id);
ALTER TABLE tickets ADD COLUMN sla_calendar text NOT NULL DEFAULT '24x7';
ALTER TABLE tickets ADD COLUMN sla_source text NOT NULL DEFAULT 'DEFAULT'
 CHECK(sla_source IN('DEFAULT','TENANT','CONTRACT'));
ALTER TABLE tickets ADD COLUMN paused_at timestamptz;
ALTER TABLE tickets ADD COLUMN paused_minutes int NOT NULL DEFAULT 0;

ALTER TABLE invoices ADD COLUMN credited_total numeric(18,2) NOT NULL DEFAULT 0
 CHECK(credited_total >= 0);
CREATE TABLE credit_notes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 number text,
 invoice_id uuid NOT NULL REFERENCES invoices(id),
 amount numeric(18,2) NOT NULL CHECK(amount > 0),
 tax numeric(18,2) NOT NULL CHECK(tax >= 0),
 total numeric(18,2) NOT NULL CHECK(total > 0),
 refund_due numeric(18,2) NOT NULL DEFAULT 0 CHECK(refund_due >= 0),
 reason text NOT NULL,
 status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN('DRAFT','ISSUED','REJECTED')),
 created_by uuid REFERENCES users(id),
 approved_by uuid REFERENCES users(id),
 approved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id, number)
);

CREATE INDEX document_pages_fts ON document_pages USING gin(to_tsvector('simple', text));
CREATE INDEX proposal_sections_fts ON proposal_sections USING gin(to_tsvector('simple', title || ' ' || content));
CREATE INDEX tender_requirements_fts ON tender_requirements USING gin(to_tsvector('simple', requirement));
CREATE INDEX company_facts_fts ON company_facts USING gin(to_tsvector('simple', title || ' ' || detail));
ALTER TABLE invoices DROP CONSTRAINT invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check
 CHECK(status IN('ISSUED','PARTIAL','PAID','CREDITED','VOID'));
