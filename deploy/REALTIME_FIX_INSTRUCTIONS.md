# Realtime Service Fix Instructions

## Problem

Realtime service is crashing with:

```
Error: Cannot find module '/app/dist/server.js'
```

## Root Cause

The Docker image was built without the `dist/server.js` file. This can happen if:

1. The image was built before the Dockerfile fixes were added
2. The build failed silently
3. `pnpm deploy` didn't include the `dist` directory properly

## Solution

**Rebuild the realtime image** on your server:

### Option 1: Using the fix script (Recommended)

```bash
cd /opt/synap-backend/deploy
./fix-realtime-build.sh
```

### Option 2: Manual rebuild

```bash
cd /opt/synap-backend/deploy

# Stop the service
docker compose stop realtime

# Remove old image
docker compose rm -f realtime
docker rmi $(docker images | grep 'backend-realtime' | awk '{print $3}') 2>/dev/null || true

# Rebuild (no cache to ensure fresh build)
docker compose build --no-cache realtime

# Start the service
docker compose up -d realtime

# Check logs
docker compose logs --tail=50 realtime
```

### Option 3: Using the synap CLI

```bash
cd /opt/synap-backend
./synap update --build
```

## Verification

After rebuilding, verify the fix:

```bash
# Check if server.js exists in the container
docker compose exec realtime ls -la /app/dist/server.js

# Check service logs
docker compose logs realtime

# Check health endpoint (if available)
docker compose exec realtime wget -O- http://localhost:4001/bridge/health 2>/dev/null || echo "Health endpoint not available"
```

## Expected Output

After a successful rebuild, you should see:

- ✅ Build logs showing "✓ server.js exists in build output"
- ✅ Build logs showing "✓ server.js confirmed in /app/deploy/dist/"
- ✅ Container starting without errors
- ✅ Service logs showing Socket.IO server starting

## If Still Failing

If the rebuild doesn't fix it, check:

1. **Build logs**: Look for errors during the build process

   ```bash
   docker compose build realtime 2>&1 | tee build.log
   ```

2. **Container contents**: Check what's actually in the container

   ```bash
   docker compose run --rm realtime ls -la /app/
   docker compose run --rm realtime find /app -name "server.js" -type f
   ```

3. **Source build**: Verify the build works locally
   ```bash
   cd /opt/synap-backend
   pnpm turbo build --filter=@synap/realtime
   ls -la packages/realtime/dist/server.js
   ```

## Prevention

The Dockerfile now includes:

- ✅ Build verification (fails if server.js not created)
- ✅ Explicit dist copy (ensures dist/ is included)
- ✅ Final verification (fails build if server.js missing)

This should prevent the issue from happening again in future builds.
