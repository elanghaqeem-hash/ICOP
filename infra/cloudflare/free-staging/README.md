# ICOP Cloudflare Free-only staging: backend bootstrap

**Not the full Fastify API.** This is an intentionally limited, isolated
staging Worker `icop-staging-api`, backed by the dedicated D1 database
`icop-staging-db`. It must not be merged/deployed as an operational replacement
for the ICOP Node/Fastify/PostgreSQL production application.

## Verified Cloudflare setup (11 October 2026)

- D1 `icop-staging-db` created separately from TotalARC's D1 database.
- Applied the initial migration `0001_cf_free_staging_bootstrap`.
- No real customer, tenant, administrator, or test-user records imported.
- `/health` tests that the D1 schema is present.
- `/api/v1/system/readiness` lists unavailable modules explicitly.
- Login deliberately returns `503 STAGING_AUTH_NOT_READY`, NOT a fake account.

## Deployment

The source of truth is `src/worker.mjs`. The Worker name is
`icop-staging-api` (NOT `icop`), with a D1 binding named `DB`.

```sh
cd infra/cloudflare/free-staging
npm install
npm test
npx wrangler deploy --config wrangler.jsonc
```

A Worker-to-Worker service binding from a separate `icop-staging` frontend
can use `ICOP_API`; do not bind the production `icop` frontend prematurely.

## Next milestones (not implemented)

1. Decide how to preserve security parity: tenant-scoped user authentication,
   password hashing, rate-limiting, MFA, session invalidation, RBAC and logs.
   Provisioning `SEED_PASSWORD` in frontend is neither sufficient nor safe.
2. Port PostgreSQL schema and business queries **explicitly** to SQLite/D1,
   including all PostgreSQL-only statements; no automatic compatibility claim.
3. Verify Workers Free CPU, memory and D1 row read/write quotas on realistic load.
4. Document OCR/PDF native binaries (Tesseract/Ghostscript/qpdf) and cron/background
   job processing cannot be taken over unchanged by normal Workers Free.
   Use supported external APIs or client-side paths only after security review.
5. Complete security, negative tenant isolation, UAT, monitored rollback and
   cost/data-residency review before any production release.

Cloudflare D1 free quotas are daily and can block queries after exhaustion:
https://developers.cloudflare.com/d1/platform/pricing/

## Phase 2: identity and audit database schema (staging only)

The new `migrations/0002_identity_audit.sql` preserves the structural requirements
from the uploaded Phase 6 source `apps/api/migrations/001_core.sql` and
`010_phase5_security.sql`. It follows UAT Pack **U01**, **U02**, and **U24**.

| Source requirement | Cloudflare D1 staging implementation | Gate |
|---|---|---|
| Tenant company identifiers | Empty `tenants` table with unique code | Schema only |
| Role-controlled user accounts | Empty `users` table, 20 allowed roles, unique tenant+normalized email | No authentication |
| First-login password change | `force_password_change=1` by default | No password endpoints |
| MFA enrollment/recovery | Disabled MFA flag, encrypted-key storage columns, recovery hashes as serialized JSON | Not functioning |
| Revoke existing JWT | `token_version` nonnegative integer default 0 | No JWT generation |
| Audit trail U24 | Empty `audit_events` with tenant/actor foreign keys and SQLite UPDATE/DELETE abort triggers | Schema integrity only |

Differences from PostgreSQL are explicit: UUIDs use TEXT (future validated UUIDs),
timestamptz uses UTC time strings, JSONB uses serialized TEXT, arrays use TEXT JSON,
and PostgreSQL procedure/trigger syntax becomes SQLite trigger syntax. **No claim
of SQL/ORM interoperability or native bcrypt hash runtime compatibility is made.**

CI executes `python3 -m unittest discover -s infra/cloudflare/free-staging/tests -p 'test_*.py' -v`.
This uses an **in-memory database and synthetic test identities only**. Real
Cloudflare D1 migration and smoke tests are separate gates. The public
`/api/v1/system/readiness` reports `schema.identity_audit_prepared` once
migration 0002 is recorded; every authentication/business capability remains
`false`. No users, demo tenants, passwords or customer data are inserted.

Release prerequisites before implementing login: adequate password KDF under
Workers Free CPU limits, MFA secret protection and rotation, lockout and
revocation, RBAC/SoD, server-side session/token protection, append-only
auditing of all auth events, tenant isolation tests, abuse throttling, and
approval of secure provisioning (never a hardcoded shared seed password).

