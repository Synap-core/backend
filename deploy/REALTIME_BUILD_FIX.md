# Realtime Service Build Fix

## Problem

Realtime service is crashing with:

```
Error: Cannot find module '/app/dist/server.js'
```

## Root Cause

The Dockerfile was copying `dist/` but it might not be in the correct location after `pnpm deploy`, or the build might not be creating the file correctly.

## Solution

Updated `Dockerfile.realtime` to:

1. **Verify build output** before copying
2. **Explicitly copy dist/** after `pnpm deploy`
3. **Add debug output** to show what's in the container
4. **Fail build** if `server.js` is missing

## Changes Made

1. **Build verification**: Check that `server.js` exists in build output before copying
2. **Explicit copy**: Copy `dist/` directory after `pnpm deploy` to ensure it's included
3. **Debug output**: Show container contents during build to help troubleshoot
4. **Build failure**: Fail the build if `server.js` is missing (catch issues early)

## Rebuild Instructions

On the server, rebuild the realtime image:

```bash
cd /opt/synap-backend/deploy
docker compose build realtime
docker compose up -d realtime
```

Or use the CLI:

```bash
cd /opt/synap-backend
./synap update --build
```

## Verification

After rebuild, check:

1. **Container logs**: `docker compose logs realtime` (should see server starting)
2. **Health check**: `docker compose exec realtime wget -O- http://localhost:4001/bridge/health`
3. **File exists**: `docker compose exec realtime ls -la /app/dist/server.js`

If still failing, check the build logs for the debug output showing what files are in the container.
