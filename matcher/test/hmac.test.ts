import { computeSignature, dispatchWebhook } from '../src/webhook';
import type { TransferEvent } from '../src/types';

const ev: TransferEvent = {
  id: 0,
  deploy_hash: '0xabc',
  block_height: 1,
  transform_key: null,
  transfer_index: 0,
  initiator_account_hash: 'init',
  from_purse: 'p1',
  to_purse: 'p2',
  to_account_hash: 'dest',
  amount: '5000000000',
  timestamp: '2026-06-29T08:00:00Z',
};

describe('computeSignature', () => {
  it('produces a stable sha256=<hex> for the same body and secret', () => {
    const s1 = computeSignature({ a: 1 }, 'secret');
    const s2 = computeSignature({ a: 1 }, 'secret');
    expect(s1).toBe(s2);
    expect(s1).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
  it('changes with the body', () => {
    expect(computeSignature({ a: 1 }, 'k')).not.toBe(computeSignature({ a: 2 }, 'k'));
  });
  it('changes with the secret', () => {
    expect(computeSignature({ a: 1 }, 'k')).not.toBe(computeSignature({ a: 1 }, 'm'));
  });
  it('accepts string bodies', () => {
    const a = computeSignature('hello', 'k');
    expect(a).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});

describe('dispatchWebhook · HMAC header', () => {
  it('sends X-Sluice-Signature when webhookSecret is provided', async () => {
    let receivedHeaders: Record<string, string> = {};
    await dispatchWebhook('https://1.1.1.1/x', ev, 99, {
      backoffMs: [],
      webhookSecret: 'verify-me',
      poster: async (_u, _b, h) => { receivedHeaders = h; return { status: 200 }; },
    });
    expect(receivedHeaders['x-sluice-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
  it('omits the header when no secret is given', async () => {
    let receivedHeaders: Record<string, string> = {};
    await dispatchWebhook('https://1.1.1.1/x', ev, 99, {
      backoffMs: [],
      poster: async (_u, _b, h) => { receivedHeaders = h; return { status: 200 }; },
    });
    expect(receivedHeaders['x-sluice-signature']).toBeUndefined();
  });
});
