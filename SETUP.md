# 🚀 Synap Backend - Setup Guide

Complete setup guide for local development and production deployment.

---

## 📋 Table of Contents

1. [Local Development (SQLite + MinIO)](#local-development-sqlite--minio)
2. [Production Setup (PostgreSQL + R2)](#production-setup-postgresql--r2)
3. [Testing](#testing)
4. [Troubleshooting](#troubleshooting)

---

## 🏠 Local Development (SQLite + MinIO)

### Single-user mode for local testing with local file storage

#### 1. Prerequisites

- Node.js 20+
- pnpm 8+
- Docker and Docker Compose (for MinIO)
- Anthropic API key
- OpenAI API key (for embeddings)

#### 2. Install Dependencies

```bash
cd /path/to/synap-backend
pnpm install
```

#### 3. Configure Environment

```bash
cp env.local.example .env
```

Edit `.env`:
```bash
# Database
DB_DIALECT=sqlite
SQLITE_DB_PATH=./data/synap.db

# Storage (MinIO for local)
STORAGE_PROVIDER=minio
MINIO_ENDPOINT=http://localhost:9000
MINIO_ACCESS_KEY_ID=minioadmin
MINIO_SECRET_ACCESS_KEY=minioadmin
MINIO_BUCKET_NAME=synap-storage

# Auth (simple token)
SYNAP_SECRET_TOKEN=your-secret-token-here  # openssl rand -hex 32

# AI
ANTHROPIC_API_KEY=sk-ant-your-key-here
OPENAI_API_KEY=sk-proj-your-key-here

# Inngest (optional, for local dev)
INNGEST_EVENT_KEY=dev-local-key
```

#### 4. Start Local Services

```bash
# Start MinIO (S3-compatible local storage)
docker-compose up -d minio

# Verify MinIO is running
docker-compose ps

# Access MinIO console (optional)
# http://localhost:9001
# Login: minioadmin / minioadmin
```

#### 5. Initialize Database

```bash
pnpm --filter database db:init
```

#### 6. Start Servers

```bash
# Terminal 1: API Server
pnpm --filter api dev

# Terminal 2: Background Jobs (optional)
pnpm --filter jobs dev
```

#### 7. Test It Works

```bash
# Get auth token
export TOKEN=$(grep SYNAP_SECRET_TOKEN .env | cut -d= -f2)

# Health check
curl http://localhost:3000/health

# Create a note
curl -X POST http://localhost:3000/trpc/notes.create \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"Test note","autoEnrich":true}'
```

### Using Your Existing Notes Folder

You can use an existing notes folder with MinIO:

```bash
# Option 1: Place notes in data/notes
mkdir -p data/notes
cp -r ~/Documents/MyNotes/* data/notes/

# Option 2: Symlink existing folder
ln -s ~/Documents/MyNotes ./data/notes

# MinIO will expose your folder via S3 API
# Files are accessible at: http://localhost:9000/synap-storage/path/to/file.md
```

See [LOCAL-SETUP.md](./LOCAL-SETUP.md) for more details.

---

## ☁️ Production Setup (PostgreSQL + R2)

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

# Storage (R2 for production)
STORAGE_PROVIDER=r2
R2_ACCOUNT_ID=your-cloudflare-account-id
R2_ACCESS_KEY_ID=your-r2-access-key
R2_SECRET_ACCESS_KEY=your-r2-secret-key
R2_BUCKET_NAME=synap-storage
R2_PUBLIC_URL=https://synap-storage.r2.dev

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
✅ RLS enabled
🎉 Database initialization complete!
```

#### 4. Run Tests

```bash
export $(cat .env.production | xargs)
npx vitest run packages/core/tests/user-isolation.test.ts
```

**Expected**: ✅ All tests passing

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
railway add -d postgres
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

**Tests**:
- ✅ Event creation with userId
- ✅ Event filtering by userId
- ✅ Entity creation with userId
- ✅ Entity filtering by userId
- ✅ User-scoped tags
- ✅ Tag filtering
- ✅ Cross-user access prevention
- ✅ Update protection
- ✅ Search isolation

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

### Chat (Conversational Interface)

```bash
# Send message
curl -X POST http://localhost:3000/trpc/chat.sendMessage \
  -H "Content-Type: application/json" \
  -H "Cookie: better-auth.session=YOUR_SESSION" \
  -d '{
    "threadId": "uuid",
    "content": "Create a task to call John tomorrow at 3pm"
  }'

# AI responds with action proposal
# Confirm action
curl -X POST http://localhost:3000/trpc/chat.executeAction \
  -H "Content-Type: application/json" \
  -H "Cookie: better-auth.session=YOUR_SESSION" \
  -d '{
    "threadId": "uuid",
    "messageId": "uuid",
    "actionType": "task.create",
    "actionParams": {...}
  }'
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

### MinIO Not Starting

```bash
# Check logs
docker-compose logs minio

# Restart
docker-compose restart minio

# Verify port is available
lsof -i :9000
```

### Storage Provider Not Found

```bash
# Verify environment variable
echo $STORAGE_PROVIDER

# Should be "minio" or "r2"

# Check .env file
cat .env | grep STORAGE_PROVIDER
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
| `STORAGE_PROVIDER` | Yes | `r2` or `minio` |
| `R2_ACCOUNT_ID` | Yes** | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | Yes** | R2 access key |
| `R2_SECRET_ACCESS_KEY` | Yes** | R2 secret key |
| `MINIO_ENDPOINT` | Yes*** | MinIO endpoint URL |
| `ANTHROPIC_API_KEY` | Yes | Claude API key |
| `OPENAI_API_KEY` | Yes | Embeddings API key |
| `BETTER_AUTH_SECRET` | Yes**** | Session secret |
| `SYNAP_SECRET_TOKEN` | Yes***** | Static auth token |

\* One of DATABASE_URL or SQLITE_DB_PATH required  
\** Required if STORAGE_PROVIDER=r2  
\*** Required if STORAGE_PROVIDER=minio  
\**** PostgreSQL only  
\***** SQLite only

---

## 📚 Additional Resources

- **Better Auth**: https://better-auth.com
- **Drizzle ORM**: https://orm.drizzle.team
- **Inngest**: https://inngest.com
- **Neon**: https://neon.tech
- **tRPC**: https://trpc.io
- **MinIO**: https://min.io/docs/

---

## 🆘 Support

- **GitHub Issues**: https://github.com/Synap-core/backend/issues
- **Discussions**: https://github.com/Synap-core/backend/discussions

---

**Ready to build your second brain!** 🧠✨

