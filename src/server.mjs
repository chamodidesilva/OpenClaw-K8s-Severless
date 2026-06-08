/**
 * OpenClaw Wake-Proxy Gateway
 *
 * A per-user-agent HTTP gateway that:
 *  1. Receives requests from clients (same API surface as OpenClaw itself)
 *  2. Wakes the target OpenClawInstance if suspended (patches spec.suspended=false)
 *  3. Waits for the pod to be Ready
 *  4. Proxies the request to the instance's ClusterIP service
 *  5. Resets an idle timer; suspends the instance after IDLE_TIMEOUT_MS of inactivity
 *
 * Environment variables:
 *   INSTANCE_NAME      - Name of the OpenClawInstance CR (default: from USER_ID)
 *   NAMESPACE          - Kubernetes namespace (default: openclaw)
 *   IDLE_TIMEOUT_MS    - Milliseconds of inactivity before suspension (default: 900000 = 15 min)
 *   WAKE_POLL_MS       - How often to poll pod readiness during wake (default: 2000)
 *   WAKE_TIMEOUT_MS    - Max time to wait for pod ready (default: 120000 = 2 min)
 *   PORT               - Port this proxy listens on (default: 8080)
 *   OPENCLAW_PORT      - Port of the target OpenClaw service (default: 18789)
 *   LOG_LEVEL          - debug | info | warn | error (default: info)
 */

import http from 'http';
import https from 'https';
import { readFileSync } from 'fs';

// ── Config ────────────────────────────────────────────────────────────────────

const NAMESPACE        = process.env.NAMESPACE         || 'openclaw';
const INSTANCE_NAME    = process.env.INSTANCE_NAME;          // required
const IDLE_TIMEOUT_MS  = parseInt(process.env.IDLE_TIMEOUT_MS  || '300000');
const WAKE_POLL_MS     = parseInt(process.env.WAKE_POLL_MS     || '2000');
const WAKE_TIMEOUT_MS  = parseInt(process.env.WAKE_TIMEOUT_MS  || '120000');
const PORT             = parseInt(process.env.PORT             || '8080');
const OPENCLAW_PORT    = parseInt(process.env.OPENCLAW_PORT    || '18789');
const LOG_LEVEL        = process.env.LOG_LEVEL         || 'info';

if (!INSTANCE_NAME) {
  console.error('INSTANCE_NAME env var is required');
  process.exit(1);
}

// OpenClaw service hostname inside the cluster
const OPENCLAW_HOST = `${INSTANCE_NAME}.${NAMESPACE}.svc.cluster.local`;

// ── Kubernetes client (in-cluster) ────────────────────────────────────────────

