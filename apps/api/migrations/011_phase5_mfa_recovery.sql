-- Phase 5 Gate 4C: two-person, expiring, audited MFA recovery.
-- Users must re-authenticate, change password, and enroll MFA after approval.
CREATE TABLE mfa_recovery_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  target_user_id uuid NOT NULL REFERENCES users(id),
  requested_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  reason text NOT NULL CHECK (length(trim(reason)) >= 20),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  decided_at timestamptz,
  CHECK (target_user_id <> requested_by),
  CHECK (approved_by IS NULL OR (approved_by <> requested_by AND approved_by <> target_user_id))
);
CREATE INDEX mfa_recovery_tenant_queue_idx
  ON mfa_recovery_requests(tenant_id, status, created_at DESC);
CREATE UNIQUE INDEX mfa_recovery_only_one_pending
  ON mfa_recovery_requests(tenant_id, target_user_id) WHERE status = 'PENDING';
