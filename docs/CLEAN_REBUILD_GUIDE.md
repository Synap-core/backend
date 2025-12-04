# Clean System Rebuild Guide

This guide provides instructions for completely rebuilding the Synap backend system from scratch, useful for:
- Verifying everything works with clean state
- Resolving Docker corruption issues
- Testing new environment variable setup
- Onboarding new developers

---

## Prerequisites

1. **Backup Important Data** (if any)
   ```bash
   # Backup PostgreSQL data (optional)
   docker compose exec postgres pg_dump -U postgres synap > backup.sql
   ```

2. **Ensure .env File Exists**
   ```bash
   # Create from template if missing
   if [ ! -f .env ]; then
     cp .env.example .env
     echo "⚠️  Edit .env and add your OPENAI_API_KEY"
   fi
   ```

---

## Step 1: Clean Docker Environment

### Remove All Containers and Images

```bash
# Stop all containers
docker compose down

# Remove containers, networks, volumes, and images
docker compose down --volumes --rmi all

# Verify cleanup
docker ps -a  # Should be empty for synap containers
docker images | grep synap  # Should be empty

# Optional: Clean Docker system (removes ALL unused data)
docker system prune -a --volumes
```

### Clean Docker Desktop (macOS)

If you encounter persistent issues:

```bash
# Reset Docker Desktop
# 1. Open Docker Desktop
# 2. Settings → Troubleshoot → Clean / Purge data
# 3. Restart Docker Desktop
```

---

## Step 2: Clean Node Modules and Build Artifacts

```bash
# Remove all node_modules
find . -name "node_modules" -type d -prune -exec rm -rf '{}' +

# Remove all dist folders
find . -name "dist" -type d -prune -exec rm -rf '{}' +

# Remove pnpm lock (optional - only if you want fresh install)
rm pnpm-lock.yaml

# Clean pnpm store (optional)
pnpm store prune
```

---

## Step 3: Fresh Install

```bash
# Install dependencies
pnpm install

# Verify installation
pnpm run build
```

**Expected:** All packages should build with 0 errors

---

## Step 4: Start Docker Services

```bash
# Start all services
docker compose up -d

# Check status
docker compose ps

# Expected output:
# NAME                STATUS
# synap-postgres      Up (healthy)
# synap-redis         Up
# synap-minio         Up
# kratos              Up
# hydra               Up
```

### Verify Services

```bash
# PostgreSQL
docker compose exec postgres psql -U postgres -c "SELECT version();"

# Redis
docker compose exec redis redis-cli ping  # Should return: PONG

# MinIO (web UI)
open http://localhost:9001  # Login: minioadmin / minioadmin
```

---

## Step 5: Database Setup

```bash
# Run migrations
pnpm db:migrate

# Verify extensions
docker compose exec postgres psql -U postgres synap -c "\\dx"
```

**Expected extensions:**
- `pgvector` - Vector similarity search
- `timescaledb` - Time-series data
- `uuid-ossp` - UUID generation

---

## Step 6: Build All Packages

```bash
# Build all packages
pnpm run build

# Expected: 0 TypeScript errors
```

**Verify each package:**
```bash
packages/
├── database ✅ dist/ created
├── domain   ✅ dist/ created
├── api      ✅ dist/ created
├── client   ✅ dist/ created
└── jobs     ✅ dist/ created
```

---

## Step 7: Run Tests

```bash
# All tests (uses .env.test automatically)
pnpm test

# Specific packages
pnpm --filter @synap/database test
pnpm --filter @synap/client test

# With coverage
pnpm test:coverage
```

**Expected Results:**
- Database tests: 9/9 passing
- Domain tests: All passing
- Client tests: All passing
- Overall: 77+ tests passing

---

## Step 8: Start Development Server

```bash
# Start all services
pnpm dev
```

**Verify endpoints:**

```bash
# Health check
curl http://localhost:3000/health

# API metrics
curl http://localhost:3000/api/trpc/health.metrics

# Admin UI
open http://localhost:5180
```

---

