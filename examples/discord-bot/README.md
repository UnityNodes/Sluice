# Sluice → Discord bot example

End-to-end demo: someone runs `/sluice-watch whale-100k` in a Discord channel, the bot wires up a Sluice subscription (sandbox or real), and every matched on-chain transfer shows up in that channel.

```text
┌─────────────┐   /sluice-watch   ┌────────┐   POST /sandbox/dispatch   ┌─────────┐
│  Discord    │ ────────────────▶ │  bot   │ ─────────────────────────▶ │ matcher │
│  channel    │                   │ (this) │                            └────┬────┘
└──────▲──────┘                   └───▲────┘                                 │
       │                              │      webhook POSTs (HMAC-signed)     │
       │                              └─────────────────────────────────────┘
       │   discord.send                                                       
       └─────────────────────────────────────────────────────────────────────
```

## Setup

```bash
cd examples/discord-bot
npm install
```

1. Create a Discord application at [discord.com/developers/applications](https://discord.com/developers/applications). Add a bot user, copy the token, and add the application to your test guild with `applications.commands` + `bot` scopes.
2. Set env vars:

   ```bash
   export DISCORD_TOKEN=...                                # bot token
   export DISCORD_APP_ID=...                               # application id
   export DISCORD_GUILD_ID=...                             # optional, instant register for one guild
   export PUBLIC_WEBHOOK_URL=https://your-bot.example.com/webhook
   export SLUICE_WEBHOOK_SECRET=$(openssl rand -hex 32)    # share with the matcher
   ```

3. Register slash commands (one time per guild):

   ```bash
   npm run register
   ```

4. Run the bot (needs a public URL, use ngrok / Cloudflare Tunnel in dev):

   ```bash
   npm start
   ```

5. In Discord: `/sluice-watch recipe:🐋 100k+ CSPR transfers`

## Recipes

Edit [`recipes.js`](recipes.js) to add or rename presets. Each entry is a `{ label, predicate }` pair. The bot exposes labels as autocomplete options on the slash command.

## Live vs sandbox

- `mode: sandbox` (default) calls `POST /api/sandbox/dispatch`, the matcher fires three demo events at your `PUBLIC_WEBHOOK_URL` with no on-chain effect. Great for development and showcase demos. **No CSPR spent.**
- `mode: live` is intentionally disabled in the example to prevent accidental spend. The commented section in [`bot.js`](bot.js) shows where to call `sluice subscribe` (CLI subprocess) or `sluice.tx.build*` (REST) to wire up a real subscription.

## HMAC verification

Every webhook POST the bot receives goes through `sluiceExpress(secret)` from `@sluice/client/middleware`, constant-time signature compare against `X-Sluice-Signature`, body parsing, and `req.sluice.{verified, eventHash, subscriptionId, rawBody}` attached for the handler.

If you don't set `SLUICE_WEBHOOK_SECRET`, the middleware still parses the body but flags `verified: false`. The bot includes a `🔒 verified` / `⚠️ unsigned` indicator in the message footer.

## What you'll see in Discord

```
⚡ On-chain Transfer matched
Amount:  5,000 CSPR
To:      `dc725246306b8ebf…`
View on cspr.live
🔒 verified

sluice sub_3 · 12:34:56
```

Sandbox events render in yellow with `🧪 Sandbox event` instead, so the channel always tells you which is which.
