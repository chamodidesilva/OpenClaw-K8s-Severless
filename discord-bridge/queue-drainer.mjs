// queue-drainer.mjs
// Runs inside the OpenClaw pod on startup.
// Drains Valkey queue and injects missed messages into OpenClaw.

import { createClient } from 'redis';

const VALKEY_URL    = process.env.VALKEY_URL;
const AGENT_NAME    = process.env.AGENT_NAME;
const OPENCLAW_URL  = process.env.OPENCLAW_URL || 'http://localhost:18789';

if (!VALKEY_URL || !AGENT_NAME) {
  console.error('Missing required env vars');
  process.exit(1);
}

const valkey = createClient({ url: VALKEY_URL });
valkey.on('error', err => console.error('Valkey error:', err));
await valkey.connect();
console.log(`Drainer connected to Valkey for agent: ${AGENT_NAME}`);

const queueKey = `discord:queue:user:${AGENT_NAME}`;

// wait for OpenClaw to be ready
async function waitForOpenClaw(retries = 60, delayMs = 3000) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${OPENCLAW_URL}/health`);
      if (res.ok) {
        console.log('OpenClaw is ready');
        return;
      }
    } catch {
      // not ready yet
    }
    console.log(`Waiting for OpenClaw... attempt ${i + 1}/${retries}`);
    await new Promise(r => setTimeout(r, delayMs));
  }
  console.error('OpenClaw did not become ready in time');
  process.exit(1);
}

// inject a message into OpenClaw via its local channel ingest API
async function injectMessage(msg) {
  try {
    const res = await fetch(`${OPENCLAW_URL}/api/ingest/discord`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
    });
    if (!res.ok) {
      console.error(`Failed to inject message ${msg.messageId}: ${res.status}`);
      return false;
    }
    console.log(`Injected message ${msg.messageId} into OpenClaw`);
    return true;
  } catch (err) {
    console.error(`Error injecting message ${msg.messageId}:`, err);
    return false;
  }
}

await waitForOpenClaw();

// drain all pending messages from Valkey — oldest first (RPOP = FIFO)
console.log('Draining Valkey queue...');
let raw;
while ((raw = await valkey.rPop(queueKey)) !== null) {
  const msg = JSON.parse(raw);
  const ok  = await injectMessage(msg);
  if (!ok) {
    // put it back at the tail if injection failed
    await valkey.rPush(queueKey, raw);
    console.error('Injection failed, message returned to queue');
    break;
  }
}

console.log('Queue drained. Drainer staying alive to monitor...');

// keep running — OpenClaw will call DELETE /drain/:messageId
// when it finishes handling each message, and we pop it from Valkey
// This is optional — KEDA just needs the count to reach 0
// simplest approach: poll and pop processed messages via a signal file
// or just let the queue drain naturally as messages are injected above

// keep the process alive so Kubernetes doesn't restart it
process.stdin.resume();

