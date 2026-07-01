/**
 * One-shot script to register the /sluice-watch slash command with Discord.
 *
 *   DISCORD_TOKEN=… DISCORD_APP_ID=… node register-commands.js
 *
 * If DISCORD_GUILD_ID is set, the command is registered to that guild only
 * (instant). Otherwise it's registered globally (~1h to propagate).
 */
'use strict';

const { REST, Routes, ApplicationCommandOptionType } = require('discord.js');
const RECIPES = require('./recipes');

const token = process.env.DISCORD_TOKEN;
const appId = process.env.DISCORD_APP_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !appId) {
  console.error('DISCORD_TOKEN and DISCORD_APP_ID are required.');
  process.exit(1);
}

const commands = [
  {
    name: 'sluice-watch',
    description: 'Subscribe this channel to a Sluice recipe, every match shows up here.',
    options: [
      {
        name: 'recipe',
        description: 'Which recipe to watch',
        type: ApplicationCommandOptionType.String,
        required: true,
        choices: Object.entries(RECIPES).map(([key, r]) => ({ name: r.label, value: key })),
      },
      {
        name: 'mode',
        description: 'sandbox (free, demo) or live (costs CSPR, must be configured server-side)',
        type: ApplicationCommandOptionType.String,
        choices: [
          { name: 'sandbox, free, fires 3 demo events',         value: 'sandbox' },
          { name: 'live, real on-chain subscription (admin)',    value: 'live'    },
        ],
        required: false,
      },
    ],
  },
  {
    name: 'sluice-status',
    description: 'Show this channel\'s active Sluice subscriptions.',
  },
];

(async () => {
  const rest = new REST({ version: '10' }).setToken(token);
  const route = guildId ? Routes.applicationGuildCommands(appId, guildId) : Routes.applicationCommands(appId);
  console.log(`registering ${commands.length} command(s) at ${guildId ? `guild ${guildId}` : 'global'}…`);
  const res = await rest.put(route, { body: commands });
  console.log(`ok, ${res.length} commands registered.`);
})().catch((e) => { console.error(e); process.exit(1); });
