# Sluice — demo video script (re-record, honest build)

> Target length **~2:45** (max 3:00). Records the current, honest live product at
> [sluice.unitynodes.com](https://sluice.unitynodes.com). Replaces `demo-sluice.mp4`
> (2026-07-07), which pre-dates honesty rounds 11–14 and shows demo lanes as real
> escrow (`FUNDS LOCKED 230 CSPR`, `ACTIVE SUBS 6`). Those numbers no longer exist.

## Before you hit record

- **Cache-bust everything.** Record in a fresh **incognito** window (no stale layout).
  Reload each page once before rolling.
- **Verify the honest numbers on screen** match live before each take:
  - `FUNDS LOCKED · CSPR` = **~30** (only real lane `sub_0003`, owner `ecf442…7309`)
  - `ACTIVE SUBS` = **1**
  - `EVENTS DELIVERED` ≈ **11** (may tick up — that's fine, it's real)
  - `WEBHOOK HEALTH` = **100.0%**
  - Badge / header: `11 on-chain · 1 active`
  - Contract: `f3710e…b971`
- **1080p or higher**, hide bookmarks bar, clean browser profile, system theme light.
- Have `scripts/demo-swap.sh` ready in a terminal for the live-swap beat.

## 🚫 Hard honesty guardrails — never let a frame show

1. Any `FUNDS LOCKED` figure above **~30 CSPR**. The old 230 counted synthetic demo
   lanes as real escrow — that is the exact thing we fixed.
2. `ACTIVE SUBS` **6** *without* its `1 escrow-backed · 5 demo` breakdown. The honest
   live tile shows `6 / 7 TOTAL` **and** that breakdown (badge + subheader say `1 active`) —
   that is fine. The old video's sin was `6` with **no** breakdown next to `230 CSPR`.
3. A demo lane (`sub_0004/0005/0100/0200/…`, placeholder owner `aaaa…`) **without** its
   `DEMO` marker, or labelled `CONFIRMED`. Demo lanes are `DELIVERED`, never `CONFIRMED`.
4. Any delivery-count aggregate that silently folds demo deliveries into an
   "on-chain / escrow" total.

If a beat can't be shot without one of these, cut the beat. Honesty is the whole pitch.

---

## Shooting script

| # | Time | On screen (action) | Voiceover |
|---|------|--------------------|-----------|
| 1 | 0:00–0:15 | Landing hero at `/`. Slow scroll past the headline **"Stripe webhooks, but for Casper."** | "You're building an app or an AI agent on Casper, and you need to know the instant something happens on chain. Ethereum has Alchemy webhooks. Solana has Helius. Casper had nothing. Sluice fills that gap." |
| 2 | 0:15–0:35 | The landing page's **How it works** section (nav: "How it works") — its pipeline diagram: **Source → Matcher → Your webhook + On-chain receipt**. Let each stage land. | "Write a JSON rule. Prepay in CSPR into an on-chain escrow contract. Sluice watches the chain, and the instant a matching event lands it pushes it to your webhook — median under ~150 ms on testnet — and writes an auditable receipt back on chain." |
| 3 | 0:35–1:05 | Open `/app` (Subscriptions tab). Pan the stat bar — **FUNDS LOCKED 30 CSPR · ACTIVE SUBS 6 / 7 TOTAL (hover the `1 escrow-backed · 5 demo` subline) · EVENTS DELIVERED 11 · WEBHOOK HEALTH 100%**. Then the table: hover the real lane **`sub_0003`** (30 CSPR, `ecf442…7309`); then hover a **`DEMO`-marked** lane (tooltip: demo lanes POST but write no receipt). | "Here's the live dashboard. Six lanes active — but only one is escrow-backed: thirty CSPR locked, funded from a real wallet. The other five are clearly marked **DEMO**. They deliver real webhooks so you can watch the feed move, but they hold no escrow, so we never count them as locked funds or write a fake on-chain receipt. What you see is exactly what's on chain — nothing inflated." |
| 4 | 1:05–1:30 | `/app` → **Build** tab. Type into the AI parser: **`transfers over 1000 CSPR to dc7252…787c9c`**. The JSON predicate writes itself on the right (`amount gte` + `to_account_hash eq`); the sample-event tile flips to green **✓ MATCHES**. ⚠️ Use `over 1000 CSPR` (the sample event is 5000 CSPR, so it matches). Saying `100k CSPR` parses correctly but the sample would read **NO MATCH** — avoid on camera. | "You don't hand-write JSON. Describe the rule in plain English — 'transfers over a thousand CSPR to this address' — and the builder compiles it to a predicate right in the browser. Test it against a sample event: it matches." |
| 5 | 1:30–2:00 | Cut to a terminal. Run **`scripts/demo-swap.sh 500000 CSPR USDC`**. Cut back to `/app` (or `/feed`) live feed — a new delivery row lands: **`Contract · Swap @ ffb5a9… → 200 · ~80ms`**. ⚠️ Testnet finalization can take up to ~1–2 min — fire the swap slightly early and cut to the moment it lands; don't hold the wait on screen. (Verified live: real tx, delivery status 200, ~74 ms.) | "This isn't a mock. I'll fire a real swap on our DemoDex contract on testnet. The production matcher is watching it — swap transaction, to CSPR.cloud's stream, to a predicate match, to a webhook two-hundred — and there it is in the feed, a real matched event in seconds." |
| 6 | 2:00–2:25 | Show a real **`record_delivery`** deploy on **cspr.live** (`error: None`). Then the **x402** panel on `/app` (`Subscription 200 … 0.1 WCSPR`). ⚠️ **Do NOT do a live one-click x402 pull on camera** — the sub-200 buffer only fills from an event matching its predicate, and a cold click honestly shows *"no matched event available, nothing charged."* Narrate over the panel and reuse the old video's real on-chain micropayment footage (still valid), or pre-warm + confirm a settlement in rehearsal first. | "And the billing is real too. Every escrow-backed delivery is a deploy on Casper — your bill is an auditable ledger on cspr.live, not an invoice we made up. This lane is even paid per delivery over x402: each pull settles a point-one WCSPR micropayment through Casper's hosted facilitator, no wallet needed." |
| 7 | 2:25–2:40 | The landing **MCP** section (nav: "MCP" — "Any MCP client drives Sluice"), or the `/app` **"For AI agents"** card: one hosted URL, any MCP client. Optional: a Claude/Cursor client listing the Sluice tools. | "Casper's AI Toolkit lets an agent read chain state, act on it, and pay per request. The missing piece was **react**. Sluice ships as one hosted MCP URL — any agent installs it and gets matched events pushed in as tool calls." |
| 8 | 2:40–2:50 | Back to `/app` header: badge **`11 on-chain · 1 active`**, contract **`f3710e…b971 on cspr.live`**. End card: **sluice.unitynodes.com**. | "Live on Casper testnet today. One contract, one hosted MCP, honest on-chain numbers. Sluice — the react primitive for Casper." |

---

## Keep from the old video (still true, re-usable B-roll)

- The live **x402** on-chain micropayment settling on cspr.live.
- Genuine **`record_delivery`** deploys on cspr.live (`error: None`).
- The "Every delivery is a deploy on Casper" section — where demo lanes correctly show
  their `record_delivery` as **FAILED / no receipt** (that's the honest behaviour).
- Contract hash `f3710e…b971` (unchanged).

## If time is tight (60–90s cut)

Beats **1 → 3 → 5 → 6 → 8**: the problem, the honest dashboard, a real swap landing
live, on-chain proof, the close. Skip the AI builder (4) and MCP (7).
