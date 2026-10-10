/* Phase 2b: registri kredensial integrasi (terenkripsi), API key layanan untuk ingest, dokumen final kontrak untuk e-sign, replikasi object storage */

CREATE TABLE integration_credentials (
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  kind             text NOT NULL CHECK (kind IN ('ESIGN_VIDA','ESIGN_PRIVY','STORAGE_S3','TENDER_FEED')),
  enabled          boolean NOT NULL DEFAULT false,
  config           jsonb NOT NULL DEFAULT '{}',
  secret_enc       text,
  secret_hint      text,
  last_test_at     timestamptz,
  last_test_ok     boolean,
  last_test_message text,
  last_run_at      timestamptz,
  updated_by       uuid REFERENCES users(id),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind)
);

CREATE TABLE service_api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  name         text NOT NULL,
  scope        text NOT NULL CHECK (scope IN ('INGEST_SOC','INGEST_VAPT')),
  customer_id  uuid REFERENCES customers(id),
  key_prefix   text NOT NULL,
  key_hash     text NOT NULL UNIQUE,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

ALTER TABLE contracts ADD COLUMN final_document_id uuid REFERENCES documents(id);
ALTER TABLE contracts ADD COLUMN renewal_opportunity_id uuid REFERENCES opportunities(id);

CREATE TABLE storage_objects (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  object_key    text NOT NULL,
  size_bytes    bigint NOT NULL,
  sha256        text NOT NULL,
  replicated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, object_key)
);
