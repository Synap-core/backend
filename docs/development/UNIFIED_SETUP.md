# Unified Development Setup

## Overview

**Simple principle**: Frontend uses one backend URL for everything. Backend uses env vars to connect to services.

## Architecture

```
┌─────────────┐
│  Frontend   │
│ (Next.js)   │
└──────┬──────┘
       │
       │ All requests use backend URL:
       │ - tRPC: /trpc/*
       │ - Kratos: /api/kratos/*
       │ - Realtime: WebSocket
       │
       ▼
┌─────────────────────────────────────┐
│  Next.js Middleware                 │
│  - Reads backend URL from cookie    │
│  - Proxies to backend               │
└──────┬──────────────────────────────┘
       │
       ▼
┌─────────────┐
│   Backend   │
│  (Hono API) │
└──────┬──────┘
       │
       │ Uses env vars to connect:
       │ - DATABASE_URL
       │ - KRATOS_PUBLIC_URL
       │ - REDIS_URL
       │ - etc.
       │
       ▼
┌─────────────────────────────────────┐
│  Services (Docker on Server)         │
│  - PostgreSQL                        │
│  - Kratos                            │
│  - Redis                             │
│  - MinIO                             │
└─────────────────────────────────────┘
```

## Frontend Configuration

### Option 1: Environment Variable (Build-time)

Create `synap-app/apps/web/.env.local`:

```bash
NEXT_PUBLIC_API_URL=http://localhost:4000
```

### Option 2: User Configuration (Runtime)

User visits `/setup` page and enters backend URL. Stored in:

- `localStorage.synap_backend_url`
- Cookie: `SYNAP_INSTANCE_URL`

### How It Works

1. **Kratos Client** (`lib/kratos.ts`):
   - Always uses `/api/kratos` (relative URL)
   - Middleware proxies to backend

2. **tRPC Client** (`packages/synap-client`):
   - Uses backend URL from config
   - Middleware proxies to backend

3. **Realtime** (Socket.IO):
   - Uses backend URL from config
   - Direct WebSocket connection

## Backend Configuration

### Local Development (No Docker)

Create `synap-backend/.env.development.local`:

```bash
# Database (on remote server)
DATABASE_URL=postgresql://synap:password@100.124.146.57:5432/synap

# Kratos (on remote server)
KRATOS_PUBLIC_URL=http://100.124.146.57:4433
KRATOS_ADMIN_URL=http://100.124.146.57:4434

# Redis (on remote server)
REDIS_URL=redis://100.124.146.57:6379

# MinIO (on remote server)
MINIO_ENDPOINT=100.124.146.57
MINIO_PORT=9000
MINIO_USE_SSL=false

# Local API
PORT=4000
PUBLIC_URL=http://localhost:4000
FRONTEND_URL=http://localhost:3000
```

### How It Works

1. **API Server** (`apps/api/src/index.ts`):
   - Exposes Kratos at `/.ory/kratos/public/*`
   - Proxies to `KRATOS_PUBLIC_URL` from env

2. **Service Connections**:
   - All services connect via env vars
   - No hardcoded URLs

## Flow Example: Kratos Login

```
1. Frontend: kratos.toSession()
   ↓
2. Request: GET /api/kratos/sessions/whoami
   ↓
3. Middleware: Reads backend URL from cookie
   ↓
4. Proxy: GET http://localhost:4000/.ory/kratos/public/sessions/whoami
   ↓
5. Backend: Receives at /.ory/kratos/public/sessions/whoami
   ↓
6. Backend: Proxies to KRATOS_PUBLIC_URL/sessions/whoami
   ↓
7. Kratos: Returns session data
   ↓
8. Backend: Forwards response to frontend
   ↓
9. Frontend: Receives session data
```

## Setup Steps

### 1. Backend (Local API, Remote Services)

```bash
cd synap-backend

# Create .env.development.local with remote server values
# (See example above)

# Start API
pnpm dev
```

### 2. Frontend

```bash
cd synap-app

# Option A: Set env var
echo "NEXT_PUBLIC_API_URL=http://localhost:4000" > apps/web/.env.local

# Option B: Use /setup page after starting dev server
pnpm dev
# Then visit http://localhost:3000/setup
```

## Key Points

✅ **Frontend**: One backend URL for everything (simple)
✅ **Backend**: Env vars for all service connections (flexible)
✅ **No Docker locally**: Run API locally, connect to remote services
✅ **Works everywhere**: Same approach for local, staging, production

## Troubleshooting

### Frontend: "Backend URL not configured"

**Solution**: Set `NEXT_PUBLIC_API_URL` in `.env.local` or use `/setup` page

### Backend: Can't connect to Kratos

**Solution**: Check `KRATOS_PUBLIC_URL` in `.env.development.local` matches your server

### 404 on `/api/kratos/*`

**Solution**:

1. Verify backend URL is set (check cookie/localStorage)
2. Verify backend is running and exposes `/.ory/kratos/public/*`
3. Check backend logs for proxy errors
