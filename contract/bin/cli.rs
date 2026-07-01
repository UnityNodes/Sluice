//! Deploy + interaction CLI for SubscriptionRegistry.
//!
//! Build:    cargo build --bin contract_cli --features livenet  (auto-detected by Odra)
//! Run:      ODRA_CASPER_LIVENET_SECRET_KEY_PATH=keys/matcher/secret_key.pem \
//!           ODRA_CASPER_LIVENET_NODE_ADDRESS=https://node.testnet.cspr.cloud \
//!           ODRA_CASPER_LIVENET_EVENTS_URL=https://node.testnet.cspr.cloud/events \
//!           ODRA_CASPER_LIVENET_CHAIN_NAME=casper-test \
//!           CSPR_CLOUD_AUTH_TOKEN=<token> \
//!           cargo run --bin contract_cli -- deploy

use contract::demo_dex::DemoDex;
use contract::registry::{SubscriptionRegistry, SubscriptionRegistryInitArgs};
use odra::casper_types::U512;
use odra::host::{HostEnv, NoArgs};
use odra::schema::casper_contract_schema::NamedCLType;
use odra_cli::{
    deploy::DeployScript,
    scenario::{Args, Error, Scenario, ScenarioMetadata},
    cspr, CommandArg, ContractProvider, DeployedContractsContainer, DeployerExt, OdraCli,
};

/// Deploys SubscriptionRegistry with a flat per-delivery cost (default: 1 CSPR).
pub struct DeployRegistryScript;

impl DeployScript for DeployRegistryScript {
    fn deploy(
        &self,
        env: &HostEnv,
        container: &mut DeployedContractsContainer,
    ) -> Result<(), odra_cli::deploy::Error> {
        let one_cspr: U512 = U512::from(1_000_000_000u64);
        let _registry = SubscriptionRegistry::load_or_deploy(
            env,
            SubscriptionRegistryInitArgs {
                delivery_unit_cost: one_cspr,
            },
            container,
            cspr!(350),
        )?;
        // DemoDex: a non-payable DeFi contract whose `swap` emits a CES `Swap`
        // event. Used to demonstrate Sluice matching real on-chain contract
        // events end to end. Loaded if already deployed, otherwise deployed.
        let _demo = DemoDex::load_or_deploy(env, NoArgs, container, cspr!(400))?;
        Ok(())
    }
}

/// Scenario: read total_deliveries for a sanity check.
pub struct StatsScenario;

impl Scenario for StatsScenario {
    fn args(&self) -> Vec<CommandArg> {
        vec![]
    }
    fn run(
        &self,
        env: &HostEnv,
        container: &DeployedContractsContainer,
        _args: Args,
    ) -> Result<(), Error> {
        let registry = container.contract_ref::<SubscriptionRegistry>(env)?;
        let total = registry.try_get_total_deliveries()?;
        let next_id = registry.try_get_next_id()?;
        let unit = registry.try_get_delivery_unit_cost()?;
        odra_cli::log(format!(
            "registry stats, next_id: {next_id}, total_deliveries: {total}, unit_cost: {unit}"
        ));
        Ok(())
    }
}

impl ScenarioMetadata for StatsScenario {
    const NAME: &'static str = "stats";
    const DESCRIPTION: &'static str =
        "Prints next_id, total_deliveries, and delivery_unit_cost from the deployed registry";
}

/// Scenario: simulate a delivery (anyone-can-call demo mode).
pub struct RecordDeliveryScenario;

impl Scenario for RecordDeliveryScenario {
    fn args(&self) -> Vec<CommandArg> {
        vec![
            CommandArg::new("id", "Subscription id", NamedCLType::U32).required(),
            CommandArg::new("event_hash", "Event hash hex", NamedCLType::String).required(),
        ]
    }
    fn run(
        &self,
        env: &HostEnv,
        container: &DeployedContractsContainer,
        args: Args,
    ) -> Result<(), Error> {
        let mut registry = container.contract_ref::<SubscriptionRegistry>(env)?;
        let id = args.get_single::<u32>("id")?;
        let event_hash = args.get_single::<String>("event_hash")?;
        env.set_gas(2_000_000_000);
        registry.try_record_delivery(id, event_hash)?;
        odra_cli::log("delivery recorded".to_string());
        Ok(())
    }
}

impl ScenarioMetadata for RecordDeliveryScenario {
    const NAME: &'static str = "record-delivery";
    const DESCRIPTION: &'static str =
        "Submits a record_delivery tx (demo build is anyone-callable)";
}

/// Scenario: emit a Swap event from DemoDex (non-payable, anyone-callable).
pub struct SwapScenario;

impl Scenario for SwapScenario {
    fn args(&self) -> Vec<CommandArg> {
        vec![
            CommandArg::new("trader", "Trader account hash or label", NamedCLType::String)
                .required(),
            CommandArg::new("token_in", "Input token symbol", NamedCLType::String).required(),
            CommandArg::new("token_out", "Output token symbol", NamedCLType::String).required(),
            CommandArg::new("amount_in", "Input amount in motes", NamedCLType::U512).required(),
            CommandArg::new("amount_out", "Output amount in motes", NamedCLType::U512).required(),
        ]
    }
    fn run(
        &self,
        env: &HostEnv,
        container: &DeployedContractsContainer,
        args: Args,
    ) -> Result<(), Error> {
        let mut dex = container.contract_ref::<DemoDex>(env)?;
        let trader = args.get_single::<String>("trader")?;
        let token_in = args.get_single::<String>("token_in")?;
        let token_out = args.get_single::<String>("token_out")?;
        let amount_in = args.get_single::<U512>("amount_in")?;
        let amount_out = args.get_single::<U512>("amount_out")?;
        env.set_gas(2_000_000_000);
        dex.try_swap(trader, token_in, token_out, amount_in, amount_out)?;
        odra_cli::log("swap emitted".to_string());
        Ok(())
    }
}

impl ScenarioMetadata for SwapScenario {
    const NAME: &'static str = "swap";
    const DESCRIPTION: &'static str = "Emits a DemoDex Swap event (non-payable demo)";
}

pub fn main() {
    OdraCli::new()
        .about("Sluice SubscriptionRegistry CLI")
        .deploy(DeployRegistryScript)
        .contract::<SubscriptionRegistry>()
        .contract::<DemoDex>()
        .scenario(StatsScenario)
        .scenario(RecordDeliveryScenario)
        .scenario(SwapScenario)
        .build()
        .run();
}
