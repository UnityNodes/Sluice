#!/usr/bin/env node
/**
 * x402 payer, the client side of the pay-per-delivery loop.
 *
 * Simulates whatever is pushing Sluice events (Sluice's own delivery worker, or
 * any pipeline that wants to pay per webhook). It performs the full x402 dance:
 *
 *   1. POST /hook with a Sluice event, NO payment  -> expect 402 + challenge.
 *   2. Read the challenge (amount, pay-to, nonce).
 *   3. Build + sign a payment payload (signing is a STUB here).
 *   4. Retry POST /hook with the X-Payment header  -> expect 200.
 *
 * Usage:
 *   node payer.js                      # pays for one delivery against localhost
 *   node payer.js --unpaid             # only does step 1 (shows the 402)
 *   BASE_URL=http://host:4021 node payer.js
 */

'use strict';

const crypto = require('crypto');

const BASE_URL = process.env.BASE_URL || 'http://localhost:4021';

// A demo payer identity. In production this is the agent's Casper account and
// its real key pair.
const PAYER_ACCOUNT =
  process.env.X402_FROM ||
  'account-hash-1111111111111111111111111111111111111111111111111111111111111111';
const PAYER_SECRET = process.env.X402_PAYER_SECRET || 'demo-payer-secret';

// A representative Sluice webhook body.
// Shape: { subscription_id, event:{amount,to_account_hash,...}, delivered_at }
function sampleSluiceEvent() {
  return {
    subscription_id: 'sub_x402_demo',
    event: {
      amount: '5000000000000', // 5000 CSPR in motes
      to_account_hash:
        'account-hash-dc725246306b8ebf3f0e7a3f2c9b1d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5',
      deploy_hash: 'stub-deploy-hash',
    },
    delivered_at: new Date().toISOString(),
  };
}

// ===========================================================================
// >>> STUB <<<  PAYMENT SIGNING
// ===========================================================================
// The real client signs the canonical x402 payload with its Casper key so the
// facilitator can verify the transfer authorization. Here we produce a
// deterministic HMAC placeholder so the demo runs offline. This signature
// proves NOTHING on-chain, it only satisfies the receiver's structural stub.
// Wire your Casper signer (CSPR SDK / facilitator client) here in production.
// ===========================================================================
function signPayment(payload) {
  const canonical = JSON.stringify([
    payload.nonce,
    payload.amountMotes,
    payload.payTo,
    payload.from,
  ]);
  return crypto.createHmac('sha256', PAYER_SECRET).update(canonical).digest('hex');
}

function buildXPaymentHeader(requirement) {
  const payload = {
    nonce: requirement.nonce,
    amountMotes: requirement.maxAmountRequired,
    payTo: requirement.payTo,
    from: PAYER_ACCOUNT,
  };
  payload.signature = signPayment(payload); // >>> STUB signature <<<

  const envelope = {
    x402Version: requirement.x402Version,
    scheme: requirement.scheme,
    network: requirement.network,
    payload,
  };
  // x402 transports the payment as base64-encoded JSON in the X-Payment header.
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
}
// ===========================================================================
// >>> END STUB <<<
// ===========================================================================

async function postHook(headers, body) {
  const res = await fetch(`${BASE_URL}/hook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  let json;
  try {
    json = await res.json();
  } catch (_e) {
    json = { raw: await res.text() };
  }
  return { status: res.status, json };
}

async function payForOneDelivery({ unpaidOnly = false } = {}) {
  const event = sampleSluiceEvent();

  // --- Step 1: unpaid request -> 402 -------------------------------------
  console.log('[payer] POST /hook  (no payment) ...');
  const first = await postHook({}, event);
  console.log(`[payer]   -> ${first.status} ${first.json.error || ''}`);

  if (first.status !== 402) {
    console.error('[payer] expected 402, got', first.status);
    process.exitCode = 1;
    return;
  }

  const requirement = first.json.accepts && first.json.accepts[0];
  console.log(
    `[payer]   challenge: pay ${requirement.maxAmountRequired} motes to ` +
    `${requirement.payTo.slice(0, 20)}… nonce=${requirement.nonce.slice(0, 8)}…`
  );

  if (unpaidOnly) return;

  // --- Steps 2-3: sign the payment ---------------------------------------
  const xPayment = buildXPaymentHeader(requirement); // >>> STUB signing <<<

  // --- Step 4: retry WITH payment -> 200 ---------------------------------
  console.log('[payer] retry POST /hook  (X-Payment attached) ...');
  const second = await postHook({ 'X-Payment': xPayment }, event);
  console.log(`[payer]   -> ${second.status}`, second.json.ok ? 'OK' : second.json.error);
  if (second.status === 200) {
    console.log(
      `[payer]   settled (stub) tx=${second.json.payment.settlementTxHash} ` +
      `seq=${second.json.seq}`
    );
  } else {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  const unpaidOnly = process.argv.includes('--unpaid');
  payForOneDelivery({ unpaidOnly }).catch((err) => {
    console.error('[payer] error:', err.message);
    process.exit(1);
  });
}

module.exports = { buildXPaymentHeader, signPayment, sampleSluiceEvent };
