#!/bin/bash
# Diagnostic script for WebSocket connection issues

echo "=== 1. Testing Caddy -> Realtime connectivity ==="
docker compose exec caddy wget -O- http://realtime:4001/bridge/health 2>&1 | head -5

echo ""
echo "=== 2. Testing direct realtime service ==="
docker compose exec realtime wget -O- http://localhost:4001/bridge/health 2>&1 | head -5

echo ""
echo "=== 3. Checking Caddy logs (last 20 lines) ==="
docker compose logs --tail=20 caddy

echo ""
echo "=== 4. Checking Realtime logs (last 20 lines) ==="
docker compose logs --tail=20 realtime

echo ""
echo "=== 5. Testing Socket.IO endpoint via Caddy ==="
curl -v -H "Upgrade: websocket" -H "Connection: Upgrade" \
  "https://backend.synap.live/socket.io/?EIO=4&transport=websocket" 2>&1 | grep -E "(HTTP|Upgrade|Connection|Error)" | head -10

echo ""
echo "=== 6. Checking if realtime service is listening ==="
docker compose exec realtime netstat -tlnp 2>/dev/null | grep 4001 || \
docker compose exec realtime ss -tlnp 2>/dev/null | grep 4001

echo ""
echo "=== 7. Checking Caddyfile syntax ==="
docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile 2>&1
