#!/usr/bin/env bash
# Staging-only read-only checks. Never prints credentials or starts services.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
API="$ROOT/infra/staging/.env.api"
TUNNEL="$ROOT/infra/staging/.env.tunnel"
COMPOSE="$ROOT/docker-compose.cloudflare-free-staging.yml"
die() { echo "FAIL: $*" >&2; exit 1; }
command -v docker >/dev/null || die "Docker required"
docker compose version >/dev/null || die "Docker Compose V2 required"
for f in "$API" "$TUNNEL"; do
  [ -f "$f" ] || die "Missing $f — copy the .example file, then set real secrets"
  mode="$(stat -c '%a' "$f")"
  if (( (8#$mode & 0077) != 0 )); then die "chmod 600 $f"; fi
done
getv() { sed -n "s/^$1=//p" "$2" | tail -n 1; }
[ "$(getv NODE_ENV "$API")" = production ] || die "NODE_ENV must be production even on staging"
[ "$(getv DB_NAME "$API")" = icop_staging ] || die "DB_NAME must be icop_staging"
[ "$(getv RUN_SEED "$API")" = false ] || die "RUN_SEED must be false"
for v in API_DOCS_ENABLED ESIGN_SANDBOX_ENABLED TRUST_PROXY SCHEDULER_ENABLED JOB_WORKER_ENABLED; do
  [ "$(getv "$v" "$API")" = false ] || die "$v must be false for initial staging"
done
[ "$(getv MFA_POLICY "$API")" = privileged ] || die "MFA_POLICY must be privileged"
user="$(getv DB_USER "$API")"
pass="$(getv DB_PASSWORD "$API")"
jwt="$(getv JWT_SECRET "$API")"
master="$(getv SECRETS_MASTER_KEY "$API")"
url="$(getv DATABASE_URL "$API")"
[[ "$user" =~ ^[a-zA-Z0-9_]+$ ]] || die "DB_USER format invalid"
[[ "$pass" =~ ^[0-9a-fA-F]{48,}$ ]] || die "DB_PASSWORD must be random hex >=48 chars"
[[ "$jwt" =~ ^[0-9a-fA-F]{64,}$ ]] || die "JWT_SECRET must be random hex >=64 chars"
[[ "$master" =~ ^[0-9a-fA-F]{64}$ ]] || die "SECRETS_MASTER_KEY must be exactly 64 hex chars"
[ "$url" = "postgres://$user:$pass@postgres:5432/icop_staging" ] || die "DATABASE_URL must reference isolated staging PostgreSQL"
origin="$(getv ALLOWED_ORIGINS "$API")"
[[ "$origin" =~ ^https://[A-Za-z0-9.-]+$ ]] && [[ "$origin" != *REPLACE* ]] || die "real HTTPS staging origin required"
tok="$(getv TUNNEL_TOKEN "$TUNNEL")"
[ "${#tok}" -ge 60 ] && [[ "$tok" != *REPLACE* ]] || die "real remotely-managed Cloudflare Tunnel token required"
# Compose config emits interpolated secrets unless quiet mode is used.
docker compose --env-file "$API" -f "$COMPOSE" config --quiet
echo "PASS: Cloudflare Free + isolated VPS staging config; no infrastructure changed."
