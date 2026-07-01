/**
 * @sluice/client, typed wrapper over the Sluice matcher HTTP + WS API.
 *
 * Quick start:
 *
 *   import { SluiceClient } from '@sluice/client';
 *   const sluice = new SluiceClient();          // defaults to https://sluice.unitynodes.com/api
 *   const subs = await sluice.subs.list();
 *
 *   // live stream
 *   const close = sluice.stream.subscribe((env) => console.log(env), { sub: 42 });
 *
 *   // dry-run a predicate before subscribing
 *   const r = await sluice.predicate.validate({ and: [{ field: 'amount', op: 'gte', value: '5000000000000' }] });
 *
 * The client uses global `fetch` (Node 18+ or any modern browser). For the
 * WebSocket stream, pass a WebSocket constructor explicitly in environments
 * that don't expose one globally (Node < 22):
 *
 *   import WS from 'ws';
 *   const sluice = new SluiceClient({ websocketCtor: WS as any });
 */

export type Operator =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'contains' | 'starts_with' | 'ends_with'
  | 'in' | 'not_in' | 'regex';

export interface Condition {
  field: string;
  op: Operator;
  value: string | number | boolean | Array<string | number>;
}

export interface Predicate { and: Condition[] }

export interface TransferEvent {
  id: number;
  deploy_hash: string;
  block_height: number;
  transform_key: string | null;
  transfer_index: number;
  initiator_account_hash: string;
  from_purse: string;
  to_purse: string;
  to_account_hash: string;
  amount: string;
  timestamp: string;
  [extra: string]: unknown;
}

export interface Subscription {
  id: number;
  owner: string;
  predicate: Predicate;
  webhook_url: string;
  balance: string;
  deliveries: number;
  active: boolean;
  created_at: number;
}

export interface RecentEvent {
  subscription_id: number;
  event_hash: string;
  description: string;
  status: number;
  attempts: number;
  latency_ms: number;
  timestamp: string;
  tx_hash?: string;
  event?: TransferEvent;
  webhook_url?: string;
}

export interface Snapshot {
  contract_hash: string;
  chain: 'casper' | 'casper-test';
  updated_at: string;
  subscriptions: Subscription[];
  recent_events: RecentEvent[];
}

export interface ChainHead {
  height: number;
  era: number;
  timestamp: string;
  chain: string;
  fetched_at: string;
}

export interface ValidationResult {
  matches: number;
  total_scanned: number;
  sample_matches: TransferEvent[];
  time_window_seconds: number;
  estimated_per_day: number | null;
  source: 'live' | 'sample' | 'mixed';
}

export interface ExplainStep {
  index: number;
  field: string;
  op: Operator;
  expected: unknown;
  actual: unknown;
  pass: boolean;
  reason: string;
}

export interface ExplainResult {
  match: boolean;
  conditions_total: number;
  conditions_passed: number;
  trace: ExplainStep[];
}

export interface StreamEnvelope<T = unknown> {
  type: 'hello' | 'delivery' | 'subs.reload' | 'ping';
  data: T;
  ts: string;
}

export interface SluiceClientOptions {
  baseUrl?: string;
  /** Inject a WebSocket constructor for environments without globalThis.WebSocket. */
  websocketCtor?: typeof globalThis.WebSocket;
  /** Defaults to fetch on globalThis. Override for testing or for adding auth headers. */
  fetchFn?: typeof fetch;
}

class SluiceApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
    this.name = 'SluiceApiError';
  }
}

/**
 * High-level client. Group methods under namespace properties (subs, predicate,
 * stream, tx, chain) so IDE autocomplete is discoverable.
 */
export class SluiceClient {
  readonly baseUrl: string;
  private readonly f: typeof fetch;
  private readonly wsCtor?: typeof globalThis.WebSocket;

  readonly subs = {
    list: async (): Promise<Subscription[]> => (await this.snapshot()).subscriptions,
    get: async (id: number): Promise<Subscription | null> => {
      const subs = await this.subs.list();
      return subs.find((s) => s.id === id) ?? null;
    },
    replayLast: (id: number, n = 10) => this.post<{ requested: number; found: number; results: Array<{ event_hash: string; ok: boolean; statusCode?: number; attempts: number; latency_ms: number; timestamp: string }> }>(`/sub/${id}/replay-last`, { n }),
    ics: (id: number): string => `${this.baseUrl}/sub/${id}.ics`,
    og: (id: number): string => `${this.baseUrl.replace(/\/api$/, '')}/og/sub/${id}`,
  };

