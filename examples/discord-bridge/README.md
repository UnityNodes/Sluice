# sluice → Discord bridge

50-line Express receiver that forwards Sluice matches to a Discord channel via an incoming-webhook URL.

## Run

```bash
cd examples/discord-bridge && npm install

SLUICE_WEBHOOK_SECRET=<shared with sluice matcher> \
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...\
PORT=8788 npm start
```

Expose it publicly (Cloudflare Tunnel, ngrok, fly.io) then point your subscription at it:

```bash
sluice subscribe \
  --predicate ./whale.json \
  --webhook https://your-host.example/sluice \
  --amount 10
```

## Security

- HMAC `X-Sluice-Signature` verified with constant-time compare. Requests without a valid signature get 401.
- `Idempotency-Key` dedupes retries in a 1-hour rolling window.
- Discord URL is never echoed back; if it's revoked just rotate it on the bridge.

## Output

Each match renders a Discord embed with `block`, `deploy_hash`, amount in CSPR, and a `cspr.live` link.
