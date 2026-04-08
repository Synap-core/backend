# Synap Backend - DevOps Guide

**Complete guide to deployment, updates, and operations**

---

## 🎯 Overview

This guide explains how Synap Backend is deployed, updated, and managed. It covers the architecture decisions, best practices, and why we chose specific approaches.

---

## 🏗️ Deployment Architecture

### Docker-First Approach

**Decision**: Everything runs in Docker containers

**Why**:

- ✅ **No build tools on host**: Everything built inside Docker
- ✅ **Consistency**: Same environment everywhere (dev, staging, production)
- ✅ **Isolation**: Services don't interfere with each other
- ✅ **Portability**: Works on any Linux server
- ✅ **Easy updates**: Pull new image, restart container

**What This Means**:

- You don't need `pnpm`, `node`, or any build tools on your server
- All builds happen inside Docker containers
- The final image contains pre-built code
- Just pull the image and run it

---

## 📦 Service Components

### Core Services (Docker Compose)

1. **Backend API** (`backend`)
   - Main tRPC API server
   - Image: `ghcr.io/synap-core/backend:latest`
   - Port: 4000 (internal)

2. **PostgreSQL** (`postgres`)
   - Database with TimescaleDB + pgvector
   - Stores: Application data, events, user data

3. **Redis** (`redis`)
   - Caching and session storage

4. **MinIO** (`minio`)
   - Object storage (S3-compatible)
   - Stores: Files, documents, media

5. **Typesense** (`typesense`)
   - Search engine
   - Full-text and semantic search

6. **Ory Kratos** (`kratos`)
   - Authentication service
   - Manages identities and sessions

7. **Ory Hydra** (`hydra`)
   - OAuth2 provider

8. **Caddy** (`caddy`)
   - Reverse proxy + SSL automation
   - Handles Let's Encrypt certificates

9. **Inngest** (`inngest`)
   - Background job processing

10. **Migration Service** (`backend-migrate`)
    - One-shot service
    - Runs migrations before backend starts
    - Exits after completion

---

## 🔄 Update Process

### How Updates Work

```bash
cd /opt/synap-backend/deploy
./synap update
```

**What Happens**:

1. **Backup** (automatic)
   - Database dump
   - Configuration backup
   - Stored in `./backups/`

2. **Pull Image**
   - Pulls new Docker image from GHCR
   - Or builds from source if image doesn't exist

3. **Run Migrations** (FIRST)
   - Uses `docker compose run --rm backend-migrate`
   - One-shot service (runs once, then removes)
   - Exits with 0 if migrations already applied
   - Exits with 1 only on actual errors

4. **Start Backend**
   - `docker compose up -d backend`
   - Backend depends on migration completion

5. **Health Check**
   - Verifies backend is responding
   - Checks `/health` endpoint

---

### Why Migrations Run First

**Problem We Solved**:

- Backend was starting before migrations completed
- If migrations failed, backend would fail to start
- Unclear error messages

**Solution**:

- Run migrations BEFORE starting backend
- Use one-shot service (`docker compose run --rm`)
- Backend waits for migration completion
- Clear success/failure status

**Implementation**:

```yaml
backend:
  depends_on:
    backend-migrate:
      condition: service_completed_successfully
```

---

## 🗄️ Migration Strategy

### Idempotent Migrations

**Key Principle**: Migrations can be run multiple times safely

**How It Works**:

1. Migration script checks `_migrations` table
2. Skips already-applied migrations
3. Exits with code 0 when already applied (not an error)
4. Only exits with 1 on actual errors

**Why This Matters**:

- ✅ Safe to re-run migrations
- ✅ No data loss on re-runs
- ✅ Works with Docker restart policies
- ✅ Clear success/failure status

---

### One-Shot Migration Service

**Configuration**:

```yaml
backend-migrate:
  deploy:
    restart_policy:
      condition: no # One-shot, no restart
```

**Why One-Shot**:

- ✅ Migrations should run once, then stop
- ✅ Prevents infinite restart loops
- ✅ Clear completion status
- ✅ Backend can depend on completion

**Alternative (Wrong)**:

```yaml
restart_policy:
  condition: on-failure # ❌ Would restart on failure, causing loops
```

---

## 🔧 Management CLI

### `synap` Commands

**Health Check**:

```bash
./synap health
```

- Checks all services
- Verifies backend health endpoint
- Shows overall status

**Logs**:

```bash
./synap logs [service]
```

- View logs for all services or specific service
- Follow mode with `-f` flag

**Update**:

```bash
./synap update [version]
```

- Updates to latest or specific version
- Creates backup automatically
- Runs migrations
- Restarts services

**Backup**:

