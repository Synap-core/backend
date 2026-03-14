# Synap Backend -- Product Documentation

Last updated: 2026-02-21

---

## 1. What is Synap?

Synap is a knowledge workspace where humans and AI collaborate as equals. It is not a chatbot bolted onto a note-taking app -- it is a unified platform where entities, documents, conversations, and agent-driven automation coexist in a single data model.

**Core primitives:**

- **Entities** -- structured knowledge objects with a flexible property system. Types include notes, tasks, contacts, meetings, ideas, and projects. Entities can be linked to each other via typed relations, forming a traversable knowledge graph.
- **Documents** -- rich, collaboratively edited documents with real-time Yjs synchronization. Content is stored in MinIO (object storage), not in the database. Versioning is driven by session lifecycle events (room close, manual save, 30-minute autosave cron), not per-keystroke.
- **Views and Whiteboards** -- visual canvases for spatial arrangement of entities and freeform content.
- **Chat Threads** -- persistent conversations between users and AI agents, with rolling context summaries and personality fingerprint caching.

Synap is multi-workspace and multi-user. Each workspace has role-based access control (owner, admin, editor, viewer). AI agents are first-class users with their own workspace memberships and roles.

---

## 2. Architecture Overview

### Monorepo Structure

Synap backend is a pnpm monorepo managed with Turborepo. The packages build in a strict dependency chain:

```
@synap-core/core  -->  @synap/database  -->  @synap-core/types  -->  @synap/jobs  -->  @synap/api
```

| Package             | Purpose                                                                               |
| ------------------- | ------------------------------------------------------------------------------------- |
| `@synap-core/core`  | Shared utilities: logging, config, constants                                          |
| `@synap/database`   | Drizzle ORM schema, migrations, repositories, pgvector                                |
| `@synap-core/types` | Shared TypeScript types, event definitions (uses relative paths into database schema) |
| `@synap/jobs`       | pg-boss job definitions, background workers, side-effect emitter                      |
| `@synap/api`        | tRPC routers, REST routes, permission checks, audit logging                           |
| `apps/api`          | Entrypoint that boots the API server on port 4000                                     |

Additional packages: `packages/realtime` (Yjs WebSocket server), `packages/hub-protocol` (REST bridge to Intelligence Hub), `packages/search` (Typesense integration), `packages/storage` (MinIO abstraction), `packages/auth` (Ory Kratos/Hydra integration), `packages/ai-embeddings` (embedding generation).

**Important:** `@synap/database` must NOT depend on `@synap-core/types` -- this would create a circular dependency. The database package keeps local copies of event type helpers in `create-unified-event.ts`.

### Docker Compose Deployment

All infrastructure is defined in `deploy/docker-compose.yml`. Services:

| Service           | Technology            | Purpose                                               |
| ----------------- | --------------------- | ----------------------------------------------------- |
| `backend`         | Node.js (port 4000)   | API server (tRPC + REST)                              |
| `realtime`        | Node.js (port 4001)   | Yjs WebSocket server for document collaboration       |
| `postgres`        | PostgreSQL + pgvector | Primary database                                      |
| `minio`           | MinIO                 | Object storage for document content, files, snapshots |
| `typesense`       | Typesense             | Full-text search engine                               |
| `kratos`          | Ory Kratos            | Identity and authentication                           |
| `hydra`           | Ory Hydra             | OAuth2/OIDC provider                                  |
| `caddy`           | Caddy                 | Reverse proxy / TLS termination                       |
| `backend-migrate` | Node.js (one-shot)    | Runs Drizzle migrations on startup                    |

Database credentials: user `synap`, database `synap`.

### Intelligence Hub

The Intelligence Hub is a separate service (`intelligence-service:3001`) that runs the multi-agent AI system. It communicates with the backend over REST via the Hub Protocol, authenticated with `HUB_PROTOCOL_API_KEY`.

The two services run on separate Docker networks by default. To enable communication, use the colocated compose override:

```bash
docker compose -f docker-compose.yml -f docker-compose.colocated.yml up -d intelligence-service
```

### Hub Protocol

The Hub Protocol (`packages/hub-protocol`) is the REST bridge between the backend and Intelligence Hub. It provides typed client functions for all hub operations:

- Thread management: `createThread()`, `postMessage()`
- Memory: `rememberFact()`, `recallFacts()`, `recallFactsSemantic()`
- Entities: search, create, update via hub tools
- Graph: `traverseGraph()` for entity relation traversal
- Context: thread summaries, personality fingerprints

