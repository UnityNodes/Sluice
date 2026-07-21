# Changelog

All notable changes to Sluice land here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **Demo/synthetic lanes can no longer leak as real on-chain escrow.** Realness was derived from absence from the hand-maintained `SLUICE_DEMO_SUBS` id allowlist, so an injected lane omitted from it (e.g. the DemoDex swap feed, a placeholder-owner lane) was served with its real balance across `/api/snapshot.json`, the status badge, `/api/metrics`, `/embed`, `/og`, and `/api/sub/N.ics`. The matcher now classifies a lane as demo **by construction** — via a single `isDemoLane()` check that also treats any subscription whose owner is not a plausible on-chain account hash as demo (`looksSyntheticOwner`) — so its balance is zeroed and its deliveries excluded from every escrow/on-chain total, regardless of the allowlist. Genuine subscriptions (real account-hash owners) are unaffected. Added 8 unit tests.
- Corrected `docs/HONEST_LIMITS.md` and `docs/TESTING.md`, which had certified the DemoDex swap lane (subscription 4) as a real escrow-backed subscription.
- Frontend honesty: x402 card no longer hardcodes the settled `0.1 WCSPR` amount (uses the server-reported value); predicate-builder sample event relabelled from "real testnet transfer" to "illustrative fixture"; `KNOWN_CONTRACTS` demo lanes labelled `(demo)`; `deliveries` badge relabelled `dispatched` (webhook dispatches, not on-chain receipts).
- Mobile: `/app` toast width capped to the viewport (`min(380px, 100vw - 48px)`); `/roadmap` pricing grid collapses to one column ≤720px.
- README tests badge corrected to `118/118` (112 matcher + 6 contract).

## [0.1.0] - 2026-06-30

First public release. Live on Casper testnet at [sluice.unitynodes.com](https://sluice.unitynodes.com), package contract `f3710eaf12c30346eb1c642da832bc1af8ff900254c46bcc49a1efca81d8b971`.

### Added: core
- On-chain `SubscriptionRegistry` Odra contract: `create_subscription` (payable), `top_up` (payable), `record_delivery`, `cancel_subscription`. Events: `SubscriptionCreated`, `DeliveryRecorded`, `ToppedUp`, `SubscriptionCancelled`.
- Off-chain matcher: dual CSPR.cloud Streaming WS readers (transfers + contract-events), predicate engine with 12 operators (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `starts_with`, `ends_with`, `in`, `not_in`, `regex`), dot-notation field paths, bigint-string numeric comparison for motes.
- Webhook dispatcher: HTTP POST + 3-retry exponential backoff (1s/4s/16s), HMAC-SHA256 signing via `X-Sluice-Signature: sha256=<hex>` when `SLUICE_WEBHOOK_SECRET` is set, SSRF guard against private CIDR ranges.

### Added: clients & SDKs
- `sluice` CLI (Node, 11 commands): `subscribe`, `list`, `cancel`, `tail`, `watch`, `replay-last`, `sandbox`, `doctor`, `ai`, `repl`, `completion`.
- `@sluice/client` TypeScript npm package, fetch-based, zero runtime deps; optional `ws` peer for Node < 22. Subpath `./middleware` ships Express + Fastify HMAC verifiers.
- `sluice-client` Python package, stdlib-only HTTP, optional `[stream]` extra for WebSocket. Includes `verify_hmac_signature` / `compute_signature` receiver helpers.
- `sluice-mcp` MCP server, 5 tools (`subscribe_to_events`, `list_subscriptions`, `cancel_subscription`, `recent_deliveries`, `sluice_sandbox_dispatch`). Stdio transport for Claude Code, Codex, Continue.
- Postman collection at `docs/sluice.postman_collection.json` covering every endpoint.

### Added: HTTP API (matcher)
- `GET /api/health`, liveness probe
- `GET  /api/snapshot.json`, full subs + recent_events feed
- `GET  /api/metrics`, Prometheus exposition (10 metric families, latency histogram, WS gauges)
- `GET  /api/chain/head`, Casper testnet head, cached 3s, in-flight-collapsed
- `GET  /api/openapi.yaml`, full OpenAPI 3.1 spec for codegen
- `POST /api/predicate/validate`, dry-run a predicate against the last-1000 recent-events ring buffer
- `POST /api/predicate/explain`, per-condition pass/fail trace for one event
- `POST /api/sandbox/dispatch`, fire N synthetic-or-buffered events at a webhook URL, no on-chain effect
- `POST /api/sub/:id/replay-last`, bulk re-dispatch last N deliveries for one subscription
- `POST /api/tx/build/{create-subscription,top-up,cancel}`, offline-built Casper V1 transaction JSON for wallet signing
- `POST /api/tx/submit`, submit signed Casper V1 tx
- `POST /api/tx/{replay,test-webhook}`, one-shot delivery resend / synthetic test
- `GET  /api/sub/:id.ics`, iCalendar feed with weekly check-in + runout estimate + milestone events
- `GET  /api/badges/:metric.svg`, Shields-style live badges for `subs-active`, `deliveries`, `delivery-success`, `latency-p95`, `uptime`, `ws`
- `GET  /og/sub/:id`, 1200×630 OG card SVG
- `GET  /embed/sub/:id`, 320×120 iframe-embed HTML widget
- `WSS  /api/stream`, public WebSocket fan-out of every delivery + subs.reload events (optional `?sub=N` filter, 25s server ping)
- `*    /api/hooks/:slug{,/feed}`, hosted webhook receiver (50-deep ring, 1h TTL, named slugs)

### Added: UIs
- Landing page (`/`) with 12 sections, predicate playground, recipe gallery with builder deep-links, MCP demo transcript, live block-height counter, animated SVG pipeline + screencast, 30-second guided tour modal, live demo subs gallery
- Dashboard (`/app`), read-only Casper Wallet connect, filter pills, search, CSV export, per-sub action menu (view on cspr.live, copy webhook, copy predicate, send test webhook, top-up, cancel modals), activity feed with per-event RESEND buttons
- Live feed (`/feed/`), rolling 20-delivery full-screen stream
- Hosted receiver (`/h/<slug>`), named-slug picker, live request log, headers/body collapsibles, send test POST
- Status page (`/status`), Stripe-style component health, polls real public endpoints

### Added: operability
- `docker-compose.yml` self-host stack (matcher + Caddy + optional demo-webhook), single `docker compose up --build`
- `docs/grafana-dashboard.json`, importable Grafana dashboard for `/api/metrics`
- `scripts/install.sh`, one-shot Ubuntu 22/24 VPS provisioner (Node + Rust + casper-client + Caddy + systemd)
- JSON Schema for predicates at [/schema/predicate-v1.json](https://sluice.unitynodes.com/schema/predicate-v1.json) for IDE autocomplete

### Tests
104 Jest tests across the predicate engine (12 operators × edge cases, regex ReDoS guard), contract-event matching, idempotency-key uniqueness, HMAC signing/verification, webhook retry semantics, and real-event regressions.

### Known limits (v0.1)
Documented honestly in [docs/HONEST_LIMITS.md](docs/HONEST_LIMITS.md):
- §9 `casper-js-sdk@5.0.0-rc6` Stored-target serialisation bug; the CLI uses the Rust `casper-client` binary as a subprocess to dodge it
- §10 Browser-wallet mutations (create/top-up/cancel) currently render CLI snippets in a modal instead of one-clicking the wallet, due to Odra 2.8's `#[odra(payable)]` `cargo_purse` semantics; the dashboard is read-only. cancel is non-payable, so it's the first mutation slated for wallet-native signing once the v0.2 TransactionV1 work lands.