```bash
./synap backup [name]
```

- Creates database dump
- Backs up configuration
- Creates tarball in `./backups/`

**Restore**:

```bash
./synap restore <backup-file>
```

- Restores database from backup
- Restores configuration
- Restarts services

---

## 🐳 Docker Image Strategy

### Multi-Stage Builds

**Stage 1: Builder**

```dockerfile
FROM node:20-alpine AS builder
RUN npm install -g pnpm@10.28.0
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo build --filter=api
RUN cd packages/database && pnpm build:migrate
```

**Stage 2: Runner**

```dockerfile
FROM node:20-alpine AS runner
COPY --from=builder /app/deploy .
COPY --from=builder /app/packages/database/dist/scripts ./node_modules/@synap/database/dist/scripts
CMD ["node", "dist/index.js"]
```

**Benefits**:

- ✅ Smaller final image (no build tools)
- ✅ Faster builds (cached layers)
- ✅ Security (no dev dependencies)
- ✅ Consistency (same build everywhere)

---

### Image Registry

**GitHub Container Registry (GHCR)**:

- Format: `ghcr.io/synap-core/backend:latest`
- Tags: `latest`, `main`, version tags (`v1.2.3`)
- Authentication: GitHub token (for private repos)

**Why GHCR**:

- ✅ Integrated with GitHub
- ✅ Free for public repos
- ✅ Good performance
- ✅ Easy to use

---

## 🔐 Security

### Secret Management

**During Installation**:

- `synap install` generates all secrets automatically
- Stored in `.env` file (not in git)
- Backup created: `synap-backend-secrets.txt`
- **IMPORTANT**: User must backup and delete backup file

**Secrets Generated**:

- `POSTGRES_PASSWORD`
- `KRATOS_SECRETS_COOKIE`
- `KRATOS_SECRETS_CIPHER`
- `KRATOS_WEBHOOK_SECRET`
- `JWT_SECRET`
- `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY`
- `TYPESENSE_API_KEY`
- And more...

---

### Network Isolation

**Docker Network**:

- All services communicate via internal network
- Only Caddy exposed to internet (ports 80, 443)
- Internal services not accessible externally
- Secure by default

---

### SSL/TLS

**Caddy Automatic SSL**:

- Let's Encrypt certificates
- Automatic provisioning
- Automatic renewal
- Zero configuration

**Why Caddy**:

- ✅ No manual certificate management
- ✅ No cron jobs for renewal
- ✅ HTTP/3 support
- ✅ Simple configuration

---

## 📊 Monitoring

### Health Checks

**Backend Health Endpoint**:

- URL: `/health`
- Returns: `200 OK` if healthy
- Used by: Docker healthchecks, CLI, monitoring

**Docker Healthchecks**:

```yaml
healthcheck:
  test:
    [
      "CMD",
      "node",
      "-e",
      "require('http').get('http://localhost:4000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))",
    ]
  interval: 30s
  timeout: 10s
  retries: 3
```

---

### Logs

**View Logs**:

```bash
./synap logs [service]
```

**Docker Compose Logs**:

```bash
docker compose logs -f [service]
```

**Optional: Dozzle** (Log Viewer UI):

```bash
docker compose --profile monitoring up -d
# Access at http://server-ip:8888
```

---

## 🔄 CI/CD Integration

### GitHub Actions

**Workflows**:

1. **`ci.yml`** - Quality checks (runs on every commit)
2. **`docker-publish.yml`** - Build images (runs on version tags)
3. **`deploy-staging.yml`** - Deploy to staging (runs on version tags)

**Optimization Applied**:

- **Before**: 3 workflows per commit = 15-30 min
- **After**: 1 workflow per commit = 5-10 min
- **Savings**: 66% reduction

**Why**:

- CI needs fast feedback (runs on every commit)
- Docker builds are expensive (only on releases)
- Deployments should be stable (only on releases)

---

## 🎓 Best Practices

### 1. Always Backup Before Updates

```bash
./synap update  # Automatically creates backup
```

**Why**: Safety net if update fails

---

### 2. Test Migrations First

```bash
# Test migration service
docker compose run --rm backend-migrate
```

**Why**: Catch migration issues before updating

---

### 3. Monitor After Updates

```bash
./synap health
./synap logs backend
```

**Why**: Verify everything works correctly

---

### 4. Keep Backups Secure

- Store backups off-server
- Encrypt sensitive backups
- Test restore process periodically

---

## 🐛 Troubleshooting

### Migration Service Fails

**Symptom**: `backend-migrate` exits with code 1

**Check**:

```bash
docker compose logs backend-migrate
```

**Common Causes**:

- Database connection issues
- Migration file errors
- Permission issues

