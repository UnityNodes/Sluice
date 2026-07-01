# Sluice: DoraHacks BUIDL page

> Paste-ready copy for the DoraHacks BUIDL form. Swap the demo-video placeholder the day you record it. Everything else is final.

---

## Title (under 70 chars)

**Sluice: push-based on-chain event subscriptions for Casper agents**

## Tagline

Stripe webhooks, but for Casper. Lock CSPR once, get matched on-chain events pushed to your webhook or AI agent in under a second, every delivery receipted on-chain.

## Track

Casper Innovation Track.

## Tags

`Casper Network` `Agentic AI` `MCP` `x402` `webhooks` `event subscriptions` `Odra` `Rust` `TypeScript` `DeFi infrastructure` `RWA` `developer tooling`

---

## Short description (under 280 chars)

Sluice is the missing 4th primitive of the Casper AI Toolkit: events. Subscribe with a JSON predicate, lock CSPR in an on-chain escrow, and Sluice pushes matches to your webhook, MCP agent, or live WebSocket in ~830 ms. Every delivery is receipted on-chain.

---

## Long description

### The problem

The Casper AI Toolkit ships three primitives that let an agent *act* on chain:

1. **State queries** via the Casper MCP Server.
2. **Trades** via the CSPR.trade MCP.
3. **Pay-per-call** via x402.

The fourth one was missing: **events**. To *react* to chain activity, an agent has to poll, stand up its own indexer, or hand-roll a WebSocket consumer over the CSPR.cloud stream. That is a multi-week side quest before any real agent logic gets written. Of the 77 BUIDLs in this buildathon, zero others ship a push-based event service. Ethereum has Alchemy webhooks. Solana has Helius. Casper had nothing. Sluice fills that gap.

### The solution

You write a rule as a JSON predicate ("any transfer to my address over 5000 CSPR"). You lock CSPR into an on-chain escrow contract. Sluice watches the live chain, evaluates your predicate, and pushes every match to you in about 830 ms from the block landing. Each successful delivery calls `record_delivery` on-chain, so your bill is an auditable ledger on cspr.live, not a number we invent at month-end. Cancel any time and unused CSPR is refunded to your wallet.

### Three delivery channels from one subscription

One subscription, three ways to receive matches. Pick per subscriber, mix freely:

- **Webhook.** HMAC-signed HTTPS POST with an idempotency key. The classic integration for backends and bots.
- **MCP tool call.** Matches surface directly inside an AI agent (Claude Code, Codex, Continue) so the agent can read an event and act on it without any glue code.
- **Live WebSocket.** `/api/stream` feeds dashboards and front ends in real time, no polling.

### The agentic angle

Sluice is the reaction layer for autonomous agents on Casper. Two example agent loops ship in the repo:

- **agentic-yield-router (Build Direction #1).** An agent subscribes to yield-change and deposit events, and when one fires it rebalances capital across venues. Sluice is the trigger; CSPR.trade MCP is the execution; x402 meters the delivery.
- **multi-agent-dao (Build Direction #3).** Several agents coordinate around treasury and governance events. Sluice pushes the event that wakes the right agent, so agents sleep until something happens instead of burning cycles polling.

The pattern is the same each time: Sluice pushes the event, the agent decides, CSPR.trade or a contract call executes, x402 handles pay-per-delivery. Sluice is the piece that lets an agent be event-driven instead of poll-driven.

### DeFi and RWA applicability

Sluice is infrastructure other protocols build on:

- **DeFi.** Liquidation alerts, yield-change triggers, whale-swap monitoring, treasury deposit notifications. A lending protocol subscribes to collateral-price and position events and reacts before positions go underwater.
- **RWA.** Compliance-token revocation events, oracle-update triggers, transfer-restriction changes. An RWA issuer subscribes to revocation events and freezes downstream flows the moment a token's compliance status changes.

In both cases the value is the same: react to chain state the instant it changes, with an on-chain receipt proving you were notified.

### What's live today (v0.1, Casper testnet)

- [x] `SubscriptionRegistry` smart contract (Rust + Odra 2.8), deployed on testnet. Entry points: `create_subscription`, `record_delivery`, `top_up`, `cancel_subscription`. Events: `SubscriptionCreated`, `DeliveryRecorded`, `ToppedUp`, `SubscriptionCancelled`.
- [x] Off-chain matcher (TypeScript, Node 20) reading the live CSPR.cloud stream.
- [x] On-chain billing ledger: every successful webhook delivery calls `record_delivery`.
- [x] Median end-to-end latency ~830 ms (WS event to webhook 200 to `record_delivery` confirmed).
- [x] Three delivery channels: webhook, MCP tool call, live WebSocket (`/api/stream`).
- [x] MCP stdio server (`npm i -g @sluice/mcp`) and hosted Streamable-HTTP server. 5 tools, 4 resources, 2 prompts.
- [x] Predicate language: JSON, AND-of-conditions with nested OR groups and parens, 12 operators, plus a plain-English AI parser (rule-based, no LLM, under 5 ms).
- [x] HMAC-SHA256 webhook signatures and per-match idempotency keys.
- [x] Web workspace at `/app`: live subscription table, visual builder, sandbox that fires real webhooks, rolling activity feed.
- [x] MCP demo transcript at `/#mcp-demo`, every tx hash clickable into cspr.live.
- [x] CLI, self-host installer, Docker compose stack, Prometheus + Grafana, TypeScript and Python client libraries.

### Tech stack

- **Contract:** Rust + Casper Odra 2.8. `SubscriptionRegistry` holds the escrow and emits the four events.
- **Matcher:** Node 20 + TypeScript. Reads the CSPR.cloud streaming WebSocket, evaluates predicates, dispatches deliveries, records each one on-chain via a signed deploy.
- **MCP:** stdio server plus Streamable-HTTP server.
- **Web:** static HTML and vanilla JS. Landing, `/app` workspace, live feed, hosted receiver.
- **Source:** CSPR.cloud streaming. **Explorer:** cspr.live.

### Honest v0.1 limits

We document limits, we do not hide them.

- Casper testnet only. No mainnet contract yet.
- Predicates are AND at the top level with nested OR groups and parens. Depth limit 4, condition limit 32.
- Webhook retries: 3 attempts with exponential backoff. No dead-letter queue in v0.1.
- The recent-deliveries ring buffer is in-memory and live-only. If the matcher restarts, that in-memory history is gone. Full history is always in the contract events on cspr.live.
- No production SLAs. This is a buildathon submission running on a single VPS.
- Wallet-native subscribe from the browser waits on a v0.2 contract redesign around `TransactionV1`.

Full list in `docs/HONEST_LIMITS.md`.

### Roadmap teaser

Q3 2026: wallet-native subscribe via `TransactionV1`, historical replay, SSE, Rust SDK. Q4 2026: mainnet contract, volume pricing tiers, dead-letter queue, x402 metered tier. 2027: cross-contract predicates, timelocked subscriptions. Full plan in `docs/ROADMAP.md`.

---

## Links

- **GitHub:** https://github.com/UnityNodes/Sluice (MIT)
- **Live app:** https://sluice.unitynodes.com/app
- **Landing:** https://sluice.unitynodes.com
- **MCP demo:** https://sluice.unitynodes.com/#mcp-demo
- **Contract on cspr.live:** https://testnet.cspr.live/contract-package/f3710eaf12c30346eb1c642da832bc1af8ff900254c46bcc49a1efca81d8b971
- **Demo video:** *<paste link here once recorded>*

---

## How we meet each judging criterion

| Criterion | Concrete evidence |
| --- | --- |
| **Technical Execution** | Live testnet contract (Odra 2.8) plus TypeScript matcher, MCP servers, CLI, web app, client libraries, Docker stack, and Prometheus metrics. Median ~830 ms end-to-end, measured. On-chain `record_delivery` receipt for every delivery. |
| **Innovation & Originality** | The only push-based event service in the buildathon (0 of 77 others ship one). Named and fills the missing 4th primitive of the Casper AI Toolkit. |
| **Use of AI / Agentic Systems** | Two shipped agent loops (agentic-yield-router, multi-agent-dao). MCP delivery channel lets an agent receive an event and act without glue code. Plain-English predicate parser turns "whales over 100k CSPR" into JSON. |
| **Real-World Applicability (DeFi & RWA)** | DeFi: liquidation alerts, yield-change triggers, whale-swap monitoring. RWA: compliance-token revocation events, oracle-update triggers. Sluice is infrastructure protocols build on. |
| **UX & Design** | `/app` workspace: visual predicate builder, plain-English input, dry-run sandbox that fires real webhooks, click-to-explain on every delivery. No signup. |
| **Working Smart Contracts** | `SubscriptionRegistry` live on testnet with 4 entry points and 4 events. Contract is the source of truth for escrow and the billing ledger. Verifiable on cspr.live right now. |
| **Long-Term Launch Plans** | Roadmap through 2027 with a mainnet contract, volume pricing, x402 metered tier, and a business model (per-delivery CSPR escrow plus optional x402 tier; self-host free and open source). See `docs/ROADMAP.md`. |
| **Long-Term Impact** | Lowers "build agentic on Casper" from a multi-week indexer to one MCP install. Composes with x402, CSPR.trade, and CSPR.cloud rather than competing. Every active subscription is continuous fee-paying on-chain activity. |

---

Made by [Unity Nodes](https://unitynodes.com) for the Casper Agentic Buildathon 2026.
