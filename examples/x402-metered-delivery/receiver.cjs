#!/usr/bin/env node
/**
 * x402-metered Sluice webhook receiver.
 *
 * A Sluice-shaped webhook receiver that is gated by the x402 HTTP micropayment
 * protocol. Instead of billing against a pre-locked on-chain CSPR escrow, every
 * single delivery must carry a valid x402 payment. Unpaid requests are refused
 * with HTTP 402 Payment Required and a challenge describing what to pay.
 *
 * Flow (see README.md for the full ASCII diagram):
 *   1. Payer POSTs a Sluice event to /hook with no X-Payment header.
 *   2. Receiver replies 402 + a payment requirement (amount, pay-to, nonce).
 *   3. Payer signs a payment payload and retries with the X-Payment header.
 *   4. Receiver verifies (STUB), records the payment, processes the event, 200.
 *
 * Run:  node receiver.cjs         (listens on PORT, default 4021)
 * Pay:  node payer.cjs            (drives the full challenge -> pay -> retry loop)
 */

'use strict';

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT || 4021);

// Price per webhook delivery, in motes. 1 CSPR = 1e9 motes.
// 0.001 CSPR = 1_000_000 motes per push.
const PRICE_MOTES = String(process.env.X402_PRICE_MOTES || '1000000');

// The Casper account (purse) that should receive x402 micropayments.
// In production this is your Sluice payout account hash / purse URef.
const PAY_TO = process.env.X402_PAY_TO ||
  'account-hash-0000000000000000000000000000000000000000000000000000000000000000';

// The x402 "scheme" + network this receiver accepts. The real Casper
// facilitator will define canonical values; these are illustrative.
const X402_SCHEME = 'exact';
const X402_NETWORK = process.env.X402_NETWORK || 'casper-testnet';

// Optional: shared secret used to HMAC-verify the Sluice webhook body itself
// (the X-Sluice-Signature header). Independent of x402 payment verification.
const SLUICE_WEBHOOK_SECRET = process.env.SLUICE_WEBHOOK_SECRET || '';

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

// Outstanding challenges we have issued: nonce -> { amountMotes, payTo, issuedAt }.
// A real deployment would use a TTL cache (Redis) so nonces expire and can't be
// replayed indefinitely.
const challenges = new Map();

// Ledger of settled deliveries. Each entry is one paid-and-processed push.
const ledger = [];

// Nonces already consumed by a successful payment, to block replay.
const spentNonces = new Set();

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// x402 payment requirement + challenge encoding
// ---------------------------------------------------------------------------

/**
 * Build a fresh payment requirement and register its nonce.
 * Mirrors the shape of an x402 "accepts" entry: what to pay, to whom, on which
 * network, plus a server-chosen nonce that binds this specific request.
 */
function newPaymentRequirement() {
  const nonce = crypto.randomBytes(16).toString('hex');
  const requirement = {
    x402Version: 1,
    scheme: X402_SCHEME,
    network: X402_NETWORK,
    // amount owed for THIS delivery, in motes (1 CSPR = 1e9 motes)
    maxAmountRequired: PRICE_MOTES,
    asset: 'CSPR',
    payTo: PAY_TO,
    // server-chosen nonce the payer must echo back inside the signed payload
    nonce,
    resource: '/hook',
    description: 'Sluice event delivery, one x402 micropayment per webhook push',
    // window during which this challenge is valid
    maxTimeoutSeconds: Math.floor(CHALLENGE_TTL_MS / 1000),
  };
  challenges.set(nonce, {
    amountMotes: PRICE_MOTES,
    payTo: PAY_TO,
    issuedAt: Date.now(),
  });
  return requirement;
}

