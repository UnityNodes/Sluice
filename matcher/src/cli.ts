#!/usr/bin/env node
/**
 * `sluice subscribe`, locks CSPR into the on-chain SubscriptionRegistry and
 * stores a predicate + webhook URL.
 *
 *   sluice subscribe \
 *     --predicate ./whale.json \
 *     --webhook https://my.app/hook \
 *     --amount 100 \
 *     --key ./keys/subscriber/secret_key.pem
 *
 * Globals can come from env:
 *   SLUICE_CONTRACT_HASH, SLUICE_NODE_RPC_URL, SLUICE_CSPR_CLOUD_TOKEN,
 *   SLUICE_CHAIN_NAME, SLUICE_KEY (default key path).
 */

import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import {
  Args,
  CLValueString,
  CLValueUInt512,
  Duration,
  FixedMode,
  Hash,
  HttpHandler,
  InitiatorAddr,
  PricingMode,
  RpcClient,
  StoredTarget,
  Timestamp,
  TransactionEntryPoint,
  TransactionEntryPointEnum,
  TransactionHash,
  TransactionInvocationTarget,
  TransactionScheduling,
  TransactionTarget,
  TransactionV1,
  TransactionV1Payload,
} from 'casper-js-sdk';

import { CasperClient } from './casper';
import { parsePredicateJson } from './contract';

const CSPR_PER_MOTE = 1_000_000_000n; // 1 CSPR = 1e9 motes

/**
 * After `subscribe --watch` lands the tx, the contract assigns the sub a
 * fresh id on the next block. We poll the matcher's public snapshot until a
 * subscription owned by our pubkey appears with a created_at newer than the
 * deadline floor, that's our new sub. Returns its id, or null if we time out.
 */
async function awaitNewSubId(opts: { ownerPubkeyHex: string; afterUnixSec: number; apiUrl: string; timeoutMs: number }): Promise<number | null> {
  const base = opts.apiUrl.replace(/\/api$/, '').replace(/\/$/, '');
  const start = Date.now();
  let lastErr = '';
  while (Date.now() - start < opts.timeoutMs) {
    try {
      const r = await fetch(`${base}/api/snapshot.json?t=${Date.now()}`, { signal: AbortSignal.timeout(5_000) });
      if (r.ok) {
        const j = await r.json() as { subscriptions: Array<{ id: number; owner: string; created_at: number; active: boolean }> };
        const mine = j.subscriptions
          .filter((s) => s.owner.toLowerCase() === opts.ownerPubkeyHex.toLowerCase() && s.created_at >= opts.afterUnixSec)
          .sort((a, b) => b.created_at - a.created_at);
        if (mine.length > 0) return mine[0].id;
      }
    } catch (e) { lastErr = (e as Error).message; }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  if (lastErr) process.stderr.write(`(snapshot poll: ${lastErr})\n`);
  return null;
}

async function subscribe(opts: {
  predicate: string;
  webhook: string;
  amount: string;
  key: string;
  contractHash: string;
  nodeRpcUrl: string;
  chainName: 'casper-test' | 'casper';
  csprCloudToken?: string;
  watch?: boolean;
  apiUrl?: string;
}): Promise<void> {
  const predicateRaw = readFileSync(opts.predicate, 'utf8');
  const parsed = parsePredicateJson(predicateRaw); // throws on bad shape
  const predicateMin = JSON.stringify(parsed);

  const motes = BigInt(opts.amount) * CSPR_PER_MOTE;
  if (motes <= 0n) throw new Error('amount must be positive');

  const signer = await CasperClient.loadKey(opts.key);

  const handler = new HttpHandler(opts.nodeRpcUrl);
  if (opts.csprCloudToken) handler.setCustomHeaders({ authorization: opts.csprCloudToken });
  const rpc = new RpcClient(handler);

  // Build create_subscription tx.
  const stored = new StoredTarget();
  const invocation = new TransactionInvocationTarget();
  invocation.byHash = new Hash(hexToBytes(stripPrefix(opts.contractHash)));
  stored.runtime = 'VmCasperV1';
  stored.id = invocation;
  const target = new TransactionTarget(undefined, stored);

  const callArgs = Args.fromMap({
    predicate_json: CLValueString.newCLString(predicateMin),
    webhook_url: CLValueString.newCLString(opts.webhook),
    // Native CSPR attached to a payable entrypoint travels via the `amount`
    // arg in the transaction. Odra payable entry-points read this through
    // `self.env().attached_value()`.
    amount: CLValueUInt512.newCLUInt512(motes.toString()),
  });

  const fixedMode = new FixedMode();
  fixedMode.gasPriceTolerance = 2;
  fixedMode.additionalComputationFactor = 0;
  const pricingMode = new PricingMode();
  pricingMode.fixed = fixedMode;

  const payload = TransactionV1Payload.build({
    initiatorAddr: new InitiatorAddr(signer.publicKey),
    ttl: new Duration(30 * 60 * 1000),
    args: callArgs,
    timestamp: new Timestamp(new Date()),
    entryPoint: new TransactionEntryPoint(TransactionEntryPointEnum.Custom, 'create_subscription'),
    scheduling: new TransactionScheduling({}),
    transactionTarget: target,
    chainName: opts.chainName,
    pricingMode,
  });

  const tx = TransactionV1.makeTransactionV1(payload);
  await tx.sign(signer);

  console.log(`submitting create_subscription tx to ${opts.nodeRpcUrl} ...`);
  const res = await rpc.putTransactionV1(tx);
  const txHash = (res as unknown as { transactionHash: TransactionHash }).transactionHash;
  const hex = txHash.transactionV1?.toHex() ?? txHash.deploy?.toHex();
  console.log('submitted.');
  console.log(`  tx_hash: ${hex}`);
  console.log(`  initiator: ${signer.publicKey.toHex()}`);
  console.log(`  amount: ${opts.amount} CSPR (${motes} motes)`);
  console.log(`  webhook: ${opts.webhook}`);

  if (!opts.watch) {
    console.log('Subscription id is assigned by the contract; check the SubscriptionCreated event on cspr.live.');
    return;
  }

  const apiUrl = opts.apiUrl ?? process.env.SLUICE_API_URL ?? 'https://sluice.unitynodes.com/api';
  const submittedAt = Math.floor(Date.now() / 1000);
  process.stdout.write(`\n⏳ waiting for matcher to see the new subscription on chain (up to 120s)…`);
  const newId = await awaitNewSubId({
    ownerPubkeyHex: signer.publicKey.toHex(),
    afterUnixSec: submittedAt - 10,        // slack for clock skew
    apiUrl,
    timeoutMs: 120_000,
  });
  if (newId === null) {
    process.stdout.write(`\n  did not appear in matcher snapshot, check cspr.live for SubscriptionCreated, then run\n  sluice tail --sub <id>\n`);
    return;
  }
  process.stdout.write(`\n✓ subscription id: ${newId}\n→ tailing deliveries (ctrl-c to quit)\n\n`);
  await tailDeliveries({ apiUrl, sub: String(newId), json: false });
}

function stripPrefix(s: string): string {
  return s.replace(/^(hash-|contract-|0x)/, '');
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`bad hex length ${hex.length}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.substr(i, 2), 16);
  return out;
}

/* ──────────────────────────── sluice ai ──────────────────────────── */

async function runAi(opts: {
  prompt: string;
  validate: boolean;
  apply: boolean;
  webhook?: string;
  amount?: string;
  key?: string;
  contractHash?: string;
  rpcUrl?: string;
  chainName?: 'casper-test' | 'casper';
  csprCloudToken?: string;
  watch?: boolean;
  apiUrl: string;
  json: boolean;
}): Promise<void> {
  const { parseNaturalLanguage } = await import('./ai');
  const parsed = parseNaturalLanguage(opts.prompt);
  if (opts.json) {
    console.log(JSON.stringify({ predicate: parsed.predicate, understood: parsed.understood, unknown: parsed.unknown }, null, 2));
    if (opts.apply && parsed.predicate) await applyParsedPredicate(parsed.predicate, opts);
    return;
  }
  const colour = process.stdout.isTTY;
  const c = (col: string, s: string) => colour ? `\x1b[${col}m${s}\x1b[0m` : s;
  console.log(c('1', `\nsluice ai, interpreting: "${opts.prompt}"\n`));
  if (parsed.predicate === null) {
    console.log(c('31', "  couldn't extract any conditions from that prompt"));
    console.log(c('2', '  try something like: "transfers over 100k CSPR to <64-hex-account-hash>"'));
    process.exit(1);
  }
  console.log(c('33', '  understood:'));
  for (const u of parsed.understood) console.log(`    · ${u}`);
  if (parsed.unknown.length > 0) {
    console.log(c('33', '  ignored:'));
    for (const u of parsed.unknown) console.log(`    · ${c('31', u)}`);
  }
  console.log(c('33', '\n  predicate:\n'));
  console.log(JSON.stringify(parsed.predicate, null, 2));
  if (opts.validate) {
    const base = opts.apiUrl.replace(/\/api$/, '').replace(/\/$/, '');
    try {
      const r = await fetch(`${base}/api/predicate/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ predicate: parsed.predicate }),
        signal: AbortSignal.timeout(8_000),
      });
      const v = await r.json() as { matches: number; total_scanned: number; estimated_per_day: number | null };
      console.log(c('33', `\n  validated against recent buffer: ${v.matches}/${v.total_scanned} would have matched${v.estimated_per_day != null ? ` (~${v.estimated_per_day}/day)` : ''}\n`));
    } catch (e) {
      console.log(c('31', `\n  validate failed: ${(e as Error).message}\n`));
    }
  } else {
    console.log('');
  }
  if (opts.apply) await applyParsedPredicate(parsed.predicate!, opts);
}

