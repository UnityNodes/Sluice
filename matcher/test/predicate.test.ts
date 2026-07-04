import { evaluate, getField, validatePredicate, PredicateError } from '../src/predicate';
import type { Predicate, TransferEvent } from '../src/types';

const sampleEvent: TransferEvent = {
  id: 0,
  deploy_hash: '0xabc',
  block_height: 8338998,
  transform_key: null,
  transfer_index: 0,
  initiator_account_hash: 'account-hash-from',
  from_purse: 'uref-from',
  to_purse: 'uref-to',
  to_account_hash: 'account-hash-target',
  amount: '5000000000',
  timestamp: '2026-06-29T08:00:00.000Z',
};

describe('getField', () => {
  it('walks plain keys', () => {
    expect(getField(sampleEvent as unknown as Record<string, unknown>, 'amount')).toBe('5000000000');
  });
  it('walks dot notation', () => {
    const obj = { a: { b: { c: 7 } } };
    expect(getField(obj, 'a.b.c')).toBe(7);
  });
  it('returns undefined on missing path', () => {
    expect(getField(sampleEvent as unknown as Record<string, unknown>, 'nope')).toBeUndefined();
    expect(getField(sampleEvent as unknown as Record<string, unknown>, 'amount.foo')).toBeUndefined();
  });
});

describe('validatePredicate', () => {
  it('accepts a valid predicate', () => {
    expect(() => validatePredicate({ and: [{ field: 'amount', op: 'gt', value: '0' }] })).not.toThrow();
  });
  it('rejects empty and', () => {
    expect(() => validatePredicate({ and: [] })).toThrow(PredicateError);
  });
  it('rejects unknown op', () => {
    expect(() => validatePredicate({ and: [{ field: 'amount', op: 'unicorn', value: '1' }] })).toThrow(PredicateError);
  });
  it('rejects missing field', () => {
    expect(() => validatePredicate({ and: [{ op: 'eq', value: '1' }] })).toThrow(PredicateError);
  });
});

describe('evaluate, numeric comparison', () => {
  const p: Predicate = { and: [{ field: 'amount', op: 'gt', value: '1000000000' }] };
  it('matches when amount > threshold', () => {
    expect(evaluate(p, sampleEvent)).toBe(true);
  });
  it('rejects when amount <= threshold', () => {
    expect(evaluate(p, { ...sampleEvent, amount: '500000000' })).toBe(false);
    expect(evaluate(p, { ...sampleEvent, amount: '1000000000' })).toBe(false);
  });
  it('handles gte / lte boundary', () => {
    const gte: Predicate = { and: [{ field: 'amount', op: 'gte', value: '5000000000' }] };
    const lte: Predicate = { and: [{ field: 'amount', op: 'lte', value: '5000000000' }] };
    expect(evaluate(gte, sampleEvent)).toBe(true);
    expect(evaluate(lte, sampleEvent)).toBe(true);
  });
});

describe('evaluate, string equality', () => {
  it('matches to_account_hash eq', () => {
    const p: Predicate = { and: [{ field: 'to_account_hash', op: 'eq', value: 'account-hash-target' }] };
    expect(evaluate(p, sampleEvent)).toBe(true);
  });
  it('rejects neq', () => {
    const p: Predicate = { and: [{ field: 'to_account_hash', op: 'neq', value: 'account-hash-target' }] };
    expect(evaluate(p, sampleEvent)).toBe(false);
  });
});

describe('evaluate, AND semantics', () => {
  it('all conditions must hold', () => {
    const p: Predicate = {
      and: [
        { field: 'amount', op: 'gt', value: '1000000000' },
        { field: 'to_account_hash', op: 'eq', value: 'account-hash-target' },
      ],
    };
    expect(evaluate(p, sampleEvent)).toBe(true);
  });
  it('one failing condition fails the whole', () => {
    const p: Predicate = {
      and: [
        { field: 'amount', op: 'gt', value: '1000000000' },
        { field: 'to_account_hash', op: 'eq', value: 'somebody-else' },
      ],
    };
    expect(evaluate(p, sampleEvent)).toBe(false);
  });
});

describe('evaluate, missing field is non-match', () => {
  it('field that does not exist in payload returns false', () => {
    const p: Predicate = { and: [{ field: 'memo', op: 'eq', value: 'whatever' }] };
    expect(evaluate(p, sampleEvent)).toBe(false);
  });
});

describe('validatePredicate, regex safety', () => {
  it('rejects a catastrophic-backtracking regex', () => {
    const p = { and: [{ field: 'to_account_hash', op: 'regex', value: '(a+)+$' }] };
    expect(() => validatePredicate(p)).toThrow(PredicateError);
  });
  it('rejects an over-long regex', () => {
    const p = { and: [{ field: 'to_account_hash', op: 'regex', value: 'a'.repeat(300) }] };
    expect(() => validatePredicate(p)).toThrow(PredicateError);
  });
  it('accepts a simple regex', () => {
    const p = { and: [{ field: 'to_account_hash', op: 'regex', value: '^ab[0-9]+$' }] };
    expect(() => validatePredicate(p)).not.toThrow();
  });
});
