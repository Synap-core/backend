# Local Backend + Remote Services Setup

**Run backend API locally, connect to remote server services**

---

## 🎯 Overview

This setup allows you to:

- ✅ Run backend API locally on your machine (Quattros 2)
- ✅ Run frontend locally
- ✅ Connect both to remote server services (database, Kratos, MinIO, etc.)
- ✅ Rapidly iterate on API code without Docker rebuilds
- ✅ Test changes immediately

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
│                 │         │        │         │
│  ┌───────────┐  │         │        ▼         │
│  │  Backend  │──┼─────────┼─▶  PostgreSQL   │
│  │  API      │  │         │  Kratos, Hydra  │
│  │ (Local)   │  │         │  MinIO, Redis   │
│  └───────────┘  │         │  Typesense      │
└─────────────────┘         └──────────────────┘
```

---

## 📋 Prerequisites

1. ✅ **`.env.development.local` already configured** (you mentioned this)
2. ✅ **Remote server running** with all services (database, Kratos, etc.)
3. ✅ **Network access** to your server
4. ✅ **Secrets from server** in `.env.development.local`

---

## 🚀 Quick Start

### Step 1: Verify Your `.env.development.local`

**Check that your `.env.development.local` has all remote server connections**:

```bash
cd synap-backend
cat .env.development.local | grep -E "DATABASE_URL|KRATOS|MINIO|REDIS|TYPESENSE"
```

**Should show**:

- `DATABASE_URL=postgresql://...@your-server:5432/...`
- `KRATOS_PUBLIC_URL=http://your-server:4433`
- `MINIO_ENDPOINT=http://your-server:9000`
- etc.

---

### Step 2: Start Backend API Locally

**From `synap-backend` directory**:

```bash
cd synap-backend

# Start backend API (uses .env.development.local automatically)
pnpm dev:api
```

**Or use the direct command**:

```bash
cd synap-backend
pnpm --filter api dev
```

**What this does**:

- Loads `.env.development.local` automatically
- Starts API on `http://localhost:4000` (or port from env)
- Connects to remote server services
- Hot-reloads on code changes

---

### Step 3: Configure Frontend to Use Local Backend

**The frontend needs to know to connect to your local backend**:

**Option A: Set in Browser (Temporary)**:

1. Open browser DevTools Console (F12)
2. Run:

```javascript
localStorage.setItem("synap_backend_url", "http://localhost:4000");
window.location.reload();
```

**Option B: Set Environment Variable (Persistent)**:

```bash
cd synap-app/apps/web

# Create or edit .env.local
echo "NEXT_PUBLIC_API_URL=http://localhost:4000" >> .env.local
```

**Then start frontend**:

```bash
cd synap-app
pnpm dev
```

---

### Step 4: Verify Connection

**Test backend health**:

```bash
curl http://localhost:4000/health
```

**Test from browser**:

1. Open `http://localhost:3000`
2. Check browser console for connection status
3. Try logging in

---

## 🔧 Detailed Setup

### Backend Configuration

**The backend API automatically uses `.env.development.local`**:

```typescript
// apps/api/package.json
"dev": "tsx watch --env-file=../../.env.development.local src/index.ts"
```

**Your `.env.development.local` should have**:

```bash
# Database (remote server)
DATABASE_URL=postgresql://synap:password@your-server-ip:5432/synap

# Kratos (remote server)
KRATOS_PUBLIC_URL=http://your-server-ip:4433
KRATOS_ADMIN_URL=http://your-server-ip:4434

# Hydra (remote server)
HYDRA_PUBLIC_URL=http://your-server-ip:4444
HYDRA_ADMIN_URL=http://your-server-ip:4445

# MinIO (remote server)
MINIO_ENDPOINT=http://your-server-ip:9000
MINIO_ACCESS_KEY=your-access-key
MINIO_SECRET_KEY=your-secret-key

# Redis (remote server)
REDIS_URL=redis://your-server-ip:6379

# Typesense (remote server)
TYPESENSE_HOST=your-server-ip
TYPESENSE_PORT=8108
TYPESENSE_API_KEY=your-api-key

# Inngest (if using remote)
INNGEST_EVENT_KEY=your-event-key
INNGEST_SIGNING_KEY=your-signing-key
INNGEST_BASE_URL=http://your-server-ip:8288

# Server config (local)
PORT=4000
NODE_ENV=development
```

