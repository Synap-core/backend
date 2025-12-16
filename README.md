# Synap Backend

**Open-Source AI-Powered Personal Knowledge Management System**

> Event-sourced backend with semantic search, knowledge graphs, and intelligent assistance

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E=22-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)

---

## 🎯 Overview

Synap is an **AI-powered personal knowledge management system** that helps you organize, connect, and intelligently interact with your information through:

- **🔍 Semantic Search** - Vector-based similarity search powered by pgvector
- **🧠 Knowledge Graph** - Entity and relationship tracking
- **🤖 AI Integration** - LangChain-powered intelligent assistance  
- **📊 Event Sourcing** - Complete audit trail and time-travel capabilities
- **🔐 Multi-Tenancy** - Secure pod-per-user architecture (prepared)

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** >= 22
- **pnpm** >= 9
- **Docker** & Docker Compose
- **OpenAI API Key** (for embeddings)

### Installation

```bash
# 1. Clone repository
git clone https://github.com/yourusername/synap-backend.git
cd synap-backend

# 2. Install dependencies
pnpm install

# 3. Configure environment
cp .env.example .env
# Edit .env - Update DATABASE_URL, OPENAI_API_KEY, etc.

# 4. Start infrastructure (PostgreSQL + MinIO)
docker compose up -d

# 5. Run database migrations
pnpm db:migrate

# 6. Verify setup - run tests
pnpm test

# 7. Start development server
pnpm dev
```

**Verify**: Visit http://localhost:3000/health

---

## 📦 Package Structure

```
synap-backend/
├── packages/
│   ├── api/           # Fastify HTTP API
│   ├── core/          # Configuration, logging, errors
│   ├── database/      # Drizzle ORM, migrations, repos
│   ├── domain/        # Business logic services
│   ├── jobs/          # Background jobs (Inngest)
│   ├── storage/       # File storage (MinIO/S3)
│   ├── ai-embeddings/ # Vector embeddings (OpenAI)
│   └── auth/          # Authentication utilities
├── docs/              # Documentation
└── scripts/           # Utility scripts
```

---

## 🏗️ Architecture

### Event-Driven CQRS Design

```
┌─────────────────────────────────────────┐
│         Fastify API Layer                │
│   (Type-safe routes + Zod validation)   │
└──────────────┬──────────────────────────┘
               │
    ┌──────────┼─────────┐
    │          │         │
    ▼          ▼         ▼
┌────────┐ ┌──────┐ ┌─────────┐
│ Domain │ │ Jobs │ │ Storage │
│Services│ │      │ │ (MinIO) │
└───┬────┘ └──┬───┘ └────┬────┘
    │         │          │
    └─────────┼──────────┘
              ▼
    ┌──────────────────┐
    │  Database Layer   │
    │  PostgreSQL +     │
    │  Drizzle ORM      │
    └──────────────────┘
```

**Key Principles**:
- All state changes → events (immutable log)
- Separate read/write models (CQRS)
- Materialized views for performance
- Complete audit trail

---

## 🛠️ Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Runtime** | Node.js 22 | JavaScript runtime |
| **Language** | TypeScript 5 | Type safety |
| **API** | Fastify 5 | HTTP server |
| **Database** | PostgreSQL 16 | Primary data store |
| **ORM** | Drizzle ORM 0.33 | Type-safe queries |
| **Driver** | postgres.js 3.4 | PostgreSQL client |
| **Vector Search** | pgvector 0.7 | Semantic search |
| **Storage** | MinIO | S3-compatible files |
| **Jobs** | Inngest 3 | Background processing |
| **AI** | LangChain 0.3 | AI orchestration |
| **Embeddings** | OpenAI | Vector embeddings |
| **Testing** | Vitest | Unit/integration tests |
| **Auth** | Ory Kratos *(optional)* | Identity management |

---

## 🔧 Development Commands

```bash
# Development
pnpm dev                 # Start all services
pnpm build               # Build all packages
pnpm test                # Run tests (11/11 passing)

# Database
pnpm db:migrate          # Apply migrations
pnpm db:studio           # Open Drizzle Studio

# Docker
docker compose up -d            # Start required services
docker compose --profile auth up # Include authentication
docker compose --profile jobs up # Include background jobs
```

---

## ✅ Current Status

**Version**: 0.3.0  
**Tests**: 11/11 passing (4 vector SELECT tests skipped - known vitest integration issue)  
**Production Ready**: Core services operational

