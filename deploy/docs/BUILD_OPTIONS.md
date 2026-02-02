# Build Options - Complete Guide

**Different ways to build and deploy Synap Backend**

---

## 🎯 Overview

Synap supports multiple build strategies to fit different use cases:

1. **Image-based** (Production) - Pull pre-built images from registry
2. **Source-based** (Development) - Build from git repository
3. **Local build** (Testing) - Build from local source (bypasses GitHub)

---

## 📊 Comparison Table

| Feature                 | Image-Based            | Source-Based (`--build`)     | Local Build (`--local`)      |
| ----------------------- | ---------------------- | ---------------------------- | ---------------------------- |
| **Command**             | `./synap-cli update`   | `./synap-cli update --build` | `./synap-cli update --local` |
| **Speed**               | ⚡ Fast (seconds)      | 🐌 Slow (5-10 min)           | 🐌 Slow (5-10 min)           |
| **Source Code**         | ❌ Not needed          | ✅ Git repo needed           | ✅ Git repo needed           |
| **Uncommitted Changes** | ❌ Not included        | ✅ Included                  | ✅ Included                  |
| **GitHub Required**     | ✅ Yes (for images)    | ✅ Yes (for repo)            | ❌ No                        |
| **CI/CD Required**      | ✅ Yes                 | ❌ No                        | ❌ No                        |
| **Security**            | 🔒 No source on server | ⚠️ Source on server          | ⚠️ Source on server          |
| **Use Case**            | Production             | Development/Testing          | Hotfixes/Private changes     |

---

## 🚀 Option 1: Image-Based (Production)

**Best for**: Production deployments, fast updates

### How It Works

1. CI/CD builds image → Pushes to GitHub Container Registry
2. Server pulls image from registry
3. Fast deployment (seconds)

### Usage

```bash
./synap-cli update
```

### Requirements

- Docker images published to GHCR
- `GITHUB_REPOSITORY` set in `.env`
- `BACKEND_VERSION` set in `.env` (or defaults to `latest`)
- Optional: `GITHUB_TOKEN` for private repos

### Advantages

- ✅ **Fast**: Pull takes seconds
- ✅ **Secure**: No source code on server
- ✅ **Consistent**: Same image everywhere
- ✅ **Versioned**: Pin specific versions

### Disadvantages

- ❌ Requires CI/CD setup
- ❌ Requires images to be published
- ❌ Network dependency

---

## 🔨 Option 2: Source-Based (`--build`)

**Best for**: Development, testing, when images aren't available

### How It Works

1. Repository cloned on server
2. Docker builds image from source
3. Deploys built image

### Usage

```bash
./synap-cli update --build
```

### Requirements

- Repository cloned (e.g., `/opt/synap-backend`)
- Source code available
- Build dependencies (handled by Docker)

### Advantages

- ✅ **Flexible**: Works without CI/CD
- ✅ **Development-friendly**: Test local changes
- ✅ **First install**: Works when images don't exist

### Disadvantages

- ❌ **Slower**: Build takes 5-10 minutes
- ❌ **Source on server**: Less secure
- ❌ **Resource intensive**: Uses CPU/memory

---

## 🏠 Option 3: Local Build (`--local`)

**Best for**: Hotfixes, testing uncommitted changes, private modifications

### How It Works

1. Make changes to source code (uncommitted OK)
2. Build Docker image from current directory
3. Deploy built image
4. **No code pushed to GitHub**

### Usage

```bash
# 1. Make changes
cd /opt/synap-backend
vim packages/api/src/some-file.ts

# 2. Build and deploy (no commit needed!)
cd deploy
./synap-cli update --local
```

### Requirements

- Repository cloned on server
- Source code in parent directory
- Local changes (uncommitted OK)

### Advantages

- ✅ **No GitHub needed**: Bypasses CI/CD
- ✅ **Uncommitted changes**: Includes local modifications
- ✅ **Private changes**: Never pushed to GitHub
- ✅ **Fast iteration**: Test changes immediately

### Disadvantages

- ❌ **Slower**: Build takes 5-10 minutes
- ❌ **Source on server**: Less secure
- ❌ **Hard to track**: Changes not in git

### Use Cases

1. **Hotfixes**: Fix critical bug, deploy immediately, commit later
2. **Testing**: Test changes before committing
3. **Private config**: Server-specific changes you don't want in GitHub
4. **Security bypass**: Deploy without going through GitHub Actions

---

## 🔄 Workflow Examples

### Example 1: Production Update

```bash
# Standard production update (pulls image)
./synap-cli update
```

---

### Example 2: Development Testing

```bash
# Make changes
cd /opt/synap-backend
vim packages/api/src/feature.ts

# Build and test (includes uncommitted changes)
cd deploy
./synap-cli update --build

# Test changes
curl http://localhost:4000/health

# If good, commit
cd ..
git add .
git commit -m "feat: new feature"
git push
```

---

### Example 3: Critical Hotfix

```bash
# Emergency fix
cd /opt/synap-backend
vim packages/api/src/critical-bug.ts
# ... fix bug ...

# Deploy immediately (no commit, no GitHub)
cd deploy
./synap-cli update --local

# Verify fix
curl http://localhost:4000/health

# Later: commit and push
cd ..
git add .
git commit -m "fix: critical bug"
git push
```

---

### Example 4: Server-Specific Customization

```bash
# Make server-specific changes
cd /opt/synap-backend
vim packages/api/src/server-config.ts
# ... add server-specific logic ...

# Add to .gitignore (never commit)
echo "packages/api/src/server-config.ts" >> .gitignore

# Deploy (never goes to GitHub)
cd deploy
./synap-cli update --local

# Future updates: always use --local
./synap-cli update --local
```

---

## 🔒 Security Considerations

### When to Use Each Option

**Image-Based** (`update`):

- ✅ Production deployments
- ✅ Security-sensitive environments
- ✅ When you want fast updates

**Source-Based** (`update --build`):

- ✅ Development/testing
- ✅ First install (images don't exist)
- ✅ CI/CD not set up

**Local Build** (`update --local`):

- ✅ Hotfixes (then commit later)
- ✅ Testing before committing
- ✅ Server-specific customizations
- ⚠️ **Not recommended for production** (harder to track)

---

## 📚 Related Documentation

- **[Local Builds Guide](./LOCAL_BUILDS.md)** - Detailed guide for `--local` flag
- **[Update Guide](./UPDATE.md)** - Standard update process
- **[Deployment Strategies](./DEPLOYMENT_STRATEGIES.md)** - Architecture decisions

---

## ✅ Quick Reference

```bash
# Production (pull image)
./synap-cli update

# Development (build from source)
./synap-cli update --build

# Local (bypass GitHub, uncommitted changes)
./synap-cli update --local

# Specific version
./synap-cli update v1.2.3
```

---

**Last Updated**: 2026-02-02
