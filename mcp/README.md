# @sluice/mcp

MCP server that exposes the Sluice event subscription registry to AI agents.

## Install

```bash
cd mcp && npm install && npm run build
npm link        # makes `sluice-mcp` available on PATH
```

## Register with Claude Code

```bash
claude mcp add-json sluice '{"command":"sluice-mcp"}'
```

## Register with Codex

Edit `~/.codex/config.toml`:

```toml
[mcp_servers.sluice]
command = "sluice-mcp"
```

## Required environment

The MCP server delegates the actual on-chain work to the `sluice` CLI, so every env var the CLI needs must be set in the MCP runtime:

```
SLUICE_KEY                       # path to subscriber's secret_key.pem
SLUICE_CONTRACT_HASH             # deployed SubscriptionRegistry contract hash (hex)
SLUICE_NODE_RPC_URL              # default https://node.testnet.cspr.cloud/rpc
SLUICE_CSPR_CLOUD_TOKEN          # CSPR.cloud auth token
SLUICE_CHAIN_NAME                # default casper-test
```

## Tools exposed

- **subscribe_to_events**: locks CSPR, stores a predicate and webhook URL on-chain.
- **list_subscriptions**: lists active subscriptions and their balances.
- **cancel_subscription**: cancels a subscription and refunds the remaining CSPR.
- **recent_deliveries**: returns the most recent matched deliveries.
- **sluice_sandbox_dispatch**: fires test webhooks with no CSPR spent.

Also exposes 4 resources and 2 prompts. See [docs/ROADMAP.md](../docs/ROADMAP.md) for what is next.
