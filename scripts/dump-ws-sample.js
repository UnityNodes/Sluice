#!/usr/bin/env node
// Dumps the first Transfer event from CSPR.cloud streaming to examples/transfer-event.json.
//
//   SLUICE_CSPR_CLOUD_TOKEN=<token> node scripts/dump-ws-sample.js
//
// Run once to capture the real CSPR.cloud payload schema into examples/transfer-event.json.

const fs = require('node:fs');
const path = require('node:path');
// `ws` is installed under matcher/node_modules, resolve from there.
const WebSocket = require(path.resolve(__dirname, '..', 'matcher', 'node_modules', 'ws'));

const TOKEN = process.env.SLUICE_CSPR_CLOUD_TOKEN;
if (!TOKEN) {
  console.error('SLUICE_CSPR_CLOUD_TOKEN env var required');
  process.exit(1);
}
const URL = process.env.SLUICE_STREAMING_WS_URL || 'wss://streaming.testnet.cspr.cloud/transfers';
const OUT = path.resolve(__dirname, '..', 'examples', 'transfer-event.json');

console.log('connecting', URL);
const ws = new WebSocket(URL, { headers: { authorization: TOKEN } });

ws.on('open', () => console.log('ws open, waiting for first Transfer event...'));
ws.on('error', (e) => { console.error('ws error', e.message); process.exit(2); });

let captured = false;
ws.on('message', (raw) => {
  if (captured) return;
  const text = raw.toString();
  // CSPR.cloud sends string "Ping" keepalives every few seconds, drop them.
  if (text === 'Ping') { process.stdout.write('p'); return; }
  let env;
  try { env = JSON.parse(text); } catch (e) { console.error('non-JSON frame', e.message, '->', text.slice(0, 80)); return; }
  if (!env || !env.data) { console.log('skip frame:', JSON.stringify(env).slice(0, 120)); return; }
  captured = true;
  fs.writeFileSync(OUT, JSON.stringify(env, null, 2));
  console.log(`\ncaptured to ${OUT}`);
  console.log('keys in env.data:', Object.keys(env.data).join(', '));
  ws.close();
  process.exit(0);
});

// Testnet transfers are sparse, wait up to 15 min by default.
const WAIT_MS = Number(process.env.SLUICE_DUMP_TIMEOUT_MS || 15 * 60_000);
setTimeout(() => {
  if (!captured) { console.error(`\nno event in ${Math.round(WAIT_MS / 1000)}s, check token / endpoint`); process.exit(3); }
}, WAIT_MS);
