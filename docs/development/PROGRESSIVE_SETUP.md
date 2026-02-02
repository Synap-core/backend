# Progressive Development Setup

**Start local, then gradually move to remote services**

---

## 🎯 Strategy

**Progressive approach**: Start with all services local, then gradually switch to remote services as you validate each one.

**Why**:

- ✅ Easier debugging (everything local)
- ✅ Validate each service independently
- ✅ Isolate issues (know which service has problems)
- ✅ Faster iteration (no network latency)

---

## 📋 Setup Phases

### Phase 1: All Local (Start Here)

**Goal**: Get everything working locally first

**Services**:

- ✅ Local API (your machine)
- ✅ Local PostgreSQL (Docker)
- ✅ Local Kratos (Docker)
- ✅ Local Redis (Docker)
- ✅ Local MinIO (Docker)
- ✅ Local Typesense (Docker)
- ✅ Local Inngest (your machine)

**Benefits**:

- Fast iteration
- Easy debugging
- No network issues
- Full control

---

### Phase 2: Database Remote

**Goal**: Connect to server database, keep everything else local

**Services**:

- ✅ Local API
- ✅ **Remote PostgreSQL** (server)
- ✅ Local Kratos
- ✅ Local Redis
- ✅ Local MinIO
- ✅ Local Typesense
- ✅ Local Inngest

**Why start here**:

- Database is most critical
- Easy to test (just connection string)
- Validates network connectivity

---

### Phase 3: Auth Remote

**Goal**: Connect to server Kratos/Hydra, keep other services local

**Services**:

- ✅ Local API
- ✅ Remote PostgreSQL
- ✅ **Remote Kratos/Hydra** (server)
- ✅ Local Redis
- ✅ Local MinIO
- ✅ Local Typesense
- ✅ Local Inngest

**Why next**:

- Auth is complex, good to validate early
- Can test login/registration flows
- Validates Kratos configuration

---

### Phase 4: All Remote (Final)

**Goal**: Connect to all server services

**Services**:

- ✅ Local API
- ✅ Remote PostgreSQL
- ✅ Remote Kratos/Hydra
- ✅ Remote Redis
- ✅ Remote MinIO
- ✅ Remote Typesense
- ✅ Remote Inngest (optional)

**Why last**:

- Most complex setup
- All network dependencies
- Production-like environment

---

## 🚀 Quick Start Guide

### Step 1: Setup Local Services

**Create local Docker Compose** (`docker-compose.local.yml`):

```yaml
version: "3.8"

services:
  postgres:
    image: timescale/timescaledb-ha:pg15
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: synap
      POSTGRES_PASSWORD: synap_dev_password
      POSTGRES_DB: synap
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  minio:
    image: minio/minio:latest
    ports:
      - "9000:9000"
      - "9001:9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    command: server /data --console-address ":9001"

  typesense:
    image: typesense/typesense:0.25.2
    ports:
      - "8108:8108"
    command: "--data-dir /data --api-key=xyz --enable-cors"

  kratos:
    image: oryd/kratos:v1.3.1
    ports:
      - "4433:4433"
      - "4434:4434"
    environment:
      DSN: postgres://synap:synap_dev_password@postgres:5432/kratos?sslmode=disable
      SECRETS_COOKIE: dev-cookie-secret-32-chars-long!!
      SECRETS_CIPHER: dev-cipher-secret-32-chars-long!!
    volumes:
      - ../kratos:/etc/config/kratos

  hydra:
    image: oryd/hydra:v2.3.0
    ports:
      - "4444:4444"
      - "4445:4445"
    environment:
      DSN: postgres://synap:synap_dev_password@postgres:5432/hydra?sslmode=disable
      SECRETS_SYSTEM: dev-hydra-secret-32-chars-long!!

volumes:
  postgres_data:
```

**Start local services**:

```bash
cd synap-backend
docker compose -f docker-compose.local.yml up -d
```

---

### Step 2: Create Local Environment File

**Create `.env.development.local`**:

