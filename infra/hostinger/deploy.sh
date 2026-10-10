#!/usr/bin/env bash
# ICOP Hostinger production gate — never use development credentials or seed users.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$ROOT/infra/hostinger/.env.production"
COMPOSE_FILE="$ROOT/docker-compose.hostinger.yml"
ACTION="$(echo "$1" 2>/dev/null || true)"
usage() { echo "Usage: $0 preflight|db-up|backup|migrate|release|status"; }
case "$ACTION" in preflight|db-up|backup|migrate|release|status) ;; *) usage; exit 2 ;; esac
command -v docker >/dev/null || { echo "FAIL: docker not installed"; exit 1; }
docker compose version >/dev/null || { echo "FAIL: docker compose v2 required"; exit 1; }
[ -f "$ENV_FILE" ] || { echo "FAIL: copy .env.production.example to .env.production"; exit 1; }
getenv() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }
perm="$(stat -c '%a' "$ENV_FILE")"
if (( (8#$perm & 0077) != 0 )); then
  echo "FAIL: chmod 600 infra/hostinger/.env.production first"
  exit 1
fi
domain="$(getenv ICOP_DOMAIN)"
email="$(getenv ACME_EMAIL)"
user="$(getenv DB_USER)"
db="$(getenv DB_NAME)"
pass="$(getenv DB_PASSWORD)"
db_url="$(getenv DATABASE_URL)"
jwt="$(getenv JWT_SECRET)"
master="$(getenv SECRETS_MASTER_KEY)"
[[ "$domain" =~ ^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$ ]] && [[ "$domain" != *example* ]] || { echo "FAIL: real ICOP_DOMAIN required"; exit 1; }
[[ "$email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] && [[ "$email" != *example* ]] || { echo "FAIL: real ACME_EMAIL required"; exit 1; }
[[ "$user" =~ ^[a-zA-Z0-9_]+$ && "$db" =~ ^[a-zA-Z0-9_]+$ ]] || { echo "FAIL: DB_USER and DB_NAME must be safe identifiers"; exit 1; }
[[ "$pass" =~ ^[0-9a-fA-F]{48,}$ ]] || { echo "FAIL: DB_PASSWORD must be random hex, openssl rand -hex 32"; exit 1; }
[[ "$db_url" == "postgres://$user:$pass@postgres:5432/$db" ]] || { echo "FAIL: DATABASE_URL does not match DB credentials"; exit 1; }
[[ "$jwt" =~ ^[0-9a-fA-F]{64,}$ ]] || { echo "FAIL: JWT_SECRET must be random hex, openssl rand -hex 48"; exit 1; }
[[ "$master" =~ ^[0-9a-fA-F]{64}$ ]] || { echo "FAIL: SECRETS_MASTER_KEY must be random hex, openssl rand -hex 32"; exit 1; }
[[ "$(getenv NODE_ENV)" == production ]] || { echo "FAIL: NODE_ENV must be production"; exit 1; }
[[ "$(getenv APP_PUBLIC_ORIGIN)" == "https://$domain" ]] || { echo "FAIL: APP_PUBLIC_ORIGIN must be HTTPS production domain"; exit 1; }
[[ "$(getenv ALLOWED_ORIGINS)" == "https://$domain" ]] || { echo "FAIL: ALLOWED_ORIGINS must match domain"; exit 1; }
[[ "$(getenv RUN_SEED)" == false ]] && [[ "$(getenv ESIGN_SANDBOX_ENABLED)" == false ]] || { echo "FAIL: production seed and sandbox must stay disabled"; exit 1; }
[[ "$(getenv API_DOCS_ENABLED)" == false ]] || { echo "FAIL: API docs must be disabled"; exit 1; }
cd "$ROOT"
dc() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
dc config --quiet
if [ "$ACTION" = preflight ]; then
  echo "PASS: production configuration validated; nothing deployed."
  exit 0
fi
case "$ACTION" in
  db-up)
    dc up -d --wait postgres
    echo "PostgreSQL started with no public port. Migrations NOT applied."
    ;;
  backup)
    dc up -d --wait postgres
    umask 077
    backup_dir="$(printenv ICOP_BACKUP_DIR || true)"
    [ -n "$backup_dir" ] || backup_dir="/var/backups/icop"
    mkdir -p "$backup_dir"
    backup="$backup_dir/icop-$(date -u '+%Y%m%dT%H%M%SZ').dump"
    dc exec -T postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup"
    test -s "$backup" || { rm -f "$backup"; echo "FAIL: database backup empty"; exit 1; }
    chmod 600 "$backup"
    echo "Database backup created: $backup. Copy off-VPS encrypted and rehearse restore."
    ;;
  migrate)
    [ "$(printenv ICOP_APPROVE_MIGRATION || true)" = YES ] || { echo "FAIL: set ICOP_APPROVE_MIGRATION=YES after DB change approval"; exit 1; }
    "$0" backup
    dc build migrate api
    dc --profile migration run --rm migrate
    dc run --rm api node dist/migration-preflight.js --target=post
    echo "Migration and postflight completed; production UAT still required."
    ;;
  release)
    # No seed, no implicit schema migration, no public API or database ports.
    dc up -d --wait postgres
    dc build api web
    dc run --rm api node dist/migration-preflight.js --target=post
    dc up -d --wait --no-build api web edge
    echo "Containers started. Verify HTTPS, login/MFA, UAT, backup restore and audit before declaring LIVE."
    ;;
  status)
    dc ps
    ;;
esac
