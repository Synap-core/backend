# Synap Backend - Architecture Reference

**AI-Optimized Single Source of Truth**

> **Purpose**: This document provides a complete, concise overview of the Synap Backend for AI assistants and developers. Read this first before contributing.

---

## Product Overview

**Synap is a Personal Data Operating System.**

- **Type**: Event-sourced backend providing "Workspace as a Service"
- **Philosophy**: User owns a private "Data Pod" (sovereign instance), not a SaaS tenant
- **Primary Use Case**: Intelligent personal knowledge management with multi-agent AI
- **Key Differentiator**: Events as the universal primitive - every action is an immutable event

---

## Core Capabilities

1. **Event Sourcing**: Every state change is an event. Infinite undo/replay.
2. **Knowledge Graph**: Auto-linked entities with semantic relationships
3. **Intelligence Services Architecture**: Any developer can build external AI services that connect to the Data Pod via Hub Protocol. Your AI, your rules.
4. **Hub Protocol**: Bidirectional protocol for external "Intelligence Services"
5. **Real-time Sync**: SSE-based event streaming to clients
6. **Data Sovereignty**: Self-hostable or private managed instance

---

## Architecture Principles

### 1. Pure Event-Driven Flow

```
UI/CLI → tRPC API → Emit Event → Inngest → Worker → Database/Storage
```

- **No direct writes** to database from API layer
- All mutations go through events
- Events are the source of truth (TimescaleDB)

### 2. CQRS (Command Query Responsibility Segregation)

- **Commands**: Via tRPC mutations → Events → Workers (write path)
- **Queries**: Via tRPC queries → Direct DB reads (read path)
- Database tables are **projections** of the event log

### 3. Hub & Spoke Model

- **Data Pod** = Hub (Central authority, owns data)
- **Intelligence Services** = Spokes (External AI, access via Hub Protocol)
- **Hub Protocol** = Secure, bidirectional API for data access

---

## The "Lego Bricks" Philosophy

Synap is built on a **composable architecture** where entities and documents are universal building blocks.

### The Building Blocks

1. **Entities** (`entities` table): Metadata nodes (tasks, notes, files, people)
2. **Documents** (`documents` table): Content storage (markdown, code, PDFs)
3. **Relations** (`relations` table): Connections between entities
4. **Views** (`views` table): Different ways to assemble/visualize entities

### Assembly Mechanisms

**Humans assemble via Views**:
- `table` - Spreadsheet view of entities
- `kanban` - Board columns (tasks by status)
- `timeline` - Chronological view
- `whiteboard` - Freeform canvas with positioned entities
- `mindmap` - Hierarchical tree
- `graph` - Network visualization

**AI assembles via Hub Protocol**:
- Reads entity graph
- Creates proposals (pending entities)
- Waits for human validation

### Human-in-the-Loop (Proposals)

Synap's unique advantage is the **proposals system** - AI suggestions pause as "draft entities":

1. AI submits insight → `entity.creation.requested` event
2. Worker creates `Proposal` (status: `pending`)
3. User reviews in UI
4. User approves → Worker converts to real entity
5. User rejects → Stays in proposals table for audit

**Proposal States**: `pending`, `validated`, `rejected`

This is only possible because:
- Events have lifecycle states
- Proposals table is separate from entities
- State transitions are events

### Example: Building a Second Brain

```
Bricks:
- 500 note entities
- 50 person entities
- 1000 relation entities

Assemblies:
- Table view: All notes, sortable
- Graph view: Visual network
- Timeline view: Chronological
- AI-generated summary notes (via proposals)
```

The same entities, infinite perspectives.

**See**: [Composable Architecture](../docs/concepts/composable-architecture) for deep dive

---

## Real-Time Architecture

Synap uses **Server-Sent Events (SSE)** for real-time updates, not WebSockets or tRPC subscriptions.

### How It Works

```
Worker completes task → broadcastSuccess() → POST to realtime.synap.app
                                                    ↓
                                         Cloudflare Durable Objects
                                                    ↓
                                         SSE → Connected Clients
```

### Implementation

- **SSE Endpoint**: `/admin/events/stream` (admin dashboard)
- **Broadcast Manager**: `packages/api/src/event-stream-manager.ts`
- **Worker Integration**: `packages/jobs/src/utils/realtime-broadcast.ts`

### For External Clients

Intelligence Services can receive real-time updates via webhook subscriptions:

