/**
 * HTTP API server (port 7799) for the dashboard UI.
 *
 * Routes:
 *   POST /tx/build/create-subscription  { initiator, predicate_json, webhook_url, motes }
 *   POST /tx/build/top-up               { initiator, id, motes }
 *   POST /tx/build/cancel               { initiator, id }
 *   POST /tx/submit                     { signed_tx }   // full Version1 JSON
 *
 * The build endpoints shell out to `casper-client make-transaction package
 * --initiator-address <user>` which produces an *unsigned* Version1 JSON. The
 * browser pipes that to Casper Wallet's `sign()`, which fills in the
 * `approvals[]` array. The fully-signed JSON comes back to /tx/submit, which
 * runs `casper-client send-transaction --wasm-path <file>` (the flag is
 * misnamed in casper-client 5.0.1 but accepts any saved transaction file).
 *
 * We use this offline-build path because casper-js-sdk@5.0.0-rc6 emits Stored
 * targets incorrectly (HONEST_LIMITS §9). Until the SDK ships a fix, the Rust
 * casper-client owns serialization in both directions.
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WebSocketServer, WebSocket } from 'ws';

import { evaluateWithTrace, validatePredicate as assertPredicate, PredicateError } from './predicate';
import type { Predicate, TransferEvent } from './types';

export interface ApiConfig {
  port: number;
  contractHash: string;     // 64-hex (no prefix)
  nodeRpcUrl: string;       // open node RPC URL (no auth needed)
  chainName: 'casper-test' | 'casper';
  paymentMotes: number;     // gas budget, default 5 CSPR
  casperClientBin: string;  // resolved path to casper-client
  /** Optional callback to replay a past delivery's webhook (wired by index.ts). */
  replay?: (eventHash: string) => Promise<{ ok: boolean; statusCode?: number; attempts: number; latency_ms: number }>;
  /** Optional bulk replay, re-dispatches the last N deliveries for one sub in a single call. */
  replayLast?: (subscriptionId: number, n: number) => Promise<{
    requested: number;
    found: number;
    results: Array<{ event_hash: string; ok: boolean; statusCode?: number; attempts: number; latency_ms: number; timestamp: string }>;
  }>;
  /** Optional natural-language parser, builds a predicate from plain English. */
  parsePrompt?: (prompt: string) => { predicate: unknown | null; understood: string[]; unknown: string[] };
  /** Optional sandbox dispatcher, fire real webhooks for synthetic-or-buffered events, no on-chain effect. */
  sandboxDispatch?: (webhook: string, predicate: unknown | null, count: number) => Promise<{
    delivered: number;
    requested: number;
    matched_in_buffer: number;
    used_synthetic: boolean;
    results: Array<{ ok: boolean; statusCode?: number; attempts: number; latency_ms: number; event_hash: string }>;
  }>;
  /** Optional callback to send a synthetic test event to a subscription's webhook. */
  testWebhook?: (subscriptionId: number) => Promise<{ ok: boolean; statusCode?: number; attempts: number; latency_ms: number; webhook_url: string }>;
  /** Optional dry-run callback, counts matches over the matcher's recent-events buffer. */
  validatePredicate?: (predicateJson: string) => {
    matches: number;
    total_scanned: number;
    sample_matches: unknown[];
    time_window_seconds: number;
    estimated_per_day: number | null;
    source: 'live' | 'sample' | 'mixed';
  };
  /** Optional lookup for /sub/:id.ics. */
  getSubscription?: (id: number) => {
    id: number; owner: string; webhook_url: string;
    balance: string; deliveries: number; active: boolean; created_at: number;
  } | null;
  /** Optional delivery-rate calc for /sub/:id.ics balance-runout projection. */
  getDeliveryRate?: (id: number) => { count: number; window_seconds: number; per_day: number };
  /** Optional: claim the next paid delivery for an x402-billed sub (internal, called by the x402 service after settlement). */
  claimX402?: (subId: number, txHash?: string) => unknown | null;
  hasX402?: (subId: number) => boolean;
  /** Optional Prometheus metrics snapshot. */
  getMetricsSnapshot?: () => {
    startedAtMs: number;
    deliveriesTotal: number;
    webhookOk: number;
    webhookFail: number;
    webhookAttempts: number;
    recordDeliveryOk: number;
    recordDeliveryFail: number;
    latencyHistogram: number[];
    latencySumMs: number;
    latencyCount: number;
    wsTransfers: boolean;
    wsContractEvents: boolean;
    activeSubscriptions: number;
    inactiveSubscriptions: number;
    validationBufferSize: number;
    validationBufferSeeded: number;
  };
  /** Latency-histogram bucket cut-offs, in milliseconds. Required when getMetricsSnapshot is set. */
  latencyBucketsMs?: number[];
}

/* ─────────────────── chain-head cache ─────────────────── */
// Many landing-page tabs poll the head every few seconds. We collapse those
// requests into one upstream call every ~3s to keep the public node happy.
interface ChainHead { height: number; era: number; timestamp: string; chain: string; fetched_at: string }
let chainHeadCache: ChainHead | null = null;
let chainHeadLastFetch = 0;
let chainHeadInflight: Promise<ChainHead | null> | null = null;
const CHAIN_HEAD_TTL_MS = 3_000;

