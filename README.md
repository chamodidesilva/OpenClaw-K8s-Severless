# OpenClaw Wake-Proxy Gateway

Serverless-style OpenClaw on Kubernetes.  
Each user gets their own `OpenClawInstance` that suspends when idle and wakes automatically when they send a message.

## Architecture

```
curl (user)
    │
    ▼
wake-proxy-<userId>  (this repo, port 8080)
    │  1. patch suspended=false  ──► K8s API
    │  2. wait for pod Ready     ◄── K8s API
    │  3. proxy request          ──► <userId>:18789  (OpenClaw pod)
    │  4. idle timer             ──► patch suspended=true after IDLE_TIMEOUT_MS
    │
    ▼
OpenClawInstance CR  ◄── managed by openclaw-operator
```

One `wake-proxy-<userId>` Deployment + Service per user.  
One `openclaw-provisioner` Deployment shared cluster-wide.

---

## Quick Start

### 1. Build & load the image into minikube

```bash
eval $(minikube docker-env)
docker build -t openclaw-wake-proxy:latest .
```

### 2. Apply RBAC

```bash
kubectl apply -f k8s/rbac.yaml
kubectl apply -f k8s/provisioner.yaml
```

### 3. Provision a user

```bash
# Port-forward the provisioner
kubectl port-forward -n openclaw svc/openclaw-provisioner 9000:9000 &

# Sign in / create agent
curl -s -X POST http://localhost:9000/provision \
  -H 'Content-Type: application/json' \
  -d '{"userId": "alice"}'
```

Response:
```json
{
  "userId": "alice",
  "instanceName": "alice",
  "proxyEndpoint": "http://wake-proxy-alice.openclaw.svc.cluster.local:8080",
  "gatewayToken": null,
  "note": "Agent provisioned. Token not yet available — operator may still be reconciling. Retry /token in a few seconds."
}
```

### 4. Fetch the token once the operator has reconciled (~10-15s)

```bash
curl -s "http://localhost:9000/token?userId=alice"
# {"userId":"alice","gatewayToken":"oc_..."}
```

Or directly from kubectl:
```bash
kubectl get secret alice-gateway-token -n openclaw \
  -o jsonpath='{.data.token}' | base64 -d
```

### 5. Send messages through the wake-proxy

```bash
# Port-forward the wake-proxy for this user
kubectl port-forward -n openclaw svc/wake-proxy-alice 8080:8080 &

TOKEN="<token from step 4>"

curl -sS http://localhost:8080/v1/responses \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openclaw/default",
    "user": "user-session-1",
    "input": "Hello!"
  }'
```

The proxy will:
- Unsuspend Alice's agent if it's sleeping (takes ~30-60s for pod to start)
- Wait until the pod is ready
- Forward the request and stream back the response
- Reset the 15-minute idle timer

After 15 minutes of no messages, the agent suspends automatically. The PVC stays, so conversation history and sessions are preserved.

---

## Flow for new users (sign-in endpoint)

```bash
# Wrap provision + token fetch into a sign-in script:
USER="bob"

# Provision (idempotent — safe to call on every login)
curl -s -X POST http://localhost:9000/provision \
  -H 'Content-Type: application/json' \
  -d "{\"userId\": \"${USER}\"}"

# Wait for operator, then get token
sleep 15
TOKEN=$(curl -s "http://localhost:9000/token?userId=${USER}" | jq -r .gatewayToken)
echo "Token: $TOKEN"
```

---

## Configuration

| Env var | Default | Description |
|---|---|---|
| `INSTANCE_NAME` | (required) | Name of the `OpenClawInstance` CR |
| `NAMESPACE` | `openclaw` | Kubernetes namespace |
| `IDLE_TIMEOUT_MS` | `900000` | Ms of inactivity before suspending (15 min) |
| `WAKE_TIMEOUT_MS` | `120000` | Max ms to wait for pod Ready after unsuspend |
| `WAKE_POLL_MS` | `2000` | Pod-ready poll interval during wake |
| `PORT` | `8080` | Proxy listen port |
| `OPENCLAW_PORT` | `18789` | Target OpenClaw service port |
| `LOG_LEVEL` | `info` | debug / info / warn / error |

---

## Proxy special endpoints

- `GET /healthz` — health check for the proxy itself
- `GET /status` — JSON status of the underlying instance (`phase`, `suspended`, `ready`)
- All other paths — proxied to OpenClaw as-is (same API surface)

---

## Notes

- The wake-proxy is stateless — it reads/writes `spec.suspended` via the K8s API. Restarting the proxy does not lose state.
- Multiple concurrent requests during a wake share a single wake operation (no thundering herd).
- The idle timer resets on every request and accounts for in-flight requests (won't suspend mid-request).
- `storage.persistence.orphan: true` means the PVC survives CR deletion — user data is always safe.
