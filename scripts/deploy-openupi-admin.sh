#!/usr/bin/env bash
# =============================================================================
# OpenUPI Admin — safe VPS deployment
#
# Run on the VPS from anywhere:
#   sudo -u deploy /opt/openupi/scripts/deploy-openupi-admin.sh
#   sudo -u deploy .../deploy-openupi-admin.sh --rollback
#
# What it guarantees:
#   * refuses to run on the wrong branch or an unexpected commit
#   * reads (never rewrites, never prints) .env.staging
#   * backs up the SQLite database and tags the previous image before rebuilding
#   * rebuilds and restarts ONLY the OpenUPI services (payment-api,
#     checkout-portal, openupi-admin) with --no-deps, leaving other containers
#     and other VPS applications untouched
#   * validates container health, HTTPS routing, anonymous auth and API isolation
#   * stops on the first failure and prints rollback instructions
#
# Nothing in this script writes a credential to stdout/stderr.
# =============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/openupi}"
EXPECTED_BRANCH="${EXPECTED_BRANCH:-fix/payment-integrity-verified}"
EXPECTED_COMMIT="${EXPECTED_COMMIT:-}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.staging.yml}"
IMAGE="${IMAGE:-youpi-pg:staging}"
VOLUME="${VOLUME:-youpi-staging_youpi-data}"
ADMIN_HOST="${ADMIN_HOST:-admin.169.58.29.37.sslip.io}"
CHECKOUT_HOST="${CHECKOUT_HOST:-pay.169.58.29.37.sslip.io}"
API_HOST="${API_HOST:-pay-api.169.58.29.37.sslip.io}"
ADMIN_PORT="${ADMIN_PORT:-6200}"
API_PORT="${API_PORT:-6100}"
CHECKOUT_PORT="${CHECKOUT_PORT:-7000}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_ROOT="${BACKUP_ROOT:-$APP_DIR/backups}"
BACKUP_DIR="$BACKUP_ROOT/openupi-$STAMP"
ROLLBACK_TAG="youpi-pg:rollback-$STAMP"
SERVICES=(payment-api checkout-portal openupi-admin)
STARTED=0

log()  { printf '[deploy] %s\n' "$*"; }
fail() {
  printf '[deploy] FAILED: %s\n' "$*" >&2
  if [ "$STARTED" -eq 1 ]; then
    cat >&2 <<EOF

--- ROLLBACK -------------------------------------------------------------------
  cd $APP_DIR
  docker image tag <previous-rollback-tag> $IMAGE     # tags listed below
  docker compose -f $COMPOSE_FILE up -d --no-deps ${SERVICES[*]}
  docker compose -f $COMPOSE_FILE ps
  sudo nginx -t && sudo systemctl reload nginx
  Database backup: $BACKUP_DIR/youpi-$STAMP.sqlite
  Restore (only if data was damaged):
    docker compose -f $COMPOSE_FILE stop payment-api
    docker run --rm -v $VOLUME:/data -v $BACKUP_DIR:/backup alpine \\
      sh -c 'cp -a /backup/youpi-$STAMP.sqlite /data/youpi.sqlite'
    docker compose -f $COMPOSE_FILE start payment-api
  Available rollback images:
$(docker image ls --format '  {{.Repository}}:{{.Tag}}' youpi-pg | sed -n '/rollback-/p' | tail -5)
-------------------------------------------------------------------------------
EOF
  fi
  exit 1
}
trap 'fail "unexpected error on line $LINENO"' ERR

for cmd in git docker curl; do
  command -v "$cmd" >/dev/null 2>&1 || fail "required command not found: $cmd"
done

cd "$APP_DIR" || fail "APP_DIR not found: $APP_DIR"
[ -f "$COMPOSE_FILE" ] || fail "compose file not found: $COMPOSE_FILE"

# ---------------------------------------------------------------- preflight --
log "Preflight: branch and release"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" != "$EXPECTED_BRANCH" ]; then
  fail "expected branch '$EXPECTED_BRANCH', found '$CURRENT_BRANCH'"
fi

if [ -n "$EXPECTED_COMMIT" ]; then
  CURRENT_COMMIT="$(git rev-parse HEAD)"
  if [ "$CURRENT_COMMIT" != "$EXPECTED_COMMIT" ]; then
    fail "expected commit $EXPECTED_COMMIT, found $CURRENT_COMMIT"
  fi
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  fail "working tree has uncommitted changes; commit or stash before deploying"
fi
log "Release: $CURRENT_BRANCH @ $(git rev-parse --short HEAD)"

log "Preflight: staging environment is present and complete"
[ -f .env.staging ] || fail ".env.staging is missing (it is never created by this script)"
for key in ADMIN_API_KEY MERCHANT_API_KEY YOUPI_SECRET_KEY OPENUPI_ADMIN_PASSWORD_HASH BASE_CHECKOUT_URL; do
  # -q keeps every value out of the log; the script never prints the file.
  if ! grep -Eq "^[[:space:]]*${key}=.+" .env.staging; then
    fail ".env.staging is missing $key (value not shown)"
  fi
done
if grep -Eq '^[[:space:]]*OPENUPI_ADMIN_PASSWORD=[^#]+' .env.staging; then
  log "WARNING: OPENUPI_ADMIN_PASSWORD is stored in plaintext; prefer OPENUPI_ADMIN_PASSWORD_HASH"
fi

