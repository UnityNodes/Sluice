#!/usr/bin/env bash
#
# One-command demo of the x402-metered Sluice receiver.
#
#   1. start the receiver
#   2. make an UNPAID request  -> HTTP 402 Payment Required (+ challenge)
#   3. make a PAID request     -> HTTP 200 (stub-verified payment, event processed)
#   4. print the ledger of paid deliveries
#
# Usage:  ./demo.sh
#
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-4021}"
BASE_URL="http://localhost:${PORT}"
export PORT BASE_URL

# ---------------------------------------------------------------------------
# deps
# ---------------------------------------------------------------------------
if [ ! -d node_modules ]; then
  echo "==> installing dependencies (express) ..."
  npm install --no-audit --no-fund >/dev/null 2>&1 || npm install
fi

# ---------------------------------------------------------------------------
# start the receiver in the background
# ---------------------------------------------------------------------------
echo "==> starting x402-metered receiver on ${BASE_URL} ..."
node receiver.cjs &
RECEIVER_PID=$!
trap 'kill "${RECEIVER_PID}" 2>/dev/null || true' EXIT

# wait for /healthz, and abort if the receiver never came up (e.g. the port was
# busy) rather than running the rest of the demo against a dead server.
ready=""
for _ in $(seq 1 40); do
  if curl -sf "${BASE_URL}/healthz" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.25
done
if [ -z "$ready" ]; then
  echo "✗ receiver did not become healthy at ${BASE_URL} (is the port in use? set PORT to a free one)" >&2
  exit 1
fi

sep() { printf '\n\033[1m%s\033[0m\n' "----------------------------------------------------------------------"; }

# ---------------------------------------------------------------------------
# 1) UNPAID request -> expect 402
# ---------------------------------------------------------------------------
sep
echo "STEP 1  UNPAID request to POST /hook  (expect 402 Payment Required)"
sep
curl -s -o /tmp/x402-unpaid-body.json -w "HTTP %{http_code}\n" \
  -X POST "${BASE_URL}/hook" \
  -H 'Content-Type: application/json' \
  -d '{"subscription_id":"sub_x402_demo","event":{"amount":"5000000000000","to_account_hash":"account-hash-dc72…"},"delivered_at":"2026-07-01T00:00:00Z"}'
echo "challenge body:"
cat /tmp/x402-unpaid-body.json; echo

# ---------------------------------------------------------------------------
# 2) PAID request -> expect 200  (payer.cjs drives the full challenge->pay->retry)
# ---------------------------------------------------------------------------
sep
echo "STEP 2  PAID request via payer.cjs  (challenge -> sign -> retry, expect 200)"
sep
node payer.cjs

# ---------------------------------------------------------------------------
# 3) ledger of paid deliveries
# ---------------------------------------------------------------------------
sep
echo "STEP 3  Ledger of paid deliveries  (GET /ledger)"
sep
curl -s "${BASE_URL}/ledger"; echo

sep
echo "done. (facilitator verification was a STUB, no real CSPR moved)"
sep