## Verified incremental release — 11 October 2026 (staging only)

The isolated Cloudflare D1 database `icop-staging-db` has now successfully
applied migration `0002_cf_free_identity_audit_schema` via the Cloudflare
D1 API. Read-only verification confirmed:

- Both `0001` and `0002` migrations are recorded.
- Empty tables `tenants`, `users`, and `audit_events` exist.
- SQLite triggers `audit_events_immutable_update` and
  `audit_events_immutable_delete` exist.
- Database row counts for tenants/users/audit events: **0 / 0 / 0**.
- Worker `icop-staging-api` was updated with a new schema readiness signal.
- Cloudflare staging Worker is distinct from production Worker `icop`.
- No real login, access-policy bypass, or production release is enabled.

The repository identity-schema regression tests cover role enum rejection,
tenant-scoped email uniqueness, cross-tenant actor FK rejection, MFA/password
change defaults and audit UPDATE/DELETE denial. These are **schema-level**
tests, not a replacement for application-level tenant filtering or full UAT.
Final release gates still require real authentication/MFA, secret handling,
abuse prevention, tenant data-access negative tests, restore rehearsal and
module-by-module PostgreSQL -> D1 migration.

## Phase 3A: Cloudflare Access identity gate (October 2026)

This code is a **read-only identity onboarding check**, NOT a replacement for
the original Fastify JWT/password/TOTP auth in `apps/api/src/modules/auth`.

- New path: `GET /api/v1/auth/access-me`.
- **Feature is disabled by default**; absent `ACCESS_IDENTITY_ENABLED=true`
  AND exact `ACCESS_AUD` yields 503.
- A protected Worker supplies signed-in identity through trusted
  `ctx.access.getIdentity()`, NEVER a browser-controlled email/role/JWT header.
- For any enabled request, `ctx.access.aud` must match `ACCESS_AUD`.
- Client must specify an explicit valid `X-ICOP-Tenant` (e.g. `DEIT`).
  D1 resolves the user's normalized verified email *within* that tenant;
  unknown, inactive, cross-tenant or invalid-role accounts fail with 403.
- Successful identity lookup must append `auth.access_identity_checked`
  to immutable tenant-scoped audit history. DB/audit error fails closed.
- Even success returns **202** with `applicationAuthenticated=false`,
  `mfaVerified=false` and `permissions=[]`; never issues a bearer token.
- The original `POST /api/v1/auth/login` remains 503 and all business
  endpoints remain disabled. Empty real D1 users table means no one is provisioned.

### Before enabling in Cloudflare (NOT DONE)

1. Create an Access application protecting `icop-staging-api` (or dedicated
   staging origin) **before** setting feature flags. Restrict eligible users
   by explicitly approved email(s) and enforce MFA at your identity provider.
   Verify both policy application and that `ctx.access` is available.
2. Set `ACCESS_AUD` to the exact Access application audience and
   `ACCESS_IDENTITY_ENABLED=true` in the **staging API Worker only**.
   Do not use dummy shared accounts or production `SEED_PASSWORD`.
3. Provision separately approved staging-only tenant memberships with securely
   derived passwords if/when full app-password authentication is implemented.
4. Execute UAT U01 (password-change/MFA), U02 (MFA reset/revocation), and U24
   (audit including IP). **None of these UATs is marked complete by this gate.**
5. If enabling Access on the `workers.dev` hostname, CI health tests that
   run without identity must be redesigned to use private authenticated
   health tests, or move health to a separate safe monitoring boundary.

Policy source: `apps/api/src/lib/rbac.ts`,
`apps/api/src/modules/auth/policy.ts`, uploaded `19-UAT-Pack.md`.
Cloudflare native identity reference:
https://developers.cloudflare.com/workers/configuration/cloudflare-access/

## Phase 3A — auth security schema (staging only)

