// Sluice → Telegram bridge. Same shape as the Discord bridge but for Bot API.
//
// Run:
//   TELEGRAM_BOT_TOKEN=123:abc TELEGRAM_CHAT_ID=-1001234567890 \
//   SLUICE_WEBHOOK_SECRET=<shared> PORT=8789 node server.js

const express = require('express');
const rateLimit = require('express-rate-limit');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8789);
const SECRET = process.env.SLUICE_WEBHOOK_SECRET || '';
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT = process.env.TELEGRAM_CHAT_ID || '';

if (!TOKEN || !CHAT) { console.error('TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID required'); process.exit(1); }

const app = express();
const limiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
app.use(limiter);
app.use('/sluice', express.raw({ type: 'application/json', limit: '256kb' }));

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
  const v = verify(req.body, req.header('x-sluice-signature'));
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
  const text =
`🐋 *Sluice match · sub_${String(payload.subscription_id).padStart(4, '0')}*

*${cspr} CSPR* transferred
→ \`${(e.to_account_hash || '').slice(0, 16)}…\`

Block: \`${e.block_height ?? '?'}\`
Deploy: [${(e.deploy_hash || '').slice(0, 12)}…](${txUrl})
When: \`${e.timestamp || '…'}\``;

  try {
    const resp = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.description || `HTTP ${resp.status}`);
    res.status(200).json({ posted: true, message_id: data.result.message_id });
  } catch (err) {
    console.error('tg send failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, seen: seen.size, has_secret: !!SECRET, chat: CHAT }));
app.listen(PORT, () => console.log(`sluice→telegram bridge on :${PORT}, secret=${SECRET ? 'set' : 'unset'}`));
