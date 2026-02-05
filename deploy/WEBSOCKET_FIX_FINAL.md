# WebSocket Connection Fix - Final Solution

## Root Cause Identified

From diagnostic logs:

- **Test 2 PASSED**: Caddy CAN reach realtime via Docker network ✅
- **Test 6 PASSED**: Realtime IS listening on `0.0.0.0:4001` ✅
- **Caddy Logs Show**: `"dial tcp: lookup realtime on 127.0.0.11:53: server misbehaving"` ❌

**Root Cause**: **Docker DNS resolution is intermittent/failing**

Caddy is trying to resolve `realtime` hostname via Docker's internal DNS (127.0.0.11:53), but it's failing intermittently. This causes:

- DNS lookup failures
- Connection timeouts
- Connection refused errors

## Solution

### 1. Ensure Service Startup Order

Added `depends_on` for realtime in Caddy service to ensure realtime starts and is healthy before Caddy tries to connect.

### 2. Add DNS Configuration

Added explicit DNS configuration to both services to ensure Docker's internal DNS works reliably.

### 3. Verify Network Configuration

Both services are on `synap-net` network (already correct).

## Changes Made

1. **docker-compose.yml**:
   - Added `depends_on: realtime: condition: service_healthy` to Caddy
   - Added `dns: [127.0.0.11]` to both Caddy and Realtime services

2. **Caddyfile**: Already correct (no manual WebSocket header manipulation)

3. **Realtime Server**: Already correct (listening on `0.0.0.0:4001`, CORS allows all)

## Testing After Fix

1. **Restart services**:

```bash
cd /opt/synap-backend/deploy
docker compose restart caddy realtime
```

2. **Verify DNS resolution**:

```bash
docker compose exec caddy nslookup realtime
# Should return: realtime's IP address
```

3. **Test WebSocket connection**:

- Open browser DevTools → Network → WS tab
- Try to connect
- Check realtime logs: Should see `[Socket.IO] Initial connection attempt`

## Expected Behavior

1. **Caddy starts** → Waits for realtime to be healthy
2. **Realtime becomes healthy** → Caddy can now resolve `realtime` hostname
3. **WebSocket request** → Caddy resolves `realtime` → Forwards to `realtime:4001`
4. **Realtime receives connection** → Logs appear ✅

## If Still Fails

If DNS still fails, we can use IP address directly in Caddyfile (not recommended, but works):

```caddy
reverse_proxy 172.19.0.10:4001  # Use IP instead of hostname
```

But this should not be necessary - the `depends_on` + DNS config should fix it.
