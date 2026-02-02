# Development Architecture

**Understanding what runs where and why**

---

## 🏗️ Architecture Overview

### Docker Services (Infrastructure) ✅

**These run in Docker** - they're external services, not application code:

- **PostgreSQL** (port 5432) - Database
- **Redis** (port 6379) - Cache
- **MinIO** (ports 9000, 9001) - Object storage
- **Typesense** (port 8108) - Search engine
- **Kratos** (ports 4433, 4434) - Authentication
- **Hydra** (ports 4444, 4445) - OAuth2 server

**Why Docker?**

- ✅ Standard services (not our code)
- ✅ Easy to start/stop
- ✅ Consistent across environments
- ✅ No need to install locally

---

### Application Code (Dev Mode) 🚀

**These run as Node.js processes** - they're our application code:

1. **API Server** (`apps/api`) - Port 4000
   - Main tRPC API
   - HTTP endpoints
   - **Required** ✅

2. **Realtime Server** (`packages/realtime`) - Port 4001
   - WebSocket server (Socket.IO)
   - Real-time collaboration
   - Yjs sync
   - **Optional** (only if you need real-time features)

3. **Inngest Workers** (`packages/jobs`)
   - Background job processing
   - Uses `npx inngest-cli@latest dev` (separate command)
   - **Required** ✅ (for background jobs)

---

## 📦 Package Breakdown

### Libraries (No Dev Server Needed)

These are just TypeScript packages - they get built and imported:

- `@synap/core` - Utilities, config
- `@synap/database` - ORM, schemas
- `@synap/storage` - Storage abstraction
- `@synap/search` - Search abstraction
- `@synap/api` - tRPC routers
- `@synap/events` - Event system
- `@synap/auth` - Auth utilities
- `@synap/types` - TypeScript types

**They run in watch mode** for type checking, but don't need a dev server.

---

## 🎯 What to Run for Development

### Minimal Setup (API Only)

```bash
# 1. Start Docker services
./scripts/dev-local.sh

# 2. Run migrations
pnpm db:migrate

# 3. Start API
pnpm dev
```

**What runs:**

- ✅ Docker: PostgreSQL, Redis, MinIO, Typesense, Kratos, Hydra
- ✅ API: Port 4000

**What doesn't run:**

- ❌ Realtime (no WebSocket features)
- ❌ Inngest (no background jobs)

---

### Full Setup (All Features)

```bash
# 1. Start Docker services
./scripts/dev-local.sh

# 2. Run migrations
pnpm db:migrate

# 3. Start API (terminal 1)
pnpm dev

# 4. Start Realtime (terminal 2)
pnpm --filter @synap/realtime dev

# 5. Start Inngest (terminal 3)
npx inngest-cli@latest dev
```

**What runs:**

- ✅ Docker: All services
- ✅ API: Port 4000
- ✅ Realtime: Port 4001
- ✅ Inngest: Port 8288

---

## 🔄 No Duplication

**There's NO duplication between Docker and dev:**

- **Docker** = Infrastructure (databases, storage, auth)
- **Dev** = Application code (API, realtime, jobs)

They work together:

- API connects to Docker PostgreSQL
- API connects to Docker Redis
- API connects to Docker MinIO
- etc.

---

## 🚀 Optimized Dev Commands

### Current (What We Have)

```json
{
  "dev": "turbo run dev --filter=api"
}
```

**Runs:** Only API ✅

### Recommended (What We Should Have)

```json
{
  "dev": "turbo run dev --filter=api",
  "dev:all": "turbo run dev --filter=api --filter=@synap/realtime",
  "dev:api": "turbo run dev --filter=api",
  "dev:realtime": "turbo run dev --filter=@synap/realtime"
}
```

**Usage:**

- `pnpm dev` - Just API (fastest)
- `pnpm dev:all` - API + Realtime (full features)
- `pnpm dev:api` - Explicit API only
- `pnpm dev:realtime` - Explicit Realtime only

---

## 📝 Summary

**Docker Services** (Infrastructure):

- PostgreSQL, Redis, MinIO, Typesense, Kratos, Hydra
- Started once: `./scripts/dev-local.sh`
- No duplication - they're external services

**Dev Servers** (Application):

- API (required) - `pnpm dev`
- Realtime (optional) - `pnpm --filter @synap/realtime dev`
- Inngest (required) - `npx inngest-cli@latest dev` (separate)

**Libraries** (No server):

- Just TypeScript packages
- Watch mode for type checking
- No dev server needed

---

**Last Updated**: 2026-02-02
