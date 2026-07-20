/**
 * Webhook dispatcher: POSTs match payload, retries with exponential backoff,
 * sets an Idempotency-Key, and guards against SSRF to private / link-local /
 * loopback ranges.
 *
 * Delivery is at-least-once. Subscriber dedupes by the Idempotency-Key header.
 *
 * The SSRF guard resolves the hostname once, validates the IP, then pins the
 * connection to that exact address so a DNS-rebinding attacker cannot swap in
 * an internal IP between validation and the actual request. Resolutions are
 * cached briefly so a hot delivery path does not re-query DNS per event.
 */

import { createHash, createHmac } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
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
const DNS_CACHE_TTL_MS = 30_000;

export class SsrfError extends Error {
  constructor(message: string) {
    super(`SSRF guard: ${message}`);
    this.name = 'SsrfError';
  }
}

// hostname -> { validated public IP, expiry }. Only allowed IPs are cached.
const dnsCache = new Map<string, { ip: string; expiresAt: number }>();

// ipaddr.js range names that we explicitly block.
const BLOCKED_RANGES: ReadonlySet<string> = new Set([
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

/** Throws SsrfError if the IP is in a blocked range. */
function assertAllowedIp(hostIp: string): void {
  if (!ipaddr.isValid(hostIp)) throw new SsrfError(`invalid resolved IP: ${hostIp}`);
  const range = ipaddr.parse(hostIp).range();
  if (BLOCKED_RANGES.has(range)) {
    throw new SsrfError(`destination IP ${hostIp} is in blocked range "${range}"`);
  }
}

/** Throws SsrfError on disallowed URL. Otherwise returns the resolved IP the request must pin to. */
export async function validateWebhookUrl(rawUrl: string): Promise<string> {
  let url: URL;
  try { url = new URL(rawUrl); }
  catch { throw new SsrfError(`malformed URL: ${rawUrl}`); }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new SsrfError(`scheme not allowed: ${url.protocol}`);
  }
  if (!url.hostname) throw new SsrfError('missing hostname');

  // IP literal: validate directly, nothing to resolve or pin.
  if (ipaddr.isValid(url.hostname)) {
    assertAllowedIp(url.hostname);
    return url.hostname;
  }

  const cached = dnsCache.get(url.hostname);
  if (cached && cached.expiresAt > Date.now()) return cached.ip;

  let hostIp: string;
  try {
    const { address } = await dnsLookup(url.hostname);
    hostIp = address;
  } catch (e) {
    throw new SsrfError(`DNS lookup failed for ${url.hostname}: ${(e as Error).message}`);
  }
  assertAllowedIp(hostIp);
  dnsCache.set(url.hostname, { ip: hostIp, expiresAt: Date.now() + DNS_CACHE_TTL_MS });
  return hostIp;
}

/** An http/https agent whose DNS resolution is pinned to an already-validated IP. */
function pinnedAgent(ip: string, protocol: string): http.Agent | https.Agent {
  const family = ipaddr.parse(ip).kind() === 'ipv6' ? 6 : 4;
  // Node calls lookup with either { all: false } (expects address, family) or
  // { all: true } (expects [{ address, family }]); support both or the socket
  // silently hangs.
  const lookup = ((_hostname: string, options: { all?: boolean } | undefined, cb: (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void) => {
    if (options && options.all) cb(null, [{ address: ip, family }]);
    else cb(null, ip, family);
  }) as unknown as LookupFunction;
  return protocol === 'https:' ? new https.Agent({ lookup }) : new http.Agent({ lookup });
}

/**
 * Stable stringify (sorted keys) so the idempotency seed does not depend on
 * object key order.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

/**
 * Deterministic idempotency key, same event -> same key, regardless of how
 * many times the matcher retries. Distinct events always produce distinct
 * keys: native Transfers key on deploy/index/amount/recipient, while contract
 * events (which carry none of those) key on name, package, block, and a stable
 * hash of the event data, so two events in one deploy do not collide.
 */
export function computeIdempotencyKey(event: TransferEvent): string {
  const e = event as unknown as Record<string, unknown>;
  const parts = [
    e.deploy_hash ?? '',
    e.block_height ?? '',
    e.event_type ?? 'transfer',
    e.name ?? '',
    e.contract_package_hash ?? '',
    e.transfer_index ?? e.id ?? '',
    e.amount ?? '',
    e.to_account_hash ?? '',
    e.data !== undefined ? stableStringify(e.data) : '',
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex');
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

  let pinnedIp: string | undefined;
  if (!opts.skipGuard) {
    pinnedIp = await validateWebhookUrl(webhookUrl);
  }

  const body = {
    subscription_id: subscriptionId,
    event_hash: idempotencyKey,
    event,
    matched_at: new Date().toISOString(),
  };
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'idempotency-key': idempotencyKey,
    'x-sluice-idempotency-key': idempotencyKey,
    'x-sluice-sub-id': String(subscriptionId),
    'user-agent': 'sluice-matcher/0.1',
  };
  if (opts.webhookSecret) {
    headers['x-sluice-signature'] = computeSignature(body, opts.webhookSecret);
  }

  const backoff = opts.backoffMs ?? BACKOFF_MS;
  const poster = opts.poster ?? (async (url, b, h) => {
    const u = new URL(url);
    // maxRedirects: 0 is a security control, not a preference. We validate and
    // IP-pin the first hop, but a 3xx Location is never re-validated and an
    // IP-literal redirect target skips the pinned lookup entirely, so following
    // redirects reopens the SSRF the guard closes (a public webhook 302s us to
    // 127.0.0.1 or 169.254.169.254). Treat a redirect as a delivery failure.
    const cfg: Parameters<typeof axios.post>[2] = { headers: h, timeout: REQUEST_TIMEOUT_MS, validateStatus: () => true, maxRedirects: 0 };
    // Pin the connection to the IP we validated so a rebind cannot redirect it
    // to an internal address between the guard and the request.
    if (pinnedIp && !ipaddr.isValid(u.hostname)) {
      const agent = pinnedAgent(pinnedIp, u.protocol);
      if (u.protocol === 'https:') cfg.httpsAgent = agent; else cfg.httpAgent = agent;
    }
    const resp = await axios.post(url, b, cfg);
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
