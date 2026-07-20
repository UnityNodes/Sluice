#!/usr/bin/env bash
# Deploy SubscriptionRegistry to Casper testnet via Odra Livenet.
#
# Required env (load from .env or export):
#   ODRA_CASPER_LIVENET_SECRET_KEY_PATH   ./keys/matcher/secret_key.pem
#   ODRA_CASPER_LIVENET_NODE_ADDRESS      https://node.testnet.cspr.cloud
#   ODRA_CASPER_LIVENET_EVENTS_URL        https://node.testnet.cspr.cloud/events
#   ODRA_CASPER_LIVENET_CHAIN_NAME        casper-test
#   CSPR_CLOUD_AUTH_TOKEN                 <bearer token from cspr.cloud>

set -euo pipefail

cd "$(dirname "$0")/.."
cd contract

: "${ODRA_CASPER_LIVENET_SECRET_KEY_PATH:?missing}"
: "${ODRA_CASPER_LIVENET_NODE_ADDRESS:?missing}"
: "${ODRA_CASPER_LIVENET_CHAIN_NAME:?missing}"

echo "1/2  building contract wasm..."
cargo odra build

echo "2/2  deploying via odra-cli..."
cargo run --bin contract_cli -- deploy
