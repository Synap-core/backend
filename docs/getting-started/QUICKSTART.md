# 🚀 Quick Start Guide

**How to run the full Synap backend in development**

---

## 📋 Prerequisites

1. **Node.js 20+** and **pnpm 8+**
2. **Docker Desktop** (for MinIO) - **Must be installed and running!**
   - Download from [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop)
   - On macOS: Open Docker Desktop app and wait for it to start
   - Verify with: `docker ps` (should not show connection errors)
3. **API Keys**:
   - Anthropic API key (for AI)
   - OpenAI API key (for embeddings)

---

## ⚡ Quick Start (3 Steps)

### Step 1: Setup Environment

```bash
# Copy example env file
cp env.local.example .env

# Edit .env and add your API keys:
# - ANTHROPIC_API_KEY=sk-ant-...
# - OPENAI_API_KEY=sk-proj-...
# - SYNAP_SECRET_TOKEN=$(openssl rand -hex 32)
```

**Note**: With the new auto-detection, you don't need to set `STORAGE_PROVIDER` - it will automatically use MinIO if R2 credentials are missing.

### Step 2: Start Services

```bash
# ⚠️ IMPORTANT: Start Docker Desktop first!
# On macOS: Open "Docker Desktop" app from Applications
# Wait until Docker Desktop shows "Docker Desktop is running" in the menu bar

# Verify Docker is running
docker ps

# Start MinIO (S3-compatible storage)
# Modern Docker Desktop uses 'docker compose' (with space)
# Legacy installations use 'docker-compose' (with hyphen)
docker compose up -d minio

# If 'docker compose' doesn't work, try:
# docker-compose up -d minio
# Or install: brew install docker-compose

# Initialize database (SQLite)
pnpm --filter database db:init
```

### Step 3: Start Backend

```bash
# This starts both API server and Inngest jobs in parallel
pnpm dev
```

**That's it!** 🎉

The `pnpm dev` command will:
- ✅ Start API server on `http://localhost:3000`
- ✅ Start Inngest dev server for background jobs
- ✅ Auto-detect MinIO as storage provider (if R2 not configured)
- ✅ Use SQLite database (if PostgreSQL not configured)

---

## 🔍 What Gets Started?

When you run `pnpm dev`, Turbo will start:

1. **API Server** (`apps/api`)
   - Hono server on port 3000
   - tRPC endpoints at `/trpc/*`
   - Health check at `/health`

2. **Inngest Dev Server** (`packages/jobs`)
   - Background job processing
   - Event handlers for async operations
   - Dev UI at `http://localhost:8288` (Inngest dashboard)

---

## 🧪 Verify It Works

```bash
# Health check
curl http://localhost:3000/health

# Should return:
# {
#   "status": "ok",
#   "mode": "single-user",
#   "auth": "static-token"
# }
```

---

## 📝 Environment Variables

### Minimal Setup (SQLite + MinIO)

```bash
# Database
DB_DIALECT=sqlite
SQLITE_DB_PATH=./data/synap.db

# Auth
SYNAP_SECRET_TOKEN=your-secret-token-here

# AI (Required)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-proj-...

# Storage (Auto-detected as MinIO if not set)
# No STORAGE_PROVIDER needed - will auto-use MinIO

# Optional
NODE_ENV=development
PORT=3000
```

### With PostgreSQL + R2

```bash
# Database
DB_DIALECT=postgres
DATABASE_URL=postgresql://user:pass@localhost:5432/synap

# Storage
STORAGE_PROVIDER=r2
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...

# Auth
BETTER_AUTH_SECRET=...
BETTER_AUTH_URL=http://localhost:3000
```

---

## 🛠️ Alternative: Start Services Separately

If you prefer to run services in separate terminals:

```bash
# Terminal 1: API Server
pnpm --filter api dev

# Terminal 2: Background Jobs
pnpm --filter jobs dev
```

---

## 🐛 Troubleshooting

> **Docker Issues?** See [DOCKER_SETUP.md](./DOCKER_SETUP.md) for detailed Docker troubleshooting.

### "R2 storage requires..." Error

**Fixed!** The system now auto-detects MinIO if R2 credentials are missing. If you still see this error:
- Make sure you're using the latest code
- Check that `STORAGE_PROVIDER` is not explicitly set to `r2` without credentials

### Docker Not Running

```bash
# Error: "Cannot connect to the Docker daemon" or "compose plugin not found"
# Solution: Start Docker Desktop app!

# On macOS:
# 1. Open "Docker Desktop" from Applications
# 2. Wait for menu bar icon to show "Docker Desktop is running"
# 3. Verify: docker ps (should work without errors)

# If Docker Desktop is not installed:
# - Download from: https://www.docker.com/products/docker-desktop
# - Or install via Homebrew: brew install --cask docker
```

### MinIO Connection Error

```bash
# First, make sure Docker Desktop is running!
docker ps  # Should work without errors

# Check MinIO is running
docker compose ps

# Restart MinIO if needed
docker compose restart minio

# Check MinIO logs
docker compose logs minio

# If 'docker compose' doesn't work:
# - Make sure Docker Desktop is running
# - Try: docker-compose (legacy, with hyphen)
# - Or install: brew install docker-compose
```

### Database Not Found

```bash
# Initialize SQLite database
pnpm --filter database db:init

# Or for PostgreSQL
./scripts/init-postgres.sh
```

### Port Already in Use

```bash
# Change port in .env
PORT=3001

# Or kill process on port 3000
lsof -ti:3000 | xargs kill
```

---

## 📚 Next Steps

- Read [ARCHITECTURE.md](./ARCHITECTURE.md) for system design
- Read [SETUP.md](./SETUP.md) for detailed setup
- Read [AI_ARCHITECTURE.md](./AI_ARCHITECTURE.md) for AI system details

---

**Happy coding!** 🚀