/**
 * Take a parsed predicate and run the existing `sluice subscribe` flow with it
 * as if the user had hand-written a JSON file. Requires --webhook + --amount.
 */
async function applyParsedPredicate(
  predicate: unknown,
  opts: { webhook?: string; amount?: string; key?: string; contractHash?: string; rpcUrl?: string; chainName?: 'casper-test' | 'casper'; csprCloudToken?: string; watch?: boolean; apiUrl: string }
): Promise<void> {
  if (!opts.webhook) throw new Error('--apply needs --webhook <url>');
  if (!opts.amount) throw new Error('--apply needs --amount <cspr>');
  if (!opts.key && !process.env.SLUICE_KEY) throw new Error('--apply needs --key <pem> (or SLUICE_KEY env)');
  if (!opts.contractHash && !process.env.SLUICE_CONTRACT_HASH) throw new Error('--apply needs --contract-hash (or SLUICE_CONTRACT_HASH env)');
  const { writeFileSync, unlinkSync, mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  // A predictable path in a shared /tmp lets another user pre-create the name
  // as a symlink. Own the directory instead, and keep the predicate private.
  const dir = mkdtempSync(join(tmpdir(), 'sluice-ai-'));
  const tmp = join(dir, 'predicate.json');
  writeFileSync(tmp, JSON.stringify(predicate, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    await subscribe({
      predicate: tmp,
      webhook: opts.webhook,
      amount: opts.amount,
      key: opts.key ?? process.env.SLUICE_KEY!,
      contractHash: opts.contractHash ?? process.env.SLUICE_CONTRACT_HASH!,
      nodeRpcUrl: opts.rpcUrl ?? process.env.SLUICE_NODE_RPC_URL ?? 'https://node.testnet.casper.network/rpc',
      chainName: (opts.chainName ?? (process.env.SLUICE_CHAIN_NAME as 'casper-test' | 'casper') ?? 'casper-test'),
      csprCloudToken: opts.csprCloudToken ?? process.env.SLUICE_CSPR_CLOUD_TOKEN,
      watch: opts.watch,
      apiUrl: opts.apiUrl,
    });
  } finally {
    try { unlinkSync(tmp); } catch { /* fine */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
  }
}

/* ──────────────────────────── sluice sandbox ──────────────────────────── */

async function sandbox(opts: { webhook: string; predicate?: string; count: string; apiUrl: string; json: boolean }): Promise<void> {
  if (!opts.webhook) throw new Error('--webhook (http or https URL) required');
  const count = Math.max(1, Math.min(Number(opts.count), 10));
  let predicate: unknown = null;
  if (opts.predicate) {
    const { readFileSync } = await import('node:fs');
    predicate = JSON.parse(readFileSync(opts.predicate, 'utf8'));
  }
  const base = opts.apiUrl.replace(/\/api$/, '').replace(/\/$/, '');
  const res = await fetch(`${base}/api/sandbox/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ webhook: opts.webhook, predicate, count }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json() as { delivered: number; requested: number; matched_in_buffer: number; used_synthetic: boolean; results: Array<{ ok: boolean; statusCode?: number; attempts: number; latency_ms: number; event_hash: string }> };
  if (opts.json) { console.log(JSON.stringify(data, null, 2)); return; }
  const colour = process.stdout.isTTY;
  const c = (col: string, s: string) => colour ? `\x1b[${col}m${s}\x1b[0m` : s;
  console.log(c('1', `\nSandbox dispatch → ${opts.webhook}\n`));
  console.log(`  matched in buffer: ${data.matched_in_buffer}`);
  console.log(`  synthetic events:  ${data.used_synthetic ? 'yes' : 'no'}`);
  console.log(`  delivered:         ${data.delivered}/${data.requested}`);
  console.log('');
  for (const [i, r] of data.results.entries()) {
    const stat = r.ok ? c('32', String(r.statusCode ?? '?')) : c('31', String(r.statusCode ?? 'no-response'));
    console.log(`  [${i + 1}] ${stat.padEnd(13)}  ${(r.latency_ms + 'ms').padEnd(7)}  attempts:${r.attempts}  ${r.event_hash.slice(0, 16)}…`);
  }
  console.log(c('2', '\n  no CSPR was spent · no on-chain record · matcher sub_0 is the sandbox lane'));
  console.log('');
  if (data.delivered < data.requested) process.exit(2);
}

/* ──────────────────────────── sluice repl ──────────────────────────── */

async function startRepl(opts: { apiUrl: string }): Promise<void> {
  const readline = await import('node:readline');
  const colour = process.stdout.isTTY;
  const c = (col: string, s: string) => colour ? `\x1b[${col}m${s}\x1b[0m` : s;
  const base = opts.apiUrl.replace(/\/api$/, '').replace(/\/$/, '');
  let lastJson: unknown = null;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: c('1', 'sluice> '),
  });

  const help = () => {
    console.log(`
${c('1', 'Sluice REPL, interactive client')}     api: ${c('36', opts.apiUrl)}

  ${c('33', 'subs')}                    list active subscriptions
  ${c('33', 'sub <id>')}                show one subscription
  ${c('33', 'events [<id>]')}           recent deliveries (filter by sub)
  ${c('33', 'head')}                    Casper testnet head block
  ${c('33', 'health')}                  matcher health
  ${c('33', 'metrics [<grep>]')}        Prometheus exposition (optional substring filter)
  ${c('33', 'validate <json>')}         dry-run a predicate against the recent buffer
  ${c('33', 'explain <pred>|<event>')}  pipe-separated: explain trace for one event
  ${c('33', 'ai <prompt>')}             plain-English → predicate JSON (offline)
  ${c('33', 'play <scenario>')}         walk a guided demo (whale-watch | health | ai-parser)
  ${c('33', 'last')}                    re-print last response as JSON
  ${c('33', 'set api <url>')}           change the matcher base URL
  ${c('33', 'help, exit, quit')}        you know
`);
  };

  /**
   * Guided demos that walk new users through real API calls with
   * explanatory text. Each step does an API call and prints the result.
   */
  const SCENARIOS: Record<string, { title: string; steps: Array<{ note: string; cmd: string; arg: string }> }> = {
    'whale-watch': {
      title: 'Spot whales, define a filter, dry-run it, see why one event matched',
      steps: [
        { note: 'health-check the matcher first', cmd: 'health', arg: '' },
        { note: 'count how many recent transfers ≥ 100k CSPR would have matched', cmd: 'validate', arg: '{"and":[{"field":"amount","op":"gte","value":"100000000000000"}]}' },
        { note: 'now ask: which conditions passed for one sample event?', cmd: 'explain', arg: '{"and":[{"field":"amount","op":"gte","value":"100000000000000"},{"field":"to_account_hash","op":"starts_with","value":"dc"}]} | {"id":0,"deploy_hash":"abc","block_height":0,"transform_key":null,"transfer_index":0,"initiator_account_hash":"00","from_purse":"u","to_purse":"u","to_account_hash":"dc725246306b8ebfb6623feca7f777c4e9f52c96691cdccf338b797480787c9c","amount":"5000000000000","timestamp":"2026-06-30T05:00:00Z"}' },
        { note: 'and finally what live subs are running this predicate-style?', cmd: 'subs', arg: '' },
      ],
    },
    health: {
      title: 'Quick infra sanity sweep',
      steps: [
        { note: 'matcher liveness', cmd: 'health', arg: '' },
        { note: 'chain head, confirm matcher RPC works', cmd: 'head', arg: '' },
        { note: 'webhook delivery success metric', cmd: 'metrics', arg: 'sluice_webhook_results_total' },
        { note: 'active subscription count', cmd: 'subs', arg: '' },
      ],
    },
    'ai-parser': {
      title: 'Tour the offline NL → predicate parser with five real phrasings',
      steps: [
        { note: 'whale watcher, over + recipient', cmd: 'ai', arg: 'transfers over 100k cspr to dc725246306b8ebfb6623feca7f777c4e9f52c96691cdccf338b797480787c9c' },
        { note: 'micro-payments tipping, under N CSPR', cmd: 'ai', arg: 'transfers under 5 cspr' },
        { note: 'range, between two thresholds', cmd: 'ai', arg: 'transfers between 100 and 1000 cspr' },
        { note: 'round-CSPR amounts via ends_with', cmd: 'ai', arg: 'round amounts ending in 000000000 over 10 cspr' },
        { note: 'sender-filter via "from <hex>" + block height window', cmd: 'ai', arg: 'transfers from b383c7cc23d18bc1b42406a1b2d29fc8dba86425197b6f553d7fd61375b5e446 in block above 8m' },
        { note: 'now validate the last predicate against recent on-chain events', cmd: 'validate', arg: '{"and":[{"field":"amount","op":"gte","value":"100000000000000"}]}' },
      ],
    },
  };

  const playScenario = async (name: string) => {
    const sc = SCENARIOS[name];
    if (!sc) {
      console.log(c('31', `unknown scenario "${name}"`));
      console.log(c('2', `available: ${Object.keys(SCENARIOS).join(', ')}`));
      return;
    }
    console.log(c('1', `\n▶ ${sc.title}\n`));
    for (const [i, step] of sc.steps.entries()) {
      console.log(c('33', `\n[${i + 1}/${sc.steps.length}] ${step.note}`));
      console.log(c('2', `    > ${step.cmd}${step.arg ? ' ' + step.arg.slice(0, 80) + (step.arg.length > 80 ? '…' : '') : ''}`));
      const fn = handlers[step.cmd];
      if (fn) await fn(step.arg);
      await new Promise((r) => setTimeout(r, 800));
    }
    console.log(c('1', `\n✓ scenario complete\n`));
  };

  const renderJson = (v: unknown) => { lastJson = v; console.log(JSON.stringify(v, null, 2)); };

  const get = async (path: string) => {
    const r = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(8_000) });
    const text = await r.text();
    try { return { ok: r.ok, json: JSON.parse(text), text }; } catch { return { ok: r.ok, text }; }
  };
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await r.text();
    try { return { ok: r.ok, json: JSON.parse(text), text }; } catch { return { ok: r.ok, text }; }
  };

  const handlers: Record<string, (rest: string) => Promise<void>> = {
    async help() { help(); },
    async subs() {
      const r = await get('/api/snapshot.json');
      if (!('json' in r) || !r.json) return console.log(r.text);
      const j = r.json as { subscriptions: Array<{ id: number; active: boolean; balance: string; deliveries: number; webhook_url: string }> };
      lastJson = j;
      const rows = j.subscriptions;
      console.log(`  ${c('2', 'id  status     deliveries  balance(CSPR)  webhook')}`);
      for (const s of rows) {
        const cspr = (BigInt(s.balance) / 1_000_000_000n).toString();
        const status = s.active ? c('32', 'active  ') : c('31', 'inactive');
        const wh = s.webhook_url.length > 38 ? s.webhook_url.slice(0, 36) + '…' : s.webhook_url;
        console.log(`  ${String(s.id).padEnd(2)}  ${status}   ${String(s.deliveries).padStart(5)}  ${cspr.padStart(13)}  ${wh}`);
      }
    },
    async sub(rest) {
      const id = Number(rest.trim());
      if (!Number.isInteger(id)) return console.log('usage: sub <id>');
      const r = await get('/api/snapshot.json');
      if (!('json' in r) || !r.json) return console.log(r.text);
      const j = r.json as { subscriptions: Array<{ id: number }> };
      const found = j.subscriptions.find((s) => s.id === id);
      if (!found) return console.log(c('31', `sub_${id} not in matcher view`));
      renderJson(found);
    },
    async events(rest) {
      const filter = rest.trim() ? Number(rest.trim()) : null;
      const r = await get('/api/snapshot.json');
      if (!('json' in r) || !r.json) return console.log(r.text);
      const j = r.json as { recent_events: Array<{ subscription_id: number; timestamp: string; status: number; latency_ms: number; description: string; tx_hash?: string }> };
      const rows = filter === null ? j.recent_events : j.recent_events.filter((e) => e.subscription_id === filter);
      lastJson = rows;
      if (rows.length === 0) return console.log(c('2', '  no events in matcher buffer'));
      for (const e of rows) {
        const status = e.status === 0 ? c('33', 'pending') : e.status >= 200 && e.status < 300 ? c('32', String(e.status)) : c('31', String(e.status));
        console.log(`  ${e.timestamp.substr(11, 8)}  sub_${e.subscription_id}  ${status}  ${e.latency_ms}ms  ${e.tx_hash ? e.tx_hash.slice(0, 14) + '…' : '…'}  ${c('2', e.description)}`);
      }
    },
    async head() { const r = await get('/api/chain/head'); 'json' in r && r.json ? renderJson(r.json) : console.log(r.text); },
    async health() {
      const r = await post('/api/health', {});
      'json' in r && r.json ? renderJson(r.json) : console.log(r.text);
    },
    async metrics(rest) {
      const r = await get('/api/metrics');
      const grep = rest.trim();
      const lines = r.text.split('\n').filter((l) => !grep || l.toLowerCase().includes(grep.toLowerCase()));
      console.log(lines.join('\n'));
    },
    async validate(rest) {
      if (!rest.trim()) return console.log('usage: validate {"and":[...]}');
      let parsed: unknown;
      try { parsed = JSON.parse(rest); } catch (e) { return console.log(c('31', `JSON parse: ${(e as Error).message}`)); }
      const r = await post('/api/predicate/validate', { predicate: parsed });
      'json' in r && r.json ? renderJson(r.json) : console.log(r.text);
    },
    async explain(rest) {
      const parts = rest.split('|').map((s) => s.trim());
      if (parts.length !== 2) return console.log('usage: explain {predicate} | {event}');
      let predicate: unknown; let event: unknown;
      try { predicate = JSON.parse(parts[0]); event = JSON.parse(parts[1]); }
      catch (e) { return console.log(c('31', `JSON parse: ${(e as Error).message}`)); }
      const r = await post('/api/predicate/explain', { predicate, event });
      'json' in r && r.json ? renderJson(r.json) : console.log(r.text);
    },
    async last() { lastJson === null ? console.log(c('2', 'nothing yet')) : console.log(JSON.stringify(lastJson, null, 2)); },
    async play(rest) { await playScenario(rest.trim() || 'whale-watch'); },
    async ai(rest) {
      if (!rest.trim()) return console.log('usage: ai "watch transfers over 100k cspr to <64-hex-account>"');
      const { parseNaturalLanguage } = await import('./ai');
      const parsed = parseNaturalLanguage(rest);
      if (!parsed.predicate) { console.log(c('31', `  no conditions extracted`)); return; }
      for (const u of parsed.understood) console.log(c('2', '  · ' + u));
      lastJson = parsed.predicate;
      console.log(JSON.stringify(parsed.predicate, null, 2));
    },
    async set(rest) {
      const m = rest.trim().match(/^api\s+(.+)$/);
      if (!m) return console.log('usage: set api <url>');
      const newUrl = m[1].trim();
      opts.apiUrl = newUrl;
      console.log(c('32', `api → ${newUrl}`));
    },
  };

  help();
  rl.prompt();
  rl.on('line', async (input) => {
    const line = input.trim();
    if (!line) { rl.prompt(); return; }
    if (line === 'exit' || line === 'quit') { rl.close(); return; }
    const [cmd, ...rest] = line.split(/\s+/);
    const fn = handlers[cmd.toLowerCase()];
    if (!fn) {
      console.log(c('31', `unknown command "${cmd}", try "help"`));
    } else {
      try { await fn(rest.join(' ')); }
      catch (e) { console.log(c('31', `error: ${(e as Error).message}`)); }
    }
    rl.prompt();
  });
  rl.on('close', () => { process.stdout.write(c('2', '\nbye.\n')); process.exit(0); });
}

/* ──────────────────────────── sluice replay-last ──────────────────────────── */

async function replayLast(opts: { id: string; n: string; apiUrl: string; json: boolean }): Promise<void> {
  const subId = Number(opts.id);
  const n = Math.max(1, Math.min(Number(opts.n), 20));
  if (!Number.isInteger(subId) || subId < 0) throw new Error(`bad subscription id: ${opts.id}`);
  const base = opts.apiUrl.replace(/\/api$/, '').replace(/\/$/, '');
  const url = `${base}/api/sub/${subId}/replay-last`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ n }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json() as { requested: number; found: number; results: Array<{ event_hash: string; ok: boolean; statusCode?: number; attempts: number; latency_ms: number; timestamp: string }> };
  if (opts.json) { console.log(JSON.stringify(data, null, 2)); return; }
  const colour = process.stdout.isTTY;
  const c = (col: string, s: string) => colour ? `\x1b[${col}m${s}\x1b[0m` : s;
  console.log(c('1', `\nReplay sub_${subId}, requested ${data.requested}, found ${data.found} in matcher buffer\n`));
  if (data.found === 0) {
    console.log(c('2', '  matcher has no recent deliveries for this sub, nothing to replay'));
    console.log(c('2', '  (the recent-events ring buffer holds 20 entries; restarts wipe it)\n'));
    return;
  }
  const ok = data.results.filter((r) => r.ok).length;
  console.log(`  ${'time'.padEnd(10)}  ${'status'.padEnd(8)}  ${'attempts'.padEnd(8)}  ${'latency'.padEnd(8)}  event_hash`);
  console.log(`  ${'─'.repeat(10)}  ${'─'.repeat(8)}  ${'─'.repeat(8)}  ${'─'.repeat(8)}  ${'─'.repeat(16)}`);
  for (const r of data.results) {
    const time = r.timestamp.substr(11, 8);
    const stat = r.statusCode == null ? c('33', 'pending') :
                 r.ok ? c('32', String(r.statusCode)) : c('31', String(r.statusCode));
    console.log(`  ${time.padEnd(10)}  ${stat.padEnd(17)}  ${String(r.attempts).padEnd(8)}  ${(r.latency_ms + 'ms').padEnd(8)}  ${r.event_hash.slice(0, 16)}…`);
  }
  console.log(`\n  ${c('1', `${ok}/${data.found} succeeded`)}\n`);
  if (ok < data.found) process.exit(2);
}

/* ──────────────────────────── sluice completion ──────────────────────────── */

const COMPLETION_BASH = `# Sluice CLI completion for bash. Add to ~/.bashrc:
#   eval "$(sluice completion bash)"
# Or, system-wide:
#   sluice completion bash | sudo tee /etc/bash_completion.d/sluice >/dev/null
_sluice_completion() {
  local cur prev words cword
  _init_completion 2>/dev/null || { cur="\${COMP_WORDS[COMP_CWORD]}"; prev="\${COMP_WORDS[COMP_CWORD-1]}"; }
  local cmds="subscribe list cancel doctor watch tail replay-last completion help"
  local global_flags="--help -h --version"

  if [[ \$COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( \$(compgen -W "\$cmds \$global_flags" -- "\$cur") )
    return
  fi

  local cmd="\${COMP_WORDS[1]}"
  case "\$cmd" in
    subscribe)   COMPREPLY=( \$(compgen -W "--predicate -p --webhook -w --amount -a --key -k --contract-hash --rpc-url --chain-name --cspr-cloud-token" -- "\$cur") );;
    list)        COMPREPLY=( \$(compgen -W "--snapshot-path --json" -- "\$cur") );;
    cancel)      COMPREPLY=( \$(compgen -W "--id --key -k --contract-hash --rpc-url --chain-name" -- "\$cur") );;
    doctor)      COMPREPLY=( \$(compgen -W "--api-url --rpc-url --key -k --contract-hash" -- "\$cur") );;
    watch)       COMPREPLY=( \$(compgen -W "--api-url --interval" -- "\$cur") );;
    tail)        COMPREPLY=( \$(compgen -W "--api-url --sub --json" -- "\$cur") );;
    replay-last) COMPREPLY=( \$(compgen -W "--api-url --n --json" -- "\$cur") );;
    completion)  COMPREPLY=( \$(compgen -W "bash zsh fish" -- "\$cur") );;
    *)           COMPREPLY=( \$(compgen -W "\$global_flags" -- "\$cur") );;
  esac
  case "\$prev" in
    --predicate|-p|--key|-k)
      COMPREPLY=( \$(compgen -f -- "\$cur") );;
    --snapshot-path)
      COMPREPLY=( \$(compgen -f -- "\$cur") );;
  esac
}
complete -F _sluice_completion sluice
`;

const COMPLETION_ZSH = `#compdef sluice
# Sluice CLI completion for zsh. Add to your fpath, or:
#   sluice completion zsh > ~/.zsh-completions/_sluice && autoload -U compinit && compinit

_sluice() {
  local -a cmds
  cmds=(
    'subscribe:create a new subscription on-chain'
    'list:list active subscriptions from the matcher snapshot'
    'cancel:cancel a subscription and refund the remaining balance'
    'doctor:check environment health'
    'watch:live-follow one subscription (TUI)'
    'tail:stream live deliveries to your terminal (ws)'
    'replay-last:re-dispatch the last N deliveries for one sub'
    'completion:print shell completion script (bash|zsh|fish)'
    'help:show command help'
  )
  _arguments -C '1: :->cmd' '*:: :->args'
  case "\$state" in
    cmd) _describe -t commands 'sluice command' cmds ;;
    args)
      case "\$line[1]" in
        subscribe)   _arguments \\
                       '(-p --predicate)'{-p,--predicate}'[predicate JSON file]:file:_files -g "*.json"' \\
                       '(-w --webhook)'{-w,--webhook}'[webhook URL]:url:' \\
                       '(-a --amount)'{-a,--amount}'[CSPR to lock]:cspr:' \\
                       '(-k --key)'{-k,--key}'[subscriber secret key]:file:_files -g "*.pem"' \\
                       '--contract-hash[deployed contract hash]:hex:' \\
                       '--rpc-url[Casper node RPC URL]:url:' \\
                       '--chain-name[casper-test|casper]:name:(casper-test casper)' \\
                       '--cspr-cloud-token[CSPR.cloud bearer]:token:' ;;
        list)        _arguments '--snapshot-path[snapshot file path]:file:_files' '--json[machine-readable JSON]' ;;
        cancel)      _arguments '--id[subscription id]:n:' '(-k --key)'{-k,--key}'[key path]:file:_files -g "*.pem"' '--contract-hash[contract hash]:hex:' '--rpc-url[rpc url]:url:' '--chain-name[chain]:name:(casper-test casper)' ;;
        doctor)      _arguments '--api-url[matcher API base]:url:' '--rpc-url[node RPC]:url:' '(-k --key)'{-k,--key}'[key path]:file:_files -g "*.pem"' '--contract-hash[contract hash]:hex:' ;;
        watch)       _arguments '1:subscription id:' '--api-url[matcher API base]:url:' '--interval[ms]:ms:' ;;
        tail)        _arguments '--api-url[matcher API base]:url:' '--sub[subscription id]:n:' '--json[raw envelopes]' ;;
        replay-last) _arguments '1:subscription id:' '--api-url[matcher API base]:url:' '--n[number of events]:n:' '--json[raw output]' ;;
        completion)  _arguments '1:shell:(bash zsh fish)' ;;
      esac
      ;;
  esac
}
_sluice
`;

const COMPLETION_FISH = `# Sluice CLI completion for fish. Save with:
#   sluice completion fish > ~/.config/fish/completions/sluice.fish

