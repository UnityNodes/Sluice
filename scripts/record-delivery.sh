#!/usr/bin/env bash
# Submits a record_delivery transaction via casper-client (because casper-js-sdk@5.0.0-rc6
# has a serialization quirk for Stored targets, see matcher/src/casper.ts).
#
# Usage:
#   record-delivery.sh <subscription_id> <event_hash_string>
#
# Required env (loaded from .env.testnet by the matcher):
#   SLUICE_CONTRACT_HASH        deployed package hash (64-hex, no prefix)
#   SLUICE_MATCHER_KEY_PATH     path to matcher's secret_key.pem
#   SLUICE_NODE_RPC_URL         RPC endpoint (default node.testnet.casper.network/rpc)
#   SLUICE_CHAIN_NAME           default casper-test

set -euo pipefail

# Locate casper-client even when invoked from non-login shells (e.g. tmux, node spawn).
CASPER_CLIENT="${CASPER_CLIENT:-}"
if [ -z "$CASPER_CLIENT" ]; then
  if command -v casper-client >/dev/null 2>&1; then
    CASPER_CLIENT=casper-client
  elif [ -x "$HOME/.cargo/bin/casper-client" ]; then
    CASPER_CLIENT="$HOME/.cargo/bin/casper-client"
  elif [ -x "/home/claude/.cargo/bin/casper-client" ]; then
    CASPER_CLIENT="/home/claude/.cargo/bin/casper-client"
  else
    echo "casper-client not found on PATH or ~/.cargo/bin" >&2; exit 127
  fi
fi

SUB_ID="${1:?usage: record-delivery.sh <subscription_id> <event_hash>}"
EVENT_HASH="${2:?usage: record-delivery.sh <subscription_id> <event_hash>}"

: "${SLUICE_CONTRACT_HASH:?must be set}"
: "${SLUICE_MATCHER_KEY_PATH:?must be set}"

NODE="${SLUICE_NODE_RPC_URL:-https://node.testnet.casper.network/rpc}"
CHAIN="${SLUICE_CHAIN_NAME:-casper-test}"

"$CASPER_CLIENT" put-transaction package \
  --node-address "$NODE" \
  --secret-key "$SLUICE_MATCHER_KEY_PATH" \
  --chain-name "$CHAIN" \
  --pricing-mode classic \
  --payment-amount 5000000000 \
  --gas-price-tolerance 1 \
  --standard-payment true \
  --package-address "package-$SLUICE_CONTRACT_HASH" \
  --session-entry-point record_delivery \
  --transaction-runtime vm-casper-v1 \
  --session-arg "id:u32='$SUB_ID'" \
  --session-arg "event_hash:string='$EVENT_HASH'"
