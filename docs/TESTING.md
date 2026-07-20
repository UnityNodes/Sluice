# Testing Sluice

Step-by-step instructions to verify that Sluice works. No setup is required for
Part 1. Everything runs on Casper **testnet**.

Live instance: <https://sluice.unitynodes.com>

---

## Part 1: verify the live deployment (about 5 minutes, nothing to install)

### 1. The matcher is alive

```bash
curl https://sluice.unitynodes.com/api/health
```

Expected:

```json
{"ok":true,"contract":"f3710eaf12c30346eb1c642da832bc1af8ff900254c46bcc49a1efca81d8b971","chain":"casper-test"}
```

### 2. Real matched events are being delivered

```bash
curl -s https://sluice.unitynodes.com/api/snapshot.json | head -c 400
```

The `recent_events` array holds the last 20 real deliveries. Each entry carries
the on-chain `deploy_hash`, the `block_height`, the webhook `status` (200), and
the delivery `latency_ms`.

Open <https://sluice.unitynodes.com/app> to see the same data rendered, with the
watched subscriptions and their predicates.

### 3. Confirm a delivery against the chain

Take any `deploy_hash` from `recent_events` and open it on the explorer:

```
https://testnet.cspr.live/transaction/<deploy_hash>
```

The transaction is a real `swap` call on the DemoDex contract. Sluice matched
the CES `Swap` event it emitted and delivered it. Compare the `amount_in`,
`token_in`, and `token_out` in the snapshot payload with the event on chain.

### 4. Pull a real event by paying with x402

Open <https://sluice.unitynodes.com/app> and press **Pull a matched event via
x402**.

What happens: the browser calls `POST /api/x402/pay`. A CEP-18 payment is signed
and settled through the official hosted Casper x402 facilitator
(`x402-facilitator.cspr.cloud`). On settlement, the matcher releases one real
queued event from subscription 200. The page shows the event that was bought and
a link to the settlement transaction on `testnet.cspr.live`.

You are paying for an event Sluice actually matched, not a sample payload.

### 5. Point an AI agent at the hosted MCP server

The MCP server speaks Streamable HTTP at `https://sluice.unitynodes.com/mcp`.

```bash
curl -s -X POST https://sluice.unitynodes.com/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'
```

Expected: HTTP 200, `content-type: text/event-stream`, and a JSON-RPC result
naming the server. The hosted endpoint exposes 2 read-only tools plus 4 resources and 2 prompts; subscribe, top-up and cancel are stdio-only because they sign with your Casper key. Use
`recent_deliveries` to read the same feed the dashboard shows.

To wire it into a client, add the URL as a Streamable HTTP MCP server.

### 6. Metrics

```bash
curl -s https://sluice.unitynodes.com/api/metrics | grep sluice_
```

Prometheus format. `sluice_ws_connected` reports the upstream CSPR.cloud stream
health for both the transfers and the contract-events sockets.

---

## Part 2: run the test suite (about 3 minutes)

Requires Node 20. The Rust toolchain (pinned in `contract/rust-toolchain`) is
only needed for the contract tests.

```bash
git clone https://github.com/UnityNodes/Sluice.git
cd Sluice

cd matcher
npm ci
npm run lint      # tsc --noEmit
npm test          # 89 tests
npm run build

cd ../mcp
npm ci
npm run build

cd ../contract
cargo check
cargo test        # 6 tests
```

Expected: 89 matcher tests and 6 contract tests pass, and both typecheck and
build are clean. This is exactly what CI runs on every push
(`.github/workflows/ci.yml`).

---

## Part 3: fire your own on-chain event (optional, needs a funded testnet key)

Requires `casper-client` and a testnet key with a few CSPR.

```bash
scripts/demo-swap.sh 500000 CSPR USDC
```

This submits a real `swap` transaction to the DemoDex contract. The contract
emits a CES `Swap` event, CSPR.cloud streams it, the matcher evaluates it
against the active predicates, and the match is delivered. Watch it land at
<https://sluice.unitynodes.com/app>, typically within a few seconds of the block
being finalized.

---

## Deployed testnet contracts

