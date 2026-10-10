# ICOP Phase 6 — deployment repair and secure release gate

Updated: 10 October 2026

## Root cause (Cloudflare API verified)
Repeated failed Cloudflare build IDs used **retry** of the historical `main` source with root `/`, an empty build command and deploy command `npx wrangler deploy`. The source repo's `main` currently contains only README. Retry replays the old build metadata, not the edited current configuration.

A later manual build from `fix/cloudflare-phase6-monorepo-build` successfully built Next.js / OpenNext and uploaded its preview bundle (build `bd8d36ed-e77a-40b0-b2a3-867be4e2d3f6`). This verifies build / preview upload, **not** runtime behavior or production release.

## This branch
Derived from the current `feature/phase6-source-reconciliation` branch (not a stale feature snapshot); ports the existing tested OpenNext adapter and locked dependencies, then executes fresh CI for this code.

`apps/web` holds the Next.js 16 frontend and same-origin BFF API route handlers. `apps/api` is a separate Node.js Fastify and PostgreSQL deployment — the Worker does NOT automatically host it.

Run build from `apps/web`:

```sh
npm ci
npx opennextjs-cloudflare build
npx wrangler deploy --dry-run
```

Or from repo root, where `wrangler.jsonc` contains a custom build step:

```sh
npx wrangler deploy --dry-run
```

Cloudflare Builds preview settings already verified via API:

- Root: `apps/web`
- Build: `npm ci && npx opennextjs-cloudflare build`
- Preview deploy: `npx wrangler preview --name icop-phase6-preview`

## Release guardrails
- **Do not retry old builds:** manual Retry retains the historic `main` + `/` + empty build command.
- **Do not switch production branch** from `main` to this development branch without release-gate approval. PR #1, #5 and the Cloudflare adapter changes are not yet promoted into main.
- **Do not turn on public Preview URLs without access controls.** Cloudflare account-level Access is not enabled, and script `icop` currently has `workers.dev` and `previews_enabled` both false. Enable Cloudflare Access with a restrictive identity policy before opening Preview URLs.
- Before preview user acceptance, provision reachable secure Fastify backend; use `API_INTERNAL_URL` (not localhost or Docker service name) and set `APP_PUBLIC_ORIGIN` to the actual preview origin. Keep credentials in runtime secrets. Validate login, MFA, secure cookies, CSRF, customer isolation, uploads/downloads, licensing and API error paths.
- Run staging runtime tests, database migrations/backup restore, rollback, independent security checks and UAT; release gate stays **NOT PASS** until demonstrated.
- **This workflow has no real deployment step**, to avoid touching the current Worker production version.

## Relevant builds
- GitHub old fix CI: https://github.com/elanghaqeem-hash/ICOP/actions/runs/38045012220
- Cloudflare preview build: `bd8d36ed-e77a-40b0-b2a3-867be4e2d3f6`
- Cloudflare failing historical retry: `32bc148d-d98e-4f60-81ad-1f5c9ad0e61b`
