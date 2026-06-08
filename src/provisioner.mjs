/**
 * OpenClaw User Provisioner
 *
 * A minimal HTTP service with one endpoint:
 *   POST /provision  { "userId": "alice" }
 *
 * On call it:
 *   1. Creates (or no-ops if existing) an OpenClawInstance CR for the user
 *   2. Creates a wake-proxy Deployment and Service for the user
 *   3. Returns the user's gateway token (from the auto-generated Secret)
 *
 * The client can then send messages to:
 *   http://wake-proxy-<userId>.openclaw.svc.cluster.local:8080/v1/responses
 * (or via kubectl port-forward for local dev)
 *
 * Environment variables:
 *   NAMESPACE          - Kubernetes namespace (default: openclaw)
 *   PORT               - Listen port (default: 9000)
 *   PROXY_IMAGE        - Wake-proxy image name (default: openclaw-wake-proxy:latest)
 *   IDLE_TIMEOUT_MS    - Passed to wake-proxy (default: 900000)
 */

import http from 'http';
import https from 'https';
import { readFileSync } from 'fs';

const NAMESPACE      = process.env.NAMESPACE       || 'openclaw';
const PORT           = parseInt(process.env.PORT   || '9000');
const PROXY_IMAGE    = process.env.PROXY_IMAGE     || 'openclaw-wake-proxy:latest';
const IDLE_TIMEOUT_MS = process.env.IDLE_TIMEOUT_MS || '900000';

// ── K8s client ────────────────────────────────────────────────────────────────

const K8S_HOST  = process.env.KUBERNETES_SERVICE_HOST;
const K8S_PORT  = process.env.KUBERNETES_SERVICE_PORT || '443';
const K8S_TOKEN = (() => {
  try { return readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8').trim(); }
  catch { return process.env.KUBE_TOKEN || ''; }
})();
const K8S_CA = (() => {
  try { return readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'); }
  catch { return undefined; }
})();

function k8sReq(method, path, body, contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const req = https.request({
      hostname: K8S_HOST, port: K8S_PORT, path, method, ca: K8S_CA,
      headers: {
        'Authorization': `Bearer ${K8S_TOKEN}`,
        'Content-Type': contentType,
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    }, res => {
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

// ── Resource builders ─────────────────────────────────────────────────────────

function buildOpenClawInstance(userId) {
  return {
    apiVersion: 'openclaw.rocks/v1alpha1',
    kind: 'OpenClawInstance',
    metadata: {
      name: userId,
      namespace: NAMESPACE,
      labels: { user: userId, 'managed-by': 'openclaw-provisioner' },
    },
    spec: {
      suspended: true,
      image: { repository: 'ghcr.io/openclaw/openclaw', tag: '2026.6.1', pullPolicy: 'IfNotPresent' },
      envFrom: [{ secretRef: { name: 'openclaw-api-keys' } }],
      workspace: { bootstrap: { enabled: false } },
      config: {
        mergeMode: 'overwrite',
        raw: {
          gateway: { http: { endpoints: { responses: { enabled: true }, chatCompletions: { enabled: true } } } },
          browser: { enabled: false },
          agents: {
            defaults: {
              workspace: '/home/openclaw/.openclaw/workspace',
              model: { primary: 'github-copilot/claude-haiku-4.5' },
              userTimezone: 'UTC',
              thinkingDefault: 'off',
              reasoningDefault: 'off',
              verboseDefault: 'off',
              elevatedDefault: 'off',
              timeoutSeconds: 600,
              maxConcurrent: 1,
            },
            list: [{ id: 'main', default: true, identity: { name: 'OpenClaw' } }],
          },
          session: { scope: 'per-sender', store: '/home/openclaw/.openclaw/sessions', reset: { mode: 'idle', idleMinutes: 30 } },
          logging: { level: 'info', consoleLevel: 'info', consoleStyle: 'compact', redactSensitive: 'tools' },
          tools: { profile: 'minimal', deny: ['session_status'], web: { search: { enabled: false }, fetch: { enabled: false } } },
        },
      },
      storage: { persistence: { enabled: true, size: '5Gi', orphan: true } },
    },
  };
}

function buildProxyDeployment(userId) {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: `wake-proxy-${userId}`,
      namespace: NAMESPACE,
      labels: { app: 'openclaw-wake-proxy', user: userId },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: 'openclaw-wake-proxy', user: userId } },
      template: {
        metadata: { labels: { app: 'openclaw-wake-proxy', user: userId } },
        spec: {
          serviceAccountName: 'openclaw-wake-proxy',
          containers: [{
            name: 'proxy',
            image: PROXY_IMAGE,
            imagePullPolicy: 'IfNotPresent',
            ports: [{ containerPort: 8080 }],
            env: [
              { name: 'INSTANCE_NAME',   value: userId },
              { name: 'NAMESPACE',       value: NAMESPACE },
              { name: 'IDLE_TIMEOUT_MS', value: IDLE_TIMEOUT_MS },
              { name: 'WAKE_TIMEOUT_MS', value: '300000' },
              { name: 'WAKE_POLL_MS',    value: '2000' },
              { name: 'PORT',            value: '8080' },
              { name: 'OPENCLAW_PORT',   value: '18789' },
              { name: 'LOG_LEVEL',       value: 'info' },
            ],
            livenessProbe:  { httpGet: { path: '/healthz', port: 8080 }, initialDelaySeconds: 5, periodSeconds: 15 },
            readinessProbe: { httpGet: { path: '/healthz', port: 8080 }, initialDelaySeconds: 2, periodSeconds: 5 },
            resources: { requests: { cpu: '10m', memory: '32Mi' }, limits: { cpu: '100m', memory: '64Mi' } },
          }],
        },
      },
    },
  };
}

function buildProxyService(userId) {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: `wake-proxy-${userId}`,
      namespace: NAMESPACE,
      labels: { app: 'openclaw-wake-proxy', user: userId },
    },
    spec: {
      selector: { app: 'openclaw-wake-proxy', user: userId },
      ports: [{ name: 'http', port: 8080, targetPort: 8080 }],
    },
  };
}

