#!/usr/bin/env bash
#
# One-command demo of the Sluice → multi-agent DAO swarm.
#
#   ./demo.sh
#
# It:
#   1. starts the coordinator (webhook server) on $PORT,
#   2. fires 3 governance triggers so you see the full swarm deliberate,
#   3. tears the coordinator down.
#
# Two delivery paths, picked automatically:
#   • PUBLIC_WEBHOOK_URL set → uses Sluice's real sandbox endpoint
#     (POST /api/sandbox/dispatch), the matcher fires signed demo events at
#     your public URL, exactly like production. No CSPR spent.
#   • otherwise (default)    → posts locally-signed events straight at the
#     coordinator, so the demo works offline with no tunnel.
#
# Env:
#   SLUICE_WEBHOOK_SECRET   shared HMAC secret (default: a demo value below)
#   PORT                    coordinator port (default: 8790)
#   PUBLIC_WEBHOOK_URL      optional public https URL → enables real sandbox path
#   SLUICE_API_URL          optional (default: https://sluice.unitynodes.com/api)
set -euo pipefail
cd "$(dirname "$0")"

export SLUICE_WEBHOOK_SECRET="${SLUICE_WEBHOOK_SECRET:-demo-secret-please-change}"
export PORT="${PORT:-8790}"
SLUICE_API_URL="${SLUICE_API_URL:-https://sluice.unitynodes.com/api}"
LOCAL_URL="http://127.0.0.1:${PORT}/webhook"

if [ ! -d node_modules ]; then
  echo "installing deps…"
  npm install --silent
fi

echo "▶ starting coordinator on :$PORT"
node coordinator.js &
COORD_PID=$!
trap 'kill "$COORD_PID" 2>/dev/null || true' EXIT

# wait for the server to accept connections, and fail loudly if it never came
# up (e.g. the port was busy). Otherwise the script would sail past a dead
# coordinator and still print "demo complete" with nothing above it.
ready=""
for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.2
done
if [ -z "$ready" ]; then
  echo "✗ coordinator did not become healthy on :${PORT} (is the port in use? try PORT=18790 ./demo.sh)" >&2
  exit 1
fi

# hex HMAC-SHA256 of a body with the shared secret (matches X-Sluice-Signature)
sign() { printf '%s' "$1" | openssl dgst -sha256 -hmac "$SLUICE_WEBHOOK_SECRET" -r | awk '{print $1}'; }

# Build one Sluice-shaped webhook envelope: (motes, to, from)
envelope() {
  local motes="$1" to="$2" from="$3"
  cat <<JSON
{"subscription_id":42,"event":{"amount":"$motes","to_account_hash":"$to","initiator_account_hash":"$from","deploy_hash":"deploy-$(date +%s)-$RANDOM","block_height":3500000,"timestamp":"$(date -u +%FT%TZ)"},"delivered_at":"$(date -u +%FT%TZ)"}
JSON
}

fire_local() {
  local body="$1"
  local sig; sig="sha256=$(sign "$body")"
  curl -s -o /dev/null -X POST "$LOCAL_URL" \
    -H 'content-type: application/json' \
    -H "X-Sluice-Signature: $sig" \
    -H "X-Sluice-Idempotency-Key: demo-$RANDOM" \
    -H 'X-Sluice-Sub-Id: 42' \
    --data "$body"
  sleep 0.6   # let the transcript print before the next one
}

# The three governance triggers a judge should see deliberated:
#   1) 500k CSPR inflow  → all three approve → PASS + execute
#   2) 5M CSPR inflow    → Risk rejects, Legal abstains → REJECT
#   3) 25k CSPR inflow   → routine, unanimous approve → PASS
TREASURY="account-hash-daoTreasury000000000000000000000000000000000000000000"
DONOR="account-hash-partnerFund00000000000000000000000000000000000000000000"

if [ -n "${PUBLIC_WEBHOOK_URL:-}" ]; then
  echo "▶ firing 3 events via Sluice sandbox → $PUBLIC_WEBHOOK_URL"
  curl -s -X POST "$SLUICE_API_URL/sandbox/dispatch" \
    -H 'content-type: application/json' \
    --data "{\"webhook\":\"$PUBLIC_WEBHOOK_URL\",\"predicate\":{\"and\":[{\"field\":\"amount\",\"op\":\"gte\",\"value\":\"50000000000000\"}]},\"count\":3}" \
    | sed 's/^/  sandbox: /'
  echo
  echo "  (events will arrive at your public URL; watch the coordinator logs there)"
  sleep 3
else
  echo "▶ no PUBLIC_WEBHOOK_URL, posting 3 locally-signed governance triggers"
  fire_local "$(envelope 500000000000000 "$TREASURY" "$DONOR")"     # 500k CSPR
  fire_local "$(envelope 5000000000000000 "$TREASURY" "$DONOR")"    # 5M CSPR
  fire_local "$(envelope 25000000000000 "$TREASURY" "$DONOR")"      # 25k CSPR
fi

echo
echo "✔ demo complete, scroll up for the three swarm deliberations."
