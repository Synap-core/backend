# WebSocket Connection Failure - Root Cause Analysis & Solution

## Problem Statement

**Symptom**: No logs on realtime server when frontend tries to connect via WebSocket
**Implication**: Requests are failing **before** reaching the realtime server

## Systematic Analysis

### Layer 1: Realtime Service ✅

- **Status**: Running on `0.0.0.0:4001` ✅
- **Health**: `/bridge/health` endpoint exists ✅
- **Conclusion**: Service is working

### Layer 2: Docker Network ✅

- **Status**: Both `caddy` and `realtime` on `synap-net` network ✅
- **Conclusion**: Network connectivity should work

### Layer 3: Caddy HTTP Routing ❓

- **Status**: Unknown - needs testing
- **Test**: `curl https://backend.synap.live/realtime/bridge/health`
- **If fails**: Caddyfile routing issue

### Layer 4: Caddy WebSocket Upgrade ❓

- **Status**: Unknown - needs testing
- **Test**: WebSocket upgrade request through Caddy
- **If fails**: Caddy WebSocket configuration issue

### Layer 5: Frontend Configuration ❓

- **Status**: Unknown - needs verification
- **Test**: Browser DevTools → Network → WS tab
- **If wrong**: `getRealtimeUrl()` or Socket.IO client config issue

## Most Likely Root Causes (In Order)

### 1. **Caddy WebSocket Upgrade Not Working** (90% probability)

**Why**:

- Caddy v2 automatically detects WebSocket upgrades
- But our Caddyfile might have issues preventing this
- No logs = Caddy is rejecting the connection

**Evidence Needed**:

- Test: `curl -i -N -H "Upgrade: websocket" https://backend.synap.live/socket.io/...`
- Check: Does it return `101 Switching Protocols`?
- If not: Caddy WebSocket upgrade is broken

### 2. **Caddy HTTP Routing Broken** (5% probability)

**Why**:

- If HTTP doesn't work, WebSocket won't work
- `/realtime/*` route might be misconfigured

**Evidence Needed**:

- Test: `curl https://backend.synap.live/realtime/bridge/health`
- If fails: Caddyfile routing issue

### 3. **Frontend Sending Wrong URL** (5% probability)

**Why**:

- Frontend might be using wrong protocol or URL
- Browser might be blocking mixed content

**Evidence Needed**:

- Check browser DevTools → Network → WS tab
- Verify URL is `wss://backend.synap.live/socket.io/...`
- Check for CORS errors in console

## Debugging Steps (Run These)

### Step 1: Test Realtime Directly

```bash
docker compose exec realtime wget -O- http://localhost:4001/bridge/health
```

**Expected**: `{"status":"ok","timestamp":...}`
**If fails**: Realtime service is broken

### Step 2: Test Caddy → Realtime Network

```bash
docker compose exec caddy wget -O- http://realtime:4001/bridge/health
```

**Expected**: `{"status":"ok","timestamp":...}`
**If fails**: Docker network issue

### Step 3: Test Caddy HTTP Routing

```bash
curl -v https://backend.synap.live/realtime/bridge/health
```

**Expected**: HTTP 200 with JSON
**If fails**: Caddyfile routing issue

### Step 4: Test Caddy WebSocket Upgrade

```bash
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  https://backend.synap.live/socket.io/?EIO=4&transport=websocket
```

**Expected**: `HTTP/1.1 101 Switching Protocols`
**If fails**: Caddy WebSocket upgrade is broken

### Step 5: Check Caddy Logs

```bash
docker compose logs --tail=50 caddy | grep -E "(socket.io|realtime|4001|upgrade)"
```

**Look for**: Connection attempts, errors, routing decisions

### Step 6: Check Frontend Configuration

- Open browser DevTools → Network → WS tab
- Try to connect
- Check:
  - Request URL (should be `wss://backend.synap.live/socket.io/...`)
  - Request headers (should include `Upgrade: websocket`)
  - Response (should be `101 Switching Protocols`)

## Solution Based on Test Results

### If Step 4 Fails (WebSocket Upgrade)

**Fix**: Caddyfile WebSocket configuration

- Remove any manual header manipulation
- Ensure `handle /socket.io/*` route exists
- Let Caddy handle upgrades automatically

### If Step 3 Fails (HTTP Routing)

**Fix**: Caddyfile HTTP routing

- Check `/realtime/*` route exists
- Verify it points to `realtime:4001`
- Test with simple HTTP first

### If Step 2 Fails (Network)

**Fix**: Docker network configuration

- Verify both services on `synap-net`
- Check `docker compose ps` shows both running
- Restart services: `docker compose restart caddy realtime`

### If All Steps Pass But Still Fails

**Fix**: Frontend configuration

- Check `getRealtimeUrl()` returns correct URL
- Verify Socket.IO client is using correct URL
- Check browser console for errors

## Quick Diagnostic Script

Run this on the server to test all layers:

```bash
cd /opt/synap-backend/deploy
chmod +x debug-websocket.sh
./debug-websocket.sh
```

This will show exactly where the failure occurs.