```typescript
POST /trpc/webhooks.create
{
  "targetUrl": "https://your-service.com/webhook",
  "events": ["note.created", "task.completed"]
}
```

Workers automatically deliver events to registered webhooks via `webhook-broker`.

---

## Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Runtime** | Node.js 20+ | Server execution |
| **Database** | PostgreSQL 16 + TimescaleDB + pgvector | Events, entities, vector search |
| **Event Bus** | Inngest | Event routing and workers |
| **API** | tRPC + Hono | Type-safe APIs |
| **ORM** | Drizzle ORM | Database access |
| **Auth** | Ory Kratos + Hydra (optional) | User auth + OAuth2 |
| **Storage** | Cloudflare R2 / MinIO | File/blob storage |
| **AI** | LangGraph + Vercel AI SDK | Agent orchestration |
| **Package Manager** | pnpm | Workspace management |

---

## Monorepo Structure

```
synap-backend/
├── apps/
│   └── api/              # Main Data Pod API server
├── packages/
│   ├── api/              # tRPC routers
│   ├── database/         # Drizzle schema, migrations
│   ├── events/           # Event types (55 total)
│   ├── jobs/             # Inngest workers
│   ├── domain/           # Business logic
│   ├── auth/             # Authentication logic
│   ├── ai/               # LangGraph agents
│   └── client/           # TypeScript SDK (@synap/client)
└── services/
    └── intelligence/     # Example external service
```

---

## Key Components

### 1. Event Store (`events` table)

- **Schema**: `id`, `type`, `workspace_id`, `payload`, `metadata`, `created_at`
- **Retention**: Infinite (core principle)
- **Access**: Via Inngest workers or direct queries

### 2. Entities (Core Data Model)

All user data stored as **Entities**:

- `notes`, `tasks`, `projects`, `files`, `contacts`, `events`, `tags`, `relations`
- Each entity type has:
  - Row in `entities` table (metadata)
  - Content in R2/MinIO
  - Events in `events_v2`

### 3. tRPC Routers

Located in `packages/api/src/routers/`:

- `notes.ts`, `tasks.ts`, `projects.ts`, `files.ts`, etc.
- Each router emits events, not direct DB writes

### 4. Inngest Workers

Located in `packages/jobs/src/`:

- **Event Dispatcher**: Routes events to handlers
- **Global Validator**: Processes proposals (AI-suggested changes)
- **Handlers**: One per entity type (e.g., `NoteCreationHandler`)

### 5. Hub Protocol

API for external services to access Data Pod:

- **Endpoint**: `/trpc/hubProtocol.*`
- **Auth**: API Keys with scopes OR OAuth2 Client Credentials
- **Methods**: `generateAccessToken`, `createEntity`, `queryEntities`

---

## Data Flow Examples

### Simple Flow: Create Note

```
1. Client → notes.create() (tRPC)
2. API validates input
3. API emits event: note.creation.requested
4. Inngest dispatches to NoteCreationHandler
5. Handler:
   - Uploads content to R2
   - Inserts entity row in DB
   - Emits note.creation.completed
6. Client receives real-time notification
```

### Complex Flow: AI-Powered Insight

```
1. Client → chat.sendMessage()
2. API → Local agent analyzes intent
3. Agent determines need for external AI
4. Agent calls Intelligence Service (Hub Protocol)
5. Service requests Data Pod access token
6. Service reads user data via Hub Protocol
7. Service processes with AI
8. Service submits insight (creates entities via Hub Protocol)
9. Hub Protocol emits events (e.g., task.creation.requested)
10. Workers process events → entities created
11. Client receives real-time updates
```

---

## Extension Points

### 1. Add New Entity Type

**Files to modify**:
- `packages/database/src/schema/entities.ts` (add table)
- `packages/events/src/types.ts` (add event types)
- `packages/api/src/routers/` (create router)
- `packages/jobs/src/handlers/` (create handler)
- `packages/client/` (export types)

**Pattern**:
```typescript
// 1. Schema
export const myEntities = pgTable('my_entities', { ... });

// 2. Events
export type MyEntityCreationRequestedEvent = { ... };

// 3. Router
export const myRouter = router({
  create: protectedProcedure.mutation(async ({ input, ctx }) => {
    await ctx.events.emit('myEntity.creation.requested', input);
  })
});

// 4. Handler
export class MyEntityCreationHandler implements IEventHandler {
  eventType = 'myEntity.creation.requested';
  async handle(event: SynapEvent) { /* create entity */ }
}
```

