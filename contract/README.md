# Sluice contracts

Two Casper contracts written with [Odra](https://odra.dev) 2.8.

### SubscriptionRegistry (`src/registry.rs`)

The on-chain escrow for Sluice subscriptions. A subscriber locks CSPR, stores a
predicate and a webhook URL, and the matcher records each delivery against it.

Entry points:
- `create_subscription(predicate_json, webhook_url)` (payable): locks the attached CSPR and stores the subscription.
- `record_delivery(id, event_hash)`: decrements the balance by the per-delivery cost and counts the delivery.
- `top_up(id)` (payable): adds CSPR to a subscription and reactivates it if it was exhausted.
- `cancel_subscription(id)`: owner-only, refunds the remaining balance.

Events: `SubscriptionCreated`, `DeliveryRecorded`, `ToppedUp`, `SubscriptionCancelled`.

Live on Casper testnet, package hash `f3710eaf12c30346eb1c642da832bc1af8ff900254c46bcc49a1efca81d8b971`.

### DemoDex (`src/demo_dex.rs`)

A minimal DeFi contract used to demonstrate Sluice matching real on-chain
contract events. Its non-payable `swap(...)` entry point emits a CES `Swap`
event, which the matcher picks up from the CSPR.cloud contract-events stream.

Live on Casper testnet, package hash `ffb5a95650e034784bb8c2f2a2bd03c814f8edf9a895b10d3edd4690e907b7b7`.

## Build

```
cargo odra build
```

Wasm files land in `wasm/`.

## Test

```
cargo test
```

## Deploy

Deployment runs through the Odra livenet CLI, not a cargo subcommand. See
[`../scripts/deploy-contract.sh`](../scripts/deploy-contract.sh) for the env
vars and the exact invocation (`cargo run --bin contract_cli -- deploy`).
