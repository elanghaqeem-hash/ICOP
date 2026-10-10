-- 001 Core: tenant, user, audit, idempotency, numbering, notification
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id),
  email                  text NOT NULL,
  full_name              text NOT NULL,
  password_hash          text NOT NULL,
  role                   text NOT NULL,
  customer_id            uuid,              -- diisi hanya untuk customer_user
  is_active              boolean NOT NULL DEFAULT true,
  force_password_change  boolean NOT NULL DEFAULT true,
  failed_logins          int NOT NULL DEFAULT 0,
  locked_until           timestamptz,
  token_version          int NOT NULL DEFAULT 0,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_role_chk CHECK (role IN (
    'super_admin','company_admin','director','vp_head','sales_manager','account_manager',
    'presales_engineer','solution_architect','pricing_finance','legal','tender_officer',
    'procurement_officer','project_manager','delivery_engineer','soc_operations',
    'product_manager','customer_support','auditor','partner_user','customer_user'))
);
CREATE UNIQUE INDEX users_tenant_email_uq ON users (tenant_id, lower(email));

-- Append-only audit trail
CREATE TABLE audit_events (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  actor_id     uuid,
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    text,
  before       jsonb,
  after        jsonb,
  ip           text,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_entity_idx ON audit_events (tenant_id, entity_type, entity_id, at DESC);

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Idempotency for financial/state-changing POSTs
CREATE TABLE idempotency_keys (
  tenant_id    uuid NOT NULL,
  key          text NOT NULL,
  user_id      uuid NOT NULL,
  route        text NOT NULL,
  status_code  int,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

-- Gapless per-tenant document numbering
CREATE TABLE number_sequences (
  tenant_id   uuid NOT NULL,
  seq_name    text NOT NULL,
  period      text NOT NULL,
  last_value  int  NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, seq_name, period)
);

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  kind        text NOT NULL,
  title       text NOT NULL,
  body        text,
  link        text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, read_at, created_at DESC);
