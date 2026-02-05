# Caddy Service Management Guide

## Service Name

The service name in docker-compose is **`caddy`** (not `caddyfile`).

## Restart Caddy

### Option 1: Using Docker Compose (Recommended)

```bash
cd /opt/synap-backend/deploy
docker compose restart caddy
```

### Option 2: Using Docker Directly

```bash
docker restart synap-backend-caddy-1
```

### Option 3: Stop and Start

```bash
cd /opt/synap-backend/deploy
docker compose stop caddy
docker compose start caddy
```

### Option 4: Using the CLI

```bash
cd /opt/synap-backend
./synap restart caddy
```

## Check Caddy Status

```bash
# Check if running
docker compose ps caddy

# View logs
docker compose logs caddy

# Follow logs in real-time
docker compose logs -f caddy
```

## Caddy Configuration

- **Config file**: `deploy/Caddyfile`
- **Reload config**: Caddy auto-reloads on file change, or restart the service
- **Validate config**: `docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile`

## Important: Caddy Dependency on Realtime

**Updated**: Caddy now uses `condition: service_started` instead of `service_healthy` for realtime. This means:

- ✅ Caddy will start even if realtime is down/crashing
- ✅ API will still work even if WebSocket service is unavailable
- ⚠️ WebSocket connections will fail if realtime is down (expected)

This ensures the main API remains available even if the realtime service has issues.