complete -c sluice -f
complete -c sluice -n '__fish_use_subcommand' -a subscribe   -d 'Create a new subscription on-chain'
complete -c sluice -n '__fish_use_subcommand' -a list        -d 'List active subscriptions'
complete -c sluice -n '__fish_use_subcommand' -a cancel      -d 'Cancel a subscription and refund'
complete -c sluice -n '__fish_use_subcommand' -a doctor      -d 'Check environment health'
complete -c sluice -n '__fish_use_subcommand' -a watch       -d 'Live-follow one subscription'
complete -c sluice -n '__fish_use_subcommand' -a tail        -d 'Stream live deliveries'
complete -c sluice -n '__fish_use_subcommand' -a replay-last -d 'Replay last N deliveries for one sub'
complete -c sluice -n '__fish_use_subcommand' -a completion  -d 'Print shell completion script'

complete -c sluice -n '__fish_seen_subcommand_from subscribe' -s p -l predicate -r -d 'predicate JSON file'
complete -c sluice -n '__fish_seen_subcommand_from subscribe' -s w -l webhook -r -d 'webhook URL'
complete -c sluice -n '__fish_seen_subcommand_from subscribe' -s a -l amount -r -d 'CSPR to lock'
complete -c sluice -n '__fish_seen_subcommand_from subscribe' -s k -l key -r -d 'subscriber secret key'

