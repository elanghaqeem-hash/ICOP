# ICOP — Two deployment targets (Development Cloudflare / Production Hostinger VPS)

This is a deployment design and source-controlled release package, NOT proof that a Hostinger VPS or domain has been provisioned. Source of truth: GitHub `elanghaqeem-hash/ICOP` main branch and the existing 2026-10-11 readiness gate.

## Environments and isolation

| Control | Development (Cloudflare) | Production Live (Hostinger VPS) |
|---|---|---|
| Application origin | Existing development frontend: https://icop.elang-haqeem.workers.dev | A verified owner-controlled domain (ICOP_DOMAIN; not supplied yet) |
| Frontend | Existing Next.js 16.4/OpenNext 1.20.9 Cloudflare Worker `icop` | Same Next.js app, Docker Node 22, behind Caddy HTTPS |
| API | Current Worker reports NOT_CONFIGURED; add a **separate** reachable secured staging Fastify API before functional UAT | Private Docker Fastify Node 22; internal `http://api:3001`, not publicly exposed |
| Database | Isolated staging PostgreSQL 16 if a development API is deployed. Worker alone does **not** host Fastify/Postgres | Dedicated persistent Docker PostgreSQL 16 volume, NOT shared with staging |
| Documents | Development fixtures / sandbox storage isolated from customers | Dedicated `api_storage` volume, encrypted offsite backup recommended |
| SSL/domain | Cloudflare HTTPS URL; use Cloudflare Access or restrictive identity policy for realistic staging data | Caddy automatically obtains TLS after DNS points to VPS and ports 80/443 are reachable |
| Release trigger | Development branch / manual Cloudflare build after tests. Until branch migration, existing Worker build remains on `main` and `--dry-run` | Explicit operator-controlled Hostinger release; **no CI auto-deploy to VPS** |
| Acceptance | UAT Pack U01–U26 with isolated data | UAT sign-off, backup/restore, migrations, security checks, owner approval |

### Important boundaries

Cloudflare Workers can serve the current Next.js frontend. The existing Fastify/PostgreSQL API is a separate server application and cannot be assumed to execute inside the same Worker. Cloudflare Development therefore requires its own isolated backend if testing beyond the UI is requested.

The current public Cloudflare frontend has no `API_INTERNAL_URL`, and `/api/system/status` has reported `backend: NOT_CONFIGURED`. Do not test actual user credentials there until a secured staging API and Access restrictions are set up.

The GitHub `main` branch is the source-release baseline for Hostinger. The `develop` branch was created and Cloudflare Builds was switched to watch `develop` on 2026-10-11 (API verified). Promotion flow: feature PR -> develop (Cloudflare) -> reviewed release PR -> main -> approved VPS release. A successful build is not a UAT sign-off.

## Option 1: Development on Cloudflare

The existing development URL is:

`https://icop.elang-haqeem.workers.dev/login`

The actual Worker is named `icop`. Cloudflare Builds **now watches `develop`**, root `apps/web`, build command `npm ci && npm run build:cloudflare` (including the Next.js 16.4 `preview-props.json` manifest patch). Its auto-deploy remains `npx wrangler deploy --dry-run` and the last published Worker version has not been automatically replaced. Never click Retry on historic failed builds.

Follow-up operator actions:
1. Configure Cloudflare Access/restrict access before introducing real-looking staging identities or tenant data.
2. **Completed (2026-10-11):** Created `develop` from the approved `main` source and changed the Cloudflare Worker build branch and trigger to `develop` (both HTTP 200, verified). Keep Hostinger production on `main`; do not redirect production DNS to the development URL.
3. Provision a nonproduction API with separate PostgreSQL and distinct JWT, secrets master key, storage and SMTP sandbox. Use only a reachable private gateway or secured HTTPS `API_INTERNAL_URL`, not localhost. Verify BFF Origin/MFA/cookies.
4. Run local Wrangler runtime smoke and the existing staging container rehearsal, then manual dev deployment and UAT U01–U26.

## Option 2: Production on Hostinger VPS

