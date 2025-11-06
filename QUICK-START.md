# 🚀 Synap Backend - Quick Start Guide

Complete setup guide for both local development and production deployment.

---

## 📋 Table of Contents

1. [Local Development (SQLite)](#local-development-sqlite)
2. [Production Setup (PostgreSQL)](#production-setup-postgresql)
3. [Testing](#testing)
4. [Troubleshooting](#troubleshooting)

---

## 🏠 Local Development (SQLite)

### Single-user mode for local testing

#### 1. Install Dependencies

```bash
cd /path/to/synap-backend
pnpm install
```

#### 2. Configure Environment

```bash
cp env.local.example .env
```

Edit `.env`:
```bash
DB_DIALECT=sqlite
SQLITE_DB_PATH=./data/synap.db
SYNAP_SECRET_TOKEN=your-secret-token-here  # openssl rand -hex 32
ANTHROPIC_API_KEY=sk-ant-your-key-here
OPENAI_API_KEY=sk-proj-your-key-here  # For embeddings
```

#### 3. Initialize Database

```bash
pnpm --filter database db:init
```

#### 4. Start Servers

```bash
# Terminal 1: API Server
pnpm --filter api dev

# Terminal 2: Background Jobs
pnpm --filter jobs dev
```

#### 5. Test

```bash
# Get auth token
export TOKEN=$(grep SYNAP_SECRET_TOKEN .env | cut -d= -f2)

# Create a note
curl -X POST http://localhost:3000/trpc/notes.create \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"Test note","autoEnrich":true}'
```

---

## ☁️ Production Setup (PostgreSQL)

### Multi-user SaaS with Better Auth

#### 1. Create Neon Database

```bash
# Sign up: https://neon.tech
# Create project: "synap-backend-production"
# Copy connection string
```

#### 2. Configure Environment

```bash
cp env.production.example .env.production
```

Edit `.env.production`:
```bash
# Database
DB_DIALECT=postgres
DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/synap?sslmode=require

# Better Auth
BETTER_AUTH_SECRET=your-secret-here  # openssl rand -base64 32
BETTER_AUTH_URL=https://yourdomain.com

# OAuth (optional)
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-secret
GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-secret

# AI
ANTHROPIC_API_KEY=sk-ant-your-key-here
OPENAI_API_KEY=sk-proj-your-key-here

# Inngest
INNGEST_EVENT_KEY=your-inngest-key
INNGEST_SIGNING_KEY=your-signing-key
```

#### 3. Initialize Database

```bash
export $(cat .env.production | xargs)
./scripts/init-postgres.sh
```

**Expected Output**:
```
🚀 Initializing Synap PostgreSQL Database...
✅ pgvector enabled
✅ Schemas pushed
✅ RLS enabled (note: not active, using explicit filtering)
🎉 Database initialization complete!
```

#### 4. Run Tests

```bash
export $(cat .env.production | xargs)
npx vitest run packages/core/tests/user-isolation.test.ts
```

**Expected**: ✅ 10/10 tests passing

#### 5. Deploy

**Vercel** (Recommended):
```bash
npm i -g vercel
vercel --prod
```

**Railway**:
```bash
npm i -g @railway/cli
railway up
```

---

## 🧪 Testing

### User Isolation Tests

Validates that users cannot access each other's data:

```bash
export DB_DIALECT=postgres
export DATABASE_URL=postgresql://...
npx vitest run packages/core/tests/user-isolation.test.ts
```

**Tests** (10 total):
- ✅ Event creation with userId
- ✅ Event filtering by userId
- ✅ Entity creation with userId
- ✅ Entity filtering by userId
- ✅ User-scoped tags
- ✅ Tag filtering
- ✅ Cross-user access prevention
- ✅ Update protection
- ✅ Search isolation
- ✅ Documentation

---

## 🔐 OAuth Setup (Optional)

### Google OAuth

1. Go to https://console.cloud.google.com
2. Create project "Synap"
3. Enable Google+ API
4. Create OAuth 2.0 credentials:
   - **Redirect URI**: `http://localhost:3000/api/auth/callback/google`
5. Copy Client ID and Secret to `.env.production`

### GitHub OAuth

1. Go to https://github.com/settings/developers
2. New OAuth App:
   - **Name**: Synap Backend
   - **Homepage**: `http://localhost:3000`
   - **Callback**: `http://localhost:3000/api/auth/callback/github`
3. Copy Client ID and Secret to `.env.production`

---

## 📖 API Usage Examples

### Authentication

```bash
# Sign up
curl -X POST http://localhost:3000/api/auth/sign-up \
  -H "Content-Type: application/json" \
  -d '{"email":"user@test.com","password":"pass123","name":"Test User"}'

# Sign in
curl -X POST http://localhost:3000/api/auth/sign-in \
  -H "Content-Type: application/json" \
  -d '{"email":"user@test.com","password":"pass123"}'

# Returns session cookie: better-auth.session=...
```

### Notes

```bash
# Create note (requires session)
curl -X POST http://localhost:3000/trpc/notes.create \
  -H "Content-Type: application/json" \
  -H "Cookie: better-auth.session=YOUR_SESSION" \
  -d '{
    "content": "Meeting notes from Q4 planning session",
    "autoEnrich": true,
    "useRAG": true
  }'

# Search notes
curl "http://localhost:3000/trpc/notes.search?input={\"query\":\"planning\",\"useRAG\":true}" \
  -H "Cookie: better-auth.session=YOUR_SESSION"
```

### Thought Capture

```bash
# Quick capture (async processing)
curl -X POST http://localhost:3000/trpc/capture.thought \
  -H "Content-Type: application/json" \
  -H "Cookie: better-auth.session=YOUR_SESSION" \
  -d '{"content":"Buy milk tomorrow at 5pm"}'

# AI will:
# 1. Analyze: intent=task, dueDate=tomorrow-5pm
# 2. Create task entity automatically
# 3. Add tags: shopping, groceries
```

---

## 🐛 Troubleshooting

### Error: "Module not found"

```bash
# Rebuild packages
pnpm build

# Or install missing deps
pnpm install
```

### Error: "Cannot find database"

```bash
# SQLite: Initialize
pnpm --filter database db:init

# PostgreSQL: Run migrations
./scripts/init-postgres.sh
```

### Error: "Unauthorized"

```bash
# Local (SQLite): Check token
echo $SYNAP_SECRET_TOKEN

# Production (PostgreSQL): Check session
curl http://localhost:3000/api/auth/session \
  -H "Cookie: better-auth.session=YOUR_SESSION"
```

### Error: "pgvector not found"

```bash
# Run extension migration
psql $DATABASE_URL < packages/database/migrations-pg/0001_enable_pgvector.sql
```

### Tests Failing

```bash
# Check environment
echo $DB_DIALECT
echo $DATABASE_URL

# PostgreSQL: Check tables exist
psql $DATABASE_URL -c "\dt"

# Should show: events, entities, content_blocks, relations, task_details, tags, entity_tags
```

---

## 📊 Database Schema

```sql
-- Events (immutable log)
events
├── id (uuid)
├── user_id (text) ← Isolation key
├── timestamp
├── type (entity.created, ...)
└── data (jsonb)

-- Entities (knowledge graph)
entities
├── id (uuid)
├── user_id (text) ← Isolation key
├── type (note, task, project, ...)
├── title
└── preview

-- Content (hybrid storage)
content_blocks
├── entity_id (FK → entities)
├── content (text, nullable)
├── storage_provider (db | s3 | r2)
└── embedding (vector[1536])

-- Tags (user-scoped)
tags
├── id (uuid)
├── user_id (text) ← Isolation key
└── name
```

---

## 🔧 Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DB_DIALECT` | Yes | `sqlite` or `postgres` |
| `DATABASE_URL` | Yes* | PostgreSQL connection string |
| `SQLITE_DB_PATH` | Yes* | SQLite file path |
| `ANTHROPIC_API_KEY` | Yes | Claude API key |
| `OPENAI_API_KEY` | Yes | Embeddings API key |
| `BETTER_AUTH_SECRET` | Yes** | Session secret |
| `SYNAP_SECRET_TOKEN` | Yes*** | Static auth token |

\* One of DATABASE_URL or SQLITE_DB_PATH required  
\** PostgreSQL only  
\*** SQLite only

---

## 📚 Additional Resources

- **Better Auth**: https://better-auth.com
- **Drizzle ORM**: https://orm.drizzle.team
- **Inngest**: https://inngest.com
- **Neon**: https://neon.tech
- **tRPC**: https://trpc.io

---

## 🆘 Support

- **GitHub Issues**: https://github.com/Synap-core/backend/issues
- **Discussions**: https://github.com/Synap-core/backend/discussions
- **Email**: support@synap.dev (coming soon)

---

**Ready to build your second brain!** 🧠✨
