# Fix GHCR "Unauthorized" Error

## The Problem

You're seeing:

```
Image ghcr.io/synap-core/backend:latest error from registry: unauthorized
```

**The path is correct now** ✅, but you're still getting "unauthorized".

## Why This Happens

**GitHub Container Registry (GHCR) packages are PRIVATE by default**, even if:

- ✅ The repository is public
- ✅ The code is open source
- ✅ CI/CD successfully built and pushed the image

**This is a GitHub design decision** - package visibility is separate from repository visibility.

## Solution 1: Make Package Public (Recommended for Open Source)

### Step 1: Find Your Package

1. Go to: `https://github.com/orgs/synap-core/packages`
   OR
   `https://github.com/synap-core/backend/pkgs/container/backend`

2. Look for the package named `backend` (container type)

### Step 2: Check Current Visibility

- If it says **"Private"** → You need to make it public
- If it says **"Public"** → There's another issue (see Solution 2)

### Step 3: Make Package Public

1. Click on the `backend` package
2. Click **"Package settings"** (gear icon, usually on the right)
3. Scroll down to **"Danger Zone"** section
4. Click **"Change visibility"**
5. Select **"Public"**
6. Type the package name to confirm: `synap-core/backend`
7. Click **"I understand, change package visibility"**

### Step 4: Verify

After making it public, wait 1-2 minutes, then try again:

```bash
docker compose pull backend
```

**OR** test directly:

```bash
docker pull ghcr.io/synap-core/backend:latest
```

## Solution 2: Add Authentication (If You Want to Keep Package Private)

If you want to keep the package private, you need to authenticate:

### Step 1: Create GitHub Personal Access Token (PAT)

1. Go to: `https://github.com/settings/tokens`
2. Click **"Generate new token"** → **"Generate new token (classic)"**
3. Name: `GHCR Docker Pull`
4. Select scopes:
   - ✅ `read:packages` (required)
   - ✅ `write:packages` (if you want to push too)
5. Click **"Generate token"**
6. **Copy the token** (you won't see it again!)

### Step 2: Add Token to Server

**Option A: Add to `.env` file**

```bash
cd /opt/synap-backend/deploy
echo "GITHUB_TOKEN=ghp_xxxxxxxxxxxx" >> .env
echo "GITHUB_USER=your-username" >> .env
```

**Option B: Login directly**

```bash
echo "ghp_xxxxxxxxxxxx" | docker login ghcr.io -u your-username --password-stdin
```

### Step 3: Update `synap-cli` to Use Authentication

The `synap-cli` script should check for `GITHUB_TOKEN` and use it for authentication. Let me check if this is already implemented...

## Solution 3: Use Build Fallback (Always Works)

Since we already implemented automatic build fallback, you can just use it:

```bash
./synap-cli update
```

This will:

1. Try to pull image (fails with unauthorized)
2. **Automatically fall back to building from source** ✅
3. Deploy the built image

**This works immediately** without needing to fix GHCR authentication!

## Quick Diagnostic Commands

### Check Package Visibility

```bash
# Visit in browser:
https://github.com/orgs/synap-core/packages/container/backend
# Look for "Public" or "Private" badge
```

### Test Direct Pull

```bash
# This will show the exact error
docker pull ghcr.io/synap-core/backend:latest
```

### Check if Image Exists

```bash
# Visit GitHub Actions
https://github.com/synap-core/backend/actions
# Find "Publish Docker Images" workflow
# Check if it completed successfully
# Check the "Build and push Backend image" step
```

### Verify Image Was Pushed

```bash
# Check the workflow logs for:
# "Successfully pushed ghcr.io/synap-core/backend:latest"
```

## Most Likely Solution

**For open source repositories, make the package public:**

1. Go to: `https://github.com/orgs/synap-core/packages/container/backend`
2. Package settings → Danger Zone → Change visibility → Public
3. Wait 1-2 minutes
4. Try: `docker compose pull backend`

**OR** just use the build fallback (already works):

```bash
./synap-cli update  # Automatically builds if pull fails
```

## Why This Is Confusing

- ✅ Repository is public → Code is visible
- ❌ Package is private → Docker image requires auth
- 🔄 These are **separate settings** in GitHub

This is a common source of confusion with GHCR!

## Summary

**Quick Fix (Recommended):**

1. Make package public: `https://github.com/orgs/synap-core/packages/container/backend`
2. Wait 1-2 minutes
3. `docker compose pull backend`

**Alternative (Works Immediately):**

```bash
./synap-cli update  # Uses build fallback
```

**If You Want Private Package:**

1. Create GitHub PAT with `read:packages` scope
2. Add to `.env`: `GITHUB_TOKEN=ghp_xxx`
3. Login: `echo $GITHUB_TOKEN | docker login ghcr.io -u USERNAME --password-stdin`
