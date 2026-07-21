# Sluice

[![CI](https://github.com/UnityNodes/Sluice/actions/workflows/ci.yml/badge.svg)](https://github.com/UnityNodes/Sluice/actions/workflows/ci.yml) [![CodeQL](https://github.com/UnityNodes/Sluice/actions/workflows/codeql.yml/badge.svg)](https://github.com/UnityNodes/Sluice/actions/workflows/codeql.yml) [![status](https://sluice.unitynodes.com/api/badge.svg)](https://sluice.unitynodes.com/app) [![contract](https://img.shields.io/badge/contract-f3710eaf%E2%80%A6b971-bcfc07?labelColor=000)](https://testnet.cspr.live/contract-package/f3710eaf12c30346eb1c642da832bc1af8ff900254c46bcc49a1efca81d8b971) [![tests](https://img.shields.io/badge/tests-110%2F110%20green-3edc64?labelColor=000)](#tests) [![license](https://img.shields.io/badge/license-MIT-000?labelColor=bcfc07)](./LICENSE)

> **Stripe webhooks, but for Casper.**
> Prepay in CSPR. Sluice pushes every matching on-chain event to your server (or straight into your AI agent via MCP) in under a second from when the block lands.

**Live on Casper testnet.** [sluice.unitynodes.com](https://sluice.unitynodes.com)
&nbsp; · &nbsp; [Dashboard](https://sluice.unitynodes.com/app)
&nbsp; · &nbsp; [MCP demo](https://sluice.unitynodes.com/#mcp-demo)
&nbsp; · &nbsp; [Contract on cspr.live](https://testnet.cspr.live/contract-package/f3710eaf12c30346eb1c642da832bc1af8ff900254c46bcc49a1efca81d8b971)

---

## What Sluice does

You're building an app or an AI agent on Casper. You need to know when something happens on chain. "Did anyone just send my address 5,000 CSPR?" "Did that whale wallet move funds again?" "Did my treasury receive a deposit?"

Your options today:

1. Poll the chain every few seconds. Wastes RPC budget. Lags reality.
2. Run your own indexer. About 600 lines of glue code and a database.
3. Sit and refresh cspr.live by hand.

Ethereum has Alchemy webhooks. Solana has Helius. Casper had nothing. **Sluice fills the gap.**

Casper's [AI Toolkit](https://www.casper.network/ai) already lets an agent **read** chain state (CSPR.cloud MCP), **act** on it (CSPR.trade MCP), and **pay** per request (x402). The missing primitive is **react**: knowing the instant something happens on chain without polling for it. Sluice is that piece, shipped as the same kind of hosted MCP, so an agent installs one URL and gets matched events pushed to it as tool calls. It composes with the rest of the toolkit rather than competing with it.

## How it works

<p align="center">
  <img src="https://sluice.unitynodes.com/pipeline.svg" alt="Sluice pipeline. Casper events, then JSON predicate, then your webhook, then on-chain receipt. Median webhook dispatch under 150 ms on testnet." width="900">
</p>

1. **Write a rule.** JSON predicate. "Any transfer to my address over 5000 CSPR."
2. **Prepay in CSPR.** Locked into the on-chain escrow contract. Each webhook delivery decrements the escrow by 1 CSPR, the flat per-delivery cost the registry was deployed with.
3. **Sluice watches the chain.** When a matching event lands, we POST to your webhook (or reach your AI agent via MCP) in under ~150 ms (median webhook dispatch latency on testnet, measured from match to webhook POST response).
4. **Every escrow-backed delivery is written on chain.** The contract itself emits `record_delivery`. Your bill is an auditable ledger on cspr.live, not a monthly invoice we made up. The public demo lanes on the live feed have no escrow to bill, so they deliver for real but write no receipt; they are labelled `DELIVERED` rather than `CONFIRMED`.

Cancel any time. Remaining CSPR is refunded to your wallet.

## What's in the box

| Piece | What it does |
|---|---|
| **Matcher** | Watches CSPR.cloud streaming WebSocket. Evaluates predicates. Dispatches webhooks with HMAC signature and idempotency key. Records deliveries on chain. |
| **`sluice` CLI** | `subscribe`, `list`, `cancel`, `tail`, `watch`, `replay-last`, `sandbox`, `doctor`, `ai`, `repl`. One binary, works against any deployed contract. |
| **MCP server (stdio)** | 5 tools, 4 resources, 3 resource templates, 2 prompts. Open standard, so any MCP client works: Claude, Cursor, Windsurf, Cline, VS Code, Codex. Built from this repo (see below); not yet published to npm. |
| **Hosted MCP (HTTP)** | Zero install, one URL for any client: `https://sluice.unitynodes.com/mcp`. Exposes the 2 read-only feed tools (`recent_deliveries`, `sluice_sandbox_dispatch`) plus all 4 resources, 3 resource templates and 2 prompts; the signing tools `subscribe_to_events` and `cancel_subscription`, plus read-only `list_subscriptions`, stay stdio-only. Per-client setup in [docs/MCP_CLIENTS.md](docs/MCP_CLIENTS.md). |
| **Web workspace** | Live subscription table, visual builder with plain-English AI parser, sandbox that fires real webhooks, rolling activity feed with click-to-explain. |
| **Demo stack** | `./scripts/demo.sh up`. One command boots matcher, Caddy, demo webhook receiver, Prometheus, Grafana, and two pre-seeded whale subscriptions. |

## Try it in one minute

### With the CLI

```bash
# 1. Clone and build
git clone https://github.com/UnityNodes/Sluice && cd Sluice/matcher
npm install && npm run build && npm link

# 2. Point at the deployed testnet contract
export SLUICE_CONTRACT_HASH=f3710eaf12c30346eb1c642da832bc1af8ff900254c46bcc49a1efca81d8b971
export SLUICE_KEY=~/keys/subscriber/secret_key.pem        # casper-client keygen
export SLUICE_NODE_RPC_URL=https://node.testnet.casper.network/rpc

# 3. Grab a free webhook URL from https://webhook.site and subscribe
sluice subscribe \
  --predicate ../examples/whale-transfers.json \
  --webhook https://webhook.site/<your-uuid> \
  --amount 10 --watch
```

`--watch` waits until the contract emits SubscriptionCreated, then tails deliveries for you. Every match shows up in webhook.site moments after the block lands (median webhook dispatch under ~150 ms on testnet, measured from match to webhook POST response).

### With Claude Code (no signup)

```bash
claude mcp add --transport http sluice https://sluice.unitynodes.com/mcp
```

Then in any Claude Code conversation:

> "Show me the last 10 Sluice deliveries. Which subscription is receiving the most?"

Claude calls `recent_deliveries`, reads `sluice://subs`, and answers.

For subscribe / cancel (which sign with your Casper key), build the stdio server from this repo:

```bash
cd Sluice/mcp && npm ci && npm run build && npm link
claude mcp add-json sluice '{"command":"sluice-mcp"}'
```

### With the web workspace

Open [sluice.unitynodes.com/app](https://sluice.unitynodes.com/app). No signup. Type "whales over 100k CSPR" into the plain-English builder, see the JSON, hit dry-run against the live testnet event buffer. When a real event matches, click the delivery row and get a condition-by-condition explanation of why it matched.

## The predicate language

Predicates are JSON. AND at the top level, with optional nested OR groups.

```json
{
  "and": [
    { "field": "to_account_hash", "op": "eq",  "value": "dc7252...787c9c" },
    { "field": "amount",          "op": "gte", "value": "5000000000" }
  ]
}
```

Or with an OR group:

```json
{
  "and": [
    { "field": "amount", "op": "gte", "value": "5000000000000" },
    { "or": [
        { "field": "to_account_hash", "op": "eq", "value": "aaa..." },
        { "field": "to_account_hash", "op": "eq", "value": "bbb..." }
    ]}
  ]
}
```

Supported operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `starts_with`, `ends_with`, `in`, `not_in`, `regex`.

**Native transfer fields:** `amount`, `to_account_hash`, `initiator_account_hash`, `deploy_hash`, `block_height`, `transfer_index`, `timestamp`.

**Contract-event fields (DeFi and RWA):** point the matcher at any external contract with `SLUICE_WATCH_CONTRACTS=<contract_package_hash>[,...]` and its emitted events flow through the same predicate engine. Those events expose `event_type` (always `"contract"`), `contract_package_hash`, `contract_hash`, `name` (the event name, e.g. `Swap` or `Liquidation`), and `data.*` (the event's own fields via dot notation). So a DEX swap over a threshold is:

```json
{
  "and": [
    { "field": "event_type", "op": "eq",  "value": "contract" },
    { "field": "name",       "op": "eq",  "value": "Swap" },
    { "field": "data.amount_in", "op": "gte", "value": "100000000000000" }
  ]
}
```

The engine is one code path: native transfers and contract events are matched by the same evaluator, so nested OR groups, the plain-English AI parser, dry-run, and click-to-explain all work identically on both.

**Proven live on testnet.** A companion contract, `DemoDex` (package `ffb5a95650e034784bb8c2f2a2bd03c814f8edf9a895b10d3edd4690e907b7b7`), is a minimal DeFi contract whose non-payable `swap` emits a CES `Swap` event. The production matcher watches it, so a real on-chain swap flows swap transaction to CSPR.cloud stream to predicate match to webhook `200` to `/app` in seconds. Fire one yourself with [`scripts/demo-swap.sh`](scripts/demo-swap.sh) (e.g. `scripts/demo-swap.sh 500000 CSPR USDC`) and watch it land. The contract lives in [`contract/src/demo_dex.rs`](contract/src/demo_dex.rs).

Full schema: [`docs/openapi.yaml`](docs/openapi.yaml) and [`web/schema/predicate-v1.json`](web/schema/predicate-v1.json). Or type "watch whales over 100k CSPR to dc7252…" into the AI builder and it writes the JSON for you.

## Self-host on a bare VPS

```bash
ssh root@your-vps
curl -fsSL https://raw.githubusercontent.com/UnityNodes/Sluice/main/scripts/install.sh | \
  SLUICE_DOMAIN=sluice.mydomain.com \
  SLUICE_CSPR_CLOUD_TOKEN=... \
  bash
```

Fresh Ubuntu 22.04 or 24.04. The installer sets up Node 20, the Rust toolchain, `casper-client`, and Caddy. It generates a matcher keypair if you don't already have one, drops a `sluice-matcher.service` systemd unit, and installs a hardened Caddy config with TLS via Let's Encrypt. Every step is idempotent so you can re-run it. First build takes about 10 minutes (dominated by `cargo install casper-client`). Source: [scripts/install.sh](scripts/install.sh).

## Self-host with Docker

```bash
git clone https://github.com/UnityNodes/Sluice && cd Sluice
cp .env.sample .env                       # paste your CSPR.cloud token + place a key under ./keys/matcher/
docker compose up --build                  # first build takes about 10 min (cargo install casper-client)
open http://localhost:8080                 # landing, /app, /feed, /h/ all served from the local stack
```

Bind a different port with `SLUICE_HTTP_PORT=9090 docker compose up`. Add a local HMAC-verifying receiver with `docker compose --profile with-demo-webhook up`. Skip the 10-minute Rust build by setting `INSTALL_CASPER_CLIENT: "false"` under `services.matcher.build.args` in `docker-compose.yml`, which gives a read-only matcher (matches and fires webhooks, but skips the on-chain `record_delivery` step). Full reference in [docker/README.md](docker/README.md).

### One-command demo stack

Boots the matcher, Caddy, a demo webhook receiver, Prometheus, Grafana with a pre-imported dashboard, and two pre-seeded subscriptions that catch real testnet whale transfers:

```bash
SLUICE_CSPR_CLOUD_TOKEN=... ./scripts/demo.sh up
```

Then open:

- `http://localhost:8080/h/demo` to watch live deliveries land in your browser
- `http://localhost:3001` for Grafana (admin / admin)
- `http://localhost:8080/app` for the workspace

Tail every webhook hit with `./scripts/demo.sh logs demo-webhook`. Tear it all down with `./scripts/demo.sh down`. No Casper wallet or faucet needed.

## See it in motion

<p align="center">
  <img src="https://sluice.unitynodes.com/screencast.svg" alt="Animated terminal recording of the sluice subscribe command running end-to-end. 18-second loop." width="900">
</p>

Every line above is a real log. Tx-hash prefixes match the ones on cspr.live for the v0.1 contract. Pure SVG with SMIL. No JS, no video tag, no plugins.

## Architecture

```
┌─────────────────┐    WS    ┌─────────────────┐   HTTPS POST   ┌────────────────┐
│  CSPR.cloud     │─────────▶│  Sluice matcher │───────────────▶│  Your webhook  │
│  Transfer stream│          │  (predicate eng)│                │  (or MCP tool) │
└─────────────────┘          └────────┬────────┘                └────────────────┘
                                      │
                                      │  record_delivery
                                      ▼
                             ┌─────────────────┐
                             │  Sluice escrow  │
                             │  contract       │
                             │  (Casper Odra)  │
                             └─────────────────┘
```

- **Contract** ([contract/](contract/)). Rust + Casper Odra 2.8. Holds subscriptions, tracks escrow balance, emits `SubscriptionCreated / SubscriptionCancelled / DeliveryRecorded / ToppedUp` events.
- **Matcher** ([matcher/](matcher/)). Node 20 + TypeScript. Subscribes to the CSPR.cloud transfer WebSocket. Evaluates predicates. Dispatches webhooks with `X-Sluice-Idempotency-Key` and `X-Sluice-Signature` (HMAC-SHA256). Retries with exponential backoff. Records delivery on chain via signed deploy.
- **MCP** ([mcp/](mcp/)). stdio server (5 tools) + Streamable HTTP server (the 2 non-signing tools; signing tools stay local). 4 resources, 3 resource templates, 2 prompts.
- **Web** ([web/](web/)). Static HTML + vanilla JS. Landing, `/app` workspace, `/status`, `/feed`, hosted receiver at `/h/<slug>`.

Full architecture doc: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Tests

- Matcher: 104 Jest tests. `cd matcher && npm test`.
- Contract: 6 Odra unit tests (OdraVM). `cd contract && cargo test`.
- REST API: smoke collection in `docs/sluice.postman_collection.json`. The MCP end-to-end check is [`docs/TESTING.md`](docs/TESTING.md) step 5.
- Predicate: unit-tested against the CSPR.cloud transfer schema in `matcher/test/predicate.test.ts`, including catastrophic-regex rejection.

Run the full suite with `cd matcher && npm test`.

## Delivery guarantees

Speed is only half the product. The other half is making sure a match actually reaches you, even when your endpoint has a bad moment.

Guaranteed today:
- **Retries with backoff.** A failed webhook is retried 3 times (1s, 4s, 16s) before it is marked failed.
- **Signed payloads.** Every POST carries `X-Sluice-Signature: sha256=<hmac>` when a secret is set, so you can reject anything that is not from Sluice.
- **Idempotency keys.** Each delivery carries a stable key, so a retry never double-counts on your side.
- **Manual replay.** `sluice replay-last <id>` re-sends the most recent deliveries with no new on-chain cost.

On the roadmap, and honestly not in v0.1:
- **Durable at-least-once queue.** Deliveries survive a matcher restart and auto-redeliver once your endpoint recovers.
- **Dead-letter handling** for endpoints that stay down past the retry window.

That gap is the line between a demo and a service you trust in production. We would rather name it than pretend it is closed.

## Honest v0.1 limits

- Casper **testnet only**. No mainnet contract yet.
- Predicates are AND at the top level with optional nested OR groups. Depth limit 4, condition limit 32.
- Webhook retries: 3 attempts with exponential backoff. No dead-letter queue in v0.1.
- Ring buffer of recent deliveries is live only. If the matcher restarts, in-memory history is gone. Full history is always in the contract events on cspr.live.
- No production SLAs. It's a buildathon submission running on a single VPS.

Full list in [docs/HONEST_LIMITS.md](docs/HONEST_LIMITS.md).

## Roadmap

- Q3 2026: OR / nested predicates (**shipped**), historical replay from CSPR.cloud, SSE alternative to webhook, Rust SDK.
- Q4 2026: mainnet contract, volume pricing tiers, dead-letter queue.
- 2027: predicates spanning several contracts at once, timelocked subscriptions. (Single-contract event matching already ships.)

Vote with usage. Roadmap tracked in [docs/ROADMAP.md](docs/ROADMAP.md).

## Client libraries

- **TypeScript / Node**: [`@sluice/client`](clients/typescript/), vendored in this repo (not yet published to npm). `cd clients/typescript && npm ci && npm run build`.
- **Python**: [`sluice-client`](clients/python/), vendored in this repo (not yet published to PyPI). `pip install ./clients/python`.
- **VS Code extension**: [clients/vscode/](clients/vscode/). Status bar shows live active/total subscription count and total deliveries; command palette gives one-key access to `sluice subscribe`, `list`, `tail`, `doctor`.

## HMAC webhook verification

Every webhook POST includes:

```
X-Sluice-Signature: sha256=<hex>
X-Sluice-Idempotency-Key: <sha256-of-event-payload>
X-Sluice-Sub-Id: <subscription-id>
```

Verify the signature server-side with a shared secret you set when you subscribed. Full snippets for Node, Python, Go, and shell in [docs/HMAC_VERIFY.md](docs/HMAC_VERIFY.md). Drop-in middleware for Express and Fastify ships as the `@sluice/client` middleware ([clients/typescript/src/middleware.ts](clients/typescript/src/middleware.ts)).

## Prometheus and Grafana

The matcher exposes a Prometheus-format `/api/metrics` endpoint:

```
sluice_deliveries_total
sluice_subscriptions{state="active|inactive"}
sluice_webhook_results_total{result="ok|fail"}
sluice_record_delivery_results_total{result="ok|fail"}
sluice_webhook_latency_ms_bucket
sluice_uptime_seconds
sluice_ws_connected{stream="transfers|contract-events"}
```

A ready-made Grafana dashboard lives at [docs/grafana-dashboard.json](docs/grafana-dashboard.json). Or spin up the full monitoring stack with one command:

```bash
docker compose --profile monitoring up -d
open http://localhost:3001    # admin / admin
```

## API reference

- REST: [docs/openapi.yaml](docs/openapi.yaml). Generate typed clients with `npx openapi-typescript-codegen --input https://sluice.unitynodes.com/api/openapi.yaml`.
- Postman collection: [docs/sluice.postman_collection.json](docs/sluice.postman_collection.json).
- Predicate JSON Schema: [`web/schema/predicate-v1.json`](web/schema/predicate-v1.json). Served at [sluice.unitynodes.com/schema/predicate-v1.json](https://sluice.unitynodes.com/schema/predicate-v1.json).

## Verify it yourself

Step-by-step instructions to check that Sluice does what this README claims, against the live testnet deployment and against the test suite, are in [`docs/TESTING.md`](docs/TESTING.md). The deployed contract package hashes and sample testnet transactions are listed there too.

## Contributing

Issues and PRs welcome. Please open an issue first for anything larger than a small bug fix so we can align on the direction. Follow conventional commits (`type(scope): description`).

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) for how to set up, what checks to run, and what we look for in a change. Participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md). To report a vulnerability, follow [`SECURITY.md`](SECURITY.md) rather than opening a public issue.

## Ecosystem

- [Casper Network](https://casper.network)
- [CSPR.cloud](https://cspr.cloud) (the streaming WebSocket that powers the matcher)
- [cspr.live](https://testnet.cspr.live) (explorer for tx hashes)
- [Casper AI Toolkit](https://www.casper.network/ai)

## License

MIT. See [LICENSE](LICENSE).

---

Made by [Unity Nodes](https://unitynodes.com) for the Casper Agentic Buildathon.