- Live isolated D1 `icop-staging-db` migration `0003_cf_free_auth_security_foundation` applied successfully. Three migration versions are present.
- Added `auth_attempt_buckets`, `auth_sessions`, `mfa_used_steps` and MFA lockout/expiry columns to `users`.
- Verified all new tables exist with **zero** tenant, user, session, MFA replay or audit records; no dummy accounts or credentials are provisioned.
- A fail-closed, source-derived restricted RBAC/MFA policy and synthetic security tests cover cross-tenant denial, forced password change, privileged MFA, per-tenant actor FK, session expiry, TOTP replay and approval SoD.
- The staging Worker `/api/v1/system/readiness` now reports `schema.auth_security_prepared`. Authentication and MFA capabilities remain `false` and `POST /api/v1/auth/login` remains 503.
- Worker deployment requires a **multi-module upload** including `worker.mjs` and `access-identity.mjs` or standard Wrangler deploy; uploading the main module alone fails because it imports the Access module.
- This is a **database/policy/test milestone only**. It does not establish secure runtime password hashing, real auth session issue/revocation, MFA enrollment/verification, or end-to-end login/UAT readiness. Never promote to `icop` production at this stage.


## Phase 3B — Workers WebCrypto prerequisites (11 October 2026)

The Phase 3B code adds **isolated cryptographic primitives, not public
authentication endpoints**:

- `src/security/totp.mjs`: RFC 4226/6238 TOTP SHA-1, 6 digits, 30-second
  step with ±1-step tolerance, last-used-step guard, plus D1 primary-key
  replay reservation that returns denial when a duplicate/DB error occurs.
  Independent RFC vectors and negative/replay tests are in `tests/totp.test.mjs`.
- `src/security/session.mjs`: CSPRNG session token helper, HMAC-SHA256 keyed
  session digest, and deny-by-default D1 session validation for tenant, user
  active flag, token version, expiration, revocation, MFA and SoD permissions.
  Regression tests include expired/revoked sessions, cross-tenant access,
  password-change and MFA enforcement. The raw token is never intended to be
  stored in D1, and HMAC key material must come from a secret store.
- **No code in the running Worker creates a new session, verifies an app
  password, changes a password or enrolls MFA.** Worker `/api/v1/auth/login`
  continues to respond 503. These utilities are dormant until approved
  authentication, enrolment and Cloudflare Access gate integration exists.

**Newly verified external blocker:** The Cloudflare Access applications API
returned `access.api.error.not_enabled` for the connected Cloudflare account
on 11 October 2026. Do not set `ACCESS_IDENTITY_ENABLED=true` before Access
has been configured with the correct audience, domain, deny-by-default policy
and identity MFA. Access does not replace application-level tenant mapping,
password-change policy or session renewal without an explicitly approved SSO
design. No production Worker secrets/configuration should be changed.

**Security review before activation:** Verify atomic transactions across
replay reservation and authentication audit/session updates, consistent UTC
clock sources, idempotent lockouts, rate limiting on both IP and identity,
recovery code generation/storage/revocation, concurrent device/session
policies, password change flows, encrypted at-rest TOTP secret handling,
tenant-specific RBAC and data residency; run negative and real browser UAT.


## Phase 3B security remediation — audit privacy and Access gating

- Cloudflare API reports `access.api.error.not_enabled` for this account.
  **Do not** set `ACCESS_IDENTITY_ENABLED=true` or provision user mappings
  until the owner enables Cloudflare Access and restricts the application
  with an explicit verified access policy and MFA requirements.
- `GET /api/v1/auth/access-me` remains **disabled by default** and
  `POST /api/v1/auth/login` remains 503; neither is usable for ICOP login.
- Prior to creating any ICOP session, a verified Access identity may only
  receive a 202 onboarding-pending response with **no** role, user ID,
  full name, or password-change flag disclosed.
- If this feature is ever enabled, the Worker additionally requires a
  **staging-only `ACCESS_AUDIT_HMAC_KEY`** (64 hexadecimal characters from a
  cryptographically secure generator). It uses HMAC-SHA256 to pseudonymize
  the Cloudflare-origin IP before writing tenant-scoped audit history.
  Missing key, missing/invalid trusted origin IP, D1 failure, or unsuccessful
  audit write all return a non-success response.
- Audit HMAC keys must be injected as Worker **secrets**, never committed to
  Git or exposed to browsers. Rotate with a documented retention policy.
  HMAC audit pseudonyms are not plaintext IP addresses; verify whether UAT
  U24/regulatory recordkeeping specifically requires retrievable source IP
  and define a separate audited approach if so.
- New negative tests cover missing audit secrets, missing IP, malformed D1
  writes, forged browser identity headers, inactive identities, and
  authorization-denied tenant mappings.
- These tests provide secure default behavior, **not** proof of operational
  Access, encrypted MFA secrets, password reset, or signed-in user sessions.

Reference: https://developers.cloudflare.com/workers/configuration/cloudflare-access/
