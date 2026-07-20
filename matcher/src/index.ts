/**
 * Matcher entry point.
 *
 *   1. Connect to CSPR.cloud Transfer streaming WS.
 *   2. Periodically reload active subscriptions from the contract.
 *   3. For each incoming Transfer, evaluate predicates → dispatch webhooks + record_delivery.
 *
 * Run via `sluice-matcher` bin, configured by env vars:
 *
 *   SLUICE_CONTRACT_HASH          deployed registry contract entity hash (64-hex)
 *   SLUICE_MATCHER_KEY_PATH       path to matcher's secret_key.pem
 *   SLUICE_NODE_RPC_URL           default https://node.testnet.cspr.cloud/rpc
 *   SLUICE_STREAMING_WS_URL       default wss://streaming.testnet.cspr.cloud/transfer
 *   SLUICE_CSPR_CLOUD_TOKEN       bearer token for CSPR.cloud Streaming + Node
 *   SLUICE_CHAIN_NAME             default casper-test
 *   SLUICE_POLL_SUBS_MS           default 30000
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { CasperClient } from './casper';
import { parsePredicateJson, type ContractStateReader } from './contract';
import { evaluate, validatePredicate as assertPredicate, PredicateError } from './predicate';
import { startApi, type ApiStreamEnvelope } from './api';
import { dispatchWebhook, computeIdempotencyKey } from './webhook';
import { WatchContractsReader, parseWatchList, type NormalizedContractEvent } from './watch-contracts';
import type { Subscription, TransferEvent, MatcherConfig, StreamEnvelope, Predicate } from './types';

import WebSocket from 'ws';

const RECORD_DELIVERY_SH = resolve(__dirname, '..', '..', 'scripts', 'record-delivery.sh');

const log = (...a: unknown[]) => {
  const line = a.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ').replace(/\n|\r/g, '');
  console.log('[matcher]', new Date().toISOString(), line);
};

function loadConfig(): MatcherConfig {
  const need = (k: string): string => {
    const v = process.env[k];
    if (!v) { throw new Error(`missing required env var ${k}`); }
    return v;
  };
  return {
    csprCloudToken: need('SLUICE_CSPR_CLOUD_TOKEN'),
    streamingWsUrl: process.env.SLUICE_STREAMING_WS_URL ?? 'wss://streaming.testnet.cspr.cloud/transfers',
    nodeRpcUrl: process.env.SLUICE_NODE_RPC_URL ?? 'https://node.testnet.cspr.cloud/rpc',
    chainName: (process.env.SLUICE_CHAIN_NAME as 'casper-test' | 'casper') ?? 'casper-test',
    contractHash: need('SLUICE_CONTRACT_HASH'),
    matcherKeyPath: need('SLUICE_MATCHER_KEY_PATH'),
    pollSubscriptionsIntervalMs: Number(process.env.SLUICE_POLL_SUBS_MS ?? 30000),
    snapshotPath: process.env.SLUICE_SNAPSHOT_PATH,
    watchContracts: parseWatchList(process.env.SLUICE_WATCH_CONTRACTS),
    // Subscription ids that are off-chain demo lanes (injected, no on-chain
    // escrow). Their deliveries are real, but they skip record_delivery so the
    // matcher does not submit a reverting on-chain tx for a non-existent sub.
    demoSubs: new Set(
      (process.env.SLUICE_DEMO_SUBS ?? '')
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
    // Subscription ids billed via x402 pay-per-delivery instead of push+escrow.
    // For these, a match is not webhooked; it is queued and delivered only when
    // an agent pays an x402 micropayment to pull it (see claimX402Event).
    x402Subs: new Set(
      (process.env.SLUICE_X402_SUBS ?? '')
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  };
}

/**
 * Renders a shields.io-style SVG status badge, embed in README via
 * `<img src="https://sluice.unitynodes.com/api/badge.svg">`.
 */
