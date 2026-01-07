# Synap Development & Deployment Guide

**Date**: 2026-01-05  
**Purpose**: Complete guide for local development, Docker deployment, and architecture scaling

---

## TL;DR - Quick Answers

**Q: What do I run for local development?**  
A: 3 commands in 3 terminals:
```bash
# Terminal 1: Backend services
cd synap-backend && docker compose --profile auth up -d && pnpm run dev

# Terminal 2: Frontend
cd synap-app/apps/web && pnpm dev

# Terminal 3 (optional): Realtime server
cd synap-backend && pnpm exec turbo run dev --filter='@synap/realtime'
```

**Q: Do I need to run client package?**  
A: **NO** - It's a published SDK library, not a service

**Q: Can I deploy with single Docker file?**  
A: Yes! See "Docker Deployment" section below

---

## Part 1: Understanding Your Architecture

### The Monorepos

You have **TWO separate monorepos**:

```
synap-backend/          ← Backend monorepo
├── apps/
│   └── api/            ← Main tRPC API server (port 4000)
├── packages/
│   ├── api/            ← tRPC routers (library)
│   ├── database/       ← Drizzle ORM + schemas
│   ├── auth/           ← Kratos integration
│   ├── client/         ← SDK for external use (published to npm)
│   ├── types/          ← Shared TypeScript types
│   ├── realtime/       ← WebSocket server (port 4001)
│   └── jobs/           ← Inngest background jobs
└── docker-compose.yml  ← Postgres, MinIO, Kratos

synap-app/              ← Frontend monorepo
├── apps/
│   └── web/            ← Next.js app (port 3000)
└── packages/
    ├── synap-hooks/    ← React hooks for frontend
    ├── ui-system/      ← Tamagui components
    └── client/         ← For using @synap-core/client
```

---

## Part 2: Local Development Workflow

### What You ACTUALLY Need Running

#### Backend Services (Port 4000)

**Run this ONCE**:
```bash
cd synap-backend

# Start Docker services (Postgres, MinIO, Kratos)
docker compose --profile auth up -d

# Start backend API + jobs + realtime
pnpm run dev
```

**This starts**:
- ✅ `apps/api` - tRPC API on `localhost:4000`
- ✅ `packages/jobs` - Inngest worker
- ✅ `packages/realtime` - WebSocket on `localhost:4001` (if turbo config includes it)
- ✅ PostgreSQL - `localhost:5432`
- ✅ MinIO - `localhost:9000` / `localhost:9001` (console)
- ✅ Kratos - `localhost:4433` (public) / `localhost:4434` (admin)

**Check services**:
```bash
# Check what's running
docker compose ps

# Kratos health
curl http://localhost:4433/health/ready

# API health  
curl http://localhost:4000/api/health

# Realtime health
curl http://localhost:4001/health
```

#### Frontend (Port 3000)

**Run in separate terminal**:
```bash
cd synap-app/apps/web

# Create .env.local if doesn't exist
cat > .env.local << 'EOF'
NEXT_PUBLIC_KRATOS_URL=http://localhost:4433
NEXT_PUBLIC_API_URL=http://localhost:4000/trpc
EOF

# Start Next.js
pnpm dev
```

**Opens**: `http://localhost:3000`

---

### What You DON'T Need to Run

❌ **`@synap-core/client`** - This is a **library package**, not a service  
❌ **`@synap-core/types`** - Library only  
❌ **`@synap/database`** - Library only  

These are dependencies used BY the services, they don't run standalone.

---

## Part 3: Complete Dev Environment Setup

### First Time Setup

```bash
# === BACKEND ===
cd synap-backend

# Install dependencies
pnpm install

# Setup environment
cp .env.example .env
# Edit .env with your settings

# Generate Drizzle client
pnpm db:generate

# Run migrations
pnpm db:migrate

# Start Docker services
docker compose --profile auth up -d

# Run dev servers
pnpm run dev

# === FRONTEND ===
cd ../synap-app

# Install dependencies  
pnpm install

# Create frontend env
cd apps/web
cat > .env.local << 'EOF'
NEXT_PUBLIC_KRATOS_URL=http://localhost:4433
NEXT_PUBLIC_API_URL=http://localhost:4000/trpc
EOF

# Start dev server
pnpm dev
```

### Daily Development Workflow

```bash
# Morning: Start everything

# Terminal 1: Backend
cd synap-backend
docker compose up -d  # Start dependencies
pnpm run dev          # Start API + jobs + realtime

# Terminal 2: Frontend
cd synap-app/apps/web
pnpm dev

# That's it! Open http://localhost:3000
```

### Troubleshooting Dev Mode

**Problem**: Backend won't start  
**Check**:
```bash
docker compose ps  # Are containers running?
pnpm run dev       # What's the error?
```

**Problem**: Frontend stuck loading  
**Check**:
1. Is Kratos running? `curl http://localhost:4433/health/ready`
2. Is .env.local correct?
3. Open browser console - any errors?

