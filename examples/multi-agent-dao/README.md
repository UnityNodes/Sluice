# Sluice → Multi-Agent DAO example

**Casper Agentic Buildathon, Build Direction #3: Multi-Agent DAO Governance & Execution.**

A large treasury movement lands on-chain. Sluice matches it and pushes it to one webhook. That single push is the *trigger* that wakes up a swarm of specialized agents, a **Risk Agent**, a **Treasury Agent**, and a **Legal Agent**, who each form an independent opinion at the same time. A coordinator tallies the votes and, if quorum is met, would execute the decision on-chain.

Sluice is the missing piece that turns a passive chain event into *autonomous, multi-party deliberation*: no polling loop, no block-scanning cron, no glue. One matched event, one webhook, one swarm.

```text
                                       ┌──────────────────┐
  on-chain treasury movement           │   Risk Agent     │  "1M+ CSPR → reject"
        (governance trigger)      ┌────▶│  (LLM opinion)   │──┐
              │                   │     └──────────────────┘  │
              ▼                   │     ┌──────────────────┐  │
        ┌───────────┐   webhook   │     │  Treasury Agent  │  │  votes
        │  Sluice   │─────────────┼────▶│  (LLM opinion)   │──┤ approve /
        │  matcher  │  POST /hook  │     └──────────────────┘  │ reject /
        └───────────┘  HMAC-signed│     ┌──────────────────┐  │ abstain
                                   │     │  Legal Agent     │  │
                                   └────▶│  (LLM opinion)   │──┘
                                         └──────────────────┘  │
                                                               ▼
                                              ┌────────────────────────────┐
                                              │        coordinator         │
                                              │  tally: approve >= quorum?  │
                                              │   ✅ execute   ⛔ reject     │
                                              └────────────────────────────┘
```

The three agents run **concurrently** (`Promise.all`), the swarm deliberates in parallel, not in a chain, and the coordinator decides by simple majority: **approve if ≥ 2 of 3 agents approve**.

## Setup

```bash
cd examples/multi-agent-dao
npm install
```

Env:

```bash
export SLUICE_WEBHOOK_SECRET=$(openssl rand -hex 32)   # shared HMAC secret (matches your Sluice subscription)
export PORT=8790                                        # optional, default 8790
export QUORUM=2                                         # optional, approve votes needed to pass
# optional, turns the agents into REAL Claude reasoners (see "AI decisions"):
export ANTHROPIC_API_KEY=sk-ant-…                       # unset ⇒ deterministic heuristic fallback
export SLUICE_AGENT_MODEL=claude-sonnet-5               # optional, this is the default
# optional, enables the real Sluice sandbox path instead of local delivery:
export PUBLIC_WEBHOOK_URL=https://your-coordinator.example.com/webhook
export SLUICE_API_URL=https://sluice.unitynodes.com/api # optional, this is the default
```

## Run the demo (one command)

```bash
./demo.sh
```

This starts the coordinator, fires **three** governance triggers, and prints the full swarm deliberation for each, a 500k CSPR inflow (passes), a 5M CSPR inflow (Risk rejects → fails), and a routine 25k CSPR inflow (passes). A judge sees the whole thing scroll by in one command.

You'll see, per event:

```text
╔──────────────────────────────────────────────────────────────────╗
  GOVERNANCE TRIGGER received from Sluice 🔒 verified
  proposal: 500000 CSPR treasury movement
    from account-hash-p…0000  →  to account-hash-d…0000
    deploy deploy-17515…9231  block 3500000  sub_42
  ──────────────────────────────────────────────────────────────────
  swarm deliberation (concurrent):
    ✅ Risk Agent      500000 CSPR is large but within the 100k, 1M managed band; monitored approval.
    ✅ Treasury Agent  Inflow of 500000 CSPR materially strengthens runway; accept.
    ✅ Legal Agent     No counterparty flags; below mandatory-reporting threshold.
  ──────────────────────────────────────────────────────────────────
  tally: 3 approve · 0 reject · 0 abstain  (quorum 2)
  DECISION: ✅ PASSED, executing
╚──────────────────────────────────────────────────────────────────╝
  ↳ EXECUTE: enacting proposal deploy-1751…9231, would submit on-chain deploy here (stubbed).
```

### Sandbox vs local delivery

- **Local (default):** if `PUBLIC_WEBHOOK_URL` is unset, `demo.sh` signs each event with `SLUICE_WEBHOOK_SECRET` and POSTs it straight at the coordinator, so the demo works fully offline with no tunnel. The signatures are real, so HMAC verification exercises the same code path production would.
- **Real sandbox:** set `PUBLIC_WEBHOOK_URL` to a public https URL (ngrok / Cloudflare Tunnel) and `demo.sh` calls Sluice's `POST /api/sandbox/dispatch` instead. The matcher fires HMAC-signed demo events at your URL exactly like production. **No CSPR spent.**

You can also fire one by hand:

```bash
curl -X POST https://sluice.unitynodes.com/api/sandbox/dispatch \
  -H 'content-type: application/json' \
  -d '{
    "webhook": "https://your-coordinator.example.com/webhook",
    "predicate": { "and": [ { "field": "amount", "op": "gte", "value": "50000000000000" } ] },
    "count": 3
  }'
```

## How it works

1. **The trigger.** You subscribe with Sluice to the events that should convene the DAO, e.g. any transfer into the treasury account of ≥ 50,000 CSPR (`predicate: { and: [{ field: "amount", op: "gte", value: "50000000000000" }] }`; amounts are in **motes**, 1 CSPR = 1,000,000,000 motes). When a matching deploy is finalized, Sluice POSTs the event to your coordinator.

2. **The webhook.** `coordinator.js` receives:

   ```json
   {
     "subscription_id": 42,
     "event": {
       "amount": "500000000000000",
       "to_account_hash": "account-hash-…",
       "initiator_account_hash": "account-hash-…",
       "deploy_hash": "…",
       "block_height": 3500000,
       "timestamp": "2026-07-01T12:00:00Z"
     },
     "delivered_at": "2026-07-01T12:00:01Z"
   }
   ```

   with headers `X-Sluice-Signature: sha256=<hex>` (HMAC-SHA256 of the raw body), `X-Sluice-Idempotency-Key`, and `X-Sluice-Sub-Id`.

3. **HMAC verification.** The `sluiceWebhook(secret)` middleware in `coordinator.js` buffers the raw request bytes, recomputes `sha256=` + HMAC-SHA256(body, secret), and compares it against `X-Sluice-Signature` in **constant time** (`crypto.timingSafeEqual`). Mismatch → `401`. If no secret is configured it still parses the body but flags the delivery `unsigned`. (This is the same scheme as `@sluice/client`'s `sluiceExpress` middleware, inlined here so the example runs standalone.)

4. **Fan-out & deliberation.** The coordinator normalizes the event into a `proposal` and calls all three agents with `Promise.all`. Each returns `{ vote, reason }`.

5. **Tally & execute.** Approve if `approve >= QUORUM` (default 2). On pass, `execute()` runs, the seam where you'd build and sign a Casper deploy to enact the decision (left as a log to avoid accidental spend). The coordinator returns `200` **before** deliberating so Sluice never waits on agent latency.

## The agents

| Agent | Role | Heuristic fallback |
| --- | --- | --- |
| **Risk Agent** | blast-radius / exposure officer | rejects ≥ 1M CSPR, approves smaller |
| **Treasury Agent** | runway / reserves manager | approves inflows, abstains on zero |
| **Legal Agent** | sanctions / KYC / compliance counsel | rejects blocklisted counterparties, abstains ≥ 1M pending disclosure |

Each agent votes `{ vote, reason }`; the coordinator and tally never care how the vote was produced.

## AI decisions

Every agent has two interchangeable paths behind the same `{ vote, reason }` contract:

- **With `ANTHROPIC_API_KEY` set** each agent reasons with **Claude (Sonnet 5, prompt-cached)**. A shared `askClaude(system, user)` helper in `coordinator.js` sends the agent's persona as the system prompt, with `cache_control: { type: 'ephemeral' }` so the persona is reused from the prompt cache across events (a Claude API best practice), and the proposal (amount in CSPR, truncated counterparties, deploy) as the user prompt. The model returns a strict JSON verdict, `{"vote":"approve|reject|abstain","reason":"..."}`, which the coordinator parses defensively (first `{…}` block, enum-validated). Set `SLUICE_AGENT_MODEL` to pick a different model.
- **Without a key**, or on any parse/enum failure, the agent logs `[<agent>] LLM unavailable, using heuristic` and falls back to its **deterministic heuristic** (`riskHeuristic` / `treasuryHeuristic` / `legalHeuristic`, the rules in the table above). This keeps the swarm fully deliberating offline with **zero API keys** and a reproducible transcript.

Each agent logs which path it took (`decided by: claude-sonnet-5` vs `decided by: heuristic`), and the transcript header shows it for the whole swarm.

```bash
# heuristic (offline, no key), deterministic transcript
./demo.sh

# real model, the swarm reasons with Claude
export ANTHROPIC_API_KEY=sk-ant-…
./demo.sh
```

### Extending the swarm

- **More agents:** push another `{ name, fn }` onto the `AGENTS` array, the fan-out and tally pick it up automatically. Bump `QUORUM` to match.
- **Weighted / veto votes:** the Legal Agent could hard-veto (any `reject` from Legal fails the proposal) instead of contributing one vote, change the tally in `deliberate()`.
- **Real execution:** in `execute()`, build a Casper deploy (via the CSPR SDK or a `@sluice/client` tx helper) to move funds, update a governance contract, or post the outcome back on-chain.
- **Idempotency:** dedupe on `X-Sluice-Idempotency-Key` (exposed as `req.sluice.idempotencyKey`) so a redelivered event never triggers a second execution.
```