# --------------------------------------------------------------- rollback ----
if [ "${1:-}" = "--rollback" ]; then
  PREVIOUS_TAG="$(docker image ls --format '{{.Repository}}:{{.Tag}}' youpi-pg | sed -n '/rollback-/p' | sort -r | head -n1)"
  [ -n "$PREVIOUS_TAG" ] || fail "no youpi-pg:rollback-* image found"
  log "Rolling back $IMAGE -> $PREVIOUS_TAG"
  docker image tag "$PREVIOUS_TAG" "$IMAGE"
  docker compose -f "$COMPOSE_FILE" up -d --no-deps "${SERVICES[@]}"
  log "Rollback complete. Verify: curl -fsS https://$ADMIN_HOST/ | grep -q OpenUPI"
  exit 0
fi

# ------------------------------------------------------------------ backup ---
log "Backup: SQLite database -> $BACKUP_DIR"
mkdir -p "$BACKUP_DIR"
if command -v sqlite3 >/dev/null 2>&1 && [ -f "${SQLITE_DB_PATH:-/opt/openupi/data/youpi.sqlite}" ]; then
  # Bind-mount installs only: VACUUM INTO is atomic and WAL-safe.
  sqlite3 "$SQLITE_DB_PATH" "VACUUM INTO '$BACKUP_DIR/youpi-$STAMP.sqlite'"
else
  # Named-volume installs (docker compose): copy through a container so WAL and
  # shared-memory files are captured together, then verify with pragma.
  docker run --rm \
    -v "$VOLUME:/data" \
    -v "$BACKUP_DIR:/backup" \
    node:22-bookworm-slim \
    node -e "const { DatabaseSync } = require('node:sqlite');
      const fs = require('node:fs');
      const db = new DatabaseSync('/data/youpi.sqlite');
      db.exec(\"VACUUM INTO '/backup/youpi-$STAMP.sqlite'\");
      db.close();
      const check = new DatabaseSync('/backup/youpi-$STAMP.sqlite');
      const row = check.prepare('PRAGMA integrity_check').get();
      check.close();
      const ok = row && Object.values(row)[0] === 'ok';
      if (!ok) { console.error('backup integrity check failed'); process.exit(1); }
      const bytes = fs.statSync('/backup/youpi-$STAMP.sqlite').size;
      if (!bytes) { console.error('backup file is empty'); process.exit(1); }" \
    || fail "database backup failed; nothing was rebuilt"
fi
log "Backup complete (integrity verified)"

log "Backup: previous image -> $ROLLBACK_TAG"
docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "image $IMAGE not found; cannot snapshot it"
docker image tag "$IMAGE" "$ROLLBACK_TAG"

# ------------------------------------------------------------- build/deploy --
STARTED=1
log "Building and restarting only: ${SERVICES[*]}"
docker compose -f "$COMPOSE_FILE" build "${SERVICES[@]}"
docker compose -f "$COMPOSE_FILE" up -d --no-deps "${SERVICES[@]}"

# --------------------------------------------------------------- validation --
log "Validation: container health"
wait_for_http() {
  local url="$1" attempts="${2:-40}"
  for _ in $(seq 1 "$attempts"); do
    if curl -fsS -o /dev/null --max-time 3 "$url"; then return 0; fi
    sleep 3
  done
  return 1
}

wait_for_http "http://127.0.0.1:$API_PORT/health" || fail "payment-api health check failed"
wait_for_http "http://127.0.0.1:$CHECKOUT_PORT/health" || fail "checkout-portal health check failed"
wait_for_http "http://127.0.0.1:$ADMIN_PORT/health" || fail "openupi-admin health check failed"

for service in "${SERVICES[@]}"; do
  state="$(docker inspect --format '{{.State.Status}}' "$(docker compose -f "$COMPOSE_FILE" ps -q "$service")" 2>/dev/null || echo missing)"
  [ "$state" = "running" ] || fail "container for $service is '$state'"
done

log "Validation: HTTPS routing and authentication"
curl -fsS --max-time 10 "https://$ADMIN_HOST/" | grep -q "OpenUPI" \
  || fail "https://$ADMIN_HOST/ did not serve the OpenUPI sign-in page"
if curl -fsS --max-time 10 "https://$ADMIN_HOST/" | grep -q "Real-Time Receiving Account Slot Ownership"; then
  fail "the legacy YOUPI dashboard is still publicly served on $ADMIN_HOST"
fi

admin_status() { curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$1"; }
[ "$(admin_status "https://$ADMIN_HOST/api/overview")" = "401" ] \
  || fail "admin API is not enforcing authentication"
[ "$(admin_status "https://$ADMIN_HOST/api/v1/checkout/x/state")" = "404" ] \
  || fail "gateway API routes are reachable from the admin host"
[ "$(admin_status "https://$ADMIN_HOST/test-console")" = "404" ] \
  || fail "legacy test console is exposed on the admin host"

wait_for_http "https://$CHECKOUT_HOST/health" || fail "public checkout host is not healthy"
wait_for_http "https://$API_HOST/health" || fail "public API host is not healthy"

log "Validation: anonymous gateway admin API is closed"
[ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "https://$API_HOST/api/v1/admin/payments")" = "404" ] \
  || fail "admin API is reachable on the public API host"

if command -v nginx >/dev/null 2>&1; then
  nginx -t >/dev/null 2>&1 || fail "nginx configuration is invalid"
fi

log "SUCCESS"
cat <<EOF

OpenUPI admin is live: https://$ADMIN_HOST
  - sign in with OPENUPI_ADMIN_USERNAME / OPENUPI_ADMIN_PASSWORD(_HASH)
  - previous image: $ROLLBACK_TAG
  - database backup: $BACKUP_DIR/youpi-$STAMP.sqlite
  - rollback: $0 --rollback

Health, auth and API-isolation checks passed. This proves deployment wiring only;
it is not a claim that a real bank payment has been observed end to end.
EOF
