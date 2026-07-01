/**
 * Regression: predicate engine + idempotency key against a *real* CSPR.cloud
 * Transfer event captured from testnet on 2026-06-29.
 *
 * If the upstream schema changes, this is the first test that should break.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { evaluate } from '../src/predicate';
import { computeIdempotencyKey } from '../src/webhook';
import type { Predicate, TransferEvent } from '../src/types';

const fixture = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'examples', 'transfer-event.json'), 'utf8'),
) as { data: TransferEvent; action: string; timestamp: string };

const event = fixture.data;

describe('real CSPR.cloud Transfer event (2026-06-29 capture)', () => {
  it('payload has every documented field', () => {
    expect(event.deploy_hash).toBe('c60a4bfebc1ad5e6ac7272b0cc0a3ed93cc3a34335c049368db75e139b5711db');
    expect(event.to_account_hash).toBe('dc725246306b8ebfb6623feca7f777c4e9f52c96691cdccf338b797480787c9c');
    expect(event.amount).toBe('5000000000000');
    expect(event.block_height).toBe(8338998);
    expect(event.transfer_index).toBe(0);
    expect(typeof event.timestamp).toBe('string');
  });

  it('predicate {amount >= 1000 CSPR} matches a 5000 CSPR transfer', () => {
    const p: Predicate = { and: [{ field: 'amount', op: 'gte', value: '1000000000000' }] };
    expect(evaluate(p, event)).toBe(true);
  });

  it('predicate {to_account_hash = specific} matches', () => {
    const p: Predicate = {
      and: [{ field: 'to_account_hash', op: 'eq', value: 'dc725246306b8ebfb6623feca7f777c4e9f52c96691cdccf338b797480787c9c' }],
    };
    expect(evaluate(p, event)).toBe(true);
  });

  it('predicate {amount > 10 000 CSPR} does NOT match a 5000 CSPR transfer', () => {
    const p: Predicate = { and: [{ field: 'amount', op: 'gt', value: '10000000000000' }] };
    expect(evaluate(p, event)).toBe(false);
  });

  it('idempotency key is deterministic for this event', () => {
    const a = computeIdempotencyKey(event);
    const b = computeIdempotencyKey(event);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
