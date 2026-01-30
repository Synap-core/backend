# How to Check and Fix GHCR Image Issues

## The Problem

You're seeing:

```
Image ghcr.io/synap-core/backend/backend:latest error from registry: unauthorized
```

Notice the **double `/backend`** - this is wrong!

## Step 1: Verify Image Path

### On Your Server

```bash
cd /opt/synap-backend/deploy

# Check what docker-compose is trying to pull
docker compose config | grep "image:"
```

**Should show:**

```
image: ghcr.io/synap-core/backend:latest
```

**If it shows:**

```
image: ghcr.io/synap-core/backend/backend:latest  # WRONG!
```

Then check your `.env`:

```bash
grep GITHUB_REPOSITORY .env
```

**Should be:**

```
GITHUB_REPOSITORY=synap-core/backend
```

**NOT:**

```
GITHUB_REPOSITORY=synap-core/backend/backend  # WRONG!
```

## Step 2: Check if Image Exists on GitHub

1. **Visit GitHub Packages:**

   ```
   https://github.com/orgs/synap-core/packages/container/backend
   ```

   Or:

   ```
   https://github.com/synap-core/backend/pkgs/container/backend
   ```

2. **Check:**
   - Does the package exist?
   - What tags are available? (latest, main, v1.x.x)
   - Is it **Public** or **Private**?

3. **If package is Private:**
   - Even if repo is public, packages are private by default
   - You need to make it public OR use authentication

## Step 3: Make Package Public (If Needed)

1. Go to: `https://github.com/orgs/synap-core/packages/container/backend`
2. Click **"Package settings"** (gear icon)
3. Scroll to **"Danger Zone"**
4. Click **"Change visibility"**
5. Select **"Public"**
6. Confirm

## Step 4: Verify CI Published the Image

1. Go to: `https://github.com/synap-core/backend/actions`
2. Find the **"Publish Docker Images"** workflow
3. Check if it completed successfully
4. Click on the workflow run
5. Check the **"Build and push Backend image"** step
6. Look for: `Successfully pushed ghcr.io/synap-core/backend:latest`

## Step 5: Test Image Pull Directly

```bash
# Try pulling directly (bypasses docker-compose)
docker pull ghcr.io/synap-core/backend:latest
```

**If this works:**

- Image exists and is accessible
- Issue is with docker-compose variable expansion

**If this fails with "unauthorized":**

- Package is private → Make it public (Step 3)
- Or add authentication (see below)

**If this fails with "not found":**

- Image doesn't exist → Check CI workflow (Step 4)

## Step 6: Add Authentication (If Package is Private)

If you want to keep the package private, add authentication:

```bash
# Add to .env
GITHUB_TOKEN=ghp_xxxxxxxxxxxx  # GitHub Personal Access Token
GITHUB_USER=your-username

# Then login
echo $GITHUB_TOKEN | docker login ghcr.io -u $GITHUB_USER --password-stdin
```

## Step 7: Use Build Fallback (Recommended)

Instead of fixing GHCR, just use the build fallback:

```bash
./synap-cli update
```

This will:

1. Try to pull image
2. If fails → automatically build from source
3. Works either way!

## Quick Fix Commands

### Fix 1: Check and Fix .env

```bash
cd /opt/synap-backend/deploy
cat .env | grep GITHUB_REPOSITORY
# Should be: GITHUB_REPOSITORY=synap-core/backend
# NOT: GITHUB_REPOSITORY=synap-core/backend/backend
```

### Fix 2: Verify Image Path

```bash
docker compose config | grep "image:"
# Should show: image: ghcr.io/synap-core/backend:latest
```

### Fix 3: Test Direct Pull

```bash
docker pull ghcr.io/synap-core/backend:latest
```

### Fix 4: Use Build Fallback

```bash
./synap-cli update  # Automatically falls back to build
```

## Common Issues

### Issue 1: Double `/backend` in Path

**Symptom:** `ghcr.io/synap-core/backend/backend:latest`

**Fix:** Check `.env` - `GITHUB_REPOSITORY` should be `synap-core/backend`, not `synap-core/backend/backend`

### Issue 2: Package is Private

**Symptom:** `unauthorized` error even though repo is public

**Fix:** Make package public in GitHub settings (Step 3)

### Issue 3: Image Doesn't Exist

**Symptom:** `not found` or `unauthorized`

**Fix:** Check CI workflow completed and image was pushed

### Issue 4: Wrong Image Name

**Symptom:** Image path doesn't match what CI published

**Fix:** Verify workflow pushes to `ghcr.io/synap-core/backend`, not `ghcr.io/synap-core/backend/backend`

## Summary

**Most likely causes:**

1. Package is private (even though repo is public) → Make it public
2. Image doesn't exist yet → Wait for CI to complete
3. Wrong path (double `/backend`) → Check `.env` file

**Quickest solution:**

```bash
./synap-cli update  # Uses build fallback, always works
```
