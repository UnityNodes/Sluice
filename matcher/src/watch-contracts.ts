/**
 * WatchContractsReader, streams events emitted by EXTERNAL Casper contracts
 * (DeFi pools, DEX routers, RWA compliance/oracle contracts, CEP-18 tokens)
 * and normalizes each one into a predicate-friendly object, then hands it to
 * a callback that runs it through the same predicate engine + webhook path as
 * native Transfer events.
 *
 * This is what lets a Sluice subscription match a real DeFi/RWA on-chain
 * event, not just a native CSPR transfer. A predicate over a contract event
 * reads fields like:
 *
 *   { "field": "event_type",             "op": "eq", "value": "contract" }
 *   { "field": "contract_package_hash",  "op": "eq", "value": "<hex>" }
 *   { "field": "name",                   "op": "eq", "value": "Swap" }
 *   { "field": "data.amount",            "op": "gte", "value": "1000000000000" }
 *
 * Native Transfer predicates are unaffected: Transfer events carry no
 * `event_type` field, so a predicate that filters on `event_type == contract`
 * simply never matches them, and vice versa.
 *
 * Enable by setting SLUICE_WATCH_CONTRACTS to a comma-separated list of
 * contract_package_hash values (64-hex, no prefix).
 */

import WebSocket from 'ws';

/** The shape we feed into the predicate engine for a contract event. */
export interface NormalizedContractEvent {
  event_type: 'contract';
  contract_package_hash: string;
  contract_hash: string;
  name: string;
  deploy_hash: string | null;
  block_height: number | null;
  timestamp: string;
  /** The event's own fields, addressable via dot notation (e.g. data.amount). */
  data: Record<string, unknown>;
  /** Open for any unmodelled fields. */
  [extra: string]: unknown;
}

interface RawContractEnvelope {
  data?: {
    contract_package_hash?: string;
    contract_hash?: string;
    data?: Record<string, unknown>;
    name?: string;
  };
  action?: string;
  extra?: { block_height?: number; deploy_hash?: string; event_id?: number };
  timestamp?: string;
}

const log = (...a: unknown[]) => console.log('[watch-contracts]', new Date().toISOString(), ...a);

export class WatchContractsReader {
  private sockets: WebSocket[] = [];
  private reconnectDelay = new Map<string, number>();
  private stopped = false;

  /**
   * @param wsRoot        streaming root, e.g. wss://streaming.testnet.cspr.cloud
   * @param packageHashes external contract_package_hash values to watch
   * @param token         CSPR.cloud bearer token
   * @param onEvent       called with each normalized contract event
   */
  constructor(
    private readonly wsRoot: string,
    private readonly packageHashes: string[],
    private readonly token: string,
    private readonly onEvent: (e: NormalizedContractEvent) => void,
  ) {}

  /** True when at least one watched-contract socket is open. */
  connected = false;

  start(): void {
    for (const hash of this.packageHashes) this.connectOne(hash);
  }

  stop(): void {
    this.stopped = true;
    for (const ws of this.sockets) { try { ws.close(); } catch { /* ignore */ } }
    this.sockets = [];
  }

  private connectOne(packageHash: string): void {
    if (this.stopped) return;
    const url = `${this.wsRoot}/contract-events?contract_package_hash=${packageHash}&includes=raw_data`;
    log('connecting', url);
    const ws = new WebSocket(url, { headers: { authorization: this.token } });
    this.sockets.push(ws);

    ws.on('open', () => {
      log('open', packageHash.slice(0, 10) + '…');
      this.reconnectDelay.set(packageHash, 1_000);
      this.connected = true;
    });

    ws.on('message', (raw: Buffer) => {
      const text = raw.toString();
      if (text === 'Ping') return;
      let env: RawContractEnvelope;
      try { env = JSON.parse(text) as RawContractEnvelope; }
      catch { log('parse error:', text.slice(0, 80)); return; }
      const normalized = this.normalize(env);
      if (normalized) {
        try { this.onEvent(normalized); }
        catch (e) { log('onEvent error:', (e as Error).message); }
      }
    });

    ws.on('error', (e) => log('ws error:', (e as Error).message));

    ws.on('close', (code) => {
      // Drop this socket from the list.
      this.sockets = this.sockets.filter((s) => s !== ws);
      this.connected = this.sockets.length > 0;
      if (this.stopped) return;
      const delay = this.reconnectDelay.get(packageHash) ?? 1_000;
      this.reconnectDelay.set(packageHash, Math.min(delay * 2, 30_000));
      log(`ws close (${code}) for ${packageHash.slice(0, 10)}…, reconnecting in ${delay}ms`);
      setTimeout(() => this.connectOne(packageHash), delay);
    });
  }

  /** Turn a raw CSPR.cloud contract-event envelope into our predicate-friendly shape. */
  normalize(env: RawContractEnvelope): NormalizedContractEvent | null {
    if (env.action !== 'emitted') return null;
    const d = env.data;
    if (!d || !d.contract_package_hash || !d.name) return null;
    return {
      event_type: 'contract',
      contract_package_hash: d.contract_package_hash,
      contract_hash: d.contract_hash ?? '',
      name: d.name,
      deploy_hash: env.extra?.deploy_hash ?? null,
      block_height: env.extra?.block_height ?? null,
      timestamp: env.timestamp ?? new Date().toISOString(),
      data: d.data ?? {},
    };
  }
}

/** Parse SLUICE_WATCH_CONTRACTS into a clean list of 64-hex package hashes. */
export function parseWatchList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().replace(/^(hash-|contract-package-)/, '').toLowerCase())
    .filter((s) => /^[0-9a-f]{64}$/.test(s));
}
