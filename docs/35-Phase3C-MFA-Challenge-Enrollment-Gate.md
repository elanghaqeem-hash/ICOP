# ICOP Phase 3C — MFA Challenge + TOTP Enrollment Gate

Status: **SOURCE / CI ONLY — no live D1 schema 0005, no HTTP MFA endpoint,
no accounts provisioned, no live login or production deployment**.

## Verified scope

On staging D1 `icop-staging-db` (ID
`8a454b5e-597a-49fd-a51e-1730786de740`), the operator previously
applied `0004_cf_free_mfa_recovery_codes`; both independent D1 read-back
and the operator's remote Wrangler `PRAGMA foreign_key_check` (no rows)
and `PRAGMA quick_check` (`ok`) passed. All four recovery ledger
objects exist. No tenants/users/sessions/recovery rows were present.
Earlier SQL backup was tested via SQLite memory restore.

This branch introduces **draft `0005_mfa_challenge_state.sql`**, which is
**not yet deployed** to staging D1. Every new MFA function is source-only
and will be tested without authenticating any real user.

## Defense-in-depth contract

1. A password-verified first-factor event is required on the current
   Cloudflare Access `ctx.access` principal. The browser cannot select
   a trusted email, role, or internal user ID.
2. Issue random 256-bit `m1_...` challenge handles; persist only HMAC-SHA256
   digests scoped by tenant/user/purpose and keyed identity digests, never
   raw challenge/email. TTL is at most 300 seconds. No app session is issued.
3. `0005` constrains the challenge to a composite tenant/user foreign key,
   immutable digest, purpose, identity hash, token version, 5-minute expiry,
   one-way consumed transition, and append-only history triggers.
4. TOTP enrollment starts only after a valid unconsumed enrollment challenge.
   A WebCrypto AES-256-GCM ciphertext is stored in `mfa_pending_secret_enc`
   with matching expiry. The provisioning URI is returned once, never logged.
   Enrollment retry does not silently rotate the pending secret.
5. TOTP confirmation validates code against the encrypted pending secret,
   consumes the challenge, records the used TOTP step, enables MFA,
   advances `token_version`, inserts ten HMAC-scoped recovery digests,
   and appends pseudonymous audit in D1 batch. Only after all expected D1
   changes does the trusted handler return ten plaintext recovery codes
   **once**. No bearer/JWT/cookie is issued.
6. Wrong TOTP attempts are user-scoped, pseudonymously audited and counted.
   Five wrong attempts trigger a 15-minute MFA lockout; new challenges do
   not reset it.
7. Every path is fail-closed unless independently verified release flags
   `AUTH_V2_ENABLED`, `ACCESS_IDENTITY_ENABLED`,
   `ACCESS_MFA_CONFIRMED`, `PASSWORD_FIRST_FACTOR_ENABLED`,
   `MFA_CHALLENGE_ENABLED`, `MFA_ENROLLMENT_ENABLED`, and, for final
   confirmation, `MFA_CONFIRM_ENABLED` are all `true`.
   Real staging presently keeps the first two Access flags `false`
   and does **not** set the new flags.

## Code and tests

- `src/security/mfa-challenge.mjs`
- `src/security/mfa-enrollment.mjs`
- `migrations/0005_mfa_challenge_state.sql`
- `tests/mfa-challenge.test.mjs`
- `tests/mfa-enrollment.test.mjs`
- `tests/test_mfa_challenge_schema.py`

CI must prove default-disabled behavior, password+Access identity binding,
HMAC isolation, expiry, immutable history, FK denial, pending AES-GCM secret,
valid/invalid TOTP behavior, one-time recovery code creation, 5-attempt MFA
lockout, replay refusal, SQL bind parity, and no session issuance.

**Do not mistake mocked D1 `batch()` unit tests for atomicity proof on
real D1.** Release requires a separate on-database transaction failure and
concurrency test against an **isolated disposable D1 database** with
synthetic accounts before production-like staging UAT.

## D1 migration 0005 (separate controlled operation, pending)

Before an operator applies 0005:

1. Review and approve the exact PR commit/source and `0005` DDL.
2. Take a **new post-0004 SQL export** of `icop-staging-db`, store
   protected outside GitHub and test SQLite restore/integrity on that backup.
   The pre-0004 backup does not represent current schema.
3. Confirm D1 migrations exactly 0001–0004, zero users/tenants/sessions,
   and no partial `auth_mfa_challenges%` SQLite objects.
4. Execute the **whole** SQL file via Wrangler `d1 execute --remote --file`;
   never split `CREATE TRIGGER` statements through the D1 query API.
5. Read back migration-history marker, table, index, both triggers,
   composite foreign key, zero challenge rows, `PRAGMA foreign_key_check`
   (zero violations), and `PRAGMA quick_check` (`ok`).
6. Stop on an error; do not retry blindly, delete objects, toggle auth
   flags, add Superadmin, merge PR or touch production.

## Blocking security reviews (NOT YET PASSED)

- Validate real Cloudflare Access MFA user experience with a documented
  challenge and permitted identity. Configured authenticators are not
  equivalent to UAT evidence.
- Verify real D1 `batch()` rollback on **zero affected rows**, SQL exceptions,
  uniqueness races, and pending-enrollment recovery; no code should be
  shown unless the entire enrollment, recovery, audit and one-time challenge
  consumption commit atomically.
- Review all HTTP CSRF protections, rate limiting and DoS boundaries before
  adding MFA routes. Current MFA primitives are **not** attached to
  `src/worker.mjs` public routing.
- Implement login-TOTP challenge consumption atomically with session issue,
  strict `HttpOnly; Secure; SameSite` session cookie handling and logout.
- Approve official DEIT users/roles, secure secrets and provisioning before
  even attempting U01/U02/U24 application UAT.
- Perform recovery, password reset, browser/cross-device challenge replay,
  cross-tenant RBAC, actor audit, expiry and revocation UAT with zero
  critical/high open findings.
- Maintain draft PR and preserve production Worker `icop` untouched until
  change approval and rollback rehearsal.
