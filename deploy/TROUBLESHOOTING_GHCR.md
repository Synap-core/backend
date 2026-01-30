# Troubleshooting GHCR Image Pull Issues

## Issue: "unauthorized" Error

### Symptom

```
Error response from daemon: error from registry: unauthorized
Image ghcr.io/synap-core/backend/backend:latest
```

### Root Causes

#### 1. **Double `/backend` in Image Path** ⚠️

**Wrong:**

```
ghcr.io/synap-core/backend/backend:latest
```

**Correct:**

```
ghcr.io/synap-core/backend:latest
```

**Check your `.env` file:**

```bash
grep GITHUB_REPOSITORY .env
```

Should be:

```
GITHUB_REPOSITORY=synap-core/backend
```

**NOT:**

```
GITHUB_REPOSITORY=synap-core/backend/backend  # WRONG!
```

#### 2. **Package Visibility (Most Common)**

Even if your **repository** is public, the **GHCR package** is **private by default**.

**Check package visibility:**

1. Go to: `https://github.com/orgs/synap-core/packages`
2. Find package: `container/backend`
3. Check if it says "Public" or "Private"

**Make package public:**

1. Click on the package
2. Go to "Package settings"
3. Scroll to "Danger Zone"
4. Click "Change visibility" → Select "Public"
5. Confirm

#### 3. **Image Doesn't Exist Yet**

If CI just ran, check:

1. Go to: `https://github.com/synap-core/backend/actions`
2. Find the latest `docker-publish` workflow run
3. Check if it completed successfully
4. Check the "Build and push Backend image" step logs
5. Verify the image was pushed: `ghcr.io/synap-core/backend:latest`

#### 4. **Authentication Required**

Even for public packages, Docker sometimes requires authentication.

**Solution 1: Login to GHCR**

```bash
# Using GitHub Personal Access Token (PAT)
echo $GITHUB_TOKEN | docker login ghcr.io -u YOUR_USERNAME --password-stdin

# Or add to .env
GITHUB_TOKEN=ghp_xxxxxxxxxxxx
GITHUB_USER=your-username
```

**Solution 2: Use Build Fallback (Recommended)**

```bash
# This will automatically fall back to building from source
./synap-cli update
```

## Quick Diagnostic Commands

### 1. Check Image Path

```bash
# On server
cd /opt/synap-backend/deploy
grep GITHUB_REPOSITORY .env
docker compose config | grep "image:"
```

Should show:

```
GITHUB_REPOSITORY=synap-core/backend
image: ghcr.io/synap-core/backend:latest
```

### 2. Test Image Pull Directly

```bash
# Try pulling directly (without docker-compose)
docker pull ghcr.io/synap-core/backend:latest
```

### 3. Check Package Exists

```bash
# Visit in browser
https://github.com/orgs/synap-core/packages/container/backend
```

### 4. Verify CI Published Image

```bash
# Check GitHub Actions
https://github.com/synap-core/backend/actions
# Look for "Publish Docker Images" workflow
```

## Solutions

### Solution 1: Make Package Public (Easiest)

1. Go to: `https://github.com/orgs/synap-core/packages/container/backend`
2. Click "Package settings"
3. Scroll to "Danger Zone"
4. Click "Change visibility" → "Public"
5. Try pulling again: `docker compose pull backend`

### Solution 2: Use Build Fallback (Works Immediately)

```bash
# This automatically falls back to building from source
./synap-cli update
```

### Solution 3: Add Authentication

```bash
# Add to .env
GITHUB_TOKEN=ghp_xxxxxxxxxxxx
GITHUB_USER=your-username

# Then update
./synap-cli update
```

### Solution 4: Force Build from Source

```bash
# Skip image pull, build directly
./synap-cli update --build
```

## Why "Unauthorized" for Open Source Repos?

GitHub Container Registry has these quirks:

1. **Packages are private by default** - Even if repo is public
2. **Authentication sometimes required** - Even for public packages
3. **Rate limiting** - Unauthenticated pulls have lower limits
4. **Package vs Repository** - Different visibility settings

## Best Practice

**For self-hosted deployments:**

1. ✅ **Make package public** (if you want public access)
2. ✅ **Use build fallback** (works whether images exist or not)
3. ✅ **Add authentication** (if you want faster, more reliable pulls)

**Recommended approach:**

```bash
# Use automatic fallback (already implemented)
./synap-cli update
# This will:
# 1. Try to pull image (fast)
# 2. If fails → build from source (reliable)
# 3. Deploy (works either way)
```

## Verification Checklist

- [ ] `.env` has `GITHUB_REPOSITORY=synap-core/backend` (not `/backend/backend`)
- [ ] Package is public: `https://github.com/orgs/synap-core/packages/container/backend`
- [ ] CI workflow completed: `https://github.com/synap-core/backend/actions`
- [ ] Image exists: `docker pull ghcr.io/synap-core/backend:latest` (test directly)
- [ ] Build fallback works: `./synap-cli update --build`

## Still Not Working?

1. **Check image path in error message** - Should be `ghcr.io/synap-core/backend:latest`
2. **Verify package exists** - Visit GitHub packages page
3. **Check CI logs** - Ensure image was actually pushed
4. **Use build fallback** - `./synap-cli update --build` (always works)
