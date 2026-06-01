import { Client, GatewayIntentBits } from 'discord.js';
import { createClient } from 'redis';

const VALKEY_URL = process.env.VALKEY_URL;
const AGENT_NAME = process.env.AGENT_NAME;
const BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;

if (!VALKEY_URL || !AGENT_NAME || !BOT_TOKEN) {
  console.error('Missing required env vars');
  process.exit(1);
}

const valkey = createClient({ url: VALKEY_URL });
valkey.on('error', err => console.error('Valkey error:', err));
await valkey.connect();
console.log(`Valkey connected for agent: ${AGENT_NAME}`);

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ]
});

discord.on('ready', () => {
  console.log(`Bot logged in as ${discord.user.tag} for agent ${AGENT_NAME}`);
});

discord.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const isMention = message.mentions.has(discord.user);
  const isDM = message.channel.type === 1;
  if (!isMention && !isDM) return;

  const queueKey   = `discord:queue:user:${AGENT_NAME}`;
  const dedupKey   = `discord:seen:${AGENT_NAME}:${message.id}`;

  try {
    // dedup — if we've already queued this message ID, skip
    const already = await valkey.set(dedupKey, '1', {
      NX: true,   // only set if not exists
      EX: 3600,   // expire after 1 hour
    });

    if (!already) {
      console.log(`Duplicate message ${message.id} skipped`);
      return;
    }

    await valkey.lPush(queueKey, JSON.stringify({
      messageId:  message.id,
      channelId:  message.channel.id,
      guildId:    message.guildId,
      content:    message.content,
      author:     message.author.id,
      authorTag:  message.author.tag,
      timestamp:  message.createdTimestamp,
    }));

    console.log(`Queued message ${message.id} for ${AGENT_NAME} → ${queueKey}`);
  } catch (err) {
    console.error('Failed to push to Valkey:', err);
  }
});

discord.on('error', err => console.error('Discord client error:', err));

process.on('unhandledRejection', err => {
  console.error('Unhandled rejection:', err);
  process.exit(1);
});

discord.login(BOT_TOKEN);

