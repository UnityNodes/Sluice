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

const log = (...a: unknown[]) => console.log('[contract-events]', new Date().toISOString(), ...a);

export class ContractEventStreamReader implements ContractStateReader {
  private subs = new Map<number, Subscription>();
  private ws: WebSocket | null = null;
  private reconnectDelay = 1_000;

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
    // Contract auto-flips active=false when balance < unit_cost. We can't see
    // unit_cost from the event, but we can derive activity from balance==0.
    if (sub.balance === '0') sub.active = false;
    log(`DeliveryRecorded id=${id} new_balance=${sub.balance} deliveries=${sub.deliveries}`);
  }

  private onCancelled(d: Record<string, unknown>, _env: ContractEventEnvelope): void {
    const id = num(d.id);
    const sub = this.subs.get(id);
    if (!sub) return;
    sub.active = false;
    sub.balance = '0';
    log(`SubscriptionCancelled id=${id}`);
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
