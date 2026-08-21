#!/usr/bin/env bash
set -euo pipefail

CURRENT_IMAGE="${ROLLBACK_CURRENT_IMAGE:-pickket-audit-final-20260719}"
PREVIOUS_IMAGE="${ROLLBACK_PREVIOUS_IMAGE:-}"
NETWORK="rollback-rehearsal-$RANDOM"
PG_CONTAINER="$NETWORK-pg"
REDIS_CONTAINER="$NETWORK-redis"
APP_CONTAINER="$NETWORK-app"
PG_PASSWORD="${ROLLBACK_PG_PASSWORD:-rollback_local_only}"
cleanup() {
  docker rm -f "$APP_CONTAINER" "$REDIS_CONTAINER" "$PG_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [[ "${ROLLBACK_REHEARSAL_CONFIRM:-}" != "I_UNDERSTAND" ]]; then
  echo "ROLLBACK_REHEARSAL_CONFIRM=I_UNDERSTAND is required" >&2
  exit 2
fi
if [[ -z "$PREVIOUS_IMAGE" ]]; then
  echo "ROLLBACK_PREVIOUS_IMAGE must point to an already built prior image" >&2
  exit 2
fi
for image in "$CURRENT_IMAGE" "$PREVIOUS_IMAGE"; do
  docker image inspect "$image" >/dev/null || { echo "image not found: $image" >&2; exit 2; }
done
CURRENT_DIGEST="$(docker image inspect "$CURRENT_IMAGE" --format '{{.Id}}')"
PREVIOUS_DIGEST="$(docker image inspect "$PREVIOUS_IMAGE" --format '{{.Id}}')"
if [[ "$CURRENT_DIGEST" == "$PREVIOUS_DIGEST" ]]; then
  echo "current and previous images must have different digests" >&2
  exit 2
fi
echo "rollback images: current=$CURRENT_DIGEST previous=$PREVIOUS_DIGEST"

docker network create "$NETWORK" >/dev/null
docker run -d --name "$PG_CONTAINER" --network "$NETWORK" \
  -e POSTGRES_USER=pickket -e POSTGRES_PASSWORD="$PG_PASSWORD" -e POSTGRES_DB=pickket_go \
  postgres:16-alpine >/dev/null
docker run -d --name "$REDIS_CONTAINER" --network "$NETWORK" redis:7-alpine >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$PG_CONTAINER" pg_isready -U pickket -d pickket_go >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$PG_CONTAINER" pg_isready -U pickket -d pickket_go >/dev/null

run_migrations() {
  local image="$1"
  docker run --rm --network "$NETWORK" \
    -e PG_HOST="$PG_CONTAINER" -e PG_PORT=5432 -e PG_USER=pickket -e PG_PASSWORD="$PG_PASSWORD" -e PG_DATABASE=pickket_go \
    "$image" npx tsx scripts/migrate.ts >/dev/null
}
start_and_check() {
  local image="$1" label="$2"
  docker rm -f "$APP_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$APP_CONTAINER" --network "$NETWORK" -p 0:3003 \
    -e NODE_ENV=production -e PG_HOST="$PG_CONTAINER" -e PG_PORT=5432 -e PG_USER=pickket -e PG_PASSWORD="$PG_PASSWORD" -e PG_DATABASE=pickket_go \
    -e REDIS_URL="redis://$REDIS_CONTAINER:6379" -e CRON_SECRET=rollback-cron "$image" >/dev/null
  local port=""
  for _ in $(seq 1 60); do
    port="$(docker port "$APP_CONTAINER" 3003/tcp 2>/dev/null | head -n 1 | sed -E 's/.*://')"
    if [[ -n "$port" ]] && curl -fsS "http://127.0.0.1:$port/api/health/live" >/dev/null 2>&1; then break; fi
    sleep 1
  done
  [[ -n "$port" ]] || { echo "$label did not expose port" >&2; return 1; }
  local live ready
  live="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/health/live")"
  ready="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/health/ready")"
  echo "${label}: live=$live ready=$ready image=$image"
  [[ "$live" == "200" && "$ready" == "200" ]]
  if [[ "$label" == "current" ]]; then
    local cron
    cron="$(curl -sS -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer rollback-cron' -H "x-cron-timestamp: $(date -u +%FT%TZ)" "http://127.0.0.1:$port/api/cron/retry-order-webhooks")"
    echo "${label}: retry-order-webhooks=$cron"
    [[ "$cron" != "404" && "$cron" != "401" ]]
  fi
  docker rm -f "$APP_CONTAINER" >/dev/null
}

run_migrations "$CURRENT_IMAGE"
start_and_check "$CURRENT_IMAGE" "current"
# The previous image starts against the new schema without running migrations;
# this is the compatibility/rollback gate. It must be supplied explicitly.
start_and_check "$PREVIOUS_IMAGE" "previous"
run_migrations "$CURRENT_IMAGE"
echo "rollback rehearsal complete: migration rerun + current/previous runtime + current redeploy"