Use Ubuntu LTS Hostinger VPS with Docker Engine / Compose v2, enough RAM/CPU/storage for PostgreSQL, Node, Tesseract OCR and PDF processing. Reserve only TCP 80/443 publicly, restrict SSH to operator IP, never expose 3000/3001/5432. Rootless/container hardening and OS patches should be reviewed before live traffic.

Files:
- `docker-compose.hostinger.yml`: Caddy edge, Next BFF, Fastify API, PostgreSQL 16, one-shot migration.
- `infra/hostinger/Caddyfile`: HTTP->HTTPS and same-origin routing; Caddy persists ACME certificates.
- `infra/hostinger/.env.production.example`: **template only**; copy locally to `.env.production`, replace all placeholders, generate unique credentials. It is git-ignored.
- `infra/hostinger/deploy.sh`: preflight, DB startup, backup, explicit migration, release, status.
- `.github/workflows/deployment-dual-target-validate.yml`: compile-free security/static validation with CI-only randomized values; no Hostinger access or deployment.

### Hostinger operator runbook (after VPS and domain are available)

Clone the reviewed source with an approved SSH key. Store secrets on the VPS only, not in GitHub issues/chat and never in the repository:

```sh
git clone https://github.com/elanghaqeem-hash/ICOP.git
cd ICOP
cp infra/hostinger/.env.production.example infra/hostinger/.env.production
chmod 600 infra/hostinger/.env.production
# Edit .env.production with real domain, email and unique DB/JWT/master secrets
# Example generation (copy values privately into env; don't paste into chat):
openssl rand -hex 32  # DB_PASSWORD and SECRETS_MASTER_KEY are distinct values
openssl rand -hex 48  # JWT_SECRET
bash infra/hostinger/deploy.sh preflight
bash infra/hostinger/deploy.sh db-up
```

**Mandatory production change approval + backup before migration** (read migration SQL diffs and approve separately):

```sh
ICOP_APPROVE_MIGRATION=YES bash infra/hostinger/deploy.sh migrate
# Afterwards, inspect gate output and complete owner approval before release.
bash infra/hostinger/deploy.sh release
bash infra/hostinger/deploy.sh status
```

The migration command creates a timestamped `pg_dump -Fc` under `/var/backups/icop` before running migrations. Keep an **encrypted offsite copy** and independently rehearse restore. The release command refuses a database that fails the read-only Phase6B2 postflight. `RUN_SEED=false` and e-sign sandbox are forced off. There is no default account created automatically.

Before executing `release`, set DNS `A` record for `ICOP_DOMAIN` to the actual Hostinger VPS public IPv4, confirm ports 80/443, and check any Cloudflare proxy rules if that DNS provider is used. Caddy obtains certificates at the specified hostname; do not claim live without a real HTTPS success check.

### Final business and security release gate

1. Verify `https://<ICOP_DOMAIN>/login` serves HTML and CSP/security headers, `/api/system/status` does not reveal hostnames or secrets, and protected API does not leak JWT.
2. Test genuine provisioned accounts, forced password change, MFA, role-based access and customer tenant segregation. **Do not seed real production users from development fixtures**.
3. Confirm persistent DB data, migration `013`, offsite backup + restore to another database, attachment storage, and domain/TLS renewal.
4. UAT Pack U01/U02/U24/U25/U26 as priority, followed by U03–U23. Obtain Director, VP, Finance and Legal sign-off and close all high/critical issues.
5. Validate SMTP, e-sign with real provider sandbox before production, storage and audit records. The attached UAT Pack expects recovery codes; current app uses two-admin recovery in Gate4C, so reconcile with business owner before sign-off.
6. Take a release tag and rollback plan. Rollbacks involving schema changes require separately tested restores; switching only the app image does not roll back data.

## Still needed from owner

- Hostinger VPS address/IP and Ubuntu version, plus access via secure SSH (never send private keys/passwords in chat).
- Real public domain/subdomain and DNS ownership.
- Approval for production cutover and UAT signatories.
- Decision on an independent staging API endpoint for Cloudflare Development (same production DB is prohibited).

The Hostinger live deployment remains **NOT PROVISIONED / NOT VERIFIED** until these prerequisites and actual login/health tests pass.
