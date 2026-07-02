# Changelog

Changelog for the Sluice contracts.

## [0.1.0] - 2026-06-29
### Added
- `SubscriptionRegistry` module: `create_subscription`, `record_delivery`, `top_up`, `cancel_subscription`, with events `SubscriptionCreated`, `DeliveryRecorded`, `ToppedUp`, `SubscriptionCancelled`. Deployed to Casper testnet.
- `DemoDex` module: non-payable `swap` that emits a CES `Swap` event, used to demonstrate live contract-event matching.
