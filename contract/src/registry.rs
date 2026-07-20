//! Sluice SubscriptionRegistry, on-chain subscription escrow for push-based event delivery.
//!
//! A subscriber locks CSPR + stores a predicate + webhook URL.
//! Off-chain matcher consumes Casper events, evaluates predicates, and on match:
//!   1. POSTs to webhook (off-chain, idempotency-keyed)
//!   2. calls `record_delivery(id, event_hash)` here, which decrements balance.

use odra::casper_types::U512;
use odra::prelude::*;

/// A single subscription record.
#[odra::odra_type]
pub struct Subscription {
    pub owner: Address,
    pub predicate_json: String,
    pub webhook_url: String,
    pub balance: U512,
    pub deliveries: u64,
    pub active: bool,
    pub created_at: u64,
}

#[odra::module(
    errors = Error,
    events = [SubscriptionCreated, DeliveryRecorded, SubscriptionCancelled, ToppedUp]
)]
pub struct SubscriptionRegistry {
    subscriptions: Mapping<u32, Subscription>,
    next_id: Var<u32>,
    total_deliveries: Var<u64>,
    delivery_unit_cost: Var<U512>,
}

#[odra::module]
impl SubscriptionRegistry {
    /// Initialises the registry.
    ///
    /// `delivery_unit_cost` is the flat CSPR amount (in motes) deducted from a
    /// subscription's balance every time the matcher records a delivery.
    pub fn init(&mut self, delivery_unit_cost: U512) {
        self.next_id.set(1);
        self.total_deliveries.set(0);
        self.delivery_unit_cost.set(delivery_unit_cost);
    }

    /// Creates a new subscription. Caller pays the attached CSPR as escrow.
    #[odra(payable)]
    pub fn create_subscription(
        &mut self,
        predicate_json: String,
        webhook_url: String,
    ) -> u32 {
        let owner = self.env().caller();
        let amount = self.env().attached_value();
        if amount == U512::zero() {
            self.env().revert(Error::ZeroDeposit);
        }
        let created_at = self.env().get_block_time();
        let id = self.next_id.get_or_default();

        let sub = Subscription {
            owner,
            predicate_json: predicate_json.clone(),
            webhook_url: webhook_url.clone(),
            balance: amount,
            deliveries: 0,
            active: true,
            created_at,
        };
        self.subscriptions.set(&id, sub);
        self.next_id.set(id + 1);

        // predicate_json is included in the event so the off-chain matcher can
        // build its in-memory predicate table from the WS contract-events stream
        // without needing a chain-read round trip. Keep it small (≤ a few KB).
        self.env().emit_event(SubscriptionCreated {
            id,
            owner,
            webhook_url,
            balance: amount,
            predicate_json,
        });
        id
    }

    /// Records one successful event delivery. Decrements the subscription's
    /// balance by `delivery_unit_cost` and increments delivery counters.
    ///
    /// Anyone-callable in the demo build. Production should restrict to a
    /// matcher pubkey (see HONEST_LIMITS.md §8).
    pub fn record_delivery(&mut self, id: u32, event_hash: String) {
        let mut sub = match self.subscriptions.get(&id) {
            Some(s) => s,
            None => self.env().revert(Error::SubscriptionNotFound),
        };
        if !sub.active {
            self.env().revert(Error::SubscriptionInactive);
        }
        let cost = self.delivery_unit_cost.get_or_default();
        if sub.balance < cost {
            self.env().revert(Error::InsufficientBalance);
        }

        sub.balance -= cost;
        sub.deliveries += 1;
        if sub.balance < cost {
            sub.active = false;
        }
        let new_balance = sub.balance;
        let owner = sub.owner;
        self.subscriptions.set(&id, sub);

        let total = self.total_deliveries.get_or_default() + 1;
        self.total_deliveries.set(total);

        self.env().emit_event(DeliveryRecorded {
            id,
            event_hash,
            new_balance,
            owner,
        });
    }

