# Sluice → Autonomous Yield-Routing Agent

Casper Agentic Buildathon, **Build Direction #1: Autonomous Yield-Routing Agents via MCP.**

A large CSPR transfer lands on a treasury/pool address you watch. Sluice detects it and pushes a signed webhook at this agent. The agent verifies the signature, checks a live yield condition (via the Casper AI Toolkit MCPs), and decides, on its own, whether to **rebalance** the new deposit into a higher-yield pool or **hold**. No polling, no cron: the chain event wakes the agent up.

```text
┌──────────────┐  large transfer   ┌─────────┐   webhook POST (HMAC-signed)   ┌──────────────┐
│ Casper chain │ ────────────────▶ │  Sluice │ ─────────────────────────────▶ │  this agent  │
│ (pool addr)  │                   │ matcher │                                │  agent.js    │
└──────────────┘                   └─────────┘                                └──────┬───────┘
                                                                                     │ verify sig
                                                                                     │ decideRebalance()
                                                    ┌────────────────────────────────┤
                                                    │                                │
                                       Casper MCP Server                    CSPR.trade MCP
                                     (read pool state)                (read APYs · route funds)
                                                    │                                │
                                                    └──────────────┬─────────────────┘
                                                                   ▼
                                                        REBALANCE  /  HOLD  (logged)
```

Sluice is the **events** primitive that completes Casper's AI Toolkit. The Casper MCP Server lets an agent *read* chain state; CSPR.trade lets it *act*. Neither one tells the agent *when* something happened on-chain, so today's agents poll. Sluice pushes the event the instant it's matched, turning a polling loop into a genuine event-driven agent.

## Setup

```bash
cd examples/agentic-yield-router
npm install
```

Then either run the one-command demo (below) or start the agent yourself:

```bash
# demo mode: no secret needed, no trades execute
node agent.js --dry-run

# production mode: signature enforced, MCP calls fire
export SLUICE_WEBHOOK_SECRET=$(openssl rand -hex 32)   # must match the matcher's secret
node agent.js
```

## Env vars

