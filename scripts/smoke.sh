#!/bin/sh
# Exercise only an isolated Compose project, never the developer's database.
set -eu

cd "$(dirname "$0")/.."
project="hooklane-smoke-$$"
export APP_PORT="${SMOKE_APP_PORT:-18088}"
export POSTGRES_PORT="${SMOKE_POSTGRES_PORT:-15438}"
export POSTGRES_USER=hooklane POSTGRES_PASSWORD=smoke_local POSTGRES_DB=hooklane
export LOG_LEVEL=info READINESS_TIMEOUT=2s SHUTDOWN_TIMEOUT=10s
base="http://127.0.0.1:$APP_PORT"

compose() { docker compose --env-file /dev/null -p "$project" "$@"; }
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
expect_status 404 /api/v1/events

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
echo 'Smoke checks passed.'