All Hub Protocol REST routes live under `/api/hub/*` on the backend side.

---

## 3. Data Model

### Users and Identity

Users are managed by Ory Kratos (external identity provider). The backend stores user profiles and workspace memberships. There are two categories of users:

- **Human users** -- authenticated via Kratos sessions
- **AI agent users** -- first-class user records with their own workspace roles, created via `POST /agent-users`. When an agent acts, it operates under its own role, not the triggering human's role.

### Workspaces and Projects

- **Workspaces** -- top-level organizational boundary. All entities, documents, and permissions are scoped to a workspace.
- **Projects** -- optional grouping within a workspace. Projects can have their own member lists with per-project roles.

### Entities

The core knowledge primitive. Every entity has:

- A `subjectType` (note, task, contact, meeting, idea, project, etc. -- 19 types total)
- A flexible JSONB `properties` field for type-specific data
- Workspace and project scoping
- Vector embeddings (pgvector) for semantic search

### Documents

- Content stored in MinIO as Yjs binary snapshots
- Real-time collaboration via Yjs WebSocket (debounced persistence every 10 seconds)
- The `documents.content` JSONB column in the database is legacy and always `{}`
- Versioning: `currentVersion` and `lastSavedVersion` are updated on session close, manual save, autosave cron (30 min), and proposal accept
- `document_sessions` table tracks active editing sessions

### Relations (Entity Graph)

Entities are connected via typed relations stored in the `relations` table. Supported relationship types include `referenced`, `parent`, `child`, `related`, and others. The graph is traversable via `traverseEntityGraph()` in the relation repository, exposed as `GET /api/hub/graph/traverse`.

### Knowledge Facts (Semantic Memory)

The `knowledge_facts` table stores persistent memory facts with vector embeddings. Facts support both keyword search and cosine-distance semantic search (`searchFactsSemantic()`). This is the AI memory system -- agents can `remember_fact` and later recall relevant context.

### Chat Threads and Messages

- `chat_threads` table with metadata JSONB for cached personality fingerprints and context summaries
- `conversation_messages` for message history
- Threads support parent-child hierarchy for multi-agent branching (dispatch agent creates child threads)

---

## 4. Permission System (RBAC)

### Workspace Roles

Role hierarchy (higher number = more permissions):

```
viewer (1)  <  editor (2)  <  admin (3)  <  owner (4)
```

Enforced by `requireWorkspaceRole()` in `packages/api/src/utils/workspace-permissions.ts`. A user must be a workspace member with at least the minimum required role for the operation.

### Permission Check Flow

The central permission function is `checkPermissionOrPropose()` in `packages/api/src/utils/permission-check.ts`. It performs a 3-level check:

1. **No workspace** -- auto-granted (personal resource)
2. **Workspace role check** -- map action to required permission, verify via `verifyPermission()`
3. **AI policy evaluation** -- determines whether an AI action is auto-approved or requires human review

The three possible outcomes:

| Result                           | Meaning                                        |
| -------------------------------- | ---------------------------------------------- |
| `{ granted: true }`              | Permission granted, proceed with operation     |
| `{ granted: false, proposalId }` | Proposal created, awaiting human review        |
| `{ denied: true, reason }`       | Hard deny (no membership or insufficient role) |

### AI Agent Users

AI agents are first-class users with workspace memberships. When `agentUserId` is provided:

- The agent's own workspace role determines permissions (not the triggering human's role)
- `requireReviewFor` is a per-event-type override list -- if the event type is listed, a proposal is created instead of auto-executing
- For non-agent AI sources (legacy path), the workspace-level `aiAutoApprove` toggle determines behavior

---

## 5. CRUD Flow

The current architecture uses a synchronous request path with async side-effects:

```
Client Request
  --> tRPC Router
    --> checkPermissionOrPropose()
      --> Direct DB write (repository)
        --> auditLog() (fire-and-forget to events table)
        --> emitSideEffects via pg-boss (async)
  <-- Immediate response to client
```

This replaced the earlier 7-hop async pipeline (request event -> Inngest validator -> validated event -> executor -> DB -> completed event -> side-effects). The new path returns responses immediately.

### Side-Effect Dispatch

After the synchronous DB write, background jobs are dispatched via pg-boss for:

- Search index updates (Typesense)
- Entity embedding generation (pgvector)
- Webhook delivery
- Notification broadcast

### Event Audit Trail

The `events` table serves as an immutable audit log. Every mutation records an event with the format `{subjectType}.{action}.{phase}` (e.g., `entity.create.completed`). The `auditLog()` helper in `packages/api/src/utils/audit-log.ts` writes these entries fire-and-forget.

