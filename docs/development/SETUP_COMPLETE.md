# Development Setup - Complete Guide

**Everything you need to know about local and hybrid development**

---

## 🎯 Quick Answer: What's Next?

You've configured `.env.development.remote` - **great!** Now:

### Recommended: Start with Local Services First

**Why**: Validate everything works locally before adding network complexity.

```bash
# 1. Setup local environment (auto-generates everything)
./scripts/setup-dev-local.sh

# 2. Start local services
./scripts/dev-local.sh

# 3. Run migrations
pnpm db:migrate

# 4. Start Inngest (separate terminal)
npx inngest-cli@latest dev

# 5. Start API
pnpm dev:local
```

**✅ Once this works, you know your setup is correct!**

---

## 🔄 Then: Progressive Migration to Remote

### Phase 1: Remote Database Only

**Edit `.env.development.remote`** - keep Kratos local:

```env
# Database: Remote
DATABASE_URL=postgresql://synap:password@your-server:5432/synap

# Kratos: Local (for now)
KRATOS_PUBLIC_URL=http://localhost:4433
KRATOS_ADMIN_URL=http://localhost:4434
# ... (local secrets)

# Other services: Local
MINIO_ENDPOINT=http://localhost:9000
```

**Start API**:

```bash
pnpm dev:remote
```

---

### Phase 2: Remote Database + Kratos

**Edit `.env.development.remote`** - now use remote Kratos:

```env
# Database: Remote (already working)
DATABASE_URL=postgresql://synap:password@your-server:5432/synap

# Kratos: Remote (NEW)
KRATOS_PUBLIC_URL=http://your-server:4433
KRATOS_ADMIN_URL=http://your-server:4434
KRATOS_SECRETS_COOKIE=your-server-secret
# ... (get from server)

# Other services: Still Local
MINIO_ENDPOINT=http://localhost:9000
```

**Start API**:

```bash
pnpm dev:remote
```

---

### Phase 3: All Remote (Optional)

**Use your existing `.env.development.remote`** (all services remote):

```bash
pnpm dev:remote
```

---

## 🛠️ Setup Scripts

### `setup-dev-local.sh` - Smart Setup

**What it does**:

- ✅ Auto-generates all secrets (like `install.sh`)
- ✅ Uses existing `.env.development.local` if present
- ✅ Preserves existing values
- ✅ No prompts needed (everything auto-generated)

**Usage**:

```bash
./scripts/setup-dev-local.sh
```

**Behavior**:

- If `.env.development.local` exists → Uses it (no changes)
- If missing → Creates it with auto-generated secrets
- If you want to update → Run script, choose "y" to update

---

### `dev-local.sh` - Start Local Services

**What it does**:

- Starts all local Docker services
- Auto-runs `setup-dev-local.sh` if needed
- Shows service status

**Usage**:

```bash
./scripts/dev-local.sh
```

---

## 📋 Complete Workflow

### Option A: All Local (Recommended First)

```bash
# 1. Setup (one-time)
./scripts/setup-dev-local.sh

# 2. Start services (every time)
./scripts/dev-local.sh

# 3. Migrations (one-time, or when schema changes)
pnpm db:migrate

# 4. Start Inngest (separate terminal, keep running)
npx inngest-cli@latest dev

# 5. Start API (main terminal)
pnpm dev:local
```

---

### Option B: Hybrid (Local API, Remote Services)

```bash
# 1. Setup remote config (one-time)
./scripts/setup-remote-dev.sh
# Or manually edit .env.development.remote

# 2. Start API with remote services
pnpm dev:remote

# 3. Inngest (can be local or remote)
npx inngest-cli@latest dev
```

---

## 🔄 Switching Between Configs

**Use Local Services**:

```bash
pnpm dev:local
```

**Use Remote Services**:

```bash
pnpm dev:remote
```

**That's it!** The scripts handle everything.

---

## ✅ Validation Checklist

### Local Setup

- [ ] Run `./scripts/setup-dev-local.sh` (creates `.env.development.local`)
- [ ] Run `./scripts/dev-local.sh` (starts Docker services)
- [ ] Run migrations
- [ ] Start Inngest
- [ ] Start API with `pnpm dev:local`
- [ ] Test: `curl http://localhost:4000/health`
- [ ] Test Kratos: `curl http://localhost:4433/health/ready`

### Remote Database

- [ ] Update `.env.development.remote` with server database
- [ ] Test connection: `psql postgresql://...`
- [ ] Run migrations on remote database
- [ ] Start API with `pnpm dev:remote`
- [ ] Verify API can read/write

### Remote Kratos

- [ ] Update `.env.development.remote` with server Kratos URLs
- [ ] Get secrets from server
- [ ] Test Kratos: `curl http://server:4433/health/ready`
- [ ] Start API with `pnpm dev:remote`
- [ ] Test registration/login flow

---

## 📚 Documentation

- **[Quick Start](./QUICK_START.md)** - 5-minute setup
- **[Next Steps](./NEXT_STEPS.md)** - Detailed step-by-step
- **[Progressive Setup](./PROGRESSIVE_SETUP.md)** - Gradual migration
- **[Hybrid Development](./HYBRID_DEVELOPMENT.md)** - Remote services guide

---

**Last Updated**: 2026-02-02
