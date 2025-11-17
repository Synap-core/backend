# 🏛️ Synap Backend - Architecture

**Technical documentation for developers and architects**

---

## 🎯 Design Philosophy

### Core Principles

1. **Event-Driven First**: Inngest is the central event bus - all communication goes through events
2. **CQRS Pattern**: Commands (writes) publish events, Queries (reads) access projections directly
3. **Event Sourcing**: TimescaleDB event store is the single source of truth (immutable history)
4. **Hybrid Storage**: PostgreSQL for metadata, R2/MinIO for content (strict separation)
5. **Type-Safe**: TypeScript strict mode + Zod runtime validation (SynapEvent schema)
6. **Local-First**: SQLite for single-user, PostgreSQL for multi-user
7. **LLM-Agnostic**: Switch AI providers with configuration

---

## 🧱 System Architecture

### Event-Driven Architecture Overview

Synap Backend follows a **pure event-driven architecture** with Inngest as the central event bus. All state changes flow through events, ensuring decoupling, scalability, and auditability.

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 1: API Layer (Event Producers)                          │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ Hono Server (Port 3000)                                 │  │
│  │  • CORS middleware                                      │  │
│  │  • Auth middleware (Better Auth / Simple Token)        │  │
│  │  • tRPC HTTP handler (/trpc/*)                         │  │
│  │  • Commands: Validate → Create SynapEvent → Publish     │  │
│  │  • Queries: Read directly from projections (fast)        │  │
│  │  • Returns: { status: 'pending', requestId } (async)    │  │
│  │  • Auth: Better Auth (PostgreSQL) / Simple Token (SQLite)│  │
│  └─────────────────────────────────────────────────────────┘  │
└───────────────────────────┬───────────────────────────────────┘
                            ↓ (publishes events)
┌─────────────────────────────────────────────────────────────────┐
│  Layer 2: Event Bus (Inngest) - Central Orchestrator           │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ Inngest Event Bus                                        │  │
│  │  • Receives events from API/Agents                       │  │
│  │  • Dispatches to registered handlers (IEventHandler)     │  │
│  │  • Retries on failure (automatic)                         │  │
│  │  • Event: 'api/event.logged'                             │  │
│  └─────────────────────────────────────────────────────────┘  │
└───────────────────────────┬───────────────────────────────────┘
                            ↓ (triggers handlers)
┌─────────────────────────────────────────────────────────────────┐
│  Layer 3: Worker Layer (Event Consumers)                        │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ @synap/jobs - Inngest Functions                          │  │
│  │  • EventDispatcher: Routes events to handlers            │  │
│  │  • NoteCreationHandler: note.creation.requested         │  │
│  │  • EmbeddingGeneratorHandler: note.creation.completed    │  │
│  │  • All business logic lives here (not in API)            │  │
│  └─────────────────────────────────────────────────────────┘  │
└───────────────────────────┬───────────────────────────────────┘
                            ↓ (updates projections)
┌─────────────────────────────────────────────────────────────────┐
│  Layer 4: Projection Layer (State Database)                   │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ @synap/database                                           │  │
│  │  • PostgreSQL: Metadata tables (entities, tags, etc.)  │  │
│  │  • pgvector: Embeddings (entity_vectors)                  │  │
│  │  • TimescaleDB: Event store (events_v2 hypertable)        │  │
│  │  • SQLite: Local single-user mode                         │  │
│  │  • RLS: Row-Level Security (PostgreSQL)                   │  │
│  └─────────────────────────────────────────────────────────┘  │
└───────────────────────────┬───────────────────────────────────┘
                            ↓ (stores content)
┌─────────────────────────────────────────────────────────────────┐
│  Layer 5: Storage Layer (Content Storage)                       │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ @synap/storage                                            │  │
│  │  • R2StorageProvider: Cloudflare R2 (production)         │  │
│  │  • MinIOStorageProvider: Local S3-compatible (dev)      │  │
│  │  • IFileStorage interface (abstraction)                   │  │
│  │  • Content stored here, metadata in PostgreSQL          │  │
│  └─────────────────────────────────────────────────────────┘  │
└───────────────────────────┬───────────────────────────────────┘
                            ↓ (used by workers)
┌─────────────────────────────────────────────────────────────────┐
│  Layer 6: AI Layer (Primitive Services)                         │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ @synap/ai                                                │  │
│  │  • ConversationalAgent: Claude 3 Haiku                  │  │
│  │  • Embeddings: OpenAI / Deterministic                   │  │
│  │  • Called by workers (not directly by API)                │  │
│  └─────────────────────────────────────────────────────────┘  │
└───────────────────────────┬───────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│  Layer 7: Core Infrastructure                                   │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ @synap/core                                              │  │
│  │  • Config: Centralized Zod-validated config             │  │
│  │  • Errors: Standardized error types (SynapError)        │  │
│  │  • Logger: Structured logging (Pino)                     │  │
│  │  • Types: SynapEvent schema (@synap/types)              │  │
│  └─────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🧩 Key Components

### 1. Hono API Server

**Location**: `apps/api/src/index.ts`

**Responsibilities**:
- HTTP server on port 3000
- CORS configuration
- Authentication (Better Auth or Simple Token)
- tRPC HTTP adapter mounting
- Health check endpoint
- Error handling with SynapError types

**Code snippet**:
```typescript
const app = new Hono();

app.use('*', cors({
  origin: getCorsOrigins(),
  credentials: true,
}));

app.get('/health', (c) => c.json({ status: 'ok' }));

app.use(
  '/trpc/*',
  authMiddleware, // Better Auth or Simple Token
  trpcServer({ router: appRouter, createContext })
);

// Error handler with standardized errors
app.onError((err, c) => {
  const synapError = isSynapError(err) ? err : toSynapError(err);
  return c.json(synapError.toJSON(), synapError.statusCode);
});
```

---

### 2. tRPC API Layer

**Location**: `packages/api/src/`

**Key Routers**:

#### `chat.sendMessage`
```typescript
sendMessage: protectedProcedure
  .input(z.object({
    threadId: z.string().uuid(),
    content: z.string(),
    limit: z.number().default(10)
  }))
  .mutation(async ({ ctx, input }) => {
    const userId = requireUserId(ctx.userId);
    
    // Store user message
    const message = await conversationService.appendMessage({
      threadId: input.threadId,
      role: 'user',
      content: input.content,
      userId,
    });
    
    // Get AI response
    const agent = getConversationalAgent();
    const response = await agent.run(input.content, {
      userId,
      threadId: input.threadId,
    });
    
    // Store AI response
    await conversationService.appendMessage({
      threadId: input.threadId,
      parentId: message.id,
      role: 'assistant',
      content: response.text,
      userId,
    });
    
    return { message, response };
  })
```

#### `notes.create`
```typescript
create: protectedProcedure
  .input(z.object({
    content: z.string().min(1),
    autoEnrich: z.boolean().default(true),
    useRAG: z.boolean().default(false),
    tags: z.array(z.string()).optional(),
  }))
  .mutation(async ({ ctx, input }) => {
    const userId = requireUserId(ctx.userId);
    
    const result = await noteService.createNote({
      userId,
      content: input.content,
      tags: input.tags,
      source: 'api',
      metadata: {
        inputType: 'text',
        autoEnrich: input.autoEnrich,
        useRAG: input.useRAG,
      },
    });
    
    return {
      success: true,
      note: {
        id: result.entityId,
        title: result.title,
        preview: result.preview,
        tags: input.tags ?? [],
      },
      entityId: result.entityId,
      fileUrl: result.fileUrl,
    };
  })
```

---

### 3. Domain Services

**Location**: `packages/domain/src/services/`

#### NoteService
```typescript
export class NoteService {
  constructor(
    private readonly database: typeof db = db,
    private readonly fileStorage: IFileStorage = storage
  ) {}

  async createNote(input: CreateNoteInput): Promise<CreateNoteResult> {
    // 1. Create entity
    const entityId = randomUUID();
    await this.database.insert(entities).values({
      id: entityId,
      userId: input.userId,
      type: 'note',
      title: input.metadata?.title,
      preview: input.content.substring(0, 200),
    });

    // 2. Store content in storage (R2/MinIO)
    const storagePath = this.fileStorage.buildPath(
      input.userId,
      'note',
      entityId,
      'md'
    );
    const fileMetadata = await this.fileStorage.upload(
      storagePath,
      input.content,
      { contentType: 'text/markdown' }
    );

    // 3. Emit event
    await eventService.appendEvent({
      userId: input.userId,
      aggregateType: 'entity',
      aggregateId: entityId,
      eventType: 'entity.created',
      data: {
        entityId,
        type: 'note',
        title: input.metadata?.title,
        fileUrl: fileMetadata.url,
        filePath: fileMetadata.path,
      },
      source: input.source,
    });

    return {
      entityId,
      title: input.metadata?.title,
      preview: input.content.substring(0, 200),
      fileUrl: fileMetadata.url,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }
}
```

#### ConversationService
```typescript
export class ConversationService {
  async appendMessage(input: AppendMessageInput): Promise<ConversationMessage> {
    // Hash-chained messages for tamper-proof conversations
    const previousHash = await this.getLastMessageHash(input.threadId);
    const messageHash = this.computeMessageHash({
      content: input.content,
      role: input.role,
      previousHash,
    });

    const message = await this.conversationRepository.createMessage({
      threadId: input.threadId,
      userId: input.userId,
      role: input.role,
      content: input.content,
      parentId: input.parentId,
      hash: messageHash,
      previousHash,
    });

    return message;
  }
}
```

---

### 4. Storage Abstraction

**Location**: `packages/storage/src/`

**Interface**:
```typescript
export interface IFileStorage {
  upload(path: string, content: string | Buffer, options?: UploadOptions): Promise<FileMetadata>;
  download(path: string): Promise<string>;
  downloadBuffer(path: string): Promise<Buffer>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  getMetadata(path: string): Promise<FileInfo>;
  getSignedUrl(path: string, expiresIn?: number): Promise<string>;
  buildPath(userId: string, entityType: string, entityId: string, extension?: string): string;
}
```

**Providers**:
- **R2StorageProvider**: Cloudflare R2 (production)
- **MinIOStorageProvider**: MinIO (local development)

**Factory Pattern**:
```typescript
export function createFileStorageProvider(): IFileStorage {
  const config = getConfig();
  const provider = config.storage.provider;

  switch (provider) {
    case 'r2':
      return new R2StorageProvider({
        accountId: config.storage.r2AccountId,
        accessKeyId: config.storage.r2AccessKeyId,
        secretAccessKey: config.storage.r2SecretAccessKey,
        bucketName: config.storage.r2BucketName,
        publicUrl: config.storage.r2PublicUrl,
      });
    case 'minio':
      return new MinIOStorageProvider({
        endpoint: config.storage.minioEndpoint,
        accessKeyId: config.storage.minioAccessKeyId,
        secretAccessKey: config.storage.minioSecretAccessKey,
        bucketName: config.storage.minioBucketName,
      });
  }
}
```

---

### 5. Database Layer

**Location**: `packages/database/src/`

#### Event Repository
```typescript
export class EventRepository {
  async appendEvent(input: AppendEventInput): Promise<EventRecord> {
    // Optimistic locking with version
    const version = await this.getNextVersion(input.aggregateType, input.aggregateId);
    
    const event: EventRecord = {
      id: randomUUID(),
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      eventType: input.eventType,
      version,
      userId: input.userId,
      data: input.data,
      metadata: input.metadata,
      timestamp: new Date(),
      source: input.source,
    };

    await this.db.insert(events).values(event);
    return event;
  }
}
```

#### Database Factory
```typescript
export async function createDatabaseClient(): Promise<DatabaseClient> {
  const dialect = (process.env.DB_DIALECT || 'sqlite').toLowerCase();

  switch (dialect) {
    case 'postgres':
      if (!process.env.DATABASE_URL) {
        throw new Error('PostgreSQL requires DATABASE_URL');
      }
      return getPostgresClient();
    case 'sqlite':
      return getSQLiteClient();
  }
}
```

---

### 6. AI Layer

**Location**: `packages/ai/src/`

#### Conversational Agent
```typescript
export class ConversationalAgent {
  async run(input: string, context: AgentContext): Promise<AgentResult> {
    // 1. Get conversation history
    const history = await this.getHistory(context.threadId);

    // 2. Call Claude
    const response = await this.anthropic.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 2048,
      messages: [
        ...history,
        { role: 'user', content: input },
      ],
      system: this.getSystemPrompt(),
    });

    // 3. Extract actions
    const actions = this.actionExtractor.extract(response.content[0].text);

    return {
      text: response.content[0].text,
      actions,
      usage: response.usage,
    };
  }
}
```

#### Action Extractor
```typescript
export class ActionExtractor {
  extract(text: string): Action[] {
    // Parse [ACTION:type:params] patterns
    const pattern = /\[ACTION:(\w+):({[^}]+})\]/g;
    const actions: Action[] = [];

    let match;
    while ((match = pattern.exec(text)) !== null) {
      actions.push({
        type: match[1] as ActionType,
        params: JSON.parse(match[2]),
      });
    }

    return actions;
  }
}
```

---

### 7. Core Infrastructure

**Location**: `packages/core/src/`

#### Configuration
```typescript
export const config = {
  database: {
    dialect: process.env.DB_DIALECT || 'sqlite',
    url: process.env.DATABASE_URL,
    sqlitePath: process.env.SQLITE_DB_PATH,
  },
  storage: {
    provider: process.env.STORAGE_PROVIDER || 'r2',
    // ... R2 and MinIO config
  },
  ai: {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
    openaiApiKey: process.env.OPENAI_API_KEY,
    embeddingsModel: process.env.EMBEDDINGS_MODEL || 'text-embedding-3-small',
  },
  // ... other config
};
```

#### Error Types
```typescript
export class NotFoundError extends SynapError {
  constructor(resource: string, id?: string) {
    super(
      id ? `${resource} with id "${id}" not found` : `${resource} not found`,
      'NOT_FOUND',
      404,
      { resource, id }
    );
  }
}

export class ValidationError extends SynapError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', 400, context);
  }
}
```

#### Logger
```typescript
export function createLogger(options: { module: string }): Logger {
  return pino({
    level: config.server.logLevel,
    base: { module: options.module },
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}
```

---

## 🔄 Data Flow

### Example: Create a Note

```
1. User Request
   ↓
   POST /trpc/notes.create
   Body: { content: "Meeting notes", autoEnrich: true }
   Header: Authorization: Bearer <token>

2. Hono Server
   ↓
   • CORS check
   • Auth middleware validates token
   • Routes to tRPC handler

3. tRPC Router (notes.create)
   ↓
   • Zod validates input
   • protectedProcedure checks auth
   • Calls noteService.createNote()

4. NoteService
   ↓
   • Creates entity in database
   • Uploads content to storage (R2/MinIO)
   • Emits entity.created event

5. EventService
   ↓
   • Appends event to event store (TimescaleDB)
   • Optimistic locking with version
   • Returns event record

6. Response to User
   ↓
   • 200 OK
   • { success: true, note: {...}, entityId: '...' }

7. Background Processing (Inngest)
   ↓
   • Entity embedding indexer listens to entity.created
   • Generates embeddings
   • Stores in vector database
```

### Example: Conversational Interface

```
1. User Message
   ↓
   POST /trpc/chat.sendMessage
   Body: { threadId: "uuid", content: "Create a task to call John" }

2. ConversationService
   ↓
   • Stores user message (hash-chained)
   • Returns message record

3. ConversationalAgent
   ↓
   • Gets conversation history
   • Calls Claude 3 Haiku
   • Extracts actions from response

4. AI Response
   ↓
   • Text: "I'll create that task for you. [ACTION:task.create:{...}]"
   • Actions: [{ type: 'task.create', params: {...} }]

5. ConversationService
   ↓
   • Stores AI response (hash-chained)
   • Returns response

6. User Confirms
   ↓
   POST /trpc/chat.executeAction
   Body: { actionType: 'task.create', actionParams: {...} }

7. Action Execution
   ↓
   • Creates task entity
   • Emits task.created event
   • Updates conversation with confirmation
```

---

## 🔐 Authentication

### Single-User (SQLite)

**Simple Token Authentication**:
```typescript
export const authMiddleware = (c: Context, next: Next) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  const expected = process.env.SYNAP_SECRET_TOKEN;
  
  if (!token || token !== expected) {
    throw new UnauthorizedError('Invalid token');
  }
  
  return next();
};
```

### Multi-User (PostgreSQL)

**Better Auth with OAuth**:
```typescript
export const auth = betterAuth({
  database: postgresAdapter(db),
  emailAndPassword: {
    enabled: true,
  },
  socialProviders: {
    google: {
      clientId: config.auth.googleClientId,
      clientSecret: config.auth.googleClientSecret,
    },
    github: {
      clientId: config.auth.githubClientId,
      clientSecret: config.auth.githubClientSecret,
    },
  },
});
```

---

## 🔄 Dual-Access Architecture (Planned)

### Overview

The dual-access system enables users to access both **local content** (personal, private) and **company/community content** (shared, collaborative) simultaneously through a unified interface.

### Current State vs Target State

**Current**: Single mode selection
```
DB_DIALECT=sqlite  → Local mode only
DB_DIALECT=postgres → Multi-user mode only
```

**Target**: Simultaneous dual-access
```
User can access:
  - Local context: SQLite + MinIO (personal)
  - Company context: PostgreSQL + R2 (shared)
  - Both: Unified search and operations
```

### Architecture Design

```
┌─────────────────────────────────────────────────────────────┐
│              Dual-Access Architecture                       │
│                                                             │
│  ┌──────────────────┐         ┌──────────────────┐        │
│  │  Local Context   │         │ Company Context  │        │
│  │                  │         │                  │        │
│  │  • SQLite DB     │         │  • PostgreSQL    │        │
│  │  • MinIO Storage │         │  • R2 Storage    │        │
│  │  • No userId    │         │  • userId-based  │        │
│  │  • Private       │         │  • Shared        │        │
│  └────────┬─────────┘         └────────┬─────────┘        │
│           │                            │                  │
│           └────────────┬────────────────┘                  │
│                        │                                   │
│           ┌────────────▼────────────┐                     │
│           │   Unified API Layer     │                     │
│           │                         │                     │
│           │  • Context switching    │                     │
│           │  • Unified search       │                     │
│           │  • Cross-context ops    │                     │
│           └─────────────────────────┘                     │
└─────────────────────────────────────────────────────────────┘
```

### Key Components

#### 1. Context Manager
```typescript
export class ContextManager {
  async getContext(req: Request): Promise<Context> {
    const header = req.headers.get('X-Context');
    // 'local' | 'company' | 'both'
    
    if (header === 'local') {
      return { type: 'local', db: localDb, storage: localStorage };
    }
    if (header === 'company') {
      return { type: 'company', db: companyDb, storage: companyStorage };
    }
    // 'both' - return unified context
    return { type: 'both', local: {...}, company: {...} };
  }
}
```

#### 2. Schema Updates
```sql
-- PostgreSQL: Add context column
ALTER TABLE entities ADD COLUMN context TEXT NOT NULL DEFAULT 'company';
ALTER TABLE entities ADD COLUMN company_id TEXT;

-- Indexes
CREATE INDEX idx_entities_context ON entities(context, user_id);
CREATE INDEX idx_entities_company ON entities(company_id, context);
```

#### 3. Storage Path Strategy
```typescript
// Local context
storage.buildPath("local", "note", "id", "md")
// → "local/notes/id.md"

// Company context
storage.buildPath(userId, "note", "id", "md")
// → "users/{userId}/notes/id.md"
```

#### 4. Unified Search
```typescript
async function unifiedSearch(query: string, contexts: string[]) {
  const results = await Promise.all([
    contexts.includes('local') && searchLocal(query),
    contexts.includes('company') && searchCompany(query),
  ]);
  
  return mergeResults(results);
}
```

### Implementation Phases

**Phase 1**: Foundation (Q1 2025)
- Schema updates
- Context management
- API header support

**Phase 2**: Unified Operations (Q2 2025)
- Cross-context search
- Unified responses
- Sync capabilities

**Phase 3**: Advanced Features (Q3 2025)
- Team workspaces
- Real-time updates
- Mobile support

See [ROADMAP.md](./ROADMAP.md) for detailed implementation plan.

---

## 🎯 Event Sourcing Patterns

### Event Types

```typescript
// Entity Lifecycle
'entity.created'
'entity.updated'
'entity.deleted'

// Tasks
'task.created'
'task.completed'
'task.status_changed'

// Conversations
'conversation.message.added'
'conversation.action.executed'

// AI
'ai.thought.analyzed'
'ai.embedding.generated'
```

### Projector Pattern

```typescript
// Inngest function
inngest.createFunction(
  { id: 'entity-projector' },
  { event: 'entity.*' },
  async ({ event, step }) => {
    await step.run('project-event', async () => {
      switch (event.name) {
        case 'entity.created':
          await db.insert(entities).values(event.data);
          break;
        case 'entity.updated':
          await db.update(entities)
            .set(event.data)
            .where(eq(entities.id, event.data.id));
          break;
      }
    });
  }
);
```

**Benefits**:
- **Time-travel**: Replay events to rebuild state
- **Audit trail**: Every change is logged
- **Debugging**: Inspect exact sequence of events

---

## 🚀 Scalability

### Local (SQLite)
- **DB**: SQLite (~1M records)
- **Storage**: MinIO (local filesystem)
- **Users**: Single-user
- **Limit**: ~10GB data

### Cloud (PostgreSQL)
- **DB**: PostgreSQL (Neon) - unlimited
- **Storage**: R2 (Cloudflare) - zero egress fees
- **Users**: Multi-tenant with user isolation
- **Limit**: Petabytes

### Hybrid Storage Strategy

```typescript
// Content stored in R2/MinIO
// Metadata stored in PostgreSQL
// Embeddings stored in pgvector (PostgreSQL) or SQLite (local)
```

**Cost savings**: 93% cheaper than storing everything in Postgres!

---

## 🧪 Testing Strategy

### Unit Tests
- Individual services in `@synap/domain`
- Mock external APIs (Claude, OpenAI)

### Integration Tests
- Full workflow: API → Domain → DB
- Located in `packages/core/tests/`

### User Isolation Tests
- Validates multi-user isolation
- 10/10 tests passing

---

## 📊 Performance

### Latency Targets

| Operation | Target | Actual |
|-----------|--------|--------|
| `notes.create` | <100ms | ~50ms |
| `chat.sendMessage` | <1.5s | ~1.3s |
| `notes.search` (RAG) | <500ms | ~400ms |
| Event projection | <100ms | ~80ms |

### Throughput
- **SQLite**: 100K+ reads/sec, 10K+ writes/sec
- **tRPC**: 1000+ req/sec (single instance)
- **Inngest**: Unlimited (horizontal scaling)

---

## 🔮 Future Enhancements

### Phase 2 (v0.5)
- [ ] Real-time subscriptions (WebSockets)
- [ ] Team workspaces
- [ ] Advanced search filters
- [ ] Mobile API optimizations

### Phase 3 (v0.6)
- [ ] Knowledge graph queries
- [ ] Automatic relation detection
- [ ] Summary generation
- [ ] Q&A over notes (RAG)

---

## 🏆 Why This Architecture Works

### 1. **Separation of Concerns**
- **API Layer**: HTTP/tRPC routing
- **Domain Layer**: Business logic
- **Data Layer**: Database & storage
- **AI Layer**: LLM integration
- **Core**: Infrastructure (config, errors, logging)

### 2. **Type Safety**
- TypeScript strict mode
- tRPC for end-to-end type safety
- Zod for runtime validation

### 3. **Flexible**
- Switch AI providers: Configuration change
- Switch databases: Environment variable
- Switch storage: Factory pattern

### 4. **Scalable**
- Event sourcing enables horizontal scaling
- Inngest handles background jobs at scale
- Hybrid storage optimizes costs

### 5. **Observable**
- Every event logged
- Structured logging (Pino)
- Inngest dashboard for job monitoring

---

**Questions?** Open an issue or contact the team!

**Next**: See [SETUP.md](./SETUP.md) to get running locally.
