# Deployment Strategies for Synap Backend

## Overview

Synap supports **two deployment strategies** to accommodate different use cases:

1. **Image-based deployment** (Production, Recommended)
2. **Source-based deployment** (Development, Fallback)

## Strategy 1: Image-Based Deployment (Production)

### When to Use

- ✅ Production environments
- ✅ Self-hosted instances (after initial setup)
- ✅ Fast updates (just pull, no build)
- ✅ No source code on server (more secure)
- ✅ Consistent builds across environments

### How It Works

```bash
# Update to latest
docker compose pull backend
docker compose up -d backend

# Or use CLI
./synap update
```

**Flow:**

1. CI/CD builds image → Pushes to GHCR
2. Server pulls image from registry
3. Fast deployment (seconds, not minutes)

### Requirements

- Docker images published to GitHub Container Registry
- `GITHUB_REPOSITORY` set in `.env` (e.g., `synap-core/backend`)
- `BACKEND_VERSION` set in `.env` (e.g., `latest` or `v1.2.3`)
- Optional: `GITHUB_TOKEN` for private repos

### Advantages

- ⚡ **Fast**: Pull takes seconds vs. build takes minutes
- 🔒 **Secure**: No source code on production server
- 📦 **Consistent**: Same image everywhere
- 🎯 **Versioned**: Pin specific versions for production
- 🔄 **Easy updates**: One command to update

### Disadvantages

- Requires CI/CD to be set up
- Requires images to be published
- Network dependency (need to pull from registry)

## Strategy 2: Source-Based Deployment (Development/Fallback)

### When to Use

- ✅ Development/testing
- ✅ First install (images don't exist yet)
- ✅ CI/CD not set up
- ✅ Network issues (can't pull images)
- ✅ Testing local changes
- ✅ Private repos without authentication

### How It Works

```bash
# Build from source
docker compose build backend
docker compose up -d backend

# Or use CLI with --build flag
./synap update --build
```

**Flow:**

1. Repository cloned on server
2. Docker builds image from source
3. Deploys built image

### Requirements

- Repository cloned (e.g., `/opt/synap-backend` or parent directory)
- Source code available
- Build dependencies (Node.js, pnpm, etc. - handled by Docker)

### Advantages

- 🛠️ **Flexible**: Works without CI/CD
- 🔧 **Development-friendly**: Test local changes
- 🚀 **First install**: Works when images don't exist
- 🔓 **No auth needed**: No registry authentication required

### Disadvantages

- 🐌 **Slower**: Build takes 5-10 minutes vs. seconds
- 📦 **Source code on server**: Less secure for production
- 🔄 **Resource intensive**: Uses CPU/memory during build
- ⚠️ **Inconsistent**: Builds may differ between environments

## Hybrid Approach (Recommended)

**Best of both worlds**: Try image first, fall back to source if needed.

### Automatic Fallback

The `docker-compose.yml` already supports this:

```yaml
backend:
  image: ghcr.io/synap-core/backend:latest # Try to pull
  build:
    context: ..
    dockerfile: deploy/Dockerfile # Fallback: build if pull fails
```

**How it works:**

1. `docker compose pull` → tries to pull image
2. If pull fails → `docker compose build` → builds from source
3. `docker compose up` → uses whichever is available

### Using synap

```bash
# Try to pull, fall back to build if needed (automatic)
./synap update

# Force build from source (skip pull attempt)
./synap update --build

# Update to specific version (pull image)
./synap update v1.2.3
```

## Comparison Table

| Feature           | Image-Based        | Source-Based         | Hybrid                      |
| ----------------- | ------------------ | -------------------- | --------------------------- |
| **Speed**         | ⚡ Fast (seconds)  | 🐌 Slow (minutes)    | ⚡ Fast (with fallback)     |
| **Security**      | 🔒 No source code  | ⚠️ Source on server  | 🔒 Prefers no source        |
| **Setup**         | Requires CI/CD     | Requires repo clone  | Works either way            |
| **Updates**       | One command        | Build + deploy       | One command                 |
| **Consistency**   | ✅ Same everywhere | ⚠️ May differ        | ✅ Same (when using images) |
| **First Install** | ❌ Needs images    | ✅ Works immediately | ✅ Works immediately        |
| **Development**   | ❌ Not ideal       | ✅ Perfect           | ✅ Flexible                 |

## Recommendations

### For Production / Self-Hosted

**Recommended: Image-based with fallback**

```bash
# In .env
GITHUB_REPOSITORY=synap-core/backend
BACKEND_VERSION=v1.2.3  # Pin version, not "latest"

# Update
./synap update
```

**Why:**

- Fast, secure, versioned
- Fallback ensures it works even if images unavailable
- Standard Docker Compose pattern

### For Development / Testing

**Recommended: Source-based**

```bash
# Clone repository
git clone https://github.com/synap-core/backend.git
cd backend/deploy

# Build and run
./synap update --build
```

**Why:**

- Test local changes
- No need for CI/CD
- Fast iteration

### For First Install

**Recommended: Hybrid (automatic fallback)**

```bash
# Installer handles this automatically
curl -fsSL https://raw.githubusercontent.com/synap-core/backend/main/synap -o synap && chmod +x synap && ./synap install --clone --from-image latest
```

**Why:**

- Works whether images exist or not
- Seamless experience
- No manual intervention needed

## Migration Path

### From Source-Based to Image-Based

1. **Set up CI/CD** (if not already done)
   - Images will be published automatically

2. **Update `.env`**

   ```bash
   GITHUB_REPOSITORY=synap-core/backend
   BACKEND_VERSION=latest
   ```

3. **Switch to image-based updates**

   ```bash
   ./synap update  # Now pulls images instead of building
   ```

4. **Optional: Remove source code** (after confirming it works)
   ```bash
   # Keep only deploy directory
   cd /opt/synap-backend
   rm -rf apps/ packages/ node_modules/ pnpm-lock.yaml
   ```

## Troubleshooting

### Image pull fails

**Option 1: Use fallback (automatic)**

```bash
./synap update  # Automatically falls back to build
```

**Option 2: Force build**

```bash
./synap update --build
```

**Option 3: Check image exists**

- Visit: https://github.com/synap-core/backend/pkgs/container/backend
- Ensure image is published
- Check version tag matches

### Build from source fails

**Check:**

1. Repository is cloned
2. Parent directory has source code (`../packages`, `../apps`)
3. Docker has enough resources (CPU, memory, disk)

**Solution:**

```bash
# Ensure repository is in parent directory
cd /opt/synap-backend/deploy
ls ../packages  # Should exist

# Or clone if missing
cd /opt
git clone https://github.com/synap-core/backend.git synap-backend
cd synap-backend/deploy
```

## Summary

**Best Practice:**

- ✅ **Production**: Image-based (fast, secure, versioned)
- ✅ **Development**: Source-based (flexible, test changes)
- ✅ **First Install**: Hybrid (automatic fallback)
- ✅ **Updates**: Image-based with source fallback

The hybrid approach gives you the best of both worlds: fast image-based updates in production, with a reliable fallback to source-based builds when needed.