`BaseRepository` in `packages/database/src/repositories/base-repository.ts` automatically emits `completed` events after successful create/update/delete operations.

---

## 6. Intelligence Hub Integration

### Multi-Agent System

The Intelligence Hub runs 7 agent types:

| Agent              | Purpose                                                      |
| ------------------ | ------------------------------------------------------------ |
| `mvp-chat`         | General-purpose conversational agent                         |
| `dispatch`         | Routes requests to specialized agents, creates child threads |
| `knowledge-search` | Searches entities, memory facts, and graph relations         |
| `code`             | Code generation and analysis                                 |
| `writing`          | Long-form writing assistance                                 |
| `action`           | Executes mutations (create/update entities, remember facts)  |
| `meta`             | Self-reflective agent for system introspection               |

### Tools

Agents have access to two categories of tools:

**Context tools** (read-only):

- `search_entities` -- full-text and semantic entity search
- `memory_search` -- recall knowledge facts (semantic first, keyword fallback)
- `graph_traverse` -- walk the entity relation graph

**Action tools** (mutating):

- `create_entity`, `update_entity` -- entity CRUD via Hub Protocol
- `remember_fact` -- persist a knowledge fact to semantic memory

### AI Agent User Flow

```
Client sends agentUserId
  --> Intelligence Hub receives request
    --> Agent selects tool (e.g., create_entity)
      --> Tool calls Hub Protocol REST endpoint with agentUserId
        --> Backend checks agent's workspace role via checkPermissionOrPropose()
          --> Granted / Proposed / Denied
```

### Context and Memory

- **Thread context**: `context-compressor.ts` produces a summary + personality fingerprint + linked context + memory facts, with an 8-second timeout to never block the main agent
- **Personality fingerprint**: LLM extracts tone/style from the last 8 assistant messages, cached in thread metadata with a 6-hour staleness window
- **Rolling summaries**: compressor fires-and-forgets `updateThreadContext()` after generating each summary
- **Semantic memory**: knowledge facts with pgvector embeddings, cosine-distance search via `searchFactsSemantic()`

---

## 7. Event and Audit System

### Events Table

The `events` table is the system's audit trail. Every mutation is recorded as an event with:

- `subjectType` -- singular entity type (e.g., `entity`, `document`, `workspace`)
- `action` -- the operation (`create`, `update`, `delete`)
- `phase` -- lifecycle stage (`requested`, `validated`, `completed`, `denied`)
- `subjectId` -- the ID of the affected resource
- `userId`, `workspaceId` -- who did it and where
- `data` -- JSONB payload with operation details

Event format: `{subjectType}.{action}.{phase}` -- always singular subject type.

The single source of truth for `SubjectType`, `EventAction`, and `EventPhase` enums is `packages/types/src/events/unified.ts`.

### Audit Trail Only

Events are now purely an audit trail. They are written directly by `auditLog()` and `BaseRepository.emitCompleted()` -- there is no event processor or forwarding pipeline. The events table is append-only and never read by the application logic (only for debugging and compliance).

---

## 8. Side-Effect Workers (pg-boss)

Background jobs are managed by pg-boss, a PostgreSQL-based job queue. Key workers:

| Job                         | Purpose                                                  |
| --------------------------- | -------------------------------------------------------- |
| `search-index`              | Sync entity/document changes to Typesense                |
| `entity-embedding`          | Generate/update pgvector embeddings via Intelligence Hub |
| `webhook-delivery`          | Deliver outbound webhooks to registered endpoints        |
| `workspace-init`            | Initialize new workspace defaults (roles, settings)      |
| `background-task-scheduler` | Proactive AI automation (scheduled tasks)                |

### Cron Jobs

- Document autosave: 30-minute interval, creates snapshots for active documents
- Whiteboard autosave: periodic snapshot of whiteboard state

---

## 9. Key Files Quick Reference

