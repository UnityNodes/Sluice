#!/usr/bin/env bash
#
# scripts/demo.sh, boot the full Sluice demo stack with one command.
#
# What you get:
#   - matcher              (Casper testnet WebSocket → predicate engine)
#   - caddy                (landing + /app + /status + /feed + /h/demo)
#   - demo-webhook         (logs every POST, replies 200, verifies HMAC)
#   - prometheus           (scrapes /api/metrics)
#   - grafana              (auto-provisioned dashboard, http://localhost:3001)
#   - 2 pre-seeded subscriptions targeting demo-webhook + /h/demo
#
# Open:
#   http://localhost:8080            landing
#   http://localhost:8080/app        workspace
#   http://localhost:8080/status     system status
#   http://localhost:8080/h/demo     hosted receiver, watch deliveries
#   http://localhost:3001            grafana (admin / admin)
#   http://localhost:9090            prometheus
#
# Requirements:
#   - docker + docker compose v2
#   - SLUICE_CSPR_CLOUD_TOKEN exported (or set in .env.testnet)
#     → free signup at https://cspr.cloud
#
# Stop:    ./scripts/demo.sh down
# Logs:    ./scripts/demo.sh logs [service]
# Status:  ./scripts/demo.sh ps

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f .env.testnet ]]; then
  # Export every line, ignoring blanks/comments.
  set -a; . ./.env.testnet; set +a
fi

if [[ -z "${SLUICE_CSPR_CLOUD_TOKEN:-}" ]]; then
  echo "✗ SLUICE_CSPR_CLOUD_TOKEN not set."
  echo "  Either export it or put it in .env.testnet."
  echo "  Free token: https://cspr.cloud"
  exit 1
fi

# Ensure the matcher key exists, generate a throwaway if absent so the
# container doesn't fail on the read-only mount.
if [[ ! -f keys/matcher/secret_key.pem ]]; then
  echo "→ generating throwaway matcher key (demo only, no on-chain calls)"
  mkdir -p keys/matcher
  openssl genpkey -algorithm Ed25519 -out keys/matcher/secret_key.pem 2>/dev/null
fi

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.demo.yml --profile demo --profile monitoring)

case "${1:-up}" in
  up)
    echo "→ building + starting demo stack…"
    "${COMPOSE[@]}" up -d --build
    echo
    echo "✓ demo running. Wait ~10 seconds for matcher to connect to CSPR.cloud, then:"
    echo
    echo "  Landing:           http://localhost:8080"
    echo "  Workspace:         http://localhost:8080/app"
    echo "  Status:            http://localhost:8080/status"
    echo "  Hosted receiver:   http://localhost:8080/h/demo"
    echo "  Grafana:           http://localhost:3001    (admin / admin)"
    echo "  Prometheus:        http://localhost:9090"
    echo
    echo "  Tail webhook hits: ./scripts/demo.sh logs demo-webhook"
    echo "  Stop:              ./scripts/demo.sh down"
    ;;
  down|stop)
    "${COMPOSE[@]}" down -v
    ;;
  logs)
    shift
    "${COMPOSE[@]}" logs -f "${@:-}"
    ;;
  ps)
    "${COMPOSE[@]}" ps
    ;;
  *)
    echo "usage: $0 {up|down|logs [service]|ps}"
    exit 2
    ;;
esac