    /// Owner-only: cancels a subscription and refunds the remaining balance.
    pub fn cancel_subscription(&mut self, id: u32) {
        let caller = self.env().caller();
        let mut sub = match self.subscriptions.get(&id) {
            Some(s) => s,
            None => self.env().revert(Error::SubscriptionNotFound),
        };
        if sub.owner != caller {
            self.env().revert(Error::NotOwner);
        }
        if !sub.active {
            self.env().revert(Error::SubscriptionInactive);
        }

        let refund = sub.balance;
        sub.balance = U512::zero();
        sub.active = false;
        self.subscriptions.set(&id, sub);

        if refund > U512::zero() {
            self.env().transfer_tokens(&caller, &refund);
        }
        self.env().emit_event(SubscriptionCancelled {
            id,
            owner: caller,
            refund,
        });
    }

    /// Adds CSPR to an existing subscription's balance. Reactivates if previously exhausted.
    #[odra(payable)]
    pub fn top_up(&mut self, id: u32) {
        let amount = self.env().attached_value();
        if amount == U512::zero() {
            self.env().revert(Error::ZeroDeposit);
        }
        let mut sub = match self.subscriptions.get(&id) {
            Some(s) => s,
            None => self.env().revert(Error::SubscriptionNotFound),
        };
        sub.balance += amount;
        sub.active = true;
        let new_balance = sub.balance;
        let owner = sub.owner;
        self.subscriptions.set(&id, sub);

        self.env().emit_event(ToppedUp {
            id,
            owner,
            amount,
            new_balance,
        });
    }

    // ---- views ----

    pub fn get_subscription(&self, id: u32) -> Option<Subscription> {
        self.subscriptions.get(&id)
    }

    pub fn get_next_id(&self) -> u32 {
        self.next_id.get_or_default()
    }

    pub fn get_total_deliveries(&self) -> u64 {
        self.total_deliveries.get_or_default()
    }

    pub fn get_delivery_unit_cost(&self) -> U512 {
        self.delivery_unit_cost.get_or_default()
    }
}

#[odra::odra_error]
pub enum Error {
    SubscriptionNotFound = 1,
    SubscriptionInactive = 2,
    InsufficientBalance = 3,
    NotOwner = 4,
    ZeroDeposit = 5,
}

#[odra::event]
pub struct SubscriptionCreated {
    pub id: u32,
    pub owner: Address,
    pub webhook_url: String,
    pub balance: U512,
    pub predicate_json: String,
}

#[odra::event]
pub struct DeliveryRecorded {
    pub id: u32,
    pub event_hash: String,
    pub new_balance: U512,
    pub owner: Address,
}

#[odra::event]
pub struct SubscriptionCancelled {
    pub id: u32,
    pub owner: Address,
    pub refund: U512,
}

#[odra::event]
pub struct ToppedUp {
    pub id: u32,
    pub owner: Address,
    pub amount: U512,
    pub new_balance: U512,
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::host::{Deployer, HostRef};

    const UNIT_COST: u64 = 1_000_000_000; // 1 CSPR per delivery

    fn setup() -> (SubscriptionRegistryHostRef, Address, Address) {
        let env = odra_test::env();
        let registry = SubscriptionRegistry::deploy(
            &env,
            SubscriptionRegistryInitArgs {
                delivery_unit_cost: U512::from(UNIT_COST),
            },
        );
        let subscriber = env.get_account(1);
        let matcher = env.get_account(2);
        (registry, subscriber, matcher)
    }

    #[test]
    fn create_subscription_locks_balance_and_returns_id() {
        let (registry, subscriber, _) = setup();
        let env = registry.env().clone();
        env.set_caller(subscriber);

        let deposit: U512 = U512::from(10_000_000_000u64); // 10 CSPR
        let id = registry
            .with_tokens(deposit)
            .create_subscription(
                "{\"and\":[{\"field\":\"amount\",\"op\":\"gt\",\"value\":\"1000\"}]}".to_string(),
                "https://example.test/hook".to_string(),
            );

        assert_eq!(id, 1);
        let sub = registry.get_subscription(1).unwrap();
        assert_eq!(sub.owner, subscriber);
        assert_eq!(sub.balance, deposit);
        assert_eq!(sub.deliveries, 0);
        assert!(sub.active);
    }

