/* Phase 4: WBS & timesheet proyek, change request, helpdesk & SLA, renewal & dunning */

CREATE TABLE project_tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id    uuid REFERENCES project_tasks(id),
  wbs_code     text NOT NULL,
  name         text NOT NULL,
  assignee_id  uuid REFERENCES users(id),
  start_date   date,
  due_date     date,
  planned_md   numeric(8,2) NOT NULL DEFAULT 0 CHECK (planned_md >= 0),
  progress_pct int NOT NULL DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),
  status       text NOT NULL DEFAULT 'TODO' CHECK (status IN ('TODO','IN_PROGRESS','BLOCKED','DONE')),
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, wbs_code),
  CHECK (due_date IS NULL OR start_date IS NULL OR due_date >= start_date)
);

CREATE TABLE project_timesheets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id     uuid REFERENCES project_tasks(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  work_date   date NOT NULL,
  md          numeric(4,2) NOT NULL CHECK (md > 0 AND md <= 1.5),
  note        text,
  status      text NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','APPROVED','REJECTED')),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX project_timesheets_uq ON project_timesheets (project_id, user_id, work_date, coalesce(task_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE change_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  project_id          uuid NOT NULL REFERENCES projects(id),
  contract_id         uuid NOT NULL REFERENCES contracts(id),
  number              text NOT NULL,
  title               text NOT NULL,
  description         text NOT NULL,
  reason              text NOT NULL,
  value_delta         numeric(18,2) NOT NULL DEFAULT 0,
  md_delta            numeric(8,2) NOT NULL DEFAULT 0,
  schedule_delta_days int NOT NULL DEFAULT 0,
  status              text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_APPROVAL','APPROVED','REJECTED')),
  approval_request_id uuid REFERENCES approval_requests(id),
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  decided_at          timestamptz,
  UNIQUE (tenant_id, number)
);

CREATE TABLE sla_targets (
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  priority           text NOT NULL CHECK (priority IN ('P1','P2','P3','P4')),
  response_minutes   int NOT NULL CHECK (response_minutes > 0),
  resolution_minutes int NOT NULL CHECK (resolution_minutes > 0),
  PRIMARY KEY (tenant_id, priority)
);

CREATE TABLE tickets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  number            text NOT NULL,
  customer_id       uuid NOT NULL REFERENCES customers(id),
  project_id        uuid REFERENCES projects(id),
  source            text NOT NULL CHECK (source IN ('PORTAL','INTERNAL','SOC_INGEST','VAPT_INGEST')),
  category          text NOT NULL CHECK (category IN ('INCIDENT','SERVICE_REQUEST','QUESTION','VULNERABILITY')),
  priority          text NOT NULL CHECK (priority IN ('P1','P2','P3','P4')),
  title             text NOT NULL,
  description       text NOT NULL,
  status            text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','WAITING_CUSTOMER','RESOLVED','CLOSED')),
  assignee_id       uuid REFERENCES users(id),
  response_due_at   timestamptz NOT NULL,
  resolution_due_at timestamptz NOT NULL,
  first_response_at timestamptz,
  resolved_at       timestamptz,
  closed_at         timestamptz,
  response_breached boolean NOT NULL DEFAULT false,
  resolution_breached boolean NOT NULL DEFAULT false,
  external_ref      text,
  meta              jsonb NOT NULL DEFAULT '{}',
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);
CREATE UNIQUE INDEX tickets_external_uq ON tickets (tenant_id, source, external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX tickets_open_idx ON tickets (tenant_id, status, resolution_due_at);

CREATE TABLE ticket_comments (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  ticket_id  uuid NOT NULL REFERENCES tickets(id),
  author_id  uuid REFERENCES users(id),
  body       text NOT NULL,
  internal   boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER ticket_comments_append_only BEFORE UPDATE OR DELETE ON ticket_comments
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE renewal_reminders (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  contract_id uuid NOT NULL REFERENCES contracts(id),
  days_before int NOT NULL CHECK (days_before IN (180, 90, 60, 30)),
  sent_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contract_id, days_before)
);

CREATE TABLE dunning_log (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  level      int NOT NULL CHECK (level IN (1, 2, 3)),
  channel    text NOT NULL,
  detail     text,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (invoice_id, level)
);
