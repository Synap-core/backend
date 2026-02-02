# Local Kratos + Remote Services Setup

**Run Kratos locally for debugging, keep other services remote**

---

## 🎯 Overview

This setup allows you to:

- ✅ Run **Kratos locally** (for debugging auth flows)
- ✅ Run **backend API locally**
- ✅ Keep **other services remote** (database, MinIO, Redis, etc.)
- ✅ Debug authentication issues easily

**Architecture**:

```
┌─────────────────┐         ┌──────────────────┐
│  Your Machine   │         │   Remote Server  │
│  (Quattros 2)   │         │                  │
│                 │         │                  │
│  ┌───────────┐  │         │  ┌────────────┐  │
│  │ Frontend  │──┼─────────┼─▶│  Backend   │  │
│  │ (Next.js) │  │         │  │  (Docker)  │  │
│  └───────────┘  │         │  └────────────┘  │
│       │          │         │        │         │
│       ▼          │         │        ▼         │
│  ┌───────────┐  │         │  PostgreSQL     │
│  │  Kratos   │  │         │  MinIO, Redis   │
│  │  (Local)  │  │         │  Typesense      │
│  └───────────┘  │         └──────────────────┘
│       │          │
│       ▼          │
│  ┌───────────┐  │
│  │  Backend  │──┼─────────┼─▶  PostgreSQL   │
│  │  API      │  │         │  (Remote)        │
│  │ (Local)   │  │         │                  │
│  └───────────┘  │         │                  │
└─────────────────┘         └──────────────────┘
```

---

## 🚀 Quick Start

### Step 1: Start Local Kratos

**Start only Kratos (and its dependencies)**:

```bash
cd synap-backend

# Start Kratos + PostgreSQL (for Kratos database)
docker compose -f docker-compose.local.yml up -d kratos kratos-migrate postgres
```

**Note**: This starts a local PostgreSQL for Kratos. Your backend will still use the remote database.

---

### Step 2: Update `.env.development.local`

**Edit your `.env.development.local`** to use local Kratos:

```bash
# Database: Remote (your server)
DATABASE_URL=postgresql://synap:password@your-server-ip:5432/synap

# Kratos: Local (for debugging)
KRATOS_PUBLIC_URL=http://localhost:4433
KRATOS_ADMIN_URL=http://localhost:4434
KRATOS_SECRETS_COOKIE=dev-cookie-secret-32-chars-long!!
KRATOS_SECRETS_CIPHER=dev-cipher-secret-32-chars-long!!

# Hydra: Local (if needed for OAuth debugging)
HYDRA_PUBLIC_URL=http://localhost:4444
HYDRA_ADMIN_URL=http://localhost:4445
ORY_HYDRA_SECRETS_SYSTEM=dev-hydra-secret-32-chars-long!!

# Other services: Remote (your server)
MINIO_ENDPOINT=http://your-server-ip:9000
REDIS_URL=redis://your-server-ip:6379
TYPESENSE_HOST=your-server-ip
TYPESENSE_PORT=8108

# Local API
PORT=4000
NODE_ENV=development
```

---

### Step 3: Start Backend API

```bash
cd synap-backend
pnpm dev:api
```

**Backend will**:

- Connect to **local Kratos** (for auth)
- Connect to **remote database** (for data)
- Connect to **remote services** (MinIO, Redis, etc.)

---

### Step 4: Verify Kratos is Running

```bash
# Check Kratos health
curl http://localhost:4433/health/ready

# Check Kratos admin
curl http://localhost:4434/health/ready
```

---

## 🔍 Debugging Kratos

### View Kratos Logs

```bash
# View Kratos logs
docker logs synap-kratos-local -f

# View Kratos migration logs
docker logs synap-kratos-migrate-local
```

### Access Kratos Admin UI

**Kratos Admin API** (for debugging):

- URL: `http://localhost:4434`
- Use for: Creating identities, checking sessions, etc.

**Example**:

```bash
# List all identities
curl http://localhost:4434/admin/identities

# Get identity by ID
curl http://localhost:4434/admin/identities/{id}
```

### Test Authentication Flow