| Var                    | Required                | Default                              | Purpose                                                          |
| ---------------------- | ----------------------- | ------------------------------------ | --------------------------------------------------------------- |
| `SLUICE_WEBHOOK_SECRET`| yes (unless `--dry-run`)|, | Shared HMAC secret. The agent refuses to start unsigned so it can't be tricked into trading. |
| `PORT`                 | no                      | `8791`                               | Local port for the webhook receiver.                            |
| `LARGE_DEPOSIT_CSPR`   | no                      | `50000`                              | Deposit size (CSPR) that triggers a rebalance evaluation.       |
| `WATCHED_POOLS`        | no                      | *(all)*                              | Comma-separated account hashes the agent manages. Unset ⇒ every recipient is treated as a pool (handy for the synthetic sandbox demo). |
| `ANTHROPIC_API_KEY`    | no                      |, | Set it and the agent reasons with Claude; unset and it falls back to the deterministic heuristic (see [AI decisions](#ai-decisions)). |
| `SLUICE_AGENT_MODEL`   | no                      | `claude-sonnet-5`                    | Which Claude model `decideRebalance` calls. |

Flag: `--dry-run` skips HMAC enforcement and never executes a trade, it only logs the decision. Use it for local demos where you don't hold the secret.

## AI decisions

The rebalance verdict has two interchangeable paths behind one function, `decideRebalance(event)`:

- **With `ANTHROPIC_API_KEY` set** the agent reasons with **Claude (Sonnet 5, prompt-cached)**. It reads the live pool APYs (via the CSPR.trade MCP) and the deposit details, then asks the model for a strict JSON verdict, `{"action":"REBALANCE|HOLD|IGNORE","reason":"..."}`. The shared `askClaude(system, user)` helper adds `cache_control: { type: 'ephemeral' }` to the system prompt so repeated events reuse the cached persona (a Claude API best practice). Set `SLUICE_AGENT_MODEL` to pick a different model.
- **Without a key**, or on any parse/enum failure, the agent logs `[agent] LLM unavailable, using heuristic` and falls back to the **deterministic heuristic** (`decideRebalanceHeuristic`, the same threshold policy described below). This keeps the whole demo runnable offline with zero credentials.

Every decision logs which path produced it: `decided by: claude-sonnet-5` vs `decided by: heuristic`.

```bash
# heuristic (offline, no key)
node agent.js --dry-run

# real model
export ANTHROPIC_API_KEY=sk-ant-…
node agent.js --dry-run
```

## One-command demo

```bash
bash demo.sh
```

`demo.sh` boots the agent in `--dry-run`, waits for `/health`, then fires **3 demo events** at it and you watch the agent verify → decide → log for each one.

Which path it uses depends on reachability. Set `PUBLIC_WEBHOOK_URL` to a publicly reachable `/webhook` and it goes through Sluice's sandbox dispatch (`POST /api/sandbox/dispatch`), the real delivery path, at **zero on-chain cost**. Leave it unset and the script signs the same envelopes locally and posts them straight to the agent, because Sluice's SSRF guard correctly refuses to dispatch to loopback. Both paths exercise the same HMAC verification.

> The sandbox has to be able to reach your `/webhook`. On a laptop, expose it first (`ngrok http 8791` or a Cloudflare Tunnel) and set `PUBLIC_WEBHOOK_URL=https://<your-tunnel>/webhook` before running `demo.sh`.

## How it works

1. **Sluice matches** a Transfer event against your subscription's predicate (e.g. `amount >= 50,000 CSPR to a watched pool`) and POSTs a JSON webhook:

   ```json
   {
     "subscription_id": 7,
     "event": {
       "amount": "75000000000000",
       "to_account_hash": "dc7252…",
       "initiator_account_hash": "b383c7…",
       "deploy_hash": "c60a4b…",
       "block_height": 8338998,
       "timestamp": "2026-06-29T11:14:49.671Z"
     },
     "delivered_at": "2026-06-29T11:15:00.470Z"
   }
   ```

   with headers `X-Sluice-Signature: sha256=<hex>`, `X-Sluice-Idempotency-Key`, and `X-Sluice-Sub-Id`.

2. **The agent verifies** the signature before doing anything else. `X-Sluice-Signature` is `sha256=` + HMAC-SHA256 of the *raw* body under the shared secret. `agent.js` reads the exact bytes (`express.raw`), recomputes the HMAC, and compares in constant time (`crypto.timingSafeEqual`). A bad or missing signature is `401`'d in production mode, the trade path can never run on an unverified event.

3. **`decideRebalance(event)`** produces the verdict. With `ANTHROPIC_API_KEY` set it asks **Claude** (grounded in the live pool APYs) for a strict JSON `{action, reason}`; without a key it uses the deterministic heuristic (see [AI decisions](#ai-decisions)). Either way the policy is the same, small, auditable one:
   - recipient not in `WATCHED_POOLS` → **IGNORE**
   - amount below `LARGE_DEPOSIT_CSPR` → **HOLD** (noise, not worth a trade)
   - large deposit → confirm the deposit landed via the **Casper MCP Server**, read live pool APYs via the **CSPR.trade MCP**, and if a pool beats the current one by ≥ 1 APY point → **REBALANCE**, else **HOLD**.

4. **The agent acts.** On `REBALANCE` it calls the CSPR.trade MCP execution tool to route the deposit (skipped in `--dry-run`). Every outcome is logged as one structured JSON line, decision, reason, amount, deploy hash, and whether the event was signature-verified.

Amounts are motes strings; 1 CSPR = 1,000,000,000 motes. The agent does all comparisons in `BigInt` motes and only converts to CSPR for logging.

## Wiring the real CSPR.trade MCP

Everything that touches the network is stubbed and **clearly labelled** so the example runs with zero credentials and never touches mainnet. There are three seams in `agent.js`, each a single function:

- **`getPoolStateViaCasperMcp(poolHash)`**, replace the stub body with a call to the Casper MCP Server's balance/state tool. Use it to confirm the deposit actually landed and read current pool depth *before* sizing a trade (don't trust the webhook amount alone).

  ```js
  return await casperMcp.callTool('get_account_balance', { account_hash: poolHash });
  ```

- **`getPoolYieldsViaCsprTradeMcp()`**, replace with the CSPR.trade MCP's quote/APY tool to pull live yields for the pools you route between.

  ```js
  return await csprTradeMcp.callTool('list_pool_yields', { asset: 'CSPR' });
  ```

- **`executeRebalanceViaCsprTradeMcp(plan)`**, the **only** place that moves funds. Replace with the CSPR.trade MCP's swap/route tool. It's guarded twice: it never runs in `--dry-run`, and it's downstream of the signature check, so it can't fire on an unverified event.

  ```js
  return await csprTradeMcp.callTool('route_funds', {
    from: plan.fromPool, to: plan.toPool, amount_motes: plan.amountMotes,
  });
  ```

Point your MCP client at the Casper MCP Server and CSPR.trade MCP, drop the three real calls in, remove the `STUB` returns, and the same loop rebalances real funds, triggered entirely by Sluice's on-chain events.

## Files

| File          | What it is                                                                 |
| ------------- | ------------------------------------------------------------------------- |
| `agent.js`    | Webhook server: HMAC verify → `decideRebalance` → log/act. Exports the policy for unit testing. |
| `demo.sh`     | Boots the agent and fires 3 sandbox events at it end-to-end.               |
| `package.json`| `express` + `@anthropic-ai/sdk` dependencies; `start` / `dry-run` / `demo` scripts. |