**Problem**: "Cannot find module '@synap-core/types/realtime'"  
**Fix**:
```bash
cd synap-backend
pnpm build --filter='@synap-core/types'
```

---

## Part 4: Docker Deployment (Self-Hosting)

### Single-Server Docker Compose

**File**: `deploy/docker-compose.production.yml`

```yaml
version: '3.8'

services:
  # === Database ===
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: synap
      POSTGRES_USER: synap
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    restart: always

  # === Object Storage ===
  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
    volumes:
      - minio_data:/data
    restart: always

  # === Authentication ===
  kratos:
    image: oryd/kratos:v1.0.0
    command: serve --config /etc/config/kratos/kratos.yml
    environment:
      DSN: postgres://synap:${DB_PASSWORD}@postgres:5432/synap_kratos
      SECRETS_COOKIE: ${KRATOS_SECRETS_COOKIE}
      SECRETS_CIPHER: ${KRATOS_SECRETS_CIPHER}
    volumes:
      - ./kratos:/etc/config/kratos
    depends_on:
      - postgres
    restart: always

  # === Backend API ===
  api:
    build:
      context: ../synap-backend
      dockerfile: apps/api/Dockerfile
    environment:
      DATABASE_URL: postgres://synap:${DB_PASSWORD}@postgres:5432/synap
      KRATOS_PUBLIC_URL: http://kratos:4433
      KRATOS_ADMIN_URL: http://kratos:4434
      MINIO_ENDPOINT: minio:9000
      MINIO_ACCESS_KEY: ${MINIO_ROOT_USER}
      MINIO_SECRET_KEY: ${MINIO_ROOT_PASSWORD}
    ports:
      - "4000:4000"
    depends_on:
      - postgres
      - minio
      - kratos
    restart: always

  # === Realtime Server ===
  realtime:
    build:
      context: ../synap-backend
      dockerfile: packages/realtime/Dockerfile
    environment:
      DATABASE_URL: postgres://synap:${DB_PASSWORD}@postgres:5432/synap
    ports:
      - "4001:4001"
    depends_on:
      - postgres
    restart: always

  # === Frontend ===
  web:
    build:
      context: ../synap-app
      dockerfile: apps/web/Dockerfile
      args:
        NEXT_PUBLIC_KRATOS_URL: ${PUBLIC_URL}/kratos
        NEXT_PUBLIC_API_URL: ${PUBLIC_URL}/api
    ports:
      - "3000:3000"
    restart: always

  # === Reverse Proxy ===
  nginx:
    image: nginx:alpine
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
    ports:
      - "80:80"
      - "443:443"
    depends_on:
      - web
      - api
      - kratos
    restart: always

volumes:
  postgres_data:
  minio_data:
```

### Docker Build Files

**Backend API**: `synap-backend/apps/api/Dockerfile`
```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY . .
RUN corepack enable pnpm
RUN pnpm install --frozen-lockfile
RUN pnpm build --filter='@synap/api'

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 4000
CMD ["node", "dist/apps/api/index.js"]
```

**Frontend**: `synap-app/apps/web/Dockerfile`
```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY . .
RUN corepack enable pnpm
RUN pnpm install --frozen-lockfile
ARG NEXT_PUBLIC_KRATOS_URL
ARG NEXT_PUBLIC_API_URL
RUN pnpm build --filter='web'

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/apps/web/.next ./.next
COPY --from=builder /app/apps/web/public ./public
COPY --from=builder /app/apps/web/package.json ./
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3000
CMD ["pnpm", "start"]
```

### Deploy to Server

```bash
# 1. Create environment file
cat > .env << 'EOF'
DB_PASSWORD=your-secure-password
MINIO_ROOT_USER=admin
MINIO_ROOT_PASSWORD=your-minio-password
KRATOS_SECRETS_COOKIE=32-char-random-string
KRATOS_SECRETS_CIPHER=32-char-random-string
PUBLIC_URL=https://your-domain.com
EOF

# 2. Build and start
docker compose -f deploy/docker-compose.production.yml up -d --build

# 3. Run migrations
docker compose exec api pnpm db:migrate

# 4. Check health
curl http://localhost:4000/api/health
curl http://localhost:3000
```

---

## Part 5: Future - Multi-Tenant Architecture

### Current: Single-Tenant Self-Hosted

```
User → synap.yourdomain.com → Single instance
                                ├── Postgres
                                ├── MinIO
                                └── Kratos
```

**Pros**: Simple, cheap, easy to maintain  
**Cons**: All users share resources

---

### Future Phase 1: Multi-Tenant Shared Infrastructure

```
Users → app.synap.com → Single API instance
                          ├── Tenant isolation by workspace_id
                          ├── Shared Postgres (row-level security)
                          ├── Shared MinIO (bucket per tenant)
                          └── Shared Kratos
```

**Implementation**:
```typescript
// Middleware adds tenant context
app.use(async (c, next) => {
  const workspaceId = c.req.header('X-Workspace-ID');
  c.set('workspaceId', workspaceId);
  await next();
});

// All queries filtered by workspace
const entities = await db.select()
  .from(entities)
  .where(eq(entities.workspaceId, workspaceId));
```

