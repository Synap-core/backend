# Fix Docker Container Removal Error

## Problem

```
Error response from daemon: container is marked for removal and cannot be started
```

This happens when a Docker container is in a "removing" state and can't be restarted.

## Solution

### Option 1: Use the Fix Script (Recommended)

```bash
cd synap-backend/deploy
./fix-container-removal.sh
```

### Option 2: Manual Cleanup

```bash
cd synap-backend/deploy

# 1. Stop all containers
docker compose down

# 2. Remove problematic containers
docker ps -a --filter "status=removing" --format "{{.ID}}" | xargs -r docker rm -f
docker ps -a --filter "name=synap-backend-postgres" --format "{{.ID}}" | xargs -r docker rm -f

# 3. Clean up orphaned containers
docker container prune -f

# 4. Remove network (will be recreated)
docker network rm synap-backend_synap-net 2>/dev/null || true
```

### Option 3: Nuclear Option (Complete Cleanup)

If the above doesn't work:

```bash
cd synap-backend/deploy

# Stop everything
docker compose down -v

# Remove all containers
docker ps -a --format "{{.ID}}" | xargs -r docker rm -f

# Remove all volumes (⚠️ This deletes data!)
docker volume ls --filter "name=synap" --format "{{.Name}}" | xargs -r docker volume rm

# Remove networks
docker network ls --filter "name=synap" --format "{{.ID}}" | xargs -r docker network rm
```

## After Cleanup

Once cleanup is complete, run the install command again:

```bash
cd synap-backend/deploy
../synap install --domain <your-domain>
```

## Prevention

This issue typically occurs when:

- Docker is forcefully stopped (kill -9)
- System crashes during container operations
- Docker daemon restarts while containers are running

To prevent:

- Always use `docker compose down` to stop containers
- Don't force-kill Docker processes
- Ensure Docker daemon is running before operations
