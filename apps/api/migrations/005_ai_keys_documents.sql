-- 005 AI key registry (terenkripsi), aktivasi AI per fitur, Document Center (OCR, kompresi, analisis), job queue

ALTER TABLE ai_providers ADD COLUMN api_key_enc text;
ALTER TABLE ai_providers ADD COLUMN api_key_last4 text;
ALTER TABLE ai_providers ADD COLUMN key_updated_at timestamptz;
ALTER TABLE ai_providers ADD COLUMN key_updated_by uuid REFERENCES users(id);

CREATE TABLE ai_features (
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  feature      text NOT NULL,
  enabled      boolean NOT NULL DEFAULT true,
  updated_by   uuid REFERENCES users(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, feature)
);

/* ───── Job queue (DB-backed, FOR UPDATE SKIP LOCKED) ───── */
CREATE TABLE jobs (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  kind          text NOT NULL,
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','DONE','FAILED')),
  attempts      int NOT NULL DEFAULT 0,
  max_attempts  int NOT NULL DEFAULT 3,
  run_after     timestamptz NOT NULL DEFAULT now(),
  progress      jsonb,
  last_error    text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz
);
CREATE INDEX jobs_queue_idx ON jobs (status, run_after) WHERE status = 'QUEUED';

/* ───── Document Center ───── */
CREATE TABLE documents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  title              text NOT NULL,
  filename           text NOT NULL,
  mime               text NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('pdf','docx','txt','image')),
  entity_type        text CHECK (entity_type IN ('customer','opportunity','tender','contract','project','general')),
  entity_id          uuid,
  confidentiality    text NOT NULL DEFAULT 'INTERNAL' CHECK (confidentiality IN ('INTERNAL','CONFIDENTIAL','RESTRICTED')),
  size_original      bigint NOT NULL,
  size_stored        bigint,
  sha256             text NOT NULL,
  original_path      text NOT NULL,
  stored_path        text,
  page_count         int,
  status             text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','PROCESSING','READY','FAILED')),
  text_source        text CHECK (text_source IN ('NATIVE','OCR','MIXED','NONE')),
  ocr_pages          int NOT NULL DEFAULT 0,
  ocr_confidence     numeric(5,2),
  compression        jsonb,
  processing_note    text,
  options            jsonb NOT NULL DEFAULT '{}',
  uploaded_by        uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz
);
CREATE UNIQUE INDEX documents_hash_uq ON documents (tenant_id, sha256);
CREATE INDEX documents_entity_idx ON documents (tenant_id, entity_type, entity_id);

CREATE TABLE document_pages (
  document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_no      int NOT NULL,
  text         text NOT NULL,
  source       text NOT NULL CHECK (source IN ('NATIVE','OCR')),
  confidence   numeric(5,2),
  PRIMARY KEY (document_id, page_no)
);

CREATE TABLE document_analyses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  document_id   uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('SUMMARY','RISKS','EXTRACT','QA')),
  question      text,
  fields        jsonb,
  status        text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','DONE','FAILED')),
  result        jsonb,
  verification  jsonb,
  providers     jsonb NOT NULL DEFAULT '[]',
  error         text,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX document_analyses_doc_idx ON document_analyses (document_id, created_at DESC);

ALTER TABLE tender_documents DROP CONSTRAINT tender_documents_extraction_status_check;
ALTER TABLE tender_documents ADD CONSTRAINT tender_documents_extraction_status_check
  CHECK (extraction_status IN ('PENDING','DONE','NEEDS_OCR','OCR_QUEUED','OCR_RUNNING','FAILED','NOT_APPLICABLE'));
ALTER TABLE tender_documents ADD COLUMN text_source text;
