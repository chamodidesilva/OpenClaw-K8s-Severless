# OpenClaw Wake-Proxy Gateway

Serverless-style OpenClaw on Kubernetes.  
Each user gets their own `OpenClawInstance` that suspends when idle (for 15 seconds) and wakes automatically when they send a message.

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

## Prerequisites
 
Install the following tools before getting started:
 
- [helm](https://helm.sh/docs/intro/install/)
- [minikube](https://minikube.sigs.k8s.io/docs/start/)
- [kubectl](https://kubernetes.io/docs/tasks/tools/)
---
 
## OpenClaw Configuration
 
This setup uses the following OpenClaw specifics:
 
| Setting | Value |
|---|---|
| Version | OpenClaw 2026.6.1 |
| Model | `github-copilot/claude-haiku-4.5` |
| Tool profile | `minimal` |
| Session reset | 30 minutes idle |
| Bootstrap | disabled |

### GitHub Token
 
A GitHub Copilot token is required to replicate this setup exactly. The token is used as the model provider credential (`GITHUB_TOKEN`).
 
To obtain one, follow this tutorial: https://joshdmoore.com/openclaw-on-kubernetes-practical-installation-guide/

### Token Limit Constraints
 
The free GitHub Copilot subscription and the Haiku 4.5 model have a low token limit per request. Several configuration decisions were made specifically to stay within this limit:
 
- `tools.profile: minimal` — loads the smallest possible tool set
- `workspace.bootstrap.enabled: false` — disables `bootstrap.md` which generates a large payload on startup
- `session.reset.mode: idle` with `idleMinutes: 30` — resets conversation context after 30 minutes of inactivity, keeping the running token count under control
Within the 30-minute window, session state (conversation history) persists across requests.
 
---

## Setup
 
Run the setup script using `source` — this is important so that the `$TOKEN` variable persists in your current shell for sending subsequent requests:
 
```bash
source setup.sh
```
 
The script will prompt for:
- Your GitHub token (or OpenAI API key)
- A local port for the wake-proxy (e.g. `8080`)

### What the script does
 
**First-time setup** (uncomment the relevant section in `setup.sh` on first run):
1. Installs `openclaw-operator` via Helm
2. Creates the `openclaw` namespace
3. Creates the `openclaw-api-keys` secret with your token
4. Builds the wake-proxy image into minikube
5. Applies RBAC and provisioner manifests (`k8s/rbac.yaml`, `k8s/provisioner.yaml`)
**Per-user setup** (runs every time):
1. Starts a port-forward to the provisioner endpoint (`openclaw-provisioner` svc)
2. Provisions user-specific resources via `POST /provision`:
   - `OpenClawInstance/<userId>` — the agent CR
   - `Deployment/wake-proxy-<userId>` — the wake-proxy
   - `Service/wake-proxy-<userId>` — the proxy service
3. Waits for the operator to reconcile and auto-create the `<userId>-gateway-token` Secret
4. Fetches the gateway token from that secret
5. Starts a port-forward to the user's wake-proxy endpoint
6. Sends a test message to verify the setup

### Sending messages after setup
 
Use the same request format with your own prompt. `$TOKEN` is already set in your shell from the script:
 
```bash
curl -sS http://localhost:<PROXY_PORT>/v1/responses \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"openclaw/default","user":"session-1","input":"your message here"}'
```
 
### Adding more users
 
Run the script again in a new terminal. The provisioner port-forward is idempotent — the script will detect it is already running and skip it. Specify a different local port for each user's wake-proxy.
 
---

## Design Decisions and Evolution
 
### Why openclaw-operator
 
While researching Kubernetes deployments of OpenClaw and scaling options, `openclaw-operator` was discovered — a Kubernetes operator built specifically for OpenClaw, primarily intended for deploying it as a fleet of instances. This aligned directly with the multi-user, per-instance requirements here, so it was adopted as the resource management layer.
 
### Why the wake-proxy architecture
 
The initial design used [KEDA](https://keda.sh/) to scale OpenClaw instances based on incoming message load. This had to be abandoned because OpenClaw does not expose a `/scale` subresource, and the `openclaw-operator` CRD does not declare one either — which KEDA requires to scale a target. The current architecture replaces KEDA with a lightweight Node.js proxy that manages the suspend/wake lifecycle directly by patching `spec.suspended` on the `OpenClawInstance` CR.
 
Initial design reference: [Stage 1 Design](https://docs.google.com/document/d/1rXrG8kj0cI85hOtMbdQ1ORgLN3uwG0EObQDI2e8DkGs/edit?usp=sharing)
 
### State storage
 
The initial design proposed an external persistent state layer (database, vector store, or object storage). After deeper investigation into how OpenClaw stores state, it became clear that its architecture is tightly coupled to the local filesystem — sessions, workspace, and memory are all stored as files. This cannot be cleanly mapped to a typical database-backed store. The operator's built-in PVC support (`storage.persistence`) is used instead, with `orphan: true` so the volume survives CR deletion and user data is never lost.
 
### Message channel: Discord → CLI
 
The first iteration used Discord as the message channel:
 
```
Discord server
    └── bot connected to server
        └── bridge pod (local cluster ↔ Discord)
            └── injects wake-up signal into Valkey list
                └── watcher pod patches OpenClawInstance suspended field
                    └── OpenClaw receives message via its own Discord connection
                        └── drains Valkey list → suspends pod when empty
```
 
Note: Valkey was used instead of Redis for its open-source licensing.
 
After significant time spent troubleshooting the Discord integration with the `OpenClawInstance` CR, the approach was abandoned in favour of the current CLI-based HTTP proxy, which is simpler, more direct, and easier to reason about.
 
---
 
## Notes
 
- The wake-proxy is stateless — it reads/writes `spec.suspended` via the K8s API. Restarting the proxy does not lose state.
- Multiple concurrent requests during a wake share a single wake operation (no thundering herd).
- The idle timer resets on every request and accounts for in-flight requests (won't suspend mid-request).
- `storage.persistence.orphan: true` means the PVC survives CR deletion — user data is always safe.
---
 
## Concurrency and Elasticity
 
### Within a single user's agent
 
The wake-proxy handles concurrent requests from the same user correctly:
 
- If two requests arrive simultaneously while the agent is suspended, both hit `ensureWake()` but share a single `wakeInProgress` promise — the pod is patched and waited on once, then both requests are proxied through. There is no thundering herd.
- The idle timer will not fire while `activeRequests > 0`, so a slow in-flight request cannot get its agent suspended mid-response.
- OpenClaw itself is configured with `maxConcurrent: 1`, so if two requests arrive while the agent is already awake, the second queues inside OpenClaw rather than being rejected.
### Across users
 
There is no shared state between users. Each user has their own pod, their own wake-proxy process, and their own idle timer. One user's agent suspending or waking has no effect on any other.
 
### Elasticity
 
**What scales well:**
- Suspended agents consume only a PVC and a CR entry in etcd — no CPU or memory. Many users can be provisioned while only the currently active ones consume real resources.
- Wake-proxy pods are small (10m CPU / 32Mi RAM each), so the proxy layer stays cheap even with many users.
- Provisioning is fully automated and idempotent.
**Practical limits on minikube:**
 
The ceiling on simultaneously active agents is determined primarily by available RAM. Each active OpenClaw pod runs a Node.js gateway with plugins across three containers — roughly 200–400Mi per instance. With minikube's default 2–4GB allocation:
 
```
~2GB RAM / ~300Mi per agent ≈ 6–7 simultaneous active agents
~4GB RAM / ~300Mi per agent ≈ 13 simultaneous active agents
```
 
To check actual usage:
```bash
kubectl top pods -n openclaw
```
 
To give minikube more memory (requires restart):
```bash
minikube stop
minikube config set memory 8192
minikube start
```
 
**What doesn't scale beyond local dev:**
- One Deployment per user means Kubernetes object overhead accumulates at higher user counts.
- `kubectl port-forward` is a debug tool — it drops connections, doesn't load-balance, and requires a running process per user. See Future Work for the production alternative.

## Future Work
 
- **S3-backed persistence** — `openclaw-operator` supports snapshot-based backups to AWS S3. The current cluster PV storage is tied to the node filesystem and could be extended to sync to S3 for durability across cluster restarts.
- **Gateway API ingress** — port-forwarding is used here for local dev. A production approach would use a Kubernetes Gateway API route (or Ingress) per user, or a single shared ingress routing by path or subdomain, eliminating the need for per-user `kubectl port-forward` processes.
- **Discord integration** — the Discord channel architecture described above can be revisited to enable remote messaging without the CLI.

## Proxy special endpoints

- `GET /healthz` — health check for the proxy itself
- `GET /status` — JSON status of the underlying instance (`phase`, `suspended`, `ready`)
- All other paths — proxied to OpenClaw as-is (same API surface)

---

