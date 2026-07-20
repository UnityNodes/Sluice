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
# The agent verifies the HMAC signature before acting, and the README says so.
# Leaving this unset made verify() fail open and every log line read
# "verified": false, which flatly contradicted the claim. Default it so the
# demo actually demonstrates the guarantee.
export SLUICE_WEBHOOK_SECRET="${SLUICE_WEBHOOK_SECRET:-demo-secret-please-change}"
# Left unset on purpose. Sluice's SSRF guard rejects loopback targets, so
# defaulting this to localhost made every sandbox dispatch fail with 400 while
# the demo still printed "complete". With no public URL we sign locally instead.
LOCAL_URL="http://127.0.0.1:${PORT}/webhook"

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

# hex HMAC-SHA256 over the body, matching the matcher's X-Sluice-Signature.
sign() { printf '%s' "$1" | openssl dgst -sha256 -hmac "$SLUICE_WEBHOOK_SECRET" -r | awk '{print $1}'; }

# One Sluice-shaped webhook envelope for a large deposit (motes).
envelope() {
  local motes="$1"
  cat <<JSON
{"subscription_id":42,"event":{"amount":"$motes","to_account_hash":"$POOL","initiator_account_hash":"$DEPOSITOR","deploy_hash":"deploy-$(date +%s)-$RANDOM","block_height":3500000,"timestamp":"$(date -u +%FT%TZ)"},"delivered_at":"$(date -u +%FT%TZ)"}
JSON
}

fire_local() {
  local body="$1" sig
  sig="sha256=$(sign "$body")"
  curl -s -o /dev/null -X POST "$LOCAL_URL" \
    -H 'content-type: application/json' \
    -H "X-Sluice-Signature: $sig" \
    -H "X-Sluice-Idempotency-Key: demo-$RANDOM" \
    -H 'X-Sluice-Sub-Id: 42' \
    --data "$body"
  sleep 1.2   # let the agent finish its verify -> decide -> log line
}

POOL="account-hash-yieldPool00000000000000000000000000000000000000000000000"
DEPOSITOR="account-hash-whaleDepositor000000000000000000000000000000000000000"

if [ -n "${PUBLIC_WEBHOOK_URL:-}" ]; then
  echo "▶ firing 3 sandbox events via ${SLUICE_API}/sandbox/dispatch → ${PUBLIC_WEBHOOK_URL}"
  echo "  (predicate: large deposits >= 50,000 CSPR)"
  curl -sf -X POST "${SLUICE_API}/sandbox/dispatch" \
    -H 'content-type: application/json' \
    -d "{\"webhook\":\"${PUBLIC_WEBHOOK_URL}\",\"predicate\":${PREDICATE},\"count\":3}" \
    && echo || echo "sandbox dispatch failed, is PUBLIC_WEBHOOK_URL reachable from Sluice?"
  sleep 5
else
  echo "▶ no PUBLIC_WEBHOOK_URL set, posting 3 locally-signed deposit events"
  echo "  (set PUBLIC_WEBHOOK_URL to a tunnelled /webhook URL to drive this through Sluice instead)"
  fire_local "$(envelope 120000000000000)"    # 120k CSPR
  fire_local "$(envelope 750000000000000)"    # 750k CSPR
  fire_local "$(envelope 60000000000000)"     # 60k CSPR
fi

echo "▶ demo complete, scroll up to see each verify → decide → log line."
