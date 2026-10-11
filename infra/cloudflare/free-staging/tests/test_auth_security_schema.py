"""Stage 3 structural safety only: SQLite in memory, no real user secrets."""
import pathlib
import sqlite3
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
MIGRATIONS = [
    ROOT / "migrations" / "0001_bootstrap.sql",
    ROOT / "migrations" / "0002_identity_audit.sql",
    ROOT / "migrations" / "0003_auth_security_foundation.sql",
]

class AuthSecuritySchema(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys=ON")
        for p in MIGRATIONS:
            self.db.executescript(p.read_text(encoding="utf-8"))

    def tearDown(self):
        self.db.close()

    def synthetic_identity(self):
        self.db.execute("INSERT INTO tenants(id,code,name) VALUES('t-a','TESTA','Test A')")
        self.db.execute("INSERT INTO tenants(id,code,name) VALUES('t-b','TESTB','Test B')")
        self.db.execute("""INSERT INTO users
          (id,tenant_id,email,email_normalized,full_name,password_hash,role)
          VALUES('u-a','t-a','a@example.invalid','a@example.invalid','Test User',?,'company_admin')""",
          ("synthetic-unusable-hash:" + "x"*50,))

    def test_empty_live_compatible_structure(self):
        for name in ("tenants","users","auth_sessions","mfa_used_steps","auth_attempt_buckets"):
            self.assertEqual(self.db.execute("SELECT COUNT(*) FROM " + name).fetchone()[0],0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM migration_history").fetchone()[0],3)
        self.assertIn("mfa_locked_until", [x[1] for x in self.db.execute("PRAGMA table_info(users)")])

    def test_session_requires_same_tenant_and_monotone_lifetime(self):
        self.synthetic_identity()
        def session(tenant,expires):
            self.db.execute("""INSERT INTO auth_sessions(session_id_hash,tenant_id,user_id,
                 token_version,issued_at,expires_at) VALUES(?,?,?,?,?,?)""",
                 ("f"*64,tenant,"u-a",0,1000,expires))
        with self.assertRaises(sqlite3.IntegrityError):
            session("t-b",2000)
        with self.assertRaises(sqlite3.IntegrityError):
            session("t-a",500)
        session("t-a",2000)

    def test_one_time_mfa_steps_and_cross_tenant_replay_denied(self):
        self.synthetic_identity()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO mfa_used_steps VALUES('t-b','u-a',123,1000)")
        self.db.execute("INSERT INTO mfa_used_steps VALUES('t-a','u-a',123,1000)")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO mfa_used_steps VALUES('t-a','u-a',123,1001)")

    def test_bucket_rejects_raw_short_keys_and_negative_counts(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO auth_attempt_buckets VALUES('ip','email','t',100,1,NULL)")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO auth_attempt_buckets VALUES(?,?,?,?,?,NULL)",
                            ("t"*64,"i"*64,"n"*64,100,-1))

if __name__ == "__main__":
    unittest.main()
