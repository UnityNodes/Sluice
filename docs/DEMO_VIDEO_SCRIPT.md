# Sluice demo video script

A tight 90-second walkthrough for the Casper Agentic Buildathon submission. Records in one screen-capture pass. Every URL and command below is real and works today against the live testnet contract.

Target length: **90 seconds**. Hard cap: 2 minutes (DoraHacks accepts up to a few minutes, but shorter holds attention).

Tools to record with: any screen recorder (OBS, QuickTime, Loom). 1920x1080. Record the browser at 100% zoom, terminal at a readable font size (16pt+).

---

## Shot list

### 0:00 to 0:10, The hook (landing hero)

**Screen:** https://sluice.unitynodes.com , top of the hero.

**Narration:**
> "On Ethereum you have Alchemy webhooks. On Solana you have Helius. On Casper, there was nothing. Sluice is the missing piece: on-chain events, pushed to you the moment they land."

**Action:** Let the hero sit for a beat so the headline "Casper events, the moment they land." reads. The live-feed terminal on the right is cycling demo deliveries with WEBHOOK / MCP / WEBSOCKET tags.

---

### 0:10 to 0:25, Plain-English to predicate (hero AI parser)

**Screen:** Scroll to the hero AI box (or it is already visible).

**Narration:**
> "You describe what you want to watch in plain English. No query language to learn."

**Action:** Click the input, type: `whales over 100k cspr`. Click Parse. The predicate JSON appears, then the dry-run line fills in: "X of 25 events matched, about N per day," with a few real sample events underneath.

**Narration (over the dry-run):**
> "It compiles to a JSON predicate and dry-runs against real recent testnet events, so you know it works before you spend anything."

---

### 0:25 to 0:45, Subscribe from the CLI (real on-chain tx)

**Screen:** A terminal.

**Narration:**
> "Lock CSPR once, point it at your webhook, and you have a subscription."

**Action:** Run (pre-typed, just hit enter):
```bash
sluice subscribe \
  --predicate ./examples/whale-transfers.json \
  --webhook https://webhook.site/<your-uuid> \
  --amount 10 --watch
```
Let it print the tx hash and "subscription id". Cut to the webhook.site tab. When a matching transfer lands on testnet, the POST appears in webhook.site with the `X-Sluice-Signature` HMAC header visible.

**Narration (over the webhook landing):**
> "There it is. A signed webhook, under a second from when the block landed. And every delivery is recorded on-chain by the contract itself, so your bill is an auditable ledger, not an invoice we made up."

**Action:** Quick cut to cspr.live showing the contract's DeliveryRecorded events.

---

### 0:45 to 1:05, The agentic angle (MCP in Claude Code)

**Screen:** Claude Code (or Codex) terminal.

**Narration:**
> "But the real point is agents. One line adds Sluice to Claude Code."

**Action:** Show the command already run: `claude mcp add --transport http sluice https://sluice.unitynodes.com/mcp`. Then type a prompt:
> "Show me the last 10 Sluice deliveries and tell me which subscription is busiest."

Claude calls `recent_deliveries`, reads `sluice://subs`, and answers in natural language.

**Narration:**
> "Now your agent can react to anything on chain. A large deposit hits a pool, Sluice fires the event, and an autonomous yield-router checks the APY through the CSPR.trade MCP and rebalances. That whole loop ships as an example in the repo."

**Action:** Quick cut to `examples/agentic-yield-router/` running `./demo.sh`, showing the REBALANCE decision log.

---

### 1:05 to 1:20, Three channels, one subscription (quick montage)

**Screen:** Split or quick cuts.

**Narration:**
> "One subscription, three ways to receive it: a webhook for your server, an MCP tool call for your agent, a live WebSocket for your dashboard. Plus a full workspace: a visual builder, a sandbox that fires real webhooks with zero CSPR, and click-to-explain on every delivery."

**Action:** Fast cuts: the /app subscriptions table, the sandbox firing, clicking a delivery row to open the explain modal with the green-checkmark condition trace.

---

### 1:20 to 1:30, Close

**Screen:** Back to the landing hero, or a clean end card.

**Narration:**
> "Sluice. The event primitive for Casper's AI Toolkit. Live on testnet, open source, MIT. Try it in sixty seconds, no wallet needed, at sluice dot unitynodes dot com."

**End card text:**
```
SLUICE
Casper events, the moment they land.

sluice.unitynodes.com
github.com/UnityNodes/Sluice
Casper Agentic Buildathon 2026
```

---

## B-roll and fallback assets (already in the repo)

If you cannot capture a live testnet match during recording, use these existing assets, all real:

- **Animated pipeline diagram:** https://sluice.unitynodes.com/pipeline.svg (source events, matcher, webhook, on-chain receipt, with a travelling pulse).
- **Animated CLI screencast:** https://sluice.unitynodes.com/screencast.svg (an 18-second loop of the exact `sluice subscribe` session, tx hashes match cspr.live).
- **MCP transcript:** the "Watch the agent" section on the landing page is a real recorded session.
- **The demo stack:** `SLUICE_CSPR_CLOUD_TOKEN=... ./scripts/demo.sh up` boots the whole thing locally if you want to record without touching production.

## Recording checklist

- [ ] Browser at 100% zoom, no bookmarks bar, clean profile.
- [ ] Terminal font 16pt or larger, dark theme.
- [ ] Pre-type every command so there is no live typing lag.
- [ ] Have a funded testnet key ready (faucet: https://testnet.cspr.live/tools/faucet).
- [ ] Have a webhook.site tab open before you start.
- [ ] Record audio separately if possible, then sync. Cleaner than mic-over-capture.
- [ ] Export 1080p, upload to YouTube (unlisted is fine), paste the link into `docs/DORAHACKS_SUBMISSION.md` and the DoraHacks BUIDL form.

## One-line description for the video upload

> Sluice pushes matching Casper on-chain events to your webhook, your AI agent via MCP, or your dashboard via WebSocket, in about 830 ms. Live on testnet. Built for the Casper Agentic Buildathon 2026.
