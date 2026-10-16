-- ICOP Phase 3C (DRAFT): one-time MFA challenge state for Cloudflare D1.
-- STAGING ONLY. This file is NOT auto-applied by CI or worker deployment.
-- No tenant, user, role, session, code or plaintext email is provisioned.
CREATE TABLE IF NOT EXISTS auth_mfa_challenges (
  challenge_hash TEXT PRIMARY KEY NOT NULL CHECK(
    length(challenge_hash)=64 AND challenge_hash NOT GLOB '*[^0-9a-f]*'
  ),
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('mfa_enroll','mfa_login')),
  identity_hash TEXT NOT NULL CHECK(
    length(identity_hash)=64 AND identity_hash NOT GLOB '*[^0-9a-f]*'
  ),
  token_version INTEGER NOT NULL CHECK(token_version>=0),
  issued_at INTEGER NOT NULL CHECK(issued_at>0),
  expires_at INTEGER NOT NULL CHECK(
    expires_at>issued_at AND expires_at<=issued_at+300
  ),
  consumed_at INTEGER,
  FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  CHECK(consumed_at IS NULL OR (
    consumed_at>=issued_at AND consumed_at<=expires_at
  ))
);
CREATE INDEX IF NOT EXISTS auth_mfa_challenges_active_idx
ON auth_mfa_challenges(tenant_id,user_id,purpose,expires_at)
WHERE consumed_at IS NULL;
-- One way: unused -> used, immutable thereafter. Never delete evidence.
CREATE TRIGGER IF NOT EXISTS auth_mfa_challenges_immutable_update
BEFORE UPDATE ON auth_mfa_challenges
BEGIN
  SELECT CASE WHEN
    NEW.challenge_hash!=OLD.challenge_hash OR
    NEW.tenant_id!=OLD.tenant_id OR
    NEW.user_id!=OLD.user_id OR
    NEW.purpose!=OLD.purpose OR
    NEW.identity_hash!=OLD.identity_hash OR
    NEW.token_version!=OLD.token_version OR
    NEW.issued_at!=OLD.issued_at OR
    NEW.expires_at!=OLD.expires_at OR
    OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
  THEN RAISE(ABORT,'MFA_CHALLENGE_IMMUTABLE') END;
END;
CREATE TRIGGER IF NOT EXISTS auth_mfa_challenges_immutable_delete
BEFORE DELETE ON auth_mfa_challenges
BEGIN
  SELECT RAISE(ABORT,'MFA_CHALLENGE_IMMUTABLE');
END;
INSERT OR IGNORE INTO migration_history(version)
VALUES ('0005_cf_free_mfa_challenge_state');
