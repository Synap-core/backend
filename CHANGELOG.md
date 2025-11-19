# Changelog

All notable changes to Synap Backend will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased] - 2025-11-18

### 🎉 Major: AI Architecture Migration

#### Changed
- **AI Architecture**: Migrated from LangChain-only to **LangGraph + Vercel AI SDK** hybrid approach
  - LangGraph handles orchestration (state machine workflows)
  - Vercel AI SDK handles LLM calls (simpler, type-safe)
  - All LangGraph nodes now use `generateObject()` with Zod schemas
  - Removed `@langchain/anthropic` dependency
  - Updated `ai` package from `^3.4.33` to `^4.0.0`

#### Removed
- **Dead Code**: Removed `ConversationalAgent` class (225 lines, unused)
- **Deprecated**: Removed `providers/chat.ts` (replaced by Vercel AI SDK)

#### Added
- **New Helper**: `packages/ai/src/agent/config-helper.ts` for lazy config loading
- **Documentation**: `AI_ARCHITECTURE.md` - Consolidated AI architecture documentation

#### Fixed
- **ESM Compatibility**: Fixed CommonJS `exports` issue in `@synap/jobs/src/client.ts`
- **Config Loading**: Implemented proper lazy initialization pattern

#### Documentation
- Updated `ARCHITECTURE.md` to reflect new AI architecture
- Updated `README.md` with LangGraph + Vercel AI SDK stack
- Consolidated AI documentation into single `AI_ARCHITECTURE.md`
- Archived obsolete analysis documents

---

## [Unreleased] - Previous

### Added
- Database factory pattern for runtime SQLite/PostgreSQL selection
- Storage factory pattern for runtime R2/MinIO selection
- Centralized configuration management with Zod validation
- Standardized error types (SynapError hierarchy)
- Structured logging with Pino
- MinIO support for local-first development
- Local file storage via MinIO S3-compatible API

### Changed
- Migrated all packages to use centralized configuration
- Replaced generic Error throws with standardized error types
- Replaced console.log with structured logging
- Updated storage abstraction to support multiple providers

### Fixed
- SQL injection vulnerability in PostgreSQL client (parameterized queries)
- Drizzle ORM type compatibility issues
- Circular dependency issues with lazy loading pattern

### Security
- Fixed SQL injection vulnerability in `setCurrentUser` function
- Added parameterized queries for all database operations

---

## [0.4.0] - 2025-01-27

### Added

#### Conversational Interface
- Hash-chained conversation messages for tamper-proof conversations
- ConversationalAgent with Claude 3 Haiku integration
- Action extraction from AI responses ([ACTION:type:params] format)
- Action execution bridge (conversation → events → state)
- Conversation branching support (alternate timelines)
- Thread management and history

#### API Endpoints
- `chat.sendMessage` - Send message to AI assistant
- `chat.getHistory` - Get conversation history
- `chat.executeAction` - Execute AI-proposed actions
- `chat.createThread` - Create new conversation thread
- `chat.getThreads` - List user's conversation threads
- `chat.createBranch` - Create conversation branch
- `chat.getBranches` - Get conversation branches
- `chat.verifyHashChain` - Verify conversation integrity

#### Domain Services
- ConversationService - Conversation management
- NoteService - Note creation and search
- EventService - Event logging and querying
- EntityService - Entity CRUD operations
- VectorService - Semantic search with embeddings
- KnowledgeService - Knowledge facts management
- SuggestionService - AI suggestions

### Changed
- Refactored from @initiativ packages to @synap/domain services
- Improved error handling with standardized error types
- Enhanced logging with structured logging

---

## [0.3.0] - 2024-11-06

### Added

#### Hybrid Storage
- Cloudflare R2 integration for production storage
- Storage abstraction interface (IFileStorage)
- Factory pattern for provider selection
- File metadata and checksum tracking
- Public URL generation

#### Event Sourcing
- TimescaleDB hypertable for event store
- EventRepository with optimistic locking
- Event correlation tracking
- Event replay capabilities

#### Database
- PostgreSQL support with TimescaleDB
- SQLite support for local development
- Database factory pattern
- Multi-dialect support

---

## [0.2.0] - 2024-11-06

### Added

#### Multi-User Support
- Better Auth integration
- OAuth providers (Google, GitHub)
- Session management
- User isolation with application-level filtering

#### Authentication
- Email/password authentication
- OAuth authentication
- Session cookies
- Password hashing

#### Database
- PostgreSQL with Neon
- Row-Level Security (RLS) support
- User-scoped queries
- Multi-tenant isolation

---

## [0.1.0] - 2024-11-06

### Added

#### Core Infrastructure
- Event-sourced backend architecture
- Hono API server with CORS support
- tRPC type-safe API layer
- Static bearer token authentication
- Drizzle ORM with multi-dialect support (SQLite/PostgreSQL)
- Inngest background job orchestration
- Turborepo monorepo structure

#### Database
- SQLite support for local single-user mode
- Event store (immutable append-only log)
- Entity-Component pattern:
  - `entities` table (core entity metadata)
  - `content_blocks` table (content storage with hybrid support)
  - `relations` table (knowledge graph edges)
  - `task_details` component table
  - `tags` and `entity_tags` tables
- Projector functions to maintain materialized views
- Database initialization script

#### AI & Intelligence
- Anthropic Claude for AI enrichment (title + tag generation)
- OpenAI embeddings for semantic search
- Automatic thought analysis and entity creation
- Semantic search with pgvector

#### API Endpoints
- `notes.create` - Create notes with AI enrichment
- `notes.search` - Hybrid search (FTS + RAG)
- `capture.thought` - Quick thought capture
- `events.log` - Event logging endpoint
- `/health` - Health check endpoint

#### Features
- Automatic AI enrichment of notes (title, tags, intent detection)
- Full-text search (FTS) via SQLite
- Semantic search (RAG) via pgvector
- Multi-format input support (text, audio via Whisper)
- Event logging and observability
- Background job processing via Inngest

---

## Key Milestones

- **V0.1** - Local MVP with SQLite
- **V0.2** - Multi-user SaaS with PostgreSQL
- **V0.3** - Hybrid storage with R2
- **V0.4** - Conversational interface with AI actions
- **V0.4+** - Code consolidation and improvements

---

For detailed information about each version, see archived documentation in `/docs/archive/`.
