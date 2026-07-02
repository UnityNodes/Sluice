# Sluice: launch thread for Twitter/X

> A 6-post launch thread. Each post is under 280 chars. Suggested media caption sits under each post. Swap the demo-video link before posting.

---

## Bio + handle suggestions

- **Handle:** `@SluiceHQ` or `@getsluice` (fallback: `@sluice_dev`)
- **Bio:** "Stripe webhooks, but for Casper. Push-based on-chain event subscriptions for agents and apps. The missing 4th primitive of the Casper AI Toolkit. Live on testnet. By @UnityNodes."

## Hashtag suggestions

`#Casper` `#CasperNetwork` `#AgenticAI` `#Web3Dev` `#DeFi`

---

## The thread

### 1/ (hook)

Casper's AI Toolkit lets agents query state, trade, and pay per call. But agents couldn't *react* to what happens on chain.

We fixed that.

Meet Sluice: push-based on-chain event subscriptions for Casper. Live on testnet.

A thread. 🧵

> Media: 10s screencast of `sluice subscribe` firing and a webhook landing. Caption: "block to webhook in ~830 ms."

### 2/ (what it is)

Sluice is Stripe webhooks, but for Casper.

Write a rule in JSON or plain English. Lock CSPR in an on-chain escrow. When a matching event lands, we push it to you in ~830 ms.

Every delivery is receipted on-chain, so your bill is an auditable ledger, not an invoice we made up.

> Media: the pipeline diagram (event to predicate to webhook to on-chain receipt). Caption: "one subscription, verifiable billing."

### 3/ (three channels)

One subscription, three ways to receive matches:

- HMAC-signed webhook for backends
- MCP tool call your AI agent can act on
- live WebSocket for dashboards

Pick per subscriber. No polling anywhere.

> Media: split screen of a webhook payload, a Claude Code MCP call, and a live dashboard. Caption: "one event, three destinations."

### 4/ (agentic)

This is the reaction layer autonomous agents were missing on Casper.

We shipped two example loops: an agentic yield router and a multi-agent DAO. Pattern each time: Sluice pushes the event, the agent decides, CSPR.trade executes, x402 meters the delivery.

Agents sleep until something happens.

> Media: sequence diagram of the agent loop. Caption: "event-driven, not poll-driven."

### 5/ (DeFi + RWA + x402)

Sluice is infrastructure other protocols build on.

DeFi: liquidation alerts, yield-change triggers, whale-swap monitoring.
RWA: compliance-token revocation, oracle updates.

Pairs natively with x402 for pay-per-delivery. It composes with the ecosystem, it doesn't compete.

> Media: two cards, one DeFi use case, one RWA use case. Caption: "react the instant chain state changes."

### 6/ (CTA)

As far as we can tell, we are the only push-based event service in the buildathon.

Live on testnet. MIT-licensed. No signup to try.

App: https://sluice.unitynodes.com/app
MCP demo: https://sluice.unitynodes.com/#mcp-demo
Code: https://github.com/UnityNodes/Sluice

Built by @UnityNodes. #Casper

> Media: the demo video (or the screencast loop if the video isn't ready). Caption: "try it in one minute."

---

Made by Unity Nodes for the Casper Agentic Buildathon 2026.
