# Sluice × x402: metered pay-per-delivery example

A Sluice-shaped webhook **receiver** that is gated by [x402](https://www.casper.network/ai),
Casper's HTTP-native micropayment protocol. Every event delivery must carry a
valid x402 payment, no payment, no delivery. This is machine-to-machine
commerce: the thing pushing events pays a micropayment for each push, per HTTP
request, with cryptographic proof.

Instead of Sluice's usual model (pre-lock CSPR in an on-chain escrow that
decrements per delivery), this endpoint charges **pay-as-you-go** over HTTP 402.

## This really works, on-chain, today

`x402-receiver.mjs` and `x402-payer.mjs` are a **real** integration against the
live hosted Casper x402 facilitator (`https://x402-facilitator.cspr.cloud`,
part of the [Casper AI Toolkit](https://www.casper.network/ai)) using the
official [`@make-software/casper-x402`](https://github.com/make-software/casper-x402)
SDK. A paying agent requests a gated event delivery, signs an EIP-712 payment
authorization with its Casper key, and the facilitator verifies and **settles
the payment on-chain**. Proof on testnet:

- **Settlement transaction:** [`63de4cc0…f10bd5`](https://testnet.cspr.live/transaction/63de4cc0010c2ebcbb245efc98253523f74cf06e321eca141f35cb1788f10bd5) (success, block 8393413)
- Payer signs, the facilitator's fee-payer pays gas, and 0.1 SLX moves from payer to payee, all from one HTTP 402 exchange.
- Payment asset: `Sluice X402 Token (SLX)`, package `220ed4c8…db88b`.

### Why a token we deployed, and what changes on mainnet

x402 settles CEP-18 tokens that expose `transfer_with_authorization`. On
testnet we deployed SLX from `Cep18X402.wasm`, the reference token contract
shipped in [make-software/casper-x402](https://github.com/make-software/casper-x402)
(`infra/local/deployer/`), which is exactly what that contract is there for:
giving an integration a funded balance to settle against.

The canonical asset is **Wrapped CSPR**, package
`3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e` (the value
used in the reference `.env.testnet`). We verified it exposes
`transfer_with_authorization`, so switching is a one-line config change:

```bash
ASSET_PACKAGE=3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e
```

Nothing else in the flow changes. We stayed on SLX for the demo because
acquiring WCSPR means calling the wrapper's `deposit`, which needs a funded
purse passed from a session contract, and that is a funding detail rather than
anything the payment path depends on.

Run it yourself: `npm install`, copy `.env.sample` to `.env`, fill in your
CSPR.cloud token and a key holding SLX, then `npm start` (receiver) and
`npm run pay` (payer). The `receiver.cjs` / `payer.cjs` files below are the
dependency-free **protocol illustration**; the `.mjs` files are the real thing.

```text
   payer.cjs                                receiver.cjs  (POST /hook)
 ┌──────────┐                              ┌────────────────────────┐
 │  agent / │  1. POST /hook  (no payment) │  x402-metered Sluice   │
 │  Sluice  │ ───────────────────────────▶ │        receiver        │
 │  worker  │                              │                        │
 │          │  2. 402 Payment Required     │   issues challenge:    │
 │          │ ◀─────────────────────────── │   { amount, payTo,     │
 │          │     accepts:[{ nonce … }]    │     nonce }            │
 │          │                              │                        │
 │          │  3. sign payment payload     │                        │
 │          │     (Casper key)  ── STUB ── │                        │
 │          │                              │                        │
 │          │  4. POST /hook               │  verify (STUB) ─┐      │
 │          │     X-Payment: <base64>      │  settle         │      │
 │          │ ───────────────────────────▶ │  record ledger  │      │
 │          │                              │  process event ◀┘      │
 │          │  5. 200 OK  { seq, txHash }  │                        │
 │          │ ◀─────────────────────────── │                        │
 └──────────┘                              └────────────────────────┘
```

> **Note.** The ASCII flow and the `payer.cjs` / `receiver.cjs` files below are a
> dependency-free illustration of the raw x402 protocol, with the signing and
> verification shown as labeled STUBS so you can read the shape without any SDK.
> The **real** integration lives in `x402-receiver.mjs` / `x402-payer.mjs`: it
> uses the official SDK, settles through the live facilitator, and moves real
> tokens on-chain (see the settlement transaction above).

## Run it

```bash
cd examples/x402-metered-delivery
npm install
./demo.sh
```

`demo.sh` starts the receiver, makes one **unpaid** request (you'll see `402`
with a challenge body), then runs `payer.cjs` to do the full
challenge → sign → retry loop (you'll see `200`), and finally prints the ledger
of paid deliveries.

Run the pieces by hand:

```bash
npm start                 # terminal 1: receiver on http://localhost:4021
node payer.cjs             # terminal 2: pays for one delivery -> 200
node payer.cjs --unpaid    # terminal 2: only step 1, shows the 402 challenge
curl localhost:4021/ledger
```

## What powers the button on the dashboard

The "Pull a matched event via x402" button on <https://sluice.unitynodes.com/app>
is served by `x402-demo-service.mjs`, not by the two scripts above.

```bash
npm run demo-service     # listens on :7788
```

In production it runs as the `sluice-x402` systemd unit, and Caddy proxies
`/api/x402/*` to `127.0.0.1:7788`. On `POST /api/x402/pay` it signs a payment,
settles it through the live facilitator, then claims one real matched event
from the matcher over its internal `/x402/claim` route. The event you get back
is one Sluice actually matched, not a sample.

## The HTTP 402 flow

1. **Unpaid request.** `POST /hook` with a Sluice event body and **no**
   `X-Payment` header. The receiver replies `402 Payment Required` with an
   x402-shaped body:

   ```json
   {
     "error": "payment_required",
     "accepts": [{
       "x402Version": 1,
       "scheme": "exact",
       "network": "casper-testnet",
       "maxAmountRequired": "1000000",
       "asset": "CSPR",
       "payTo": "account-hash-0000…",
       "nonce": "9f3c…",
       "resource": "/hook"
     }]
   }
   ```

   `maxAmountRequired` is in **motes** (1 CSPR = 1e9 motes). Default price is
   `1_000_000` motes = **0.001 CSPR per delivery**.

2. **Pay.** The payer signs a payload binding the server `nonce`, amount, and
   pay-to address with its Casper key, then base64-encodes the envelope. *(This
   signing step is a STUB here.)*

3. **Retry.** `POST /hook` again, this time with
   `X-Payment: <base64-encoded signed payload>`. The receiver verifies the
   payment *(STUB)*, burns the nonce (replay protection), records the payment in
   its ledger, processes the Sluice event, and returns `200 OK`.

## Two billing models, escrow vs x402 pay-per-delivery

Sluice bills for delivering matched on-chain events. There are two ways to
charge for that work:

| | **On-chain escrow** (Sluice today) | **x402 pay-per-delivery** (this example) |
|---|---|---|
| When you pay | Up front, lock CSPR in an escrow contract | Per request, one micropayment per push |
| Settlement | Contract decrements the escrow per delivery | x402 facilitator settles each payment |
| Capital tied up | Yes, pre-funded balance sits locked | No, pay exactly for what's delivered |
| Failure mode | Escrow drains / needs top-up | 402 until the next payment clears |
| Onboarding | Deploy/fund an escrow first | Just start calling; pay on demand |
| Best for | High-volume, predictable, long-lived subs | Bursty, exploratory, or per-agent metering |
| Trust model | Funds custodied on-chain in advance | Payment proven per request, no pre-custody |

**When each fits.** Escrow is great for a known, steady subscription: fund once,
stream thousands of events, low per-event overhead. x402 shines for **agents**
that spin up, consume a handful of events, and disappear, no escrow to deploy,
no leftover locked balance, and the cost maps exactly to usage. An agent can
discover the price from the `402` challenge and decide, per event, whether the
data is worth paying for.

## Sluice webhook body

The receiver processes the standard Sluice webhook shape:

```json
{
  "subscription_id": "sub_x402_demo",
  "event": { "amount": "5000000000000", "to_account_hash": "account-hash-dc72…" },
  "delivered_at": "2026-07-01T00:00:00Z"
}
```

If you set `SLUICE_WEBHOOK_SECRET`, the receiver also HMAC-verifies the
`X-Sluice-Signature: sha256=<hex>` header (constant-time compare) alongside the
x402 payment check. The two are independent: x402 answers *"has this delivery
been paid for?"*, the HMAC answers *"did Sluice really send this body?"*.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `4021` | Receiver listen port |
| `X402_PRICE_MOTES` | `1000000` | Price per delivery, in motes (0.001 CSPR) |
| `X402_PAY_TO` | `account-hash-0000…` | Casper account/purse that receives payment |
| `X402_NETWORK` | `casper-testnet` | x402 network label |
| `SLUICE_WEBHOOK_SECRET` | *(unset)* | Enables `X-Sluice-Signature` HMAC verify |
| `X402_FROM` / `X402_PAYER_SECRET` | demo values | Payer identity + stub signing key |

## Swapping the stub illustration for the real facilitator

The Casper x402 facilitator is live at <https://x402-facilitator.cspr.cloud>
(see <https://www.casper.network/ai>). The `.mjs` scripts already use it; to
port the dependency-free stub walkthrough, replace its two stubs:

1. **Receiver, `verifyPaymentStub()` in `receiver.cjs`.** Swap the structural
   check for a facilitator call that verifies the signed payment against the
   chain and settles it:

   ```js
   // const receipt = await facilitator.verifyAndSettle(decoded, requirement);
   // if (!receipt.settled) return { ok: false, reason: receipt.error };
   // return { ok: true, payment: { settlementTxHash: receipt.txHash, … } };
   ```

   The facilitator confirms `maxAmountRequired` motes actually moved to `payTo`
   and returns a real settlement receipt / tx hash.

2. **Payer, `signPayment()` in `payer.cjs`.** Replace the HMAC placeholder with
   a real Casper signature over the canonical payload using the agent's key
   pair (via the CSPR SDK or the facilitator's client library).

Everything else, the 402 challenge shape, the `X-Payment` header transport, the
nonce/replay handling, and the ledger, is already in the shape the real
protocol expects, so the swap is localized to those two functions.

Search this directory for `>>> STUB <<<` to find every spot that needs a real
implementation.
