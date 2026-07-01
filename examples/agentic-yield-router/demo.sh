#!/usr/bin/env bash
#
# One-command end-to-end demo of the autonomous yield-routing loop.
#
#   1. boots agent.js locally (in --dry-run so no secret and no real trades)
#   2. fires 3 sandbox events at it through Sluice's sandbox dispatch endpoint
#, real Sluice delivery path, zero on-chain cost
#   3. you watch the agent verify → decide → log for each event, then it exits
#
# Usage:  bash demo.sh
#
# Env you can override:
#   PORT               local port for the agent           (default 8791)
#   SLUICE_API         Sluice API base                    (default https://sluice.unitynodes.com/api)
#   PUBLIC_WEBHOOK_URL where the matcher should POST. Defaults to the local
#                      server, which only works if the Sluice sandbox can reach
#                      this host. On a laptop, expose it first (ngrok / cloudflared)
#                      and set PUBLIC_WEBHOOK_URL to that public /webhook URL.
set -euo pipefail

PORT="${PORT:-8791}"
SLUICE_API="${SLUICE_API:-https://sluice.unitynodes.com/api}"
PUBLIC_WEBHOOK_URL="${PUBLIC_WEBHOOK_URL:-http://localhost:${PORT}/webhook}"

# A "large deposit" predicate: only push transfers >= 50,000 CSPR
# (50000 * 1_000_000_000 = 50000000000000 motes) so the demo events are the
# kind that actually trigger the rebalance branch.
PREDICATE='{"and":[{"field":"amount","op":"gte","value":"50000000000000"}]}'

cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "▶ installing deps…"
  npm install --silent
fi

echo "▶ starting agent on :${PORT} (dry-run, no trades will execute)…"
node agent.js --dry-run &
AGENT_PID=$!
# Always clean up the background agent, even on error / Ctrl-C.
trap 'kill "${AGENT_PID}" 2>/dev/null || true' EXIT

# Wait for /health instead of a blind sleep.
echo -n "▶ waiting for agent to be ready"
for _ in $(seq 1 20); do
  if curl -sf "http://localhost:${PORT}/health" >/dev/null 2>&1; then
    echo " ✓"
    break
  fi
  echo -n "."
  sleep 0.25
done

echo "▶ firing 3 sandbox events via ${SLUICE_API}/sandbox/dispatch → ${PUBLIC_WEBHOOK_URL}"
echo "  (predicate: large deposits ≥ 50,000 CSPR)"
curl -sf -X POST "${SLUICE_API}/sandbox/dispatch" \
  -H 'content-type: application/json' \
  -d "{\"webhook\":\"${PUBLIC_WEBHOOK_URL}\",\"predicate\":${PREDICATE},\"count\":3}" \
  && echo || echo "⚠ sandbox dispatch failed, is PUBLIC_WEBHOOK_URL reachable from Sluice?"

echo "▶ watching for decisions (Ctrl-C to stop)…"
# Give the sandbox deliveries time to land and be processed, then exit cleanly.
sleep 5
echo "▶ demo complete, scroll up to see each verify → decide → log line."
