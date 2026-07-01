# Sluice: CSPR.fans community pitch

> The top 3 community-voted projects skip judging. This is the copy to win those votes. Keep it useful, not spammy.

---

## The hook (2 sentences)

Casper's AI Toolkit lets agents query state, trade, and pay per call, but there was no way for an agent to *react* to what happens on chain. Sluice ships that missing piece: lock CSPR once, describe what you care about in plain English, and matching on-chain events get pushed to your webhook or AI agent in under a second.

---

## Why vote for us

- **We built the one primitive nobody else did.** Of 77 buildathon BUIDLs, zero others ship a push-based event service. Sluice is it.
- **It's live on testnet, not a mockup.** Contract, matcher, MCP servers, web app, CLI. You can subscribe right now and watch a real event land.
- **On-chain billing you can audit.** Every delivery calls `record_delivery` on-chain, so your bill is a ledger on cspr.live, not a number we made up.
- **It makes Casper the easy chain to build agents on.** From a multi-week indexer to one MCP install. That helps every other builder in the ecosystem, not just us.
- **It composes, it doesn't compete.** Sluice pairs with x402 (pay per delivery), CSPR.trade MCP (react then trade), and CSPR.cloud (the streaming source it reads from).

---

## The 30-second read

Sluice is Stripe webhooks for Casper. You write a rule as JSON or plain English, lock some CSPR in an on-chain escrow, and Sluice watches the chain for you. When a matching event lands, we push it three ways from one subscription: an HMAC-signed webhook, an MCP tool call your AI agent can act on, or a live WebSocket for dashboards. Median time from block to delivery is about 830 ms. Every delivery is receipted on-chain, so the escrow drains transparently and you can cancel for a refund any time. DeFi protocols use it for liquidation and yield-change alerts. RWA issuers use it for compliance-token revocation and oracle updates. It's the reaction layer autonomous agents were missing on Casper, and it's MIT-licensed end to end.

---

## Ready-to-post community messages

### For the Casper Discord

> Hey builders. We shipped Sluice for the Agentic Buildathon: push-based on-chain event subscriptions for Casper, the missing 4th primitive of the AI Toolkit (state, trades, and x402 were there, events weren't).
>
> Write a rule, lock CSPR in an on-chain escrow, and matching events get pushed to your webhook or straight into your AI agent via MCP in ~830 ms. Every delivery is receipted on-chain. Live on testnet now, MIT-licensed, no signup to try.
>
> Try it or read the code: https://sluice.unitynodes.com  ·  https://github.com/UnityNodes/Sluice
>
> If it's useful to you, a CSPR.fans vote would mean a lot.

### For the Casper Telegram

> Sluice is live on testnet: Stripe-style webhooks for Casper events. Lock CSPR once, get matched on-chain events pushed to your webhook, MCP agent, or a live WebSocket in under a second. Every delivery is written on-chain so billing is auditable.
>
> It's the event primitive the AI Toolkit was missing, and it's the only push-based event service in the whole buildathon. No signup to try: https://sluice.unitynodes.com
>
> A vote on CSPR.fans helps us skip to the final round. Thank you.

### Generic (Twitter/X reply, forum, Farcaster)

> Sluice ships the piece Casper agents were missing: the ability to *react* to on-chain events. Lock CSPR, describe what you want, get matches pushed to your webhook or AI agent in ~830 ms, each one receipted on-chain. Live on testnet, MIT-licensed. https://sluice.unitynodes.com

---

**Vote link:** *<paste your CSPR.fans project URL here>*

Made by Unity Nodes for the Casper Agentic Buildathon 2026.
