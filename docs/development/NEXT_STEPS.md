# Next Steps - Development Setup

**You've configured `.env.development.remote` - here's what to do next**

---

## 🎯 Recommended Approach: Progressive Setup

**Start local, then gradually move to remote** - this makes debugging easier and validates each service independently.

---

## 📋 Step-by-Step Guide

### Phase 1: Test with Local Services First ✅

**Why**: Validate everything works locally before adding network complexity

#### 1. Start Local Services

```bash
cd synap-backend

# Start local Docker services (PostgreSQL, Kratos, etc.)
./scripts/dev-local.sh
```

**Or manually**:

```bash
docker compose -f docker-compose.local.yml up -d
```

#### 2. Create Local Environment File

```bash
# Copy example
cp .env.development.local.example .env.development.local

# Edit if needed (defaults should work)
```

#### 3. Run Migrations

```bash
# Run database migrations
pnpm db:migrate
```

#### 4. Start Inngest (Separate Terminal)

```bash
npx inngest-cli@latest dev
```

#### 5. Start API

```bash
# Start API with local services
pnpm dev:local
```

#### 6. Test

```bash
# Test health endpoint
curl http://localhost:4000/health

# Test Kratos
curl http://localhost:4433/health/ready
```

**✅ If this works, you've validated:**

- API starts correctly
- Database connection works
- Kratos works
- All local services are configured correctly

---

### Phase 2: Switch to Remote Database

**Once local works, test with remote database**

#### 1. Update Environment

**Edit `.env.development.remote`** - keep Kratos local for now:

```env
# Database: Remote
DATABASE_URL=postgresql://synap:password@your-server:5432/synap

# Kratos: Still Local
KRATOS_PUBLIC_URL=http://localhost:4433
KRATOS_ADMIN_URL=http://localhost:4434
# ... (local Kratos secrets)

# Other services: Still Local
MINIO_ENDPOINT=http://localhost:9000
REDIS_URL=redis://localhost:6379
# ... etc
```

#### 2. Test Database Connection

```bash
# Test connection
psql postgresql://synap:password@your-server:5432/synap -c "SELECT 1;"
```

#### 3. Run Migrations on Remote Database

```bash
# Run migrations on server database
dotenv -e .env.development.remote -- pnpm db:migrate
```

#### 4. Start API with Remote Database

```bash
pnpm dev:remote
```

**✅ If this works, you've validated:**

- Remote database connection
- Network connectivity
- Migrations work on remote DB

---

### Phase 3: Switch to Remote Kratos

**Once database works, test with remote Kratos**

#### 1. Update Environment

**Edit `.env.development.remote`** - now use remote Kratos:

```env
# Database: Remote (already working)
DATABASE_URL=postgresql://synap:password@your-server:5432/synap

# Kratos: Remote (NEW)
KRATOS_PUBLIC_URL=http://your-server:4433
KRATOS_ADMIN_URL=http://your-server:4434
KRATOS_SECRETS_COOKIE=your-server-secret
KRATOS_SECRETS_CIPHER=your-server-secret
KRATOS_WEBHOOK_SECRET=your-server-secret

# Other services: Still Local
MINIO_ENDPOINT=http://localhost:9000
REDIS_URL=redis://localhost:6379
```

#### 2. Test Kratos Connection

```bash
# Test Kratos health
curl http://your-server:4433/health/ready
curl http://your-server:4434/health/ready
```

#### 3. Start API

```bash
pnpm dev:remote
```

#### 4. Test Authentication

```bash
# Test registration/login flow
# Use your frontend or API directly
```

**✅ If this works, you've validated:**

- Remote Kratos connection
- Authentication flows work
- Session management

---

### Phase 4: All Remote (Optional)

**Once Kratos works, you can switch other services too**

**Edit `.env.development.remote`** - use all remote services:

```env
# All services remote
DATABASE_URL=postgresql://synap:password@your-server:5432/synap
KRATOS_PUBLIC_URL=http://your-server:4433
MINIO_ENDPOINT=http://your-server:9000
REDIS_URL=redis://your-server:6379
TYPESENSE_HOST=your-server
# ... etc
```

---

## 🔄 Quick Switch Between Configs

### Switch to Local

```bash
# Use local services
pnpm dev:local
```

### Switch to Remote

```bash
# Use remote services
pnpm dev:remote
```

---

## ✅ Validation Checklist

### Local Setup ✅

- [ ] Local services start (`docker compose -f docker-compose.local.yml up -d`)
- [ ] API starts with local config (`pnpm dev:local`)
- [ ] Can connect to local database
- [ ] Can register/login with local Kratos
- [ ] Health endpoint works

### Remote Database ✅

- [ ] Can connect to remote database
- [ ] Migrations run successfully
- [ ] API can read/write to remote database
- [ ] Local Kratos still works

### Remote Kratos ✅

- [ ] Can connect to remote Kratos
- [ ] Registration flow works
- [ ] Login flow works
- [ ] Sessions work correctly

### All Remote ✅

- [ ] All services connected
- [ ] End-to-end flow works
- [ ] Performance acceptable

---

## 🐛 Troubleshooting

### Local Services Won't Start

**Check**:

```bash
docker compose -f docker-compose.local.yml ps
docker compose -f docker-compose.local.yml logs
```

**Common issues**:

- Port conflicts (5432, 4433 already in use)
- Stop conflicting services or change ports

---

### Can't Connect to Remote Database

**Check**:

1. Is PostgreSQL port exposed? (`5432:5432` in server's docker-compose.yml)
2. Is firewall allowing connection?
3. Test manually: `psql postgresql://...`

---

### Kratos Not Working

**Local Kratos**:

- Check migrations: `docker compose -f docker-compose.local.yml logs kratos-migrate`
- Check health: `curl http://localhost:4433/health/ready`

**Remote Kratos**:

- Verify URLs are correct
- Check secrets match server
- Test connection: `curl http://server:4433/health/ready`

---

## 📚 Related Documentation

- **[Progressive Setup](./PROGRESSIVE_SETUP.md)** - Detailed progressive approach
- **[Hybrid Development](./HYBRID_DEVELOPMENT.md)** - Remote services guide
- **[Build Options](../deploy/docs/BUILD_OPTIONS.md)** - Image vs source builds

---

## 🎯 Recommended Next Action

**Start with Phase 1** (all local):

```bash
# 1. Start local services
./scripts/dev-local.sh

# 2. Run migrations
pnpm db:migrate

# 3. Start Inngest (separate terminal)
npx inngest-cli@latest dev

# 4. Start API
pnpm dev:local

# 5. Test
curl http://localhost:4000/health
```

**Once that works, move to Phase 2** (remote database), then Phase 3 (remote Kratos).

---

**Last Updated**: 2026-02-02
