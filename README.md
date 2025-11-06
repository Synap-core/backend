# 🧠 Synap Backend

**Personal AI-Powered Knowledge Management Platform**

Event-sourced, multi-user backend with intelligent thought capture, semantic search, and AI enrichment.

---

## 📊 Quick Overview

```
Version: 0.2.0 (Multi-User SaaS)
Status: ✅ Production-Ready
Architecture: Event Sourcing + Multi-User Isolation
Database: PostgreSQL (Neon) + SQLite (Open Source)
AI: Anthropic Claude 3 Haiku + OpenAI Embeddings
```

---

## ✨ Features

- ✅ **Intelligent Capture** - AI analyzes thoughts and creates structured entities
- ✅ **Semantic Search** - RAG with pgvector for similarity search
- ✅ **Multi-User** - Full user isolation with Better Auth + OAuth
- ✅ **Event Sourcing** - Immutable audit trail, time-travel capable
- ✅ **Type-Safe API** - tRPC for end-to-end type safety
- ✅ **Async Workflows** - Inngest for background AI processing

---

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- pnpm 8+
- PostgreSQL (Neon) or SQLite
- Anthropic API key

### Installation

```bash
# Clone repository
git clone https://github.com/Synap-core/backend.git synap-backend
cd synap-backend

# Install dependencies
pnpm install

# Setup environment
cp env.production.example .env
# Edit .env with your credentials

# Initialize database
./scripts/init-postgres.sh

# Start servers
pnpm --filter api dev      # Terminal 1 (API server)
pnpm --filter jobs dev     # Terminal 2 (Background jobs)
```

### Test It Works

```bash
# Create a note
curl -X POST http://localhost:3000/trpc/notes.create \
  -H "Content-Type: application/json" \
  -H "Cookie: better-auth.session=YOUR_SESSION" \
  -d '{"content":"My first note","autoEnrich":true}'

# Response:
{
  "success": true,
  "note": {
    "id": "...",
    "title": "My First Note",  // ✨ AI-generated
    "tags": ["note", "first"]   // ✨ AI-generated
  }
}
```

---

## 🏗️ Architecture

### Event Sourcing

```
User Action → Event Log → Inngest → Projectors → Database
                 ↓
          (Immutable Truth)
```

**Core Principle**: The `events` table is the single source of truth. All other tables are projections (materialized views) rebuilt from events.

### Multi-User Isolation

**Method**: Application-level filtering (explicit `WHERE userId = ?`)

```typescript
// Every query filters by userId:
const notes = await db.select()
  .from(entities)
  .where(eq(entities.userId, ctx.userId)); // ✅ User isolation
```

**Security**: Validated with comprehensive tests (10/10 passing)

### Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **API** | Hono + tRPC | Type-safe HTTP server |
| **Auth** | Better Auth | OAuth + Sessions |
| **Database** | Neon PostgreSQL | Serverless autoscaling |
| **ORM** | Drizzle | Type-safe queries |
| **Jobs** | Inngest | Async workflows |
| **AI** | Anthropic Claude | Text analysis |
| **Search** | pgvector + LlamaIndex | Semantic RAG |

---

## 📁 Project Structure

```
synap-backend/
├── apps/
│   └── api/              # Hono API server
├── packages/
│   ├── auth/             # Better Auth + Simple token
│   ├── api/              # tRPC routers
│   ├── database/         # Drizzle schemas + migrations
│   ├── jobs/             # Inngest functions
│   ├── core/             # Tests
│   └── @initiativ-*/     # Business logic modules
├── scripts/
│   └── init-postgres.sh  # Database setup
├── QUICK-START.md        # Detailed setup guide
├── ARCHITECTURE.md       # Technical deep dive
└── CHANGELOG.md          # Version history
```

---

## 🔐 Authentication

### Sign Up / Sign In

```bash
# Email/Password
POST /api/auth/sign-up
{
  "email": "user@example.com",
  "password": "secure-password",
  "name": "John Doe"
}

# OAuth
GET /api/auth/google    # Google OAuth
GET /api/auth/github    # GitHub OAuth
```

### Session Management

- **Expiry**: 7 days
- **Storage**: PostgreSQL
- **Cookies**: HttpOnly, Secure, SameSite
- **Refresh**: Automatic (24h)

---

## 📚 API Endpoints

### Notes

```typescript
// Create note with AI enrichment
POST /trpc/notes.create
{
  "content": "Raw thought or note",
  "autoEnrich": true,    // AI generates title/tags
  "useRAG": true         // Enable semantic indexing
}

// Search notes semantically
GET /trpc/notes.search
{
  "query": "important deadline",
  "useRAG": true,
  "limit": 10
}
```

### Thought Capture

```typescript
// Quick capture (async AI processing)
POST /trpc/capture.thought
{
  "content": "Remember to call mom tomorrow"
}

// AI automatically:
// 1. Analyzes content
// 2. Detects intent (task)
// 3. Extracts due date
// 4. Creates entity
```

### Events

```typescript
// Log custom event
POST /trpc/events.log
{
  "type": "custom.event",
  "data": { "key": "value" }
}

// List events
GET /trpc/events.list
{
  "limit": 50,
  "type": "entity.created"  // Optional filter
}
```