| File                                                         | Purpose                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| `packages/types/src/events/unified.ts`                       | SubjectType, EventAction, EventPhase enums (source of truth) |
| `packages/database/src/repositories/base-repository.ts`      | Base class -- auto-emits completed events after DB writes    |
| `packages/database/src/repositories/entity-repository.ts`    | Entity CRUD with property indexing                           |
| `packages/database/src/repositories/document-repository.ts`  | Document CRUD, versioning, session management                |
| `packages/database/src/repositories/relation-repository.ts`  | Entity relations + `traverseEntityGraph()`                   |
| `packages/database/src/repositories/knowledge-repository.ts` | Knowledge facts + `searchFactsSemantic()`                    |
| `packages/database/src/repositories/event-repository.ts`     | Events table access (audit log)                              |
| `packages/api/src/utils/permission-check.ts`                 | `checkPermissionOrPropose()` -- central permission gate      |
| `packages/api/src/utils/workspace-permissions.ts`            | `requireWorkspaceRole()` -- RBAC enforcement                 |
| `packages/api/src/utils/audit-log.ts`                        | `auditLog()` -- fire-and-forget event recording              |
| `packages/api/src/routers/agent-users.ts`                    | AI agent user CRUD endpoints                                 |
| `packages/api/src/routers/hub-protocol-rest.ts`              | Hub Protocol REST routes (entity, memory, graph)             |
| `packages/api/src/routers/entities.ts`                       | Entity tRPC router                                           |
| `packages/api/src/routers/documents.ts`                      | Document tRPC router                                         |
| `packages/api/src/routers/proposals.ts`                      | Proposal review/approve/reject                               |
| `packages/jobs/src/boss.ts`                                  | pg-boss client (start/stop)                                  |
| `packages/jobs/src/emit-side-effects.ts`                     | Enqueue async side-effects after CRUD                        |
| `packages/jobs/src/workers/index.ts`                         | Register all pg-boss queue handlers                          |
| `packages/jobs/src/cron.ts`                                  | Cron schedule registration                                   |
| `packages/hub-protocol/`                                     | REST client for Intelligence Hub communication               |
| `packages/realtime/`                                         | Yjs WebSocket server for document collaboration              |
| `packages/search/`                                           | Typesense search integration                                 |
| `packages/storage/`                                          | MinIO object storage abstraction                             |
| `deploy/docker-compose.yml`                                  | Full infrastructure definition                               |
| `migrations/`                                                | Drizzle SQL migrations                                       |

---

## 10. Getting Started (Developer)

### Prerequisites

- Docker and Docker Compose
- Node.js 20+
- pnpm 9+

### Setup

```bash
# Clone the repository
git clone <repo-url> && cd synap-backend

# Copy environment template and configure
cp deploy/.env.example deploy/.env
# Edit deploy/.env with required secrets:
#   POSTGRES_PASSWORD, JWT_SECRET, KRATOS_SECRETS_COOKIE,
#   KRATOS_SECRETS_CIPHER, MINIO_ACCESS_KEY, MINIO_SECRET_KEY,
#   TYPESENSE_API_KEY, TYPESENSE_ADMIN_API_KEY

# Start all services
cd deploy
docker compose up -d

# Migrations run automatically via the backend-migrate service.
# The backend service waits for migrations to complete before starting.
```

### Building from Source

```bash
# Install dependencies
pnpm install

# Build all packages (respects dependency chain via Turborepo)
pnpm build

# Build only the backend Docker image
cd deploy && docker compose build backend
```

### Integration Tests

```bash
# Tests live in tests/integration/
# Each test is a numbered shell script (01-health.sh through 54+)
# Configure backend URL in tests/integration/config.sh
cd tests/integration
./run-all.sh
```

The test suite covers health checks, entity CRUD, document operations, permissions, proposals, relations, cross-thread linking, agent users, and more. As of the last run: 54 tests passing, 0 failures, 3 skips (proposals/SSE edge cases).

### Key Environment Variables

| Variable               | Purpose                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| `DATABASE_URL`         | PostgreSQL connection string                                       |
| `INTELLIGENCE_HUB_URL` | Intelligence Hub internal URL (`http://intelligence-service:3001`) |
| `HUB_PROTOCOL_API_KEY` | API key for Hub Protocol authentication                            |
| `ADMIN_EMAIL`          | Email address for admin user (bypasses invite requirement)         |
| `MINIO_ENDPOINT`       | MinIO endpoint (`http://minio:9000` in Docker)                     |
| `TYPESENSE_HOST`       | Typesense hostname                                                 |

### Common Operations

```bash
# Rebuild and restart backend only
cd deploy && docker compose build backend && docker compose up -d backend

# View backend logs
cd deploy && docker compose logs -f backend

# Reset event processor watermark (if events are replaying)
docker compose stop backend
docker compose exec postgres psql -U synap -d synap \
  -c "UPDATE system_settings SET value = NOW()::text WHERE key = 'event_processor_watermark';"
docker compose start backend

# Run with Intelligence Hub (colocated networking)
docker compose -f docker-compose.yml -f docker-compose.colocated.yml up -d intelligence-service
```
