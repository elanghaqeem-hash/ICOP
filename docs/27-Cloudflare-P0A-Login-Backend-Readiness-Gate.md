# ICOP — Gate P0-A: Cloudflare login/backend readiness

Date: 2026-10-11. Source: current GitHub `main`, user-provided `19-UAT-Pack.md`, and Cloudflare Worker `icop` account observations.

## Source-artifact traceability

- **U01**: login, force password change, MFA, logout; cannot be accepted until the backend and PostgreSQL are genuinely reachable.
- **U25**: administrator tests API integrations; a connected frontend alone must not be presented as an operational service.
- **U26**: mobile 390px still requires actual device acceptance; no new mobile claims in this gate.
- Phase 5 and Phase 6 gate reports describe historical tests/source snapshots. GitHub CI confirms code checks, not live UAT.

## Verified state before this fix

- Cloudflare Worker `icop` is deployed and `/login` HTML renders after Next 16.4 preview-props manifest patch (error 1101 repaired).
- Configured production Worker bindings: `ASSETS` and `WORKER_SELF_REFERENCE` only. No runtime `API_INTERNAL_URL` secret and no proven online Fastify/PostgreSQL.
- Current Cloudflare Builds production command is `npm ci && npm run build:cloudflare`; deployment command remains `npx wrangler deploy --dry-run` as safeguard.
- GitHub `main` CI green as of the pre-patch check. This fix does not claim live login works.

## Changes in this gate

1. Production Next BFF **does not** silently default to `http://localhost:3001` when `API_INTERNAL_URL` is missing; immediately returns HTTP 503 and code `API_NOT_CONFIGURED`. Non-production retains the development fallback.
2. Origin and CSRF validation remain ahead of the upstream connection. No bearer credentials are disclosed in the response.
3. UI errors for `API_NOT_CONFIGURED`, `API_UNAVAILABLE`, and `API_ORIGIN_INVALID` explain a backend outage in Indonesian, rather than implying the user entered a wrong password.
4. Repeatable HTTP smoke regression added to GitHub CI, separately checking malformed Origin and missing backend.
5. No credentials or dummy users introduced.

## Release gate

- [ ] CI frontend Next build, backend tests, audit, and new HTTP regression all PASS at exact head commit.
- [ ] Manual live browser check after deployment: frontend GET `/login` 200, POST auth login returns controlled 503 while backend absent (not 1101, 502 or password failure).
- [ ] Provision reachable private Fastify API/DB and secrets; deploy migrations using the verified migration order. Avoid importing historical conflicting Phase 6 `010/011` migrations over GitHub MFA migrations.
- [ ] HTTPS + APP_PUBLIC_ORIGIN configured, no API secret in Git; validate U01 MFA and U25 integrations with real authorized accounts.
- [ ] Backup/restore drill, security review/pentest, mobile U26, complete owner UAT sign-off.
- [ ] Only after these may the production operational gate be marked PASS.

> **Decision**: This patch improves failure behavior, not production service readiness. Do not present the login as operational until backend and live user checks pass.