function renderBadge(activeSubs: number, totalDeliveries: number, ok: boolean): string {
  // totalDeliveries sums each subscription's on-chain `deliveries` counter, so
  // it counts receipts, not webhook dispatches. Say which one, otherwise it
  // reads as a contradiction against the dispatch total in /api/metrics.
  const right = `${totalDeliveries} on-chain · ${activeSubs} active`;
  const labelW = 50;
  const valueW = Math.max(60, right.length * 7 + 14);
  const totalW = labelW + valueW;
  const bg = ok ? '#3edc64' : '#ff2d2e';
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20" role="img" aria-label="sluice: ${right}">
  <title>sluice: ${right}</title>
  <linearGradient id="g" x2="0" y2="100%">
    <stop offset="0" stop-color="#fff" stop-opacity=".12"/>
    <stop offset="1" stop-opacity=".12"/>
  </linearGradient>
  <mask id="m"><rect width="${totalW}" height="20" rx="3" fill="#fff"/></mask>
  <g mask="url(#m)">
    <rect width="${labelW}" height="20" fill="#000"/>
    <rect x="${labelW}" width="${valueW}" height="20" fill="${bg}"/>
    <rect width="${totalW}" height="20" fill="url(#g)"/>
  </g>
  <g text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="${labelW / 2}" y="15" fill="#bcfc07" font-weight="bold">sluice</text>
    <text x="${labelW + valueW / 2}" y="15" fill="#000" font-weight="bold">${right}</text>
  </g>
</svg>`;
}

interface RecentEvent {
  subscription_id: number;
  event_hash: string;
  description: string;
  status: number;          // 0 if not yet POSTed
  attempts: number;
  latency_ms: number;
  timestamp: string;
  tx_hash?: string;
  /** Full Transfer payload, kept so the dashboard can replay this delivery. */
  event?: TransferEvent;
  /** Snapshot of the subscription's webhook URL at delivery time. */
  webhook_url?: string;
}

/**
 * Result of a predicate dry-run against the recent-events buffer. Drives the
 * landing playground's ⚡ Dry-run button so users see how many real, recent
 * Transfers their filter would have matched before they spend gas.
 */
export interface ValidationResult {
  matches: number;
  total_scanned: number;
  sample_matches: TransferEvent[];     // up to 5 matched events, newest first
  time_window_seconds: number;          // span between oldest and newest event scanned
  estimated_per_day: number | null;     // matches normalised to a 24h rate; null if window < 60s
  source: 'live' | 'sample' | 'mixed';  // honest about whether seed data is in the mix
}

/** Histogram buckets for webhook latency, in milliseconds (cumulative). */
const LATENCY_BUCKETS_MS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as const;

interface MatcherCounters {
  startedAtMs: number;
  deliveriesTotal: number;
  webhookOk: number;
  webhookFail: number;
  webhookAttempts: number;            // cumulative attempt count across all dispatches
  recordDeliveryOk: number;
  recordDeliveryFail: number;
  latencyHistogram: number[];         // index == LATENCY_BUCKETS_MS index; final slot is +Inf
  latencySumMs: number;
  latencyCount: number;
  wsTransfers: boolean;
  wsContractEvents: boolean;          // set externally by the contract-events reader (best-effort)
  wsContractWatch: boolean;           // connected to at least one external watched-contract stream
}

export interface MetricsSnapshot extends MatcherCounters {
  activeSubscriptions: number;
  inactiveSubscriptions: number;
  validationBufferSize: number;
  validationBufferSeeded: number;
}

/** Pluggable broadcaster, wired by index.ts to the API's StreamHub. */
type Broadcast = (env: Omit<ApiStreamEnvelope, 'ts'>) => void;

export class Matcher {
  private broadcast: Broadcast = () => { /* no-op until wired */ };
  private active: Subscription[] = [];
  /**
   * Every subscription the reader returned, active or not. `active` is already
   * filtered, so deriving an inactive count from it always yielded zero.
   */
  private allSubs: Subscription[] = [];
  private ws: WebSocket | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = 1_000;
  private recentEvents: RecentEvent[] = [];
  /** Ring buffer of every Transfer the matcher saw, fuels POST /predicate/validate. */
  private validationEvents: TransferEvent[] = [];
  private liveEventCount = 0;          // events observed since process start
  private seededEventCount = 0;        // events loaded from sample file on cold-start
  static MAX_RECENT = 20;
  static MAX_VALIDATION = 1000;
  // Cap concurrent casper-client record_delivery subprocesses so a burst of
  // matched events cannot fork an unbounded number of signing processes.
  private recordSlots = Number(process.env.SLUICE_MAX_RECORD_DELIVERY_CONCURRENCY ?? 4);
  private recordWaiters: Array<() => void> = [];
  // x402 pay-per-delivery: matched events for x402-billed subs wait here until an
  // agent pays an x402 micropayment to pull one. x402Last keeps the most recent
  // match per sub so a drained queue still serves a real event.
  private x402Pending = new Map<number, RecentEvent[]>();
  private x402Last = new Map<number, RecentEvent>();
  static MAX_X402_PENDING = 100;

  private counters: MatcherCounters = {
    startedAtMs: Date.now(),
    deliveriesTotal: 0,
    webhookOk: 0,
    webhookFail: 0,
    webhookAttempts: 0,
    recordDeliveryOk: 0,
    recordDeliveryFail: 0,
    latencyHistogram: new Array(LATENCY_BUCKETS_MS.length + 1).fill(0),
    latencySumMs: 0,
    latencyCount: 0,
    wsTransfers: false,
    wsContractEvents: false,
    wsContractWatch: false,
  };

  constructor(
    private readonly cfg: MatcherConfig,
    private readonly reader: ContractStateReader,
  ) {
    this.maybeSeedValidationBuffer();
    this.maybeSeedRecentFromSnapshot();
  }

  setBroadcaster(fn: Broadcast): void { this.broadcast = fn; }

  /**
   * Restore the recent-events feed from the last snapshot on the disk so a
   * matcher restart does not blank the dashboard's activity list. Testnet
   * events are sparse, so an empty feed after every deploy reads as "nothing
   * ever happened"; reloading the last snapshot keeps continuity.
   */
  private maybeSeedRecentFromSnapshot(): void {
    const p = this.cfg.snapshotPath;
    if (!p || !existsSync(p)) return;
    try {
      const snap = JSON.parse(readFileSync(p, 'utf8'));
      const rows = Array.isArray(snap?.recent_events) ? snap.recent_events : [];
      this.recentEvents = rows.slice(0, Matcher.MAX_RECENT) as RecentEvent[];
      if (this.recentEvents.length) log(`recent feed seeded with ${this.recentEvents.length} events from ${p}`);
    } catch (e) {
      log(`recent seed failed at ${p}: ${(e as Error).message}`);
    }
  }

  private maybeSeedValidationBuffer(): void {
    const candidates = [
      process.env.SLUICE_VALIDATION_SAMPLE_PATH,
      resolve(__dirname, '..', '..', 'examples', 'transfer-events-sample.json'),
      resolve(process.cwd(), 'examples', 'transfer-events-sample.json'),
    ].filter((p): p is string => !!p);
    for (const p of candidates) {
      if (!existsSync(p)) continue;
      try {
        const raw = JSON.parse(readFileSync(p, 'utf8'));
        if (!Array.isArray(raw)) return;
        for (const ev of raw.slice(0, Matcher.MAX_VALIDATION)) {
          if (ev && typeof ev === 'object' && typeof (ev as TransferEvent).amount === 'string') {
            this.validationEvents.push(ev as TransferEvent);
            this.seededEventCount++;
          }
        }
        log(`validation buffer seeded with ${this.seededEventCount} events from ${p}`);
        return;
      } catch (e) {
        log(`validation seed failed at ${p}: ${(e as Error).message}`);
      }
    }
  }

  async start(): Promise<void> {
    // Sanity-check the matcher key exists and parses. Throws if missing.
    await CasperClient.loadKey(this.cfg.matcherKeyPath);
    await this.reloadSubscriptions();
    this.reloadTimer = setInterval(
      () => this.reloadSubscriptions().catch((e) => log('reload error:', e)),
      this.cfg.pollSubscriptionsIntervalMs,
    );
    this.connect();
  }

  async stop(): Promise<void> {
    if (this.reloadTimer) clearInterval(this.reloadTimer);
    if (this.ws) this.ws.close();
  }

  private async reloadSubscriptions(): Promise<void> {
    const subs = await this.reader.loadActiveSubscriptions();
    this.allSubs = subs;
    this.active = subs.filter((s) => s.active);
    log(`subscriptions reloaded, ${this.active.length} active`);

    this.broadcast({ type: 'subs.reload', data: { active: this.active.length, total: subs.length, updated_at: new Date().toISOString() } });
    if (this.cfg.snapshotPath) {
      const { writeFile } = await import('node:fs/promises');
      const path = await import('node:path');
      const snapshot = {
        contract_hash: this.cfg.contractHash,
        chain: this.cfg.chainName,
        updated_at: new Date().toISOString(),
        subscriptions: subs,
        recent_events: this.recentEvents.slice(0, Matcher.MAX_RECENT),
      };
      try {
        await writeFile(this.cfg.snapshotPath, JSON.stringify(snapshot, null, 2));
        const totalDeliveries = subs.reduce((a, s) => a + (s.deliveries || 0), 0);
        const activeCount = subs.filter(s => s.active).length;
        const badge = renderBadge(activeCount, totalDeliveries, this.counters.wsTransfers);
        const badgePath = path.join(path.dirname(this.cfg.snapshotPath), 'badge.svg');
        await writeFile(badgePath, badge);
      } catch (e) {
        log(`snapshot write failed: ${(e as Error).message}`);
      }
    }
  }

  private connect(): void {
    log(`connecting to ${this.cfg.streamingWsUrl}`);
    const ws = new WebSocket(this.cfg.streamingWsUrl, {
      headers: { authorization: this.cfg.csprCloudToken },
    });
    this.ws = ws;

    ws.on('open', () => {
      log('ws open');
      this.reconnectDelay = 1_000;
      this.counters.wsTransfers = true;
    });

    ws.on('message', (raw: Buffer) => {
      const text = raw.toString();
      // CSPR.cloud sends string "Ping" keepalives, drop silently.
      if (text === 'Ping') return;
      try {
        const env = JSON.parse(text) as StreamEnvelope<TransferEvent>;
        void this.handleEnvelope(env);
      } catch (e) {
        log('ws parse error:', (e as Error).message, '->', text.slice(0, 80));
      }
    });

    ws.on('error', (e) => log('ws error:', (e as Error).message));

    ws.on('close', (code, reason) => {
      log(`ws close (${code}) ${reason.toString()}`);
      this.counters.wsTransfers = false;
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      setTimeout(() => this.connect(), delay);
    });
  }

  private async handleEnvelope(env: StreamEnvelope<TransferEvent>): Promise<void> {
    const event = env.data;
    if (!event || typeof event !== 'object') return;
    this.recordForValidation(event);

    const matches = this.active.filter((sub) => sub.active && this.safeMatch(sub, event));
    // Dispatch matched subscriptions concurrently: a slow or failing webhook for
    // one subscriber must not delay delivery to the others for the same event.
    await Promise.all(matches.map((sub) => {
      if (this.cfg.x402Subs?.has(sub.id)) { this.enqueueX402(sub, event); return Promise.resolve(); }
      log(`match sub=${sub.id} deploy_hash=${event.deploy_hash} amount=${event.amount}`);
      return this.dispatch(sub, event).catch((e) => log(`dispatch error sub=${sub.id}:`, (e as Error).message));
    }));
  }

  /** Evaluate a predicate without letting a malformed one throw out of the match loop. */
  private safeMatch(sub: Subscription, event: TransferEvent): boolean {
    try { return evaluate(sub.predicate, event); }
    catch { return false; }
  }

  /**
   * Feed a normalized external contract event (DeFi/RWA) through the same
   * predicate + dispatch path as native transfers. Predicates that filter on
   * `event_type == "contract"`, `name`, `contract_package_hash`, or `data.*`
   * match here; amount/to_account_hash transfer predicates naturally do not.
   */
  async ingestContractEvent(ev: NormalizedContractEvent): Promise<void> {
    const event = ev as unknown as TransferEvent;
    const matches = this.active.filter((sub) => sub.active && this.safeMatch(sub, event));
    await Promise.all(matches.map((sub) => {
      if (this.cfg.x402Subs?.has(sub.id)) { this.enqueueX402(sub, event); return Promise.resolve(); }
      log(`contract-event match sub=${sub.id} name=${ev.name} pkg=${ev.contract_package_hash.slice(0, 8)}…`);
      return this.dispatch(sub, event).catch((e) => log(`dispatch error sub=${sub.id}:`, (e as Error).message));
    }));
  }

  /** Flag for /metrics + status: are we connected to any watched-contract stream. */
  setContractWatchConnected(connected: boolean): void {
    this.counters.wsContractWatch = connected;
  }

  /** Bounded-concurrency gate for record_delivery subprocess spawns. */
  private async acquireRecordSlot(): Promise<void> {
    if (this.recordSlots > 0) { this.recordSlots--; return; }
    await new Promise<void>((resolve) => this.recordWaiters.push(resolve));
  }
  private releaseRecordSlot(): void {
    const next = this.recordWaiters.shift();
    if (next) next();
    else this.recordSlots++;
  }

  /**
   * A CES event name is chosen by whoever deployed the contract, and we watch
   * third-party contracts. Keep it to identifier characters so the name cannot
   * smuggle markup into any consumer that renders the description.
   */
  private safeEventName(name: unknown): string {
    const s = String(name ?? '').replace(/[^A-Za-z0-9_.-]/g, '');
    return s.slice(0, 64) || 'event';
  }

  /** Human one-liner for an event, shared by the webhook feed and x402 queue. */
  private describeEvent(event: TransferEvent): string {
    if ((event as { event_type?: string }).event_type === 'contract') {
      const ce = event as unknown as NormalizedContractEvent;
      const pkgShort = ce.contract_package_hash ? `${ce.contract_package_hash.slice(0, 6)}…` : '…';
      return `Contract · ${this.safeEventName(ce.name)} @ ${pkgShort}`;
    }
    const csprStr = (() => {
      try { const m = BigInt(String(event.amount)); const c = m / 1_000_000_000n; return c >= 1n ? `${c.toLocaleString('en-US')} CSPR` : `${event.amount} motes`; }
      catch { return `${event.amount} motes`; }
    })();
    const toShort = event.to_account_hash ? `${event.to_account_hash.slice(0, 6)}…${event.to_account_hash.slice(-4)}` : '…';
    return `Transfer · ${csprStr} → ${toShort}`;
  }

  /** Queue a match for an x402-billed sub instead of pushing it. */
  private enqueueX402(sub: Subscription, event: TransferEvent): void {
    const row: RecentEvent = {
      subscription_id: sub.id,
      event_hash: computeIdempotencyKey(event),
      description: this.describeEvent(event),
      status: 402,
      attempts: 0,
      latency_ms: 0,
      timestamp: new Date().toISOString(),
      event,
      webhook_url: '',
    };
    const q = this.x402Pending.get(sub.id) ?? [];
    q.push(row);
    while (q.length > Matcher.MAX_X402_PENDING) q.shift();
    this.x402Pending.set(sub.id, q);
    this.x402Last.set(sub.id, row);
    log(`x402 queued sub=${sub.id} pending=${q.length} ${row.description}`);
  }

  /**
   * Non-consuming check for whether a paid claim would return an event. Callers
   * use this to avoid settling a payment for a delivery we cannot make: the sub
   * has simply not matched anything yet (a fresh matcher process, say).
   */
  hasX402Event(subId: number): boolean {
    const q = this.x402Pending.get(subId);
    return Boolean((q && q.length) || this.x402Last.has(subId));
  }

  /**
   * Pull the next paid delivery for an x402-billed sub, called after an on-chain
   * x402 settlement. Returns the oldest queued match, or the most recent match
   * if the queue is drained, or null if the sub has never matched.
   */
  claimX402Event(subId: number, txHash?: string): RecentEvent | null {
    const q = this.x402Pending.get(subId);
    const row = (q && q.length) ? q.shift() : this.x402Last.get(subId);
    if (!row) return null;
    const delivered: RecentEvent = { ...row, status: 200, ...(txHash ? { tx_hash: txHash } : {}) };
    this.counters.deliveriesTotal++;
    this.pushEvent(delivered);
    return delivered;
  }

  private async dispatch(sub: Subscription, event: TransferEvent): Promise<void> {
    const t0 = Date.now();
    const idempotencyKey = computeIdempotencyKey(event);
    const description = this.describeEvent(event);

    const webhookSecret = process.env.SLUICE_WEBHOOK_SECRET;
    const webhookResult = await dispatchWebhook(sub.webhook_url, event, sub.id, webhookSecret ? { webhookSecret } : undefined);
    const latency = Date.now() - t0;
    const baseRow: RecentEvent = {
      subscription_id: sub.id,
      event_hash: idempotencyKey,
      description,
      status: webhookResult.statusCode ?? 0,
      attempts: webhookResult.attempts,
      latency_ms: latency,
      timestamp: new Date().toISOString(),
      event,
      webhook_url: sub.webhook_url,
    };

    this.counters.webhookAttempts += webhookResult.attempts;
    this.recordLatency(latency);
    if (!webhookResult.ok) {
      this.counters.webhookFail++;
      log(`webhook failed sub=${sub.id} idempotency=${idempotencyKey} attempts=${webhookResult.attempts}`);
      this.pushEvent(baseRow);
      return;
    }
    this.counters.webhookOk++;
    this.counters.deliveriesTotal++;
    log(`webhook ok sub=${sub.id} status=${webhookResult.statusCode} attempts=${webhookResult.attempts}`);

    if (this.cfg.demoSubs?.has(sub.id)) {
      // Off-chain demo lane: the delivery is real, but there is no on-chain
      // subscription to bill, so skip record_delivery entirely.
      this.pushEvent(baseRow);
      return;
    }

    await this.acquireRecordSlot();
    try {
      const txHash = await this.submitRecordDelivery(sub.id, idempotencyKey);
      this.counters.recordDeliveryOk++;
      log(`record_delivery submitted sub=${sub.id} tx=${txHash}`);
      this.pushEvent({ ...baseRow, tx_hash: txHash });
    } catch (e) {
      this.counters.recordDeliveryFail++;
      log(`record_delivery failed sub=${sub.id}: ${(e as Error).message}`);
      this.pushEvent(baseRow);
    } finally {
      this.releaseRecordSlot();
    }
  }

  private recordLatency(ms: number): void {
    this.counters.latencySumMs += ms;
    this.counters.latencyCount++;
    let placed = false;
    for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
      if (ms <= LATENCY_BUCKETS_MS[i]) {
        this.counters.latencyHistogram[i]++;
        placed = true;
        break;
      }
    }
    if (!placed) this.counters.latencyHistogram[LATENCY_BUCKETS_MS.length]++;
  }

  getMetricsSnapshot(): MetricsSnapshot {
    const active = this.active.length;
    return {
      ...this.counters,
      activeSubscriptions: active,
      inactiveSubscriptions: Math.max(0, this.allSubs.length - active),
      validationBufferSize: this.validationEvents.length,
      validationBufferSeeded: this.seededEventCount,
    };
  }

  /** Marked from outside (e.g. by the contract-events reader). Best-effort, not auth. */
  setContractEventsConnected(connected: boolean): void {
    this.counters.wsContractEvents = connected;
  }

  private pushEvent(e: RecentEvent): void {
    this.recentEvents.unshift(e);
    if (this.recentEvents.length > Matcher.MAX_RECENT) this.recentEvents.length = Matcher.MAX_RECENT;
    this.broadcast({ type: 'delivery', data: e });
  }

  private recordForValidation(event: TransferEvent): void {
    this.validationEvents.unshift(event);
    if (this.validationEvents.length > Matcher.MAX_VALIDATION) {
      this.validationEvents.length = Matcher.MAX_VALIDATION;
    }
    this.liveEventCount++;
  }

  /** Dry-run a predicate against the recent-events buffer. */
  validatePredicateAgainstRecent(predicateJson: string): ValidationResult {
    let parsed: unknown;
    try { parsed = JSON.parse(predicateJson); }
    catch (e) { throw new Error(`predicate not valid JSON: ${(e as Error).message}`); }
    try { assertPredicate(parsed); }
    catch (e) {
      if (e instanceof PredicateError) throw new Error(`predicate invalid: ${e.message}`);
      throw e;
    }
    const predicate = parsed as Predicate;
    const buf = this.validationEvents;
    const sample: TransferEvent[] = [];
    let matches = 0;
    for (const ev of buf) {
      if (evaluate(predicate, ev)) {
        matches++;
        if (sample.length < 5) sample.push(ev);
      }
    }
    const timestamps = buf
      .map((ev) => Date.parse(String(ev.timestamp ?? '')))
      .filter((t) => Number.isFinite(t));
    let window_s = 0;
    if (timestamps.length >= 2) {
      window_s = Math.max(0, (Math.max(...timestamps) - Math.min(...timestamps)) / 1000);
    }
    const perDay = window_s >= 60
      ? Math.round((matches / window_s) * 86_400 * 10) / 10
      : null;
    const source: ValidationResult['source'] =
      this.liveEventCount === 0 ? 'sample'
      : this.seededEventCount === 0 ? 'live'
      : 'mixed';
    return {
      matches,
      total_scanned: buf.length,
      sample_matches: sample,
      time_window_seconds: Math.round(window_s),
      estimated_per_day: perDay,
      source,
    };
  }

  /** Look up an active subscription, used by the .ics calendar feed. */
  getActiveSubscription(id: number): Subscription | null {
    return this.active.find((s) => s.id === id) ?? null;
  }

  /** Count deliveries for a subscription in the recent-events buffer, drives .ics rate estimate. */
  getRecentDeliveryRate(id: number): { count: number; window_seconds: number; per_day: number } {
    const rows = this.recentEvents.filter((e) => e.subscription_id === id);
    if (rows.length < 2) return { count: rows.length, window_seconds: 0, per_day: 0 };
    const ts = rows.map((r) => Date.parse(r.timestamp)).filter((t) => Number.isFinite(t));
    const window_s = (Math.max(...ts) - Math.min(...ts)) / 1000;
    const per_day = window_s >= 60 ? (rows.length / window_s) * 86_400 : 0;
    return { count: rows.length, window_seconds: Math.round(window_s), per_day };
  }

  /** Sends a synthetic Transfer event to the subscription's webhook URL, debugging shortcut. */
  async sendTestWebhook(subscriptionId: number): Promise<{ ok: boolean; statusCode?: number; attempts: number; latency_ms: number; webhook_url: string }> {
    const sub = this.active.find((s) => s.id === subscriptionId);
    if (!sub) throw new Error(`subscription ${subscriptionId} not active (or not in matcher's view yet)`);
    const synthetic: TransferEvent = {
      id: 0,
      deploy_hash: '0'.repeat(64),
      block_height: 0,
      transform_key: null,
      transfer_index: 0,
      initiator_account_hash: '00'.repeat(32),
      from_purse: 'uref-test-source-000',
      to_purse: 'uref-test-dest-000',
      to_account_hash: '00'.repeat(32),
      amount: '2500000000',
      timestamp: new Date().toISOString(),
      // marker so a receiver can route test vs real
      _sluice_test: true,
    };
    const t0 = Date.now();
    const webhookSecret = process.env.SLUICE_WEBHOOK_SECRET;
    const res = await dispatchWebhook(sub.webhook_url, synthetic, sub.id, webhookSecret ? { webhookSecret } : undefined);
    return { ok: res.ok, statusCode: res.statusCode, attempts: res.attempts, latency_ms: Date.now() - t0, webhook_url: sub.webhook_url };
  }

  /**
   * Sandbox dispatch, POST synthetic-or-buffered events to a webhook URL with
   * no on-chain effect. Subscription id is the reserved value 0 ("sandbox").
   * Drives `sluice sandbox` and the landing-page test-receiver workflow so
   * developers can iterate on their webhook handler without spending CSPR.
   */
  async sandboxDispatch(webhook: string, predicate: unknown | null, count: number): Promise<{
    delivered: number;
    requested: number;
    matched_in_buffer: number;
    used_synthetic: boolean;
    results: Array<{ ok: boolean; statusCode?: number; attempts: number; latency_ms: number; event_hash: string }>;
  }> {
    const webhookSecret = process.env.SLUICE_WEBHOOK_SECRET;
    let events: TransferEvent[] = [];
    let matchedInBuffer = 0;
    let usedSynthetic = false;
    if (predicate && typeof predicate === 'object') {
      try {
        assertPredicate(predicate);
        events = this.validationEvents.filter((ev) => evaluate(predicate as Predicate, ev)).slice(0, count);
        matchedInBuffer = events.length;
      } catch (e) {
        throw new Error(`predicate invalid: ${e instanceof PredicateError ? e.message : (e as Error).message}`);
      }
    }
    while (events.length < count) {
      usedSynthetic = true;
      const seed = this.validationEvents[events.length % Math.max(1, this.validationEvents.length)] ?? {
        id: 0, deploy_hash: '0'.repeat(64), block_height: 0, transform_key: null, transfer_index: 0,
        initiator_account_hash: '00'.repeat(32), from_purse: 'uref-sandbox-from', to_purse: 'uref-sandbox-to',
        to_account_hash: '00'.repeat(32), amount: '2500000000', timestamp: new Date().toISOString(),
      } as TransferEvent;
      events.push({ ...seed, _sluice_sandbox: true } as TransferEvent);
    }
    const results: Array<{ ok: boolean; statusCode?: number; attempts: number; latency_ms: number; event_hash: string }> = [];
    let delivered = 0;
    for (const ev of events) {
      const t0 = Date.now();
      const r = await dispatchWebhook(webhook, ev, 0, webhookSecret ? { webhookSecret } : undefined);
      if (r.ok) delivered++;
      results.push({ ok: r.ok, statusCode: r.statusCode, attempts: r.attempts, latency_ms: Date.now() - t0, event_hash: computeIdempotencyKey(ev) });
    }
    return { delivered, requested: count, matched_in_buffer: matchedInBuffer, used_synthetic: usedSynthetic, results };
  }

  /** Re-dispatches the last N deliveries for one subscription in one call (no on-chain re-record). */
  async replayLast(subscriptionId: number, n: number): Promise<{
    requested: number;
    found: number;
    results: Array<{ event_hash: string; ok: boolean; statusCode?: number; attempts: number; latency_ms: number; timestamp: string }>;
  }> {
    const candidates = this.recentEvents
      .filter((e) => e.subscription_id === subscriptionId && e.event && e.webhook_url)
      .slice(0, Math.max(1, Math.min(n, Matcher.MAX_RECENT)));
    const webhookSecret = process.env.SLUICE_WEBHOOK_SECRET;
    const results: Array<{ event_hash: string; ok: boolean; statusCode?: number; attempts: number; latency_ms: number; timestamp: string }> = [];
    for (const evt of candidates) {
      const t0 = Date.now();
      const r = await dispatchWebhook(evt.webhook_url!, evt.event!, evt.subscription_id, webhookSecret ? { webhookSecret } : undefined);
      results.push({ event_hash: evt.event_hash, ok: r.ok, statusCode: r.statusCode, attempts: r.attempts, latency_ms: Date.now() - t0, timestamp: evt.timestamp });
    }
    return { requested: n, found: candidates.length, results };
  }

  /** Re-dispatches a past delivery's webhook (Stripe-style "resend" feature). */
  async replayEvent(eventHash: string): Promise<{ ok: boolean; statusCode?: number; attempts: number; latency_ms: number }> {
    const found = this.recentEvents.find(e => e.event_hash === eventHash);
    if (!found || !found.event || !found.webhook_url) {
      throw new Error(`event ${eventHash.slice(0, 12)}… not in recent buffer or full payload missing`);
    }
    const t0 = Date.now();
    const webhookSecret = process.env.SLUICE_WEBHOOK_SECRET;
    const res = await dispatchWebhook(found.webhook_url, found.event, found.subscription_id, webhookSecret ? { webhookSecret } : undefined);
    return { ok: res.ok, statusCode: res.statusCode, attempts: res.attempts, latency_ms: Date.now() - t0 };
  }

  /**
   * Submits record_delivery via the `scripts/record-delivery.sh` casper-client
   * wrapper. Once casper-js-sdk's Stored-target serialization is fixed
   * (HONEST_LIMITS §9), switch to `this.casper.submitRecordDelivery(...)`.
   */
  private submitRecordDelivery(id: number, eventHashHex: string): Promise<string> {
    return new Promise((resolveTx, rejectTx) => {
      const child = spawn(RECORD_DELIVERY_SH, [String(id), eventHashHex], {
        env: {
          ...process.env,
          SLUICE_CONTRACT_HASH: this.cfg.contractHash,
          SLUICE_MATCHER_KEY_PATH: this.cfg.matcherKeyPath,
          SLUICE_NODE_RPC_URL: this.cfg.nodeRpcUrl,
          SLUICE_CHAIN_NAME: this.cfg.chainName,
        },
      });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('close', (code) => {
        if (code !== 0) return rejectTx(new Error(`record-delivery.sh exit ${code}: ${stderr || stdout}`));
        const m = stdout.match(/"Version1":\s*"([0-9a-f]{64})"/);
        if (!m) return rejectTx(new Error(`no tx hash in output: ${stdout.slice(0, 200)}`));
        resolveTx(m[1]);
      });
    });
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  // CSPR.cloud streaming root for the contract-events channel.
  const wsRoot = cfg.streamingWsUrl
    .replace(/\/transfers?$/, '')
    .replace(/\/contract-events.*$/, '');
  // Until we persist state across restarts, the event-stream reader cold-starts
  // empty and learns subs as they're created. SLUICE_INJECT_SUBS_FILE pre-seeds
  // a list (useful for demos where the sub already exists on chain).
  const { ContractEventStreamReader } = await import('./contract-events');
  const seed = process.env.SLUICE_INJECT_SUBS_FILE
    ? new (await import('./contract')).StaticSubscriptionReader()
    : null;
  const seedSubs = seed ? await seed.loadActiveSubscriptions() : undefined;
  const reader = new ContractEventStreamReader(wsRoot, cfg.contractHash, cfg.csprCloudToken, seedSubs);
  reader.start();

  const matcher = new Matcher(cfg, reader);
  await matcher.start();
  // Poll the registry contract-events connection into the /metrics gauge.
  setInterval(() => matcher.setContractEventsConnected(reader.connected), 5_000);

  // Optional: stream external DeFi/RWA contract events through the predicate
  // engine. Enable with SLUICE_WATCH_CONTRACTS=<pkg-hash>[,<pkg-hash>...].
  if (cfg.watchContracts && cfg.watchContracts.length > 0) {
    const watcher = new WatchContractsReader(
      wsRoot,
      cfg.watchContracts,
      cfg.csprCloudToken,
      (ev) => { void matcher.ingestContractEvent(ev); },
    );
    watcher.start();
    log(`watching ${cfg.watchContracts.length} external contract(s) for events`);
    // Poll the connected flag into metrics.
    setInterval(() => matcher.setContractWatchConnected(watcher.connected), 5_000);
  }

  // HTTP API for the dashboard (tx build + submit). Caddy reverse-proxies
  // /api/tx/* → localhost:7799 on sluice.unitynodes.com.
  const api = startApi({
    port: Number(process.env.SLUICE_API_PORT ?? 7799),
    contractHash: cfg.contractHash,
    nodeRpcUrl: process.env.SLUICE_NODE_RPC_URL_WRITE ?? cfg.nodeRpcUrl,
    chainName: cfg.chainName,
    paymentMotes: Number(process.env.SLUICE_PAYMENT_MOTES ?? 5_000_000_000),
    casperClientBin: process.env.CASPER_CLIENT_BIN ?? 'casper-client',
    replay: (eventHash) => matcher.replayEvent(eventHash),
    replayLast: (subId, n) => matcher.replayLast(subId, n),
    sandboxDispatch: (webhook, predicate, count) => matcher.sandboxDispatch(webhook, predicate, count),
    parsePrompt: (prompt) => {
      // Lazy-require to avoid circular dep, ai.ts pulls from types only.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { parseNaturalLanguage } = require('./ai') as typeof import('./ai');
      return parseNaturalLanguage(prompt);
    },
    testWebhook: (subId) => matcher.sendTestWebhook(subId),
    validatePredicate: (predicateJson) => matcher.validatePredicateAgainstRecent(predicateJson),
    getSubscription: (id) => matcher.getActiveSubscription(id),
    getDeliveryRate: (id) => matcher.getRecentDeliveryRate(id),
    claimX402: (subId, txHash) => matcher.claimX402Event(subId, txHash),
    hasX402: (subId) => matcher.hasX402Event(subId),
    getMetricsSnapshot: () => matcher.getMetricsSnapshot(),
    latencyBucketsMs: LATENCY_BUCKETS_MS as unknown as number[],
  });
  // Wire the stream hub back into the matcher so dispatches fan out to ws subscribers.
  matcher.setBroadcaster((env) => api.hub.broadcast(env));

  const shutdown = async () => { log('shutting down'); api.close(); await matcher.stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

export { parsePredicateJson };
