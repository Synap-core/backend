# WebSocket Connection Failure - Root Cause Analysis

## Problem Statement

Frontend cannot connect to realtime server via WebSocket:

- **Frontend**: `http://localhost:3000` → `wss://backend.synap.live/socket.io/`
- **Realtime Server**: Running on `0.0.0.0:4001` ✅
- **Caddy**: Routes `/socket.io/*` → `realtime:4001`
- **Symptom**: No logs on realtime server = **requests never reach it**

## Root Cause Analysis

### 1. **Caddy WebSocket Upgrade Configuration** (PRIMARY SUSPECT)

**Issue**: Caddy v2 requires specific configuration for WebSocket upgrades.

**Current Caddyfile**:

```caddy
handle /socket.io/* {
    reverse_proxy realtime:4001 {
        header_up Connection {>Connection}
        header_up Upgrade {>Upgrade}
        ...
    }
}
```

**Problem**:

- `header_up` directives are for **outgoing** headers (to backend)
- Caddy v2 **automatically** handles WebSocket upgrades when it detects `Upgrade: websocket` header
- Manual header manipulation can **break** the automatic upgrade

**Evidence**: No requests reaching realtime server = Caddy is likely rejecting/failing the upgrade

### 2. **CORS Preflight Failure** (SECONDARY)

**Issue**: Cross-origin request (`localhost:3000` → `backend.synap.live`)

**Current Config**:

- Realtime server: `CORS_ORIGIN=*` (allows all) ✅
- But Caddy might be blocking OPTIONS preflight requests

**Evidence**: WebSocket handshake includes CORS, but if preflight fails, handshake never happens

### 3. **Path Mismatch** (POSSIBLE)

**Issue**: Socket.IO client might be using wrong path

**Current**:

- Client: `wss://backend.synap.live/socket.io/?EIO=4&transport=websocket`
- Server: `path: "/socket.io/"`
- Caddy: `handle /socket.io/*`

**Analysis**: Path looks correct, but trailing slash might matter

### 4. **Network Connectivity** (UNLIKELY BUT VERIFY)

**Issue**: Caddy can't reach realtime service

**Evidence Needed**: Test `docker exec caddy wget http://realtime:4001/bridge/health`

## Solution: Clean, Definitive Fix

### Step 1: Fix Caddyfile (Remove Manual Header Manipulation)

Caddy v2 **automatically** handles WebSocket upgrades. Manual `header_up` can break it.

### Step 2: Add Explicit WebSocket Support

Use Caddy's built-in WebSocket detection.

### Step 3: Ensure CORS Handles Preflight

Socket.IO handles CORS, but we need to ensure OPTIONS requests pass through.

### Step 4: Add Health Check Endpoint

Verify connectivity before WebSocket attempts.

## Implementation Plan

1. **Simplify Caddyfile** - Remove manual WebSocket header manipulation
2. **Test Connectivity** - Verify Caddy → Realtime network path
3. **Add Logging** - See what Caddy is actually receiving
4. **Verify CORS** - Ensure preflight requests work
5. **Test Incrementally** - HTTP first, then WebSocket
