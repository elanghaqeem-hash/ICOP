"""Validate D1/SQLite identity bootstrap against UAT U01/U02/U24 safeguards.

In-memory synthetic fixtures ONLY; no Cloudflare DB/production access.
SQLite matches most D1 SQL, but live D1 application is a separate gate.
"""
import pathlib
import sqlite3
import unittest

HERE = pathlib.Path(__file__).resolve().parents[1]
BOOTSTRAP = HERE / "migrations" / "0001_bootstrap.sql"
IDENTITY = HERE / "migrations" / "0002_identity_audit.sql"


class IdentitySchema(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript(BOOTSTRAP.read_text(encoding="utf-8"))
        self.db.executescript(IDENTITY.read_text(encoding="utf-8"))

    def tearDown(self):
        self.db.close()

    def test_no_tenant_user_or_audit_seeded(self):
        for table in ("tenants", "users", "audit_events"):
            self.assertEqual(self.db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0], 0)
        applied = {r[0] for r in self.db.execute("SELECT version FROM migration_history")}
        self.assertIn("0002_cf_free_identity_audit_schema", applied)

    def synthetic_identity(self):
        self.db.execute("INSERT INTO tenants(id,code,name) VALUES(?,?,?)", ("tenant-a", "ACME", "Synthetic Test A"))
        self.db.execute("INSERT INTO tenants(id,code,name) VALUES(?,?,?)", ("tenant-b", "TEST", "Synthetic Test B"))
        self.db.execute(
            "INSERT INTO users(id,tenant_id,email,email_normalized,full_name,password_hash,role)"
            " VALUES (?,?,?,?,?,?,?)",
            ("alice", "tenant-a", "test@example.invalid", "test@example.invalid", "Synthetic Test",
             "not-a-real-usable-hash-" + "x" * 48, "company_admin")
        )

    def test_isolation_composite_actor_reference(self):
        self.synthetic_identity()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO audit_events(tenant_id,actor_id,action,entity_type) VALUES(?,?,?,?)",
                            ("tenant-b", "alice", "UPDATE", "customer"))
        self.db.execute("INSERT INTO audit_events(tenant_id,actor_id,action,entity_type) VALUES(?,?,?,?)",
                        ("tenant-a", "alice", "UPDATE", "customer"))

    def test_reject_unknown_tenant_and_cross_tenant_duplicate_email(self):
        self.synthetic_identity()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "INSERT INTO users(id,tenant_id,email,email_normalized,full_name,password_hash,role)"
                " VALUES(?,?,?,?,?,?,?)",
                ("other", "unknown", "u@example.invalid", "u@example.invalid",
                 "Synthetic Test", "x" * 64, "auditor"))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "INSERT INTO users(id,tenant_id,email,email_normalized,full_name,password_hash,role)"
                " VALUES(?,?,?,?,?,?,?)",
                ("other2", "tenant-a", "test@example.invalid", "test@example.invalid",
                 "Synthetic Test", "x" * 64, "auditor"))
        self.db.execute(
            "INSERT INTO users(id,tenant_id,email,email_normalized,full_name,password_hash,role)"
            " VALUES(?,?,?,?,?,?,?)",
            ("same-email-other-tenant", "tenant-b", "test@example.invalid", "test@example.invalid",
             "Synthetic Test", "x" * 64, "auditor"))

    def test_defaults_and_audit_immutability(self):
        self.synthetic_identity()
        user = self.db.execute("SELECT mfa_enabled,force_password_change,token_version,is_active FROM users").fetchone()
        self.assertEqual(user, (0, 1, 0, 1))
        self.db.execute("INSERT INTO audit_events(tenant_id,actor_id,action,entity_type) VALUES(?,?,?,?)",
                        ("tenant-a", "alice", "LOGIN", "user"))
        with self.assertRaisesRegex(sqlite3.IntegrityError, "AUDIT_APPEND_ONLY"):
            self.db.execute("UPDATE audit_events SET action='MODIFIED' WHERE id=1")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "AUDIT_APPEND_ONLY"):
            self.db.execute("DELETE FROM audit_events WHERE id=1")

    def test_illegal_role_is_denied(self):
        self.synthetic_identity()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE users SET role='root_anything' WHERE id='alice'")


if __name__ == "__main__":
    unittest.main()
