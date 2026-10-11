-- ICOP Cloudflare Free staging schema v0004: MFA recovery code lifecycle.
-- Based on Phase 6 UAT U01/U02/U24. NO users or actual codes are created.
-- Worker must persist ONLY keyed HMAC digests, never plaintext recovery codes.
CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  code_hash TEXT NOT NULL CHECK (
    length(code_hash) = 64 AND code_hash NOT GLOB '*[^0-9a-f]*'
  ),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  issued_at INTEGER NOT NULL CHECK (issued_at > 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
  consumed_at INTEGER,
  revoked_at INTEGER,
  PRIMARY KEY (tenant_id, user_id, code_hash),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
    ON DELETE RESTRICT,
  CHECK (consumed_at IS NULL OR (
    consumed_at >= issued_at AND consumed_at <= expires_at
  )),
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at),
  CHECK (consumed_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX IF NOT EXISTS mfa_recovery_unused_idx
ON mfa_recovery_codes(tenant_id, user_id, generation, expires_at)
WHERE consumed_at IS NULL AND revoked_at IS NULL;

-- A code can transition from UNUSED -> CONSUMED *or* REVOKED once.
-- No changes to actor ownership, issued hash or historical tombstones.
CREATE TRIGGER IF NOT EXISTS mfa_recovery_codes_lifecycle
BEFORE UPDATE ON mfa_recovery_codes
BEGIN
  SELECT CASE WHEN
    NEW.tenant_id != OLD.tenant_id OR NEW.user_id != OLD.user_id OR
    NEW.code_hash != OLD.code_hash OR NEW.generation != OLD.generation OR
    NEW.issued_at != OLD.issued_at OR NEW.expires_at != OLD.expires_at OR
    OLD.consumed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL OR
    (NEW.consumed_at IS NULL AND NEW.revoked_at IS NULL) OR
    (NEW.consumed_at IS NOT NULL AND NEW.revoked_at IS NOT NULL)
  THEN RAISE(ABORT, 'RECOVERY_CODE_HISTORY_IMMUTABLE') END;
END;
CREATE TRIGGER IF NOT EXISTS mfa_recovery_codes_no_delete
BEFORE DELETE ON mfa_recovery_codes
BEGIN
  SELECT RAISE(ABORT, 'RECOVERY_CODE_HISTORY_IMMUTABLE');
END;

INSERT OR IGNORE INTO migration_history(version)
VALUES ('0004_cf_free_mfa_recovery_codes');
