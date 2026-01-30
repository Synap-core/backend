# Fix GHCR Private Package Issue

## The Problem

You're seeing:

```
Image ghcr.io/synap-core/backend:latest error from registry: unauthorized
```

And when you try to make the package public, you see:

```
"Setting is disabled by organization administrators."
```

## Why This Happens

Your GitHub organization (`synap-core`) has a policy that **prevents making packages public**. This is a security setting at the organization level.

## Solutions

### Solution 1: Use Build Fallback (Recommended - Works Immediately)

Since we've implemented automatic build fallback, you don't need to fix GHCR authentication:

```bash
./synap-cli update
```

This will:

1. Try to pull image (fails with unauthorized)
2. **Automatically fall back to building from source** ✅
3. Deploy the built image

**This works right now** without any GitHub configuration changes!

### Solution 2: Add GitHub Authentication (If You Want Image Pulls)

If you want to use image pulls instead of building from source, add authentication:

#### Step 1: Create GitHub Personal Access Token (PAT)

1. Go to: `https://github.com/settings/tokens`
2. Click **"Generate new token"** → **"Generate new token (classic)"**
3. Name: `GHCR Docker Pull`
4. Select scopes:
   - ✅ `read:packages` (required)
   - ✅ `write:packages` (optional, if you want to push)
5. Click **"Generate token"**
6. **Copy the token** (you won't see it again!)

#### Step 2: Add Token to Server

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

#### Step 3: Update `synap-cli` to Use Authentication

The `synap-cli` script already checks for `GITHUB_TOKEN` and uses it for authentication. Just add it to your `.env` file and it will work automatically.

### Solution 3: Ask Organization Admin to Enable Public Packages

If you want public packages (for open source), you need to:

1. Contact your GitHub organization admin
2. Ask them to enable "Public packages" in organization settings:
   - Go to: `https://github.com/organizations/synap-core/settings/packages`
   - Enable "Public packages" option
3. Then you can make individual packages public

**Note:** This might not be possible if your organization has strict security policies.

## Recommended Approach

**For self-hosted deployments, use the build fallback:**

```bash
./synap-cli update
```

**Why this is better:**

- ✅ Works immediately (no GitHub configuration needed)
- ✅ Always gets latest code (builds from source)
- ✅ No authentication required
- ✅ More reliable (doesn't depend on GHCR)

**When to use image pulls:**

- If you want faster updates (pulling is faster than building)
- If you want to pin specific versions
- If you have CI/CD publishing images regularly

## Summary

**Quick Fix (Works Now):**

```bash
./synap-cli update  # Automatically builds from source
```

**If You Want Image Pulls:**

1. Create GitHub PAT with `read:packages` scope
2. Add to `.env`: `GITHUB_TOKEN=ghp_xxx`
3. `./synap-cli update` will now pull images

**If You Want Public Packages:**

- Contact org admin to enable public packages
- Then make package public in GitHub settings
