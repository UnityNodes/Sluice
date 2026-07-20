# HONEST_LIMITS

These limits are summarized in `README.md`. They exist because a payments-savvy reviewer will catch any overclaiming, and shipping known caveats is much cheaper than fielding objections during judging.

---

1. **Delivery semantics: at-most-once during the demo.** If the matcher dies, events that arrived while it was down are lost, CSPR.cloud Streaming is live-only. Production adds a checkpointed block-height cursor + JSON-RPC backfill via `state_get_block`. Out of buildathon scope.

2. **Operator-subsidised gas during the demo.** The matcher pays gas for every `record_delivery` it submits. Production deducts a `gas_reimbursement` field from the subscriber's escrow per delivery, so the matcher is fee-neutral.

3. **Predicate eval is O(N_subscriptions) per event.** The demo is bounded to ≤100 subs; production shards by predicate key (e.g. `to_account_hash` index) so unrelated subscribers don't pay each other's CPU.

4. **Event coverage: native Transfer plus CES contract events** (the latter via `SLUICE_WATCH_CONTRACTS`). Deploy, Balance, and NFT event types are on the roadmap. Validator-skip and governance are *derived* events (synthesise from Block + active validator set), Phase 2 work.

5. **Filter coverage: subscriber-defined predicates evaluated off-chain.** CSPR.cloud Streaming only supports `account_hash`/`public_key` filtering server-side; everything else (amount, contract args, direction, custom fields) runs in our matcher's predicate engine. This is intentional, defining the filter language is the differentiation.

6. **Not x402, complements x402.** Sluice is on-chain prepaid *subscription* escrow with push delivery. x402 is per-call *pull* micropayments. The two are complementary, not competitive. Do not conflate them.

7. **Webhook delivery is at-least-once.** Subscribers must dedupe by the `Idempotency-Key` HTTP header, computed as `sha256(deploy_hash || transfer_id || amount || to_account_hash)`. The header is set on every retry, so a duplicate POST always carries the same key.

8. **`record_delivery` is callable by anyone in the demo build.** Anyone can grief by spamming, draining a subscriber's balance. Production restricts the entry-point to a single matcher pubkey (set at contract init) or to addresses on an allow-list governed by the contract owner. This is a deliberate v0.1 cut to ship by the deadline; the rewrite is one extra `if caller != trusted_matcher { revert }`. Related: `record_delivery` decrements the accounting balance but does not transfer the consumed motes to a payee, so in v0.1 that CSPR stays in the contract purse with no withdrawal path (a subscriber can still refund the *remaining* balance via `cancel`). Production adds the operator payout and an on-chain idempotency set keyed on `event_hash` so a duplicate submission cannot double-charge. Two more contract entry-points share this v0.1 cut: `top_up` is not owner-restricted and reactivates a cancelled subscription (any account can fund any id, and a `top_up` after `cancel` flips the record active on-chain even though the matcher treats cancel as terminal, so it sits idle until cancelled again); production gates `top_up` to the owner and refuses it on a cancelled record. Low fund risk (the owner can always re-cancel to refund), called out rather than hidden.

9. **Matcher submits via `casper-client` subprocess, not `casper-js-sdk@5.0.0-rc6` directly.** The SDK release candidate emits Stored-target JSON flat (`{ id, runtime, transferred_value }`) and includes a `transferred_value` field in the hashed payload bytes, which the Casper 2.2.2 node rejects with "invalid hash" / "Invalid params". `matcher/src/casper.ts` retains the SDK build/sign path for the day a future SDK release fixes the encoding; until then `scripts/record-delivery.sh` (which uses `casper-client put-transaction package`) is the submission path used by `matcher/src/index.ts`.

10. **The dashboard is read-only in v0.1; every mutation is CLI- or MCP-driven.** Odra `#[odra(payable)]` entry-points compile to a two-step calling convention: the caller creates a temporary purse, funds it, then calls the contract with that purse URef as a `__cargo_purse` argument. Casper Wallet's single-`sign()` signs one `TransactionV1` at a time and can't drive that, so for v0.1 we chose to ship a clean read-only dashboard rather than a half-functional wallet panel. The "+ New subscription", "Top-up", and "Cancel" modals copy the equivalent `sluice …` CLI command (and a Claude Code MCP prompt). The matcher API endpoints (`/api/tx/build/*`, `/api/tx/submit`) stay live, verified end-to-end with the subscriber key during development, so the dashboard's wallet-sign path can be turned back on with no chain or server changes once a contract redesign (v0.2) lifts the cargo-purse arg.

11. **The public API is rate-limited, not authenticated.** The demo dashboard is meant to be usable by anyone without a login, so the matcher's HTTP API stays open and applies a per-IP rate limit (`SLUICE_API_RATE_LIMIT`, default 60/min) rather than requiring a token. Outbound webhook dispatch (including the sandbox and replay tools) runs through an SSRF guard that resolves the target once, rejects private/link-local/loopback ranges, and pins the connection to the validated IP. A hosted production tier would put a real auth boundary in front of the side-effecting routes; that is a deployment posture, not a code change.

12. **Not every lane on the public feed is escrow-backed.** Subscription 4 (the DemoDex swap feed) is a real on-chain subscription with a funded escrow, so each of its deliveries calls `record_delivery` and carries a transaction hash. The RWA watcher lanes are injected demo subscriptions with no escrow, so their deliveries are real but write no receipt, and the UI labels them `DELIVERED` rather than `CONFIRMED`. This is why `sluice_deliveries_total` is larger than `sluice_record_delivery_results_total`: the first counts webhook dispatches, the second counts on-chain receipts.

---

If you spot something else worth disclosing, file an issue and label it `honest-limits`.