**Pros**: Economical, easy to scale  
**Cons**: Noisy neighbor problem, security concerns

---

### Future Phase 2: Isolated Per-Workspace Containers

```
User A → workspace-abc.synap.com → Dedicated container
          ├── API container
          ├── Realtime container
          └── Shared DB (isolated schema)

User B → workspace-xyz.synap.com → Dedicated container
          ├── API container
          ├── Realtime container
          └── Shared DB (isolated schema)
```

**Using Kubernetes**:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: workspace-${WORKSPACE_ID}
spec:
  replicas: 1
  template:
    spec:
      containers:
      - name: api
        image: synap/api:latest
        env:
        - name: WORKSPACE_ID
          value: "${WORKSPACE_ID}"
        - name: DATABASE_URL
          value: "postgres://...?schema=workspace_${WORKSPACE_ID}"
```

**Pros**: Better isolation, dedicated resources  
**Cons**: More complex, higher cost

---

### Future Phase 3: Dedicated Infrastructure (Enterprise)

```
Enterprise Client → tenant.synap.com
  ↓
Dedicated VPC (AWS/OVH)
  ├── Dedicated RDS
  ├── Dedicated S3/MinIO
  ├── Dedicated containers
  └── Optional: On-premise deployment
```

**Deployment via Terraform**:
```terraform
module "tenant_infrastructure" {
  source = "./modules/tenant"
  
  tenant_id   = "acme-corp"
  region      = "eu-west-1"
  db_instance = "db.t3.medium"
  api_replicas = 3
}
```

**Pros**: Full isolation, compliance-ready  
**Cons**: Expensive, complex management

---

## Recommendations for Your Roadmap

### Phase 1: MVP (Current)
**Goal**: Prove product-market fit  
**Architecture**: Single self-hosted Docker Compose  
**Cost**: ~$50/month (1 VPS)  
**Users**: 10-100

```bash
# Deploy to DigitalOcean droplet
ssh root@your-server
git clone your-repo
docker compose up -d
```

### Phase 2: Early Growth  
**Goal**: Onboard first paid customers  
**Architecture**: Multi-tenant shared infrastructure  
**Cost**: ~$500/month (managed Postgres, container hosting)  
**Users**: 100-1,000

**Tech stack**:
- Render.com or Railway for containers
- Managed Postgres (Supabase/Neon)
- Cloudflare R2 for storage

### Phase 3: Scale  
**Goal**: Enterprise customers  
**Architecture**: Per-workspace containers + shared DB  
**Cost**: Variable (~$50/workspace/month)  
**Users**: 1,000-10,000

**Tech stack**:
- Kubernetes (EKS/GKE)
- Aurora/Cloud SQL
- S3/CloudStorage

### Phase 4: Enterprise
**Goal**: Fortune 500 clients  
**Architecture**: Dedicated VPCs per major client  
**Cost**: $5,000+/month per enterprise  
**Users**: Unlimited

**Tech stack**:
- Terraform IaC
- Multi-region deployment
- On-premise option

---

## Part 6: Practical Next Steps

### This Week
- [x] Fix local dev environment
- [ ] Create .env.local for frontend
- [ ] Start Kratos (`docker compose --profile auth up -d`)
- [ ] Test full auth flow (registration → login → workspace)

### This Month
- [ ] Create Dockerfile for API
- [ ] Create Dockerfile for frontend
- [ ] Test Docker Compose deployment on local machine
- [ ] Deploy to staging VPS (DigitalOcean/Hetzner)

### This Quarter
- [ ] Add workspace isolation to all queries
- [ ] Implement proper multi-tenancy
- [ ] Setup monitoring (Sentry/LogRocket)
- [ ] Load testing

---

## Part 7: Quick Reference Commands

### Development

```bash
# Start everything
cd synap-backend && docker compose up -d && pnpm run dev &
cd synap-app/apps/web && pnpm dev

# Stop everything
docker compose down
pkill -f "pnpm run dev"

# Reset database
docker compose down -v
docker compose up -d
cd synap-backend && pnpm db:push
```

### Production

```bash
# Build for production
docker compose -f docker-compose.production.yml build

# Deploy
docker compose -f docker-compose.production.yml up -d

# View logs
docker compose logs -f api
docker compose logs -f web

# Backup database
docker compose exec postgres pg_dump -U synap synap > backup.sql
```

---

## Summary

**Local Dev**: 2 terminals, that's it
```
Terminal 1: cd synap-backend && docker compose up -d && pnpm run dev
Terminal 2: cd synap-app/apps/web && pnpm dev
```

**Docker Deploy**: Single docker-compose.yml with all services

**Future Scaling**:
1. Start simple (single instance)
2. Add multi-tenancy (shared DB, workspace isolation)
3. Move to containers per workspace (K8s)
4. Offer dedicated infrastructure (enterprise)

Your current architecture is **perfect for MVP**. Don't overcomplicate until you have real users demanding it!
