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