  readonly predicate = {
    validate: (predicate: Predicate) => this.post<ValidationResult>('/predicate/validate', { predicate }),
    explain: (predicate: Predicate, event: TransferEvent) => this.post<ExplainResult>('/predicate/explain', { predicate, event }),
  };

  readonly tx = {
    testWebhook: (subscription_id: number) => this.post<{ ok: boolean; statusCode?: number; attempts: number; latency_ms: number; webhook_url: string }>('/tx/test-webhook', { subscription_id }),
    replay: (event_hash: string) => this.post<{ ok: boolean; statusCode?: number; attempts: number; latency_ms: number }>('/tx/replay', { event_hash }),
  };

  readonly sandbox = {
    dispatch: (webhook: string, opts: { predicate?: Predicate; count?: number } = {}) =>
      this.post<{ delivered: number; requested: number; matched_in_buffer: number; used_synthetic: boolean; results: Array<{ ok: boolean; statusCode?: number; attempts: number; latency_ms: number; event_hash: string }> }>('/sandbox/dispatch', { webhook, predicate: opts.predicate ?? null, count: opts.count ?? 3 }),
  };

  readonly chain = {
    head: () => this.get<ChainHead>('/chain/head'),
  };

  readonly stream = {
    /**
     * Subscribe to the live event stream. Returns a function that closes the
     * underlying WebSocket. Reconnect logic is the caller's responsibility , 
     * keep it simple here, since reconnect strategy is app-specific.
     */
    subscribe: (
      onEnvelope: (env: StreamEnvelope) => void,
      opts: { sub?: number; onOpen?: () => void; onError?: (e: Event | Error) => void; onClose?: (code: number) => void } = {},
    ): (() => void) => {
      const WSCtor = this.wsCtor ?? (globalThis as { WebSocket?: typeof globalThis.WebSocket }).WebSocket;
      if (!WSCtor) throw new Error('No WebSocket constructor, pass {websocketCtor} in client options (e.g. import WS from "ws")');
      const url = this.baseUrl.replace(/^http/, 'ws') + '/stream' + (opts.sub != null ? `?sub=${opts.sub}` : '');
      const ws = new WSCtor(url);
      ws.addEventListener('open', () => opts.onOpen?.());
      ws.addEventListener('message', (ev) => {
        try { onEnvelope(JSON.parse(String((ev as MessageEvent).data))); }
        catch (e) { opts.onError?.(e as Error); }
      });
      ws.addEventListener('error', (e) => opts.onError?.(e as Event));
      ws.addEventListener('close', (e) => opts.onClose?.((e as CloseEvent).code));
      return () => ws.close();
    },
  };

  constructor(opts: SluiceClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://sluice.unitynodes.com/api').replace(/\/$/, '');
    this.f = opts.fetchFn ?? fetch.bind(globalThis);
    this.wsCtor = opts.websocketCtor;
  }

  health(): Promise<{ ok: boolean; contract: string; chain: string }> {
    return this.post('/health', {});
  }

  snapshot(): Promise<Snapshot> {
    return this.get('/snapshot.json');
  }

  metricsText(): Promise<string> {
    return this.f(`${this.baseUrl}/metrics`).then((r) => r.text());
  }

  badgeUrl(metric: 'subs-active' | 'deliveries' | 'delivery-success' | 'latency-p95' | 'uptime' | 'ws'): string {
    return `${this.baseUrl}/badges/${metric}.svg`;
  }

  private async get<T>(path: string): Promise<T> {
    const r = await this.f(`${this.baseUrl}${path}`);
    if (!r.ok) throw new SluiceApiError(r.status, `GET ${path} → ${r.status}`, await safeJson(r));
    return (await r.json()) as T;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const r = await this.f(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new SluiceApiError(r.status, `POST ${path} → ${r.status}`, await safeJson(r));
    return (await r.json()) as T;
  }
}

async function safeJson(r: Response): Promise<unknown> {
  try { return await r.json(); } catch { return undefined; }
}

export { SluiceApiError };
