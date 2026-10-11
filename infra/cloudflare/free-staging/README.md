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