### 2. Add AI Agent

**The Intelligence Services Model**:

Synap's "multi-agent" architecture is about **external Intelligence Services**, not built-in agents. Anyone can create a separate AI service that:

1. Registers with the Data Pod via Hub Protocol
2. Receives events or responds to user requests
3. Processes with ANY AI model (OpenAI, Anthropic, local, custom)
4. Submits insights back to the Data Pod

**Example: Building a Custom Intelligence Service**

```typescript
// Your separate service: my-ai-analyzer/
import { Hono } from 'hono';
import { HubProtocolClient } from '@synap/hub-protocol';

const app = new Hono();

app.post('/analyze', async (c) => {
  const { threadId, dataPodUrl, apiKey } = await c.req.json();
  
  // 1. Connect to user's Data Pod
  const hub = new HubProtocolClient(dataPodUrl, apiKey);
  
  // 2. Read data
  const context = await hub.getThreadContext({ threadId });
  
  // 3. Process with YOUR AI
  const analysis = await yourCustomAI.analyze(context);
  
  // 4. Submit insights
  await hub.createEntity({
    type: 'task',
    title: analysis.suggestedTask,
    metadata: { aiGenerated: true, confidence: 0.95 }
  });
  
  return c.json({ success: true });
});
```

**For Internal Agents** (optional):

If you want agents inside the Data Pod, use LangGraph. Place in `packages/ai/src/agents/`.

```typescript
import { StateGraph } from '@langchain/langgraph';

export function createMyAgent() {
  const graph = new StateGraph<MyState>();
  
  graph.addNode('step1', async (state) => { /* ... */ });
  graph.addNode('step2', async (state) => { /* ... */ });
  
  graph.setEntryPoint('step1');
  graph.addEdge('step1', 'step2');
  
  return graph.compile();
}
```

**Integrate** via tRPC router or event handler.

### 3. Add External Intelligence Service

**This is the primary extensibility model for AI in Synap.**

Create a separate service that:

1. **Registers** with Data Pod: `POST /trpc/intelligenceRegistry.register`
2. **Implements** Hub Protocol client
3. **Subscribes** to events or responds to requests
4. **Submits** insights via `hubProtocol.createEntity`

**Architecture**:

```
User → Data Pod → Intelligence Service (YOUR AI)
                      ↓
                 Any AI Model
                 (GPT-4, Claude, Llama, Custom)
                      ↓
                 Insights/Entities
                      ↓
         ← Hub Protocol ← Data Pod
```

**Benefits**:
- Run on separate infrastructure (GPU, serverless, etc.)
- Use any AI provider
- Keep proprietary logic private
- Scale independently
- Multi-tenant by design

**Reference Implementation**: `services/intelligence/` (example in repo)

---

## Security Model

### Authentication

1. **User Auth**: Ory Kratos (email/password, OAuth providers)
2. **API Keys**: For machine clients (Hub Protocol)
   - Stored in `api_keys` table
   - Scopes: `read`, `write`, `admin`
3. **OAuth2** (Optional): Ory Hydra for Intelligence Services

### Authorization

- **Row-Level Security** via `workspace_id`
- All queries filtered by `ctx.user.workspaceId`
- Events tagged with workspace

---

## Environment Variables

**Required**:
- `DATABASE_URL`: PostgreSQL connection string
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`: Cloudflare R2
- `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`: Inngest

**Optional**:
- `ENABLE_OAUTH2`: Enable OAuth2 flow
- `HYDRA_PUBLIC_URL`, `HYDRA_ADMIN_URL`: Ory Hydra endpoints
- `HUB_PROTOCOL_API_KEY`: Master key for Intelligence Service
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`: AI providers

---

## Development Commands

```bash
# Install dependencies
pnpm install

# Start local services (Postgres, MinIO)
docker compose up -d

# Database migrations
pnpm --filter database db:migrate

# Start dev server
pnpm dev

# Build all packages
pnpm build

# Run tests
pnpm test

# Type check
pnpm typecheck
```

---

## Common Tasks

### Add New tRPC Router

```bash
# 1. Create router file
touch packages/api/src/routers/my-router.ts

# 2. Implement router
export const myRouter = router({ ... });

# 3. Register in app router
// packages/api/src/router.ts
import { myRouter } from './routers/my-router.js';
export const appRouter = router({
  // ... existing
  my: myRouter,
});
```

