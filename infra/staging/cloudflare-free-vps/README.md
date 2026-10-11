# ICOP staging — Cloudflare Free frontend + VPS Fastify/PostgreSQL

**Status: preparation only.** This is not a deployed service. Do not merge PR #20
or change the `icop` production Worker before the staging gates below are green.

## Architecture

```text
User -> Cloudflare Free Worker (Next.js frontend + BFF, same-origin cookie)
     -> HTTPS staging-api.example.com (Cloudflare Access Service Auth)
     -> Cloudflare Tunnel (outbound-only connector on VPS)
     -> Fastify API :3001 (Docker network; not host-published)
     -> PostgreSQL 16 (Docker volume; not host-published)
```

- Reuse existing Fastify business API, PostgreSQL migrations, RBAC, MFA, OCR/PDF binaries.
- The VPS must have Docker Engine + Compose v2, reliable persistent volume,
  TLS outbound egress, backups, monitoring and an accessible SSH admin account.
- All passwords/tokens are stored outside Git. Do not use production user data
  in staging unless independently authorized and redacted.
- Background workers and in-process scheduler remain **disabled** for initial
  staging; delivery/OCR job processing is therefore not complete. Volume-based
  document storage is temporary for staging. R2 migration remains a production gate.

## 1. Cloudflare dashboard (separate staging resources)

1. Create a *staging frontend Worker* or separate staging route/domain. Do not
   overwrite or attach secrets to the existing production `icop` Worker.
2. Create a remotely managed Cloudflare Tunnel under Networking -> Tunnels,
   named `icop-staging-api`. Copy its token privately.
3. Configure a published application route using your **real** staging API hostname,
   pointing to **`http://api:3001`** (Docker service DNS from cloudflared).
4. Under Zero Trust -> Access -> Applications, protect that hostname with an
   Access policy whose only allowed ingress is **Service Auth** with the
   dedicated `icop-staging-bff` service token. No bypass policy or anonymous
   access. Test a request without service token is rejected by Access.
5. On the staging frontend Worker, store:
   - `API_INTERNAL_URL=https://<your-staging-api-host>`
   - `APP_PUBLIC_ORIGIN=https://<your-staging-frontend-host>`
   - `API_ACCESS_REQUIRED=true`
   - `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` **as Worker secrets**.
   Do not put `SEED_PASSWORD`, `DATABASE_URL`, `JWT_SECRET`, or tunnel tokens
   in the frontend.
6. Ensure the correct OpenNext build config is used and that deploy targets the
   **staging Worker name**, not `icop`. Neither `apps/web/wrangler.jsonc` nor
   root `wrangler.jsonc` has been pointed at staging yet. This is a release gate.

## 2. Prepare VPS

```sh
git clone https://github.com/elanghaqeem-hash/ICOP.git
cd ICOP
git checkout feature/cloudflare-api-container-foundation
cp infra/staging/.env.api.example infra/staging/.env.api
cp infra/staging/.env.tunnel.example infra/staging/.env.tunnel
chmod 600 infra/staging/.env.api infra/staging/.env.tunnel
```

Fill in **real staging-only secrets** in both files, without sending them via chat:
- `DB_PASSWORD`: `openssl rand -hex 32`
- `JWT_SECRET`: `openssl rand -hex 48`
- `SECRETS_MASTER_KEY`: `openssl rand -hex 32`
- `DATABASE_URL` matching PostgreSQL values
- `ALLOWED_ORIGINS` matching staging frontend HTTPS origin
- `TUNNEL_TOKEN`: from Cloudflare dashboard (never commit)
- Configure DNS/Access before allowing staging API traffic.

```sh
bash infra/staging/cloudflare-free-vps/preflight.sh
docker compose --env-file infra/staging/.env.api -f docker-compose.cloudflare-free-staging.yml build api migrate
docker compose --env-file infra/staging/.env.api -f docker-compose.cloudflare-free-staging.yml up -d --wait postgres
# Approved one-shot schema migration; ONLY for empty staging or after a DB backup.
docker compose --env-file infra/staging/.env.api -f docker-compose.cloudflare-free-staging.yml --profile migration run --rm migrate
docker compose --env-file infra/staging/.env.api -f docker-compose.cloudflare-free-staging.yml run --rm api node dist/migration-preflight.js --target=post
docker compose --env-file infra/staging/.env.api -f docker-compose.cloudflare-free-staging.yml up -d --wait api tunnel
```

**Do not auto-seed.** If a fresh **synthetic** admin is required in staging,
request provisioning approval, then set a strong one-time `SEED_PASSWORD`
in the operator shell and run `docker compose ... --profile migration run
--rm -e SEED_PASSWORD migrate node dist/migrate.js --seed`; rotate the
password at first login, enforce MFA, and clear the shell variable. Never use
the seed routine as a production password reset.

## 3. Staging release gates

- Verify `docker compose ps`: Postgres/API healthy, tunnel connected;
  `docker port` returns no host-published port for DB/API.
- `/health` returns database healthy **only through the protected path**;
  unauthenticated external requests are rejected by Access.
- Verify BFF login, password change, MFA, tenant RBAC, logout/revocation;
  service-token headers must never reach browser responses or logs.
- Validate backup/restore to an isolated DB, error handling, rate limiting,
  upload behavior, document persistence, and recovery after container restart.
- Cloudflare Workers Free has request/CPU limits; stress-test Next.js BFF
  within your plan limits before a production cutover.
- Confirm staging domain, monitoring, on-call operator and rollback strategy.
- Keep production domain and Worker **untouched** until release review.

Cloudflare docs:
- https://developers.cloudflare.com/tunnel/get-started/
- https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/
- https://developers.cloudflare.com/workers/platform/limits/
