/**
 * ContractEventStreamReader, subscribes to the CSPR.cloud contract-events
 * WebSocket for our SubscriptionRegistry and maintains an in-memory map of
 * active subscriptions by event-sourcing the chain.
 *
 *   SubscriptionCreated   → add sub
 *   ToppedUp              → bump balance + reactivate
 *   DeliveryRecorded      → decrement balance, bump deliveries, maybe deactivate
 *   SubscriptionCancelled → set active = false
 *
 * Cold-start limitation (v0.1): CSPR.cloud streaming is live-only, so a
 * matcher restart starts from an empty map and only sees subscriptions
 * created from that point forward. For longer-running matchers, persist this
 * map to disk and reload on startup. Documented in HONEST_LIMITS §1.
 */

import WebSocket from 'ws';

import type { ContractStateReader } from './contract';
import { parsePredicateJson } from './contract';
import type { Subscription } from './types';

interface ContractEventEnvelope {
  data: {
    contract_package_hash: string;
    contract_hash: string;
    data: Record<string, unknown>;
    raw_data?: string;
    name: string;
  };
  action: string;
  extra: { block_height?: number; deploy_hash?: string; event_id?: number };
  timestamp: string;
}

const oneLine = (v: unknown) => (typeof v === 'string' ? v.replace(/[\r\n]/g, ' ') : v);
const log = (...a: unknown[]) => console.log('[contract-events]', new Date().toISOString(), ...a.map(oneLine));

// The registry flips a subscription inactive once its balance drops below the
// per-delivery cost (registry.rs record_delivery), not at exactly zero. Mirror
// that threshold so the matcher's view matches the chain. Configurable to match
// whatever delivery_unit_cost the registry was deployed with (1 CSPR default).
const DELIVERY_UNIT_COST = BigInt(process.env.SLUICE_DELIVERY_UNIT_COST ?? '1000000000');
// Cap the in-memory subscription map so a long-running matcher watching a busy
// registry does not grow unboundedly; oldest inactive entries are pruned first.
const MAX_TRACKED_SUBS = Number(process.env.SLUICE_MAX_TRACKED_SUBS ?? 2000);

export class ContractEventStreamReader implements ContractStateReader {
  private subs = new Map<number, Subscription>();
  private ws: WebSocket | null = null;
  private reconnectDelay = 1_000;
  /** True while the registry contract-events socket is open (polled into /metrics). */
  connected = false;

  constructor(
    private readonly wsUrl: string,
    private readonly contractPackageHash: string,
    private readonly token: string,
    /** Optional pre-seed (e.g. from a snapshot file) so the matcher can pick up where it left off. */
    seed?: Subscription[],
  ) {
    if (seed) {
      for (const s of seed) this.subs.set(s.id, s);
    }
  }

  /** Open the WS and start consuming events. Fire-and-forget; updates happen in the background. */
  start(): void {
    const url = `${this.wsUrl}/contract-events?contract_package_hash=${this.contractPackageHash}&includes=raw_data`;
    log('connecting', url);
    const ws = new WebSocket(url, { headers: { authorization: this.token } });
    this.ws = ws;

    ws.on('open', () => {
      log('open');
      this.reconnectDelay = 1_000;
      this.connected = true;
    });

    ws.on('message', (raw: Buffer) => {
      const text = raw.toString();
      if (text === 'Ping') return;
      let env: ContractEventEnvelope;
      try { env = JSON.parse(text) as ContractEventEnvelope; }
      catch { log('parse error:', text.slice(0, 80)); return; }
      this.apply(env);
    });

    ws.on('error', (e) => log('ws error:', (e as Error).message));
    ws.on('close', (code) => {
      this.connected = false;
      log(`ws close (${code}), reconnecting in ${this.reconnectDelay}ms`);
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      setTimeout(() => this.start(), delay);
    });
  }

  stop(): void { this.ws?.close(); }

  async loadActiveSubscriptions(): Promise<Subscription[]> {
    return Array.from(this.subs.values());
  }

  private apply(env: ContractEventEnvelope): void {
    const evt = env.data;
    if (env.action !== 'emitted') return;
    if (evt.contract_package_hash !== this.contractPackageHash) return;
    const d = evt.data;

    switch (evt.name) {
      case 'SubscriptionCreated': return this.onCreated(d, env);
      case 'DeliveryRecorded': return this.onDelivered(d, env);
      case 'SubscriptionCancelled': return this.onCancelled(d, env);
      case 'ToppedUp': return this.onToppedUp(d, env);
      default: log(`ignoring unknown event: ${evt.name}`);
    }
  }

  private onCreated(d: Record<string, unknown>, env: ContractEventEnvelope): void {
    try {
      const id = num(d.id);
      const ownerStr = String(d.owner ?? '');
      const owner = ownerStr.replace(/^Key::Account\(/, '').replace(/\)$/, '').replace(/^account-hash-/, '');
      const balance = String(d.new_balance ?? d.balance ?? '0');
      const webhook_url = String(d.webhook_url ?? '');
      const predicate_json = String(d.predicate_json ?? '');
      const sub: Subscription = {
        id, owner,
        predicate: parsePredicateJson(predicate_json),
        webhook_url, balance,
        deliveries: 0, active: true,
        created_at: env.extra.block_height ?? 0,
      };
      this.subs.set(id, sub);
      this.pruneInactive();
      log(`SubscriptionCreated id=${id} balance=${balance} webhook=${webhook_url}`);
    } catch (e) {
      log(`SubscriptionCreated parse error: ${(e as Error).message}`, JSON.stringify(d).slice(0, 200));
    }
  }

  private onDelivered(d: Record<string, unknown>, _env: ContractEventEnvelope): void {
    const id = num(d.id);
    const sub = this.subs.get(id);
    if (!sub) return;
    sub.balance = String(d.new_balance ?? sub.balance);
    sub.deliveries += 1;
    // Mirror the contract: it flips active=false once balance < unit_cost, not
    // only at exactly zero, so a non-multiple deposit deactivates correctly.
    try { if (BigInt(sub.balance) < DELIVERY_UNIT_COST) sub.active = false; }
    catch { if (sub.balance === '0') sub.active = false; }
    log(`DeliveryRecorded id=${id} new_balance=${sub.balance} deliveries=${sub.deliveries} active=${sub.active}`);
  }

  private onCancelled(d: Record<string, unknown>, _env: ContractEventEnvelope): void {
    const id = num(d.id);
    if (!this.subs.has(id)) return;
    // Cancelled subscriptions are terminal, drop them so the map stays bounded.
    this.subs.delete(id);
    log(`SubscriptionCancelled id=${id} (removed)`);
  }

  /** Keep the map bounded by evicting the oldest inactive subscriptions. */
  private pruneInactive(): void {
    if (this.subs.size <= MAX_TRACKED_SUBS) return;
    for (const [id, s] of this.subs) {
      if (this.subs.size <= MAX_TRACKED_SUBS) break;
      if (!s.active) this.subs.delete(id);
    }
  }

  private onToppedUp(d: Record<string, unknown>, _env: ContractEventEnvelope): void {
    const id = num(d.id);
    const sub = this.subs.get(id);
    if (!sub) return;
    sub.balance = String(d.new_balance ?? sub.balance);
    sub.active = true;
    log(`ToppedUp id=${id} new_balance=${sub.balance}`);
  }
}

function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return parseInt(v, 10);
  throw new Error(`expected number, got ${typeof v}: ${String(v)}`);
}
