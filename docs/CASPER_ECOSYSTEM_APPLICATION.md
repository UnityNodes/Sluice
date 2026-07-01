# Sluice: Casper Ecosystem application

> Draft text for grant / ecosystem-listing applications. Single page, tuned for "where does this fit on the Casper roadmap".

---

## Project name
**Sluice**, the event primitive for Casper's AI Toolkit.

## One-liner
Push-based on-chain event subscriptions with native CSPR escrow, designed for autonomous AI agents and developer tooling.

## The gap Sluice fills

Casper's AI Toolkit ships three primitives today:

- **State queries**, Casper MCP Server, CSPR.cloud REST.
- **Trades**, CSPR.trade MCP.
- **Per-call payments**, x402.

The fourth was missing: **events**. An agent (or any backend) that wants to *react* to chain activity has to either poll, build its own indexer, or rely on the raw CSPR.cloud Streaming firehose. Sluice is the production envelope on top of that firehose: predicate filter + paid escrow + push delivery + idempotency + HMAC signatures + on-chain delivery receipts.

Of the **77** BUIDLs submitted to the Casper Agentic Buildathon 2026, zero ship this primitive. It is now live on testnet, MIT-licensed.

## What's live today

- **`SubscriptionRegistry` contract** (Odra 2.8, deployed at `contract-package-f3710eaf…b971`). Entry points: `create_subscription`, `record_delivery`, `top_up`, `cancel_subscription`. Events: `SubscriptionCreated`, `DeliveryRecorded`, `ToppedUp`, `SubscriptionCancelled`.
- **Off-chain matcher** (Node 20, TypeScript). Dual WS into CSPR.cloud Streaming, `transfers` and `contract-events`. Event-sourced subscription state. End-to-end latency: WS event → webhook 200 → `record_delivery` confirmed in **~ 830 ms**.
- **CLI**, `sluice subscribe / list / cancel`.
- **MCP server**, `claude mcp add-json sluice …`, four tools, real transcripts on the landing page.
- **Web**, landing + read-only dashboard + live event feed at `sluice.unitynodes.com`.
- **Receivers**, Discord, Telegram, GitHub Actions bridge templates in `examples/`.
- **Security**, `Idempotency-Key` per match, optional HMAC-SHA256 `X-Sluice-Signature` header, SSRF guard for webhook destinations.

## How it strengthens the Casper ecosystem

1. **Lowers the bar for "build something agentic on Casper."** An LLM agent integration goes from a multi-week indexer effort to one line: `claude mcp add-json sluice …`.
2. **Composes with the existing toolkit, doesn't compete.** Sluice complements x402 (we push, x402 pulls), uses CSPR.cloud as its source (not a replacement), uses Odra for the contract (canonical), and uses CSPR.click conventions where they apply.
3. **Generates more on-chain activity.** Every webhook delivery is a `record_delivery` deploy. As subscriptions scale, so does meaningful, fee-paying activity on Casper.
4. **MIT-licensed, easy to fork.** Operators can self-host their own matcher; the contract is the source of truth.

## Roadmap

- **v0.1, testnet** (done): Transfer events, CLI + MCP + dashboard, HMAC webhooks, replay endpoint, status badge.
- **v0.2, broader event coverage**: Deploy, Balance, Contract, derived events. Wallet-signed mutations from the dashboard (contract redesign to use TransactionV1's native `transferred_value`). OR/nested predicates. OpenAPI surface.
- **v0.3, production hardening**: matcher checkpointing + backfill (at-least-once delivery semantics), predicate sharding (`O(log N)` eval), bonded matcher pool so subscribers can demand independent operators.
- **mainnet**, production SLAs, volume pricing tiers, paid `gas_reimbursement` deducted per delivery so the matcher is fee-neutral.

## Honest v0.1 limitations

Verbatim from `docs/HONEST_LIMITS.md`. Ten caveats covering delivery semantics, gas subsidy, predicate scope, the casper-js-sdk v5 Stored-target serialization bug, the Odra `__cargo_purse` constraint that parks browser-wallet mutations to v0.2, and the v0.1 demo-mode `record_delivery` accessibility. Documented, not hidden.

## What we'd ask for

- **Listing on `casper.network/ai`** alongside other AI Toolkit components. We fit the catalogue.
- **A grant** to fund v0.2 contract redesign + browser-wallet mutations + production matcher hosting.
- **An introduction to operators / dapps that need events.** Sluice scales with usage; the bottleneck right now is exposure to projects that would actually subscribe.

## Repository & contacts

- Code · https://github.com/UnityNodes/Sluice (MIT)
- Live · https://sluice.unitynodes.com
- Contract · [`contract-package-f3710eaf…b971`](https://testnet.cspr.live/contract-package/f3710eaf12c30346eb1c642da832bc1af8ff900254c46bcc49a1efca81d8b971)
- Author · Oleksiy Andrienko ([@0xFearless-1](https://github.com/0xFearless-1))
- Built for · Casper Agentic Buildathon 2026
