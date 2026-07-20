#!/usr/bin/env node
// Live yield-router agent for the Sluice site.
//
// This is agent.js wired to the LIVE matcher: Sluice delivers each matched
// DemoDex swap (the same events you see in /feed) to this service's webhook, it
// verifies the HMAC, reasons over the swap, and appends its decision to a small
// ring buffer the landing page polls. It turns "an agent could react to Sluice
// events" into "an agent is reacting, right now, on the page."
//
// It reuses agent.js's audited decision logic verbatim (require, no fork). The
// only new thing here is normalising a DemoDex `Swap` event into the deposit
// shape decideRebalance expects, and persisting decisions for the UI.
//
// Env:
//   PORT                    listen port (default 8795, bind 127.0.0.1)
//   SLUICE_WEBHOOK_SECRET   shared HMAC secret (same as the matcher)
//   AGENT_DECISION_LOG      path to write the ring JSON (served by the site)
//   AGENT_LOG_MAX           ring size (default 25)
//   LARGE_DEPOSIT_CSPR      rebalance threshold, forwarded to agent.js (default 50000)
//   ANTHROPIC_API_KEY       if set, agent.js reasons with Claude; else heuristic

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { decideRebalance, verifyHmacSignature } = require('./agent.js');

const PORT = Number(process.env.PORT || 8795);
const HOST = process.env.HOST || '127.0.0.1';
const SECRET = process.env.SLUICE_WEBHOOK_SECRET || '';
const LOG_PATH = process.env.AGENT_DECISION_LOG || '/tmp/sluice-agent-log.json';
const LOG_MAX = Number(process.env.AGENT_LOG_MAX || 25);
const MOTES_PER_CSPR = 1_000_000_000n;

// In-memory ring, seeded from disk so a restart keeps recent history.
let ring = [];
try {
  const prev = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
  if (Array.isArray(prev.decisions)) ring = prev.decisions.slice(0, LOG_MAX);
} catch { /* first run, no log yet */ }

function persist() {
  const body = JSON.stringify({ updated_at: new Date().toISOString(), agent: 'yield-router', decisions: ring }, null, 2);
  const tmp = `${LOG_PATH}.tmp`;
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, LOG_PATH);
  } catch (e) {
    console.error('[live-agent] could not persist log:', e.message);
  }
}

// Normalise whatever Sluice delivered into the { amount, to_account_hash, ... }
// shape agent.js reasons over. A native Transfer already has `amount`; a DemoDex
// contract `Swap` carries it under data.amount_in, so map that across and label
// the pool by the token being swapped into.
function normalise(payload) {
  const e = payload.event || payload;
  if (!e || typeof e !== 'object') return null;
  if (e.amount) return e; // native transfer, already the right shape
  if (e.name === 'Swap' && e.data && e.data.amount_in) {
    return {
      amount: String(e.data.amount_in),
      to_account_hash: `demodex-${String(e.data.token_out || 'pool').toLowerCase()}`,
      token_in: e.data.token_in,
      token_out: e.data.token_out,
      deploy_hash: e.deploy_hash,
      block_height: e.block_height,
      timestamp: e.timestamp,
      contract_package_hash: e.contract_package_hash,
    };
  }
  return null;
}

const app = express();

app.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
  const signature = req.get('X-Sluice-Signature');
  const idempotencyKey = req.get('X-Sluice-Idempotency-Key');

  let verified = false;
  if (SECRET) {
    verified = verifyHmacSignature(raw, signature, SECRET);
    if (!verified) { res.status(401).json({ error: 'invalid X-Sluice-Signature' }); return; }
  }

  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); }
  catch { res.status(400).json({ error: 'body is not valid JSON' }); return; }

  res.sendStatus(200); // ack first, think after

  const event = normalise(payload);
  if (!event) { console.warn('[live-agent] delivery had no usable amount, skipped'); return; }

  try {
    const decision = await decideRebalance(event);
    const row = {
      at: new Date().toISOString(),
      verified,
      subscription_id: payload.subscription_id ?? null,
      deploy_hash: event.deploy_hash ?? null,
      block_height: event.block_height ?? null,
      swap: event.token_in && event.token_out ? `${event.token_in} → ${event.token_out}` : null,
      amount_cspr: decision.amountCspr,
      decision: decision.action,
      decided_by: decision.decidedBy || 'heuristic',
      reason: decision.reason,
      plan: decision.plan ?? null,
      explorer: event.deploy_hash ? `https://testnet.cspr.live/transaction/${event.deploy_hash}` : null,
    };
    ring.unshift(row);
    if (ring.length > LOG_MAX) ring.length = LOG_MAX;
    persist();
    console.log(`[live-agent] ${row.decision} (${row.decided_by}) on ${row.amount_cspr} CSPR swap`);
  } catch (e) {
    console.error('[live-agent] decision loop failed:', e.message);
  }
});

app.get('/decisions', (_req, res) => res.json({ updated_at: new Date().toISOString(), decisions: ring }));
app.get('/health', (_req, res) => res.json({ ok: true, decisions: ring.length, has_secret: !!SECRET }));

if (!SECRET) console.warn('[live-agent] WARNING: SLUICE_WEBHOOK_SECRET unset, signature verification DISABLED. Set it in production.');
app.listen(PORT, HOST, () => console.log(`live yield-router agent on ${HOST}:${PORT}, log=${LOG_PATH}, threshold=${process.env.LARGE_DEPOSIT_CSPR || 50000} CSPR`));
