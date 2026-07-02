# Sluice: Architecture

## Components

```
┌────────────────────┐    ┌────────────────────────────────────┐    ┌─────────────────────────┐
│  Subscriber (CLI   │    │ SubscriptionRegistry contract      │    │  Subscriber's app /     │
│  or AI agent via   │    │ on Casper testnet (Odra 2.8)       │    │  webhook endpoint       │
│  MCP)              │    │                                    │    │                         │
│                    │    │  • create_subscription (payable)   │    │  POST { event, sub_id } │
│  sluice subscribe──┼───▶│  • record_delivery                 │    │  Idempotency-Key: <hash>│
│  sluice-mcp        │    │  • cancel_subscription             │    └────────▲────────────────┘
└────────────────────┘    │  • top_up (payable)                │             │
                          └───────────┬────────────────────────┘             │
                                      │ state reads                          │
                                      │ + record_delivery txs                │
                                      │                                      │
            ┌─────────────────────────▼─────────────────────────────────────┐│
            │  Matcher (Node 20, stateless except for in-mem subs cache)    ││
            │                                                               ││
            │   1. WS  wss://streaming.testnet.cspr.cloud/transfers ◀───┐   ││
            │      (every Transfer event, env { action, data, … })     │   ││
            │   2. for each event, eval against every active sub       │   ││
            │      (AND plus nested OR, 12 ops, dot.notation field access)   │   ││
            │   3. on match → POST webhook (retries, SSRF-guarded) ────┼───┼┘
            │   4. then → record_delivery(id, event_hash) on-chain     │   │
            │   5. periodically reload active subs from contract state │   │
            └──────────────────────────────────────────────────────────┘   │
                                                                           │
                                  ┌────────────────────────────────────┐   │
                                  │ Casper testnet                     │◀──┘ confirmations
                                  │  (CSPR.cloud Streaming + Node)     │
                                  └────────────────────────────────────┘
```

## Why off-chain matcher, on-chain contract?

The contract is the *trust anchor*, it stores the predicate and webhook URL declared by the subscriber, plus the escrowed balance. Anyone can verify the same predicate produced the same delivery count, and the subscriber can audit (or cancel + refund) on-chain.

The matcher is the *execution engine*. WebSocket parsing, predicate evaluation, retry policy, SSRF, all of this is fast, cheap, and gas-free off-chain. Only the *outcome* (a delivery happened) is posted back on-chain via `record_delivery`, gating the balance decrement.

## Idempotency

`Idempotency-Key = sha256(deploy_hash || transfer_id || amount || to_account_hash)`. Stable per Transfer regardless of how many retries fire. Subscribers dedupe by header.

## Subscription lifecycle

```
            create_subscription                cancel_subscription
              (locks CSPR)                       (refunds, deactivates)
   start ───────────▶ active ─────────────────────▶ end
                      │  ▲                          ▲
                      │  │ top_up                   │
                      │  │                          │
                      ▼  │     balance < cost       │
                      depleted (active=false) ──────┘
                              │
                              │ top_up (reactivates)
                              ▼
                            active
```

`record_delivery` flips `active=false` automatically when balance drops below the unit cost, protects subscribers from over-billing if the matcher races a depletion.

## What's NOT in v0.1

- Matcher cursor / backfill (at-most-once on matcher restart). Phase 2.
- `gas_reimbursement` field deducted from subscriber's escrow per `record_delivery`. Phase 2.
- Predicate sharding (current eval is O(N_subscriptions) per event). Phase 3.
- Broader event coverage beyond native Transfer and CES contract events (Deploy, Balance, NFT, derived validator-skip). Phase 2.
- Restricted `record_delivery` (currently anyone-callable for demo). Phase 2.

See [HONEST_LIMITS.md](./HONEST_LIMITS.md) for the full list of v0.1 limits.
