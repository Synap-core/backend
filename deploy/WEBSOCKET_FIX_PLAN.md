# WebSocket Connection Fix - Engineering Analysis

## Root Cause: Caddy WebSocket Upgrade Interference

### The Problem

**Symptom**: WebSocket connections fail, no logs on realtime server
**Root Cause**: Manual `header_up` directives in Caddyfile are **interfering** with Caddy's automatic WebSocket upgrade detection

### Why This Happens

1. **Caddy v2 automatically detects WebSocket upgrades** when it sees:
   - `Connection: Upgrade` header
   - `Upgrade: websocket` header
2. **Manual `header_up` directives override this**:
   - `header_up Connection {>Connection}` - tries to forward Connection header
   - `header_up Upgrade {>Upgrade}` - tries to forward Upgrade header
   - **Problem**: These directives are for **outgoing** headers (Caddy → Backend)
   - **But**: Caddy needs to **read** incoming headers (Client → Caddy) to detect upgrade
   - **Result**: Caddy's automatic detection is bypassed, upgrade fails

3. **Evidence**:
   - No logs on realtime server = requests never reach it
   - Caddy is likely rejecting the connection at the upgrade stage
   - Browser shows "WebSocket connection failed" = handshake never completes

## The Solution

### Principle: Let Caddy Do Its Job

Caddy v2 is designed to automatically handle WebSocket upgrades. We should **not** interfere with this.

### Implementation

1. **Remove manual WebSocket header manipulation** from Caddyfile
   - Remove `header_up Connection`
   - Remove `header_up Upgrade`
   - Remove `header_up Host` (Caddy handles this automatically)
   - Keep only forwarding headers for logging: `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`

2. **Simplify Socket.IO CORS**
   - Set `origin: true` (allow all) - Caddy is the security boundary
   - Include `OPTIONS` in methods for preflight requests
   - Add connection state recovery for reliability

3. **Verify Network Path**
   - Test: `docker exec caddy wget http://realtime:4001/bridge/health`
   - If this fails, it's a network issue, not WebSocket

## Expected Behavior After Fix

1. **Client** → `wss://backend.synap.live/socket.io/?EIO=4&transport=websocket`
2. **Caddy** → Detects `Upgrade: websocket` header automatically
3. **Caddy** → Upgrades connection and forwards to `realtime:4001`
4. **Realtime** → Receives WebSocket connection, logs appear
5. **Connection** → Established ✅

## Testing Plan

1. **Test HTTP first**: `curl https://backend.synap.live/realtime/bridge/health`
2. **Test WebSocket**: Browser DevTools → Network → WS tab
3. **Check logs**: Both Caddy and Realtime should show connection attempts
4. **Verify**: Realtime logs should show `[Presence] Client connected` or `[Yjs] Client connected`