complete -c sluice -n '__fish_seen_subcommand_from list' -l snapshot-path -r
complete -c sluice -n '__fish_seen_subcommand_from list' -l json

complete -c sluice -n '__fish_seen_subcommand_from doctor' -l api-url -r
complete -c sluice -n '__fish_seen_subcommand_from doctor' -l rpc-url -r
complete -c sluice -n '__fish_seen_subcommand_from doctor' -s k -l key -r
complete -c sluice -n '__fish_seen_subcommand_from doctor' -l contract-hash -r

complete -c sluice -n '__fish_seen_subcommand_from watch' -l api-url -r
complete -c sluice -n '__fish_seen_subcommand_from watch' -l interval -r

complete -c sluice -n '__fish_seen_subcommand_from tail' -l api-url -r
complete -c sluice -n '__fish_seen_subcommand_from tail' -l sub -r
complete -c sluice -n '__fish_seen_subcommand_from tail' -l json

complete -c sluice -n '__fish_seen_subcommand_from replay-last' -l api-url -r
complete -c sluice -n '__fish_seen_subcommand_from replay-last' -l n -r
complete -c sluice -n '__fish_seen_subcommand_from replay-last' -l json

complete -c sluice -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish'
`;

function printCompletion(shell: string): void {
  switch (shell) {
    case 'bash': process.stdout.write(COMPLETION_BASH); break;
    case 'zsh':  process.stdout.write(COMPLETION_ZSH);  break;
    case 'fish': process.stdout.write(COMPLETION_FISH); break;
    default:
      console.error(`unknown shell "${shell}", try one of: bash, zsh, fish`);
      process.exit(1);
  }
}

/* ──────────────────────────── sluice tail ──────────────────────────── */

async function tailDeliveries(opts: { apiUrl: string; sub?: string; json: boolean }): Promise<void> {
  // Dynamic-load ws so users running just `sluice subscribe` don't pay for it.
  const { default: WSClient } = await import('ws') as unknown as { default: typeof import('ws') };
  const base = opts.apiUrl.replace(/\/api$/, '').replace(/\/$/, '');
  const wsUrl = base.replace(/^http/, 'ws') + '/api/stream' + (opts.sub ? `?sub=${encodeURIComponent(opts.sub)}` : '');

  const colour = process.stdout.isTTY;
  const c = (col: string, s: string) => colour ? `\x1b[${col}m${s}\x1b[0m` : s;
  console.log(c('2', `connecting to ${wsUrl} …`));

  let backoff = 1_000;
  let stopped = false;
  process.on('SIGINT', () => { stopped = true; process.exit(0); });
  process.on('SIGTERM', () => { stopped = true; process.exit(0); });

  while (!stopped) {
    await new Promise<void>((resolve) => {
      const ws = new WSClient(wsUrl);
      ws.on('open', () => { backoff = 1_000; console.log(c('32', `▶ stream open${opts.sub ? ` · filtering sub_${opts.sub}` : ''}`)); });
      ws.on('message', (raw) => {
        // Stream frames are network controlled; strip newlines inline at each
        // log call so a crafted payload cannot forge extra log lines.
        const text = raw.toString().replace(/\n|\r/g, '');
        if (opts.json) { console.log(text); return; }
        let env: { type?: string; data?: { subscription_id?: number; event_hash?: string; description?: string; status?: number; attempts?: number; latency_ms?: number; tx_hash?: string }; ts?: string };
        try { env = JSON.parse(text); } catch { console.log(text); return; }
        const ts = (env.ts || '').substr(11, 8);
        switch (env.type) {
          case 'hello':
            console.log(c('2', `  ↳ hello ${JSON.stringify(env.data)}`.replace(/\n|\r/g, '')));
            break;
          case 'subs.reload':
            console.log(`${c('2', ts)}  ${c('33', '↻ subs.reload')}  ${JSON.stringify(env.data).replace(/\n|\r/g, '')}`);
            break;
          case 'delivery': {
            const d = env.data || {};
            const s = d.status ?? 0;
            const statusFmt =
              s === 0 ? c('33', 'pending') :
              s >= 200 && s < 300 ? c('32', String(s)) :
              c('31', String(s));
            const tx = d.tx_hash ? c('36', d.tx_hash.slice(0, 14) + '…') : c('2', '…');
            const subStr = c('1', `sub_${d.subscription_id ?? '?'}`);
            const desc = String(d.description || '').replace(/\n|\r/g, '');
            console.log(`${c('2', ts)}  ${subStr}  ${statusFmt.padEnd(15)}  ${(d.latency_ms || 0) + 'ms'}  ${tx}  ${c('2', desc)}`);
            break;
          }
          default:
            console.log(text);
        }
      });
      ws.on('close', () => { console.log(c('31', `✗ stream closed, reconnecting in ${backoff}ms`)); setTimeout(resolve, backoff); backoff = Math.min(backoff * 2, 15_000); });
      ws.on('error', (e: Error) => { console.log(c('31', `✗ ${e.message}`)); try { ws.close(); } catch {} });
    });
    if (stopped) break;
  }
}

/* ──────────────────────────── sluice watch ──────────────────────────── */

interface SnapshotV1 {
  contract_hash: string;
  chain: string;
  updated_at: string;
  subscriptions: Array<{ id: number; owner: string; webhook_url: string; balance: string; deliveries: number; active: boolean }>;
  recent_events: Array<{
    subscription_id: number;
    event_hash: string;
    description: string;
    status: number;
    attempts: number;
    latency_ms: number;
    timestamp: string;
    tx_hash?: string;
  }>;
}

async function fetchSnapshot(apiBase: string): Promise<SnapshotV1> {
  const base = apiBase.replace(/\/api$/, '').replace(/\/$/, '');
  const res = await fetch(`${base}/api/snapshot.json`, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from snapshot`);
  return await res.json() as SnapshotV1;
}

