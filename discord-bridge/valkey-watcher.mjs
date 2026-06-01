import { createClient } from 'redis';
import { execSync } from 'child_process';

const VALKEY_URL    = process.env.VALKEY_URL;
const AGENT_NAME    = process.env.AGENT_NAME;
const INSTANCE_NAME = process.env.INSTANCE_NAME;
const NAMESPACE     = process.env.NAMESPACE || 'openclaw';
const COOLDOWN_MS   = parseInt(process.env.COOLDOWN_MS || '300000');

if (!VALKEY_URL || !AGENT_NAME || !INSTANCE_NAME) {
  console.error('Missing required env vars');
  process.exit(1);
}

const valkey = createClient({ url: VALKEY_URL });
valkey.on('error', err => console.error('Valkey error:', err));
await valkey.connect();
console.log(`Watcher started for ${INSTANCE_NAME}`);

const queueKey = `discord:queue:user:${AGENT_NAME}`;
let idleSince = null;

function getCurrentSuspended() {
  try {
    const result = execSync(
      `kubectl get openclawinstance ${INSTANCE_NAME} \
       -n ${NAMESPACE} \
       -o jsonpath='{.spec.suspended}'`,
      { stdio: 'pipe' }
    ).toString().trim().replace(/'/g, '');
    return result === 'true';
  } catch (err) {
    console.error('Failed to get current suspended state:', err.message);
    return null;
  }
}

function patch(suspendValue) {
  try {
    execSync(
      `kubectl patch openclawinstance ${INSTANCE_NAME} \
       -n ${NAMESPACE} \
       --type merge \
       -p '{"spec":{"suspended":${suspendValue}}}'`,
      { stdio: 'pipe' }
    );
    console.log(`Patched ${INSTANCE_NAME} suspended=${suspendValue}`);
  } catch (err) {
    console.error('Patch failed:', err.message);
  }
}

setInterval(async () => {
  try {
    const len = await valkey.lLen(queueKey);
    const suspended = getCurrentSuspended();
    if (suspended === null) return; // skip if we couldn't read state

    if (len > 0 && suspended) {
      // only patch when transitioning false — not on every poll
      console.log(`Queue has ${len} items — waking ${INSTANCE_NAME}`);
      patch(false);
      idleSince = null;

    } else if (len === 0 && !suspended) {
      if (!idleSince) {
        idleSince = Date.now();
        console.log(`Queue empty — starting cooldown for ${INSTANCE_NAME}`);
      } else if (Date.now() - idleSince >= COOLDOWN_MS) {
        console.log(`Cooldown elapsed — suspending ${INSTANCE_NAME}`);
        patch(true);
        idleSince = null;
      }

    } else if (len > 0 && !suspended) {
      // already awake, reset idle timer if new messages arrive
      idleSince = null;
    }

  } catch (err) {
    console.error('Poll error:', err);
  }
}, 10000);

