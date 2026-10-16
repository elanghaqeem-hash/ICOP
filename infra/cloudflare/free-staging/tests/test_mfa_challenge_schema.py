"""Phase 3C U01/U24 — one-time challenge migration (SQLite-only).

No network, no staging writes and no actual identities. Source migration 0005
must never be automatically applied to production or live staging by this test.
"""
from pathlib import Path
import sqlite3
import unittest

ROOT=Path(__file__).resolve().parents[1]
SOURCES=[
  '0001_bootstrap.sql','0002_identity_audit.sql',
  '0003_auth_security_foundation.sql','0004_mfa_recovery_codes.sql',
  '0005_mfa_challenge_state.sql'
]

class MfaChallengeSchema(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:')
        self.db.execute('PRAGMA foreign_keys=ON')
        for name in SOURCES:
            self.db.executescript((ROOT/'migrations'/name).read_text(encoding='utf8'))
        self.db.execute("INSERT INTO tenants(id,code,name) VALUES('t1','DEIT','Synthetic')")
        self.db.execute("INSERT INTO tenants(id,code,name) VALUES('t2','OTHER','Synthetic')")
        self.db.execute("""
            INSERT INTO users(id,tenant_id,email,email_normalized,full_name,password_hash,role)
            VALUES('u1','t1','fake@example.invalid','fake@example.invalid',
              'Synthetic','inert-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx','company_admin')
        """)
    def tearDown(self):
        self.db.close()
    def issue(self, digest='a'*64, tenant='t1', user='u1', purpose='mfa_enroll',
              identity='b'*64, issued=100, expires=400):
        self.db.execute("""
            INSERT INTO auth_mfa_challenges
            (challenge_hash,tenant_id,user_id,purpose,identity_hash,token_version,
             issued_at,expires_at)
            VALUES(?,?,?,?,?,0,?,?)
        """,(digest,tenant,user,purpose,identity,issued,expires))

    def test_ddl_and_marker(self):
        tables=self.db.execute("SELECT name,type FROM sqlite_master WHERE name LIKE 'auth_mfa_challenges%' ORDER BY name").fetchall()
        self.assertEqual(set(tables),{
            ('auth_mfa_challenges','table'),
            ('auth_mfa_challenges_active_idx','index'),
            ('auth_mfa_challenges_immutable_update','trigger'),
            ('auth_mfa_challenges_immutable_delete','trigger')})
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM migration_history').fetchone(),(5,))
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM auth_mfa_challenges').fetchone(),(0,))

    def test_one_time_consume_and_history_cannot_be_changed(self):
        self.issue()
        self.db.execute("UPDATE auth_mfa_challenges SET consumed_at=150 WHERE challenge_hash=?",('a'*64,))
        with self.assertRaisesRegex(sqlite3.IntegrityError,'MFA_CHALLENGE_IMMUTABLE'):
            self.db.execute("UPDATE auth_mfa_challenges SET consumed_at=160")
        with self.assertRaisesRegex(sqlite3.IntegrityError,'MFA_CHALLENGE_IMMUTABLE'):
            self.db.execute("DELETE FROM auth_mfa_challenges")
        with self.assertRaisesRegex(sqlite3.IntegrityError,'MFA_CHALLENGE_IMMUTABLE'):
            self.db.execute("UPDATE auth_mfa_challenges SET identity_hash=?",('c'*64,))

    def test_invalid_lifetime_and_negative_state_fail(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.issue(expires=401)
        with self.assertRaises(sqlite3.IntegrityError):
            self.issue(expires=100)
        self.issue()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE auth_mfa_challenges SET consumed_at=450")

    def test_cross_tenant_fk_and_purpose_constraints(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.issue(tenant='t2',user='u1')
        with self.assertRaises(sqlite3.IntegrityError):
            self.issue(purpose='superadmin_bypass')
        with self.assertRaises(sqlite3.IntegrityError):
            self.issue(digest='short')
        self.issue()
        with self.assertRaises(sqlite3.IntegrityError):
            self.issue()
        self.assertEqual(self.db.execute('PRAGMA foreign_key_check').fetchall(),[])
        self.assertEqual(self.db.execute('PRAGMA integrity_check').fetchone(),('ok',))

if __name__=='__main__':
    unittest.main()
