/**
 * Reads the active subscription set from the deployed SubscriptionRegistry.
 *
 * Strategy: enumerate ids from 1..get_next_id() and pull each `get_subscription(id)`.
 * For the demo (≤100 subs) this is fine; production should index events instead.
 */

import { RpcClient } from 'casper-js-sdk';

import type { Subscription, Predicate } from './types';
import { validatePredicate } from './predicate';

export interface ContractStateReader {
  loadActiveSubscriptions(): Promise<Subscription[]>;
}

export class CsprCloudStateReader implements ContractStateReader {
  /**
   * @param baseUrl REST root, e.g. https://api.testnet.cspr.cloud
   * @param contractHash 64-hex contract hash (no prefix)
   * @param authToken CSPR.cloud bearer token
   */
  constructor(
    private readonly baseUrl: string,
    private readonly contractHash: string,
    private readonly authToken: string,
  ) {}

  /**
   * Pulls all active subscriptions from the CSPR.cloud REST API.
   *
   * In v0.1 we lean on contract-emitted events (SubscriptionCreated) accessible
   * via /events endpoints. Subscription state is then derived locally.
   *
   * Until the exact REST path is confirmed (Day-0 task), this is a stub that
   * returns the demo-test fixtures.
   *
   * TODO(day-1): swap to actual cspr.cloud event list call.
   */
  async loadActiveSubscriptions(): Promise<Subscription[]> {
    // Quiet unused-var warnings until we wire the REST call.
    void this.baseUrl;
    void this.contractHash;
    void this.authToken;
    return [];
  }
}

/**
 * Static reader: feeds a hardcoded subscription list (for matcher dry runs
 * before the on-chain reader is wired). Reads `SLUICE_INJECT_SUBS_FILE` as a
 * path to a JSON file with a `Subscription[]` body, or `SLUICE_INJECT_SUBS`
 * as inline JSON, if no constructor argument is given.
 */
import { readFileSync } from 'node:fs';

export class StaticSubscriptionReader implements ContractStateReader {
  private readonly staticSubs?: Subscription[];
  private readonly path?: string;
  constructor(subs?: Subscription[]) {
    if (subs) { this.staticSubs = subs; return; }
    this.path = process.env.SLUICE_INJECT_SUBS_FILE;
  }
  async loadActiveSubscriptions(): Promise<Subscription[]> {
    if (this.staticSubs) return this.staticSubs;
    if (this.path) return JSON.parse(readFileSync(this.path, 'utf8')) as Subscription[];
    const env = process.env.SLUICE_INJECT_SUBS;
    return env ? (JSON.parse(env) as Subscription[]) : [];
  }
}

/** Reader that pulls subscriptions via JSON-RPC `query_global_state`. */
export class RpcStateReader implements ContractStateReader {
  constructor(
    private readonly rpc: RpcClient,
    private readonly contractHash: string,
  ) {}

  async loadActiveSubscriptions(): Promise<Subscription[]> {
    // Placeholder, implemented once we know the dictionary URef layout.
    // For Odra 2.8 storage Mapping<u32, Subscription>, each entry lives in a
    // dictionary keyed by the u32 id (stringified). We need the contract's
    // named-key URef for "subscriptions" then query each dict entry.
    void this.rpc;
    void this.contractHash;
    return [];
  }
}

/** Helper: parse a predicate JSON string with validation. */
export function parsePredicateJson(raw: string): Predicate {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new Error(`invalid predicate JSON: ${(e as Error).message}`); }
  validatePredicate(parsed);
  return parsed;
}
