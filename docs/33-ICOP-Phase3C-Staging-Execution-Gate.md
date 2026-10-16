# ICOP Phase 3C — Staging execution / authentication security gate

**Environment:** `icop-staging-api`, Cloudflare Workers Free, isolated D1 `icop-staging-db`  
**Change scope:** Staging only, no `main` merge, no production deployment, no account provisioning.  
**Status:** BOOTSTRAP_ONLY / APPLICATION AUTH DISABLED (not a Phase 3C production sign-off).

## 1. Verified progress — 14 October 2026

Evidence: exact on-worker multipart-module snapshot checked before upload, repository
source fingerprint checked after upload, then Cloudflare Workers settings/D1
read-back. PR #27 predeployment CI: five workflows PASS.

- Staging Worker upload succeeded and **all five deployed module bytes** matched
  the PR #27 source: `worker.mjs`, `access-identity.mjs`,
  `security/auth-me.mjs`, `security/session.mjs`, `security/policy.mjs`.
- `GET /api/v1/auth/me` is now compiled into staging, but is explicitly
  fail-closed: with absent `AUTH_V2_ENABLED` and both flags below equal to
  `false`, it must return `503 STAGING_AUTH_NOT_READY` after passing Access.
- **Cloudflare Worker bindings remain:** `DB` → staging D1, correct
  `ACCESS_AUD`, `ACCESS_IDENTITY_ENABLED=false`,
  `ACCESS_MFA_CONFIRMED=false`. No staging auth/session cookie issued.
- Live staging D1 contains migrations `0001`, `0002`, `0003` only;
  `0004_cf_free_mfa_recovery_codes` **NOT applied**.
- Live D1 counts verified: `tenants=0`, `users=0`, `auth_sessions=0`,
  `audit_events=0`.
- Cloudflare staging Access app independent MFA configuration enables TOTP,
  biometrics and security key, MFA session duration 6h. Config does **not**
  establish a verified user MFA prompt or app-level enrollment.
- Production `icop` Worker was not targeted. Existing GitHub PRs #20, #26,
  #27 remain Draft.

## 2. Source-defined acceptance basis

From `19-UAT-Pack.md`:

- **U01:** first login requires password change, MFA enrollment and logout /
  login; next TOTP valid, repeated TOTP rejected, ten recovery codes displayed once.
- **U02:** admin can reset user MFA only with reason; target sessions revoked
  and user forced to re-enroll.
- **U24:** audit trail must preserve actor, time and IP for security actions.
  ICOP staging currently pseudonymizes IP by keyed HMAC; reconcile this with
  exact audit reporting requirements before UAT sign-off.
- **UAT release:** no open critical/high defects including MFA bypass or
  cross-customer data exposure; sign-off by Director, VP, Finance and Legal.

## 3. Invariant gates — do not bypass

1. No production Worker `icop` updates or PR merge during Phase 3C staging.
2. No synthetic production-facing or real Superadmin account or user
   created before authorized tenant/role provisioning approval and verified MFA.
3. No flips of `ACCESS_IDENTITY_ENABLED`, `ACCESS_MFA_CONFIRMED`,
   `AUTH_V2_ENABLED`, or first-factor flags just to make readiness green.
4. No HTTP first-factor password entrypoint or bearer token release until
   verified challenge state, anti-replay, rate limiting, account lockout,
   password-reset/enrollment handlers and authenticated UAT are implemented.
5. PR #27 `first-factor.mjs` is **source/test only**, NOT included in the
   five-module staging Worker upload. `auth/login` remains 503.
6. `0004` requires a single reviewed remote SQL-file migration with trigger
   integrity, not partial HTTP statements; source:
   `infra/cloudflare/free-staging/MFA_RECOVERY_MIGRATION_GATE.md`.

## 4. Next work packages and evidence needed

| Gate | Action | Completion evidence | Current |
| --- | --- | --- | --- |
| C3-01 | Confirm interactive Access MFA on app (not Launcher alone) | Approved test identity, challenge, Access log, timestamp | Pending UAT |
| C3-02 | Migrate `0004` safely via remote SQL-file, verify trigger constraints | D1 schema/version/immutability PASS + rollback | Blocked |
| C3-03 | Authorize DEIT tenant + identity-to-role mapping | Signed approved identities/roles, no shared credentials | Not provisioned |
| C3-04 | Implement password first-factor + password change + MFA enrollment/verify | U01 negative, replay, lockout, recovery tests and audit | Partially source-only |
| C3-05 | Integrate session issue/verify/revoke and cross-tenant RBAC | U01/U02/U24 PASS on staging with authorized accounts | Pending |
| C3-06 | Security review & UAT sign-off | No critical/high findings, four role sign-offs | Not requested yet |

## 5. Rollback

If a staging upload fails verification, restore the **pre-upload source modules**
(`worker.mjs`, `access-identity.mjs`) with explicit original bindings and
recheck Access perimeter. Do NOT rollback by disabling Access or changing
production. Preserve verified `ACCESS_*_ENABLED=false` gates.
