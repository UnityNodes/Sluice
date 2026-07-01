# examples/

Runnable integrations and predicate fixtures for Sluice.

## Agent loops (Casper Agentic Buildathon)

| Directory | What it shows |
|---|---|
| [`agentic-yield-router/`](agentic-yield-router/) | Build Direction 1. A Sluice event triggers an autonomous agent that checks pool APY via the CSPR.trade MCP and decides to rebalance. `./demo.sh` runs the whole loop. |
| [`multi-agent-dao/`](multi-agent-dao/) | Build Direction 3. Sluice fans a treasury event out to Risk, Treasury, and Legal agents that deliberate concurrently, then a coordinator tallies and executes. |
| [`x402-metered-delivery/`](x402-metered-delivery/) | Pay-per-delivery with x402. A webhook receiver that answers 402 Payment Required and only processes deliveries carrying a valid x402 payment. See also [`docs/X402_INTEGRATION.md`](../docs/X402_INTEGRATION.md). |

## Bots and CI

| Directory | What it shows |
|---|---|
| [`discord-bot/`](discord-bot/) | `/sluice-watch` slash command wires up a subscription and posts matched transfers to a channel. |
| [`discord-bridge/`](discord-bridge/), [`telegram-bridge/`](telegram-bridge/) | Minimal webhook-to-chat bridges. |
| [`github-action/`](github-action/) | Fail a CI job when a watched on-chain condition fires. |

## Predicate fixtures

## whale-transfers.json
Matches every Transfer with `amount >= 10 000 CSPR` (10,000 · 10⁹ motes). Drop-in for `sluice subscribe --predicate examples/whale-transfers.json`.

## transfer-event.json *(generated on Day 0)*
A real CSPR.cloud Streaming Transfer event captured by `scripts/dump-ws-sample.js`. Used as a ground-truth fixture for predicate tests; do **not** edit by hand.

## Predicate shape

```json
{
  "and": [
    { "field": "to_account_hash", "op": "eq",  "value": "<account hash hex>" },
    { "field": "amount",          "op": "gt",  "value": "1000000000" }
  ]
}
```

Operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`. Numeric strings compare as bigints; everything else compares as strings. Field paths support dot-notation (e.g. `extra.tag`).
