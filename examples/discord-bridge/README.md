# sluice → Discord bridge

Small Express receiver that forwards Sluice matches to a Discord channel via an incoming-webhook URL.

## Run

```bash
cd examples/discord-bridge && npm install

SLUICE_WEBHOOK_SECRET=<shared with sluice matcher> \
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/... \
PORT=8788 npm start
```

Expose it publicly (Cloudflare Tunnel, ngrok, fly.io) then point your subscription at it:

```bash
sluice subscribe \
  --predicate ../whale-transfers.json \
  --webhook https://your-host.example/sluice \
  --amount 10
```

## Security

- When `SLUICE_WEBHOOK_SECRET` is set, the `X-Sluice-Signature` HMAC is verified with a constant-time compare and any request without a valid signature gets 401. If the secret is left unset (local testing), verification is skipped and the bridge logs a warning at startup. Always set it in production.
- `Idempotency-Key` dedupes retries in a 1-hour rolling window.
- Discord URL is never echoed back; if it's revoked just rotate it on the bridge.

## Output

Each match renders a Discord embed with `block`, `deploy_hash`, amount in CSPR, and a `cspr.live` link.
