/**
 * Webhook dispatcher: POSTs match payload, retries with exponential backoff,
 * sets an Idempotency-Key, and guards against SSRF to private / link-local /
 * loopback ranges.
 *
 * Delivery is at-least-once. Subscriber dedupes by the Idempotency-Key header.
 */

import { createHash, createHmac } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { URL } from 'node:url';
import axios, { AxiosError } from 'axios';
import ipaddr from 'ipaddr.js';

import type { TransferEvent } from './types';

export interface WebhookResult {
  ok: boolean;
  statusCode?: number;
  attempts: number;
  idempotencyKey: string;
  errorMessage?: string;
}

const BACKOFF_MS = [1_000, 4_000, 16_000] as const; // 3 retries
const REQUEST_TIMEOUT_MS = 10_000;
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

export class SsrfError extends Error {
  constructor(message: string) {
    super(`SSRF guard: ${message}`);
    this.name = 'SsrfError';
  }
}

/** Throws SsrfError on disallowed URL. Otherwise returns the resolved IP for logging. */
export async function validateWebhookUrl(rawUrl: string): Promise<string> {
  let url: URL;
  try { url = new URL(rawUrl); }
  catch { throw new SsrfError(`malformed URL: ${rawUrl}`); }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new SsrfError(`scheme not allowed: ${url.protocol}`);
  }
  if (!url.hostname) throw new SsrfError('missing hostname');

  let hostIp: string;
  if (ipaddr.isValid(url.hostname)) {
    hostIp = url.hostname;
  } else {
    try {
      const { address } = await dnsLookup(url.hostname);
      hostIp = address;
    } catch (e) {
      throw new SsrfError(`DNS lookup failed for ${url.hostname}: ${(e as Error).message}`);
    }
  }

  if (!ipaddr.isValid(hostIp)) {
    throw new SsrfError(`invalid resolved IP: ${hostIp}`);
  }
  const parsed = ipaddr.parse(hostIp);
  const range = parsed.range();

  // ipaddr.js range names that we explicitly block.
  const BLOCKED: ReadonlySet<string> = new Set([
    'unspecified',     // 0.0.0.0, ::
    'broadcast',       // 255.255.255.255
    'multicast',
    'linkLocal',       // 169.254.0.0/16, fe80::/10
    'loopback',        // 127.0.0.0/8, ::1
    'uniqueLocal',     // fc00::/7
    'ipv4Mapped',
    'rfc6145',
    'rfc6052',
    '6to4',
    'teredo',
    'reserved',
    'benchmarking',
    'amt',
    'as112',
    'deprecated',
    'orchid2',
    'droneRemoteIdProtocolEntityTags',
    'private',         // 10/8, 172.16/12, 192.168/16
    'carrierGradeNat', // 100.64/10
  ]);

  if (BLOCKED.has(range)) {
    throw new SsrfError(`destination IP ${hostIp} is in blocked range "${range}"`);
  }

  return hostIp;
}

/**
 * Deterministic idempotency key, same event → same key, regardless of how
 * many times the matcher retries. Subscriber dedupes by this header.
 */
export function computeIdempotencyKey(event: TransferEvent): string {
  const seed = `${event.deploy_hash}|${event.transfer_index ?? event.id ?? ''}|${event.amount}|${event.to_account_hash ?? ''}`;
  return createHash('sha256').update(seed).digest('hex');
}

interface DispatchOptions {
  /** Override the default backoff schedule (mostly for tests). */
  backoffMs?: ReadonlyArray<number>;
  /** Skip SSRF guard (only used when the caller has already validated). */
  skipGuard?: boolean;
  /** Inject an axios-like POST function, used in tests, never in prod. */
  poster?: (url: string, body: unknown, headers: Record<string, string>) => Promise<{ status: number }>;
  /** Per-subscription HMAC secret. When set, an X-Sluice-Signature header is included
   * as `sha256=<hex>` over the JSON-serialised body, so receivers can verify
   * the request is from Sluice and not spoofed. */
  webhookSecret?: string;
}

/** Compute the HMAC signature for a webhook payload. */
export function computeSignature(body: unknown, secret: string): string {
  const json = typeof body === 'string' ? body : JSON.stringify(body);
  return 'sha256=' + createHmac('sha256', secret).update(json).digest('hex');
}

export async function dispatchWebhook(
  webhookUrl: string,
  event: TransferEvent,
  subscriptionId: number,
  opts: DispatchOptions = {},
): Promise<WebhookResult> {
  const idempotencyKey = computeIdempotencyKey(event);

  if (!opts.skipGuard) {
    await validateWebhookUrl(webhookUrl);
  }

  const body = {
    subscription_id: subscriptionId,
    event,
    matched_at: new Date().toISOString(),
  };
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'idempotency-key': idempotencyKey,
    'user-agent': 'sluice-matcher/0.1',
  };
  if (opts.webhookSecret) {
    headers['x-sluice-signature'] = computeSignature(body, opts.webhookSecret);
  }

  const backoff = opts.backoffMs ?? BACKOFF_MS;
  const poster = opts.poster ?? (async (url, b, h) => {
    const resp = await axios.post(url, b, { headers: h, timeout: REQUEST_TIMEOUT_MS, validateStatus: () => true });
    return { status: resp.status };
  });

  let lastError: string | undefined;
  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    try {
      const { status } = await poster(webhookUrl, body, headers);
      if (status >= 200 && status < 300) {
        return { ok: true, statusCode: status, attempts: attempt + 1, idempotencyKey };
      }
      lastError = `HTTP ${status}`;
    } catch (e) {
      const err = e as AxiosError | Error;
      lastError = err.message;
    }
    if (attempt < backoff.length) {
      await new Promise((r) => setTimeout(r, backoff[attempt]));
    }
  }
  return { ok: false, attempts: backoff.length + 1, idempotencyKey, errorMessage: lastError };
}
