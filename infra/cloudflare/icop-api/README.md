# ICOP — Cloudflare backend foundation (NOT production ready)

This is an **unmerged, staging-first migration scaffold**, not a deployed backend.

## Architecture

- Existing `icop` Worker: OpenNext/Next.js frontend and httpOnly-cookie BFF.
- New private `icop-api` Worker: internal Service Binding target that forwards
  `/api/v1/*` and `/health` to a Cloudflare Container.
- Cloudflare Container: existing `apps/api/Dockerfile` with Fastify/Node 22,
  Tesseract, Ghostscript and qpdf.
- **External managed PostgreSQL 16**: required; current schema uses native
  PostgreSQL, triggers/JSONB and pgvector. Cloudflare D1 is NOT a drop-in.
- Cloudflare R2: required for durable files, and file write paths must be made
  fail-closed on replication failure before document uploads are enabled.

The Container's local disk is ephemeral. Do not use it as persistent storage.
This architecture requires **Cloudflare Workers Paid with Containers entitlement**.
Verify Cloudflare account eligibility and Docker-based build support before deploy.

## Prepare privately, in order

1. Provision managed PostgreSQL 16 with tested backups and TLS/private connectivity.
   Never use SQLite/D1 to run existing PostgreSQL migrations directly.
2. From `apps/api` run the approved migration preflight and one-shot migrations
   against a staging database. Do **not** seed/demo users or run migrations on
   production without owner approval and a backup.
3. In this directory run `npm install` (generate/commit package-lock.json before
   release), then use a Docker-capable CI runner to validate the image build.
4. Configure Worker secrets using Wrangler **in this directory**, not in the
   current public frontend Worker:

   ```sh
   npx wrangler secret put DATABASE_URL
   npx wrangler secret put JWT_SECRET
   npx wrangler secret put SECRETS_MASTER_KEY
   npx wrangler secret put ALLOWED_ORIGINS
   ```

   `DATABASE_URL` points to the managed PostgreSQL endpoint; `ALLOWED_ORIGINS`
   contains the precise HTTPS ICOP frontend origin. Secrets must never be committed.
5. Deploy `icop-api` using `npm run deploy` from this directory. Validate
   Container provisioning, migrations, health and auth via a private test Worker.
   The Worker is deliberately not published at workers.dev.
6. **Only after step 5**, add a second service binding to the existing
   `icop` frontend Worker config(s), keeping its self-reference binding:

   ```jsonc
   { "binding": "ICOP_API", "service": "icop-api" }
   ```

   The Next.js BFF can then access the binding instead of a public API URL.
   Set `APP_PUBLIC_ORIGIN` to the exact frontend HTTPS origin. Keep
   `API_INTERNAL_URL` only as an explicit fallback for non-Cloudflare hosting.
7. Confirm a pre-existing admin user (if any) before provisioning a new one.
   The current seed script intentionally does not reset existing users' passwords.
   Never put SEED_PASSWORD in the frontend Worker or Git.

## Release gates / known blockers

- **Container build**: Docker + Wrangler build from a monorepo nested
  Dockerfile must be verified. Adjust the Docker build context if needed.
- **PostgreSQL connectivity**: managed database not provisioned or tested.
- **Secrets and MFA**: not provisioned/tested. Superadmin login unavailable.
- **Persistent storage**: current storage service writes local first and silently
  logs failed S3 replication; must be changed to fail closed with R2.
- **Background work**: in-process scheduler and job poller explicitly disabled
  until Cloudflare Cron / Queues or a separate dedicated Container is tested.
- **Security**: rate limits, external integrations, audit logging, multi-tenant
  isolation, load, CI, recovery, penetration tests, and rollback need real tests.
- **Cold start**: Container boot latency needs measurements. No uptime claims.
- **Operational cost**: Containers are a paid offering; review usage and budget.

Do not merge or enable the `ICOP_API` frontend binding until the API Worker and
database have passed the staging gates above.

## Follow-up audit (11 Oct 2026)

- Updated Wrangler Container config with explicit `instance_type` and `exports` Durable Object storage declaration from current Cloudflare documentation.
- Removed module-global Worker-secret capture from the Container class. This is **not yet a functional backend**: the next commit must inject secrets using the documented `ctx.container.start({ env: ... })` lifecycle. Do not deploy the current scaffold until this is implemented and tested. Reference: https://developers.cloudflare.com/containers/examples/env-vars-and-secrets/
- Validate monorepo Docker build context and image path, particularly the existing API Dockerfile's relative `COPY package*.json` statements.
- Make document storage R2-first and fail-closed. Container local storage is ephemeral.
- No Production API URL exists yet; no secrets, DB migrations, login, or MFA are verified.
