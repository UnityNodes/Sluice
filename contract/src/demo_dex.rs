//! DemoDex, a minimal DeFi contract used to demonstrate Sluice matching real,
//! on-chain contract events end to end.
//!
//! `swap` is intentionally non-payable: it takes no escrow and moves no funds,
//! it only records a trade and emits a CES `Swap` event. That lets the demo
//! trigger genuine on-chain events on demand (via casper-client), which the
//! CSPR.cloud contract-events stream carries to the Sluice matcher, which
//! evaluates subscriber predicates against `name == "Swap"` and `data.amount_in`.

use odra::casper_types::U512;
use odra::prelude::*;

#[odra::module(events = [Swap])]
pub struct DemoDex {
    total_swaps: Var<u64>,
}

#[odra::module]
impl DemoDex {
    /// Records a swap and emits a `Swap` event. Non-payable by design.
    pub fn swap(
        &mut self,
        trader: String,
        token_in: String,
        token_out: String,
        amount_in: U512,
        amount_out: U512,
    ) {
        let n = self.total_swaps.get_or_default() + 1;
        self.total_swaps.set(n);
        self.env().emit_event(Swap {
            trader,
            token_in,
            token_out,
            amount_in,
            amount_out,
        });
    }

    pub fn total_swaps(&self) -> u64 {
        self.total_swaps.get_or_default()
    }
}

#[odra::event]
pub struct Swap {
    pub trader: String,
    pub token_in: String,
    pub token_out: String,
    pub amount_in: U512,
    pub amount_out: U512,
}
