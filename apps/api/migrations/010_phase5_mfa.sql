-- Phase 5 Gate 4B: per-user MFA with encrypted secret and monotonic TOTP replay guard.
ALTER TABLE users ADD COLUMN mfa_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN mfa_secret_enc text;
ALTER TABLE users ADD COLUMN mfa_pending_secret_enc text;
ALTER TABLE users ADD COLUMN mfa_pending_expires_at timestamptz;
ALTER TABLE users ADD COLUMN mfa_last_step bigint NOT NULL DEFAULT -1;
ALTER TABLE users ADD COLUMN mfa_failed_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN mfa_locked_until timestamptz;
ALTER TABLE users ADD CONSTRAINT users_mfa_enabled_secret_chk
  CHECK (NOT mfa_enabled OR mfa_secret_enc IS NOT NULL);
