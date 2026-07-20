# sluice → Telegram bridge

Identical to the Discord bridge, but speaks the Telegram Bot API.

## Run

```bash
cd examples/telegram-bridge && npm install

TELEGRAM_BOT_TOKEN=123456:abc-your-bot-token \
TELEGRAM_CHAT_ID=-1001234567890 \
SLUICE_WEBHOOK_SECRET=<shared with sluice matcher> \
PORT=8789 npm start
```

`TELEGRAM_CHAT_ID` is the channel/group/user ID, find it by sending a message to your bot and calling `https://api.telegram.org/bot<TOKEN>/getUpdates`.

Then in Sluice:

```bash
sluice subscribe \
  --predicate ../treasury-inbox.json \
  --webhook https://your-host.example/sluice \
  --amount 10
```

## Output

Markdown-formatted message with the matched amount, deploy hash, block height, and a clickable `cspr.live` link.
