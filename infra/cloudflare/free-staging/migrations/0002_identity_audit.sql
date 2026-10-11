-- ICOP Cloudflare Free staging, migration 0002.
-- Source mapping: apps/api/migrations/001_core.sql and 010_phase5_security.sql
-- Basis: UAT Pack U01/U02 (identity + MFA) and U24 (append-only audit).
-- This creates empty structural tables only: it DOES NOT enable login or seed
-- users, customers, tenant records, passwords or personal information.
-- PostgreSQL UUID -> validated TEXT IDs supplied by future application;
-- timestamptz -> ISO/UTC TEXT; text[] -> JSON serialized TEXT.
-- A distinct migration is required for all PostgreSQL procedural and business SQL.

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY NOT NULL,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (length(trim(code)) BETWEEN 2 AND 32),
  CHECK (length(trim(name)) > 0)
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  customer_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  force_password_change INTEGER NOT NULL DEFAULT 1 CHECK (force_password_change IN (0, 1)),
  failed_logins INTEGER NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
  locked_until TEXT,
  token_version INTEGER NOT NULL DEFAULT 0 CHECK (token_version >= 0),
  mfa_enabled INTEGER NOT NULL DEFAULT 0 CHECK (mfa_enabled IN (0, 1)),
  mfa_secret_enc TEXT,
  mfa_pending_secret_enc TEXT,
  mfa_recovery_hashes_json TEXT NOT NULL DEFAULT '[]',
  mfa_last_step INTEGER,
  mfa_enrolled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, email_normalized),
  CHECK (email_normalized = lower(trim(email)) AND length(email_normalized) > 3),
  CHECK (length(trim(full_name)) > 0),
  CHECK (length(password_hash) >= 50),
  CHECK (role IN (
    'super_admin','company_admin','director','vp_head','sales_manager',
    'account_manager','presales_engineer','solution_architect','pricing_finance',
    'legal','tender_officer','procurement_officer','project_manager',
    'delivery_engineer','soc_operations','product_manager','customer_support',
    'auditor','partner_user','customer_user'
  ))
);
CREATE INDEX IF NOT EXISTS users_tenant_active_idx ON users(tenant_id, is_active);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  before_json TEXT,
  after_json TEXT,
  ip TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CHECK (length(trim(action)) > 0),
  CHECK (length(trim(entity_type)) > 0)
);
CREATE INDEX IF NOT EXISTS audit_events_entity_idx
  ON audit_events (tenant_id, entity_type, entity_id, at DESC);

-- Match PostgreSQL's forbid_mutation() policy with SQLite triggers.
CREATE TRIGGER IF NOT EXISTS audit_events_immutable_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS audit_events_immutable_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY');
END;

-- Record after all schema statements. Never mark a migration before completion.
INSERT OR IGNORE INTO migration_history(version)
VALUES ('0002_cf_free_identity_audit_schema');
