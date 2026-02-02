# 🚀 Start Here: Local Development Setup

**You have `.env.development.local` configured - here's how to use it!**

---

## ✅ What You Have

- ✅ `.env.development.local` with remote server configuration
- ✅ Remote server running all services (database, Kratos, MinIO, etc.)
- ✅ Ready to develop locally

---

## 🎯 What You Want

- ✅ Run backend API locally on your machine (Quattros 2)
- ✅ Run frontend locally
- ✅ Both connect to remote server services
- ✅ Easy to update and test changes

---

## 🚀 Quick Start (3 Commands)

### 1. Start Backend API

```bash
cd synap-backend
pnpm dev:api
```

**Or use the helper script**:

```bash
cd synap-backend
./scripts/start-local-dev.sh
```

**Backend starts on**: `http://localhost:4000`

---

### 2. Configure Frontend

**Set backend URL** (choose one method):

**Method A: Environment Variable** (recommended):

```bash
cd synap-app/apps/web
echo "NEXT_PUBLIC_API_URL=http://localhost:4000" > .env.local
```

**Method B: Browser Console** (quick test):

```javascript
localStorage.setItem("synap_backend_url", "http://localhost:4000");
window.location.reload();
```

---

### 3. Start Frontend

```bash
cd synap-app
pnpm dev
```

**Frontend starts on**: `http://localhost:3000`

---

## ✅ Verify It Works

1. **Backend health**: `curl http://localhost:4000/health`
2. **Open browser**: `http://localhost:3000`
3. **Check console**: No connection errors

---

## 🎉 You're Done!

Now you can:

- ✅ Edit backend code → Auto-reloads
- ✅ Edit frontend code → Auto-reloads
- ✅ Test changes immediately
- ✅ All data from remote server

---

## 📚 More Information

- **[Quick Start Guide](./QUICK_START_LOCAL.md)** - 3-step setup
- **[Full Guide](./LOCAL_BACKEND_REMOTE_SERVICES.md)** - Complete documentation
- **[Troubleshooting](./LOCAL_BACKEND_REMOTE_SERVICES.md#-troubleshooting)** - Common issues

---

## 🔧 How It Works

**Backend**:

- Uses `.env.development.local` automatically
- Connects to remote server services
- Runs locally on your machine

**Frontend**:

- Connects to local backend (`http://localhost:4000`)
- Backend proxies to remote services
- Everything works seamlessly

---

## 🆘 Need Help?

**Backend won't start?**

- Check `.env.development.local` exists
- Verify remote server is accessible
- See [Troubleshooting Guide](./LOCAL_BACKEND_REMOTE_SERVICES.md#-troubleshooting)

**Frontend won't connect?**

- Check backend is running: `curl http://localhost:4000/health`
- Verify frontend URL: `localStorage.getItem('synap_backend_url')`
- See [Troubleshooting Guide](./LOCAL_BACKEND_REMOTE_SERVICES.md#-troubleshooting)

---

**Last Updated**: 2026-02-02
