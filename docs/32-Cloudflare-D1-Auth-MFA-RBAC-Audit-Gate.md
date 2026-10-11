# ICOP Phase 6 → Cloudflare D1: Authentication, MFA, Session, RBAC & Audit Gate

Scope: isolated Cloudflare staging `icop-staging-api` and D1 `icop-staging-db`. This is **not** Fastify/PostgreSQL production parity. `main`, Hostinger VPS and public frontend `icop` must remain unchanged.

## Source-derived acceptance contract

The supplied `19-UAT-Pack.md` requires U01: role accounts, first-login password change, TOTP enrollment/verification, next TOTP accepted and repeated code rejected, ten independent one-time recovery codes displayed only once; U02: authorized **other-user** MFA reset with mandatory reason, session revocation and reenrollment; U24: immutable audit with actor/time/IP attribution. Source Phase 6 `apps/api/src/modules/auth/routes.ts` requires lockout after five failed passwords for 15 minutes, explicit tenant membership, MFA for privileged roles, token_version revocation and role-based segregation of duties. The current Cloudflare D1 code is a **separate implementation**, not automatic PostgreSQL compatibility.

## Implemented in feature branch (not yet enabled)

| Control | Code | Test gate |
|---|---|---|
| Secret encryption | AES-256-GCM, unique IV and subject-associated data (tenant+user) | Cross-tenant swap / invalid key fails |
| D1-only password KDF | New identities: per-user salted PBKDF2-SHA256 600,000 iterations, min 12 complex chars | Strong/wrong/weak password, salt variance |
| TOTP | RFC6238 SHA1, 30 seconds, anti-replay uniqueness | Code-step replay and invalid state denied |
| Session | CSPRNG 256-bit bearer, keyed HMAC in D1, 8h expiry, active user + token_version + tenant + RBAC | No raw bearer in D1; expired/revoked blocked |
| MFA recovery | 10 128-bit codes, keyed digests, generation & revocation, one-time consumption | Wrong/reused code cannot return session |
| Administrative reset | SoD against self-reset, tenant scoped, reason 10–500 chars; D1 session/recovery revocation and audited version increment | Self/cross-tenant/insufficient role denied |
| Audit | Append-only D1 `audit_events`, actor+action+UTC time, keyed-hash IP | No plaintext IP or MFA secret in database payload |
| Authenticated read route | `GET /api/v1/auth/me` requires both Cloudflare Access and valid D1 session; current Access email must match D1 session user; tenant & permission checked | Absent Access, cross-tenant, invalid MFA/session and forged headers denied |

## Release blockers and no-activation policy

1. **D1 migration 0004 is NOT applied remotely.** Prior HTTP multi-statement trigger attempt returned SQLite `incomplete input`; the original artifact directs operator to `infra/cloudflare/free-staging/MFA_RECOVERY_MIGRATION_GATE.md` and the Wrangler remote **SQL-file** migration route. Validate triggers and no data loss; do not mark a failed SQL script applied.
2. The deployed staging database only has schema migrations 0001–0003, no authorized user/tenant accounts. No Superadmin or seed account should be created without explicit approved administrator identity and enrollment.
3. The Cloudflare Access app has independent MFA configuration, but **actual authorized MFA challenge/UAT is not verified**. `ACCESS_IDENTITY_ENABLED=false` and `ACCESS_MFA_CONFIRMED=false` remain intentional.
4. `AUTH_V2_ENABLED` must remain **absent/false**. The original `POST /api/v1/auth/login` returns `503 STAGING_AUTH_NOT_READY`. The feature branch has not completed live password login, MFA enrollment/confirm HTTP routes, password change, a D1 onboarding workflow or end-to-end request-to-session integration; the new server-only primitives must not be exposed to a client-provided principal.
5. Provision dedicated secret values with appropriate rotations/permissions: `SESSION_HMAC_KEY`, `MFA_ENCRYPTION_KEY`, `MFA_RECOVERY_KEY`, `ACCESS_AUDIT_HMAC_KEY`; never copy `SEED_PASSWORD` from frontend, print keys, log plaintext IPs or expose the D1 database directly to browsers.
6. **Performance/cost**: PBKDF2 600,000 iterations and SQL batch workloads must be benchmarked against Workers Free CPU/D1 quotas on a protected test tenancy. bcrypt records from Fastify are not compatible with the new PBKDF2 format without a reviewed reset/migration.
7. U01/U02/U24 require real authorized test identities and an authenticated browser rehearsal proving password change, login, TOTP enrollment, repeated-code denial, ten recovery codes displayed once, revoke-all, SoD, cross-tenant denial and immutable audit. Tests with mocked D1 do not count as live UAT.
8. Security sign-off: no critical/high findings, audit/backup/rollback plan, signed authorization by appropriate ICOP owners. Do **not** merge these changes to production/operational frontend or enable any auth until all gates are evidenced.

## Test & rollout

- Unit/security tests: `node --test infra/cloudflare/free-staging/tests/*.test.mjs`.
- In-memory D1 schema tests: `python3 -m unittest discover -s infra/cloudflare/free-staging/tests -p 'test_*.py' -v`.
- Cloudflare staging CI must be green at the **same commit SHA**, and an Access-negative perimeter test must reject all anonymous requests.
- After explicit security owner approval: migrate 0004 via Wrangler remote SQL-file command from the migration guide; verify keys and protected Access with live MFA; enroll approved nonproduction identities; exercise full UAT; only then consider enabling `AUTH_V2_ENABLED` and connecting the frontend BFF.

**Current status: PARTIALLY IMPLEMENTED IN SOURCE — LIVE AUTHENTICATION BLOCKED.** Do not label "completed" or "production ready" until the above gates pass.
