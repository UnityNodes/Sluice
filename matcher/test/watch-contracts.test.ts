import { evaluate } from '../src/predicate';
import { WatchContractsReader, parseWatchList, type NormalizedContractEvent } from '../src/watch-contracts';
import type { Predicate } from '../src/types';

/**
 * A real-shaped CSPR.cloud contract-event envelope for a DEX Swap. This is the
 * shape the streaming API delivers for `contract-events?...&includes=raw_data`.
 */
const rawSwapEnvelope = {
  action: 'emitted',
  timestamp: '2026-07-01T08:00:00Z',
  extra: { block_height: 8360000, deploy_hash: 'abc123', event_id: 42 },
  data: {
    contract_package_hash: 'd'.repeat(64),
    contract_hash: 'e'.repeat(64),
    name: 'Swap',
    data: { amount_in: '250000000000000', token_in: 'CSPR', trader: 'a'.repeat(64) },
  },
};

const makeReader = () =>
  new WatchContractsReader('wss://streaming.testnet.cspr.cloud', ['d'.repeat(64)], 'token', () => {});

describe('WatchContractsReader.normalize', () => {
  it('normalizes an emitted contract event into the predicate-friendly shape', () => {
    const ev = makeReader().normalize(rawSwapEnvelope as never)!;
    expect(ev.event_type).toBe('contract');
    expect(ev.contract_package_hash).toBe('d'.repeat(64));
    expect(ev.name).toBe('Swap');
    expect(ev.deploy_hash).toBe('abc123');
    expect(ev.block_height).toBe(8360000);
    expect((ev.data as Record<string, unknown>).amount_in).toBe('250000000000000');
  });

  it('drops non-emitted actions', () => {
    expect(makeReader().normalize({ action: 'other', data: rawSwapEnvelope.data } as never)).toBeNull();
  });

  it('drops envelopes with no name or package hash', () => {
    expect(makeReader().normalize({ action: 'emitted', data: {} } as never)).toBeNull();
  });
});

describe('contract-event predicates via the shared engine', () => {
  const ev = makeReader().normalize(rawSwapEnvelope as never)! as unknown as NormalizedContractEvent;

  it('matches a DeFi Swap predicate over a threshold', () => {
    const p: Predicate = {
      and: [
        { field: 'event_type', op: 'eq', value: 'contract' },
        { field: 'name', op: 'eq', value: 'Swap' },
        { field: 'contract_package_hash', op: 'eq', value: 'd'.repeat(64) },
        { field: 'data.amount_in', op: 'gte', value: '100000000000000' },
      ],
    };
    expect(evaluate(p, ev as never)).toBe(true);
  });

  it('does not match when the threshold is above the event amount', () => {
    const p: Predicate = {
      and: [
        { field: 'event_type', op: 'eq', value: 'contract' },
        { field: 'data.amount_in', op: 'gte', value: '999000000000000000' },
      ],
    };
    expect(evaluate(p, ev as never)).toBe(false);
  });

  it('a native transfer predicate does not false-match a contract event', () => {
    const transferPred: Predicate = { and: [{ field: 'amount', op: 'gte', value: '1' }] };
    expect(evaluate(transferPred, ev as never)).toBe(false);
  });

  it('a contract predicate does not false-match a native transfer', () => {
    const transferEvent = {
      id: 1, deploy_hash: 'x', block_height: 1, transform_key: null, transfer_index: 0,
      initiator_account_hash: 'c'.repeat(64), from_purse: '', to_purse: '',
      to_account_hash: 'b'.repeat(64), amount: '5000000000000', timestamp: 't',
    };
    const contractPred: Predicate = { and: [{ field: 'event_type', op: 'eq', value: 'contract' }] };
    expect(evaluate(contractPred, transferEvent as never)).toBe(false);
  });
});

describe('parseWatchList', () => {
  it('strips prefixes, lowercases, and drops invalid entries', () => {
    const list = parseWatchList(`hash-${'d'.repeat(64)}, contract-package-${'E'.repeat(64)}, nope`);
    expect(list).toEqual(['d'.repeat(64), 'e'.repeat(64)]);
  });

  it('returns an empty list for undefined', () => {
    expect(parseWatchList(undefined)).toEqual([]);
  });
});
