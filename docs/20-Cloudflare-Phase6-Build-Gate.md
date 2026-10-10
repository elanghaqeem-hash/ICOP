# Cloudflare Worker icop — build fail remediation (Phase 6)

Status as of 10 October 2026: **GitHub Actions dry-run PASS, Cloudflare production NOT VERIFIED**.

## Evidence and root cause

Cloudflare logs at 10:20–10:21 UTC show: clone repository, no build/dependency cache, then execute `npx wrangler deploy` directly; Wrangler could not find assets/entrypoint. The log does not say which source branch was cloned.

At time of investigation, GitHub `main` only contains README. The active code lives in `feature/phase6-source-reconciliation`, not main.

## Fix included in PR #6

- Port Next.js 16.4.0-compatible tested `@opennextjs/cloudflare@1.20.9` and `wrangler@4.149.0`, including lockfile.
- Add `apps/web/open-next.config.ts` and `apps/web/wrangler.jsonc`.
- Add root `wrangler.jsonc` with custom `build.command` to build and bundle `apps/web` when **plain `npx wrangler deploy` is invoked from repository root**.
- Add no-deploy GitHub Actions validation workflow.

Validated on GitHub Actions run https://github.com/elanghaqeem-hash/ICOP/actions/runs/38044837954 : typecheck, OpenNext build, app-root Wrangler dry-run, **root-level deploy-only Wrangler dry-run**, production dependency audit all PASS.

Root dry-run log specifically shows `[custom build] Running: npm ci --prefix apps/web && cd apps/web && npx opennextjs-cloudflare build` and completes bundling. This does NOT prove Cloudflare production success.

## How to check safely in Cloudflare

1. Open existing Worker `icop` on account `208155f241d4da84e1a6a9b44b7a8d28` and inspect **Settings > Builds**, including repository, production branch, root directory, commands and Preview Builds.
2. Confirm connected GitHub repository `elanghaqeem-hash/ICOP`. Leave production on `main` until ready; it does **not** yet contain the application, so rerunning its production deployment will repeat the same error.
3. Enable preview builds for `fix/cloudflare-phase6-monorepo-build`. For this branch:
   - If **Root directory** is repository root `.` (or blank), the root `wrangler.jsonc` can build the frontend itself before `npx wrangler deploy`. The exact path passed `--dry-run` in CI.
   - If Root directory is `apps/web`, use Build command `npm ci && npx opennextjs-cloudflare build` and Preview command `npx wrangler preview` (or the preview command supported by this Worker).
   - Production Deploy command stays `npx wrangler deploy` only once production sources and release gate are approved.
4. Verify preview URL and that Next.js UI and BFF work, not just compilation. Test HTTP UI, cookie-auth, MFA, CSRF, file uploads, PDFs, service binding, Worker limits and data network.
5. Do not deploy to production until the backend can be reached securely (Worker cannot use Docker URL `http://api:3001`), PostgreSQL is provisioned, secrets and `APP_PUBLIC_ORIGIN` are configured, and UAT and production gates are signed off.

**Safety:** This PR is draft, does not merge to main or publish Cloudflare. GitHub CI passing does not mean production is connected or healthy.

See Cloudflare documentation:
- https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/
- https://developers.cloudflare.com/workers/wrangler/custom-builds/
