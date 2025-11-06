# ⚡ Synap Backend - Quick Start Guide

**Get running in 5 minutes** 🚀

---

## Prerequisites

- **Node.js**: v20+ ([download](https://nodejs.org))
- **pnpm**: v8+ (`npm install -g pnpm`)
- **Anthropic API Key**: Get one at [console.anthropic.com](https://console.anthropic.com)

---

## Step 1: Clone & Install (1 min)

```bash
cd /Users/antoine/Documents/Code/synap-backend
pnpm install
```

**What this does**:
- Installs all dependencies across the monorepo
- Links workspace packages
- Builds TypeScript packages

---

## Step 2: Configure Environment (1 min)

```bash
cp env.example .env
```

Edit `.env` with your settings:

```bash
# Database (SQLite for local MVP)
DB_DIALECT=sqlite
SQLITE_DB_PATH=./data/synap.db

# Authentication (generate with: openssl rand -hex 32)
SYNAP_SECRET_TOKEN=00a0896278b2ac5b19a8a3788ef1013a37a27d837c73ab2213aa6517414dbefd

# AI Provider (Anthropic Claude)
ANTHROPIC_API_KEY=sk-ant-your-api-key-here

# Optional: RAG Embeddings (for semantic search)
EMBEDDINGS_PROVIDER=openai  # or 'google', 'cohere', 'local'
OPENAI_API_KEY=sk-proj-your-key-here  # if using OpenAI embeddings
```

**Security Note**: The `SYNAP_SECRET_TOKEN` is your master password. Keep it secret!

---

## Step 3: Initialize Database (30 sec)

```bash
pnpm --filter database db:init
```

**What this does**:
- Creates `data/synap.db` (SQLite database)
- Initializes tables: `events`, `entities`, `content_blocks`, `relations`, `tags`, etc.

**Verify**:
```bash
ls -lh data/synap.db
# Should show: synap.db file created
```

---

## Step 4: Start Development Servers (1 min)

You need **two terminals**:

### Terminal 1: API Server
```bash
pnpm --filter api dev
```

**Expected output**:
```
> api@1.0.0 dev
> tsx watch src/index.ts

📦 SQLite database: /path/to/synap-backend/data/synap.db
🚀 Hono server started on http://localhost:3000
✅ tRPC endpoints available at /trpc/*
```

### Terminal 2: Inngest Job Server
```bash
pnpm --filter jobs dev
```

**Expected output**:
```
> jobs@1.0.0 dev
> npx inngest-cli@latest dev

[Inngest] Dev server running at http://localhost:8288
[Inngest] Functions loaded:
  - analyzeCapturedThought
  - processAnalyzedThought
  - handleNewEvent
```

**Inngest Dashboard**: Open [http://localhost:8288](http://localhost:8288) to monitor jobs

---

## Step 5: Test the System (2 min)

### 5.1 Health Check
```bash
curl http://localhost:3000/health
```

**Expected**: `{"status":"ok"}`

---

### 5.2 Create a Note (with AI enrichment)

```bash
curl -X POST "http://localhost:3000/trpc/notes.create" \
  -H "Authorization: Bearer 00a0896278b2ac5b19a8a3788ef1013a37a27d837c73ab2213aa6517414dbefd" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Build a real-time collaborative editor using WebSockets",
    "autoEnrich": true
  }'
```

**Expected response**:
```json
{
  "result": {
    "data": {
      "success": true,
      "note": {
        "id": "uuid-here",
        "title": "Real-time Collaborative Editor Project",
        "content": "Build a real-time collaborative editor using WebSockets",
        "tags": ["editor", "websockets", "real-time", "collaborative"],
        "createdAt": "2025-11-06T...",
        "metadata": {
          "inputSource": "text",
          "processedAt": "2025-11-06T..."
        }
      }
    }
  }
}
```

**What happened**:
1. ✅ API received your note
2. ✅ Initiativ Core processed it (created .md file, indexed it)
3. ✅ Claude AI enriched it (generated title + tags)
4. ✅ Event logged in event store
5. ✅ Entity created in database

---

### 5.3 Search Notes

```bash
curl -X POST "http://localhost:3000/trpc/notes.search" \
  -H "Authorization: Bearer your-token-here" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "editor",
    "useRAG": false,
    "limit": 5
  }'
```

**Search modes**:
- `useRAG: false` → Fast FTS (Full-Text Search) via SQLite
- `useRAG: true` → Smart semantic search via LlamaIndex

---

### 5.4 Verify Database

```bash
# View events
sqlite3 data/synap.db "SELECT type, timestamp FROM events ORDER BY timestamp DESC LIMIT 5;"

# View entities
sqlite3 data/synap.db "SELECT id, type, title FROM entities LIMIT 5;"

# View content
sqlite3 data/synap.db "SELECT entityId, SUBSTR(content, 1, 50) FROM content_blocks LIMIT 5;"
```

---

## ✅ Success!

You now have:
- ✅ **Event-sourced backend** running locally
- ✅ **SQLite database** (no cloud dependencies)
- ✅ **AI enrichment** via Anthropic Claude
- ✅ **Type-safe API** via tRPC
- ✅ **Background jobs** via Inngest

---

## 🎯 Next Steps

### Try More Features

#### 1. **Audio Input** (if Whisper configured)
```bash
curl -X POST "http://localhost:3000/trpc/notes.create" \
  -H "Authorization: Bearer your-token-here" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "https://example.com/audio.mp3",
    "inputType": "audio"
  }'
```

#### 2. **RAG Semantic Search**
```bash
# Create 5+ notes first, then search with RAG
curl -X POST "http://localhost:3000/trpc/notes.search" \
  -H "Authorization: Bearer your-token-here" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "What are my ideas about real-time systems?",
    "useRAG": true,
    "limit": 10
  }'
```

#### 3. **View Initiativ Data**
```bash
# Initiativ Core stores .md files locally
ls ~/.synap/initiativ-data/notes/

# View event log
cat ~/.synap/data/events.jsonl | jq
```

---

## 🔧 Development Commands

```bash
# Install dependencies
pnpm install

# Start API server (hot reload)
pnpm --filter api dev

# Start Inngest jobs
pnpm --filter jobs dev

# Initialize/reset database
pnpm --filter database db:init

# View database (Drizzle Studio)
pnpm --filter database db:studio

# Run tests
pnpm --filter core test

# Build for production
pnpm build

# Lint
pnpm lint

# Type check
pnpm typecheck
```

---

## 🐛 Troubleshooting

### Error: "SYNAP_SECRET_TOKEN not set"
**Fix**: Add to `.env`:
```bash
SYNAP_SECRET_TOKEN=$(openssl rand -hex 32)
```

### Error: "ANTHROPIC_API_KEY not set"
**Fix**: Get API key from [console.anthropic.com](https://console.anthropic.com) and add to `.env`

### Error: "Cannot open database"
**Fix**: Initialize database:
```bash
mkdir -p data
pnpm --filter database db:init
```

### Error: "Module not found: better-sqlite3"
**Fix**: Rebuild native module:
```bash
cd packages/database
pnpm install
npm rebuild better-sqlite3
```

### Error: "Port 3000 already in use"
**Fix**: Kill existing process or change port:
```bash
lsof -ti:3000 | xargs kill -9
# Or set PORT=3001 in .env
```

### Inngest jobs not triggering
**Fix**: Make sure Inngest dev server is running in Terminal 2

---

## 📊 Monitor & Debug

### View Inngest Dashboard
```bash
open http://localhost:8288
```

**What you can see**:
- Job execution history
- Event payloads
- Error traces
- Execution times

### View Database
```bash
pnpm --filter database db:studio
```

**What you can see**:
- All tables (entities, events, content_blocks, etc.)
- Run SQL queries
- Edit data

### View Logs
```bash
# API logs (Terminal 1)
# Inngest logs (Terminal 2)

# Or tail event log
tail -f ~/.synap/data/events.jsonl | jq
```

---

## 🚀 Deploy to Production

### Option 1: Single-User (Self-Hosted)
```bash
# Build
pnpm build

# Start production server
NODE_ENV=production pnpm start
```

### Option 2: Multi-User (Cloud)
1. Switch `DB_DIALECT=postgres` in `.env`
2. Set `DATABASE_URL=postgresql://...`
3. Deploy to Vercel/Railway/Render
4. Add Better Auth for multi-user support

**See [ARCHITECTURE.md](./ARCHITECTURE.md)** for cloud deployment details.

---

## 📚 Learn More

- **[README.md](./README.md)** - Project overview
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** - Technical deep-dive
- **[CHANGELOG.md](./CHANGELOG.md)** - Version history

---

**Need help?** Check the [GitHub Issues](https://github.com/yourusername/synap-backend/issues) or contact antoine@example.com

**Ready to build!** 🎉