// ===========================================================================
// >>> STUB <<<  FACILITATOR VERIFICATION
// ===========================================================================
// The real Casper x402 facilitator (public launch: June 2026) performs actual
// settlement + verification: it checks the signed payment payload against the
// chain, confirms the transfer of `amountMotes` to `payTo`, and returns a
// settlement receipt. See "Wiring the real Casper x402 facilitator" in
// README.md and https://www.casper.network/ai.
//
// Until then this function does STRUCTURAL validation only. It does NOT prove
// that any CSPR actually moved on-chain. DO NOT deploy this as a real paywall.
//
// A decoded X-Payment header is expected to look like:
//   {
//     x402Version: 1,
//     scheme: "exact",
//     network: "casper-testnet",
//     payload: {
//       nonce: "<echoed server nonce>",
//       amountMotes: "1000000",
//       payTo: "account-hash-...",
//       from: "account-hash-<payer>",
//       signature: "<hex signature over the canonical payload>"
//     }
//   }
// ===========================================================================
function verifyPaymentStub(xPaymentHeader) {
  let decoded;
  try {
    // x402 transports the payment as a base64-encoded JSON object.
    const json = Buffer.from(xPaymentHeader, 'base64').toString('utf8');
    decoded = JSON.parse(json);
  } catch (_e) {
    return { ok: false, reason: 'X-Payment header is not valid base64 JSON' };
  }

  const p = decoded && decoded.payload;
  if (!p || typeof p !== 'object') {
    return { ok: false, reason: 'missing payment payload' };
  }
  if (decoded.scheme !== X402_SCHEME || decoded.network !== X402_NETWORK) {
    return { ok: false, reason: 'scheme/network mismatch' };
  }

  const challenge = challenges.get(p.nonce);
  if (!challenge) {
    return { ok: false, reason: 'unknown or expired nonce' };
  }
  if (spentNonces.has(p.nonce)) {
    return { ok: false, reason: 'nonce already spent (replay)' };
  }
  if (Date.now() - challenge.issuedAt > CHALLENGE_TTL_MS) {
    challenges.delete(p.nonce);
    return { ok: false, reason: 'challenge expired' };
  }
  // Underpayment check: must pay at least the quoted amount.
  if (BigInt(p.amountMotes || '0') < BigInt(challenge.amountMotes)) {
    return { ok: false, reason: 'underpaid' };
  }
  if (p.payTo !== challenge.payTo) {
    return { ok: false, reason: 'wrong pay-to address' };
  }
  if (!p.signature || typeof p.signature !== 'string' || p.signature.length < 8) {
    return { ok: false, reason: 'missing signature' };
  }

  // >>> STUB <<< In production, hand `decoded` to the Casper x402 facilitator:
  //   const receipt = await facilitator.verifyAndSettle(decoded, requirement);
  //   if (!receipt.settled) return { ok: false, reason: receipt.error };
  // Here we fabricate a receipt so the demo can complete offline.
  const settlementTxHash =
    'stub-settlement-' + crypto.createHash('sha256')
      .update(p.nonce + ':' + p.signature).digest('hex').slice(0, 40);

  return {
    ok: true,
    stubbed: true,
    payment: {
      nonce: p.nonce,
      amountMotes: String(p.amountMotes),
      payTo: p.payTo,
      from: p.from || 'account-hash-unknown',
      settlementTxHash,
    },
  };
}
// ===========================================================================
// >>> END STUB <<<
// ===========================================================================