## Step 9: Verification Checklist

### Database
- [ ] PostgreSQL container healthy
- [ ] Extensions installed (pgvector, timescaledb)
- [ ] Migrations applied successfully
- [ ] Can query tables

### API
- [ ] Server starts on port 3000
- [ ] Health endpoint returns 200
- [ ] tRPC routes accessible
- [ ] Authentication working

### Tests
- [ ] Database tests passing (9/9)
- [ ] All package tests passing
- [ ] No environment variable errors

### Admin UI
- [ ] Starts on port 5180
- [ ] Can access dashboard
- [ ] Architecture visualizer works

---

## Troubleshooting

### Issue: PostgreSQL Won't Start

```bash
# Check logs
docker compose logs postgres

# Common fixes:
# 1. Port already in use
lsof -i :5432
kill -9 <PID>

# 2. Data corruption
docker volume rm synap-backend_postgres_data
docker compose up -d postgres
```

### Issue: "DATABASE_URL is required"

```bash
# Ensure .env file exists
ls -la .env

# Check it has DATABASE_URL
grep DATABASE_URL .env

# If missing, copy from template
cp .env.example .env
```

### Issue: Tests Fail with Connection Errors

```bash
# Verify PostgreSQL is accessible
psql postgresql://postgres:postgres@localhost:5432/synap -c "SELECT 1"

# Check .env.test
cat .env.test | grep DATABASE_URL
```

### Issue: Docker Overlay2 Errors (macOS)

```bash
# Recreate containers
docker compose down
docker compose up -d

# Or full reset
docker compose down --volumes
docker system prune -a --volumes
docker compose up -d
```

### Issue: Port Conflicts

```bash
# Check what's using the port
lsof -i :3000  # API
lsof -i :5432  # PostgreSQL
lsof -i :6379  # Redis
lsof -i :9000  # MinIO

# Kill process
kill -9 <PID>
```

---

## Quick Reference Commands

```bash
# Complete reset (nuclear option)
docker compose down --volumes --rmi all
find . -name "node_modules" -type d -prune -exec rm -rf '{}' +
find . -name "dist" -type d -prune -exec rm -rf '{}' +
pnpm install
docker compose up -d
pnpm db:migrate
pnpm run build
pnpm test
pnpm dev

# Soft reset (keep images)
docker compose down
docker compose up -d
pnpm dev

# Test-only reset
docker compose restart postgres
pnpm test
```

---

## Post-Rebuild Validation

Run this script to validate everything:

```bash
#!/bin/bash
set -e

echo "🔍 Validating System..."

# 1. Docker
echo "✓ Checking Docker..."
docker compose ps | grep -E "Up|healthy" || exit 1

# 2. Build
echo "✓ Building packages..."
pnpm run build || exit 1

# 3. Tests
echo "✓ Running tests..."
pnpm test || exit 1

# 4. API
echo "✓ Testing API..."
curl -f http://localhost:3000/health || exit 1

# 5. Database
echo "✓ Testing database..."
docker compose exec -T postgres psql -U postgres synap -c "SELECT 1" || exit 1

echo "✅ All systems operational!"
```

Save as `scripts/validate-system.sh` and run:
```bash
chmod +x scripts/validate-system.sh
./scripts/validate-system.sh
```

---

## Summary

**Total Time:** ~10-15 minutes

**Steps:**
1. ✅ Clean Docker (2 min)
2. ✅ Clean node_modules (3 min)
3. ✅ Install dependencies (3 min)
4. ✅ Start services (2 min)
5. ✅ Run migrations (1 min)
6. ✅ Build packages (2 min)
7. ✅ Run tests (2 min)
8. ✅ Start dev server (instant)

**Result:** Clean, verified system ready for development

---

## Next Steps After Rebuild

1. **Update error_resolution_report.md**
   - Mark any issues found during rebuild
   - Document new learnings

2. **Run Full Test Suite**
   - Verify 100% tests passing
   - Check coverage metrics

3. **Continue Development**
   - System is clean and ready
   - All best practices applied
