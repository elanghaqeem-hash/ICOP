/* Phase 2b/4: konfigurasi SMTP (terenkripsi), status template legal, billing (invoice & pembayaran append-only) */

CREATE TABLE smtp_settings (
  tenant_id      uuid PRIMARY KEY REFERENCES tenants(id),
  enabled        boolean NOT NULL DEFAULT false,
  host           text NOT NULL,
  port           int NOT NULL CHECK (port BETWEEN 1 AND 65535),
  secure         boolean NOT NULL DEFAULT false,
  username       text,
  password_enc   text,
  password_last4 text,
  from_name      text NOT NULL,
  from_email     text NOT NULL,
  updated_by     uuid REFERENCES users(id),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE template_status (
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  code         text NOT NULL,
  version      int NOT NULL DEFAULT 1,
  status       text NOT NULL DEFAULT 'PENDING_LEGAL' CHECK (status IN ('PENDING_LEGAL','APPROVED','RETIRED')),
  approved_by  uuid REFERENCES users(id),
  approved_at  timestamptz,
  note         text,
  PRIMARY KEY (tenant_id, code)
);

CREATE TABLE invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  number        text NOT NULL,
  project_id    uuid NOT NULL REFERENCES projects(id),
  contract_id   uuid NOT NULL REFERENCES contracts(id),
  customer_id   uuid NOT NULL REFERENCES customers(id),
  milestone_id  uuid REFERENCES project_milestones(id),
  description   text NOT NULL,
  amount        numeric(18,2) NOT NULL CHECK (amount > 0),
  tax_rate      numeric(5,2) NOT NULL DEFAULT 11,
  tax           numeric(18,2) NOT NULL,
  total         numeric(18,2) NOT NULL,
  paid_total    numeric(18,2) NOT NULL DEFAULT 0 CHECK (paid_total >= 0),
  issue_date    date NOT NULL DEFAULT current_date,
  due_date      date NOT NULL,
  status        text NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED','PARTIAL','PAID','VOID')),
  void_reason   text,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (paid_total <= total),
  UNIQUE (tenant_id, number)
);
CREATE UNIQUE INDEX invoices_milestone_uq ON invoices (milestone_id) WHERE milestone_id IS NOT NULL AND status <> 'VOID';

CREATE TABLE invoice_payments (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  invoice_id  uuid NOT NULL REFERENCES invoices(id),
  amount      numeric(18,2) NOT NULL CHECK (amount > 0),
  paid_on     date NOT NULL,
  reference   text NOT NULL,
  recorded_by uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoice_payments_inv_idx ON invoice_payments (invoice_id);
CREATE TRIGGER invoice_payments_append_only BEFORE UPDATE OR DELETE ON invoice_payments
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE project_milestones ADD COLUMN bast_ref text;
ALTER TABLE project_milestones ADD COLUMN accepted_at timestamptz;
