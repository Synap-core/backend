# Realtime Service Debug Guide

## Problem

Realtime service crashes with:

```
Error: Cannot find module '/app/dist/server.js'
```

## Root Cause Analysis

The Dockerfile expects:

1. `src/server.ts` → compiles to → `dist/server.js`
2. Build step: `pnpm turbo build --filter=@synap/realtime`
3. Copy step: `cp -r /app/packages/realtime/dist /app/deploy/dist`
4. Run: `node dist/server.js`

**Issue**: The `dist/server.js` file doesn't exist in the final container.

## Debugging Steps

### Step 1: Check Build Output Locally

```bash
cd /opt/synap-backend

# Build the realtime package
pnpm turbo build --filter=@synap/realtime

# Check if server.js was created
ls -la packages/realtime/dist/server.js

# If it doesn't exist, check what was built
ls -la packages/realtime/dist/
```

**Expected**: `packages/realtime/dist/server.js` should exist

### Step 2: Check Docker Build Logs

```bash
cd /opt/synap-backend/deploy

# Rebuild with verbose output
docker compose build --no-cache realtime 2>&1 | tee build.log

# Look for these key lines:
# - "✓ server.js exists in build output"
# - "✓ server.js confirmed in /app/deploy/dist/"
# - "ERROR: /app/dist/server.js not found in final image!"
```

### Step 3: Inspect Container Contents

```bash
# Check what's actually in the container
docker compose run --rm realtime ls -la /app/
docker compose run --rm realtime ls -la /app/dist/ 2>/dev/null || echo "dist/ does not exist"
docker compose run --rm realtime find /app -name "server.js" -type f
```

### Step 4: Check TypeScript Compilation

The issue might be that TypeScript is not compiling correctly. Check:

```bash
cd /opt/synap-backend/packages/realtime

# Check tsconfig.json
cat tsconfig.json

# Try building manually
pnpm build

# Check output
ls -la dist/
```

## Common Issues & Solutions

### Issue 1: Build Fails Silently

**Symptom**: Build completes but `dist/server.js` doesn't exist

**Cause**: TypeScript compilation errors or build script issues

**Solution**:

```bash
cd /opt/synap-backend/packages/realtime
pnpm build
# Check for TypeScript errors
```

### Issue 2: pnpm deploy Doesn't Include dist/

**Symptom**: Build succeeds but `pnpm deploy` doesn't copy `dist/`

**Cause**: `pnpm deploy` might not include build artifacts

**Solution**: The Dockerfile already has explicit copy step:

```dockerfile
cp -r /app/packages/realtime/dist /app/deploy/dist
```

If this fails, check:

- Does `/app/packages/realtime/dist/` exist after build?
- Does the copy command have proper permissions?

### Issue 3: Wrong Output Path

**Symptom**: File exists but in wrong location

**Cause**: TypeScript `outDir` mismatch

**Check**: `tsconfig.json` should have:

```json
{
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  }
}
```

### Issue 4: Module Resolution Issues

**Symptom**: Build succeeds but runtime can't find dependencies

**Cause**: `pnpm deploy` might not include all dependencies

**Solution**: Check if `node_modules` exists in `/app/deploy/`

## Quick Fix

Run the fix script:

```bash
cd /opt/synap-backend/deploy
./fix-realtime-build.sh
```

Or manually:

```bash
cd /opt/synap-backend/deploy

# Stop service
docker compose stop realtime

# Remove old image
docker compose rm -f realtime
docker rmi $(docker images | grep 'backend-realtime' | awk '{print $3}') 2>/dev/null || true

# Rebuild
docker compose build --no-cache realtime

# Verify
docker compose run --rm realtime test -f /app/dist/server.js && echo "✅ OK" || echo "❌ FAILED"

# Start
docker compose up -d realtime

# Check logs
docker compose logs --tail=50 realtime
```

## Verification

After fixing, verify:

```bash
# 1. Check file exists
docker compose exec realtime ls -la /app/dist/server.js

# 2. Check service is running
docker compose ps realtime

# 3. Check logs (should see "Real-time WebSocket server running")
docker compose logs realtime | grep "WebSocket server"

# 4. Check health (if bridge endpoint exists)
docker compose exec realtime wget -O- http://localhost:4001/bridge/health 2>/dev/null || echo "Health endpoint not available"
```

## Prevention

The Dockerfile now includes verification steps that will fail the build if `server.js` is missing. This should prevent the issue from happening again.

If the build still fails, check:

1. TypeScript compilation errors
2. Build script configuration
3. File permissions
4. Docker build context
