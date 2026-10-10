# ICOP — Cloudflare Workers Build Repair (2026-10-10)

## Diagnosis evidenced by the failed Cloudflare build

The build initialized and cloned a Git repository, then executed `npx wrangler deploy` without producing build assets. Wrangler reported:

```text
Could not detect a directory containing static files (e.g. html, css and js) for the project
```

This proves the deploy command could not find a valid Worker entrypoint or static output; it **does not** prove which repository/branch Cloudflare cloned. Verify that in Cloudflare > icop > Settings > Builds.

As checked on 2026-10-10, `main` contained only a README. Application sources are on `feature/phase5-source-integration`, including `apps/web` (Next.js 16) and `apps/api` (Fastify and PostgreSQL).

## Scope of this proposal

Adds `apps/web/wrangler.jsonc` as **preliminary** OpenNext Worker configuration. It targets the existing Worker name `icop`, avoids editing production resources, and does not install dependencies or trigger a deployment.

**This is not a completed or tested deployment.** Cloudflare recommends vinext for new/compatible Next.js applications; ICOP's existing Next.js BFF route handlers and cookie/CSRF behavior must be regression-tested before replacing the runtime. OpenNext is a candidate that preserves Next.js build semantics but is also unverified against this application in Workers.

## Required before any preview build

1. Review and approve PR #1 plus its CI, security and UAT gates; keep `main` as the production branch. Do **not** switch the existing production Worker to `feature/phase5-source-integration` just to obtain source code.
2. In a **separate tested change**, at `apps/web`, install and lock compatible versions:

   ```sh
   cd apps/web
   npm install @opennextjs/cloudflare
   npm install --save-dev wrangler
   ```

   Commit **both** `package.json` and `package-lock.json`. Do not install unpinned tooling on each CI run as a permanent workaround.
3. Create `apps/web/open-next.config.ts` with:

   ```ts
   import { defineCloudflareConfig } from "@opennextjs/cloudflare";
   export default defineCloudflareConfig();
   ```

   This file is **intentionally absent from this configuration-only PR**, to avoid breaking the existing `tsc --noEmit` until the adapter dependency is installed.
4. Test `npm ci`, `npm run typecheck`, `npm run build`, and `npx opennextjs-cloudflare build` inside `apps/web`. Run `npx opennextjs-cloudflare preview` and the BFF auth/CSRF regression suite against the Workers runtime.
5. Only after these checks, use the following **target** Cloudflare Builds configuration for a preview/staging deployment:

   | Setting | Value |
   | --- | --- |
   | Repository | `elanghaqeem-hash/ICOP` |
   | Root directory | `apps/web` |
   | Production branch | `main` (only when ready) |
   | Build command | `npm ci && npx opennextjs-cloudflare build` |
   | Non-production upload | `npx opennextjs-cloudflare upload` (validate preview handling in this Cloudflare account) |
   | Production deploy | `npx opennextjs-cloudflare deploy` (ONLY after release gate PASS) |

   Do not leave `npx wrangler deploy` as the only deploy step for an unbuilt Next.js application. Ensure the Worker name matches `icop`.

## Critical runtime boundary: web != API

- `apps/web/src/app/api/v1/[...path]/route.ts` runs **server-side**. It uses `node:crypto`, Secure HttpOnly session cookies, CSRF validation, `APP_PUBLIC_ORIGIN` and `API_INTERNAL_URL`.
- Its default upstream `http://localhost:3001` and Docker name `http://api:3001` **will not be the ICOP Fastify API** inside a Cloudflare Worker. You must plan a reachable, secured upstream API via an approved private/public ingress architecture, with the exact origin configured as a Cloudflare runtime secret/variable.
- The backend depends on Node.js, PostgreSQL and OCR/PDF/service tools. Do not assume this Fastify container is deployed by the frontend Worker. Provision and validate backend, database, object storage, authentication and networking separately.
- `APP_PUBLIC_ORIGIN` must match the real HTTPS web origin to prevent `ORIGIN_MISMATCH`. Keep secrets out of GitHub and build logs. Verify cookies, login, MFA, CSRF, uploads and downloads end-to-end.
- Verify Worker size, CPU/resource limits, Node.js compatibility, logs, rollback and monitoring. Keep the Phase 5 release gate status **NOT PASS** until evidenced.

## Rollout safety

Do not repoint public traffic or change the current Worker `icop` production deployment during this provisional step. Configure a separate staging Worker or a non-production preview, verify functionality and backend reachability, then approve a controlled release. Cloudflare login/session remains a separate authenticated action; GitHub repository access does not grant Cloudflare dashboard/API permissions.

## References

- Cloudflare Workers Builds: https://developers.cloudflare.com/workers/ci-cd/builds/
- Next.js on Workers: https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/
- OpenNext existing application setup: https://opennext.js.org/cloudflare/get-started
- Repo gate notes: `docs/18-Phase5-Security-and-Release-Checklist.md`
