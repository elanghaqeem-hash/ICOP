# ICOP Cloudflare Development — safe staging backend connection

**Environment:** Cloudflare Development only. No Hostinger VPS activity. No production `main` promotion.

## Evidence
- Frontend Worker `icop` is deployed on `workers.dev`; GitHub deployment branch `develop` runs OpenNext.
- A separate, existing Worker `icop-staging-api` and isolated D1 `icop-staging-db` exist. This is a bootstrap API, not the Fastify/PostgreSQL business API.
- Backend Access app has MFA configuration, but `ACCESS_IDENTITY_ENABLED=false` and `ACCESS_MFA_CONFIRMED=false`. Real interactive MFA and ICOP session UAT have **not** been validated.
- Cloudflare staging API's `/api/v1/system/readiness` lists `authentication:false` and module capabilities false. `POST /api/v1/auth/login` returns 503 `STAGING_AUTH_NOT_READY` by design.
- No authorized tenant/user onboarding has been proven in the staging D1. Never invent an admin account, credentials or seeded customer data.

## Minimal integration implemented in this change
1. A separate `apps/web/wrangler.develop.jsonc` declares the private Worker Service Binding `ICOP_STAGING_STATUS -> icop-staging-api`. This file is for **manual Cloudflare development deployment only**. The default `wrangler.jsonc` remains unchanged for local smoke and other targets.
2. `GET /api/system/status` uses the service binding ONLY to call backend's read-only `GET /api/v1/system/readiness` with a bounded timeout. It maps the expected bootstrap response to `STAGING_CONNECTED_AUTH_DISABLED`; no hostname, tenant, Access JWT, backend response body, or DB details are returned publicly.
3. Absent service binding retains the prior `NOT_CONFIGURED` / `CONFIGURED_UNVERIFIED` signals for local non-Cloudflare runtimes; backend errors are sanitized as `STAGING_UNREACHABLE`.
4. Login screen distinguishes connected backend from application login readiness. **The login submit handler and BFF authentication flow are unchanged.** The button remains gated until a genuine application auth API, session cookies, MFA, tenant isolation and UAT have been approved.
5. Cloudflare Develop CI typechecks, builds OpenNext, validates both default and development Wrangler configurations using `--dry-run`, and smoke tests the no-backend route.

## Security boundary
Worker Service Bindings can bypass the external Cloudflare Access web perimeter. Therefore, the new binding must be used exclusively for the backend's sanitized read-only readiness endpoint. **Never add a general-purpose proxy to the staging API on this public frontend.** The existing API login route is not connected to this binding. No credential forwarding, token issuance, user registration, privileged D1 access or customer data is allowed by this phase.

## Operations and acceptance
- Deploy this branch only after Cloudflare Develop CI passes. For a controlled deploy, use the Wrangler development configuration (`npx wrangler deploy --config wrangler.develop.jsonc`) and restore the automatic Cloudflare Builds command to `--dry-run` immediately after triggering the build.
- Confirm the Worker settings include `ICOP_STAGING_STATUS` and that the public `/api/system/status` returns `backend:STAGING_CONNECTED_AUTH_DISABLED`, `readyForBusiness:false`.
- If runtime fetch fails, treat `STAGING_UNREACHABLE` as a failed connectivity check; do not enable login.
- Next secure milestone: approved identity onboarding, Access real-user MFA challenge, app-level authentication/session/recovery/audit, full tenant negative tests, and UAT U01/U02/U24/U26. A D1 table by itself cannot replace these controls.
- This phase is **CONNECTIVITY ONLY**, not acceptance of operational login.