    #[test]
    fn record_delivery_decrements_balance_and_counts() {
        let (mut registry, subscriber, matcher) = setup();
        let env = registry.env().clone();
        env.set_caller(subscriber);
        let deposit = U512::from(10 * UNIT_COST);
        registry
            .with_tokens(deposit)
            .create_subscription("{}".to_string(), "https://x.test".to_string());

        env.set_caller(matcher);
        registry.record_delivery(1, "0xdeadbeef".to_string());

        let sub = registry.get_subscription(1).unwrap();
        assert_eq!(sub.balance, deposit - U512::from(UNIT_COST));
        assert_eq!(sub.deliveries, 1);
        assert_eq!(registry.get_total_deliveries(), 1);
        assert!(sub.active);
    }

    #[test]
    fn record_delivery_deactivates_when_balance_runs_out() {
        let (mut registry, subscriber, matcher) = setup();
        let env = registry.env().clone();
        env.set_caller(subscriber);
        let deposit = U512::from(2 * UNIT_COST);
        registry
            .with_tokens(deposit)
            .create_subscription("{}".to_string(), "https://x.test".to_string());

        env.set_caller(matcher);
        registry.record_delivery(1, "a".to_string());
        registry.record_delivery(1, "b".to_string());

        let sub = registry.get_subscription(1).unwrap();
        assert_eq!(sub.balance, U512::zero());
        assert_eq!(sub.deliveries, 2);
        assert!(!sub.active);

        let err = registry
            .try_record_delivery(1, "c".to_string())
            .unwrap_err();
        assert_eq!(err, Error::SubscriptionInactive.into());
    }

    #[test]
    fn cancel_refunds_owner_only() {
        let (mut registry, subscriber, matcher) = setup();
        let env = registry.env().clone();
        env.set_caller(subscriber);
        let deposit = U512::from(5 * UNIT_COST);
        registry
            .with_tokens(deposit)
            .create_subscription("{}".to_string(), "https://x.test".to_string());

        // Non-owner cannot cancel.
        env.set_caller(matcher);
        let err = registry.try_cancel_subscription(1).unwrap_err();
        assert_eq!(err, Error::NotOwner.into());

        // Owner can.
        env.set_caller(subscriber);
        let balance_before = env.balance_of(&subscriber);
        registry.cancel_subscription(1);
        let balance_after = env.balance_of(&subscriber);
        assert_eq!(balance_after, balance_before + deposit);

        let sub = registry.get_subscription(1).unwrap();
        assert!(!sub.active);
        assert_eq!(sub.balance, U512::zero());
    }

    #[test]
    fn top_up_extends_balance_and_reactivates() {
        let (mut registry, subscriber, matcher) = setup();
        let env = registry.env().clone();
        env.set_caller(subscriber);
        registry
            .with_tokens(U512::from(UNIT_COST))
            .create_subscription("{}".to_string(), "https://x.test".to_string());

        // Drain it.
        env.set_caller(matcher);
        registry.record_delivery(1, "a".to_string());
        assert!(!registry.get_subscription(1).unwrap().active);

        // Owner tops up.
        env.set_caller(subscriber);
        registry.with_tokens(U512::from(3 * UNIT_COST)).top_up(1);
        let sub = registry.get_subscription(1).unwrap();
        assert!(sub.active);
        assert_eq!(sub.balance, U512::from(3 * UNIT_COST));
    }

    #[test]
    fn create_subscription_rejects_zero_deposit() {
        let (mut registry, subscriber, _) = setup();
        let env = registry.env().clone();
        env.set_caller(subscriber);
        let err = registry
            .try_create_subscription("{}".to_string(), "https://x.test".to_string())
            .unwrap_err();
        assert_eq!(err, Error::ZeroDeposit.into());
    }
}