// ── Provision logic ───────────────────────────────────────────────────────────

async function ensureResource(createPath, body, label) {
  // Try to create; 409 Conflict = already exists, that's fine
  const r = await k8sReq('POST', createPath, body);
  if (r.status === 201) {
    console.log(`[info] Created ${label}`);
  } else if (r.status === 409) {
    console.log(`[info] ${label} already exists, skipping`);
  } else {
    throw new Error(`Failed to create ${label}: ${r.status} ${JSON.stringify(r.body)}`);
  }
}

async function getGatewayToken(userId) {
  const secretName = `${userId}-gateway-token`;
  const r = await k8sReq('GET', `/api/v1/namespaces/${NAMESPACE}/secrets/${secretName}`);
  if (r.status !== 200) {
    // Token secret may not exist yet if the operator hasn't reconciled
    return null;
  }
  const encoded = r.body?.data?.token;
  if (!encoded) return null;
  return Buffer.from(encoded, 'base64').toString('utf8');
}

async function provision(userId) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(userId)) {
    throw new Error('userId must be lowercase alphanumeric with optional hyphens');
  }

  // 1. OpenClawInstance
  await ensureResource(
    `/apis/openclaw.rocks/v1alpha1/namespaces/${NAMESPACE}/openclawinstances`,
    buildOpenClawInstance(userId),
    `OpenClawInstance/${userId}`
  );

  // 2. Wake-proxy Deployment
  await ensureResource(
    `/apis/apps/v1/namespaces/${NAMESPACE}/deployments`,
    buildProxyDeployment(userId),
    `Deployment/wake-proxy-${userId}`
  );

  // 3. Wake-proxy Service
  await ensureResource(
    `/api/v1/namespaces/${NAMESPACE}/services`,
    buildProxyService(userId),
    `Service/wake-proxy-${userId}`
  );

  // 4. Fetch token (may be null if operator hasn't reconciled yet)
  const token = await getGatewayToken(userId);

  return {
    userId,
    instanceName: userId,
    proxyEndpoint: `http://wake-proxy-${userId}.${NAMESPACE}.svc.cluster.local:8080`,
    gatewayToken: token,
    note: token
      ? 'Agent provisioned. Use proxyEndpoint with Authorization: Bearer <gatewayToken>.'
      : 'Agent provisioned. Token not yet available — operator may still be reconciling. Retry /token in a few seconds.',
  };
}

// ── HTTP server ───────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);

  // POST /provision  { userId }
  if (req.method === 'POST' && url.pathname === '/provision') {
    try {
      const { userId } = await readBody(req);
      if (!userId) throw new Error('userId is required');
      const result = await provision(userId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result, null, 2));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /token?userId=alice  — fetch token after operator reconciles
  if (req.method === 'GET' && url.pathname === '/token') {
    const userId = url.searchParams.get('userId');
    if (!userId) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'userId query param required' })); return;
    }
    try {
      const token = await getGatewayToken(userId);
      res.writeHead(token ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(token ? { userId, gatewayToken: token } : { error: 'Token not yet available' }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => console.log(`[info] Provisioner listening on :${PORT}`));
