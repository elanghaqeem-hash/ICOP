# Cloudflare development gate — Login and backend readiness

Scope: ICOP `develop` branch only. Hostinger VPS and GitHub `main` remain unchanged.

## Source and acceptance scope
- Reuse current Cloudflare OpenNext frontend and `GET /api/system/status` readiness route.
- Owner-provided `19-UAT-Pack.md`: **U01** login/MFA, **U25** integration connection feedback, **U26** 390px mobile. This change addresses visibility and fail-closed behavior only, **not** full U01 authentication/MFA.
- No seeded accounts, dummy customers, or new privileged endpoint.

## Behavior
1. Client reads same-origin `/api/system/status` with `cache: no-store`; no secret/API hostname is displayed.
2. `backend: NOT_CONFIGURED`: show a clear Indonesian message; disable email, password and submit. Prevent real credential attempts while Fastify backend is absent.
3. `backend: CONFIGURED_UNVERIFIED`: allow trying login, explicitly warn that configuration does not establish UAT readiness. The existing BFF validates Origin/CSRF and performs actual authentication.
4. Request error/unexpected response: stop login and provide a retry control; never assume healthy.
5. On a `.workers.dev` hostname display the Development · Cloudflare indicator. Production Hostinger URLs do not get this indicator.
6. CSS keeps all controls readable on 390px and preserves existing MFA/routing/password policy.

## CI gate
`.github/workflows/cloudflare-develop-gate.yml` runs TypeScript, OpenNext build, Wrangler `--dry-run`, real local Worker HTTP `GET /login`, `GET /api/system/status` with `NOT_CONFIGURED` and `readyForBusiness:false`, and login `POST` returning 503 `API_NOT_CONFIGURED` without backend.

## Deployment and blockers
- Merge only into `develop` after CI success. Cloudflare Worker `icop` follows `develop` but automatic deployment remains `--dry-run`; a deliberate manual development deployment and direct URL verification are separate steps.
- Cloudflare Access is not enabled, therefore do not attach real tenant data or real login credentials to public development URLs.
- A Node Fastify + PostgreSQL 16 development backend remains **not provisioned**. Neither this PR nor a Cloudflare Worker build can make login, CRM data or MFA operational. A separate secured API/backend is necessary before full UAT.
- Hostinger production should be deployed only on an explicit later request.
