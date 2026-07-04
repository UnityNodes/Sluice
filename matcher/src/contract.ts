/**
 * Subscription readers.
 *
 * The running matcher event-sources subscription state from the registry's
 * SubscriptionCreated / DeliveryRecorded / ToppedUp / SubscriptionCancelled
 * events (ContractEventStreamReader in contract-events.ts). StaticSubscriptionReader
 * below feeds a fixed list from a file or env for demos and dry runs.
 */

import { readFileSync } from 'node:fs';

import type { Subscription, Predicate } from './types';
import { validatePredicate } from './predicate';

export interface ContractStateReader {
  loadActiveSubscriptions(): Promise<Subscription[]>;
}

/**
 * Static reader: feeds a hardcoded subscription list (for matcher dry runs and
 * demos). Reads `SLUICE_INJECT_SUBS_FILE` as a path to a JSON file with a
 * `Subscription[]` body, or `SLUICE_INJECT_SUBS` as inline JSON, if no
 * constructor argument is given.
 */
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

/** Helper: parse a predicate JSON string with validation. */
export function parsePredicateJson(raw: string): Predicate {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new Error(`invalid predicate JSON: ${(e as Error).message}`); }
  validatePredicate(parsed);
  return parsed;
}
