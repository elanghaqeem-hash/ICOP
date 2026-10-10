# Phase 6B2 — Staging DB Readiness & Runtime Deployment Gate

**Scope:** Phase 6B2 source is already merged to `main` at `8242eb347544b64cbc0a643112393673e36b002a`. GitHub Actions [38057641333](https://github.com/elanghaqeem-hash/ICOP/actions/runs/38057641333) passed 164/164 regressions, Web build/BFF smoke and package audits (4/4). Passing source CI is *not* production deployment acceptance.

## Verified hosting evidence as of 10 October 2026

- Connected Cloudflare account has a Worker named `icop`. Its `last_deployed_from` is `dash_template`, `has_assets=false`, and the connected Worker Builds listing returned no builds. It has **not been verified** as an ICOP Next.js frontend deployment from the merged GitHub source.
- Connected Vercel account search for project `icop` returned **zero matching projects**. This does not prove ICOP does not exist in another user/team/account.
- No verified live `DATABASE_URL`, managed PostgreSQL staging endpoint, admin MFA credentials, HTTPS API endpoint, or proven backup location was supplied to this integration. **Do not run migration 013 against any live database without operator confirmation and a tested restore path.**
- GitHub repository currently public, and `main` is not protected according to GitHub branch metadata. Enforce review, restricted write rights, security checks and code/IP privacy before customer launch.

## This incremental source gate

The new `apps/api/src/migration-preflight.ts` performs **only SELECTs in a PostgreSQL READ ONLY transaction**. It is intentionally separate from `npm run migrate`.

`--target=pre` checks that migrations `001–012` are in `schema_migrations`, migration 013 is pending and the suggestion table does not already exist.

`--target=post` checks migrations `001–013`, suggestion table/required columns and the unique partial index enforcing one PENDING suggestion per requirement. It fails closed if the schema or migration ledger is inconsistent, and it never attempts automatic repairs.

Run from `apps/api`, with explicit `DATABASE_URL` from a secure staging secrets store:

```bash
npm ci
# READ ONLY; do this after a verified snapshot of the staging database.
npm run migration:preflight -- --target=pre

# ONLY WITH STAGING OWNER APPROVAL, TESTED BACKUP/RESTORE AND MAINTENANCE WINDOW:
npm run migrate

# READ ONLY:
npm run migration:preflight -- --target=post
```

If preflight finds that 013 has already been applied, inspect with `--target=post` instead of force-reapplying it. Never print `DATABASE_URL`, JWT_SECRET, `SECRETS_MASTER_KEY` or AI provider credentials in logs.

## Non-production regression

`apps/api/tests/e2e.phase6.staging-migration.test.ts` is confined to the explicit CI `TEST_DATABASE_URL`, requires `icop_test` in the database target, creates a populated 012 schema, verifies read-only preflight, runs the existing versioned migrator to 013, checks legacy tenant/tender/requirement survival and migration idempotency, then removes a test-only index to confirm preflight fails without attempting repair.

The integration CI with PostgreSQL 16, BFF smoke and production dependency audit must pass on the new PR. These tests **do not simulate a real production backup, real customer data, live provider privacy or full infrastructure**.

## Staging and operational acceptance — not yet performed

1. Choose a **separate staging database**, not production or developer/test data. Keep API private; HTTPS ingress to frontend, allowlisted backend and proxy configuration; MFA enforced for privileged roles.
2. Create encrypted backup with timestamp/checksum and *test restore to an isolated database*. Assign named release owner, approver and rollback authority.
3. Run preflight and verify source schema matches staging state; any drift stops the release. Apply migration 013 with approved secrets and operator supervision; verify postflight and startup `/health` response through private ingress.
4. Exercise RBAC/MFA, BFF cookie and CSRF defenses, two distinct makers/checkers, cross-tenant 403/404 negative cases, and authentication/session revocation after MFA recovery.
5. Use redacted client-authorized RKS/contract documents and a real approved AI provider under assessed privacy/data retention terms. Confirm hallucinated quotes downgrade to CLARIFY, COMPLY acceptance rechecks VERIFIED facts at submission date, and commercial pricing is never sent to providers.
6. Confirm tenant feature `tender_compliance` is **OFF by default**. Enable it only for an explicitly approved pilot tenant; monitor `ai_calls`, errors, cost controls and audit trails. Disable immediately via admin feature switch if risk appears.
7. Run security/pentest, vulnerability remediation, mobile UAT and Finance/Legal/Tender owner acceptance; separately approve customer production activation and hosting deployment.

**Rollback:** disable feature, revert application to prior verified deploy if necessary; do not blindly reverse destructive database migrations. A schema rollback needs DBA/owner signoff and verified recovery of dependent data.

**Result:** This PR provides a *testable staging readiness tool and version-upgrade regression*, **not evidence of actual staging or production deployment**.

## Phase 6B2 staging runtime rehearsal (10 Oct 2026 increment)

**Important change in the API container:** `apps/api/Dockerfile` no longer automatically calls the migrator or seed on startup. The production API checks migration 013 metadata in a **read-only gate before opening its listen socket** and refuses to start if the schema is incomplete. Treat database upgrades as explicit release events; previously automatic boot-time migrations were unsafe for controlled customer deployment.

**Standalone Compose:** `docker-compose.staging.yml` is an isolated/local staging rehearsal, NOT a shared HTTPS deployment. It exposes only Next.js on `127.0.0.1:3000` (no host ports for PostgreSQL or Fastify API). A trusted HTTPS reverse proxy and approved separate staging PostgreSQL must be provisioned for actual multi-user UAT. `SCHEDULER_ENABLED=false` and `JOB_WORKER_ENABLED=false` avoid duplicated production jobs in rehearsal.

**Required operator order on an approved isolated staging host:**

```bash
# Place production-strength staging-only DB_PASSWORD, DATABASE_URL, JWT_SECRET,
# SECRETS_MASTER_KEY, ALLOWED_ORIGINS, APP_PUBLIC_ORIGIN in a protected .env file.
# Never use .env.example's weak placeholders or real production database credentials.
docker compose -f docker-compose.staging.yml build api web
docker compose -f docker-compose.staging.yml up -d --wait postgres

# Check restore capability and take a recoverable backup BEFORE migration.
# The migration service is excluded from ordinary 'up'.
docker compose -f docker-compose.staging.yml --profile migration run --rm migrate
docker compose -f docker-compose.staging.yml run --rm api \
  node dist/migration-preflight.js --target=post
docker compose -f docker-compose.staging.yml up -d --wait api web

# Visit http://127.0.0.1:3000/login only on an isolated test host.
# Shared/customer environments REQUIRE HTTPS before any authenticated session.
```

**Automated non-production rehearsal:** `.github/workflows/staging-container-rehearsal.yml` builds both containers, creates random throwaway CI credentials and a clean PostgreSQL 16 volume, verifies that API startup without migrations is blocked, manually runs migrations, performs read-only postflight, dumps and restores to a distinct DB, then checks /login HTTP 200, anonymous BFF HTTP 401, malicious Origin POST HTTP 403, and no API/Postgres published host ports. CI teardown deletes volumes and ephemeral secrets. This DOES NOT access or prove safety of real staging or production backups.

**Deployment and operational gates are still BLOCKED:** real DNS/TLS, secret distribution, database backups/restore, identity/MFA UAT, privacy/provider contractual approvals, mobile user acceptance and pen-test results remain unavailable. Do not enable `tender_compliance` on any customer tenant automatically.
