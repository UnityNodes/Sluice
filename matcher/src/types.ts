/**
 * Shared types for the Sluice matcher.
 *
 * Names track the CSPR.cloud Streaming Transfer event envelope: every message
 * is `{ action, data, timestamp, extra? }`. The fields inside `data` are what
 * the predicate engine actually sees.
 *
 * The field set tracks the CSPR.cloud transfer envelope and is validated
 * against a real WS capture in examples/transfer-event.json.
 */

export type Operator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'contains' | 'starts_with' | 'ends_with' | 'in' | 'not_in' | 'regex';

export interface Condition {
  field: string;
  op: Operator;
  value: string | number | boolean | Array<string | number>;
}

/**
 * v0.2, `and` can contain nested groups. A group is `{ and: [...] }` or
 * `{ or: [...] }`. Old-style flat AND predicates (Condition[]) still validate
 * and evaluate identically, no migration needed.
 */
export type PredicateNode = Condition | { and: PredicateNode[] } | { or: PredicateNode[] };

export interface Predicate {
  and: PredicateNode[];
}

/**
 * A Casper Transfer as exposed by CSPR.cloud Streaming.
 *
 * Schema verified against a real testnet event (see examples/transfer-event.json):
 *   { id, deploy_hash, block_height, transform_key, transfer_index,
 *     initiator_account_hash, from_purse, to_purse, to_account_hash,
 *     amount (motes, string), timestamp }
 */
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
  amount: string; // motes, decimal string
  timestamp: string;
  /** Open for any unmodelled fields the API may add. */
  [extra: string]: unknown;
}

export interface StreamEnvelope<TData = unknown> {
  action: string;
  data: TData;
  timestamp?: string;
  extra?: unknown;
}

/** Mirror of the Odra `Subscription` struct, but in JS/TS-friendly form. */
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

export interface MatcherConfig {
  csprCloudToken: string;
  streamingWsUrl: string;        // default wss://streaming.testnet.cspr.cloud/transfers (plural)
  nodeRpcUrl: string;
  chainName: 'casper-test' | 'casper';
  contractHash: string;
  matcherKeyPath: string;
  pollSubscriptionsIntervalMs: number;
  /** If set, matcher writes its active subs map to this file on every reload (for CLI / MCP read). */
  snapshotPath?: string;
  /**
   * External contract_package_hash values whose emitted events should also be
   * streamed through the predicate engine (DeFi pools, DEX routers, RWA
   * compliance/oracle contracts, CEP-18 tokens). Native Transfer matching is
   * always on; this adds contract-event matching on top.
   */
  watchContracts?: string[];
  /**
   * Subscription ids that are off-chain demo lanes (injected, no on-chain
   * escrow). Deliveries fire normally, but record_delivery is skipped so the
   * matcher does not submit a reverting tx for a subscription the registry
   * does not know about.
   */
  demoSubs?: Set<number>;
}
