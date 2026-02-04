# Building Docker Images Directly on Server

**Complete guide to building images locally instead of waiting for GitHub CI/CD**

---

## 🎯 Quick Reference

| Method          | Command                       | When to Use                       |
| --------------- | ----------------------------- | --------------------------------- |
| **Auto-detect** | `./synap update`              | In git repo: builds automatically |
| **Force build** | `./synap update --build`      | Always build, never pull          |
| **Force pull**  | `./synap update --from-image` | Always pull, never build          |

---

## 🚀 Option 1: Automatic (Recommended)

The `synap` CLI automatically detects your environment:

```bash
cd /opt/synap-backend/deploy
./synap update
```

**Behavior:**

- ✅ **In git repo**: Builds from source automatically (faster for development)
- ✅ **Not in git repo**: Pulls images from GitHub Container Registry (production)

**Why this works:**

- If you have the repo cloned, you likely want to test changes
- If you don't have the repo, you want pre-built images

---

## 🔨 Option 2: Force Build from Source

Always build locally, even if images are available:

```bash
cd /opt/synap-backend/deploy
./synap update --build
# or
./synap update --from-source
```

**What happens:**

1. Builds `backend` service from `Dockerfile.api`
2. Builds `realtime` service from `Dockerfile.realtime`
3. Skips pulling from registry
4. Deploys built images

**Use cases:**

- ✅ Testing uncommitted changes
- ✅ CI/CD not set up yet
- ✅ Network issues (can't pull images)
- ✅ Custom modifications

---

## 📦 Option 3: Force Pull from Registry

Always pull pre-built images, never build:

```bash
cd /opt/synap-backend/deploy
./synap update --from-image
```

**What happens:**

1. Pulls `ghcr.io/synap-core/backend:latest`
2. Pulls `ghcr.io/synap-core/backend-realtime:latest`
3. Skips building
4. Deploys pulled images

**Use cases:**

- ✅ Production deployments
- ✅ Fast updates (seconds vs minutes)
- ✅ No source code on server

---

## 🔧 Manual Docker Compose Build

You can also use Docker Compose directly:

```bash
cd /opt/synap-backend/deploy

# Build both services
docker compose build backend realtime

# Build specific service
docker compose build backend

# Build without cache (fresh build)
docker compose build --no-cache backend

# Build and start
docker compose up -d --build backend realtime
```

---

## 📊 Comparison

| Feature                 | Auto-detect                      | Force Build | Force Pull          |
| ----------------------- | -------------------------------- | ----------- | ------------------- |
| **Speed**               | ⚡ Smart (builds if repo exists) | 🐌 5-10 min | ⚡ Seconds          |
| **Source Code**         | ✅ If in repo                    | ✅ Required | ❌ Not needed       |
| **Uncommitted Changes** | ✅ Included                      | ✅ Included | ❌ Not included     |
| **Network Required**    | ❌ No (if building)              | ❌ No       | ✅ Yes (for pull)   |
| **CI/CD Required**      | ❌ No                            | ❌ No       | ✅ Yes (for images) |

---

## 🎯 Best Practices

### Development Server

```bash
# Clone repo
git clone https://github.com/synap-core/backend.git /opt/synap-backend
cd /opt/synap-backend/deploy

# Auto-builds from source (detects git repo)
./synap update
```

### Production Server (No Source Code)

```bash
# Just deploy directory (no repo clone)
cd /opt/synap-backend/deploy

# Pulls pre-built images
./synap update --from-image
```

### Testing Changes

```bash
# Make changes in repo
cd /opt/synap-backend
# ... edit files ...

# Force rebuild with changes
cd deploy
./synap update --build
```

---

## 🔄 How It Works

### Docker Compose Fallback

The `docker-compose.yml` is configured with automatic fallback:

```yaml
backend:
  image: ghcr.io/synap-core/backend:latest # Try to pull
  build:
    context: ..
    dockerfile: deploy/Dockerfile.api # Fallback: build if pull fails
```

**Flow:**

1. `docker compose pull` → tries to pull image
2. If pull fails → `docker compose build` → builds from source
3. `docker compose up` → uses whichever is available

### Separate Images

Each service has its own Dockerfile:

- **`Dockerfile.api`** → `backend` service
- **`Dockerfile.realtime`** → `realtime` service

Both are built/pulled independently.

---

## 🐛 Troubleshooting

### Build Fails

```bash
# Check build logs
docker compose build backend 2>&1 | tee build.log

# Rebuild without cache
docker compose build --no-cache backend

# Check Docker resources
docker system df
```

### Pull Fails

```bash
# Check network
ping ghcr.io

# Check authentication
docker login ghcr.io

# Fall back to build
./synap update --build
```

### Mixed State

```bash
# Clean everything
docker compose down
docker compose build --no-cache
docker compose up -d
```

---

## 📚 Related Documentation

- [Deployment Strategies](./DEPLOYMENT_STRATEGIES.md) - Image vs source deployment
- [Build Options](./BUILD_OPTIONS.md) - All build methods
- [Installation Guide](./installation.md) - Initial setup