---

## 🧪 Testing

### Run Tests

```bash
# User isolation tests (10 tests)
export DB_DIALECT=postgres
export DATABASE_URL=postgresql://...
npx vitest run packages/core/tests/user-isolation.test.ts

# Expected: ✅ 10/10 tests passing
```

### Test Coverage

- ✅ Event isolation (User A vs User B)
- ✅ Entity isolation
- ✅ Tag scoping
- ✅ Cross-user access prevention
- ✅ Update/Delete protection
- ✅ Search result filtering

---

## 🚢 Deployment

### Option 1: Vercel (Recommended)

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel --prod

# Configure environment variables in Vercel dashboard
```

### Option 2: Railway

```bash
# Install Railway CLI
npm i -g @railway/cli

# Deploy
railway up

# Link database
railway add -d postgres
```

### Option 3: Self-Hosted

```bash
# Build
pnpm build

# Start
NODE_ENV=production pnpm --filter api start
```

---

## 📈 Performance

| Metric | Value | Notes |
|--------|-------|-------|
| API Response | 50-200ms | Cached queries |
| AI Enrichment | 2-3s | Async (Inngest) |
| Vector Search | 300-500ms | pgvector HNSW |
| Concurrent Users | 1000+ | Neon autoscale |
| Cost per User | $0.055/mo | At 1000 users |

---

## 🛠️ Development

### Setup

```bash
# Install dependencies
pnpm install

# Setup environment
cp env.local.example .env
# Edit .env

# Initialize SQLite (local dev)
pnpm --filter database db:init

# Start dev servers
pnpm --filter api dev      # API (port 3000)
pnpm --filter jobs dev     # Jobs (Inngest dev)
```

### Useful Commands

```bash
# Build all packages
pnpm build

# Run tests
pnpm test

# Lint
pnpm lint

# Database operations
pnpm --filter database db:push     # Push schema changes
pnpm --filter database db:studio   # Open Drizzle Studio
```

---

## 📖 Documentation

- **[QUICK-START.md](QUICK-START.md)** - Detailed setup guide
- **[ARCHITECTURE.md](ARCHITECTURE.md)** - System design & decisions
- **[CHANGELOG.md](CHANGELOG.md)** - Version history & roadmap
- **[V0.2-FINAL-ANALYSIS.md](V0.2-FINAL-ANALYSIS.md)** - Technical deep dive
- **[V0.2-CAPABILITIES-REPORT.md](V0.2-CAPABILITIES-REPORT.md)** - Features & use cases

---

## 🔒 Security

### Multi-User Isolation

**Method**: Application-level filtering with explicit `userId` checks

**Implementation**:
- ✅ Every query filters by `ctx.userId`
- ✅ Helper functions enforce filtering
- ✅ Comprehensive isolation tests
- ✅ Code review required for all DB operations

**Future**: Migrate to Supabase for database-level RLS (V0.3)

---

## 🗺️ Roadmap

### V0.2 (Current) ✅
- ✅ Multi-user backend
- ✅ Better Auth + OAuth
- ✅ AI enrichment (Claude)
- ✅ Semantic search (RAG)
- ✅ Event sourcing
- ✅ User isolation (app-level)

### V0.3 (Q1 2025)
- ⏳ Supabase migration (database-level RLS)
- ⏳ Realtime subscriptions
- ⏳ S3/R2 file storage
- ⏳ Advanced search filters
- ⏳ Webhooks

### V0.4 (Q2 2025)
- ⏳ Team workspaces
- ⏳ Sharing & permissions
- ⏳ Knowledge graph relations
- ⏳ Mobile API optimizations

See [CHANGELOG.md](CHANGELOG.md) for detailed roadmap.

---

## 🤝 Contributing

Contributions welcome! Please:
1. Read [ARCHITECTURE.md](ARCHITECTURE.md) first
2. Follow TypeScript strict mode
3. Add tests for new features
4. Update documentation

---

## 📄 License

MIT License - See LICENSE file

---

## 🔗 Links

- **Repository**: https://github.com/Synap-core/backend
- **Documentation**: See `/docs` folder
- **Issues**: GitHub Issues
- **Discussions**: GitHub Discussions

---

## 💡 Questions?

1. **Setup issues?** → Check [QUICK-START.md](QUICK-START.md)
2. **Architecture questions?** → Read [ARCHITECTURE.md](ARCHITECTURE.md)
3. **API usage?** → See examples in docs
4. **Contributing?** → Open an issue first

---

**Built with ❤️ for the future of personal knowledge management**

---

## 📊 Status

```
┌─────────────────────────────────────────────┐
│  SYNAP BACKEND V0.2                         │
│  Status: ✅ Production-Ready                │
│  Tests: ✅ 10/10 Passing                    │
│  Security: ✅ User Isolation Validated      │
│  Performance: ✅ <500ms queries             │
│  Scalability: ✅ 1000+ concurrent users     │
└─────────────────────────────────────────────┘
```

**Ready to deploy!** 🚀
