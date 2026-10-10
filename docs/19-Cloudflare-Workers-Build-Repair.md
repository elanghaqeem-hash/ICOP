# ICOP Cloudflare Workers — build repair and release control (2026-10-10)

## Evidence: original Cloudflare failure

Cloudflare clones a repository but runs `npx wrangler deploy` immediately; the build contains no `apps/web` output or Worker entrypoint, yielding:

```text
Could not detect a directory containing static files (e.g. html, css and js) for the project
```

Those logs do **not** include the name or branch of the repository cloned. Verify the actual source in the Cloudflare dashboard, under Worker **icop** > Settings > Builds.

The GitHub `main` branch currently holds README only. Full ICOP source exists on `feature/phase5-source-integration` (PR #1, draft) and its Cloudflare fix branch `fix/cloudflare-workers-build-20261010` (PR #4, draft).

## Verified repair in GitHub (NOT a Cloudflare production deploy)

PR #4 introduces:

- `apps/web/wrangler.jsonc`: targets existing Worker name `icop`, `.open-next/worker.js` and `.open-next/assets`.
- `apps/web/open-next.config.ts`: required by `@opennextjs/cloudflare@1.20.9`.
- `apps/web/package.json` and `apps/web/package-lock.json`: lock tested OpenNext and Wrangler `4.149.0` versions.
- `.github/workflows/cloudflare-preview-validation.yml`: tests Next.js typecheck, OpenNext bundle, Wrangler `--dry-run`, dependency audit; does not deploy.
- This document.

GitHub Actions run [38043577242](https://github.com/elanghaqeem-hash/ICOP/actions/runs/38043577242) **PASS** for adapter build, Wrangler dry-run, typecheck and production dependency audit. That is **not** proof that a Cloudflare-hosted runtime, backend, login or production gate passes. Do not describe it as a deployed application.

## Cloudflare dashboard settings — preview test, not production switch

1. Open the **existing** Worker `icop` in account `208155f241d4da84e1a6a9b44b7a8d28`. Go to **Settings > Builds**.
2. Confirm connected source is `elanghaqeem-hash/ICOP`. Keep **production branch `main`**, not a feature branch.
3. Set **root directory** to `apps/web` (important: monorepo).
4. Set **Build command** to `npm ci && npx opennextjs-cloudflare build`.
5. Set **production deploy command** to `npx wrangler deploy` — valid **only after** the build produces `.open-next/worker.js`. Keep production blocked until release gate PASS. Re-running production build now against README-only `main` still fails.
6. Enable **Preview Builds** for non-production branches; use the current Worker Previews command `npx wrangler preview` for preview, subject to Cloudflare account configuration. Make the build of `fix/cloudflare-workers-build-20261010` a **preview**, not a production deploy.
7. Inspect preview logs and version URL; verify route handlers, static assets, login, MFA, CSRF, proxy, authorization, uploads and downloads, and worker size/resources, before considering merge.

**Never switch the production branch to the fix branch solely to bypass a missing source tree.** Review PR #4 into the feature branch and PR #1 into `main` only when security, data, application UAT and release criteria are met.

## Important runtime distinction

- `apps/web`: Next.js 16.4.0, with server-side BFF `/api/v1/[...path]`, secure httpOnly session cookies, and anti-CSRF checks. Static export is NOT equivalent and is not a safe shortcut.
- `apps/api`: Fastify + Node.js + PostgreSQL, plus OCR/PDF and object-storage integrations. It is **not** deployed automatically by a frontend Workers build.
- `API_INTERNAL_URL=http://localhost:3001` and Docker hostname `http://api:3001` will NOT resolve to Fastify when Next.js runs on a Cloudflare Worker. Implement and validate appropriate secure API ingress separately.
- `APP_PUBLIC_ORIGIN` must equal the deployed HTTPS origin, including for preview tests; mismatches result in 403 `ORIGIN_MISMATCH`.
- Protect passwords and keys with Cloudflare runtime secrets; Workers Build variables are build-time only, not runtime secrets. Never commit credentials.

## Current release status

- **GitHub adapter build validation: PASS** (see run above).
- **GitHub PR #1 and #4: draft/unmerged.**
- **Cloudflare Worker preview/prod deployment: NOT VERIFIED.**
- **Backend, identity, database, staging UAT, penetration testing, monitoring and rollback: NOT VERIFIED.**
- **Production gate: NOT PASS.** See `docs/18-Phase5-Security-and-Release-Checklist.md`.

## Vendor documentation

- https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/
- https://opennext.js.org/cloudflare/get-started
