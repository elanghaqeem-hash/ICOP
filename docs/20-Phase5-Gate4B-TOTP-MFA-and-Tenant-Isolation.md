# Phase 5 Gate 4B — Privileged TOTP MFA and Tenant Isolation
**Source of truth:** branch `feature/phase5-source-integration` (PR #1). This describes code changes, NOT a production approval.

## Functional scope implemented
- PostgreSQL migration `010_phase5_mfa.sql` introduces per-user MFA enabled state, AES-256-GCM encrypted secret, ten-minute pending setup, 30-second last accepted TOTP timestep, bad-code counter and fifteen-minute lockout.
- `auth/mfa/setup` generates a one-time onboarding secret and an `otpauth://` provisioning URI. Secret is returned only during setup; persisted database value is encrypted with `SECRETS_MASTER_KEY`.
- `auth/mfa/enable` accepts a valid TOTP and rotates `token_version`, invalidating the temporary login token.
- `auth/mfa/verify` verifies a current authenticator code with ±30-second drift, using a `SELECT FOR UPDATE` row lock and monotonic counter to reject replay/concurrent reuse.
- Password-only logins for required roles receive restricted JWTs, with a **5-minute challenge lifetime**, not access tokens for commercial endpoints. Users must change initial passwords before MFA setup.
- Auth middleware checks current user role/tenant/enrollment plus JWT MFA claim for *every business API request*; an old password-only bearer token cannot bypass MFA.
- BFF uses `httpOnly; Secure; SameSite=Lax` cookies and double-submit CSRF protection, hiding challenge and verified JWTs from browser JavaScript.
- UI `/mfa` has enrollment and 6-digit challenge, usable on phones. The secret is intended to be copied manually into Google/Microsoft Authenticator or a compatible TOTP app; QR generation is **not included**.

## Production role policy

`MFA_POLICY=privileged` is the effective production default for:
`super_admin`, `company_admin`, `director`, `vp_head`, `sales_manager`, `pricing_finance`, `legal`, `tender_officer`.
`MFA_POLICY=all` requires MFA for every user, including customers. Development and test default `off` so old fixtures remain backwards-compatible; `MFA_POLICY=privileged` can be set in CI for security test suites. Setting `MFA_POLICY=off` **cannot disable** the privileged policy in production.

Once an account has enrolled, MFA remains required even if it no longer has a privileged role. The role is retrieved from the database on each request, not trusted from a stale JWT role claim.

## Tests and acceptance

- Existing Phase 1–4 suites continue to run in GitHub Actions.
- `e2e.phase5.mfa.test.ts`: RFC6238 reference vector; first-password change; inability to access customer API before MFA; encrypted secret and enrollment; challenge and replay resistance; negative tenant/customer lookup; global logout; repeated-invalid-code lockout.
- `apps/web/tests/auth-bff-smoke.mjs`: real Next production HTTP BFF, including a restricted login challenge, masked browser responses, CSRF validation, session rotation and webhook forwarding.
- `npm audit --omit=dev --audit-level=high`, typechecks and production builds are mandatory checks.

## Staging rollout sequence
1. Confirm repository is private or all proprietary pricing/policies are approved for exposure.
2. Back up DB before applying migration 010, run migration, keep the encryption master key securely in Secret Manager, and verify DB access by tenancy.
3. Provision HTTPS for frontend and set `APP_PUBLIC_ORIGIN` to exact public origin. Keep `API_INTERNAL_URL` server-only and ensure API cannot be accessed directly by browsers.
4. Create an authentic privileged test account (no committed passwords), login, rotate password and enroll MFA using a real authenticator app on both desktop and mobile.
5. Verify expired challenge, replay, 5 bad codes/15-minute lock, race/concurrent OTP use, role changes, logout-all invalidation, CSRF failure and tenant isolation in live staging.
6. Restore database snapshot on isolated non-production infrastructure, validate actual rollback, document owner UAT and approval.

## Open production blockers
- MFA recovery and backup codes need a carefully controlled, audited **two-person admin recovery process**; there is intentionally no weak email-only reset.
- Full RBAC/tenant cross-module negative tests (pricing, tenders, billing, approval, FlexGuard), proof of distinct tenant fixture isolation and object storage boundaries.
- Independent pentest, DAST/SAST/secret scanning, device session inventory/refresh/revocation, rate limiting across replicas, Key Management Service key rotation.
- Real HTTPS/mobile staging, live third-party providers, backup/restore drill, runbook and formally accepted business/legal UAT.

**Decision:** Gate 4B code CI does not equal production go-live approval. Maintain PR as Draft until above blockers are resolved.