| Contract | Package hash | What it does |
|---|---|---|
| `SubscriptionRegistry` | `f3710eaf12c30346eb1c642da832bc1af8ff900254c46bcc49a1efca81d8b971` | Holds each subscription and its CSPR escrow. `record_delivery(id, event_hash)` decrements the escrow once per delivery. |
| `DemoDex` | `ffb5a95650e034784bb8c2f2a2bd03c814f8edf9a895b10d3edd4690e907b7b7` | A minimal DeFi contract whose non-payable `swap` emits a CES `Swap` event. Used to generate real contract events on demand. |
| `SLX` (CEP-18) | `220ed4c8e5368063ec167d738d1b96d5760833366af4a1194264312a766db88b` | The x402 payment token. Supports `transfer_with_authorization`, so the facilitator can settle a signed payment. |

## Third-party contracts Sluice watches on testnet

These belong to other Casper teams. Contract events are public data, so watching
them needs no coordination. They demonstrate that the engine works against real
DeFi and RWA contracts, not only our own.

| Project | Package hash |
|---|---|
| Wisp Dollar (stablecoin) | `65bedddde009284db1bd62614afc8bbeb405590ddec1669eca3db38b5e18810f` |
| STEWARD Institutional Fund (RWA) | `1d25c895320b16f37eb57b344b8b655f56c30ca6e941e903976fc0e97a803409` |
| Meridian RWA | `0d5ae3015928b0070f03b9a377cf09fa86c63f3ce86f24b357f570977b786d8d` |

## Sample testnet transactions

| Transaction | What it shows |
|---|---|
| [`63de4cc0…f10bd5`](https://testnet.cspr.live/transaction/63de4cc0010c2ebcbb245efc98253523f74cf06e321eca141f35cb1788f10bd5) | An x402 micropayment settled on-chain through the hosted facilitator. 0.1 SLX moved from the paying agent to the feed publisher, and the facilitator paid the gas. This is the payment that buys one matched event delivery. |
| [`3fb89280…939efd`](https://testnet.cspr.live/transaction/3fb8928092af0f0a01716c497795ff1950a8d3eae517ddee4b3cc08eeb939efd) | A `swap` call on DemoDex at block 8453751. It emitted the CES `Swap` event (520,000 CSPR in, 518,700 CSPRX out) that Sluice matched and delivered to a webhook in 117 ms. |
| [`f665f4f7…14b419`](https://testnet.cspr.live/transaction/f665f4f7dd5acf719ff1cb9b5763ffd80a950c7bae94a5bdb4c88e1f0414b419) | Another DemoDex `swap`, matched and delivered on the next cycle. |
| [`67a87d6b…089b0e`](https://testnet.cspr.live/transaction/67a87d6bcd35ffb32fb1c7271a0441efef306a127dd8a178f9395f1591089b0e) | `create_subscription` for subscription 4, locking 300 CSPR of escrow. This is the subscription behind every `CONFIRMED` row on the live feed. |
| [`67cb9683…4c7a75`](https://testnet.cspr.live/transaction/67cb968323b55b68c2b55b576d8575f04c40468768a1531c12fe6454314c7a75) | A `record_delivery` receipt: Sluice matched a swap, POSTed the webhook in 74 ms, then wrote this on-chain and decremented the escrow by 1 CSPR. Delivery and billing, end to end. |

## Which lanes are escrow-backed

Subscription **4** (the DemoDex swap feed) is a real on-chain subscription with
a funded escrow, so every one of its deliveries calls `record_delivery` and
carries a transaction hash you can open on cspr.live. Those rows are labelled
`CONFIRMED`.

The remaining public lanes (the RWA watchers) are injected demo lanes with no
escrow to bill. Their deliveries are real, but no receipt is written, so they
are labelled `DELIVERED` rather than `CONFIRMED`. This keeps the public feed
running without spending escrow on contracts that are not ours.

To see the difference yourself, compare a `CONFIRMED` row's transaction hash on
the explorer against `sluice_record_delivery_results_total` in
[`/api/metrics`](https://sluice.unitynodes.com/api/metrics). The full list of
prototype limits is in [`HONEST_LIMITS.md`](HONEST_LIMITS.md).
