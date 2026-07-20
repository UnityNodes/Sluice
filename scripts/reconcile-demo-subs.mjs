#!/usr/bin/env node
// Reconcile the injected demo subscriptions against on-chain truth.
//
// Injected subs (SLUICE_INJECT_SUBS_FILE) carry a static `deliveries` seed. The
// matcher increments it from live DeliveryRecorded events, but on restart it
// resets to the seed and only counts deliveries seen since boot, so the on-chain
// SubscriptionRegistry ends up ahead of the displayed counter. Balance self-heals
// (every DeliveryRecorded carries the absolute new_balance) but the delivery
// count never does.
//
// This runs before the matcher starts and rewrites each on-chain-backed sub's
// `deliveries` and `balance` to the value derived from chain:
//   deliveries = count of successful record_delivery(id) txs
//   balance    = sum(create + top_up amounts for id) - deliveries * unit_cost
// A sub with no on-chain record_delivery (pure demo/RWA lanes) is left untouched.
//
// Fail-safe: on ANY error it writes nothing and exits 0, so the matcher always
// boots with the existing seed. Wire it as a non-fatal `ExecStartPre=-`.
//
// Usage:
//   SLUICE_CSPR_CLOUD_TOKEN=… SLUICE_INJECT_SUBS_FILE=/tmp/inject-subs.json \
//     node scripts/reconcile-demo-subs.mjs [--dry-run]
//
// Env:
//   SLUICE_INJECT_SUBS_FILE   path to the inject JSON (required)
//   SLUICE_CSPR_CLOUD_TOKEN / CSPR_CLOUD_AUTH_TOKEN   CSPR.cloud bearer
//   SLUICE_CONTRACT_HASH      registry package hash (required)
//   SLUICE_MATCHER_PUBKEY     record_delivery caller (default: known matcher key)
//   SLUICE_SUBSCRIBER_PUBKEY  create/top_up caller (default: known subscriber key)
//   SLUICE_DELIVERY_UNIT_COST_MOTES  per-delivery cost (default 1e9 = 1 CSPR)
//   CSPR_CLOUD_API            API base (default https://api.testnet.cspr.cloud)

import { readFileSync, writeFileSync, renameSync } from 'node:fs';

const DRY = process.argv.includes('--dry-run');
const API = process.env.CSPR_CLOUD_API || 'https://api.testnet.cspr.cloud';
const TOKEN = process.env.SLUICE_CSPR_CLOUD_TOKEN || process.env.CSPR_CLOUD_AUTH_TOKEN || '';
const FILE = process.env.SLUICE_INJECT_SUBS_FILE || '';
const REG = (process.env.SLUICE_CONTRACT_HASH || '').replace(/^hash-/, '');
const MATCHER_PK = process.env.SLUICE_MATCHER_PUBKEY || '0115cd952be9138a261970a7ea683ed2bb798d8f33068b82ab6c31baee038e3f9d';
const SUBSCRIBER_PK = process.env.SLUICE_SUBSCRIBER_PUBKEY || '0141ae56d7afef7eb22298b50db5f013cd6945a26eab4098eebd97e9cf6064f676';
const UNIT_COST = BigInt(process.env.SLUICE_DELIVERY_UNIT_COST_MOTES || '1000000000');

// Never let the network hang the matcher's boot: hard-cap the whole run.
const DEADLINE = Date.now() + 20_000;

function bail(msg) {
  console.error(`[reconcile] skipped: ${msg}`);
  process.exit(0); // exit 0 so a non-fatal ExecStartPre still lets the matcher start
}

