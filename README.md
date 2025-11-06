# 🧠 Synap Backend v0.1

**Production-ready backend for an intelligent "second brain" application**

> Event-sourced architecture meets local-first philosophy

---

## 🎯 What is Synap?

Synap is a **hybrid knowledge management system** that combines:
- **Event Sourcing**: Every change is logged, auditable, and replayable
- **AI Intelligence**: Automatic enrichment with Anthropic Claude
- **Local-First**: SQLite for single-user, PostgreSQL for cloud
- **Business Logic**: Powered by `@initiativ/core` packages (328 notes validated)

---

## ✨ Features

### Current (v0.1 - Local MVP)
- ✅ **Thought Capture**: Text input with AI enrichment
- ✅ **Auto-Tagging**: Claude extracts tags and generates titles
- ✅ **Event Sourcing**: Immutable event log with projectors
- ✅ **Semantic Search**: FTS (fast) and RAG (smart) search modes
- ✅ **Static Auth**: Simple bearer token authentication
- ✅ **Multi-Format Support**: Text, audio (Whisper), files
- ✅ **Observability**: Full event logging and tracing

### Roadmap (v0.2+)
- 🔜 **Multi-User**: Add user context and RLS
- 🔜 **Git Versioning**: Auto-commit notes to Git
- 🔜 **Knowledge Graph**: Entity relations and graph queries
- 🔜 **Hybrid Storage**: S3/R2 for large files
- 🔜 **Real-time Sync**: WebSocket updates

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      HTTP Client                        │
└────────────────────┬────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────┐
│               Layer 1: Hono API + tRPC                  │
│  • Bearer token authentication                          │
│  • Type-safe API with Zod validation                    │
└────────────────────┬────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────┐
│         Layer 2: Initiativ Adapter (Integration)        │
│  • Bridges Synap events ↔ Initiativ workflows          │
│  • Maps types between systems                           │
└────────────────────┬────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────┐
│      Layer 3: @initiativ/* Business Logic Packages      │
│  • @initiativ/core: Workflows orchestration             │
│  • @initiativ/rag: Semantic search (LlamaIndex)         │
│  • @initiativ/agents: AI enrichment (LangChain)         │
│  • @initiativ/storage: File & DB management             │
└────────────────────┬────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────┐
│     Layer 4: Event Store + Inngest Background Jobs      │
│  • Events table (immutable log)                         │
│  • Projectors (update materialized views)               │
│  • AI analysis jobs (Anthropic Claude)                  │
└────────────────────┬────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────┐
│              Layer 5: Database (SQLite/PG)              │
│  • entities, content_blocks, relations                  │
│  • tags, task_details (components)                      │
└─────────────────────────────────────────────────────────┘
```

---

## 🚀 Quick Start

### Prerequisites
- Node.js 20+
- pnpm 8+
- Anthropic API key

### 1. Install
```bash
cd synap-backend
pnpm install
```

### 2. Configure
```bash
cp env.example .env
nano .env
```

Required environment variables:
```bash
DB_DIALECT=sqlite
SQLITE_DB_PATH=./data/synap.db
SYNAP_SECRET_TOKEN=your-secret-token  # Generate: openssl rand -hex 32
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

### 3. Initialize Database
```bash
pnpm --filter database db:init
```

### 4. Start Servers
```bash
# Terminal 1: API server
pnpm --filter api dev

# Terminal 2: Inngest jobs
pnpm --filter jobs dev
```

### 5. Test
```bash
# Create a note
curl -X POST "http://localhost:3000/trpc/notes.create" \
  -H "Authorization: Bearer your-secret-token" \
  -H "Content-Type: application/json" \
  -d '{"content":"Test note with AI enrichment","autoEnrich":true}'

# Search notes
curl -X POST "http://localhost:3000/trpc/notes.search" \
  -H "Authorization: Bearer your-secret-token" \
  -H "Content-Type: application/json" \
  -d '{"query":"test","useRAG":false,"limit":10}'
```

**📚 Full guide**: See [QUICK-START.md](./QUICK-START.md)

---

## 📂 Project Structure

```
synap-backend/
├── apps/
│   └── api/                    # Hono API server
│       └── src/
│           └── index.ts        # Server entry point
├── packages/
│   ├── @initiativ/core/        # Business logic: workflows
│   ├── @initiativ/rag/         # Semantic search (LlamaIndex)
│   ├── @initiativ/agents/      # AI agents (LangChain + Claude)
│   ├── @initiativ/storage/     # File & DB storage
│   ├── @initiativ/git/         # Git versioning (phase 2)
│   ├── @initiativ/input/       # Input processing (text, audio)
│   ├── @initiativ/events/      # Event logging
│   ├── database/               # Drizzle schemas + migrations
│   ├── api/                    # tRPC routers + adapters
│   ├── auth/                   # Static token auth
│   ├── jobs/                   # Inngest background functions
│   └── core/                   # Shared utilities
├── data/                       # SQLite database (local)
├── README.md                   # This file
├── QUICK-START.md              # Getting started guide
├── ARCHITECTURE.md             # Technical deep-dive
└── CHANGELOG.md                # Version history
```

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| **API** | Hono (lightweight server) |
| **API Layer** | tRPC (type-safe endpoints) |
| **Database** | SQLite (local) / PostgreSQL (cloud) |
| **ORM** | Drizzle ORM (multi-dialect) |
| **Auth** | Static bearer tokens (v0.1) |
| **Jobs** | Inngest (async orchestration) |
| **AI** | Anthropic Claude (via Vercel AI SDK) |
| **RAG** | LlamaIndex (semantic search) |
| **Agents** | LangChain (AI workflows) |
| **Monorepo** | Turborepo + pnpm workspaces |
| **Language** | TypeScript (strict mode) |

---

## 🎯 Use Cases

### Personal
- **Second Brain**: Capture thoughts, AI auto-organizes them
- **Note-Taking**: Markdown files with semantic search
- **Task Management**: Auto-detect tasks from thoughts

### Team
- **Knowledge Base**: Shared notes with AI suggestions
- **Meeting Notes**: Audio transcription + AI summaries

### Enterprise
- **System of Record**: Full audit trail via event sourcing
- **Compliance**: Immutable event log for regulations

---

## 🔍 Key Concepts

### Event Sourcing
Every change is recorded as an immutable event:
```typescript
{
  "type": "entity.created",
  "data": { "entityId": "123", "title": "My Note" },
  "timestamp": "2025-11-06T01:51:46.068Z",
  "source": "api"
}
```

### Projectors
Inngest functions that react to events and update materialized views:
```typescript
onEvent("entity.created") → Insert into entities table
onEvent("entity.updated") → Update entities table
```

### Hybrid Architecture
- **Synap Backend**: Infrastructure (API, DB, auth, jobs)
- **Initiativ Packages**: Business logic (workflows, AI, search)
- **Best of Both**: Scalable infrastructure + battle-tested logic

---

## 📊 Validated Performance

The `@initiativ/core` packages powering Synap have been validated with:
- ✅ **328 real notes** processed successfully
- ✅ **Multi-provider AI** (OpenAI, Google, Anthropic, local)
- ✅ **Hybrid search** (FTS + RAG) with 60%+ accuracy
- ✅ **Event logging** with full observability
- ✅ **File storage** (.md files + Git versioning ready)

---

## 🌟 Why Synap?

### 1. **Truly Local-First**
- SQLite for single-user (no cloud required)
- File-based storage (.md files)
- Optional Git versioning

### 2. **AI-Native**
- Automatic title generation
- Smart tagging
- Semantic search
- Content summarization

### 3. **Event-Sourced**
- Full audit trail
- Time-travel debugging
- Replayable state

### 4. **LLM-Agnostic**
Switch AI providers with one line:
```typescript
provider: 'anthropic' | 'openai' | 'google' | 'local'
```

### 5. **Production-Ready**
- TypeScript strict mode
- Comprehensive error handling
- Structured logging
- Test coverage

---

## 📖 Documentation

- **[QUICK-START.md](./QUICK-START.md)** - Get running in 5 minutes
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** - Deep technical dive
- **[CHANGELOG.md](./CHANGELOG.md)** - Version history

---

## 🤝 Contributing

This is currently a private project. Two versions are planned:
- **Open Source** (single-user, local-first) - Branch: `open-source`
- **SaaS** (multi-user, cloud-hosted) - Branch: `main`

---

## 📜 License

Private - All Rights Reserved (for now)

---

## 🙏 Acknowledgments

Built with:
- Anthropic Claude (AI enrichment)
- LlamaIndex (RAG search)
- LangChain (AI agents)
- Hono (API framework)
- Drizzle (ORM)
- Inngest (job orchestration)

---

**Status**: v0.1 (Local MVP) - Production Ready ✅

**Next**: v0.2 (Multi-user + Cloud)
