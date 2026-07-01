#!/usr/bin/env bash
# Fires a real Swap event from the DemoDex contract on Casper testnet.
#
# DemoDex is a minimal DeFi contract whose non-payable `swap` entry point emits
# a CES `Swap` event. The live Sluice matcher watches its package
# (SLUICE_WATCH_CONTRACTS) and delivers any Swap over the subscription threshold
# to the webhook + /app feed. Use this to drive a live end-to-end demonstration.
#
# Usage:
#   scripts/demo-swap.sh [amount_in_cspr] [token_in] [token_out]
# Example:
#   scripts/demo-swap.sh 500000 CSPR USDC

set -euo pipefail

DEX_PACKAGE="${DEX_PACKAGE:-ffb5a95650e034784bb8c2f2a2bd03c814f8edf9a895b10d3edd4690e907b7b7}"
# Default to the subscriber key: it carries the demo-swap budget and keeps the
# matcher key free for its real job (record_delivery on genuine subscriptions).
KEY="${DEMO_SWAP_KEY:-/root/Sluice/keys/subscriber/secret_key.pem}"
NODE="${SLUICE_NODE_RPC_URL:-https://node.testnet.casper.network/rpc}"
CHAIN="${SLUICE_CHAIN_NAME:-casper-test}"
CC="${CASPER_CLIENT_BIN:-/home/claude/.cargo/bin/casper-client}"

AMOUNT_CSPR="${1:-500000}"
TOKEN_IN="${2:-CSPR}"
TOKEN_OUT="${3:-USDC}"

# motes = CSPR * 1e9; amount_out applies a 0.25% fee for realism.
AMOUNT_IN=$(python3 -c "print(int($AMOUNT_CSPR)*1000000000)")
AMOUNT_OUT=$(python3 -c "print(int(int($AMOUNT_CSPR)*1000000000*0.9975))")
# A pseudo-random trader hash per call (varies the event; deterministic seedless).
TRADER=$(head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n')

echo "swap: ${AMOUNT_CSPR} ${TOKEN_IN} -> ${TOKEN_OUT}  trader=${TRADER:0:12}…"

"$CC" put-transaction package \
  --node-address "$NODE" \
  --secret-key "$KEY" \
  --chain-name "$CHAIN" \
  --pricing-mode classic --payment-amount 3000000000 \
  --gas-price-tolerance 1 --standard-payment true \
  --package-address "package-$DEX_PACKAGE" \
  --session-entry-point swap \
  --transaction-runtime vm-casper-v1 \
  --session-arg "trader:string='$TRADER'" \
  --session-arg "token_in:string='$TOKEN_IN'" \
  --session-arg "token_out:string='$TOKEN_OUT'" \
  --session-arg "amount_in:u512='$AMOUNT_IN'" \
  --session-arg "amount_out:u512='$AMOUNT_OUT'"
