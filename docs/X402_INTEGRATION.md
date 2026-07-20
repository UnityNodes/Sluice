# Sluice × x402: the events and payments primitives of the Casper AI Toolkit

Autonomous agents on Casper need two low-level capabilities that the base chain
doesn't give them directly:

- **Events**, *"tell me the moment something on-chain matters to me."*
- **Payments**, *"let me pay for exactly what I use, per request, with proof."*

**Sluice is the events primitive. [x402](https://www.casper.network/ai) is the
payments primitive.** Together they let an agent **subscribe-and-pay-per-event**
with no human in the loop: it discovers what an event feed costs, pays a
micropayment per delivery, and reacts, end to end, machine to machine.

> **Status:** the Casper x402 **facilitator** went live in June 2026 as part of
> the [Casper AI Toolkit](https://www.casper.network/ai). It is hosted at
> `https://x402-facilitator.cspr.cloud` (mainnet and testnet) with an official
> SDK, [`@make-software/casper-x402`](https://github.com/make-software/casper-x402),
> exposing `/verify` and `/settle` behind a CSPR.cloud access token. The runnable
> example in [`examples/x402-metered-delivery/`](../examples/x402-metered-delivery/)
> is **wired to it for real**: `x402-receiver.mjs` and `x402-payer.mjs` settle a
> live payment through the hosted facilitator. Proof on testnet:
> [`37d55534…1eb0`](https://testnet.cspr.live/transaction/37d5553425a1a2290be0b6e0b17843cc8f53a74bc77abe1ecd9b6ae975ab1eb0)
> (a paid Sluice event delivery, settled on-chain in Wrapped CSPR). The dependency-free
> `receiver.cjs` / `payer.cjs` remain as a stubbed protocol walkthrough.

## How the two primitives compose

```text
  ┌─────────────────────────────────────────────────────────────────────┐
  │                        Autonomous agent                              │
  │                                                                      │
  │   "watch 100k+ CSPR transfers to X, and I'll pay per alert"          │
  └───────────────┬──────────────────────────────────┬──────────────────┘
                  │  subscribe (events primitive)     │  pay (payments primitive)
                  ▼                                    ▼
        ┌───────────────────┐                ┌────────────────────────┐
        │      SLUICE       │  each matched  │         x402           │
        │  on-chain event   │  event =       │  HTTP micropayment     │
        │  match + webhook  │  one delivery  │  per delivery          │
        │  delivery         │ ─────────────▶ │  (402 → pay → 200)     │
        └───────────────────┘                └────────────────────────┘
```

Sluice watches the Casper event stream, matches events against an agent's
subscription, and delivers each match as a webhook. x402 gates that delivery:
the agent pays a micropayment per push. The
[`examples/x402-metered-delivery/`](../examples/x402-metered-delivery/) receiver
is exactly this gate, a Sluice-shaped webhook sink that refuses unpaid
deliveries with `402`.

## Billing: escrow vs x402 pay-per-delivery

Sluice already bills for delivery via an **on-chain escrow**: the subscriber
pre-locks CSPR, and the `SubscriptionRegistry` contract decrements it per
`record_delivery`. x402 offers a second, complementary model.

| | **On-chain escrow** (Sluice today) | **x402 pay-per-delivery** |
|---|---|---|
| Payment timing | Pre-funded, up front | Per HTTP request |
| Where it settles | `SubscriptionRegistry` escrow decrement | x402 facilitator settlement |
| Capital locked | Yes, balance held in advance | No, pay only for what's delivered |
| Onboarding cost | Deploy + fund an escrow first | Zero, pay on the first 402 |
| Overhead per event | Very low (one contract decrement) | One micropayment per delivery |
| Replay / abuse guard | Escrow balance bounds spend | Server nonce, burned on settle |
| Ideal workload | Steady, high-volume, long-lived subs | Bursty, exploratory, ephemeral agents |
| Trust model | Funds custodied on-chain in advance | Payment proven per request |

**Rule of thumb.** Use **escrow** for a durable, high-throughput subscription
where pre-funding amortizes to near-zero per-event cost. Use **x402** for agents
that appear, consume a few events, and vanish, no escrow to deploy, no leftover
locked balance, and spend that tracks usage one-to-one. The two aren't mutually
exclusive: a long-lived feed can run on escrow while a metered "trial" or
per-agent tier of the same feed runs on x402.

## Why this belongs in the Casper AI Toolkit

An agent that can *see* on-chain events but can't *pay* for services is only
half-autonomous, and vice-versa. Pairing them unlocks self-directed workflows:

- A trading agent subscribes to whale transfers (**Sluice**) and pays per alert
  (**x402**), it only spends when there's signal, and never pre-commits capital.
- A monitoring agent samples a premium event feed by paying for the first N
  deliveries, then decides whether to escrow for volume.
- A marketplace of Sluice feeds becomes possible: publishers set an
  `X402_PRICE_MOTES` per delivery; agents discover it from the `402` challenge
  and pay per push, no accounts, no invoices, no pre-registration.

## Roadmap

| Phase | State | What lands |
|---|---|---|
| **1, Shape** | ✅ done | 402 challenge → pay → retry flow, nonce/replay handling, ledger, escrow-vs-x402 model. Signing + verification **stubbed**. See the example dir. |
| **2, Facilitator wiring** | ✅ done | `x402-receiver.mjs` + `x402-payer.mjs` use the `@make-software/casper-x402` SDK against the live hosted facilitator. A paid Sluice delivery settled on testnet: [`37d55534…1eb0`](https://testnet.cspr.live/transaction/37d5553425a1a2290be0b6e0b17843cc8f53a74bc77abe1ecd9b6ae975ab1eb0). Payment settles in Wrapped CSPR (`3d80df21…847c1e`); the facilitator's fee-payer covers gas. |
| **3, Native Sluice option** | ✅ done | `x402` is a live billing mode on the matcher (`SLUICE_X402_SUBS`). An x402-billed subscription is not pushed: the matcher queues each real match, and an agent pulls one by paying an x402 micropayment (`POST /api/x402/pay` on the dashboard). The delivered payload is the actual on-chain event Sluice matched, not a sample. Escrow (push) and x402 (pull) now run side by side on the same event stream. |
| **4, Price discovery** | planned | Publishers advertise per-feed pricing; agents negotiate escrow vs x402 automatically based on projected volume. |

Everything except phases 2+ is already in the runnable example. Search
[`examples/x402-metered-delivery/`](../examples/x402-metered-delivery/) for
`>>> STUB <<<` to find every spot that the real facilitator replaces.

## References

- Runnable example: [`examples/x402-metered-delivery/`](../examples/x402-metered-delivery/)
- Casper AI / x402: <https://www.casper.network/ai>
- Sluice architecture: [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md)
- Honest limits of the prototype: [`docs/HONEST_LIMITS.md`](./HONEST_LIMITS.md)