**Solution**:

- Check database is running
- Verify `DATABASE_URL` in `.env`
- Check migration logs

---

### Backend Won't Start

**Symptom**: Backend container keeps restarting

**Check**:

```bash
docker compose logs backend
./synap health
```

**Common Causes**:

- Migration not completed
- Database connection failed
- Missing environment variables

**Solution**:

- Verify migrations completed
- Check database is healthy
- Verify `.env` file is correct

---

### SSL Certificate Issues

**Symptom**: HTTPS not working

**Check**:

```bash
docker compose logs caddy
```

**Common Causes**:

- DNS not configured
- Port 80/443 blocked
- Rate limiting (Let's Encrypt)

**Solution**:

- Verify DNS A record
- Check firewall rules
- Wait 1-2 minutes for certificate

---

## 📚 References

- **Complete DevOps Guide**: `DEVOPS_COMPLETE_GUIDE.md` (root)
- **GitHub Actions**: `GITHUB_ACTIONS_AUDIT.md` (root)
- **Migration Fixes**: `DEVOPS_IMPROVEMENTS.md` (root)
- **Docker Documentation**: https://docs.docker.com/
- **Caddy Documentation**: https://caddyserver.com/docs/

---

## 🔒 Security Hardening

### Measures in Place

| Measure                | Implementation                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **CP↔Pod auth**        | ES256 asymmetric JWT — pods fetch CP public key from `CONTROL_PLANE_URL/.well-known/jwks.json`. No shared secret needed or stored on pods. |
| **JWKS resilience**    | 3-attempt exponential backoff on fetch failure (1s/5s/30s). Falls back to last-known-good key up to 48h.                                   |
| **Startup validation** | Pod refuses to start if `JWT_SECRET`, `POSTGRES_PASSWORD`, `SYNAP_SERVICE_ENCRYPTION_KEY`, or `KRATOS_SECRETS_COOKIE` are missing.         |
| **Secret generation**  | All secrets auto-generated by `install.sh` with `openssl rand -hex 32`. MinIO access key also randomized.                                  |
| **API key display**    | `setup-openclaw.sh` shows only the first 12 chars of the Hub API key in terminal output. Full key stored in `.env` only.                   |
| **File permissions**   | `.env` created with `chmod 600` (owner-read-only).                                                                                         |
| **Gitignore**          | `.env`, `.env.local`, `.env.*.local`, `.env.test`, `.env.development` all gitignored.                                                      |

### Secrets Rotation Runbook

Each secret has a specific impact when rotated. Follow the procedure for the secret you need to rotate:

#### `JWT_SECRET`

- **Impact**: Invalidates ALL active user sessions. All users will be logged out.
- **Procedure**:
  1. Generate new secret: `openssl rand -hex 64`
  2. Update `.env` on the pod
  3. Restart backend: `./synap restart backend`
  4. Users will need to log in again — no data loss

#### `SYNAP_SERVICE_ENCRYPTION_KEY`

- **Impact**: Invalidates all stored Intelligence Service credentials. IS connection will break until re-provisioned.
- **Procedure**:
  1. Generate new key: `openssl rand -hex 32`
  2. Update `.env`
  3. Restart backend
  4. Re-run `/api/provision/register-intelligence` from the Intelligence Service — this re-encrypts and stores new credentials
  5. Verify IS reconnects successfully

#### `KRATOS_SECRETS_COOKIE` / `KRATOS_SECRETS_CIPHER`

- **Impact**: Invalidates all Kratos sessions. All users must re-authenticate.
- **Procedure**:
  1. Generate new values in `install.sh` format
  2. Update both `.env` AND `config/kratos/kratos.yml` (Kratos does not support env var substitution)
  3. Restart Kratos: `docker compose restart kratos`

#### `VAULT_SERVER_KEY`

- **Impact**: Breaks vault secret decryption. Re-provision any vault entries after rotation.
- **Procedure**: Rotate with care — existing vault entries become unreadable. Best done during a maintenance window.

#### `PROVISIONING_TOKEN`

- **Impact**: Existing pods provisioned with the old token are unaffected (token is one-time-use). New pods cannot be provisioned with the old token.
- **Procedure**: Generate a new token, update `.env`, restart backend.

#### Control Plane JWKS Key Rotation (ES256)

- **Impact**: Pods refresh the public key within 24h automatically (via JWKS TTL refresh). If you rotate immediately, existing valid JWTs remain valid until their `exp` but new JWTs from the new key will work within 24h (or immediately after `clearJwksCache()` is called).
- **Procedure**: Rotate key in CP, pods pick it up automatically. No pod config change needed.

---

**Last Updated**: 2026-04-07
