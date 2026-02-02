# Quick Start: Local Backend + Remote Services

**Get up and running in 3 steps**

---

## ✅ Prerequisites

You already have:

- ✅ `.env.development.local` configured with remote server details
- ✅ Remote server running with all services

---

## 🚀 3-Step Setup

### Step 1: Start Backend API

```bash
cd synap-backend

# Option A: Use helper script (recommended)
./scripts/start-local-dev.sh

# Option B: Direct command
pnpm dev:api
```

**Backend will start on**: `http://localhost:4000`

---

### Step 2: Configure Frontend

**Set backend URL** (choose one):

**Option A: Environment Variable** (recommended):

```bash
cd synap-app/apps/web
echo "NEXT_PUBLIC_API_URL=http://localhost:4000" > .env.local
```

**Option B: Browser Console**:

```javascript
localStorage.setItem("synap_backend_url", "http://localhost:4000");
window.location.reload();
```

---

### Step 3: Start Frontend

```bash
cd synap-app
pnpm dev
```

**Frontend will start on**: `http://localhost:3000`

---

## ✅ Verify It Works

1. **Check backend**: `curl http://localhost:4000/health`
2. **Open frontend**: `http://localhost:3000`
3. **Check console**: No connection errors

---

## 🎉 You're Done!

Now you can:

- ✅ Edit backend code → Auto-reloads
- ✅ Edit frontend code → Auto-reloads
- ✅ Test changes immediately
- ✅ All data comes from remote server

---

## 📚 Next Steps

- **[Full Guide](./LOCAL_BACKEND_REMOTE_SERVICES.md)** - Detailed documentation
- **[Troubleshooting](./LOCAL_BACKEND_REMOTE_SERVICES.md#-troubleshooting)** - Common issues

---

**Last Updated**: 2026-02-02
