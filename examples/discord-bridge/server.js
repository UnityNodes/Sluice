// Sluice → Discord bridge.
//
// Drops every Sluice match into a Discord channel via an incoming-webhook URL.
// Verifies the X-Sluice-Signature HMAC and idempotency-dedupes inside a 1 hour window.
//
// Run:
//   SLUICE_WEBHOOK_SECRET=<shared> DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/... \
//     PORT=8788 node server.js
//
// Then in Sluice CLI:
//   sluice subscribe --webhook https://<your-host>:8788/sluice ...

const express = require('express');
const rateLimit = require('express-rate-limit');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8788);
const SECRET = process.env.SLUICE_WEBHOOK_SECRET || '';
const DISCORD_URL = process.env.DISCORD_WEBHOOK_URL || '';

if (!DISCORD_URL) { console.error('DISCORD_WEBHOOK_URL is required'); process.exit(1); }

const app = express();
const limiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
app.use(limiter);
app.use('/sluice', express.raw({ type: 'application/json', limit: '256kb' }));

// One-hour idempotency window.
const seen = new Map();
setInterval(() => { for (const [k, t] of seen) if (Date.now() - t > 3600_000) seen.delete(k); }, 60_000);

function verify(body, header) {
  if (!SECRET) return { ok: true };
  if (!header || !header.startsWith('sha256=')) return { ok: false, reason: 'no signature' };
  const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  const a = Buffer.from(header); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'sig mismatch' };
  return { ok: true };
}

app.post('/sluice', async (req, res) => {
  const sig = req.header('x-sluice-signature');
  const v = verify(req.body, sig);
  if (!v.ok) return res.status(401).json({ error: v.reason });

  const idem = req.header('idempotency-key') || crypto.randomUUID();
  if (seen.has(idem)) return res.status(200).json({ duplicate: true });
  seen.set(idem, Date.now());

  // express.raw only fills req.body for application/json, so anything else
  // arrives as {} and would throw here. Reject it instead of letting the
  // rejection take the process down.
  let payload;
  try {
    payload = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '');
    if (!payload || typeof payload !== 'object') throw new Error('body must be a JSON object');
  } catch (err) {
    return res.status(400).json({ error: `invalid JSON body: ${err.message}` });
  }

  const e = payload.event || {};
  let cspr;
  try {
    cspr = (BigInt(e.amount || '0') / 1_000_000_000n).toString();
  } catch {
    return res.status(400).json({ error: 'event.amount must be an integer string of motes' });
  }
  const txUrl = `https://testnet.cspr.live/transaction/${e.deploy_hash}`;
  const msg = {
    embeds: [{
      title: `🐋 Sluice, sub_${String(payload.subscription_id).padStart(4, '0')}`,
      description: `**${cspr} CSPR** transferred to \`${(e.to_account_hash || '').slice(0, 16)}…\``,
      url: txUrl,
      color: 0xbcfc07,
      fields: [
        { name: 'Block', value: String(e.block_height ?? '?'), inline: true },
        { name: 'Deploy', value: `[${(e.deploy_hash || '').slice(0, 12)}…](${txUrl})`, inline: true },
        { name: 'When', value: e.timestamp || '…', inline: false },
      ],
      footer: { text: 'sluice.unitynodes.com' },
    }],
  };

  try {
    const resp = await fetch(DISCORD_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(msg),
    });
    if (!resp.ok) throw new Error(`Discord HTTP ${resp.status}`);
    res.status(200).json({ posted: true });
  } catch (err) {
    console.error('discord post failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, seen: seen.size, has_secret: !!SECRET }));
app.listen(PORT, () => console.log(`sluice→discord bridge on :${PORT}, secret=${SECRET ? 'set' : 'unset'}`));
