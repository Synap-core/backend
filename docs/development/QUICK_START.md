# Quick Start - Development Setup

**Get up and running in 5 minutes**

---

## 🚀 Fastest Path: Start Local First

**Recommended**: Test everything locally first, then gradually move to remote services.

---

## Step 1: Start Local Services

```bash
cd synap-backend

# Start all local services (PostgreSQL, Kratos, Redis, MinIO, Typesense)
./scripts/dev-local.sh
```

**Or manually**:

```bash
docker compose -f docker-compose.local.yml up -d
```

**Wait for services** (30 seconds):

```bash
docker compose -f docker-compose.local.yml ps
```

---

## Step 2: Setup Local Environment

```bash
# Copy local environment template
cp .env.development.local.example .env.development.local

# Defaults should work, but review if needed
```

---

## Step 3: Run Migrations

```bash
# Run database migrations
pnpm db:migrate
```

---

## Step 4: Start Inngest (Separate Terminal)

```bash
# In a new terminal
npx inngest-cli@latest dev
```

**Keep this running** - Inngest handles background jobs.

---

## Step 5: Start API

```bash
# In main terminal
pnpm dev:local
```

**API will start on**: `http://localhost:4000`

---

## Step 6: Test

```bash
# Test health
curl http://localhost:4000/health

# Test Kratos
curl http://localhost:4433/health/ready
```

**✅ If this works, you're ready to develop!**

---

## 🔄 Next: Switch to Remote Services

Once local setup works, you can gradually switch to remote services:

### Option A: Remote Database Only

**Edit `.env.development.remote`**:

```env
# Database: Remote
DATABASE_URL=postgresql://synap:password@your-server:5432/synap

# Everything else: Local
KRATOS_PUBLIC_URL=http://localhost:4433
MINIO_ENDPOINT=http://localhost:9000
# ... etc
```

**Start API**:

```bash
pnpm dev:remote
```

---

### Option B: Remote Database + Kratos

**Edit `.env.development.remote`**:

```env
# Database: Remote
DATABASE_URL=postgresql://synap:password@your-server:5432/synap

# Kratos: Remote
KRATOS_PUBLIC_URL=http://your-server:4433
KRATOS_ADMIN_URL=http://your-server:4434
# ... (get secrets from server)

# Everything else: Local
MINIO_ENDPOINT=http://localhost:9000
# ... etc
```

**Start API**:

```bash
pnpm dev:remote
```

---

### Option C: All Remote

**Use your existing `.env.development.remote`** (all services remote):

```bash
pnpm dev:remote
```

---

## 📊 Service Status

**Check what's running**:

```bash
# Local services
docker compose -f docker-compose.local.yml ps

# Or check individual services
docker ps | grep synap
```

---

## 🐛 Common Issues

### Port Already in Use

**Problem**: Port 5432, 4433, etc. already in use

**Solution**:

```bash
# Find what's using the port
lsof -i :5432

# Stop conflicting service or change ports in docker-compose.local.yml
```

---

### Kratos Not Starting

**Check**:

```bash
docker compose -f docker-compose.local.yml logs kratos
docker compose -f docker-compose.local.yml logs kratos-migrate
```

**Common fix**: Kratos needs migrations first:

```bash
docker compose -f docker-compose.local.yml run --rm kratos-migrate
```

---

### Can't Connect to Remote Database

**Test connection**:

```bash
psql postgresql://synap:password@your-server:5432/synap -c "SELECT 1;"
```

**If fails**:

1. Check firewall on server
2. Verify port is exposed (`5432:5432` in docker-compose.yml)
3. Check credentials

---

## 📚 More Help

- **[Next Steps](./NEXT_STEPS.md)** - Detailed step-by-step guide
- **[Progressive Setup](./PROGRESSIVE_SETUP.md)** - Gradual migration strategy
- **[Hybrid Development](./HYBRID_DEVELOPMENT.md)** - Remote services guide

---

## ✅ Success Checklist

- [ ] Local services running
- [ ] Migrations completed
- [ ] API starts successfully
- [ ] Health endpoint responds
- [ ] Can connect to database (local or remote)
- [ ] Can use Kratos (local or remote)

---

**Last Updated**: 2026-02-02
