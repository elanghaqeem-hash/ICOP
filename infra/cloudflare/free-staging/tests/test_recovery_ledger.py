"""U01/U02/U24: in-memory SQLite tests for the D1 MFA recovery ledger.

No customer or production data is written. The live staging migration must
be applied and verified separately after the CI suite passes.
"""
import pathlib
import sqlite3
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
MIGRATIONS = [ROOT / "migrations" / f for f in (
    "0001_bootstrap.sql", "0002_identity_audit.sql",
    "0003_auth_security_foundation.sql", "0004_mfa_recovery_codes.sql"
)]
HASH = "a" * 64
HASH2 = "b" * 64


class RecoveryLedger(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys=ON")
        for file in MIGRATIONS:
            self.db.executescript(file.read_text(encoding="utf-8"))
        self.db.execute("INSERT INTO tenants(id, code, name) VALUES('t1','DEIT','Synthetic') ")
        self.db.execute("INSERT INTO tenants(id, code, name) VALUES('t2','TEST','Synthetic Two')")
        self.db.execute("""
            INSERT INTO users(id, tenant_id, email, email_normalized,
                full_name, password_hash, role)
            VALUES('u1','t1','u1@example.invalid','u1@example.invalid',
                'Test User',?, 'company_admin')
        """, ("synthetic-unusable-hash-" + "x" * 50,))

    def tearDown(self):
        self.db.close()

    def issue(self, tenant='t1', user='u1', digest=HASH):
        self.db.execute("""INSERT INTO mfa_recovery_codes
            (tenant_id,user_id,code_hash,generation,issued_at,expires_at)
            VALUES (?,?,?,1,100,300)""", (tenant, user, digest))

    def test_migration_is_only_structure_no_live_codes(self):
        self.assertEqual(
            self.db.execute("SELECT count(*) FROM mfa_recovery_codes").fetchone()[0], 0
        )
        self.assertEqual(
            self.db.execute("SELECT count(*) FROM migration_history").fetchone()[0], 4
        )

    def test_one_time_consume_cannot_be_replayed(self):
        self.issue()
        statement = """UPDATE mfa_recovery_codes SET consumed_at=?
          WHERE tenant_id=? AND user_id=? AND code_hash=?
            AND consumed_at IS NULL AND revoked_at IS NULL
            AND issued_at <= ? AND expires_at >= ?"""
        first = self.db.execute(statement, (150,'t1','u1',HASH,150,150))
        self.assertEqual(first.rowcount, 1)
        second = self.db.execute(statement, (155,'t1','u1',HASH,155,155))
        self.assertEqual(second.rowcount, 0)
        with self.assertRaisesRegex(sqlite3.IntegrityError, "RECOVERY_CODE_HISTORY_IMMUTABLE"):
            self.db.execute("UPDATE mfa_recovery_codes SET consumed_at=160 WHERE code_hash=?", (HASH,))

    def test_cross_tenant_mismatch_and_foreign_key_rejected(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.issue(tenant='t2', user='u1')
        self.issue()
        changed = self.db.execute(
            "UPDATE mfa_recovery_codes SET consumed_at=150 WHERE tenant_id='t2'"
        )
        self.assertEqual(changed.rowcount,0)

    def test_rotation_marks_old_codes_revoked_not_deleted(self):
        self.issue()
        self.issue(digest=HASH2)
        changed = self.db.execute(
            """UPDATE mfa_recovery_codes SET revoked_at=200
               WHERE tenant_id='t1' AND user_id='u1'
                 AND consumed_at IS NULL AND revoked_at IS NULL"""
        )
        self.assertEqual(changed.rowcount,2)
        self.assertEqual(self.db.execute(
            "SELECT count(*) FROM mfa_recovery_codes WHERE revoked_at=200"
        ).fetchone()[0],2)
        with self.assertRaisesRegex(sqlite3.IntegrityError, "RECOVERY_CODE_HISTORY_IMMUTABLE"):
            self.db.execute("DELETE FROM mfa_recovery_codes WHERE tenant_id='t1'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "RECOVERY_CODE_HISTORY_IMMUTABLE"):
            self.db.execute("UPDATE mfa_recovery_codes SET revoked_at=NULL WHERE code_hash=?", (HASH,))

    def test_invalid_hash_expiry_and_double_state_rejected(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.issue(digest="not-a-valid-hash")
        self.issue()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "UPDATE mfa_recovery_codes SET consumed_at=150,revoked_at=155 WHERE code_hash=?",
                (HASH,),
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "UPDATE mfa_recovery_codes SET consumed_at=350 WHERE code_hash=?",
                (HASH,),
            )


if __name__ == '__main__':
    unittest.main()