1. **Start frontend**:

   ```bash
   cd synap-app
   pnpm dev
   ```

2. **Open browser**: `http://localhost:3000`

3. **Try login/registration** - Kratos logs will show the flow

4. **Check logs**:
   ```bash
   docker logs synap-kratos-local -f
   ```

---

## 🛠️ Advanced: Kratos + Hydra Locally

**If you need to debug OAuth flows too**:

```bash
# Start Kratos + Hydra + PostgreSQL
docker compose -f docker-compose.local.yml up -d kratos kratos-migrate hydra hydra-migrate postgres
```

**Update `.env.development.local`**:

```bash
# Kratos: Local
KRATOS_PUBLIC_URL=http://localhost:4433
KRATOS_ADMIN_URL=http://localhost:4434

# Hydra: Local
HYDRA_PUBLIC_URL=http://localhost:4444
HYDRA_ADMIN_URL=http://localhost:4445
ORY_HYDRA_SECRETS_SYSTEM=dev-hydra-secret-32-chars-long!!
```

---

## 📊 Service Status

**Check what's running**:

```bash
# Local services
docker compose -f docker-compose.local.yml ps

# Should show:
# - synap-postgres-local (for Kratos)
# - synap-kratos-local
# - synap-hydra-local (if started)
```

---

## 🔄 Switching Between Local and Remote Kratos

### Use Local Kratos (Current Setup)

```bash
# .env.development.local
KRATOS_PUBLIC_URL=http://localhost:4433
KRATOS_ADMIN_URL=http://localhost:4434
```

### Switch to Remote Kratos

```bash
# .env.development.local
KRATOS_PUBLIC_URL=http://your-server-ip:4433
KRATOS_ADMIN_URL=http://your-server-ip:4434
# ... (use remote secrets)
```

**No need to restart Docker** - just update env and restart backend API.

---

## 🐛 Troubleshooting

### Kratos Won't Start

**Problem**: `kratos-migrate` fails

**Check**:

```bash
docker logs synap-kratos-migrate-local
```

**Solution**:

- Ensure PostgreSQL is running: `docker compose -f docker-compose.local.yml ps postgres`
- Check database exists: `docker exec synap-postgres-local psql -U synap -l`

---

### Kratos Can't Connect to Database

**Problem**: `DSN connection failed`

**Check**:

```bash
docker logs synap-kratos-local
```

**Solution**:

- Verify PostgreSQL is healthy: `docker compose -f docker-compose.local.yml ps postgres`
- Check DSN in docker-compose.local.yml matches PostgreSQL config

---

### Backend Can't Connect to Local Kratos

**Problem**: Backend fails to reach `http://localhost:4433`

**Check**:

```bash
# Is Kratos running?
curl http://localhost:4433/health/ready

# Check backend logs
# (should show Kratos connection attempts)
```

**Solution**:

- Ensure Kratos is running: `docker compose -f docker-compose.local.yml ps kratos`
- Verify `.env.development.local` has correct URLs
- Check for port conflicts: `lsof -i :4433`

---

### Kratos Database Conflicts

**Problem**: Kratos uses remote database, but you want local

**Solution**:

- Local Kratos uses its own PostgreSQL (separate from your backend database)
- Backend database can be remote
- They don't conflict - different databases

---

## 📚 Related Documentation

- **[Local Backend + Remote Services](./LOCAL_BACKEND_REMOTE_SERVICES.md)** - Full setup guide
- **[Progressive Setup](./PROGRESSIVE_SETUP.md)** - Gradual migration guide
- **[Hybrid Development](./HYBRID_DEVELOPMENT.md)** - All remote services

---

## ✅ Checklist

Before starting:

- [ ] Kratos started: `docker compose -f docker-compose.local.yml up -d kratos`
- [ ] Kratos healthy: `curl http://localhost:4433/health/ready`
- [ ] `.env.development.local` updated with local Kratos URLs
- [ ] Backend starts: `pnpm dev:api`
- [ ] Frontend configured: `NEXT_PUBLIC_API_URL=http://localhost:4000`
- [ ] Can access: `http://localhost:3000`

---

**Last Updated**: 2026-02-02
