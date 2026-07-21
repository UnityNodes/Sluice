# Add Sluice to any MCP client

MCP is an open standard, so the Sluice MCP server is not Claude-only. The hosted
endpoint speaks Streamable HTTP and works with any MCP-compatible client.

**Hosted endpoint (free on testnet):**

```
https://sluice.unitynodes.com/mcp
```

The stdio server exposes 5 tools (`subscribe_to_events`, `list_subscriptions`,
`cancel_subscription`, `recent_deliveries`, `sluice_sandbox_dispatch`),
4 resources, 3 resource templates, and 2 prompts. The hosted HTTP endpoint
serves the 2 read-only feed tools (`recent_deliveries`, `sluice_sandbox_dispatch`)
plus the same resources and prompts; `subscribe_to_events` and
`cancel_subscription` sign with your Casper key, so they stay stdio-only.

## Per-client setup

### Claude Code

```bash
claude mcp add --transport http sluice https://sluice.unitynodes.com/mcp
```

### Cursor: `~/.cursor/mcp.json`

```json
{ "mcpServers": { "sluice": { "url": "https://sluice.unitynodes.com/mcp" } } }
```

### Windsurf: `~/.codeium/windsurf/mcp_config.json`

```json
{ "mcpServers": { "sluice": { "serverUrl": "https://sluice.unitynodes.com/mcp" } } }
```

### VS Code: `.vscode/mcp.json`

```json
{ "servers": { "sluice": { "type": "http", "url": "https://sluice.unitynodes.com/mcp" } } }
```

### Cline (VS Code): MCP settings JSON

```json
{ "mcpServers": { "sluice": { "url": "https://sluice.unitynodes.com/mcp" } } }
```

### Claude Desktop: `claude_desktop_config.json` (via `mcp-remote`)

```json
{ "mcpServers": { "sluice": { "command": "npx", "args": ["mcp-remote", "https://sluice.unitynodes.com/mcp"] } } }
```

### Local stdio (offline / self-host)

Install the package, then point any client's command transport at `sluice-mcp`:

```json
{ "mcpServers": { "sluice": { "command": "sluice-mcp" } } }
```

## Verify

After adding the server, restart the client. `sluice` should appear in its MCP
server list. The hosted endpoint carries the read-only tools; the signing tools need the local stdio server. Ask it: *"show me the last 10 Sluice
deliveries."*
