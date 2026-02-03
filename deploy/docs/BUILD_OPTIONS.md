# Build Options Guide

Complete guide to different ways of building and deploying Synap Backend.

## 🎯 Quick Reference

| Method           | Command                  | Speed              | Use Case                |
| ---------------- | ------------------------ | ------------------ | ----------------------- |
| **Image-based**  | `./synap update`         | ⚡ Fast (seconds)  | Production              |
| **Source build** | `./synap update --build` | 🐌 Slow (5-10 min) | Development             |
| **Local build**  | `./synap update --local` | 🐌 Slow (5-10 min) | Testing/Private changes |

## 🚀 Option 1: Image-Based (Production)

**Best for**: Production deployments, fast updates

### Usage

```bash
./synap update
```

### How It Works

1. Pulls pre-built Docker image from GitHub Container Registry
2. Fast deployment (seconds, not minutes)
3. No source code needed on server

### Requirements

- Docker images published to GHCR
- `GITHUB_REPOSITORY` set in `.env` (e.g., `synap-core/backend`)
- `BACKEND_VERSION` set in `.env` (defaults to `latest`)

### Advantages

- ✅ **Fast**: Pull takes seconds
- ✅ **Secure**: No source code on server
- ✅ **Consistent**: Same image everywhere
- ✅ **Versioned**: Pin specific versions (`v1.2.3`)

---

## 🔨 Option 2: Source Build (Development)

**Best for**: Development, testing, when images aren't available

### Usage

```bash
./synap update --build
```

### How It Works

1. Builds Docker image from source code in repository
2. Includes uncommitted changes
3. Deploys built image

### Requirements

- Repository cloned (e.g., `/opt/synap-backend`)
- Source code available in parent directory

### Advantages

- ✅ **Flexible**: Works without CI/CD
- ✅ **Development-friendly**: Test local changes
- ✅ **First install**: Works when images don't exist

### Disadvantages

- ❌ **Slower**: Build takes 5-10 minutes
- ❌ **Source on server**: Less secure for production

---

## 🏠 Option 3: Local Build (Testing/Private)

**Best for**: Testing uncommitted changes, private modifications

### Usage

```bash
./synap update --local
```

### How It Works

1. Builds from current directory (bypasses GitHub)
2. Includes all uncommitted changes
3. No push to GitHub required

### When to Use

- Testing changes before committing
- Deploying hotfixes without CI/CD
- Keeping changes private
- Bypassing GitHub Actions

### Requirements

- Repository cloned on server
- Source code in parent directory

---

## 📊 Comparison

| Feature                 | Image-Based            | Source Build        | Local Build         |
| ----------------------- | ---------------------- | ------------------- | ------------------- |
| **Speed**               | ⚡ Seconds             | 🐌 5-10 min         | 🐌 5-10 min         |
| **Source Code**         | ❌ Not needed          | ✅ Git repo         | ✅ Git repo         |
| **Uncommitted Changes** | ❌ Not included        | ✅ Included         | ✅ Included         |
| **GitHub Required**     | ✅ Yes (for images)    | ✅ Yes (for repo)   | ❌ No               |
| **CI/CD Required**      | ✅ Yes                 | ❌ No               | ❌ No               |
| **Security**            | 🔒 No source on server | ⚠️ Source on server | ⚠️ Source on server |

---

## 🎯 Recommendations

### Production

```bash
# Use image-based updates
./synap update
```

### Development

```bash
# Build from source
./synap update --build
```

### Testing Private Changes

```bash
# Local build (bypasses GitHub)
./synap update --local
```

---

## 🔄 Automatic Fallback

The unified CLI automatically falls back to source build if image pull fails:

```bash
./synap update
# Tries to pull image first
# Falls back to build if pull fails
```

This ensures updates always work, even if images aren't available.

---

## 📚 Related Documentation

- [Installation Guide](./installation.md) - Initial setup
- [Deployment Strategies](../DEPLOYMENT_STRATEGIES.md) - Detailed strategies
- [Troubleshooting](./troubleshooting.md) - Common issues
