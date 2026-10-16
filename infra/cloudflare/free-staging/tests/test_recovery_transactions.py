"""U01/U02/U24: transaction and immutable-history regression for D1 MFA recovery.

Purely synthetic SQLite file (temporary, deleted after each test). No
Cloudflare access, real user, production DB, staging writes or credentials.
These tests harden recovery ledger behavior, not HTTP MFA/login UAT.
"""
from pathlib import Path
from tempfile import TemporaryDirectory
import sqlite3
import unittest

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = (
    "0001_bootstrap.sql",
    "0002_identity_audit.sql",
    "0003_auth_security_foundation.sql",
    "0004_mfa_recovery_codes.sql",
)
DIGEST = "a" * 64
OTHER_DIGEST = "b" * 64
CONSUME = """
    UPDATE mfa_recovery_codes SET consumed_at=?
    WHERE tenant_id=? AND user_id=? AND code_hash=?
      AND consumed_at IS NULL AND revoked_at IS NULL
      AND issued_at<=? AND expires_at>=?
"""


class RecoveryTransactionGate(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory(prefix="icop-recovery-uat-")
        self.path = str(Path(self.tmp.name) / "isolated.sqlite3")
        self.db = sqlite3.connect(self.path, timeout=0.1)
        self.db.execute("PRAGMA foreign_keys=ON")
        for migration in MIGRATIONS:
            self.db.executescript((ROOT / "migrations" / migration).read_text(encoding="utf-8"))
        for tenant, code in (("t1", "DEIT"), ("t2", "OTHER")):
            self.db.execute(
                "INSERT INTO tenants(id,code,name) VALUES(?,?,?)",
                (tenant, code, "Synthetic " + tenant),
            )
        for user_id, tenant in (("u1", "t1"), ("u2", "t2")):
            email = user_id + "@example.invalid"
            self.db.execute("""
                INSERT INTO users(id,tenant_id,email,email_normalized,full_name,password_hash,role)
                VALUES(?,?,?,?,?,?,?)
            """, (user_id, tenant, email, email, "Synthetic", "inert:" + "x" * 70, "company_admin"))
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def issue(self, tenant="t1", user="u1", digest=DIGEST):
        self.db.execute("""
            INSERT INTO mfa_recovery_codes
              (tenant_id,user_id,code_hash,generation,issued_at,expires_at)
            VALUES(?,?,?,1,100,300)
        """, (tenant, user, digest))

    def test_failed_session_write_rolls_back_recovery_consumption(self):
        self.issue()
        self.db.commit()
        self.db.execute("BEGIN IMMEDIATE")
        changed = self.db.execute(CONSUME, (150, "t1", "u1", DIGEST, 150, 150))
        self.assertEqual(changed.rowcount, 1)
        with self.assertRaises(sqlite3.IntegrityError):
            # Intentionally invalid composite FK; the auth transaction must be atomic.
            self.db.execute("""
                INSERT INTO auth_sessions
                  (session_id_hash,tenant_id,user_id,token_version,mfa_verified,issued_at,expires_at)
                VALUES(?,?,?,?,?,?,?)
            """, ("c" * 64, "t2", "u1", 0, 1, 150, 150 + 3600))
        self.db.rollback()
        row = self.db.execute(
            "SELECT consumed_at FROM mfa_recovery_codes WHERE tenant_id='t1' AND user_id='u1'"
        ).fetchone()
        self.assertEqual(row, (None,))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM auth_sessions").fetchone()[0], 0)

    def test_competing_connections_cannot_both_consume_one_code(self):
        self.issue()
        self.db.commit()
        first = sqlite3.connect(self.path, timeout=0.05)
        second = sqlite3.connect(self.path, timeout=0.05)
        try:
            first.execute("BEGIN IMMEDIATE")
            self.assertEqual(
                first.execute(CONSUME, (150, "t1", "u1", DIGEST, 150, 150)).rowcount, 1
            )
            with self.assertRaisesRegex(sqlite3.OperationalError, "locked"):
                second.execute(CONSUME, (150, "t1", "u1", DIGEST, 150, 150))
            first.commit()
            self.assertEqual(
                second.execute(CONSUME, (155, "t1", "u1", DIGEST, 155, 155)).rowcount, 0
            )
        finally:
            first.close()
            second.close()
        self.assertEqual(
            self.db.execute("SELECT COUNT(*) FROM mfa_recovery_codes WHERE consumed_at=150").fetchone()[0], 1
        )

    def test_revocation_replay_and_immutable_history(self):
        self.issue()
        self.assertEqual(self.db.execute("""
            UPDATE mfa_recovery_codes SET revoked_at=200
            WHERE tenant_id='t1' AND user_id='u1' AND consumed_at IS NULL AND revoked_at IS NULL
        """).rowcount, 1)
        self.assertEqual(
            self.db.execute(CONSUME, (210, "t1", "u1", DIGEST, 210, 210)).rowcount, 0
        )
        with self.assertRaisesRegex(sqlite3.IntegrityError, "RECOVERY_CODE_HISTORY_IMMUTABLE"):
            self.db.execute("UPDATE mfa_recovery_codes SET revoked_at=NULL WHERE code_hash=?", (DIGEST,))
        with self.assertRaisesRegex(sqlite3.IntegrityError, "RECOVERY_CODE_HISTORY_IMMUTABLE"):
            self.db.execute("DELETE FROM mfa_recovery_codes WHERE code_hash=?", (DIGEST,))

    def test_tenant_scoped_fk_and_duplicate_digest(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.issue("t2", "u1")  # user u1 exists only under tenant t1
        self.issue()
        with self.assertRaises(sqlite3.IntegrityError):
            self.issue()
        # Cross-tenant user can use the same synthetic digest without reaching t1.
        self.issue("t2", "u2")
        self.assertEqual(
            self.db.execute(CONSUME, (150, "t2", "u2", DIGEST, 150, 150)).rowcount, 1
        )
        self.assertEqual(
            self.db.execute("SELECT consumed_at FROM mfa_recovery_codes WHERE tenant_id='t1'").fetchone(),
            (None,),
        )
        self.assertEqual(
            self.db.execute("PRAGMA foreign_key_check").fetchall(), []
        )

    def test_append_only_audit_and_recovery_constraints(self):
        self.db.execute("""
            INSERT INTO audit_events(tenant_id,actor_id,action,entity_type,entity_id,ip)
            VALUES('t1','u1','auth.mfa_recovery_used','user','u1','hmac-sha256:synthetic')
        """)
        with self.assertRaisesRegex(sqlite3.IntegrityError, "AUDIT_APPEND_ONLY"):
            self.db.execute("UPDATE audit_events SET action='modified'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "AUDIT_APPEND_ONLY"):
            self.db.execute("DELETE FROM audit_events")
        with self.assertRaises(sqlite3.IntegrityError):
            self.issue(digest="invalid")
        self.issue(digest=OTHER_DIGEST)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                UPDATE mfa_recovery_codes SET consumed_at=150,revoked_at=160 WHERE code_hash=?
            """, (OTHER_DIGEST,))
        self.assertEqual(self.db.execute("PRAGMA integrity_check").fetchone(), ("ok",))


if __name__ == "__main__":
    unittest.main()
