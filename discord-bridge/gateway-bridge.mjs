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

  const queueKey = `discord:queue:user:${AGENT_NAME}`;
  const dedupKey = `discord:seen:${AGENT_NAME}:${message.id}`;

  try {
    // dedup — skip if already signalled for this message
    const already = await valkey.set(dedupKey, '1', {
      NX: true,
      EX: 3600,
    });

    if (!already) {
      console.log(`Duplicate message ${message.id} skipped`);
      return;
    }

    // push a lightweight wake signal — not the full payload
    // lTrim keeps only 1 item so the list never grows beyond that
    await valkey.lPush(queueKey, JSON.stringify({
      messageId: message.id,
      timestamp: message.createdTimestamp,
    }));
    await valkey.lTrim(queueKey, 0, 0);

    console.log(`Wake signal pushed for ${AGENT_NAME} → ${queueKey}`);
  } catch (err) {
    console.error('Failed to push wake signal:', err);
  }
});

discord.on('error', err => console.error('Discord client error:', err));

process.on('unhandledRejection', err => {
  console.error('Unhandled rejection:', err);
  process.exit(1);
});

discord.login(BOT_TOKEN);

