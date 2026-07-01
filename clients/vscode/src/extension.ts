/**
 * Sluice VS Code extension, status-bar live counter + command palette.
 *
 * On activation we add a status-bar item that polls /api/snapshot.json every
 * `sluice.pollSeconds` seconds and shows the active subscription count plus
 * the lifetime delivery total. Clicking it opens the workspace in the user's
 * browser. The command palette gets four entries (workspace, sandbox,
 * build, refresh, MCP install copy) that all route to the same matcher API
 * via the configurable base URL. Predicate JSON Schema is registered against
 * common filename patterns so editing a `predicate.json` gives autocomplete
 * + inline validation out of the box.
 */

import * as vscode from 'vscode';

interface Snapshot {
  subscriptions: Array<{ id: number; active: boolean; deliveries: number }>;
  updated_at: string;
  chain: string;
}

interface ExtState {
  statusBar: vscode.StatusBarItem;
  timer?: NodeJS.Timeout;
  lastSnapshot?: Snapshot;
}

const state: ExtState = {
  statusBar: undefined as unknown as vscode.StatusBarItem,
};

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('sluice');
  return {
    apiBase: (cfg.get<string>('apiBase') ?? 'https://sluice.unitynodes.com/api').replace(/\/$/, ''),
    pollSeconds: Math.max(3, cfg.get<number>('pollSeconds') ?? 10),
    statusBarFormat: cfg.get<string>('statusBarFormat') ?? 'Sluice  ${active}/${total} active · ${delivered} delivered',
  };
}

async function fetchSnapshot(): Promise<Snapshot | null> {
  const { apiBase } = getConfig();
  try {
    const res = await fetch(`${apiBase}/snapshot.json?t=${Date.now()}`);
    if (!res.ok) return null;
    return (await res.json()) as Snapshot;
  } catch {
    return null;
  }
}

function formatStatus(snap: Snapshot, fmt: string): string {
  const subs = snap.subscriptions ?? [];
  const active = subs.filter((s) => s.active).length;
  const delivered = subs.reduce((a, s) => a + (s.deliveries ?? 0), 0);
  return fmt
    .replace(/\$\{active\}/g, String(active))
    .replace(/\$\{total\}/g, String(subs.length))
    .replace(/\$\{delivered\}/g, String(delivered));
}

async function refreshStatus(): Promise<void> {
  const snap = await fetchSnapshot();
  if (!snap) {
    state.statusBar.text = '$(circle-slash) Sluice  offline';
    state.statusBar.tooltip = 'Could not reach the matcher. Check sluice.apiBase setting.';
    state.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    return;
  }
  const { statusBarFormat } = getConfig();
  state.lastSnapshot = snap;
  state.statusBar.text = '$(broadcast) ' + formatStatus(snap, statusBarFormat);
  state.statusBar.tooltip = `Matcher snapshot · updated ${snap.updated_at}\nClick to open the workspace.`;
  state.statusBar.backgroundColor = undefined;
}

function startPolling(context: vscode.ExtensionContext): void {
  const { pollSeconds } = getConfig();
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(refreshStatus, pollSeconds * 1000);
  context.subscriptions.push({ dispose: () => state.timer && clearInterval(state.timer) });
  void refreshStatus();
}

/* ─────────────────── commands ─────────────────── */

async function cmdOpenWorkspace(): Promise<void> {
  const { apiBase } = getConfig();
  const root = apiBase.replace(/\/api$/, '');
  await vscode.env.openExternal(vscode.Uri.parse(`${root}/app`));
}

async function cmdCopyMcpInstall(): Promise<void> {
  const cmd = "claude mcp add-json sluice '{\"command\":\"sluice-mcp\"}'";
  await vscode.env.clipboard.writeText(cmd);
  vscode.window.showInformationMessage('Sluice MCP install command copied. Paste into your shell to register the server.');
}

async function cmdBuildPredicate(): Promise<void> {
  const prompt = await vscode.window.showInputBox({
    title: 'Sluice, describe the events to watch',
    prompt: 'Plain English. Examples: "transfers over 100k cspr to dc7252…" · "between 5 and 50 cspr ending in 000000000"',
    placeHolder: 'transfers over 100k cspr to <64-hex>',
    ignoreFocusOut: true,
  });
  if (!prompt) return;
  const { apiBase } = getConfig();
  try {
    const res = await fetch(`${apiBase}/predicate/from-prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const data = await res.json() as { predicate?: unknown; understood?: string[]; unknown?: string[]; error?: string };
    if (!res.ok || !data.predicate) {
      vscode.window.showWarningMessage(`Sluice AI: ${data.error ?? 'could not extract a predicate from that prompt.'}`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument({
      language: 'json',
      content: JSON.stringify(data.predicate, null, 2),
    });
    await vscode.window.showTextDocument(doc);
    const note = (data.understood ?? []).slice(0, 3).join(' · ');
    vscode.window.showInformationMessage(`Sluice AI: ${note || 'predicate generated.'}`);
  } catch (e) {
    vscode.window.showErrorMessage(`Sluice AI failed: ${(e as Error).message}`);
  }
}

async function cmdSandboxDispatch(): Promise<void> {
  const webhook = await vscode.window.showInputBox({
    title: 'Sluice sandbox, webhook URL',
    prompt: 'Where the matcher should POST. Accepts /api/hooks/<slug> too.',
    placeHolder: 'https://webhook.site/your-uuid',
    ignoreFocusOut: true,
  });
  if (!webhook) return;
  const countStr = await vscode.window.showInputBox({
    title: 'Sluice sandbox, how many events?',
    value: '3', validateInput: (v) => /^([1-9]|10)$/.test(v) ? null : 'enter 1-10',
  });
  if (!countStr) return;
  const { apiBase } = getConfig();
  const root = apiBase.replace(/\/api$/, '');
  const fullWebhook = webhook.startsWith('/api/hooks/') ? root + webhook : webhook;
  try {
    const res = await fetch(`${apiBase}/sandbox/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ webhook: fullWebhook, count: Number(countStr) }),
    });
    const j = await res.json() as { delivered?: number; requested?: number; error?: string };
    if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
    vscode.window.showInformationMessage(`Sluice sandbox: ${j.delivered}/${j.requested} delivered to ${fullWebhook}`);
  } catch (e) {
    vscode.window.showErrorMessage(`Sluice sandbox failed: ${(e as Error).message}`);
  }
}

/* ─────────────────── activate / deactivate ─────────────────── */

export function activate(context: vscode.ExtensionContext): void {
  state.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  state.statusBar.text = '$(broadcast) Sluice  …';
  state.statusBar.command = 'sluice.openWorkspace';
  state.statusBar.tooltip = 'Polling matcher…';
  state.statusBar.show();
  context.subscriptions.push(state.statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('sluice.openWorkspace',   cmdOpenWorkspace),
    vscode.commands.registerCommand('sluice.copyMcpInstall',  cmdCopyMcpInstall),
    vscode.commands.registerCommand('sluice.buildPredicate',  cmdBuildPredicate),
    vscode.commands.registerCommand('sluice.sandboxDispatch', cmdSandboxDispatch),
    vscode.commands.registerCommand('sluice.refreshSnapshot', refreshStatus),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sluice')) startPolling(context);
    }),
  );

  startPolling(context);
}

export function deactivate(): void {
  if (state.timer) clearInterval(state.timer);
  state.statusBar?.dispose();
}
