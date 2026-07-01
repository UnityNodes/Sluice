// Sluice demo webhook, logs every received POST and replies 200.
// Used by the buildathon demo video to show end-to-end delivery.

const express = require('express');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8787);
const SECRET = process.env.SLUICE_WEBHOOK_SECRET || '';

const app = express();
// We want the RAW body to verify HMAC, then parse JSON ourselves.
app.use(express.raw({ type: 'application/json', limit: '256kb' }));

const seen = new Map(); // idempotency-key → first seen at

/** Constant-time compare to avoid signature-timing oracles. */
function verify(rawBody, header) {
  if (!SECRET) return { ok: true, reason: 'no secret configured (verification disabled)' };
  if (!header || !header.startsWith('sha256=')) return { ok: false, reason: 'missing or malformed X-Sluice-Signature' };
  const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return { ok: false, reason: 'signature length mismatch' };
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'signature mismatch' };
  return { ok: true, reason: 'verified' };
}

app.post('/', (req, res) => {
  const sigHeader = req.header('x-sluice-signature');
  const verdict = verify(req.body, sigHeader);
  if (!verdict.ok) {
    console.log(`[${new Date().toISOString()}] REJECT, ${verdict.reason}, header=${sigHeader || '(none)'}`);
    return res.status(401).json({ error: verdict.reason });
  }

  const idem = req.header('idempotency-key') || '(none)';
  const dupe = seen.has(idem);
  if (!dupe) seen.set(idem, new Date().toISOString());

  const body = JSON.parse(req.body.toString('utf8'));
  const e = body.event;
  const sub = body.subscription_id;
  console.log(
    `[${new Date().toISOString()}] sub=${sub} amount=${e?.amount} to=${e?.to_account_hash}` +
    `  deploy=${e?.deploy_hash}  idem=${idem.substring(0, 16)}...  sig=${verdict.reason}  ${dupe ? '(duplicate, deduped)' : ''}`,
  );
  res.status(200).json({ received: true, duplicate: dupe, signature: verdict.reason });
});

app.get('/health', (_req, res) => res.json({ ok: true, seen: seen.size }));

app.listen(PORT, () => {
  console.log(`sluice demo-webhook listening on http://0.0.0.0:${PORT}`);
});