---

### Frontend Configuration

**The frontend uses `getBackendUrl()` which checks**:

1. `localStorage.getItem('synap_backend_url')` (user configured)
2. `process.env.NEXT_PUBLIC_API_URL` (build-time default)
3. Fallback to `null`

**To set backend URL**:

**Method 1: Environment Variable** (recommended for development):

```bash
cd synap-app/apps/web
echo "NEXT_PUBLIC_API_URL=http://localhost:4000" > .env.local
```

**Method 2: Browser LocalStorage** (user preference):

```javascript
// In browser console
localStorage.setItem("synap_backend_url", "http://localhost:4000");
```

**Method 3: Setup Page**:

1. Navigate to `http://localhost:3000/setup`
2. Enter: `http://localhost:4000`
3. Click "Connect Server"

---

## 🛠️ Development Workflow

### Daily Development

**1. Start Backend**:

```bash
cd synap-backend
pnpm dev:api
```

**2. Start Frontend** (in another terminal):

```bash
cd synap-app
pnpm dev
```

**3. Make Changes**:

- Edit backend code → Auto-reloads
- Edit frontend code → Auto-reloads
- Test immediately

**4. Test Changes**:

- Open `http://localhost:3000`
- Use the app
- Check backend logs for errors

---

### Running Migrations

**If you need to run database migrations**:

```bash
cd synap-backend

# Run migrations using remote database
pnpm db:migrate
```

**This uses `.env.development.local` automatically**.

---

## 🔍 Troubleshooting

### Backend Can't Connect to Remote Services

**Problem**: Backend fails to connect to database/Kratos/etc.

**Check**:

1. Is server running? `ssh server "docker compose ps"`
2. Are ports accessible? `telnet your-server-ip 5432`
3. Are credentials correct? Compare with server `.env`

**Solution**:

- Verify `.env.development.local` has correct server IP
- Check firewall rules on server
- Test connection: `psql -h your-server-ip -U synap -d synap`

---

### Frontend Can't Connect to Local Backend

**Problem**: Frontend tries to connect to wrong URL

**Check**:

```javascript
// In browser console
console.log("Backend URL:", localStorage.getItem("synap_backend_url"));
console.log("Env URL:", process.env.NEXT_PUBLIC_API_URL);
```

**Solution**:

```javascript
// Set correct URL
localStorage.setItem("synap_backend_url", "http://localhost:4000");
window.location.reload();
```

---

### CORS Errors

**Problem**: Browser blocks requests to backend

**Check**: Backend CORS configuration allows `http://localhost:3000`

**Solution**: Backend should already allow all origins in development, but verify:

```typescript
// apps/api/src/index.ts
cors({
  origin: "*", // or specific origins
});
```

---

### Port Already in Use

**Problem**: `Error: Port 4000 already in use`

**Solution**:

```bash
# Find process using port 4000
lsof -i :4000

# Kill it
kill -9 <PID>

# Or change port in .env.development.local
PORT=4001
```

---

## 📚 Related Documentation

- **[Local Kratos Debugging](./LOCAL_KRATOS_DEBUG.md)** - Run Kratos locally for debugging
- **[Hybrid Development](./HYBRID_DEVELOPMENT.md)** - Full remote services setup
- **[Progressive Setup](./PROGRESSIVE_SETUP.md)** - Gradual migration guide
- **[Quick Start](./QUICK_START.md)** - Fast setup guide

---

## ✅ Checklist

Before starting:

- [ ] `.env.development.local` configured with remote server details
- [ ] Remote server running and accessible
- [ ] Can connect to remote database: `psql -h server -U synap -d synap`
- [ ] Backend starts: `pnpm dev:api`
- [ ] Frontend configured: `NEXT_PUBLIC_API_URL=http://localhost:4000`
- [ ] Frontend starts: `pnpm dev`
- [ ] Can access: `http://localhost:3000`

---

**Last Updated**: 2026-02-02
