import { evaluate, validatePredicate, PredicateError } from '../src/predicate';
import type { Predicate, TransferEvent } from '../src/types';

const ev: TransferEvent = {
  id: 0,
  deploy_hash: 'abc123def456',
  block_height: 8338998,
  transform_key: null,
  transfer_index: 0,
  initiator_account_hash: 'init-hash',
  from_purse: 'uref-aaaa-007',
  to_purse: 'uref-bbbb-004',
  to_account_hash: 'dest-hash',
  amount: '5000000000',
  timestamp: '2026-06-29T08:00:00Z',
};

const eval1 = (op: string, field: string, value: unknown) =>
  evaluate({ and: [{ field, op, value } as never] } as Predicate, ev);

describe('contains', () => {
  it('matches substring', () => { expect(eval1('contains', 'deploy_hash', 'def')).toBe(true); });
  it('rejects miss',     () => { expect(eval1('contains', 'deploy_hash', 'xyz')).toBe(false); });
});

describe('starts_with', () => {
  it('matches prefix',   () => { expect(eval1('starts_with', 'deploy_hash', 'abc')).toBe(true); });
  it('rejects non-prefix', () => { expect(eval1('starts_with', 'deploy_hash', 'def')).toBe(false); });
});

describe('ends_with', () => {
  it('matches suffix', () => { expect(eval1('ends_with', 'deploy_hash', '456')).toBe(true); });
  it('rejects non-suffix', () => { expect(eval1('ends_with', 'deploy_hash', '999')).toBe(false); });
});

describe('regex', () => {
  it('matches a real regex', () => { expect(eval1('regex', 'deploy_hash', '^abc\\d{3}')).toBe(true); });
  it('rejects non-match',   () => { expect(eval1('regex', 'deploy_hash', '^def')).toBe(false); });
  it('returns false on bad regex (does not throw)', () => {
    expect(eval1('regex', 'deploy_hash', '(((')).toBe(false);
  });
});

describe('in / not_in', () => {
  it('in matches', () => { expect(eval1('in', 'amount', ['1', '5000000000', '999'])).toBe(true); });
  it('in rejects miss', () => { expect(eval1('in', 'amount', ['1', '2'])).toBe(false); });
  it('not_in inverts', () => { expect(eval1('not_in', 'amount', ['1', '2'])).toBe(true); });
  it('validation rejects in with scalar value', () => {
    expect(() => validatePredicate({ and: [{ field: 'amount', op: 'in', value: '1' }] })).toThrow(PredicateError);
  });
});
