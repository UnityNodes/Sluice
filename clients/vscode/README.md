# Sluice: VS Code extension

Status bar + command palette + JSON Schema validation for [Sluice](https://sluice.unitynodes.com), on-chain Casper event subscriptions.

## What you get

- **Status-bar item** with live `Sluice  N/M active · D delivered` polled from the matcher every 10 seconds (configurable). Click → opens the workspace in your browser.
- **Command palette** entries (`Sluice:` prefix):
  - **Open workspace in browser**, sluice.unitynodes.com/app (or your self-host URL)
  - **Build predicate (AI → JSON)**, describe what you want in plain English, get a `predicate.json` opened in a new editor pane, ready to save
  - **Fire sandbox webhooks at a URL**, POST 1-10 Sluice-shaped events to any webhook URL without spending CSPR
  - **Refresh status bar now**
  - **Copy MCP install command**, drops `claude mcp add-json sluice '{"command":"sluice-mcp"}'` on your clipboard
- **Inline JSON Schema** for `**/predicate*.json`, `**/sluice-predicate*.json`, `**/whale*.json`, autocomplete + validation against [predicate-v1.json](https://sluice.unitynodes.com/schema/predicate-v1.json).

## Settings

| Setting               | Default                                | What it does                                            |
|-----------------------|----------------------------------------|---------------------------------------------------------|
| `sluice.apiBase`      | `https://sluice.unitynodes.com/api`    | Matcher API base. Override for a self-host.             |
| `sluice.pollSeconds`  | `10`                                   | How often the status bar refreshes (min `3`).           |
| `sluice.statusBarFormat` | `Sluice  ${active}/${total} active · ${delivered} delivered` | Status bar text. Supports `${active}`, `${total}`, `${delivered}` placeholders. |

## Building

```bash
cd clients/vscode
npm install
npm run build           # tsc → dist/extension.js
npm install -g @vscode/vsce
vsce package --no-dependencies   # → sluice-vscode-0.1.0.vsix
```

Then either drop the `.vsix` into VS Code via the Extensions panel "Install from VSIX" menu, or publish to the marketplace.

## License

MIT, same as the rest of [Sluice](https://github.com/UnityNodes/Sluice).
