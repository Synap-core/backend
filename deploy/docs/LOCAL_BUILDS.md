# Local Builds - Bypassing GitHub Actions

**Build Docker images directly on your server without pushing to GitHub**

---

## 🎯 Overview

Sometimes you want to:

- ✅ Test changes before committing
- ✅ Deploy hotfixes without waiting for CI/CD
- ✅ Keep changes private (not in GitHub)
- ✅ Build with uncommitted local modifications
- ✅ Bypass GitHub Actions security checks

**Solution**: Build Docker images directly on your server from local source code.

---

## 🚀 Quick Start

### Option 1: Using synap-cli (Recommended)

```bash
cd /opt/synap-backend/deploy

# Build from local source (includes uncommitted changes)
./synap-cli update --local
```

**What this does**:

1. Creates backup
2. Builds Docker image from current directory
3. Runs migrations
4. Restarts backend with new image

---

### Option 2: Manual Docker Build

```bash
cd /opt/synap-backend/deploy

# Build image
docker compose build backend

# Run migrations
docker compose run --rm backend-migrate

# Restart backend
docker compose up -d backend
```

---

## 📋 Prerequisites

### 1. Repository Cloned on Server

**Structure**:

```
/opt/synap-backend/          (repository root)
├── packages/                 (source code)
├── apps/                     (source code)
├── deploy/                   (deployment files)
│   ├── docker-compose.yml
│   ├── synap-cli
│   └── Dockerfile
└── .git/                     (git repository)
```

**Clone repository** (if not already):

```bash
cd /opt
git clone https://github.com/synap-core/backend.git synap-backend
cd synap-backend/deploy
```

---

### 2. Make Local Changes

**Edit source code**:

```bash
cd /opt/synap-backend

# Make your changes
vim packages/api/src/index.ts

# Or use your preferred editor
# Changes don't need to be committed!
```

---

### 3. Build and Deploy

**Using CLI**:

```bash
cd /opt/synap-backend/deploy
./synap-cli update --local
```

**Manual**:

```bash
cd /opt/synap-backend/deploy
docker compose build backend
docker compose run --rm backend-migrate
docker compose up -d backend
```

---

## 🔄 Workflow Examples

### Example 1: Quick Hotfix

**Scenario**: Need to fix a bug immediately, can't wait for CI/CD

```bash
# 1. SSH into server
ssh user@server

# 2. Navigate to repo
cd /opt/synap-backend

# 3. Make fix
vim packages/api/src/some-file.ts
# ... make changes ...

# 4. Build and deploy (no commit needed!)
cd deploy
./synap-cli update --local

# 5. Test fix
curl http://localhost:4000/health

# 6. Later: commit and push to GitHub
git add .
git commit -m "fix: critical bug"
git push
```

---

### Example 2: Testing Uncommitted Changes

**Scenario**: Want to test changes before committing

```bash
# 1. Make experimental changes
cd /opt/synap-backend
vim packages/api/src/experimental-feature.ts

# 2. Build and test locally
cd deploy
./synap-cli update --local

# 3. Test the changes
# ... use the API ...

# 4. If it works, commit
cd ..
git add .
git commit -m "feat: experimental feature"
git push

# 5. If it doesn't work, discard
git checkout -- packages/api/src/experimental-feature.ts
```

---

### Example 3: Private Changes (Never Push to GitHub)

**Scenario**: Server-specific configuration you don't want in GitHub

```bash
# 1. Make server-specific changes
cd /opt/synap-backend
vim packages/api/src/server-config.ts
# ... add server-specific logic ...

# 2. Build and deploy
cd deploy
./synap-cli update --local

# 3. Add to .gitignore (so it's never committed)
cd ..
echo "packages/api/src/server-config.ts" >> .gitignore

# 4. Continue using --local for updates
# These changes will never be pushed to GitHub
```

---

## 🔒 Security Considerations

### When to Use Local Builds

**✅ Good Use Cases**:

- Development/testing
- Hotfixes (then commit later)
- Server-specific customizations
- Testing before committing

**⚠️ Be Careful With**:

- Production deployments (prefer image-based)
- Security-sensitive changes (should be reviewed)
- Long-term maintenance (harder to track)

---

### Best Practices

1. **Commit Eventually**: Even if you test locally first, commit changes for tracking
2. **Document Changes**: Keep notes of what you changed and why
3. **Use Branches**: Create a branch for experimental changes
4. **Backup First**: Always backup before deploying local builds

---

## 🆚 Comparison: Local vs Image-Based

| Feature                 | Local Build (`--local`)  | Image-Based (default)     |
| ----------------------- | ------------------------ | ------------------------- |
| **Speed**               | 🐌 Slow (5-10 min build) | ⚡ Fast (seconds to pull) |
| **Uncommitted Changes** | ✅ Included              | ❌ Not included           |
| **GitHub Required**     | ❌ No                    | ✅ Yes                    |
| **CI/CD Required**      | ❌ No                    | ✅ Yes                    |
| **Security**            | ⚠️ Source on server      | 🔒 No source on server    |
| **Use Case**            | Development/testing      | Production                |

---

## 🛠️ Troubleshooting

### Build Fails

**Problem**: `docker compose build` fails

**Check**:

1. Are you in the `deploy/` directory?
2. Is source code in parent directory?
3. Are dependencies installed? (Docker handles this)

**Solution**:

```bash
# Verify structure
cd /opt/synap-backend/deploy
ls ../packages  # Should show packages
ls ../apps      # Should show apps

# Check Docker
docker --version
docker compose version

# Try manual build
docker compose build backend --no-cache
```

---

### Image Not Updating

**Problem**: Changes not reflected after build

**Check**:

1. Did build complete successfully?
2. Did you restart the backend?
3. Are you looking at the right service?

**Solution**:

```bash
# Force rebuild (no cache)
docker compose build backend --no-cache

# Restart backend
docker compose restart backend

# Check logs
docker compose logs backend
```

---

### Out of Disk Space

**Problem**: Build fails due to disk space

**Check**:

```bash
df -h
docker system df
```

**Solution**:

```bash
# Clean up Docker
docker system prune -a

# Remove old images
docker image prune -a

# Free up space, then rebuild
```

---

## 📚 Related Documentation

- **[Update Guide](./UPDATE.md)** - Standard update process
- **[Deployment Strategies](./DEPLOYMENT_STRATEGIES.md)** - Image vs source-based
- **[DevOps Guide](./DEVOPS.md)** - Complete deployment guide

---

## ✅ Checklist

Before using local builds:

- [ ] Repository cloned on server
- [ ] Source code in correct location
- [ ] Docker and Docker Compose installed
- [ ] Sufficient disk space (5GB+ recommended)
- [ ] Backup created (automatic with `synap-cli`)
- [ ] Changes tested locally (if possible)
- [ ] Plan to commit changes (eventually)

---

**Last Updated**: 2026-02-02
