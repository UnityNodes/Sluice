import { validateWebhookUrl, computeIdempotencyKey, dispatchWebhook, SsrfError } from '../src/webhook';
import type { TransferEvent } from '../src/types';

const sampleEvent: TransferEvent = {
  id: 0,
  deploy_hash: '0xabc',
  block_height: 1,
  transform_key: null,
  transfer_index: 1,
  initiator_account_hash: 'init',
  from_purse: 'uref-from',
  to_purse: 'uref-to',
  amount: '5000000000',
  to_account_hash: 'tgt',
  timestamp: '2026-06-29T08:00:00Z',
};

describe('validateWebhookUrl', () => {
  it('accepts public https', async () => {
    // Use a known public IP literal so we don't depend on DNS in CI.
    await expect(validateWebhookUrl('https://1.1.1.1/hook')).resolves.toBe('1.1.1.1');
  });
  it('rejects ftp scheme', async () => {
    await expect(validateWebhookUrl('ftp://example.com')).rejects.toBeInstanceOf(SsrfError);
  });
  it('rejects loopback literal', async () => {
    await expect(validateWebhookUrl('http://127.0.0.1/x')).rejects.toBeInstanceOf(SsrfError);
  });
  it('rejects RFC1918 10/8', async () => {
    await expect(validateWebhookUrl('http://10.0.0.5/x')).rejects.toBeInstanceOf(SsrfError);
  });
  it('rejects RFC1918 192.168/16', async () => {
    await expect(validateWebhookUrl('http://192.168.1.5/x')).rejects.toBeInstanceOf(SsrfError);
  });
  it('rejects link-local 169.254/16', async () => {
    await expect(validateWebhookUrl('http://169.254.169.254/meta')).rejects.toBeInstanceOf(SsrfError);
  });
  it('rejects IPv6 loopback', async () => {
    await expect(validateWebhookUrl('http://[::1]/x')).rejects.toBeInstanceOf(SsrfError);
  });
});

describe('computeIdempotencyKey', () => {
  it('is deterministic per event', () => {
    expect(computeIdempotencyKey(sampleEvent)).toBe(computeIdempotencyKey(sampleEvent));
  });
  it('changes when the deploy hash changes', () => {
    const a = computeIdempotencyKey(sampleEvent);
    const b = computeIdempotencyKey({ ...sampleEvent, deploy_hash: '0xdef' });
    expect(a).not.toBe(b);
  });
});

describe('dispatchWebhook', () => {
  it('resolves ok on 2xx first try, no retries', async () => {
    let called = 0;
    const res = await dispatchWebhook('https://1.1.1.1/x', sampleEvent, 1, {
      backoffMs: [],
      poster: async () => { called++; return { status: 200 }; },
    });
    expect(res.ok).toBe(true);
    expect(res.attempts).toBe(1);
    expect(called).toBe(1);
  });

  it('retries on 500, succeeds on 2nd attempt', async () => {
    let n = 0;
    const res = await dispatchWebhook('https://1.1.1.1/x', sampleEvent, 1, {
      backoffMs: [1, 1, 1], // tiny waits for test speed
      poster: async () => ({ status: ++n === 1 ? 500 : 200 }),
    });
    expect(res.ok).toBe(true);
    expect(res.attempts).toBe(2);
  });

  it('gives up after 4 attempts on persistent 503', async () => {
    const res = await dispatchWebhook('https://1.1.1.1/x', sampleEvent, 1, {
      backoffMs: [1, 1, 1],
      poster: async () => ({ status: 503 }),
    });
    expect(res.ok).toBe(false);
    expect(res.attempts).toBe(4);
  });

  it('refuses to dispatch to loopback even before any retry', async () => {
    await expect(
      dispatchWebhook('http://127.0.0.1/hook', sampleEvent, 1, {
        backoffMs: [],
        poster: async () => ({ status: 200 }),
      })
    ).rejects.toBeInstanceOf(SsrfError);
  });
});