async function watchSubscription(opts: { id: string; apiUrl: string; intervalMs: number }): Promise<void> {
  const subId = Number(opts.id);
  if (!Number.isInteger(subId) || subId < 0) throw new Error(`bad subscription id: ${opts.id}`);
  if (!process.stdout.isTTY) throw new Error('sluice watch needs a TTY, pipe-friendly output is not supported, try `sluice list --json` instead');

  const colour = (col: string, s: string) => `\x1b[${col}m${s}\x1b[0m`;
  const clear = () => process.stdout.write('\x1b[H\x1b[2J');
  const cursorOff = () => process.stdout.write('\x1b[?25l');
  const cursorOn = () => process.stdout.write('\x1b[?25h');

  let running = true;
  let tick = 0;
  let lastErr: string | null = null;

  const onKey = (chunk: Buffer) => {
    const k = chunk.toString();
    if (k === 'q' || k === 'Q' || k === '' /* ctrl-c */) {
      running = false;
    }
  };
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onKey);
  }
  cursorOff();
  const cleanup = () => {
    cursorOn();
    if (process.stdin.isTTY) {
      process.stdin.removeListener('data', onKey);
      try { process.stdin.setRawMode(false); } catch {}
      process.stdin.pause();
    }
  };
  process.on('SIGINT', () => { running = false; });
  process.on('SIGTERM', () => { running = false; });

  const fmtRel = (iso: string) => {
    const dt = Date.now() - Date.parse(iso);
    if (!Number.isFinite(dt)) return '?';
    if (dt < 5000) return 'just now';
    if (dt < 60_000) return `${Math.floor(dt / 1000)}s ago`;
    if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`;
    return `${Math.floor(dt / 3_600_000)}h ago`;
  };
  const statusGlyph = (s: number) =>
    s === 0 ? colour('33', '⚠ pending') :
    s >= 200 && s < 300 ? colour('32', `✓ ${s}`) :
    colour('31', `✗ ${s}`);

  while (running) {
    tick++;
    let snap: SnapshotV1 | null = null;
    try { snap = await fetchSnapshot(opts.apiUrl); lastErr = null; }
    catch (e) { lastErr = (e as Error).message; }

    clear();
    const w = Math.max(60, Math.min(process.stdout.columns || 90, 120));
    const rule = '─'.repeat(w - 2);
    process.stdout.write(`${colour('1', `sluice watch sub_${subId}`)}  ${colour('2', `· ${opts.apiUrl} · tick ${tick}`)}\n`);
    process.stdout.write(`╭${rule}╮\n`);

    if (lastErr) {
      process.stdout.write(`│ ${colour('31', `network error: ${lastErr}`)}\n`);
    } else if (!snap) {
      process.stdout.write(`│ ${colour('2', 'waiting for snapshot…')}\n`);
    } else {
      const sub = snap.subscriptions.find((s) => s.id === subId);
      if (!sub) {
        process.stdout.write(`│ ${colour('33', `subscription ${subId} not in matcher's current view`)}\n`);
        process.stdout.write(`│ ${colour('2', `known ids: ${snap.subscriptions.map((s) => s.id).join(', ')}`)}\n`);
      } else {
        const cspr = (BigInt(sub.balance) / 1_000_000_000n).toString();
        const status = sub.active ? colour('32', 'ACTIVE') : colour('31', 'INACTIVE');
        process.stdout.write(`│ ${status}  ${colour('1', `${sub.deliveries} deliveries`)}  ${colour('36', `${cspr} CSPR locked`)}\n`);
        process.stdout.write(`│ ${colour('2', `webhook: ${sub.webhook_url}`)}\n`);
        process.stdout.write(`│ ${colour('2', `snapshot updated ${fmtRel(snap.updated_at)}`)}\n`);
        process.stdout.write(`├${rule}┤\n`);
        const rows = snap.recent_events.filter((e) => e.subscription_id === subId).slice(0, 12);
        if (rows.length === 0) {
          process.stdout.write(`│ ${colour('2', 'no deliveries yet in matcher recent-events buffer')}\n`);
        } else {
          process.stdout.write(`│ ${colour('1', 'time'.padEnd(12))} ${'status'.padEnd(11)} ${'attempts'.padEnd(9)} ${'latency'.padEnd(8)} ${'tx'.padEnd(14)}\n`);
          for (const r of rows) {
            const ts = r.timestamp.substr(11, 8);
            const tx = r.tx_hash ? r.tx_hash.slice(0, 12) + '…' : colour('2', ',  pending , ');
            process.stdout.write(`│ ${ts.padEnd(12)} ${statusGlyph(r.status).padEnd(20)} ${String(r.attempts).padEnd(9)} ${(r.latency_ms + 'ms').padEnd(8)} ${tx}\n`);
          }
        }
      }
    }
    process.stdout.write(`╰${rule}╯\n`);
    process.stdout.write(`${colour('2', `press q to quit · refresh every ${opts.intervalMs}ms`)}\n`);

    const start = Date.now();
    while (running && Date.now() - start < opts.intervalMs) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  clear();
  cleanup();
  process.exit(0);
}

/* ──────────────────────────── sluice doctor ──────────────────────────── */

interface DoctorCheck { name: string; status: 'ok' | 'warn' | 'fail'; detail: string }

async function rpcCall(url: string, method: string, params: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const j = await res.json() as { result?: unknown; error?: { message?: string } };
    if (j.error) return { ok: false, error: j.error.message ?? JSON.stringify(j.error) };
    return { ok: true, result: j.result };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function probeMatcherApi(apiUrl: string): Promise<DoctorCheck> {
  try {
    const res = await fetch(`${apiUrl.replace(/\/$/, '')}/health`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { name: 'matcher API', status: 'fail', detail: `HTTP ${res.status} from ${apiUrl}` };
    const j = await res.json() as { contract?: string; chain?: string };
    return { name: 'matcher API', status: 'ok', detail: `${apiUrl} · contract ${(j.contract ?? '').slice(0, 12)}… · chain ${j.chain}` };
  } catch (e) {
    return { name: 'matcher API', status: 'fail', detail: `unreachable: ${(e as Error).message}` };
  }
}

async function probeCasperClient(): Promise<DoctorCheck> {
  return new Promise((res) => {
    const { spawn } = require('node:child_process');
    const child = spawn('casper-client', ['--version']);
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('error', () => res({ name: 'casper-client', status: 'fail', detail: 'not on PATH, install via `cargo install casper-client`' }));
    child.on('close', (code: number) => {
      if (code !== 0) res({ name: 'casper-client', status: 'fail', detail: `exit ${code}` });
      else res({ name: 'casper-client', status: 'ok', detail: out.trim() });
    });
  });
}

async function probeKey(keyPath: string | undefined, rpcUrl: string): Promise<DoctorCheck[]> {
  if (!keyPath) return [{ name: 'subscriber key', status: 'warn', detail: 'SLUICE_KEY not set, skipping balance check' }];
  try {
    const signer = await CasperClient.loadKey(keyPath);
    const pub = signer.publicKey.toHex();
    const checks: DoctorCheck[] = [
      { name: 'subscriber key', status: 'ok', detail: `${pub.slice(0, 12)}…` },
    ];
    const accountHash = signer.publicKey.accountHash().toHex();
    const balRes = await rpcCall(rpcUrl, 'query_balance', { purse_identifier: { main_purse_under_account_hash: `account-hash-${accountHash}` } });
    if (balRes.ok && balRes.result && typeof (balRes.result as { balance?: string }).balance === 'string') {
      const motes = BigInt((balRes.result as { balance: string }).balance);
      const cspr = Number(motes / 1_000_000_000n);
      const status: DoctorCheck['status'] = cspr >= 20 ? 'ok' : cspr >= 5 ? 'warn' : 'fail';
      checks.push({ name: 'subscriber balance', status, detail: `${cspr} CSPR` });
    } else {
      checks.push({ name: 'subscriber balance', status: 'warn', detail: `could not query: ${balRes.error}` });
    }
    return checks;
  } catch (e) {
    return [{ name: 'subscriber key', status: 'fail', detail: (e as Error).message }];
  }
}

async function probeRpc(rpcUrl: string): Promise<DoctorCheck> {
  const r = await rpcCall(rpcUrl, 'info_get_status', null);
  if (!r.ok) return { name: 'node RPC', status: 'fail', detail: `${rpcUrl}, ${r.error}` };
  const status = r.result as { chainspec_name?: string; last_added_block_info?: { height?: number } };
  const h = status.last_added_block_info?.height;
  return { name: 'node RPC', status: 'ok', detail: `${rpcUrl} · chain ${status.chainspec_name ?? '?'} · head ${h ?? '?'}` };
}

function probeEnv(name: string, label: string, required: boolean): DoctorCheck {
  const v = process.env[name];
  if (v) return { name: label, status: 'ok', detail: `${name} set (${v.slice(0, 8)}…)` };
  return { name: label, status: required ? 'fail' : 'warn', detail: `${name} not set` };
}

async function probeSnapshot(apiUrl: string): Promise<DoctorCheck> {
  try {
    const base = apiUrl.replace(/\/api$/, '').replace(/\/$/, '');
    const res = await fetch(`${base}/api/snapshot.json`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return { name: 'snapshot', status: 'warn', detail: `HTTP ${res.status}` };
    const j = await res.json() as { updated_at?: string; subscriptions?: unknown[] };
    if (!j.updated_at) return { name: 'snapshot', status: 'warn', detail: 'missing updated_at' };
    const ageSec = (Date.now() - Date.parse(j.updated_at)) / 1000;
    const status: DoctorCheck['status'] = ageSec < 120 ? 'ok' : ageSec < 600 ? 'warn' : 'fail';
    const subs = Array.isArray(j.subscriptions) ? j.subscriptions.length : 0;
    return { name: 'snapshot', status, detail: `${Math.round(ageSec)}s old · ${subs} subs` };
  } catch (e) {
    return { name: 'snapshot', status: 'warn', detail: (e as Error).message };
  }
}

async function doctor(opts: { apiUrl: string; rpcUrl: string; key?: string; contractHash?: string; fix?: boolean }): Promise<void> {
  const colour = process.stdout.isTTY;
  const c = (col: string, s: string) => colour ? `\x1b[${col}m${s}\x1b[0m` : s;
  const glyph = { ok: c('32', '✓'), warn: c('33', '⚠'), fail: c('31', '✗') };

  console.log(c('1', '\nSluice, environment check' + (opts.fix ? ' (with --fix)' : '') + '\n'));

  // If --fix is on, try to repair the easy missing-bits BEFORE probing so the
  // probes see the repaired state. We attempt: missing key, missing
  // contract hash from env, missing CSPR.cloud token (instructions only).
  const fixLog: string[] = [];
  if (opts.fix) {
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const keyPath = opts.key ?? process.env.SLUICE_KEY;
    if (keyPath) {
      try { await fs.access(keyPath); }
      catch {
        // missing, try to generate via casper-client keygen
        const dir = path.dirname(keyPath);
        await fs.mkdir(dir, { recursive: true });
        const { spawn } = await import('node:child_process');
        const result = await new Promise<{ code: number; out: string }>((res) => {
          const child = spawn('casper-client', ['keygen', dir]);
          let out = '';
          child.stdout?.on('data', (d) => { out += d.toString(); });
          child.stderr?.on('data', (d) => { out += d.toString(); });
          child.on('close', (code) => res({ code: code ?? -1, out }));
          child.on('error', (e) => res({ code: -1, out: e.message }));
        });
        if (result.code === 0) {
          fixLog.push(`generated keypair at ${dir} (faucet the pubkey at https://testnet.cspr.cloud/tools/faucet)`);
        } else {
          fixLog.push(`could not generate keypair: ${result.out.slice(0, 200)}`);
        }
      }
    }
    if (!opts.contractHash && !process.env.SLUICE_CONTRACT_HASH) {
      // We can't invent a contract hash, but we can suggest the live testnet one.
      fixLog.push("contract hash is missing, using the live testnet contract for this run; set SLUICE_CONTRACT_HASH=f3710eaf12c30346eb1c642da832bc1af8ff900254c46bcc49a1efca81d8b971 in your env for your own deploy");
      opts.contractHash = 'f3710eaf12c30346eb1c642da832bc1af8ff900254c46bcc49a1efca81d8b971';
    }
    if (!process.env.SLUICE_CSPR_CLOUD_TOKEN) {
      fixLog.push("CSPR.cloud token still missing, get one free at https://cspr.cloud then export SLUICE_CSPR_CLOUD_TOKEN=…");
    }
  }

  const checks: DoctorCheck[] = [];
  checks.push(probeEnv('SLUICE_CSPR_CLOUD_TOKEN', 'CSPR.cloud token', false));
  if (opts.contractHash) {
    checks.push({ name: 'contract hash', status: /^[0-9a-f]{64}$/i.test(opts.contractHash) ? 'ok' : 'fail',
      detail: opts.contractHash });
  } else {
    checks.push({ name: 'contract hash', status: 'fail', detail: 'SLUICE_CONTRACT_HASH not set' });
  }
  checks.push(await probeCasperClient());
  checks.push(await probeRpc(opts.rpcUrl));
  checks.push(...(await probeKey(opts.key, opts.rpcUrl)));
  checks.push(await probeMatcherApi(opts.apiUrl));
  checks.push(await probeSnapshot(opts.apiUrl));

  const nameWidth = Math.max(...checks.map((c) => c.name.length));
  for (const ch of checks) {
    console.log(`  ${glyph[ch.status]}  ${ch.name.padEnd(nameWidth)}   ${ch.detail}`);
  }

  if (fixLog.length > 0) {
    console.log(c('1', '\n  fix actions:'));
    for (const m of fixLog) console.log(`    ${c('33', '→')} ${m}`);
  }

  const summary = checks.reduce((a, c) => { a[c.status]++; return a; }, { ok: 0, warn: 0, fail: 0 });
  console.log('');
  const verdict = summary.fail > 0
    ? c('31;1', `${summary.fail} fail · ${summary.warn} warn · ${summary.ok} ok, fix the fails before subscribing`)
    : summary.warn > 0
    ? c('33;1', `${summary.ok} ok · ${summary.warn} warn, you can subscribe, but check the warnings`)
    : c('32;1', `${summary.ok} ok, ready to subscribe`);
  console.log(`  ${verdict}\n`);
  if (!opts.fix && summary.fail > 0) {
    console.log(c('2', '  tip: re-run with `sluice doctor --fix` to auto-repair what we can.\n'));
  }
  if (summary.fail > 0) process.exit(1);
}

