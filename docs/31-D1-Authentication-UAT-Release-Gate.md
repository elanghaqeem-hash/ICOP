# ICOP — D1 staging authentication release gate (12 Oct 2026)

Status: **CODE IN DRAFT / NO OPERATIONAL LOGIN / NO PRODUCTION APPROVAL**.

## Source fidelity
Use the uploaded Phase 6 Fastify `apps/api/src/modules/auth/routes.ts` and owner `19-UAT-Pack.md` as the authoritative acceptance baseline, in particular U01 (first-login change, TOTP/replay, 10 one-time recovery codes), U02 (separate admin MFA reset plus session invalidation), U24 (actor/time/IP audit), U26 (mobile). Do not silently replace those requirements with Cloudflare Access login or a sample account.

## Current Cloudflare read-only evidence
- Existing D1 `icop-staging-db`: migration_history 0001, 0002, 0003; **0004 not applied**. Tables `mfa_recovery_*` absent.
- D1 rows counted: **0 tenants, 0 users, 0 auth_sessions, 0 audit_events**.
- `icop-staging-api` has D1 binding, and Cloudflare Access app-scoped MFA configured (TOTP/biometrics/security key). Interactive challenge has **not been signed off**.
- Worker flags `ACCESS_IDENTITY_ENABLED=false`, `ACCESS_MFA_CONFIRMED=false`; `AUTH_V2_ENABLED` and `PASSWORD_FIRST_FACTOR_ENABLED` not enabled. No staging authentication secrets have been supplied.
- Public Cloudflare frontend `icop` may report its internal bootstrap service binding as `CONNECTED_BOOTSTRAP_ONLY`. This is NOT a working auth provider. The frontend's actual password login remains disabled.
- GitHub `main` and Hostinger VPS are unchanged by this PR.

## Implemented, but not activated
| Feature | Source / check | Gate |
|---|---|---|
| Trusted first-factor password verification | `src/security/first-factor.mjs`: Cloudflare Access verified identity, tenant-scoped D1, PBKDF2 validation | Behind FOUR explicit flags and audit secret; no session issued |
| Lockout and audit | Atomic D1 update and immutable audit, HMAC-pseudonymized network information | Negative tests, no real identities |
| MFA enrollment/replay | PR #26 TOTP AES-GCM, replay guard and keyed recovery hash | No HTTP enrollment or verified interactive UAT |
| Session management | PR #26 D1 hashed 8-hour sessions/revoke all | No real session issuance route |
| RBAC and tenant isolation | PR #26 `session.mjs` permission map and `auth-me.mjs` Access identity match | Actual authenticated cross-tenant negative UAT pending |
| Audit U24 | Immutable SQLite audit triggers and PR #26 protected write helpers | Audit retention/privacy and server-side secret provisioning pending |

## Required remaining implementation and owner gates
1. **Migration 0004**: migrate using remote Wrangler SQL-file flow, verify triggers, migration history and rollback evidence. D1 HTTP JSON query interface previously failed trigger parse with `SQLITE_ERROR: incomplete input`; never mark 0004 complete from a partially created table.
2. **Provision secrets only through secure Cloudflare Worker secret APIs**, after owner approves audit pseudonym retention: independent session HMAC, MFA AES-GCM, recovery HMAC and audit HMAC secrets with rotation/backup policy. No key/password in source, PR, build logs, or frontend `SEED_PASSWORD`.
3. **Approved staged identity provisioning**: owner-approved email, least-privilege role and tenant; require first-login password change. No invented Superadmin, dummy customer or shared password in live D1.
4. **Complete server HTTP auth state machine** with a trusted, short-lived first-factor transaction proof, password change, TOTP enrollment and replay protection, 10 recovery codes shown once, MFA verify and secure HttpOnly+Secure+SameSite session cookies, CSRF/Origin protection, logout/logout-all and independent admin-reset workflow. A password-only response must never be an authenticated ICOP session.
5. **Real UAT by authorized users**: verify Cloudflare Access interactive MFA, U01/U02 replay, 15-minute lockout, U24 actor/time/IP pseudonym audit, CSRF, cross-tenant and forged-header denial, session revocation, credential reset/rollback, mobile 390px. Do not infer from test fixtures.
6. **Performance and cost**: benchmark PBKDF2 600k and D1 query/write quotas under Workers Free limits; change design rather than reduce KDF strength without review.
7. **Release**: eliminate critical/high findings; obtain Director, VP Cybersecurity Strategic, Finance and Legal UAT sign-offs from the owner pack. Never merge this dependent draft branch directly into `main` ahead of PR #20/#26.

Only after these proofs may an authorized operator review enabling `ACCESS_IDENTITY_ENABLED`, `ACCESS_MFA_CONFIRMED`, `AUTH_V2_ENABLED` and `PASSWORD_FIRST_FACTOR_ENABLED`. No flag is to be enabled by code-only CI.
