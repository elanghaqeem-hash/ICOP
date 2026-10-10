-- 002 CRM & catalogue
CREATE TABLE customers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  code               text NOT NULL,
  legal_name         text NOT NULL,
  brand_name         text,
  parent_id          uuid REFERENCES customers(id),
  industry           text NOT NULL,
  subsector          text,
  classification     text NOT NULL DEFAULT 'B2B' CHECK (classification IN ('B2B','B2G','B2B2B')),
  client_tier        text NOT NULL DEFAULT 'A' CHECK (client_tier IN ('S','A','B','C','D','E')),
  npwp               text,
  address            text,
  city               text,
  onboarding_status  text NOT NULL DEFAULT 'PROSPECT' CHECK (onboarding_status IN ('PROSPECT','ONBOARDING','ACTIVE','INACTIVE')),
  segmentation       text,
  account_owner_id   uuid REFERENCES users(id),
  existing_technologies text[] NOT NULL DEFAULT '{}',
  notes              text,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
-- Deduplication: nama legal (dinormalisasi) & NPWP unik per tenant
CREATE UNIQUE INDEX customers_name_uq ON customers (tenant_id, regexp_replace(lower(legal_name), '[^a-z0-9]', '', 'g'));
CREATE UNIQUE INDEX customers_npwp_uq ON customers (tenant_id, npwp) WHERE npwp IS NOT NULL;
CREATE INDEX customers_tenant_name_idx ON customers (tenant_id, legal_name);

ALTER TABLE users ADD CONSTRAINT users_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id);

CREATE TABLE contacts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  customer_id        uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  full_name          text NOT NULL,
  title              text,
  email              text,
  phone              text,
  contact_role       text NOT NULL DEFAULT 'primary' CHECK (contact_role IN ('primary','technical','procurement','finance','management','other')),
  is_decision_maker  boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contacts_customer_idx ON contacts (tenant_id, customer_id);

CREATE TABLE opportunities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  code              text NOT NULL,
  customer_id       uuid NOT NULL REFERENCES customers(id),
  name              text NOT NULL,
  service_category  text NOT NULL,
  stage             text NOT NULL DEFAULT 'LEAD' CHECK (stage IN ('LEAD','QUALIFIED','SCOPING','PROPOSAL','NEGOTIATION','WON','LOST')),
  amount_estimate   numeric(18,2) NOT NULL DEFAULT 0,
  probability       int NOT NULL DEFAULT 10 CHECK (probability BETWEEN 0 AND 100),
  expected_close    date,
  source            text NOT NULL DEFAULT 'direct' CHECK (source IN ('direct','referral','partner','tender','inbound','import')),
  is_tender         boolean NOT NULL DEFAULT false,
  owner_id          uuid REFERENCES users(id),
  lost_reason       text,
  competitors       text[] NOT NULL DEFAULT '{}',
  next_action       text,
  stage_changed_at  timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  CONSTRAINT lost_reason_required CHECK (stage <> 'LOST' OR lost_reason IS NOT NULL)
);
CREATE INDEX opportunities_stage_idx ON opportunities (tenant_id, stage, updated_at DESC);
CREATE INDEX opportunities_customer_idx ON opportunities (tenant_id, customer_id);

CREATE TABLE opportunity_stage_history (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  opportunity_id  uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  from_stage      text,
  to_stage        text NOT NULL,
  changed_by      uuid REFERENCES users(id),
  changed_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE activities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  customer_id     uuid NOT NULL REFERENCES customers(id),
  opportunity_id  uuid REFERENCES opportunities(id),
  kind            text NOT NULL CHECK (kind IN ('call','meeting','visit','email','task','note')),
  subject         text NOT NULL,
  notes           text,
  due_at          timestamptz,
  done_at         timestamptz,
  owner_id        uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activities_customer_idx ON activities (tenant_id, customer_id, created_at DESC);

CREATE TABLE catalog_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  sku                text NOT NULL,
  item_type          text NOT NULL CHECK (item_type IN ('service','product','license','bundle')),
  pillar             text NOT NULL,
  category           text NOT NULL,
  name               text NOT NULL,
  description        text,
  vendor             text,
  pricing_structure  text NOT NULL,
  unit               text NOT NULL,
  list_price         numeric(18,2),
  cost_price         numeric(18,2),
  currency           text NOT NULL DEFAULT 'IDR',
  vendor_authorized  boolean NOT NULL DEFAULT false,
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sku)
);