async function listSubscriptions(opts: { snapshotPath: string; json: boolean }): Promise<void> {
  const { readFileSync, existsSync } = await import('node:fs');
  if (!existsSync(opts.snapshotPath)) {
    console.error(`no matcher snapshot at ${opts.snapshotPath}, is sluice-matcher running with SLUICE_SNAPSHOT_PATH set?`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(opts.snapshotPath, 'utf8')) as {
    contract_hash: string;
    chain: string;
    updated_at: string;
    subscriptions: Array<{ id: number; owner: string; webhook_url: string; balance: string; deliveries: number; active: boolean }>;
  };
  if (opts.json) {
    console.log(JSON.stringify(raw, null, 2));
    return;
  }
  console.log(`Sluice, ${raw.chain}, snapshot ${raw.updated_at}`);
  console.log(`Contract: ${raw.contract_hash}`);
  if (raw.subscriptions.length === 0) { console.log('No subscriptions.'); return; }
  console.log('');
  console.log(' id │ status   │ deliveries │ balance (CSPR) │ webhook');
  console.log('────┼──────────┼────────────┼────────────────┼────────────────────────────');
  for (const s of raw.subscriptions) {
    const status = s.active ? 'active' : 'inactive';
    const cspr = (BigInt(s.balance) / 1_000_000_000n).toString();
    const webhook = s.webhook_url.length > 30 ? s.webhook_url.slice(0, 28) + '…' : s.webhook_url;
    console.log(` ${String(s.id).padStart(2)} │ ${status.padEnd(8)} │ ${String(s.deliveries).padStart(10)} │ ${cspr.padStart(14)} │ ${webhook}`);
  }
}

async function main(): Promise<void> {
  const program = new Command();
  program.name('sluice').description('Sluice, on-chain event subscriptions on Casper');

  program
    .command('cancel')
    .description('cancel a subscription (owner-only) and refund the remaining balance')
    .requiredOption('--id <n>', 'subscription id')
    .option('-k, --key <pemPath>', 'subscriber secret key PEM', process.env.SLUICE_KEY)
    .option('--contract-hash <hex>', 'deployed registry contract hash', process.env.SLUICE_CONTRACT_HASH)
    .option('--rpc-url <url>', 'open Casper node RPC URL', process.env.SLUICE_NODE_RPC_URL ?? 'https://node.testnet.casper.network/rpc')
    .option('--chain-name <name>', 'casper-test | casper', process.env.SLUICE_CHAIN_NAME ?? 'casper-test')
    .action(async (opts) => {
      if (!opts.key) throw new Error('--key (or SLUICE_KEY env) is required');
      if (!opts.contractHash) throw new Error('--contract-hash (or SLUICE_CONTRACT_HASH env) is required');
      const { spawn } = await import('node:child_process');
      const child = spawn('casper-client', [
        'put-transaction', 'package',
        '--node-address', opts.rpcUrl,
        '--secret-key', opts.key,
        '--chain-name', opts.chainName,
        '--pricing-mode', 'classic',
        '--payment-amount', '5000000000',
        '--gas-price-tolerance', '1',
        '--standard-payment', 'true',
        '--package-address', `package-${opts.contractHash}`,
        '--session-entry-point', 'cancel_subscription',
        '--transaction-runtime', 'vm-casper-v1',
        '--session-arg', `id:u32='${opts.id}'`,
      ], { stdio: 'inherit' });
      await new Promise<void>((resolve, reject) => {
        child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
      });
    });

  program
    .command('list')
    .description('list active subscriptions from the running matcher snapshot')
    .option('--snapshot-path <path>', 'snapshot file path', process.env.SLUICE_SNAPSHOT_PATH ?? '/tmp/sluice-snapshot.json')
    .option('--json', 'machine-readable JSON output', false)
    .action(listSubscriptions);

  program
    .command('replay-last <id>')
    .description('re-dispatch the last N deliveries for one subscription in a single call (no on-chain re-record)')
    .option('--api-url <url>', 'Sluice matcher API base', process.env.SLUICE_API_URL ?? 'https://sluice.unitynodes.com/api')
    .option('--n <count>', 'how many recent deliveries to replay (1..20)', '10')
    .option('--json', 'machine-readable JSON output', false)
    .action(async (id, opts) => {
      await replayLast({ id, n: opts.n, apiUrl: opts.apiUrl, json: opts.json });
    });

  program
    .command('ai <prompt>')
    .description('build a predicate from plain English, offline rule-based parser, no LLM')
    .option('--validate', 'dry-run the result against the matcher recent buffer', false)
    .option('--apply',    'after parsing, run `sluice subscribe` with the result (needs --webhook + --amount)', false)
    .option('-w, --webhook <url>', 'webhook URL (required with --apply)')
    .option('-a, --amount <cspr>', 'CSPR to lock (required with --apply)')
    .option('-k, --key <pemPath>', 'subscriber key (with --apply; defaults to SLUICE_KEY)', process.env.SLUICE_KEY)
    .option('--contract-hash <hex>', 'contract hash (with --apply; defaults to SLUICE_CONTRACT_HASH)', process.env.SLUICE_CONTRACT_HASH)
    .option('--rpc-url <url>', 'Casper node RPC URL', process.env.SLUICE_NODE_RPC_URL ?? 'https://node.testnet.casper.network/rpc')
    .option('--chain-name <name>', 'casper-test | casper', process.env.SLUICE_CHAIN_NAME ?? 'casper-test')
    .option('--cspr-cloud-token <tok>', 'CSPR.cloud bearer (auth header)', process.env.SLUICE_CSPR_CLOUD_TOKEN)
    .option('--watch', 'after submit, tail the new subscription live', false)
    .option('--api-url <url>', 'Sluice matcher API base', process.env.SLUICE_API_URL ?? 'https://sluice.unitynodes.com/api')
    .option('--json', 'machine-readable JSON output', false)
    .action((prompt, opts) => runAi({
      prompt, validate: opts.validate, apply: opts.apply, webhook: opts.webhook, amount: opts.amount,
      key: opts.key, contractHash: opts.contractHash, rpcUrl: opts.rpcUrl, chainName: opts.chainName,
      csprCloudToken: opts.csprCloudToken, watch: opts.watch, apiUrl: opts.apiUrl, json: opts.json,
    }));

  program
    .command('sandbox')
    .description('fire N webhooks at a URL with no on-chain effect, for receiver development')
    .requiredOption('-w, --webhook <url>', 'webhook URL to POST to')
    .option('-p, --predicate <path>', 'optional predicate JSON, filter the recent buffer first')
    .option('--count <n>', 'how many events to send (1..10)', '3')
    .option('--api-url <url>', 'Sluice matcher API base', process.env.SLUICE_API_URL ?? 'https://sluice.unitynodes.com/api')
    .option('--json', 'machine-readable JSON output', false)
    .action(sandbox);

  program
    .command('repl')
    .description('interactive REPL, subs, events, head, validate, explain, metrics in one shell')
    .option('--api-url <url>', 'Sluice matcher API base', process.env.SLUICE_API_URL ?? 'https://sluice.unitynodes.com/api')
    .action(async (opts) => {
      await startRepl({ apiUrl: opts.apiUrl });
    });

  program
    .command('completion <shell>')
    .description('print a shell completion script, pipe into your rc file. Supports bash, zsh, fish.')
    .action((shell) => printCompletion(String(shell)));

  program
    .command('tail')
    .description('stream live deliveries from the matcher in your terminal (ws). Companion to `watch`.')
    .option('--api-url <url>', 'Sluice matcher API base', process.env.SLUICE_API_URL ?? 'https://sluice.unitynodes.com/api')
    .option('--sub <id>', 'only emit deliveries for one subscription id')
    .option('--json', 'emit raw JSON envelopes (one per line)', false)
    .action(tailDeliveries);

  program
    .command('watch <id>')
    .description('live-follow a subscription, terminal redraws every 2s with balance, deliveries, recent webhook results')
    .option('--api-url <url>', 'Sluice matcher API base', process.env.SLUICE_API_URL ?? 'https://sluice.unitynodes.com/api')
    .option('--interval <ms>', 'poll interval in milliseconds', '2000')
    .action(async (id, opts) => {
      await watchSubscription({ id, apiUrl: opts.apiUrl, intervalMs: Number(opts.interval) });
    });

  program
    .command('doctor')
    .description('check environment health, keys, balances, RPC, matcher API, snapshot freshness')
    .option('--api-url <url>', 'Sluice matcher API base', process.env.SLUICE_API_URL ?? 'https://sluice.unitynodes.com/api')
    .option('--rpc-url <url>', 'Casper node RPC URL', process.env.SLUICE_NODE_RPC_URL ?? 'https://node.testnet.casper.network/rpc')
    .option('-k, --key <pemPath>', 'subscriber secret key PEM', process.env.SLUICE_KEY)
    .option('--contract-hash <hex>', 'deployed registry contract hash', process.env.SLUICE_CONTRACT_HASH)
    .option('--fix', 'attempt to repair missing keys / contract / token before probing', false)
    .action(doctor);

  program
    .command('subscribe')
    .description('create a new subscription on-chain')
    .requiredOption('-p, --predicate <path>', 'predicate JSON file')
    .requiredOption('-w, --webhook <url>', 'webhook URL to receive events')
    .requiredOption('-a, --amount <cspr>', 'CSPR to lock into escrow (integer)')
    .option('-k, --key <pemPath>', 'subscriber secret key PEM', process.env.SLUICE_KEY)
    .option('--contract-hash <hex>', 'deployed registry contract entity hash', process.env.SLUICE_CONTRACT_HASH)
    .option('--rpc-url <url>', 'Casper node RPC URL', process.env.SLUICE_NODE_RPC_URL ?? 'https://node.testnet.cspr.cloud/rpc')
    .option('--chain-name <name>', 'casper-test | casper', process.env.SLUICE_CHAIN_NAME ?? 'casper-test')
    .option('--cspr-cloud-token <tok>', 'CSPR.cloud bearer (auth header)', process.env.SLUICE_CSPR_CLOUD_TOKEN)
    .option('--watch', 'after submit, poll matcher snapshot for the new sub id and tail it live', false)
    .option('--api-url <url>', 'Sluice matcher API base (for --watch)', process.env.SLUICE_API_URL ?? 'https://sluice.unitynodes.com/api')
    .action(async (opts) => {
      if (!opts.key) throw new Error('--key (or SLUICE_KEY env) is required');
      if (!opts.contractHash) throw new Error('--contract-hash (or SLUICE_CONTRACT_HASH env) is required');
      await subscribe(opts);
    });

  await program.parseAsync(process.argv);
}

if (require.main === module) {
  main().catch((e) => { console.error('error:', e.message); process.exit(1); });
}