// ---------------------------------------------------------------------------
// Optional Sluice HMAC verification (independent of x402)
// ---------------------------------------------------------------------------
function verifySluiceSignature(rawBody, header) {
  if (!SLUICE_WEBHOOK_SECRET) return { verified: false, reason: 'no secret set' };
  if (!header || !header.startsWith('sha256=')) {
    return { verified: false, reason: 'missing X-Sluice-Signature' };
  }
  const expected = crypto
    .createHmac('sha256', SLUICE_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  const got = header.slice('sha256='.length);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(got, 'hex');
  const verified = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { verified, reason: verified ? 'ok' : 'signature mismatch' };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const app = express();
const limiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
app.use(limiter);

// Keep the raw body so we can HMAC-verify the Sluice signature byte-for-byte.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);

/**
 * POST /hook, x402-gated Sluice webhook sink.
 *
 * No / invalid X-Payment  -> 402 Payment Required + challenge.
 * Valid X-Payment (stub)  -> record payment, process event, 200.
 */
app.post('/hook', (req, res) => {
  const xPayment = req.get('X-Payment');

  // --- Unpaid: issue an x402 challenge -----------------------------------
  if (!xPayment) {
    const requirement = newPaymentRequirement();
    return res.status(402).json({
      error: 'payment_required',
      message:
        'This Sluice delivery endpoint is x402-metered. Pay per push, then ' +
        'retry with an X-Payment header.',
      // The `accepts` array matches the x402 spec: a list of payment options
      // the client may satisfy. We offer exactly one here.
      accepts: [requirement],
    });
  }

  // --- Paid: verify (STUB) -----------------------------------------------
  const result = verifyPaymentStub(xPayment);
  if (!result.ok) {
    // 402 again, the payment was present but not acceptable.
    const requirement = newPaymentRequirement();
    return res.status(402).json({
      error: 'payment_invalid',
      message: 'X-Payment header rejected: ' + result.reason,
      accepts: [requirement],
    });
  }

  // Payment accepted. Burn the nonce so it can't be replayed.
  spentNonces.add(result.payment.nonce);
  challenges.delete(result.payment.nonce);

  // --- Process the Sluice event ------------------------------------------
  const body = req.body || {};
  const sig = verifySluiceSignature(req.rawBody || '', req.get('X-Sluice-Signature'));

  const event = body.event || {};
  const record = {
    seq: ledger.length + 1,
    at: new Date().toISOString(),
    subscription_id: body.subscription_id || null,
    delivered_at: body.delivered_at || null,
    event: {
      amount: event.amount ?? null,
      to_account_hash: event.to_account_hash ?? null,
    },
    payment: result.payment,        // includes (stub) settlementTxHash
    sluice_signature_verified: sig.verified,
    facilitator_stub: true,         // honesty flag: settlement was NOT real
  };
  ledger.push(record);

  // >>> This is where real Sluice-side business logic goes: enqueue the
  //     transfer for a trading agent, forward to Discord, update a DB, etc.
  console.log(
    (`[receiver] paid delivery #${record.seq}, ` +
    `${event.amount ?? '?'} motes to ${short(event.to_account_hash)} ` +
    `(stub settle ${result.payment.settlementTxHash})`).replace(/\n|\r/g, '')
  );

  return res.status(200).json({
    ok: true,
    seq: record.seq,
    processed: true,
    payment: {
      amountMotes: result.payment.amountMotes,
      settlementTxHash: result.payment.settlementTxHash,
      stubbed: true,
    },
    sluice_signature_verified: sig.verified,
  });
});

/** GET /ledger, the list of paid, processed deliveries. */
app.get('/ledger', (_req, res) => {
  const totalMotes = ledger.reduce(
    (acc, r) => acc + BigInt(r.payment.amountMotes),
    0n
  );
  res.json({
    count: ledger.length,
    total_paid_motes: totalMotes.toString(),
    total_paid_cspr: (Number(totalMotes) / 1e9).toString(),
    price_per_delivery_motes: PRICE_MOTES,
    facilitator: 'STUB, settlement not verified on-chain',
    deliveries: ledger,
  });
});

/** GET /healthz, liveness probe for demo.sh. */
app.get('/healthz', (_req, res) => res.json({ ok: true }));

function short(h) {
  if (!h || typeof h !== 'string') return String(h);
  return h.length > 20 ? h.slice(0, 12) + '…' : h;
}

// Export config + helpers so payer.cjs can reuse them in-process if desired.
module.exports = { app, PRICE_MOTES, PAY_TO, X402_SCHEME, X402_NETWORK };

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[receiver] x402-metered Sluice receiver on http://localhost:${PORT}`);
    console.log(`[receiver] price: ${PRICE_MOTES} motes/delivery -> ${PAY_TO}`);
    console.log('[receiver] WARNING: facilitator verification is a STUB, no CSPR moves.');
  });
}
