-- ICOP Cloudflare Free staging — authentication security foundation only.
-- Mirrors the Fastify auth route lockout / MFA state machine structurally.
-- Safe: creates empty tables and adds columns, NO accounts or secrets seeded.
-- Gate: login remains 503 until cryptographic, session, MFA and identity tests pass.
ALTER TABLE users ADD COLUMN mfa_pending_expires_at TEXT;
ALTER TABLE users ADD COLUMN mfa_failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK(mfa_failed_attempts >= 0);
ALTER TABLE users ADD COLUMN mfa_locked_until TEXT;

-- Optional account/session metadata, NEVER store bearer tokens or plaintext IPs.
-- Raw identifiers must be keyed-HMAC'd using a separate, secret key.
CREATE TABLE IF NOT EXISTS auth_attempt_buckets (
  tenant_key TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  network_key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK(failed_count >= 0),
  locked_until INTEGER,
  PRIMARY KEY (tenant_key,identity_key,network_key,window_start),
  CHECK(length(tenant_key) >= 32),
  CHECK(length(identity_key) >= 32),
  CHECK(length(network_key) >= 32)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS auth_attempt_window_idx
  ON auth_attempt_buckets(window_start);

-- Tokens must be verified, revocable and tenant-scoped in application code.
-- session_id_hash is a keyed digest; raw session IDs are never stored.
CREATE TABLE IF NOT EXISTS auth_sessions (
  session_id_hash TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  token_version INTEGER NOT NULL CHECK(token_version >= 0),
  mfa_verified INTEGER NOT NULL DEFAULT 0 CHECK(mfa_verified IN (0,1)),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  CHECK(length(session_id_hash) >= 32),
  CHECK(expires_at > issued_at),
  CHECK(revoked_at IS NULL OR revoked_at >= issued_at)
);
CREATE INDEX IF NOT EXISTS auth_sessions_active_idx
  ON auth_sessions(tenant_id,user_id,expires_at,revoked_at);

-- Distinct replay prevention: unique per user+TOTP step.
-- The executor must DELETE expired rows with an approved retention policy.
CREATE TABLE IF NOT EXISTS mfa_used_steps (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  totp_step INTEGER NOT NULL CHECK(totp_step >= 0),
  used_at INTEGER NOT NULL,
  PRIMARY KEY(tenant_id,user_id,totp_step),
  FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT
) WITHOUT ROWID;

INSERT OR IGNORE INTO migration_history(version)
VALUES ('0003_cf_free_auth_security_foundation');
