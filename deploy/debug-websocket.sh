#!/bin/bash
# Systematic WebSocket Debugging Script
# Tests each layer: Frontend → Caddy → Realtime

set -e

echo "=========================================="
echo "WebSocket Connection Debugging"
echo "=========================================="
echo ""

echo "=== 1. TEST: Realtime Service Health (Direct) ==="
echo "Testing if realtime service is reachable directly..."
docker compose exec -T realtime wget -q -O- http://localhost:4001/bridge/health 2>&1 | head -3 || echo "❌ FAILED: Realtime service not responding"
echo ""

echo "=== 2. TEST: Caddy → Realtime Network Connectivity ==="
echo "Testing if Caddy can reach realtime service..."
docker compose exec -T caddy wget -q -O- http://realtime:4001/bridge/health 2>&1 | head -3 || echo "❌ FAILED: Caddy cannot reach realtime service"
echo ""

echo "=== 3. TEST: Caddy HTTP Routing (via Caddy) ==="
echo "Testing HTTP endpoint through Caddy..."
curl -s -o /dev/null -w "HTTP Status: %{http_code}\n" https://backend.synap.live/realtime/bridge/health || echo "❌ FAILED: HTTP routing through Caddy"
echo ""

echo "=== 4. TEST: Caddy WebSocket Routing (via Caddy) ==="
echo "Testing WebSocket upgrade through Caddy..."
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: test123" \
  -H "Origin: http://localhost:3000" \
  https://backend.synap.live/socket.io/?EIO=4&transport=websocket 2>&1 | head -20 || echo "❌ FAILED: WebSocket upgrade through Caddy"
echo ""

echo "=== 5. CHECK: Caddy Logs (Last 10 lines) ==="
echo "Recent Caddy access logs:"
docker compose logs --tail=10 caddy 2>&1 | grep -E "(socket.io|realtime|4001)" || echo "No relevant logs found"
echo ""

echo "=== 6. CHECK: Realtime Logs (Last 10 lines) ==="
echo "Recent Realtime logs:"
docker compose logs --tail=10 realtime 2>&1 | grep -E "(connection|socket|error)" || echo "No connection attempts logged"
echo ""

echo "=== 7. CHECK: Caddyfile Validation ==="
docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile 2>&1 || echo "❌ Caddyfile has syntax errors"
echo ""

echo "=== 8. CHECK: Network Connectivity (Docker Network) ==="
echo "Testing Docker network connectivity..."
docker compose exec -T caddy ping -c 1 realtime 2>&1 | head -3 || echo "❌ FAILED: Caddy cannot ping realtime service"
echo ""

echo "=== 9. CHECK: Realtime Service Status ==="
docker compose ps realtime | grep -E "(Up|Exit)" || echo "❌ Realtime service not running"
echo ""

echo "=== 10. CHECK: Port Binding ==="
echo "Checking if realtime is listening on port 4001..."
docker compose exec -T realtime netstat -tlnp 2>/dev/null | grep 4001 || \
docker compose exec -T realtime ss -tlnp 2>/dev/null | grep 4001 || \
echo "❌ Realtime not listening on port 4001"
echo ""

echo "=========================================="
echo "Debugging Complete"
echo "=========================================="
echo ""
echo "Next Steps:"
echo "1. If Test 1 fails: Realtime service is broken"
echo "2. If Test 2 fails: Docker network issue"
echo "3. If Test 3 fails: Caddy HTTP routing issue"
echo "4. If Test 4 fails: Caddy WebSocket upgrade issue"
echo "5. If all tests pass but still no connection: Frontend configuration issue"
