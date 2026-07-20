# Sluice: roadmap, business model, and grant framing

> Where Sluice goes from a testnet v0.1 to a mainnet service, how it pays for itself, and what a grant would fund. Honest about what's shipped and what isn't.

---

## Current status: v0.1 (Casper testnet)

Live today on testnet:

- `SubscriptionRegistry` smart contract (Rust + Odra 2.8). Entry points `create_subscription`, `record_delivery`, `top_up`, `cancel_subscription`. Events `SubscriptionCreated`, `DeliveryRecorded`, `ToppedUp`, `SubscriptionCancelled`.
- Off-chain matcher (TypeScript, Node 20) reading the live CSPR.cloud stream.
- Three delivery channels from one subscription: HMAC-signed webhook, MCP tool call, live WebSocket (`/api/stream`).
- MCP stdio server (5 tools) and hosted Streamable-HTTP server (2 read-only tools; signing tools stay local). Both expose 4 resources and 2 prompts.
- Predicate language: JSON, AND-of-conditions with nested OR groups and parens, 12 operators, plain-English AI parser (rule-based, no LLM, under 5 ms).
- On-chain billing: every successful delivery calls `record_delivery`. Median end-to-end ~140 ms on testnet (block timestamp to webhook delivery).
- Web workspace, CLI, self-host installer, Docker stack, Prometheus + Grafana, TypeScript and Python client libraries.

Honest limits: testnet only, no dead-letter queue, in-memory delivery ring buffer, no production SLAs, wallet-native subscribe not yet wired. Full list in `docs/HONEST_LIMITS.md`.

---

## Q3 2026

Close the gaps that block a smooth developer experience.

- **Wallet-native subscribe via `TransactionV1`.** Contract redesign so a subscriber can create and top up a subscription from a browser wallet, no CLI or PEM key required.
- **Historical replay.** Backfill matches from CSPR.cloud so a new subscription can be seeded against past events, and so a matcher restart no longer drops recent history.
- **SSE delivery channel.** Server-Sent Events as a lighter alternative to the WebSocket stream for front ends behind restrictive proxies.
- **Rust SDK.** First-class client for Rust services and on-chain-adjacent tooling, alongside the existing TypeScript and Python clients.

---

## Q4 2026

Go to mainnet and make the economics real.

- **Mainnet contract.** Production deployment of `SubscriptionRegistry` with the redesigned `TransactionV1` flow.
- **Free tier for entry.** A no-cost daily allowance of deliveries so developers can build against mainnet before paying anything, the way Alchemy and Helius win adoption. Self-host stays free and open source; prepaid escrow is only the hosted, high-volume path.
- **Volume pricing tiers.** Per-delivery escrow rate that steps down as monthly volume grows, so high-throughput protocols pay less per event.
- **Dead-letter queue.** Failed deliveries after retry exhaustion land in a durable queue with a replay endpoint, so no match is silently lost.
- **x402 metered tier.** An optional pay-per-delivery path via x402 for callers who prefer metered billing over prepaid CSPR escrow.

---

## 2027

Extend the predicate engine and the trust model.

- **Cross-contract predicates.** Match on arbitrary contract events, not just transfers, so DeFi and RWA protocols can subscribe to their own domain events.
- **Timelocked subscriptions.** Subscriptions that activate or expire at a block height or timestamp, for scheduled and campaign-bounded monitoring.

---

## Business model

- **Testnet: free.** No charge to try, subscribe, or self-host against testnet.
- **Mainnet: per-delivery CSPR escrow.** Lock CSPR up front, each successful delivery deducts a small per-delivery fee via `record_delivery`. Transparent, auditable on cspr.live, and refundable on cancel. Volume tiers reduce the per-delivery rate as usage grows.
- **Optional x402 metered tier.** Callers who prefer metered pay-per-delivery can route billing through x402 instead of prepaid escrow.
- **Self-host: free and open source.** The full stack is MIT-licensed. Operators can run their own matcher against the same contract. The contract is the source of truth, so a self-hosted matcher is a first-class citizen, not a downgrade.

The hosted service earns per-delivery. Self-hosting keeps the ecosystem honest and gives large operators an escape hatch. Both paths generate on-chain `record_delivery` activity on Casper.

---

## Grant ask and milestones

We are seeking a grant to fund the path from testnet v0.1 to a production mainnet service. Rough scope below.

- **Milestone 1: Wallet-native subscribe (4-6 weeks).** Redesign the contract around `TransactionV1`, wire browser-wallet subscribe and top-up in `/app`, ship the flow to testnet with tests. Deliverable: a subscriber can create and fund a subscription end to end from a wallet, no CLI.
- **Milestone 2: Durability and replay (3-4 weeks).** Historical replay from CSPR.cloud, matcher checkpointing so restarts don't drop history, and a dead-letter queue with a replay endpoint. Deliverable: no delivery is silently lost, and new subscriptions can be seeded against past events.
- **Milestone 3: Mainnet launch (4-6 weeks).** Deploy `SubscriptionRegistry` to mainnet, ship volume pricing tiers, and stand up production hosting with monitoring and SLAs. Deliverable: a paying mainnet service with published uptime.
- **Milestone 4: x402 metered tier and cross-contract predicates (5-7 weeks).** Optional x402 pay-per-delivery path and predicate matching on arbitrary contract events. Deliverable: DeFi and RWA protocols can subscribe to their own domain events and pay per delivery.

Grant funds cover the contract redesign, production matcher hosting, and audit-readiness work.

---

## Why this matters for Casper

Sluice lowers the bar for building agentic and event-driven apps on Casper from a multi-week indexer project to a single MCP install. It is the reaction layer the AI Toolkit was missing, and it composes with the rest of the toolkit instead of competing: it reads from CSPR.cloud, pairs with x402 for pay-per-delivery, and hands events to CSPR.trade-driven agents. Every active subscription is a continuous stream of fee-paying `record_delivery` transactions, so the service scales on-chain usage as it grows. Casper gets the primitive that makes it the easy chain to build autonomous, event-driven systems on, and DeFi and RWA protocols get production infrastructure for liquidation alerts, yield triggers, compliance revocations, and oracle updates.

---

Made by Unity Nodes for the Casper Agentic Buildathon 2026.
