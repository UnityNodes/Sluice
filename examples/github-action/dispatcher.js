// Minimal bridge: Sluice webhook → GitHub repository_dispatch.
//
//   GITHUB_TOKEN=ghp_…repo-scope \
//   GITHUB_REPO=owner/repo \
//   SLUICE_WEBHOOK_SECRET=<shared> \
//   PORT=8790 node dispatcher.js
//
// The matching .github/workflows/sluice-watch.yml in `owner/repo` listens for
// `repository_dispatch` events of type "sluice-match".

const express = require('express');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8790);
const SECRET = process.env.SLUICE_WEBHOOK_SECRET || '';
const TOKEN = process.env.GITHUB_TOKEN || '';
const REPO = process.env.GITHUB_REPO || '';

if (!TOKEN || !REPO) { console.error('GITHUB_TOKEN + GITHUB_REPO required'); process.exit(1); }

const app = express();
app.use('/sluice', express.raw({ type: 'application/json', limit: '256kb' }));

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

  const payload = JSON.parse(req.body.toString('utf8'));
  try {
    const resp = await fetch(`https://api.github.com/repos/${REPO}/dispatches`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${TOKEN}`,
        'accept': 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'sluice-gha-bridge',
      },
      body: JSON.stringify({ event_type: 'sluice-match', client_payload: payload }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`GitHub HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    res.status(204).end();
  } catch (e) {
    console.error('dispatch failed:', e.message);
    res.status(502).json({ error: e.message });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, repo: REPO, has_secret: !!SECRET }));
app.listen(PORT, () => console.log(`sluice→GHA bridge on :${PORT} for ${REPO}`));