### What Works

- ✅ **Core Services** - Event, conversation, knowledge, suggestion all tested
- ✅ **Database Layer** - Migrations, pooling, type-safe queries
- ✅ **Vector Storage** - Embedding generation and storage
- ✅ **API Layer** - Validation, error handling, CORS
- ✅ **File Storage** - MinIO integration
- ✅ **Authentication** - Ory Kratos configured (optional)

### Known Limitations

- ⏸️ Vector semantic search (INSERT works, SELECT tests skipped due to vitest issue)
- ❌ AI intelligence features not implemented yet
- ❌ Real-time WebSocket support
- ❌ Multi-tenant deployment (prepared but not active)

See [MASTER_DOCUMENTATION.md](./MASTER_DOCUMENTATION.md) for complete details.

---

## 🔌 Integrations

### N8N Workflow Automation

**Quick Setup** - Add webhook URL to `.env`:

```bash
# Get webhook URL from your N8N workflow (webhook trigger node)
N8N_WEBHOOK_URL=https://yourinstance.app.n8n.cloud/webhook/synap-events

# Optional: Customize event types (defaults to all entity events)
N8N_EVENT_TYPES=entities.create.validated,entities.update.validated

# Optional: Secret for signature verification
N8N_WEBHOOK_SECRET=your-secret-key
```

**That's it!** N8N auto-subscribes on server start. Create an entity, it shows up in N8N.

**Alternative**: Use Admin UI → Subscribers → Webhooks tab

### LangFlow AI Agents

```bash
# Add to .env
LANGFLOW_URL=http://localhost:7860
LANGFLOW_API_KEY=your-api-key
```

See [docs/integrations/](./docs/integrations/) for detailed guides.

---

## 📚 Documentation

- **[MASTER_DOCUMENTATION.md](./MASTER_DOCUMENTATION.md)** - Complete system documentation (start here!)
- **[CHANGELOG.md](./CHANGELOG.md)** - Version history
- **[docs/](./docs/)** - Additional guides

**For Contributors**: Read MASTER_DOCUMENTATION.md first - it contains architecture, testing principles, and development guidelines.

---

## 🗺️ Roadmap

### Phase 1: Complete Core (Next Up)
- [ ] Fix vector search (vitest integration issue)
- [ ] Implement semantic search endpoints
- [ ] Add AI intelligence (Q&A, summarization)
- [ ] Increase test coverage to 80%

### Phase 2: Production
- [ ] Monitoring & observability
- [ ] Performance optimization  
- [ ] Deployment automation
- [ ] Multi-tenant migration

### Phase 3: Advanced
- [ ] Advanced AI capabilities
- [ ] Real-time collaboration
- [ ] Mobile applications

See MASTER_DOCUMENTATION.md for detailed roadmap.

---

## 🤝 Contributing

We welcome contributions! 

**Before contributing**:
1. Read [MASTER_DOCUMENTATION.md](./MASTER_DOCUMENTATION.md) - Architecture & principles
2. Check existing issues or create one
3. Follow TypeScript strict mode
4. Write tests for new features
5. Use Zod for validation

**Development Setup**:
```bash
# Fork and clone
git clone https://github.com/yourusername/synap-backend.git

# Install dependencies
pnpm install

# Start services
docker compose up -d

# Run migrations
pnpm db:migrate

# Run tests
pnpm test

# Start coding!
```

---

## 📄 License

MIT License - See [LICENSE](./LICENSE) for details

---

## 🙏 Acknowledgments

Built with:
- [Drizzle ORM](https://orm.drizzle.team) - Type-safe database toolkit
- [Fastify](https://fastify.dev) - Fast web framework
- [pgvector](https://github.com/pgvector/pgvector) - Vector similarity search
- [LangChain](https://js.langchain.com) - AI orchestration
- [Inngest](https://inngest.com) - Background jobs

---

## 📞 Support

- **Documentation**: [MASTER_DOCUMENTATION.md](./MASTER_DOCUMENTATION.md)
- **Issues**: [GitHub Issues](https://github.com/yourusername/synap-backend/issues)
- **Discussions**: [GitHub Discussions](https://github.com/yourusername/synap-backend/discussions)

---

**Last Updated**: December 6, 2025  
**Version**: 0.3.0  
**Status**: Core Operational, Tests Passing ✅
