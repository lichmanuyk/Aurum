#!/usr/bin/env bash
# Spins up a throwaway Aurum stack for E2E tests, runs Playwright against it,
# then always tears the stack down again — including its Postgres volume.
#
# Fully isolated from the real self-hosted instance:
#   - separate compose project name (aurum-e2e)      -> separate containers/network
#   - separate Postgres database name (aurum_e2e)     -> separate data, same server
#   - separate host port (3100, vs the real one's 3000) -> no port clash
#   - `down -v` on exit removes the isolated volume, so no test data persists
#     and the real `aurum`/`aurum_pgdata` are never opened.
set -euo pipefail
cd "$(dirname "$0")/.."

export AURUM_POSTGRES_USER=aurum
export AURUM_DEFAULT_CURRENCY=USD
export AURUM_BIND_ADDRESS=127.0.0.1
export AURUM_BASIC_AUTH_USER= AURUM_BASIC_AUTH_PASSWORD= AURUM_COINGECKO_API_KEY=
export AURUM_POSTGRES_DB=aurum_e2e
export AURUM_POSTGRES_PASSWORD=aurum-e2e-only
export AURUM_WEB_PORT=3100
COMPOSE="docker compose --env-file /dev/null -p aurum-e2e"

cleanup() {
  $COMPOSE down -v
}
trap cleanup EXIT

$COMPOSE up -d --build

echo "waiting for http://localhost:${AURUM_WEB_PORT}/api/health ..."
# /api/health, not just / — nginx (the `web` container) answers the bare root
# well before the backend has finished running migrations + seeding, and a
# request racing ahead of that gets nginx's own HTML error page back instead
# of JSON, which the first test to touch the API then fails to parse.
for _ in $(seq 1 60); do
  if curl -sf "http://localhost:${AURUM_WEB_PORT}/api/health" >/dev/null; then
    echo "stack is up"
    break
  fi
  sleep 1
done

cd e2e
npm ci
AURUM_E2E_BASE_URL="http://localhost:${AURUM_WEB_PORT}" npx playwright test "$@"
