# ICOP Cloudflare — Staged Backend Readiness and Live Gate (2026-10-11)

## Evidence source
- Current GitHub `main` is authoritative for code and migrations; the attached Phase 6 ZIP is a **historical snapshot** with different authentication and SQL migration numbering. Never overwrite the newer Gate4C two-person MFA recovery with ZIP code.
- Attached `19-UAT-Pack.md` is the acceptance specification, **not live test results**. Prioritize U01 (login/change-password/MFA), U02 (MFA recovery), U24 (audit), U25 (provider integrations), U26 (mobile) before approving operations. The attached UAT mentions 10 recovery codes, while the current GitHub MFA recovery is two independent administrators; reconcile the requirement explicitly with the owner.
- Earlier Phase 1–4 gate documents provide functional context, not proof of current live Cloudflare/PostgreSQL integration.

## P0: Backend config is not yet present on the Cloudflare Worker
- The live frontend is reachable at `https://icop.elang-haqeem.workers.dev/login`.
- Cloudflare Worker bindings: ASSETS and WORKER_SELF_REFERENCE. API_INTERNAL_URL is **not set**; no backend connection has been verified.
- Fastify `apps/api` is a separate Node 22 service requiring PostgreSQL 16 with correct migrations, JWT_SECRET, SECRETS_MASTER_KEY, tenant policy, storage/OCR, HTTPS ingress and operational monitoring. A Cloudflare frontend deploy does not provision it.
- Before this change the Next.js BFF silently fell back to `http://localhost:3001` even on production Workers. That is not a reachable backend and is now prohibited.
- This change returns 503 code `BACKEND_NOT_CONFIGURED` for authenticated API login attempts when no explicit API_INTERNAL_URL has been provisioned. No fabricated JWT/user/password is created.
- The public `GET /api/system/status` exposes only frontend UP and whether an API URL is configured, not hostnames, secrets, database connectivity or customer information; its `readyForBusiness` is intentionally false until true backend/runtime UAT exists.
- The login form uses the existing alert to provide an Indonesian administrator-facing explanation of this condition rather than generic API error text.

## Staged acceptance checklist

| Gate | Minimum proof | Status at authoring |
|---|---|---|
| 0 Frontend Worker runtime | GET /login HTTP 200; no Cloudflare 1101 | Verified before this patch |
| 1 Fail-closed missing backend | GET /api/system/status yields NOT_CONFIGURED; POST /api/v1/auth/login yields 503 BACKEND_NOT_CONFIGURED; no password transmitted to nonexistent backend | Await CI |
| 2 Real backend and DB | Operator-provisioned PostgreSQL 16 + Fastify; migrate after backup; read-only migration preflight; API /health | Not provided |
| 3 Private API ingress | Set API_INTERNAL_URL on Cloudflare securely; APP_PUBLIC_ORIGIN exactly the HTTPS website; authenticated and origin/CSRF testing | Not provided |
| 4 Real identity UAT | U01/U02 real users (not default passwords), MFA and tenant isolation; no session bearer leaked | Not done |
| 5 Operational UAT | U03–U26; Finance/Legal/owner signoff, backup/restore, upload/OCR, security assessment, mobile 390px | Not done |

## Reusing available artefacts
The owner-provided `icop-cyberbusiness360-phase6-src.zip`, incremental Git bundle, existing repository migration scripts and Docker Compose staging rehearsal avoid recreating business modules. The `docker-compose.staging.yml` and `.github/workflows/staging-container-rehearsal.yml` run disposable PostgreSQL and API with generated secrets, explicit migrations and restore tests. These rehearsals do **not** deploy a permanent backend or prove public login.

## Operational notes
- Keep production Cloudflare Builds on `npx wrangler deploy --dry-run` until an approved release. Merge of code must not silently deploy an app.
- Avoid localhost, Docker service names or insecure origins in API_INTERNAL_URL configured on Cloudflare; use a reachable private ingress or secured HTTPS API endpoint and verify.
- Do not publish database URI/JWT/secret key or new unauthenticated admin/backdoor test endpoint. Do not seed fake users.
- Complete backend deployment decisions and owner security signoff before enabling login or calling the system production-ready.