### Add Database Table

```bash
# 1. Define schema
# packages/database/src/schema/my-table.ts
export const myTable = pgTable('my_table', { ... });

# 2. Export from index
# packages/database/src/schema/index.ts
export * from './my-table.js';

# 3. Generate migration
pnpm --filter database db:generate

# 4. Apply migration
pnpm --filter database db:migrate
```

### Add Event Type

```typescript
// packages/events/src/types.ts
export type MyCustomEvent = {
  type: 'my.custom.event';
  payload: { ... };
};

// packages/events/src/payloads.ts
export const MyCustomEventPayloadSchema = z.object({ ... });
```

---

## Critical Concepts for AI Understanding

### 1. Events Are Immutable

- **Never delete** events
- **Never update** events
- To "undo", emit a reversal event

### 2. Workers Are Idempotent

- Workers can run multiple times
- Use `event.id` for deduplication
- Use transactions for atomic operations

### 3. Proposals Pattern

For AI-suggested changes:

```
1. AI creates Proposal (via hubProtocol.createEntity)
2. Proposal stored in `proposals` table
3. User reviews/approves
4. Global Validator converts to real events
```

### 4. Hub Protocol is Stateless

- Each request includes Data Pod URL + API Key
- No session state on Intelligence Service
- Token generation is on-demand

---

## Architectural Decisions

### Why Event Sourcing?

- **Time-travel**: Replay state at any point
- **Audit log**: Complete history
- **AI-friendly**: Event stream is perfect for agent consumption

### Why Hub & Spoke vs Monolith?

- **Extensibility**: Anyone can build Intelligence Services
- **Data Sovereignty**: User controls what services access
- **Scalability**: External services scale independently

### Why tRPC?

- **Type safety**: End-to-end TypeScript
- **Developer Experience**: Auto-complete, no code generation
- **Simplicity**: No GraphQL complexity

### Why Inngest vs Bull/BullMQ?

- **Declarative**: Function-as-workflow
- **Observability**: Built-in dashboard
- **Reliability**: Automatic retries, idempotency

---

## Troubleshooting Guide

### Events not processing?

1. Check Inngest dashboard: `http://localhost:8288`
2. Verify `INNGEST_EVENT_KEY` matches
3. Check worker logs: `pnpm --filter jobs dev`

### Database connection issues?

1. Verify Postgres is running: `docker compose ps`
2. Check `DATABASE_URL` format
3. Test connection: `pnpm --filter database db:status`

### Type errors in client?

1. Rebuild packages: `pnpm build`
2. Regenerate types: `pnpm --filter client build`
3. Restart TS server in IDE

---

## API Reference

### Complete Event List (55 Types)

- **Notes**: `note.creation.requested`, `note.update.requested`, `note.deletion.requested`
- **Tasks**: `task.creation.requested`, `task.update.requested`, `task.completion.requested`
- **Projects**: `project.creation.requested`, `project.update.requested`
- **Files**: `file.upload.requested`, `file.deletion.requested`
- **Relations**: `relation.creation.requested`, `relation.deletion.requested`
- **Tags**: `tag.creation.requested`, `tag.assignment.requested`
- **Plus**: Contacts, Events, Settings, Preferences, Approvals

See: `packages/events/src/types.ts` for complete list

### tRPC Endpoints

All endpoints follow pattern: `/trpc/[router].[method]`

**Core Routers**:
- `notes`, `tasks`, `projects`, `files`, `contacts`, `events`, `tags`, `relations`
- `auth`, `workspaces`, `preferences`, `search`
- `hubProtocol`, `intelligenceRegistry`
- `proposals` (AI-suggested changes)

---

## Next Steps for New Contributors

1. **Read this document** (you're here!)
2. **Set up environment**: `pnpm install && docker compose up -d`
3. **Run migrations**: `pnpm --filter database db:migrate`
4. **Start dev server**: `pnpm dev`
5. **Read code**: Start with `packages/api/src/routers/notes.ts`
6. **Make small change**: Add a field to notes
7. **Test change**: Use API client to verify

---

## License

Proprietary - Synap Core

---

**For detailed documentation**: See `/docs` folder (Docusaurus site)

**For AI agents**: This document contains 95% of what you need to help users effectively.