async function fetchJson(url) {
  const left = DEADLINE - Date.now();
  if (left <= 0) throw new Error('deadline exceeded');
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), Math.min(left, 10_000));
  try {
    const r = await fetch(url, { headers: { Authorization: TOKEN }, signal: ac.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// Page through an account's deploys, calling `onRow` for each. Returns whether
// it walked EVERY page. A partial scan (deadline hit mid-pagination) must not be
// trusted: it would undercount deliveries and could set the counter below both
// reality and the existing seed, so callers refuse to write on an incomplete run.
async function eachDeploy(pubkey, onRow) {
  let page = 1;
  let total = null;
  while (true) {
    if (Date.now() >= DEADLINE) return false;
    const d = await fetchJson(`${API}/accounts/${pubkey}/deploys?page_size=250&page=${page}`);
    const rows = d.data || [];
    total = d.item_count ?? total;
    if (rows.length === 0) return true;
    for (const r of rows) onRow(r);
    if (page * 250 >= (total || 0)) return true;
    page++;
  }
}

const argParsed = (a, k) => (a && a[k] && a[k].parsed != null ? a[k].parsed : undefined);
const isForRegistry = (r) => (r.contract_package_hash || '') === REG && !r.error_message;

async function main() {
  if (!TOKEN) bail('no CSPR.cloud token');
  if (!FILE) bail('SLUICE_INJECT_SUBS_FILE not set');
  if (!REG) bail('SLUICE_CONTRACT_HASH not set');

  let subs;
  try {
    subs = JSON.parse(readFileSync(FILE, 'utf8'));
    if (!Array.isArray(subs)) throw new Error('inject file is not a JSON array');
  } catch (e) {
    bail(`cannot read inject file: ${e.message}`);
  }

  // Count successful record_delivery per sub id (matcher is the only caller).
  const delivered = new Map();
  const fullMatcher = await eachDeploy(MATCHER_PK, (r) => {
    if (!isForRegistry(r)) return;
    const a = r.args || {};
    if ('event_hash' in a && 'id' in a) {
      const id = Number(argParsed(a, 'id'));
      if (Number.isFinite(id)) delivered.set(id, (delivered.get(id) || 0) + 1);
    }
  });
  if (!fullMatcher) bail('did not finish scanning matcher deploys within the deadline');

  // Sum locked motes (create + top_up amounts) per sub id from the subscriber.
  // create_subscription/top_up are payable, so the amount is the deploy's
  // transferred value; CSPR.cloud exposes it as the `amount`/`value` arg when it
  // can. If it does not, `locked` stays empty for that id and we leave the
  // (self-healing) balance seed alone.
  const locked = new Map();
  const fullSubscriber = await eachDeploy(SUBSCRIBER_PK, (r) => {
    if (!isForRegistry(r)) return;
    const a = r.args || {};
    if ('event_hash' in a) return; // record_delivery, not a funding call
    const idRaw = argParsed(a, 'id');
    const amount = argParsed(a, 'amount') ?? argParsed(a, 'value');
    if (idRaw == null || amount == null) return;
    const id = Number(idRaw);
    try {
      const m = BigInt(String(amount));
      if (Number.isFinite(id)) locked.set(id, (locked.get(id) || 0n) + m);
    } catch { /* ignore unparseable amount */ }
  });
  // Balance is best-effort: if the subscriber scan was incomplete, just skip the
  // balance override (deliveries above is already authoritative and complete).
  if (!fullSubscriber) locked.clear();

  let changed = 0;
  const out = subs.map((s) => {
    const id = Number(s.id);
    const d = delivered.get(id);
    if (d == null) return s; // no on-chain deliveries: pure demo lane, leave as-is
    const next = { ...s, deliveries: d };
    // Only override balance if we could reconstruct the locked total for this id;
    // otherwise leave the (self-healing) balance seed alone.
    const lk = locked.get(id);
    if (lk != null) {
      const bal = lk - UNIT_COST * BigInt(d);
      next.balance = String(bal < 0n ? 0n : bal);
    }
    if (next.deliveries !== s.deliveries || next.balance !== s.balance) {
      changed++;
      console.error(`[reconcile] sub ${id}: deliveries ${s.deliveries} -> ${next.deliveries}, balance ${s.balance} -> ${next.balance}`);
    }
    return next;
  });

  if (changed === 0) { console.error('[reconcile] nothing to change'); return; }

  const serialized = JSON.stringify(out, null, 2);
  // Validate we produced parseable JSON with the same sub count before writing.
  const check = JSON.parse(serialized);
  if (!Array.isArray(check) || check.length !== subs.length) bail('sanity check failed, refusing to write');

  if (DRY) { console.error(`[reconcile] DRY-RUN, ${changed} sub(s) would change`); return; }

  // Atomic write: temp + rename, so a crash mid-write never truncates the seed.
  const tmp = `${FILE}.reconcile.tmp`;
  writeFileSync(tmp, serialized);
  renameSync(tmp, FILE);
  console.error(`[reconcile] wrote ${changed} corrected sub(s) to ${FILE}`);
}

main().catch((e) => bail(e.message));
