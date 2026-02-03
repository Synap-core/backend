# Fix GHCR Permission Denied Error

## The Error

```
ERROR: failed to push ghcr.io/synap-core/backend:main: denied: permission_denied: write_package
```

## Root Cause

This happens when:

1. **Package doesn't exist yet** - First push requires package creation
2. **Organization settings** - Organization might have restrictions on package creation
3. **GITHUB_TOKEN scope** - Default token might not have enough permissions for organization packages

## Solution 1: Check Organization Settings (Most Common Fix)

### Step 1: Check Package Permissions

1. Go to: `https://github.com/organizations/synap-core/settings/packages`
2. Check these settings:
   - **"Package creation"** should allow repository members
   - **"Package visibility"** should allow public packages (if you want public)
   - **"Package deletion"** settings

### Step 2: Check Repository Settings

1. Go to: `https://github.com/synap-core/backend/settings`
2. Go to **"Actions"** → **"General"**
3. Under **"Workflow permissions"**:
   - ✅ Select: **"Read and write permissions"**
   - ✅ Check: **"Allow GitHub Actions to create and approve pull requests"** (if needed)

### Step 3: Check Organization Actions Settings

1. Go to: `https://github.com/organizations/synap-core/settings/actions`
2. Under **"Workflow permissions"**:
   - ✅ Select: **"Read and write permissions"**
   - ✅ Check: **"Allow GitHub Actions to create and approve pull requests"**

## Solution 2: Create Package Manually First

If the package doesn't exist, create it first:

1. Go to: `https://github.com/orgs/synap-core/packages`
2. Click **"New package"**
3. Select **"Container"**
4. Name: `backend`
5. Visibility: **Public** (for open source) or **Private**
6. Click **"Create package"**

Then the workflow should be able to push to it.

## Solution 3: Use Personal Access Token (PAT) Instead

If organization settings can't be changed, use a PAT:

### Step 1: Create PAT

1. Go to: `https://github.com/settings/tokens`
2. Click **"Generate new token"** → **"Generate new token (classic)"**
3. Name: `GHCR Push Token`
4. Expiration: **90 days** (or custom)
5. Select scopes:
   - ✅ `write:packages` (required)
   - ✅ `read:packages` (required)
   - ✅ `delete:packages` (optional)
6. Click **"Generate token"**
7. **Copy the token** (you won't see it again!)

### Step 2: Add PAT as Secret

1. Go to: `https://github.com/synap-core/backend/settings/secrets/actions`
2. Click **"New repository secret"**
3. Name: `GHCR_PAT`
4. Value: `ghp_xxxxxxxxxxxx` (your token)
5. Click **"Add secret"**

### Step 3: Update Workflow

Update `.github/workflows/docker-publish.yml` to use the PAT:

```yaml
- name: Log in to Container Registry
  uses: docker/login-action@v3
  with:
    registry: ${{ env.REGISTRY }}
    username: ${{ github.actor }}
    password: ${{ secrets.GHCR_PAT }} # Changed from GITHUB_TOKEN
```

## Solution 4: Add id-token Permission (For OIDC)

Some organizations require OIDC. Add this to the workflow:

```yaml
permissions:
  contents: read
  packages: write
  id-token: write # Add this for OIDC
```

## Quick Check: Verify Current Settings

Run this in your terminal to check if package exists:

```bash
# Check if package exists (requires auth)
curl -H "Authorization: token YOUR_TOKEN" \
  https://api.github.com/orgs/synap-core/packages/container/backend
```

If you get `404 Not Found`, the package doesn't exist yet.

## Recommended Fix Order

1. ✅ **First**: Check organization settings (Solution 1)
2. ✅ **Second**: Create package manually (Solution 2)
3. ✅ **Third**: Use PAT if org settings can't be changed (Solution 3)
4. ✅ **Last**: Add id-token permission (Solution 4)

## After Fixing

Once fixed, the workflow should push successfully. You'll see:

```
#40 pushing layers
#40 pushing layers 0.8s done
#40 DONE
```

Instead of:

```
#40 ERROR: failed to push ghcr.io/synap-core/backend:main: denied: permission_denied: write_package
```
