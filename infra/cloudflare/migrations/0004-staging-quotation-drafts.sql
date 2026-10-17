-- ICOP staging-only quotation capture; NOT the production quotations model.
-- Customer and opportunity references are manually entered pending verified
-- CRM/opportunity migration. Records are DRAFT only, never issuable.
CREATE TABLE IF NOT EXISTS staging_quotation_drafts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  submission_key TEXT NOT NULL CHECK (length(submission_key) BETWEEN 8 AND 80),
  customer_name TEXT NOT NULL CHECK (length(trim(customer_name)) BETWEEN 2 AND 160),
  customer_email TEXT,
  opportunity_ref TEXT,
  service_category TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 3 AND 200),
  scope_summary TEXT,
  currency TEXT NOT NULL DEFAULT 'IDR' CHECK (currency='IDR'),
  lines_json TEXT NOT NULL CHECK (json_valid(lines_json)),
  discount_percent REAL NOT NULL DEFAULT 0 CHECK (discount_percent>=0 AND discount_percent<100),
  tax_percent REAL NOT NULL DEFAULT 0 CHECK (tax_percent>=0 AND tax_percent<=25),
  subtotal INTEGER NOT NULL CHECK (subtotal>=0),
  discount_amount INTEGER NOT NULL CHECK (discount_amount>=0),
  taxable_amount INTEGER NOT NULL CHECK (taxable_amount>=0),
  tax_amount INTEGER NOT NULL CHECK (tax_amount>=0),
  grand_total INTEGER NOT NULL CHECK (grand_total>=0),
  validity_days INTEGER NOT NULL DEFAULT 30 CHECK (validity_days BETWEEN 7 AND 180),
  payment_terms TEXT NOT NULL,
  delivery_terms TEXT,
  exclusions TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status='DRAFT'),
  source TEXT NOT NULL DEFAULT 'MANUAL_UNVERIFIED' CHECK (source='MANUAL_UNVERIFIED'),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, owner_user_id, submission_key)
);
CREATE INDEX IF NOT EXISTS staging_quote_tenant_recent ON staging_quotation_drafts (tenant_id, created_at DESC);
INSERT OR IGNORE INTO migration_history(version) VALUES ('0004_cf_staging_manual_quotation_drafts');
