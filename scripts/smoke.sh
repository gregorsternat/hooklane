#!/bin/sh
# Exercise only an isolated Compose project, never the developer's database.
set -eu

cd "$(dirname "$0")/.."
project="hooklane-smoke-$$"
export APP_PORT="${SMOKE_APP_PORT:-18088}"
export POSTGRES_PORT="${SMOKE_POSTGRES_PORT:-15438}"
export POSTGRES_USER=hooklane POSTGRES_PASSWORD=smoke_local POSTGRES_DB=hooklane
export LOG_LEVEL=info READINESS_TIMEOUT=2s SHUTDOWN_TIMEOUT=10s
export ADMIN_TOKEN=smoke-admin-token-at-least-32-characters
export INGEST_TOKEN=smoke-ingest-token-at-least-32-characters
export ENCRYPTION_KEY=1111111111111111111111111111111111111111111111111111111111111111
export ALLOW_HTTP_DESTINATIONS=true
export DESTINATION_ALLOWED_CIDRS=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16
export WORKER_POLL_INTERVAL=100ms RETRY_BASE=200ms MAX_ATTEMPTS=4
base="http://127.0.0.1:$APP_PORT"

compose() { docker compose --env-file /dev/null -f compose.yaml -f compose.smoke.yaml -p "$project" "$@"; }
cleanup() {
  result=$?
  trap - EXIT
  if [ "$result" -ne 0 ]; then compose logs --tail=80 || true; fi
  compose down --volumes --remove-orphans
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

expect_status() {
  actual=$(curl --max-time 5 -s -o /dev/null -w '%{http_code}' "$base$2")
  if [ "$actual" != "$1" ]; then
    echo "$2: expected HTTP $1, got $actual" >&2
    return 1
  fi
}

compose up --build --wait --wait-timeout 90
expect_status 200 /healthz
expect_status 200 /readyz
curl --max-time 5 -fsS "$base/" | grep -q '<title>Hooklane</title>'
expect_status 401 /api/v1/events
python3 scripts/smoke_api.py "$base"
compose logs receiver | grep -q 'verified webhook'

compose exec -T db psql -U hooklane -d hooklane -v ON_ERROR_STOP=1 \
  -c 'CREATE TABLE smoke_probe (value text NOT NULL); INSERT INTO smoke_probe VALUES ('"'persistent'"');'

echo 'Checking PostgreSQL outage and recovery...'
compose stop db
expect_status 200 /healthz
expect_status 503 /readyz
compose start --wait db
attempt=0
until expect_status 200 /readyz; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 20 ] || exit 1
  sleep 1
done

echo 'Checking graceful shutdown...'
compose stop app
app_id=$(compose ps -aq app)
[ "$(docker inspect -f '{{.State.ExitCode}}' "$app_id")" = 0 ]
compose logs app | grep -q 'HTTP server stopped'

echo 'Checking persistence across container recreation...'
compose down
compose up --wait --wait-timeout 90
expect_status 200 /readyz
stored=$(compose exec -T db psql -U hooklane -d hooklane -Atc 'SELECT value FROM smoke_probe;')
[ "$stored" = persistent ]
event_count=$(compose exec -T db psql -U hooklane -d hooklane -Atc 'SELECT count(*) FROM events;')
[ "$event_count" = 2 ]
echo 'Checking encryption-key mismatch gates data access...'
(ENCRYPTION_KEY=2222222222222222222222222222222222222222222222222222222222222222 compose up -d --force-recreate app)
attempt=0
until expect_status 200 /healthz; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 20 ] || exit 1
  sleep 1
done
expect_status 503 /readyz
actual=$(curl --max-time 5 -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $ADMIN_TOKEN" "$base/api/v1/stats")
[ "$actual" = 503 ]
compose up -d --force-recreate --wait --wait-timeout 90 app
expect_status 200 /readyz
echo 'Smoke checks passed.'
