# WebSocket Connection Debugging Guide

## Problem

No logs on realtime server = requests aren't reaching it. This means the failure is happening **before** the realtime server.

## Systematic Debugging Approach

### Layer 1: Realtime Service (Direct Test)

**Test if realtime service is working at all**

```bash
# From server
docker compose exec realtime wget -O- http://localhost:4001/bridge/health

# Expected: `{"status":"ok","timestamp":...}`
# If fails: Realtime service is broken
```

### Layer 2: Docker Network (Caddy → Realtime)

**Test if Caddy can reach realtime service on Docker network**

```bash
# From server
docker compose exec caddy wget -O- http://realtime:4001/bridge/health

# Expected: `{"status":"ok","timestamp":...}`
# If fails: Docker network issue (services not on same network)
```

### Layer 3: Caddy HTTP Routing

**Test if Caddy routes HTTP requests to realtime**

```bash
# From server or your machine
curl -v https://backend.synap.live/realtime/bridge/health

# Expected: HTTP 200 with JSON response
# If fails: Caddy routing issue (check Caddyfile)
```

### Layer 4: Caddy WebSocket Upgrade

**Test if Caddy upgrades WebSocket connections**

```bash
# From server or your machine
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Origin: http://localhost:3000" \
  https://backend.synap.live/socket.io/?EIO=4&transport=websocket

# Expected: HTTP 101 Switching Protocols
# If fails: Caddy WebSocket upgrade issue
```

### Layer 5: Frontend Configuration

**Test if frontend is sending correct URL**

Check browser DevTools → Network → WS tab:

- Request URL should be: `wss://backend.synap.live/socket.io/?EIO=4&transport=websocket`
- Request headers should include: `Upgrade: websocket`, `Connection: Upgrade`
- If URL is wrong: Frontend configuration issue

## Quick Diagnostic Script

Run this on the server:

```bash
cd /opt/synap-backend/deploy
chmod +x debug-websocket.sh
./debug-websocket.sh
```

This will test all layers and show exactly where the failure occurs.

## Common Issues & Solutions

### Issue 1: Layer 2 Fails (Caddy can't reach realtime)

**Solution**: Check `docker-compose.yml` - both services must be on `synap-net` network

### Issue 2: Layer 3 Fails (Caddy HTTP routing)

**Solution**: Check Caddyfile - `/realtime/*` route must exist and point to `realtime:4001`

### Issue 3: Layer 4 Fails (WebSocket upgrade)

**Solution**:

- Remove manual `header_up` directives (they break Caddy's auto-upgrade)
- Ensure Caddyfile has `handle /socket.io/*` route
- Check Caddy logs: `docker compose logs caddy | grep socket.io`

### Issue 4: Layer 5 Fails (Frontend)

**Solution**:

- Check `getRealtimeUrl()` returns correct URL
- Verify frontend is using `wss://` (not `ws://`) for HTTPS
- Check browser console for CORS errors

## Expected Flow (Working)

1. **Frontend** → `wss://backend.synap.live/socket.io/?EIO=4&transport=websocket`
2. **Caddy** → Detects `Upgrade: websocket` header automatically
3. **Caddy** → Upgrades connection, forwards to `realtime:4001`
4. **Realtime** → Receives WebSocket connection
5. **Realtime logs** → `[Socket.IO] Initial connection attempt: {...}`
6. **Connection** → Established ✅

## What to Check After Running Diagnostics

1. **If Layer 1 fails**: Realtime service is broken → Check realtime logs
2. **If Layer 2 fails**: Docker network issue → Check `docker-compose.yml` networks
3. **If Layer 3 fails**: Caddy HTTP routing issue → Check Caddyfile `/realtime/*` route
4. **If Layer 4 fails**: Caddy WebSocket upgrade issue → Check Caddyfile `/socket.io/*` route
5. **If all pass but still fails**: Frontend configuration issue → Check `getRealtimeUrl()` and browser DevTools