async function fetchChainHead(rpcUrl: string): Promise<ChainHead | null> {
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'info_get_status' }),
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return null;
    const j = await res.json() as { result?: { chainspec_name?: string; last_added_block_info?: { height?: number; era_id?: number; timestamp?: string } } };
    const info = j.result?.last_added_block_info;
    if (!info?.height || !info.timestamp) return null;
    return {
      height: info.height,
      era: info.era_id ?? -1,
      timestamp: info.timestamp,
      chain: j.result?.chainspec_name ?? 'unknown',
      fetched_at: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function getChainHead(rpcUrl: string): Promise<ChainHead | null> {
  const now = Date.now();
  if (chainHeadCache && (now - chainHeadLastFetch) < CHAIN_HEAD_TTL_MS) return chainHeadCache;
  if (chainHeadInflight) return chainHeadInflight;
  chainHeadInflight = fetchChainHead(rpcUrl).then((h) => {
    if (h) { chainHeadCache = h; chainHeadLastFetch = Date.now(); }
    chainHeadInflight = null;
    return h ?? chainHeadCache;
  });
  return chainHeadInflight;
}

/* ─────────────────── hosted-receiver ring buffer ─────────────────── */
interface HookedRequest {
  ts: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  query: string;
  remote: string;
}
const HOOK_MAX = 50;             // per id
const HOOK_MAX_IDS = 500;        // distinct ids, total
const HOOK_TTL_MS = 60 * 60 * 1000; // 1h
const HOOK_ID_RE = /^[a-z0-9-]{4,64}$/i;
const hooks = new Map<string, HookedRequest[]>();
function hookGc(): void {
  const cutoff = Date.now() - HOOK_TTL_MS;
  for (const [id, ring] of hooks) {
    const kept = ring.filter((r) => new Date(r.ts).getTime() > cutoff);
    if (kept.length === 0) hooks.delete(id);
    else if (kept.length !== ring.length) hooks.set(id, kept);
  }
}
setInterval(hookGc, 60_000).unref?.();

const log = (...a: unknown[]) => {
  const line = a.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ').replace(/\n|\r/g, '');
  console.log('[api]', new Date().toISOString(), line);
};

interface BuildBody {
  initiator: string;
  // create-subscription
  predicate_json?: string;
  webhook_url?: string;
  motes?: string;       // for create + top-up
  // top-up + cancel
  id?: number;
}

const MAX_JSON_BODY = 256 * 1024;

async function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    // Cap the body like readRaw does. Without this an unauthenticated caller
    // can stream hundreds of MB into a single POST and OOM the process, and
    // /predicate/explain echoes the value back, doubling the amplification.
    req.on('data', (c) => { size += c.length; if (size > MAX_JSON_BODY) { req.destroy(); reject(new Error('body too large')); return; } chunks.push(c); });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function readRaw(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 256 * 1024) { req.destroy(); reject(new Error('body too large')); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  const json = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(json);
}

function respondIcs(res: ServerResponse, status: number, filename: string, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/calendar; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'public, max-age=60',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function respondText(res: ServerResponse, status: number, contentType: string, body: string, cacheSeconds = 0): void {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

/** Prometheus exposition format (text/plain; version=0.0.4). */
function renderPromMetrics(snap: NonNullable<ReturnType<NonNullable<ApiConfig['getMetricsSnapshot']>>>, buckets: number[]): string {
  const out: string[] = [];
  // Prometheus label values escape the backslash first, then the quote and the
  // newline. Escaping only the quote lets a value close its own label and
  // inject a metric line.
  const escLabel = (v: unknown) =>
    String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const line = (k: string, v: number | string, lbl?: Record<string, string>) => {
    const labels = lbl ? '{' + Object.entries(lbl).map(([k, v]) => `${k}="${escLabel(v)}"`).join(',') + '}' : '';
    out.push(`${k}${labels} ${v}`);
  };
  const uptime = (Date.now() - snap.startedAtMs) / 1000;

  out.push('# HELP sluice_subscriptions Number of subscriptions known to the matcher, by state.');
  out.push('# TYPE sluice_subscriptions gauge');
  line('sluice_subscriptions', snap.activeSubscriptions, { state: 'active' });
  line('sluice_subscriptions', snap.inactiveSubscriptions, { state: 'inactive' });

  out.push('# HELP sluice_deliveries_total Total successful webhook deliveries since matcher start.');
  out.push('# TYPE sluice_deliveries_total counter');
  line('sluice_deliveries_total', snap.deliveriesTotal);

  out.push('# HELP sluice_webhook_results_total Webhook dispatch outcomes by result.');
  out.push('# TYPE sluice_webhook_results_total counter');
  line('sluice_webhook_results_total', snap.webhookOk, { result: 'ok' });
  line('sluice_webhook_results_total', snap.webhookFail, { result: 'fail' });

  out.push('# HELP sluice_webhook_attempts_total Cumulative HTTP attempts across all dispatches (each dispatch may retry up to 3 times).');
  out.push('# TYPE sluice_webhook_attempts_total counter');
  line('sluice_webhook_attempts_total', snap.webhookAttempts);

  out.push('# HELP sluice_record_delivery_results_total On-chain record_delivery submission outcomes.');
  out.push('# TYPE sluice_record_delivery_results_total counter');
  line('sluice_record_delivery_results_total', snap.recordDeliveryOk, { result: 'ok' });
  line('sluice_record_delivery_results_total', snap.recordDeliveryFail, { result: 'fail' });

  out.push('# HELP sluice_webhook_latency_ms Webhook dispatch latency histogram (match to webhook POST response), in milliseconds.');
  out.push('# TYPE sluice_webhook_latency_ms histogram');
  let cum = 0;
  for (let i = 0; i < buckets.length; i++) {
    cum += snap.latencyHistogram[i];
    line('sluice_webhook_latency_ms_bucket', cum, { le: String(buckets[i]) });
  }
  cum += snap.latencyHistogram[buckets.length];
  line('sluice_webhook_latency_ms_bucket', cum, { le: '+Inf' });
  line('sluice_webhook_latency_ms_sum', snap.latencySumMs);
  line('sluice_webhook_latency_ms_count', snap.latencyCount);

  out.push('# HELP sluice_ws_connected Whether the upstream CSPR.cloud websocket stream is currently connected.');
  out.push('# TYPE sluice_ws_connected gauge');
  line('sluice_ws_connected', snap.wsTransfers ? 1 : 0, { stream: 'transfers' });
  line('sluice_ws_connected', snap.wsContractEvents ? 1 : 0, { stream: 'contract-events' });

  out.push('# HELP sluice_validation_buffer_size Number of events currently in the dry-run validation ring buffer.');
  out.push('# TYPE sluice_validation_buffer_size gauge');
  line('sluice_validation_buffer_size', snap.validationBufferSize);
  line('sluice_validation_buffer_seeded', snap.validationBufferSeeded);

  out.push('# HELP sluice_uptime_seconds Seconds since matcher start.');
  out.push('# TYPE sluice_uptime_seconds counter');
  line('sluice_uptime_seconds', uptime.toFixed(1));

  return out.join('\n') + '\n';
}

/**
 * Shields.io-style badge SVG. Left label is dark, right value is colour-coded.
 * Used by the headline /api/badge.svg (sluice → "N delivered · M active") and
 * the per-metric /api/badges/:metric.svg endpoints.
 */
function renderShield(label: string, value: string, valueColor: string): string {
  const labelW = Math.max(45, label.length * 6.7 + 12);
  const valueW = Math.max(50, value.length * 6.7 + 12);
  const totalW = Math.round(labelW + valueW);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20" role="img" aria-label="${label}: ${value}">
  <title>${label}: ${value}</title>
  <linearGradient id="g" x2="0" y2="100%">
    <stop offset="0" stop-color="#fff" stop-opacity=".12"/>
    <stop offset="1" stop-opacity=".12"/>
  </linearGradient>
  <mask id="m"><rect width="${totalW}" height="20" rx="3" fill="#fff"/></mask>
  <g mask="url(#m)">
    <rect width="${labelW}" height="20" fill="#000"/>
    <rect x="${labelW}" width="${valueW}" height="20" fill="${valueColor}"/>
    <rect width="${totalW}" height="20" fill="url(#g)"/>
  </g>
  <g text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11" font-weight="bold">
    <text x="${labelW / 2}" y="15" fill="#bcfc07">${label}</text>
    <text x="${labelW + valueW / 2}" y="15" fill="#000">${value}</text>
  </g>
</svg>`;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h${Math.floor((seconds % 3_600) / 60)}m`;
  return `${Math.floor(seconds / 86_400)}d${Math.floor((seconds % 86_400) / 3_600)}h`;
}

interface BadgeSpec { label: string; value: string; color: string }

/**
 * Self-contained 320x120 HTML widget for one subscription. Drop into any blog
 * via <iframe src="…/embed/sub/N" width="320" height="120" frameborder="0">.
 * Initial values render server-side (no FOUC); client-side poll keeps it
 * fresh every 5s.
 */
function renderEmbed(sub: NonNullable<ReturnType<NonNullable<ApiConfig['getSubscription']>>>, contractHash: string, chain: string): string {
  const cspr = (BigInt(sub.balance) / 1_000_000_000n).toString();
  const explorer = chain === 'casper-test' ? 'https://testnet.cspr.live' : 'https://cspr.live';
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sluice sub_${sub.id}</title>
<style>
  *{box-sizing:border-box} html,body{margin:0;padding:0;background:transparent;color:#000;font:500 13px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}
  a{color:inherit;text-decoration:none}
  .card{width:100%;height:100vh;background:#000;color:#fff;border:1px solid #000;padding:14px 18px;display:flex;flex-direction:column;justify-content:space-between;overflow:hidden;position:relative}
  .row{display:flex;align-items:center;gap:8px}
  .dot{width:7px;height:7px;border-radius:50%}
  .pulse{animation:p 1.6s infinite}
  @keyframes p{0%,100%{opacity:1}50%{opacity:.45}}
  .accent{color:#bcfc07}
  .mono{font-family:'JetBrains Mono',ui-monospace,Menlo,monospace}
  .num{font:600 28px/1 'Casper Sans',Inter,sans-serif;letter-spacing:-.02em}
  .small{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#888}
  .pill{padding:2px 8px;font:600 9px 'JetBrains Mono';letter-spacing:.08em;border-radius:2px}
  .ok{background:#3edc64;color:#000}.bad{background:#ff2d2e;color:#fff}
</style>
</head><body>
<a class="card" id="card" href="${explorer}/contract/${contractHash}" target="_blank" rel="noopener" title="Open Sluice subscription #${sub.id} on cspr.live">
  <div class="row">
    <span class="dot pulse" id="dot" style="background:${sub.active ? '#bcfc07' : '#ff2d2e'}"></span>
    <span class="accent mono" style="font-weight:600;letter-spacing:-.02em">sluice</span>
    <span class="mono small">SUB</span>
    <span class="mono" style="font-weight:600">#${sub.id}</span>
    <span style="flex:1"></span>
    <span class="pill ${sub.active ? 'ok' : 'bad'}" id="status">${sub.active ? 'ACTIVE' : 'INACTIVE'}</span>
  </div>
  <div class="row" style="gap:24px">
    <div>
      <div class="small">BALANCE</div>
      <div class="num"><span id="bal">${esc(cspr)}</span> <span class="mono small" style="color:#888">CSPR</span></div>
    </div>
    <div>
      <div class="small">DELIVERED</div>
      <div class="num"><span id="dlv">${sub.deliveries}</span></div>
    </div>
  </div>
  <div class="row mono" style="font-size:10px;color:#666;letter-spacing:.04em">
    <span>${chain.toUpperCase()}</span>
    <span style="color:#444">·</span>
    <span>updated <span id="ago">just now</span></span>
    <span style="flex:1"></span>
    <span class="accent">sluice.unitynodes.com ↗</span>
  </div>
</a>
<script>
(() => {
  let lastUpdate = Date.now();
  const fmtAgo = () => {
    const dt = Date.now() - lastUpdate;
    if (dt < 5000) return 'just now';
    if (dt < 60_000) return Math.floor(dt/1000) + 's ago';
    return Math.floor(dt/60_000) + 'm ago';
  };
  setInterval(() => { document.getElementById('ago').textContent = fmtAgo(); }, 1000);
  async function poll() {
    try {
      const r = await fetch('/api/snapshot.json?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      const s = j.subscriptions.find((x) => x.id === ${sub.id});
      if (!s) return;
      document.getElementById('bal').textContent = (BigInt(s.balance) / 1000000000n).toString();
      document.getElementById('dlv').textContent = s.deliveries;
      const st = document.getElementById('status');
      st.textContent = s.active ? 'ACTIVE' : 'INACTIVE';
      st.className = 'pill ' + (s.active ? 'ok' : 'bad');
      document.getElementById('dot').style.background = s.active ? '#bcfc07' : '#ff2d2e';
      lastUpdate = Date.now();
    } catch {}
  }
  setInterval(poll, 5000);
})();
</script>
</body></html>`;
}

function buildBadgeSpec(metric: string, snap: NonNullable<ReturnType<NonNullable<ApiConfig['getMetricsSnapshot']>>>, buckets: number[]): BadgeSpec | null {
  const greenIf = (cond: boolean) => cond ? '#3edc64' : '#ff2d2e';
  switch (metric) {
    case 'subs-active':
      return { label: 'sluice subs', value: `${snap.activeSubscriptions} active`, color: snap.activeSubscriptions > 0 ? '#3edc64' : '#999' };
    case 'deliveries':
      return { label: 'sluice', value: `${snap.deliveriesTotal} delivered`, color: '#3edc64' };
    case 'delivery-success': {
      const total = snap.webhookOk + snap.webhookFail;
      if (total === 0) return { label: 'webhook ok', value: 'no data', color: '#999' };
      const pct = (snap.webhookOk / total) * 100;
      const color = pct >= 99 ? '#3edc64' : pct >= 95 ? '#ffb347' : '#ff2d2e';
      return { label: 'webhook ok', value: `${pct.toFixed(1)}% (${snap.webhookOk}/${total})`, color };
    }
    case 'latency-p95': {
      if (snap.latencyCount === 0) return { label: 'webhook p95', value: 'no data', color: '#999' };
      // A p95 over a handful of samples is noise, and one slow outlier drags it
      // to the top bucket. Say the sample is small rather than publishing a
      // number that contradicts the median we quote everywhere else.
      if (snap.latencyCount < 20) {
        return { label: 'webhook p95', value: `n=${snap.latencyCount}, too few`, color: '#999' };
      }
      // approximate from histogram, find bucket where cumulative >= 0.95 * count
      const target = 0.95 * snap.latencyCount;
      let cum = 0;
      // Falling past every bucket means p95 is above the largest one. Render
      // that as "over N", never as the raw "+Inf" sentinel.
      let bucket = `>${buckets[buckets.length - 1]}ms`;
      let overflowed = true;
      for (let i = 0; i < buckets.length; i++) {
        cum += snap.latencyHistogram[i];
        if (cum >= target) { bucket = `≤${buckets[i]}ms`; overflowed = false; break; }
      }
      const bucketMs = Number.parseFloat(bucket.replace(/[^\d.]/g, ''));
      const color = overflowed ? '#ff2d2e'
                  : bucketMs <= 500 ? '#3edc64'
                  : bucketMs <= 2000 ? '#ffb347'
                  : '#ff2d2e';
      return { label: 'webhook p95', value: bucket, color };
    }
    case 'uptime': {
      const up = (Date.now() - snap.startedAtMs) / 1000;
      return { label: 'matcher up', value: formatUptime(up), color: '#3edc64' };
    }
    case 'ws':
      return { label: 'ws transfers', value: snap.wsTransfers ? 'connected' : 'down', color: greenIf(snap.wsTransfers) };
    default:
      return null;
  }
}

/**
 * Render a 1200x630 OG card for a subscription as inline SVG. Chosen over PNG
 * to keep the matcher dependency-free; Discord/Slack/LinkedIn/Facebook accept
 * image/svg+xml previews. Twitter still wants raster, see HONEST_LIMITS.
 */
function renderOgSvg(sub: NonNullable<ReturnType<NonNullable<ApiConfig['getSubscription']>>>, chain: string): string {
  const cspr = (BigInt(sub.balance) / 1_000_000_000n).toString();
  const webhook = sub.webhook_url.length > 56 ? sub.webhook_url.slice(0, 53) + '…' : sub.webhook_url;
  const status = sub.active ? 'ACTIVE' : 'INACTIVE';
  const statusBg = sub.active ? '#3edc64' : '#ff2d2e';
  const chainBadge = chain.toUpperCase();
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630" role="img" aria-label="Sluice subscription ${sub.id}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#000"/>
      <stop offset="1" stop-color="#1a1a1a"/>
    </linearGradient>
    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#1a1a1a" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="630" fill="url(#grid)" opacity=".6"/>
  <g font-family="Inter, -apple-system, system-ui, sans-serif">
    <g transform="translate(60, 60)">
      <rect width="44" height="44" fill="#000"/>
      <polygon points="14,10 34,22 14,34" fill="#bcfc07"/>
      <text x="60" y="32" font-size="28" font-weight="500" fill="#fff" letter-spacing="-.5">sluice</text>
      <text x="170" y="32" font-size="14" font-weight="500" fill="#bcfc07" letter-spacing="2">${chainBadge}</text>
    </g>
    <text x="60" y="220" font-size="28" font-weight="500" fill="#666" letter-spacing="4">SUBSCRIPTION</text>
    <text x="60" y="320" font-size="160" font-weight="600" fill="#fff" letter-spacing="-4">#${sub.id}</text>
    <g transform="translate(60, 380)">
      <rect width="100" height="32" fill="${statusBg}"/>
      <text x="50" y="22" font-size="14" font-weight="600" fill="#000" text-anchor="middle" letter-spacing="2">${status}</text>
    </g>
    <g transform="translate(60, 470)">
      <text font-size="14" font-weight="500" fill="#666" letter-spacing="2">BALANCE</text>
      <text y="32" font-size="32" font-weight="500" fill="#fff">${esc(cspr)} CSPR</text>
    </g>
    <g transform="translate(360, 470)">
      <text font-size="14" font-weight="500" fill="#666" letter-spacing="2">DELIVERIES</text>
      <text y="32" font-size="32" font-weight="500" fill="#fff">${sub.deliveries}</text>
    </g>
    <g transform="translate(660, 470)">
      <text font-size="14" font-weight="500" fill="#666" letter-spacing="2">CONTRACT</text>
      <text y="32" font-size="20" font-weight="500" fill="#fff" font-family="JetBrains Mono, monospace">f3710eaf…b971</text>
    </g>
    <g transform="translate(60, 580)" font-family="JetBrains Mono, monospace">
      <text font-size="13" fill="#666">webhook</text>
      <text x="80" font-size="13" fill="#bcfc07">${esc(webhook)}</text>
    </g>
  </g>
</svg>`;
}

/** ICS escaping: backslashes, commas, semicolons, and newlines per RFC 5545. */
function icsEscape(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function icsTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/**
 * Build an iCalendar VCALENDAR for a subscription:
 *   - VEVENT "balance runs out (estimate)", only if recent rate > 0
 *   - VEVENT "weekly check-in", repeats forever, anchored 7 days out
 *   - VEVENT for each milestone the sub has crossed (100/500/1000 deliveries)
 */
function buildIcs(sub: NonNullable<ReturnType<NonNullable<ApiConfig['getSubscription']>>>, rate: { per_day: number }, contractHash: string, chain: string): string {
  const lines: string[] = [];
  const now = new Date();
  const motesPerCspr = 1_000_000_000;
  // Float division: integer BigInt division truncated sub-1-CSPR balances to 0,
  // which skipped the runway reminder for exactly the subs that need it.
  const balanceCspr = Number(sub.balance) / motesPerCspr;
  const perDeliveryMotes = Number(process.env.SLUICE_PER_DELIVERY_MOTES ?? 500_000_000); // 0.5 CSPR
  const perDeliveryCspr = perDeliveryMotes / motesPerCspr;
  const explorer = chain === 'casper-test' ? 'https://testnet.cspr.live' : 'https://cspr.live';
  const subUrl = `${explorer}/contract/${contractHash}`;

  lines.push('BEGIN:VCALENDAR');
  lines.push('VERSION:2.0');
  lines.push('PRODID:-//Sluice//Subscription Calendar//EN');
  lines.push('CALSCALE:GREGORIAN');
  lines.push('METHOD:PUBLISH');
  lines.push(`X-WR-CALNAME:Sluice sub_${sub.id}`);
  lines.push(`X-WR-CALDESC:On-chain event subscription on Casper (${chain})`);

  // Balance-runs-out projection, only if we have a measurable rate.
  if (rate.per_day > 0 && perDeliveryCspr > 0) {
    const daysLeft = balanceCspr / perDeliveryCspr / rate.per_day;
    if (daysLeft > 0 && daysLeft < 365 * 5) {
      const runOut = new Date(now.getTime() + daysLeft * 86_400 * 1000);
      const reminder = new Date(runOut.getTime() - 86_400 * 1000);
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:sluice-sub-${sub.id}-balance-runout@sluice.unitynodes.com`);
      lines.push(`DTSTAMP:${icsTimestamp(now)}`);
      lines.push(`DTSTART:${icsTimestamp(reminder)}`);
      lines.push(`DTEND:${icsTimestamp(new Date(reminder.getTime() + 60 * 60 * 1000))}`);
      lines.push(`SUMMARY:${icsEscape(`Sluice sub_${sub.id}, top up before balance runs out`)}`);
      lines.push(`DESCRIPTION:${icsEscape(
        `Subscription #${sub.id} balance is projected to hit zero in ~${daysLeft.toFixed(1)} day(s).\n` +
        `Current balance: ${balanceCspr} CSPR\n` +
        `Recent rate: ${rate.per_day.toFixed(2)} deliveries/day\n` +
        `Assumed cost per delivery: ${perDeliveryCspr} CSPR (override via SLUICE_PER_DELIVERY_MOTES).\n` +
        `Top up via the dashboard or CLI: sluice top-up --id ${sub.id} --amount 10`
      )}`);
      lines.push(`URL:${subUrl}`);
      lines.push('END:VEVENT');
    }
  }

  // Weekly check-in, open-ended RRULE.
  const weekly = new Date(now.getTime() + 7 * 86_400 * 1000);
  lines.push('BEGIN:VEVENT');
  lines.push(`UID:sluice-sub-${sub.id}-weekly@sluice.unitynodes.com`);
  lines.push(`DTSTAMP:${icsTimestamp(now)}`);
  lines.push(`DTSTART:${icsTimestamp(weekly)}`);
  lines.push(`DTEND:${icsTimestamp(new Date(weekly.getTime() + 15 * 60 * 1000))}`);
  lines.push('RRULE:FREQ=WEEKLY');
  lines.push(`SUMMARY:${icsEscape(`Sluice sub_${sub.id}, weekly check-in`)}`);
  lines.push(`DESCRIPTION:${icsEscape(
    `Quick weekly look at subscription #${sub.id}:\n` +
    `• balance: ${balanceCspr} CSPR\n` +
    `• deliveries to date: ${sub.deliveries}\n` +
    `• webhook: ${sub.webhook_url}\n` +
    `Open the dashboard: https://sluice.unitynodes.com/app`
  )}`);
  lines.push(`URL:https://sluice.unitynodes.com/app`);
  lines.push('END:VEVENT');

  // Delivery-count milestones already crossed, fixed dates in the past so
  // calendar apps surface them as a one-tap history of the subscription.
  for (const milestone of [100, 500, 1000, 5000, 10000]) {
    if (sub.deliveries < milestone) continue;
    const at = new Date(sub.created_at * 1000); // approximate, we don't track exact crossing
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:sluice-sub-${sub.id}-milestone-${milestone}@sluice.unitynodes.com`);
    lines.push(`DTSTAMP:${icsTimestamp(now)}`);
    lines.push(`DTSTART:${icsTimestamp(at)}`);
    lines.push(`DTEND:${icsTimestamp(new Date(at.getTime() + 15 * 60 * 1000))}`);
    lines.push(`SUMMARY:${icsEscape(`Sluice sub_${sub.id}, ${milestone}+ deliveries`)}`);
    lines.push(`DESCRIPTION:${icsEscape(`Subscription #${sub.id} has crossed ${milestone} on-chain-confirmed deliveries.`)}`);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

// Bound how many casper-client subprocesses the API can fork at once. The
// /tx/build/* and /tx/submit routes are unauthenticated, so without a gate a
// burst of requests could exhaust processes / file descriptors and take the
// matcher down. Excess calls queue rather than spawn.
const CC_MAX = Number(process.env.SLUICE_MAX_TX_SUBPROCESS ?? 4);
let ccActive = 0;
const ccWaiters: Array<() => void> = [];
async function ccAcquire(): Promise<void> {
  if (ccActive < CC_MAX) { ccActive++; return; }
  await new Promise<void>((r) => ccWaiters.push(r));
  ccActive++;
}
function ccRelease(): void {
  ccActive--;
  const next = ccWaiters.shift();
  if (next) next();
}

function spawnCC(bin: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    void ccAcquire().then(() => {
      let settled = false;
      const done = (v: { stdout: string; stderr: string; code: number }) => { if (!settled) { settled = true; ccRelease(); resolve(v); } };
      let child;
      try {
        child = spawn(bin, args, { env: process.env });
      } catch (e) {
        ccRelease(); reject(e as Error); return;
      }
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (e) => { if (!settled) { settled = true; ccRelease(); reject(e); } });
      child.on('close', (code) => done({ stdout, stderr, code: code ?? -1 }));
    });
  });
}

function workspace(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sluice-tx-'));
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

async function buildCreate(cfg: ApiConfig, b: BuildBody): Promise<unknown> {
  if (!b.initiator || !b.predicate_json || !b.webhook_url || !b.motes) {
    throw new Error('initiator, predicate_json, webhook_url, motes are all required');
  }
  // Sanity-check predicate JSON parses.
  JSON.parse(b.predicate_json);
  const { dir, cleanup } = workspace();
  try {
    const out = join(dir, 'unsigned.json');
    const args = [
      'make-transaction', 'package',
      '--initiator-address', b.initiator,
      '--chain-name', cfg.chainName,
      '--pricing-mode', 'classic',
      '--payment-amount', String(cfg.paymentMotes),
      '--gas-price-tolerance', '1',
      '--standard-payment', 'true',
      '--package-address', `package-${cfg.contractHash}`,
      '--session-entry-point', 'create_subscription',
      '--transaction-runtime', 'vm-casper-v1',
      '--transferred-value', b.motes,
      '--session-arg', `predicate_json:string='${b.predicate_json.replace(/'/g, "'\\''")}'`,
      '--session-arg', `webhook_url:string='${b.webhook_url.replace(/'/g, "'\\''")}'`,
      '--output', out,
    ];
    const r = await spawnCC(cfg.casperClientBin, args);
    if (r.code !== 0) throw new Error(`make-transaction failed: ${r.stderr || r.stdout}`);
    return JSON.parse(readFileSync(out, 'utf8'));
  } finally { cleanup(); }
}

async function buildTopUp(cfg: ApiConfig, b: BuildBody): Promise<unknown> {
  if (!b.initiator || b.id == null || !b.motes) throw new Error('initiator, id, motes required');
  const { dir, cleanup } = workspace();
  try {
    const out = join(dir, 'unsigned.json');
    const args = [
      'make-transaction', 'package',
      '--initiator-address', b.initiator,
      '--chain-name', cfg.chainName,
      '--pricing-mode', 'classic',
      '--payment-amount', String(cfg.paymentMotes),
      '--gas-price-tolerance', '1',
      '--standard-payment', 'true',
      '--package-address', `package-${cfg.contractHash}`,
      '--session-entry-point', 'top_up',
      '--transaction-runtime', 'vm-casper-v1',
      '--transferred-value', b.motes,
      '--session-arg', `id:u32='${b.id}'`,
      '--output', out,
    ];
    const r = await spawnCC(cfg.casperClientBin, args);
    if (r.code !== 0) throw new Error(`make-transaction failed: ${r.stderr || r.stdout}`);
    return JSON.parse(readFileSync(out, 'utf8'));
  } finally { cleanup(); }
}

async function buildCancel(cfg: ApiConfig, b: BuildBody): Promise<unknown> {
  if (!b.initiator || b.id == null) throw new Error('initiator, id required');
  const { dir, cleanup } = workspace();
  try {
    const out = join(dir, 'unsigned.json');
    const args = [
      'make-transaction', 'package',
      '--initiator-address', b.initiator,
      '--chain-name', cfg.chainName,
      '--pricing-mode', 'classic',
      '--payment-amount', String(cfg.paymentMotes),
      '--gas-price-tolerance', '1',
      '--standard-payment', 'true',
      '--package-address', `package-${cfg.contractHash}`,
      '--session-entry-point', 'cancel_subscription',
      '--transaction-runtime', 'vm-casper-v1',
      '--session-arg', `id:u32='${b.id}'`,
      '--output', out,
    ];
    const r = await spawnCC(cfg.casperClientBin, args);
    if (r.code !== 0) throw new Error(`make-transaction failed: ${r.stderr || r.stdout}`);
    return JSON.parse(readFileSync(out, 'utf8'));
  } finally { cleanup(); }
}

async function submitTx(cfg: ApiConfig, body: { signed_tx: unknown }): Promise<{ tx_hash: string }> {
  if (!body.signed_tx || typeof body.signed_tx !== 'object') throw new Error('signed_tx (JSON) required');
  const { dir, cleanup } = workspace();
  try {
    const file = join(dir, 'signed.json');
    writeFileSync(file, JSON.stringify(body.signed_tx));
    const r = await spawnCC(cfg.casperClientBin, [
      'send-transaction',
      '--node-address', cfg.nodeRpcUrl,
      '--wasm-path', file,
    ]);
    if (r.code !== 0) throw new Error(`send-transaction failed: ${r.stderr || r.stdout}`);
    // Parse the JSON-RPC response that send-transaction prints.
    const m = r.stdout.match(/"Version1":\s*"([0-9a-f]{64})"/);
    if (!m) throw new Error(`could not extract tx hash from: ${r.stdout.slice(0, 300)}`);
    return { tx_hash: m[1] };
  } finally { cleanup(); }
}

/* ─────────────────── WebSocket fan-out ─────────────────── */

export interface ApiStreamEnvelope {
  type: 'hello' | 'delivery' | 'subs.reload' | 'ping';
  data: unknown;
  ts: string;
}

/**
 * Per-connection state for /api/stream subscribers.
 *
 * - sub_filter is the value of ?sub=N query, undefined when client wants all.
 * - server pings every 25s and drops dead sockets, protects against half-open
 *   TCP states that some proxies leave hanging.
 */
interface StreamClient { ws: WebSocket; subFilter?: number; alive: boolean }

class StreamHub {
  readonly clients = new Set<StreamClient>();

  broadcast(env: Omit<ApiStreamEnvelope, 'ts'>): void {
    const payload = JSON.stringify({ ...env, ts: new Date().toISOString() });
    for (const c of this.clients) {
      if (c.ws.readyState !== WebSocket.OPEN) continue;
      if (env.type === 'delivery' && c.subFilter !== undefined) {
        const subId = (env.data as { subscription_id?: number }).subscription_id;
        if (subId !== c.subFilter) continue;
      }
      try { c.ws.send(payload); } catch {}
    }
  }

  add(client: StreamClient): void { this.clients.add(client); }
  remove(client: StreamClient): void { this.clients.delete(client); }
}

// Fixed-window per-IP rate limiter for state-changing POST routes. The dashboard
// is intentionally usable without a login, so this bounds abuse (spam replay /
// sandbox dispatch, outbound-webhook amplification) rather than locking out
// legitimate users.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = Number(process.env.SLUICE_API_RATE_LIMIT ?? 60);
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  if (rateBuckets.size > 5_000) {
    for (const [k, v] of rateBuckets) if (v.resetAt <= now) rateBuckets.delete(k);
  }
  const b = rateBuckets.get(ip);
  if (!b || b.resetAt <= now) { rateBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS }); return false; }
  b.count++;
  return b.count > RATE_MAX;
}
function clientIp(req: { headers: Record<string, unknown>; socket: { remoteAddress?: string } }): string {
  // Do NOT trust the leftmost X-Forwarded-For entry: it is fully client-chosen,
  // and Cloudflare/Caddy only *append* to the header, so a caller can rotate a
  // fake first hop to dodge the per-IP rate limit. Prefer Cloudflare's
  // CF-Connecting-IP (which CF overwrites, so a client cannot forge it on the
  // normal path), then the rightmost XFF entry (added by the nearest trusted
  // proxy), then the socket address.
  const cf = String(req.headers['cf-connecting-ip'] ?? '').trim();
  if (cf) return cf;
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (xff.length) return xff[xff.length - 1];
  return req.socket.remoteAddress || 'unknown';
}

export function startApi(cfg: ApiConfig): { close: () => void; hub: StreamHub } {
  const hub = new StreamHub();
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') { respond(res, 204, ''); return; }
      const url = req.url || '';
      const [rawRoute, qs = ''] = url.split('?');

      // OpenAPI spec served from disk, drives `npx openapi-typescript-codegen
      // --input https://sluice.unitynodes.com/api/openapi.yaml` for instant
      // typed clients. We search next to the dist/ build first, then the
      // installed repo layout, and 404 cleanly if neither exists.
      if (rawRoute === '/openapi.yaml' && req.method === 'GET') {
        const candidates = [
          join(__dirname, '..', '..', 'docs', 'openapi.yaml'),
          join(process.cwd(), 'docs', 'openapi.yaml'),
        ];
        for (const p of candidates) {
          try {
            const body = readFileSync(p, 'utf8');
            respondText(res, 200, 'application/yaml; charset=utf-8', body, 300);
            return;
          } catch { /* try next */ }
        }
        respond(res, 404, { error: 'openapi.yaml not found on disk' });
        return;
      }

      // Snapshot JSON, so an MCP client or the CLI can read matcher state via
      // the same API base it uses for everything else (the reverse proxy also
      // serves this file statically, but a direct-to-matcher base needs a route).
      if ((rawRoute === '/snapshot.json' || rawRoute === '/snapshot') && req.method === 'GET') {
        const p = process.env.SLUICE_SNAPSHOT_PATH;
        if (p) {
          try {
            const body = readFileSync(p, 'utf8');
            respondText(res, 200, 'application/json; charset=utf-8', body, 5);
            return;
          } catch { /* fall through to 404 */ }
        }
        respond(res, 404, { error: 'snapshot not available' });
        return;
      }

      // Liveness probe. POST is the documented form (see docs/openapi.yaml) and
      // is what the docker healthcheck and the TypeScript client use. Uptime
      // monitors and humans reach for GET, so answer both with the same body.
      if (rawRoute === '/health' && req.method === 'GET') {
        respond(res, 200, { ok: true, contract: cfg.contractHash, chain: cfg.chainName });
        return;
      }

      // Embed widget for a subscription, a 320x120 self-contained HTML page
      // for iframe embedding in blogs, Notion, dashboards, etc. JS polls
      // /api/snapshot.json every 5s; no extra deps.
      const embedMatch = rawRoute.match(/^\/embed\/sub\/(\d+)$/);
      if (embedMatch && req.method === 'GET') {
        if (!cfg.getSubscription) { respond(res, 501, { error: 'subscription lookup not wired' }); return; }
        const id = Number(embedMatch[1]);
        const sub = cfg.getSubscription(id);
        if (!sub) { respond(res, 404, { error: `subscription ${id} not found in matcher's active view` }); return; }
        const html = renderEmbed(sub, cfg.contractHash, cfg.chainName);
        respondText(res, 200, 'text/html; charset=utf-8', html, 30);
        return;
      }

      // Calendar feed for a subscription. text/calendar, GET only.
      const icsMatch = rawRoute.match(/^\/sub\/(\d+)\.ics$/);
      if (icsMatch && req.method === 'GET') {
        if (!cfg.getSubscription) { respond(res, 501, { error: 'subscription lookup not wired' }); return; }
        const id = Number(icsMatch[1]);
        const sub = cfg.getSubscription(id);
        if (!sub) { respond(res, 404, { error: `subscription ${id} not found in matcher's active view` }); return; }
        const rate = cfg.getDeliveryRate ? cfg.getDeliveryRate(id) : { count: 0, window_seconds: 0, per_day: 0 };
        const ics = buildIcs(sub, rate, cfg.contractHash, cfg.chainName);
        respondIcs(res, 200, `sluice-sub-${id}.ics`, ics);
        return;
      }

      // Per-metric Shields-style badge, drop into any README via <img>.
      const badgeMatch = rawRoute.match(/^\/badges\/([a-z0-9-]+)\.svg$/);
      if (badgeMatch && req.method === 'GET') {
        if (!cfg.getMetricsSnapshot || !cfg.latencyBucketsMs) { respond(res, 501, { error: 'metrics not wired' }); return; }
        const metric = badgeMatch[1];
        const snap = cfg.getMetricsSnapshot();
        const spec = buildBadgeSpec(metric, snap, cfg.latencyBucketsMs);
        if (!spec) {
          respond(res, 404, { error: `unknown metric "${metric}"`, available: ['subs-active', 'deliveries', 'delivery-success', 'latency-p95', 'uptime', 'ws'] });
          return;
        }
        respondText(res, 200, 'image/svg+xml; charset=utf-8', renderShield(spec.label, spec.value, spec.color), 60);
        return;
      }

      // OG image for a subscription, accepts /og/sub/:id and /og/sub/:id.svg.
      const ogMatch = rawRoute.match(/^\/og\/sub\/(\d+)(?:\.svg)?$/);
      if (ogMatch && req.method === 'GET') {
        if (!cfg.getSubscription) { respond(res, 501, { error: 'subscription lookup not wired' }); return; }
        const id = Number(ogMatch[1]);
        const sub = cfg.getSubscription(id);
        if (!sub) { respond(res, 404, { error: `subscription ${id} not found in matcher's active view` }); return; }
        const svg = renderOgSvg(sub, cfg.chainName);
        respondText(res, 200, 'image/svg+xml; charset=utf-8', svg, 60);
        return;
      }

      // Cached Casper chain-head proxy, drives the live block counter in the hero
      // and the status page. 3s TTL collapses fanout.
      if (rawRoute === '/chain/head' && req.method === 'GET') {
        const h = await getChainHead(cfg.nodeRpcUrl);
        if (!h) { respondText(res, 502, 'application/json', JSON.stringify({ error: 'upstream node RPC unreachable' })); return; }
        respondText(res, 200, 'application/json', JSON.stringify(h), 3);
        return;
      }

      // Prometheus scrape endpoint.
      if (rawRoute === '/metrics' && req.method === 'GET') {
        if (!cfg.getMetricsSnapshot || !cfg.latencyBucketsMs) { respond(res, 501, { error: 'metrics not wired' }); return; }
        const snap = cfg.getMetricsSnapshot();
        const body = renderPromMetrics(snap, cfg.latencyBucketsMs);
        respondText(res, 200, 'text/plain; version=0.0.4; charset=utf-8', body);
        return;
      }

      // Hosted webhook receiver routes (any HTTP method).
      const recvFeed = rawRoute.match(/^\/hooks\/([a-z0-9-]{4,64})\/feed$/i);
      if (recvFeed && req.method === 'GET') {
        const id = recvFeed[1];
        respond(res, 200, { id, requests: hooks.get(id) ?? [], max: HOOK_MAX, ttl_seconds: HOOK_TTL_MS / 1000 });
        return;
      }
      const recvCatch = rawRoute.match(/^\/hooks\/([a-z0-9-]{4,64})$/i);
      if (recvCatch) {
        const id = recvCatch[1];
        if (!HOOK_ID_RE.test(id)) { respond(res, 400, { error: 'bad id' }); return; }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(',') : (v ?? '');
        const body = req.method && req.method !== 'GET' ? await readRaw(req) : '';
        const entry: HookedRequest = {
          ts: new Date().toISOString(),
          method: req.method || 'GET',
          headers,
          body,
          query: qs,
          remote: req.socket.remoteAddress || '',
        };
        const ring = hooks.get(id) ?? [];
        // Bound the number of distinct ids, not just entries per id: the id is
        // attacker-chosen and GC only evicts on age, so without this a flood of
        // fresh ids grows the map without limit. Evict the oldest id when full.
        if (!hooks.has(id) && hooks.size >= HOOK_MAX_IDS) {
          const oldest = hooks.keys().next().value;
          if (oldest !== undefined) hooks.delete(oldest);
        }
        ring.unshift(entry);
        if (ring.length > HOOK_MAX) ring.length = HOOK_MAX;
        hooks.set(id, ring);
        respond(res, 200, { received: true, id, stored_count: ring.length });
        return;
      }

      if (req.method !== 'POST') { respond(res, 405, { error: 'method not allowed' }); return; }
      if (rateLimited(clientIp(req))) { respond(res, 429, { error: 'rate limit exceeded, slow down' }); return; }
      const route = rawRoute;
      const body = await readJson(req) as Record<string, unknown>;
      log(`${req.method} ${route}`);

      if (route === '/tx/build/create-subscription') {
        const tx = await buildCreate(cfg, body as unknown as BuildBody);
        respond(res, 200, { tx });
      } else if (route === '/tx/build/top-up') {
        const tx = await buildTopUp(cfg, body as unknown as BuildBody);
        respond(res, 200, { tx });
      } else if (route === '/tx/build/cancel') {
        const tx = await buildCancel(cfg, body as unknown as BuildBody);
        respond(res, 200, { tx });
      } else if (route === '/tx/submit') {
        const r = await submitTx(cfg, body as { signed_tx: unknown });
        respond(res, 200, r);
      } else if (route === '/tx/replay') {
        if (!cfg.replay) { respond(res, 501, { error: 'replay not wired' }); return; }
        const { event_hash } = body as { event_hash?: string };
        if (!event_hash) throw new Error('event_hash required');
        const r = await cfg.replay(event_hash);
        respond(res, 200, r);
      } else if (route === '/sandbox/dispatch') {
        if (!cfg.sandboxDispatch) { respond(res, 501, { error: 'sandbox not wired' }); return; }
        const { webhook, predicate, count } = body as { webhook?: string; predicate?: unknown; count?: number };
        if (typeof webhook !== 'string' || !/^https?:\/\//i.test(webhook)) throw new Error('webhook (http/https URL) required');
        const n = Math.max(1, Math.min(Number(count ?? 3), 10));
        const r = await cfg.sandboxDispatch(webhook, predicate ?? null, n);
        respond(res, 200, r);
      } else if (route.match(/^\/sub\/(\d+)\/replay-last$/)) {
        if (!cfg.replayLast) { respond(res, 501, { error: 'replay-last not wired' }); return; }
        const m = route.match(/^\/sub\/(\d+)\/replay-last$/)!;
        const id = Number(m[1]);
        const { n } = body as { n?: number };
        const count = Math.max(1, Math.min(Number(n ?? 10), 20));
        const r = await cfg.replayLast(id, count);
        respond(res, 200, r);
      } else if (route === '/tx/test-webhook') {
        if (!cfg.testWebhook) { respond(res, 501, { error: 'test-webhook not wired' }); return; }
        const { subscription_id } = body as { subscription_id?: number };
        if (typeof subscription_id !== 'number') throw new Error('subscription_id (number) required');
        const r = await cfg.testWebhook(subscription_id);
        respond(res, 200, r);
      } else if (route === '/x402/available') {
        // Peek before paying. An x402 payment settles on-chain and cannot be
        // refunded, so a caller checks here first rather than buying a delivery
        // the matcher has nothing to serve for.
        if (!cfg.hasX402) { respond(res, 501, { error: 'x402 not wired' }); return; }
        const { subscription_id } = body as { subscription_id?: number };
        if (typeof subscription_id !== 'number') throw new Error('subscription_id (number) required');
        respond(res, 200, { subscription_id, available: cfg.hasX402(subscription_id) });
      } else if (route === '/x402/claim') {
        if (!cfg.claimX402) { respond(res, 501, { error: 'x402 claim not wired' }); return; }
        const { subscription_id, tx_hash } = body as { subscription_id?: number; tx_hash?: string };
        if (typeof subscription_id !== 'number') throw new Error('subscription_id (number) required');
        const r = cfg.claimX402(subscription_id, typeof tx_hash === 'string' ? tx_hash : undefined);
        if (!r) { respond(res, 404, { error: 'no matched event pending for this subscription yet' }); return; }
        respond(res, 200, r);
      } else if (route === '/predicate/validate') {
        if (!cfg.validatePredicate) { respond(res, 501, { error: 'validate not wired' }); return; }
        let predicateJson: string;
        const { predicate, predicate_json } = body as { predicate?: unknown; predicate_json?: string };
        if (typeof predicate_json === 'string') {
          predicateJson = predicate_json;
        } else if (predicate && typeof predicate === 'object') {
          predicateJson = JSON.stringify(predicate);
        } else {
          throw new Error('send { predicate: {...} } or { predicate_json: "..." }');
        }
        const r = cfg.validatePredicate(predicateJson);
        respond(res, 200, r);
      } else if (route === '/predicate/from-prompt') {
        if (!cfg.parsePrompt) { respond(res, 501, { error: 'parser not wired' }); return; }
        const { prompt } = body as { prompt?: string };
        if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt (non-empty string) required');
        if (prompt.length > 600) throw new Error('prompt too long (max 600 chars)');
        const r = cfg.parsePrompt(prompt);
        respond(res, 200, r);
      } else if (route === '/predicate/explain') {
        const { predicate, event } = body as { predicate?: unknown; event?: unknown };
        if (!predicate || typeof predicate !== 'object') throw new Error('predicate (object) required');
        if (!event || typeof event !== 'object') throw new Error('event (object) required');
        try { assertPredicate(predicate); }
        catch (e) { if (e instanceof PredicateError) throw new Error(`predicate invalid: ${e.message}`); throw e; }
        const r = evaluateWithTrace(predicate as Predicate, event as TransferEvent);
        respond(res, 200, r);
      } else if (route === '/health') {
        respond(res, 200, { ok: true, contract: cfg.contractHash, chain: cfg.chainName });
      } else {
        respond(res, 404, { error: `unknown route ${route}` });
      }
    } catch (e) {
      log('error:', (e as Error).message);
      respond(res, 400, { error: (e as Error).message });
    }
  });
  // WebSocket public stream, clients subscribe via wss://…/api/stream
  // (Caddy reverse-proxies the upgrade) or ws://127.0.0.1:7799/stream directly.
  const wss = new WebSocketServer({ server, path: '/stream' });
  wss.on('connection', (ws, req) => {
    const u = new URL(req.url || '/', 'http://localhost');
    const subRaw = u.searchParams.get('sub');
    const subFilter = subRaw && /^\d+$/.test(subRaw) ? Number(subRaw) : undefined;
    const client: StreamClient = { ws, subFilter, alive: true };
    hub.add(client);
    ws.send(JSON.stringify({
      type: 'hello',
      data: {
        contract: cfg.contractHash,
        chain: cfg.chainName,
        ping_seconds: 25,
        sub_filter: subFilter ?? null,
      },
      ts: new Date().toISOString(),
    } satisfies ApiStreamEnvelope));
    ws.on('pong', () => { client.alive = true; });
    ws.on('close', () => hub.remove(client));
    ws.on('error', () => hub.remove(client));
  });
  const pingTimer = setInterval(() => {
    for (const c of hub.clients) {
      if (!c.alive) { try { c.ws.terminate(); } catch {} hub.remove(c); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch {}
    }
  }, 25_000);
  pingTimer.unref?.();

  server.listen(cfg.port, '127.0.0.1', () => log(`api listening on http://127.0.0.1:${cfg.port} (+ ws /stream)`));
  return {
    close: () => { clearInterval(pingTimer); for (const c of hub.clients) { try { c.ws.close(); } catch {} } wss.close(); server.close(); },
    hub,
  };
}
