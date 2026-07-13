#!/usr/bin/env bash
# Diagnose the complete Pod Socket.IO path without assuming a particular domain
# or ingress topology. Run from this deploy directory:
#
#   ./diagnose-websocket.sh
#   POD_URL=https://your-pod.example ./diagnose-websocket.sh

set -u

compose() {
  docker compose "$@"
}

pod_url="${POD_URL:-}"
if [[ -z "$pod_url" && -f .env ]]; then
  pod_url="$(sed -n 's/^PUBLIC_URL=//p' .env | head -n 1)"
fi
pod_url="${pod_url%/}"

echo "=== 1. Service status ==="
compose ps backend realtime caddy || true

echo
echo "=== 2. Realtime direct health ==="
curl -fsS --max-time 5 http://127.0.0.1:4001/bridge/health \
  || echo "FAILED: Realtime is not reachable on host port 4001"

echo
echo "=== 3. Realtime direct Socket.IO handshake ==="
curl -sS -o /dev/null -w 'HTTP %{http_code}\n' --max-time 10 \
  'http://127.0.0.1:4001/socket.io/?EIO=4&transport=polling' \
  || echo "FAILED: Direct Socket.IO handshake could not connect"

echo
echo "=== 4. Bridge authentication configuration ==="
if [[ -f .env ]] && grep -q '^BRIDGE_SECRET=.' .env; then
  echo "BRIDGE_SECRET is configured"
else
  echo "WARN: BRIDGE_SECRET is missing or empty (bridge remains local-dev compatible)"
fi

if [[ -n "$(compose ps -q caddy 2>/dev/null)" ]]; then
  echo
  echo "=== 5. Pod Caddy -> Realtime ==="
  compose exec -T caddy wget -q -O- http://realtime:4001/bridge/health \
    || echo "FAILED: Pod Caddy cannot reach Realtime"
  compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile \
    || echo "FAILED: Pod Caddyfile is invalid"
else
  echo
  echo "=== 5. Pod Caddy ==="
  echo "Not running in this compose project; public ingress is managed externally."
fi

echo
echo "=== 6. Public Socket.IO handshake ==="
if [[ -z "$pod_url" ]]; then
  echo "SKIPPED: set POD_URL or PUBLIC_URL in .env"
else
  echo "Pod URL: $pod_url"
  curl -sS -o /dev/null -w 'HTTP %{http_code}\n' --max-time 15 \
    "$pod_url/socket.io/?EIO=4&transport=polling" \
    || echo "FAILED: Public Socket.IO handshake could not connect"
fi

echo
echo "=== 7. Recent stream transport diagnostics ==="
compose logs --since=30m realtime 2>&1 | grep -E \
  'Presence|Client connected|invalid session|missing session|user mismatch|Bridge' \
  || echo "No matching Realtime diagnostics in the last 30 minutes"
compose logs --since=30m backend 2>&1 | grep -E \
  'Failed to broadcast|chat:stream|bridge' \
  || echo "No matching backend diagnostics in the last 30 minutes"

echo
echo "Expected: direct and public Socket.IO handshakes return HTTP 200."