const K8S_HOST  = process.env.KUBERNETES_SERVICE_HOST;
const K8S_PORT  = process.env.KUBERNETES_SERVICE_PORT || '443';
const K8S_TOKEN = (() => {
  try { return readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8').trim(); }
  catch { return process.env.KUBE_TOKEN || ''; }
})();
const K8S_CA    = (() => {
  try { return readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'); }
  catch { return undefined; }
})();

function k8sRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const opts = {
      hostname: K8S_HOST,
      port: K8S_PORT,
      path,
      method,
      headers: {
        'Authorization': `Bearer ${K8S_TOKEN}`,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
      ca: K8S_CA,
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function getInstanceStatus() {
  const r = await k8sRequest(
    'GET',
    `/apis/openclaw.rocks/v1alpha1/namespaces/${NAMESPACE}/openclawinstances/${INSTANCE_NAME}`
  );
  if (r.status !== 200) throw new Error(`K8s GET instance failed: ${r.status}`);
  return r.body;
}

async function patchSuspended(suspended) {
  const r = await k8sRequest(
    'PATCH',
    `/apis/openclaw.rocks/v1alpha1/namespaces/${NAMESPACE}/openclawinstances/${INSTANCE_NAME}`,
    { spec: { suspended } }
  );
  // Allow 422/409 when field is already set
  if (r.status !== 200 && r.status !== 422) {
    throw new Error(`K8s PATCH suspended=${suspended} failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return r.body;
}

// Use strategic-merge-patch (Content-Type header doesn't matter for our simple patch object above,
// but the operator accepts a partial spec patch via SSA or strategic merge).
// Actually for CRDs we need merge-patch. Override Content-Type:
async function patchSuspendedMerge(suspended) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify({ spec: { suspended } });
    const opts = {
      hostname: K8S_HOST,
      port: K8S_PORT,
      path: `/apis/openclaw.rocks/v1alpha1/namespaces/${NAMESPACE}/openclawinstances/${INSTANCE_NAME}`,
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${K8S_TOKEN}`,
        'Content-Type': 'application/merge-patch+json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
      ca: K8S_CA,
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

async function getPodReady() {
  const r = await k8sRequest(
    'GET',
    `/api/v1/namespaces/${NAMESPACE}/pods?labelSelector=app.kubernetes.io%2Finstance%3D${INSTANCE_NAME}`
  );
  if (r.status !== 200) return false;
  const pods = r.body.items || [];
  return pods.some(pod =>
    pod.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True')
  );
}

// ── Logger ────────────────────────────────────────────────────────────────────

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[LOG_LEVEL] ?? 1;

const log = {
  debug: (...a) => currentLevel <= 0 && console.debug('[debug]', ...a),
  info:  (...a) => currentLevel <= 1 && console.log('[info]',  ...a),
  warn:  (...a) => currentLevel <= 2 && console.warn('[warn]',  ...a),
  error: (...a) => currentLevel <= 3 && console.error('[error]', ...a),
};

// ── State ─────────────────────────────────────────────────────────────────────

let idleTimer = null;
let isSuspended = false;          // cached view; refreshed on startup and on patch
let activeRequests = 0;
let wakeInProgress = null;        // Promise<void> shared across concurrent callers

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (activeRequests > 0) {
      // Still busy; defer
      resetIdleTimer();
      return;
    }
    log.info(`Idle timeout reached (${IDLE_TIMEOUT_MS}ms). Suspending ${INSTANCE_NAME}...`);
    try {
      await patchSuspendedMerge(true);
      isSuspended = true;
      log.info('Suspended successfully.');
    } catch (e) {
      log.error('Failed to suspend:', e.message);
    }
  }, IDLE_TIMEOUT_MS);
}

// ── Wake logic ────────────────────────────────────────────────────────────────

async function ensureWake() {
  // Fast path: already awake
  if (!isSuspended) {
    // Verify pod is still ready (handles crash restarts, etc.)
    if (await getPodReady()) return;
    // Pod not ready but we think we're unsuspended - wait for it
    await waitForPodReady();
    return;
  }

  // If another request is already waking, share that promise
  if (wakeInProgress) {
    log.debug('Wake already in progress, waiting...');
    return wakeInProgress;
  }

  wakeInProgress = (async () => {
    log.info(`Waking ${INSTANCE_NAME}...`);
    await patchSuspendedMerge(false);
    isSuspended = false;
    log.info('Patch sent, waiting for pod to become Ready...');
    await waitForPodReady();
    log.info('Pod is Ready.');
  })().finally(() => { wakeInProgress = null; });

  return wakeInProgress;
}

async function waitForPodReady() {
  const deadline = Date.now() + WAKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await getPodReady()) return;
    await sleep(WAKE_POLL_MS);
  }
  throw new Error(`Timed out waiting for ${INSTANCE_NAME} pod to be Ready after ${WAKE_TIMEOUT_MS}ms`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Proxy logic ───────────────────────────────────────────────────────────────

function proxyRequest(clientReq, clientRes) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: OPENCLAW_HOST,
      port: OPENCLAW_PORT,
      path: clientReq.url,
      method: clientReq.method,
      headers: {
        ...clientReq.headers,
        host: `${OPENCLAW_HOST}:${OPENCLAW_PORT}`,
      },
    };

    log.debug(`Proxying ${clientReq.method} ${clientReq.url} -> ${OPENCLAW_HOST}:${OPENCLAW_PORT}`);

    const proxyReq = http.request(options, proxyRes => {
      clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(clientRes);
      proxyRes.on('end', resolve);
      proxyRes.on('error', reject);
    });

    proxyReq.on('error', reject);
    clientReq.pipe(proxyReq);
  });
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // Health check for this proxy itself
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, instance: INSTANCE_NAME, suspended: isSuspended }));
    return;
  }

  // Status endpoint
  if (req.url === '/status') {
    try {
      const instance = await getInstanceStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        instance: INSTANCE_NAME,
        phase: instance.status?.phase,
        suspended: instance.spec?.suspended,
        ready: await getPodReady(),
      }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  activeRequests++;
  resetIdleTimer();

  try {
    await ensureWake();
    resetIdleTimer(); // reset again after potentially long wake time
    await proxyRequest(req, res);
  } catch (e) {
    log.error(`Request failed: ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Agent unavailable',
        detail: e.message,
      }));
    }
  } finally {
    activeRequests--;
    resetIdleTimer();
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────

async function main() {
  log.info(`Starting OpenClaw Wake-Proxy for instance=${INSTANCE_NAME} ns=${NAMESPACE}`);
  log.info(`Idle timeout: ${IDLE_TIMEOUT_MS}ms | Wake timeout: ${WAKE_TIMEOUT_MS}ms`);

  // Check current suspended state
  try {
    const instance = await getInstanceStatus();
    isSuspended = instance.spec?.suspended === true;
    log.info(`Instance current state: suspended=${isSuspended}, phase=${instance.status?.phase}`);
  } catch (e) {
    log.warn('Could not fetch initial instance state:', e.message);
  }

  server.listen(PORT, () => {
    log.info(`Proxy listening on :${PORT}`);
    // Start idle timer from the beginning
    resetIdleTimer();
  });
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
