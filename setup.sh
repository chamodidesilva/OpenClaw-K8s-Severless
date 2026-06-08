#!/bin/bash

set -e

# ── Helpers ───────────────────────────────────────────────────────────────────

log()  { echo "[$(date +%H:%M:%S)] $*"; }
fail() { echo "[error] $*" >&2; exit 1; }

wait_for_port() {
    sleep 10
}

wait_for_deployment() {
  local name=$1 ns=$2
  log "Waiting for deployment/$name to be ready..."
  kubectl rollout status deployment/"$name" -n "$ns" --timeout=90s
}

wait_for_secret() {
  local name=$1 ns=$2
  log "Waiting for secret/$name (operator reconciling)..."
  for i in $(seq 1 30); do
    if kubectl get secret "$name" -n "$ns" > /dev/null 2>&1; then
      log "Secret $name is ready."
      return 0
    fi
    sleep 2
  done
  fail "Secret $name did not appear after 60s — check operator logs"
}

wait_for_service() {
  local name=$1 ns=$2
  log "Waiting for svc/$name..."
  for i in $(seq 1 20); do
    if kubectl get svc "$name" -n "$ns" > /dev/null 2>&1; then
      log "Service $name is ready."
      return 0
    fi
    sleep 2
  done
  fail "Service $name did not appear after 40s"
}

# ── One-time setup (comment out after first run) ──────────────────────────────

minikube start --driver=docker

helm install openclaw-operator \
  oci://ghcr.io/paperclipinc/charts/openclaw-operator \
  --namespace openclaw-operator-system \
  --create-namespace

kubectl create namespace openclaw

read -p "Enter your GitHub Copilot token / OpenAI API key: " API_KEY
echo
kubectl create secret generic openclaw-api-keys \
  --namespace openclaw \
  --from-literal=GITHUB_TOKEN="$API_KEY"

eval $(minikube docker-env)
docker build -t openclaw-wake-proxy:latest .

kubectl apply -f rbac.yaml
kubectl apply -f provisioner.yaml

# ── Per-user setup (reuse from here for additional users) ─────────────────────

read -p "Enter user ID: " USER_ID
read -p "Enter local proxy port (e.g. 8080): " PROXY_PORT

# Validate user ID
if ! echo "$USER_ID" | grep -qE '^[a-z0-9]+(-[a-z0-9]+)*$'; then
  fail "User ID must be lowercase alphanumeric with optional hyphens (e.g. alice, user-1)"
fi

# Validate port is a number
if ! echo "$PROXY_PORT" | grep -qE '^[0-9]+$'; then
  fail "Port must be a number"
fi

# 1. Ensure provisioner port-forward is up (idempotent — skip if already running)
PROVISIONER_PF_PORT=9001
if ! nc -z localhost $PROVISIONER_PF_PORT 2>/dev/null; then
  log "Starting provisioner port-forward on :${PROVISIONER_PF_PORT}..."
  wait_for_deployment openclaw-provisioner openclaw
  kubectl port-forward -n openclaw svc/openclaw-provisioner \
    ${PROVISIONER_PF_PORT}:9000 > /dev/null 2>&1 &
  wait_for_port $PROVISIONER_PF_PORT "openclaw-provisioner"
else
  log "Provisioner port-forward already up on :${PROVISIONER_PF_PORT}."
fi

# 2. Provision the user (idempotent)
log "Provisioning user: $USER_ID"
PROVISION_RESP=$(curl -sf http://localhost:${PROVISIONER_PF_PORT}/provision \
  -H 'Content-Type: application/json' \
  -d "{\"userId\":\"${USER_ID}\"}")
echo "$PROVISION_RESP" | jq . 2>/dev/null || echo "$PROVISION_RESP"

# 3. Wait for the operator to create the gateway-token secret
wait_for_secret "${USER_ID}-gateway-token" openclaw

# 4. Fetch the token
TOKEN=$(curl -sf "http://localhost:${PROVISIONER_PF_PORT}/token?userId=${USER_ID}" \
  | grep -o '"gatewayToken":"[^"]*"' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
  fail "Could not retrieve gateway token for $USER_ID"
fi
log "Token retrieved for $USER_ID."

# 5. Wait for the wake-proxy service to exist, then port-forward it
wait_for_service "wake-proxy-${USER_ID}" openclaw
sleep 10
log "Starting wake-proxy port-forward: localhost:${PROXY_PORT} -> wake-proxy-${USER_ID}:8080"
# PF_LOG=$(mktemp /tmp/pf-wake-proxy-XXXX.log)
kubectl port-forward -n openclaw "svc/wake-proxy-${USER_ID}" ${PROXY_PORT}:8080 &
sleep 5

# 6. Send a test message
log "Sending test message to $USER_ID's agent..."
RESPONSE=$(curl -sS "http://localhost:${PROXY_PORT}/v1/responses" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"openclaw/default\",\"user\":\"session-1\",\"input\":\"Hello!\"}")

echo ""
echo "─── Response ────────────────────────────────────────────"
echo "$RESPONSE" | jq -r '.output[0].content[0].text' 2>/dev/null || echo "$RESPONSE"
echo "─────────────────────────────────────────────────────────"
echo ""
log "Done. To send more messages:"
echo "  curl -sS http://localhost:${PROXY_PORT}/v1/responses \\"
echo "    -H \"Authorization: Bearer \$TOKEN\" \\"
echo "    -H \"Content-Type: application/json\" \\"
echo "    -d '{\"model\":\"openclaw/default\",\"user\":\"session-1\",\"input\":\"your message\"}' | jq -r '.output[0].content[0].text' "
echo ""
log "To add another user, run this script again in a new terminal."

