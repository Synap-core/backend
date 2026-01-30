# Updating Synap Backend

## Standard Docker Compose Approach (Recommended)

The Synap backend uses **standard Docker Compose commands** for updates. The `synap-cli update` command is a convenience wrapper that adds backups and health checks, but you can always use standard commands directly.

### Quick Update (Latest)

```bash
# Standard Docker Compose way
docker compose pull backend
docker compose up -d backend
```

### Update to Specific Version

```bash
# 1. Set version in .env (Docker Compose reads this automatically)
echo "BACKEND_VERSION=v1.2.3" >> .env
# Or edit .env manually:
# BACKEND_VERSION=v1.2.3

# 2. Pull new image
docker compose pull backend

# 3. Update service
docker compose up -d backend
```

### With Migrations

```bash
# Pull and update
docker compose pull backend
docker compose up -d backend

# Run migrations (if needed)
docker compose up -d backend-migrate
```

## Using synap-cli (Convenience Wrapper)

The `synap-cli update` command wraps the standard commands with additional safety features:

```bash
# Update to latest
./synap-cli update

# Update to specific version
./synap-cli update v1.2.3
```

**What it adds:**

- ✅ Automatic backup before update
- ✅ Health checks after update
- ✅ Migration handling
- ✅ Rollback instructions

**What it does (under the hood):**

1. Updates `BACKEND_VERSION` in `.env`
2. Runs `docker compose pull backend` (standard)
3. Runs `docker compose up -d backend` (standard)
4. Runs `docker compose up -d backend-migrate` (standard)
5. Performs health check

## Why This Approach?

### ✅ Standard Docker Compose

- Uses `.env` file (standard Docker Compose feature)
- Uses `docker compose pull` (standard command)
- Uses `docker compose up -d` (standard command)
- No custom deployment mechanisms

### ✅ Version Management

- Version stored in `.env` file (standard)
- `docker-compose.yml` reads `${BACKEND_VERSION:-latest}` (standard variable substitution)
- Easy to pin versions for production

### ✅ No Source Code Required

- Server only needs `docker-compose.yml` and `.env`
- Images pulled from GitHub Container Registry
- Fast updates (pull vs rebuild)

## Comparison with Other Approaches

### ❌ Anti-pattern: Custom Update Scripts

```bash
# BAD: Custom script that modifies docker-compose.yml directly
./custom-update.sh  # Modifies YAML files, hard to track
```

### ✅ Good: Standard Docker Compose

```bash
# GOOD: Standard commands, version in .env
docker compose pull backend
docker compose up -d backend
```

### ✅ Better: Wrapper with Safety Features

```bash
# BEST: Standard commands + safety features
./synap-cli update  # Wraps standard commands, adds backups/health checks
```

## Best Practices

1. **Pin versions in production:**

   ```bash
   # In .env
   BACKEND_VERSION=v1.2.3  # Not "latest"
   ```

2. **Test updates in staging first:**

   ```bash
   # Staging
   docker compose pull backend
   docker compose up -d backend

   # Production (after testing)
   docker compose pull backend
   docker compose up -d backend
   ```

3. **Always backup before major updates:**

   ```bash
   ./synap-cli backup
   docker compose pull backend
   docker compose up -d backend
   ```

4. **Monitor after updates:**
   ```bash
   ./synap-cli health
   ./synap-cli logs backend
   ```

## Troubleshooting

### Image not found

```bash
# Check image exists
docker images | grep backend

# Check .env has correct GITHUB_REPOSITORY
grep GITHUB_REPOSITORY .env

# Login to GHCR (if private)
echo $GITHUB_TOKEN | docker login ghcr.io -u $GITHUB_USER --password-stdin
```

### Service won't start

```bash
# Check logs
docker compose logs backend

# Check health
./synap-cli health

# Rollback
./synap-cli update <previous-version>
```

## Summary

**Standard approach:**

- ✅ `docker compose pull` + `docker compose up -d`
- ✅ Version in `.env` file
- ✅ No custom mechanisms

**Our implementation:**

- ✅ Uses standard Docker Compose commands
- ✅ `synap-cli` is a convenience wrapper (not required)
- ✅ Adds safety features (backups, health checks)
- ✅ Follows Docker Compose best practices
