/**
 * Sluice → Discord, minimal but end-to-end.
 *
 *   1. /sluice-watch <recipe> [mode]   maps to a predicate from recipes.js
 *   2. mode=sandbox (default)          fires 3 free demo events at our /webhook
 *      mode=live                       creates a real subscription (admin: env SLUICE_KEY + SLUICE_CONTRACT_HASH)
 *   3. Every webhook POST              gets posted into the same channel
 *
 * Required env:
 *   DISCORD_TOKEN, DISCORD_APP_ID                discord.com/developers credentials
 *   PUBLIC_WEBHOOK_URL                            https://your-bot.example.com/webhook (matcher → this bot)
 *   SLUICE_WEBHOOK_SECRET                         shared HMAC secret (matches the matcher's secret)
 *   SLUICE_API_URL          (optional, default: https://sluice.unitynodes.com/api)
 *   PORT                    (optional, default: 8787)
 *
 * Live-mode-only (skip if you only want sandbox):
 *   SLUICE_KEY, SLUICE_CONTRACT_HASH              passed through to `sluice subscribe` subprocess
 */
'use strict';

const express = require('express');
const { Client, GatewayIntentBits, Events, EmbedBuilder } = require('discord.js');
const { SluiceClient } = require('@sluice/client');
const { sluiceExpress } = require('@sluice/client/middleware');
const RECIPES = require('./recipes');

const DISCORD_TOKEN = required('DISCORD_TOKEN');
const PUBLIC_WEBHOOK_URL = required('PUBLIC_WEBHOOK_URL');
const SLUICE_WEBHOOK_SECRET = process.env.SLUICE_WEBHOOK_SECRET; // optional but recommended
const PORT = Number(process.env.PORT || 8787);

const sluice = new SluiceClient({ baseUrl: process.env.SLUICE_API_URL });

// channel_id → { sub_id?, recipe, mode } so we can route incoming webhooks
const SUBS = new Map();
// sub_id → channel_id back-reference for fast lookup on delivery
const SUB_TO_CHANNEL = new Map();

/* ─────────────── discord side ─────────────── */

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once(Events.ClientReady, (c) => console.log(`logged in as ${c.user.tag}`));

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand()) return;
  try {
    if (i.commandName === 'sluice-watch') {
      const recipeKey = i.options.getString('recipe', true);
      const mode = i.options.getString('mode') || 'sandbox';
      const recipe = RECIPES[recipeKey];
      if (!recipe) return i.reply({ content: `unknown recipe \`${recipeKey}\``, ephemeral: true });

      await i.deferReply();
      if (mode === 'sandbox') {
        const res = await sluice.sandbox.dispatch(PUBLIC_WEBHOOK_URL, { predicate: recipe.predicate, count: 3 });
        SUBS.set(i.channelId, { recipe: recipeKey, mode: 'sandbox' });
        await i.editReply(
          `🧪 **Sandbox: ${recipe.label}**\n` +
          `Fired ${res.delivered}/${res.requested} test events at the bot's webhook. ` +
          `${res.matched_in_buffer} matched the recent on-chain buffer; ${res.used_synthetic ? 'others were synthetic.' : 'all were real events.'}\n` +
          `Watch this channel, they should land in the next few seconds.`,
        );
      } else {
        // Live mode would shell out to `sluice subscribe` here (kept commented to
        // avoid accidental spend in the example). The subscription would land,
        // the matcher would push deliveries to PUBLIC_WEBHOOK_URL, and the
        // webhook handler below would route them into this channel.
        await i.editReply(
          `🔒 **Live mode** is disabled in this example to prevent accidental CSPR spend. ` +
          `Wire \`sluice subscribe --predicate ${recipeKey}.json --webhook ${PUBLIC_WEBHOOK_URL} --amount 10\` ` +
          `into your operator process to enable it.`,
        );
      }
    } else if (i.commandName === 'sluice-status') {
      const entry = SUBS.get(i.channelId);
      if (!entry) return i.reply({ content: 'No active Sluice subscriptions in this channel.', ephemeral: true });
      const recipe = RECIPES[entry.recipe];
      await i.reply({ content: `Watching **${recipe?.label ?? entry.recipe}** in **${entry.mode}** mode.`, ephemeral: true });
    }
  } catch (e) {
    console.error(e);
    if (i.deferred) i.editReply(`error: ${e.message}`); else i.reply({ content: `error: ${e.message}`, ephemeral: true });
  }
});

client.login(DISCORD_TOKEN);

/* ─────────────── webhook receiver ─────────────── */

const app = express();
// sluiceExpress reads raw body for HMAC, then attaches req.body + req.sluice.
app.post('/webhook', sluiceExpress(SLUICE_WEBHOOK_SECRET), (req, res) => {
  res.sendStatus(200);
  const payload = req.body;
  if (!payload || typeof payload !== 'object') return;
  const channelId = SUB_TO_CHANNEL.get(payload.subscription_id) ?? firstWatchingChannel();
  if (!channelId) return;
  const channel = client.channels.cache.get(channelId);
  if (!channel || !channel.isTextBased()) return;
  const ev = payload.event || payload;
  const amount = ev.amount ? `${(BigInt(ev.amount) / 1_000_000_000n).toString()} CSPR` : '?';
  const to = (ev.to_account_hash || '').slice(0, 16) + '…';
  const explorer = `https://testnet.cspr.live/deploy/${ev.deploy_hash}`;
  const verified = req.sluice?.verified ? '🔒 verified' : '⚠️ unsigned';
  channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(payload._sluice_sandbox ? 0xffc107 : 0x3edc64)
        .setTitle(payload._sluice_sandbox ? '🧪 Sandbox event' : '⚡ On-chain Transfer matched')
        .setDescription([
          `**Amount:** ${amount}`,
          `**To:** \`${to}\``,
          `[View on cspr.live](${explorer})`,
          `\`${verified}\``,
        ].join('\n'))
        .setFooter({ text: `sluice sub_${payload.subscription_id ?? '?'} · ${new Date(ev.timestamp || Date.now()).toISOString().substr(11, 8)}` }),
    ],
  }).catch((e) => console.error('discord send error', e));
});

function firstWatchingChannel() {
  // Sandbox mode doesn't tell us the channel directly, use whatever channel
  // is registered. For multi-channel deployments, store subscription→channel
  // mappings keyed on subscription_id at creation time.
  for (const id of SUBS.keys()) return id;
  return null;
}

app.listen(PORT, () => console.log(`webhook receiver listening on :${PORT}`));

function required(name) {
  const v = process.env[name];
  if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1); }
  return v;
}
