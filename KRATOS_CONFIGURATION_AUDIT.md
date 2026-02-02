# Kratos Configuration & Deployment Audit

**Date**: 2026-02-02  
**Purpose**: Comprehensive audit of Kratos configuration, deployment automation, and best practices

---

## 📋 Table of Contents

1. [What is kratos.yml?](#what-is-kratosyml)
2. [Why We Had Templates (The Problem)](#why-we-had-templates-the-problem)
3. [Current Deployment Architecture](#current-deployment-architecture)
4. [Best Practices for Kratos Configuration](#best-practices-for-kratos-configuration)
5. [Audit of Automation & Commands](#audit-of-automation--commands)
6. [Issues & Recommendations](#issues--recommendations)

---

## What is kratos.yml?

`kratos.yml` is the **main configuration file** for Ory Kratos (identity & access management). It defines:

- **Database connection** (`dsn`)
- **Server endpoints** (public/admin URLs)
- **Authentication flows** (login, registration, recovery)
- **Webhook URLs** (for syncing with backend)
- **CORS settings** (allowed origins for frontend)
- **Cookie settings** (domain, SameSite, secure)
- **UI URLs** (where to redirect users)
- **Session settings** (lifespan, cookie config)

**Key Point**: This is a **static YAML file** that Kratos reads on startup. It's not meant to be generated at runtime.

---

## Why We Had Templates (The Problem)

### Original Approach (Template + Script)

**What we had:**

- `kratos.yml.template` - Template with placeholders
- `kratos-entrypoint.sh` - Script to generate `kratos.yml` from template
- Dynamic CORS origins from `ALLOWED_ORIGINS` env var
- Dynamic cookie settings based on `DOMAIN` env var

**Why it seemed necessary:**

1. **CORS origins** - Different frontend URLs per deployment
2. **Cookie domain** - Different domains (localhost vs production)
3. **Webhook URL** - Needed to be `backend:4000` (Docker service name)

**Problems with this approach:**

1. ❌ **Complexity** - Extra script layer, harder to debug
2. ❌ **Fragility** - Script could fail, template could be missing
3. ❌ **Not standard** - Kratos doesn't expect runtime config generation
4. ❌ **Hard to maintain** - Two files to keep in sync
5. ❌ **Deployment issues** - Script needs to run, permissions, etc.

### The Real Issue

The webhook URL was the main problem:

- **Wrong**: `host.docker.internal:4000` (doesn't work in Docker)
- **Correct**: `backend:4000` (Docker service name)

But this should have been fixed in the **source file**, not via a script!

---

## Current Deployment Architecture

### 1. **Initial Installation** (`install.sh`)

**Location**: `synap-backend/deploy/install.sh`

**What it does:**

- Checks prerequisites (Docker, disk space)
- Clones repository (or uses local)
- Generates secrets (passwords, API keys)
- Creates `.env` file
- Sets up Docker Compose
- Starts all services

**How it's used:**

```bash
# One-command install
curl -fsSL https://raw.githubusercontent.com/Synap-core/backend/main/deploy/install.sh | bash

# Or clone and run
git clone https://github.com/Synap-core/backend.git
cd backend/deploy
./install.sh
```

**Status**: ✅ Works well, handles initial setup

---

### 2. **Update Process** (`synap-cli update`)

**Location**: `synap-backend/deploy/synap-cli`

**What it does:**

1. Reads `BACKEND_VERSION` from `.env`
2. Pulls Docker image from GHCR (or builds from source)
3. Updates `.env` with new version
4. Runs migrations
5. Restarts backend service

**How it's used:**

```bash
cd /opt/synap-backend/deploy
./synap-cli update              # Update to latest (pulls image)
./synap-cli update --build      # Force build from source
./synap-cli update v1.2.3        # Update to specific version
```

**Status**: ✅ Works, but has complexity around image pulling vs building

---

### 3. **Docker Compose Configuration**

**Location**: `synap-backend/deploy/docker-compose.yml`

**What it does:**

- Defines all services (backend, postgres, kratos, caddy, etc.)
- Sets environment variables
- Mounts volumes (config files, data)
- Configures networking

**Kratos Service (Current):**

```yaml
kratos:
  image: oryd/kratos:v1.3.1
  environment:
    DSN: postgres://synap:${POSTGRES_PASSWORD}@postgres:5432/kratos?sslmode=disable
    SERVE_PUBLIC_BASE_URL: https://${DOMAIN}/.ory/kratos/public/
    DOMAIN: ${DOMAIN}
  command:
    - kratos
    - serve
    - -c
    - /etc/config/kratos/kratos.yml
  volumes:
    - ../kratos:/etc/config/kratos # Mounts kratos.yml directly
```

**Status**: ✅ Clean, no entrypoint script needed

---

### 4. **GitHub Actions (CI/CD)**

**Location**: `.github/workflows/` (if exists)

**What it should do:**

- Build Docker images on push
- Push to GitHub Container Registry (GHCR)
- Tag images (latest, version tags)
- Run tests

**Current Status**: ⚠️ **Not found** - Need to check if CI/CD exists

**Expected workflow:**

1. Push to `main` → Build image → Push to `ghcr.io/synap-core/backend:main`
2. Create tag `v1.2.3` → Build image → Push to `ghcr.io/synap-core/backend:v1.2.3`

---

## Best Practices for Kratos Configuration

### ✅ Recommended Approach (What We Should Do)

1. **Static `kratos.yml` file**
   - Commit directly to repository
   - Use environment variable substitution for secrets (`${POSTGRES_PASSWORD}`)
   - Hardcode service names (`backend:4000` for webhook)
   - Include common CORS origins (can be edited if needed)

2. **Environment Variables for Secrets Only**
   - `DSN` - Database connection (Kratos supports this natively)
   - `SECRETS_COOKIE` - Cookie encryption secret
   - `SECRETS_CIPHER` - Data encryption secret
   - `SERVE_PUBLIC_BASE_URL` - Public API URL (Kratos supports this)
   - `SERVE_ADMIN_BASE_URL` - Admin API URL (Kratos supports this)

3. **No Runtime Scripts**
   - Kratos reads config file directly
   - No entrypoint scripts needed
   - Simpler, more predictable

4. **Docker Volume Mount**
   - Mount `kratos/kratos.yml` directly
   - No template generation needed

### ❌ What NOT to Do

1. **Don't generate config at runtime** - Use static files
2. **Don't use shell scripts for config** - Kratos has native env var support
3. **Don't hardcode secrets** - Use environment variables
4. **Don't use `host.docker.internal`** - Use Docker service names (`backend:4000`)

---

## Audit of Automation & Commands

### ✅ What's Working Well

1. **`install.sh`** - Initial setup
   - ✅ Handles prerequisites
   - ✅ Generates secrets
   - ✅ Creates `.env` file
   - ✅ Starts services

2. **`synap-cli`** - Management tool
   - ✅ Health checks
   - ✅ Logs viewing
   - ✅ Backup/restore
   - ✅ Update process
   - ✅ Config management

3. **Docker Compose** - Service orchestration
   - ✅ All services defined
   - ✅ Environment variables
   - ✅ Volume mounts
   - ✅ Health checks

### ⚠️ Issues & Gaps

1. **Kratos Configuration**
   - ❌ **FIXED**: Removed entrypoint script
   - ✅ **CURRENT**: Static `kratos.yml` with correct webhook URL
   - ⚠️ **TODO**: Verify CORS origins work for all deployments

2. **CI/CD Pipeline**
   - ⚠️ **MISSING**: No GitHub Actions found
   - ⚠️ **NEEDED**: Automated image builds on push
   - ⚠️ **NEEDED**: Automated image pushes to GHCR

3. **Update Process**
   - ✅ Works for pulling images
   - ⚠️ Complex fallback logic (pull → build from source)
   - ⚠️ No clear separation between "production" (images) and "development" (source builds)

4. **Configuration Management**
   - ✅ `.env` file for secrets
   - ⚠️ No validation of required env vars
   - ⚠️ No migration path for config changes

---

## Issues & Recommendations

### Issue 1: Kratos Configuration (FIXED ✅)

**Problem**: Entrypoint script was generating config at runtime

**Solution**:

- ✅ Removed `kratos-entrypoint.sh`
- ✅ Created static `kratos.yml` with correct webhook URL
- ✅ Removed template file

**Status**: ✅ **RESOLVED**

---

### Issue 2: CI/CD Pipeline (MISSING ⚠️)

**Problem**: No automated image builds

**Recommendation**: Create GitHub Actions workflow:

```yaml
# .github/workflows/docker-publish.yml
name: Build and Push Docker Image

on:
  push:
    branches: [main]
    tags: ["v*"]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Build and push
        uses: docker/build-push-action@v4
        with:
          context: ./synap-backend
          push: true
          tags: |
            ghcr.io/synap-core/backend:latest
            ghcr.io/synap-core/backend:${{ github.sha }}
            ghcr.io/synap-core/backend:${{ github.ref_name }}
```

**Priority**: 🔴 **HIGH** - Needed for automated deployments

---

### Issue 3: Update Process Complexity

**Problem**: `synap-cli update` has complex fallback logic

**Current Flow:**

1. Try to pull image from GHCR
2. If fails, build from source
3. Run migrations
4. Restart services

**Recommendation**: Simplify into two clear paths:

1. **Production Path** (image-based):

   ```bash
   ./synap-cli update          # Pulls image, no source needed
   ```

2. **Development Path** (source-based):
   ```bash
   ./synap-cli update --build  # Builds from source, requires repo
   ```

**Priority**: 🟡 **MEDIUM** - Works but could be clearer

---

### Issue 4: Configuration Validation

**Problem**: No validation of required env vars

**Recommendation**: Add validation to `install.sh` and `synap-cli`:

```bash
# Check required vars
REQUIRED_VARS=("DOMAIN" "POSTGRES_PASSWORD" "KRATOS_SECRETS_COOKIE")
for var in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!var}" ]; then
    echo "Error: $var is required"
    exit 1
  fi
done
```

**Priority**: 🟡 **MEDIUM** - Better error messages

---

### Issue 5: CORS Origins Management

**Problem**: CORS origins are hardcoded in `kratos.yml`

**Current Solution**: Edit `kratos/kratos.yml` directly

**Alternative** (if needed): Use Kratos environment variable support:

- Kratos doesn't natively support `ALLOWED_ORIGINS` env var
- Would need custom entrypoint (not recommended)
- **Better**: Just edit the YAML file (simpler)

**Priority**: 🟢 **LOW** - Current approach is fine

---

## Summary & Action Items

### ✅ What's Fixed

1. **Kratos Configuration** - Removed entrypoint script, using static `kratos.yml`
2. **Webhook URL** - Correctly set to `backend:4000`

### ⚠️ What Needs Work

1. **CI/CD Pipeline** - Create GitHub Actions for automated builds
2. **Update Process** - Simplify and document two clear paths
3. **Config Validation** - Add checks for required env vars

### 📋 Recommended Next Steps

1. **Immediate**:
   - ✅ Test Kratos with new static config
   - ✅ Verify webhook works correctly

2. **Short-term**:
   - Create GitHub Actions workflow for image builds
   - Add config validation to installer

3. **Long-term**:
   - Document deployment architecture
   - Create migration guide for config changes

---

## Conclusion

**The root cause** of the Kratos configuration issue was over-engineering:

- We tried to make it "dynamic" with templates and scripts
- But Kratos is designed to use **static config files**
- The solution was simple: commit a correct `kratos.yml` file

**Best practice**:

- ✅ Static config files (committed to repo)
- ✅ Environment variables for secrets only
- ✅ No runtime script generation
- ✅ Docker service names for internal communication

**Current state**: ✅ **CLEAN** - No shell scripts, static config, correct webhook URL
