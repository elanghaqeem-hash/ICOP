# ICOP Cloudflare Development — Restricted staging backend bridge

## Environment
- Frontend: Worker `icop`, built from **develop**. This is a development frontend, not an approved business production service.
- Backend: isolated Worker `icop-staging-api` (Cloudflare Workers Free) with D1 `icop-staging-db`, protected externally by Cloudflare Access.
- Hostinger VPS and GitHub `main` are **out of scope**; no deployment to them.

## Connected functionality
The frontend uses a **separate** internal Cloudflare Service Binding `ICOP_READINESS` only in `GET /api/system/status`, which fetches the staging API's **GET /api/v1/system/readiness**. It validates exactly the expected `bootstrap_only`, `staging`, `ready` tuple, never returns raw upstream data, worker address, identity, secrets or database contents.

`stagingConnection` values:
- `CONNECTED_BOOTSTRAP_ONLY`: D1 bootstrap route was reachable internally; **not full API readiness**.
- `UNAVAILABLE`: service binding exists but route failed or returned an unexpected response.
- `NOT_BOUND`: local Next.js or Worker service binding not available.

`backend` remains `NOT_CONFIGURED` until a *separate*, reachable and security-approved application API is provisioned. `readyForBusiness` always remains false in this phase. The login form continues to permit keyboard entry for UI testing, but the real submit path remains fail-closed with `503 API_NOT_CONFIGURED`.

## Security boundary
1. Never use `ICOP_READINESS` to forward credentials, cookies, bearer tokens, tenant selectors, roles or requests from the browser.
2. Do not wire the generic `/api/v1/*` BFF to this service binding: internal bindings can bypass an edge Access challenge, so the staging API requires **its own** application-level auth/RBAC/MFA. The current API returns `STAGING_AUTH_NOT_READY`.
3. Cloudflare Access remains enforced for direct external access to `icop-staging-api`; connecting to its health handler does **not** authorize users.
4. Preserve staging-only database, disallow customer data, production credentials, seed passwords and cross-tenant access.
5. Future login requires interactive MFA UAT, authorized tenant/account provisioning, atomic audit/session handling, negative isolation tests and security owner approval. Current PR #20 is Draft and must not be treated as a production Fastify/PostgreSQL replacement.

## Acceptance
- Cloudflare Develop CI: TypeScript, OpenNext bundle, Wrangler dry-run, local HTTP login, status with `NOT_CONFIGURED` and `readyForBusiness:false`, login POST 503.
- After controlled dev deployment: direct browser JSON at `/api/system/status` must return `stagingConnection: CONNECTED_BOOTSTRAP_ONLY`. If not, **do not claim backend connected**; debug service binding/Access with no bypass.
- Ensure `main` and Hostinger are unchanged and Cloudflare automatic deploy remains dry-run.