```env
# Local Development - All Services Local
NODE_ENV=development
PORT=4000

# Database (Local)
DATABASE_URL=postgresql://synap:synap_dev_password@localhost:5432/synap

# Kratos (Local)
KRATOS_PUBLIC_URL=http://localhost:4433
KRATOS_ADMIN_URL=http://localhost:4434
KRATOS_SECRETS_COOKIE=dev-cookie-secret-32-chars-long!!
KRATOS_SECRETS_CIPHER=dev-cipher-secret-32-chars-long!!
KRATOS_WEBHOOK_SECRET=dev-webhook-secret

# Hydra (Local)
HYDRA_PUBLIC_URL=http://localhost:4444
HYDRA_ADMIN_URL=http://localhost:4445
ORY_HYDRA_SECRETS_SYSTEM=dev-hydra-secret-32-chars-long!!

# Storage (Local)
STORAGE_PROVIDER=minio
MINIO_ENDPOINT=http://localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=synap-storage
MINIO_USE_SSL=false

# Redis (Local)
REDIS_URL=redis://localhost:6379

# Typesense (Local)
TYPESENSE_HOST=localhost
TYPESENSE_PORT=8108
TYPESENSE_PROTOCOL=http
TYPESENSE_API_KEY=xyz
TYPESENSE_ADMIN_API_KEY=xyz

# Inngest (Local)
INNGEST_DEV=true
INNGEST_BASE_URL=http://localhost:8288

# JWT
JWT_SECRET=dev-jwt-secret-change-in-production
```

---

### Step 3: Test Local Setup

**Start Inngest** (separate terminal):

```bash
npx inngest-cli@latest dev
```

**Start API**:

```bash
cd synap-backend
dotenv -e .env.development.local -- pnpm --filter api dev
```

**Test**:

```bash
curl http://localhost:4000/health
```

---

### Step 4: Migrate Database

**Run migrations**:

```bash
cd synap-backend
pnpm db:migrate
```

**Initialize Kratos**:

```bash
# Kratos migrations run automatically via docker-compose
# Check logs: docker compose -f docker-compose.local.yml logs kratos
```

---

## 🔄 Switching Between Configurations

### Script: Switch Config

**Create `scripts/switch-dev-config.sh`**:

```bash
#!/bin/bash
# Switch between local and remote development configs

CONFIG=$1

if [ "$CONFIG" = "local" ]; then
    echo "Switching to local configuration..."
    cp .env.development.local .env.development
    echo "✅ Using local services"
elif [ "$CONFIG" = "remote" ]; then
    echo "Switching to remote configuration..."
    cp .env.development.remote .env.development
    echo "✅ Using remote services"
else
    echo "Usage: ./scripts/switch-dev-config.sh [local|remote]"
    exit 1
fi
```

---

## 📝 Progressive Migration Checklist

### Phase 1: All Local ✅

- [ ] Local Docker Compose running
- [ ] `.env.development.local` configured
- [ ] API starts successfully
- [ ] Can connect to local database
- [ ] Can register/login with local Kratos
- [ ] Can upload files to local MinIO
- [ ] Can search with local Typesense

---

### Phase 2: Database Remote

- [ ] Update `.env.development.remote` with server database
- [ ] Test database connection
- [ ] Run migrations on server database
- [ ] Verify API can read/write to remote database
- [ ] Keep other services local

---

### Phase 3: Auth Remote

- [ ] Update `.env.development.remote` with server Kratos URLs
- [ ] Get Kratos secrets from server
- [ ] Test login flow with remote Kratos
- [ ] Test registration flow
- [ ] Verify sessions work
- [ ] Keep other services local

---

### Phase 4: All Remote

- [ ] Update all connection strings in `.env.development.remote`
- [ ] Test all services
- [ ] Verify end-to-end flow
- [ ] Performance check (network latency)

---

## 🐛 Troubleshooting

### Local Services Not Starting

**Check**:

```bash
docker compose -f docker-compose.local.yml ps
docker compose -f docker-compose.local.yml logs
```

**Common issues**:

- Port conflicts (5432, 4433, etc. already in use)
- Volume permissions
- Missing environment variables

---

### Can't Connect to Remote Database

**Check**:

1. Is PostgreSQL port exposed? (`5432:5432` in docker-compose.yml)
2. Is firewall allowing connection?
3. Are credentials correct?
4. Can you connect manually? `psql postgresql://...`

---

### Kratos Not Working

**Local Kratos**:

- Check migrations ran: `docker compose logs kratos-migrate`
- Check Kratos is running: `docker compose ps kratos`
- Check health: `curl http://localhost:4433/health/ready`

**Remote Kratos**:

- Verify URLs are correct
- Check secrets match server
- Test connection: `curl http://server:4433/health/ready`

---

## 📚 Next Steps

1. **Start with Phase 1** (all local)
2. **Validate everything works**
3. **Move to Phase 2** (database remote)
4. **Test thoroughly**
5. **Move to Phase 3** (auth remote)
6. **Final validation**
7. **Move to Phase 4** (all remote)

---

**Last Updated**: 2026-02-02
