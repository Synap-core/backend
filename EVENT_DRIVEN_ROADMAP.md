# 🏗️ Event-Driven Architecture: Validated Roadmap

**Date**: 2025-01-17  
**Status**: CTO-Validated Architecture  
**Approach**: Layer-by-Layer Validation (Foundation → Reactions → State → Access)

---

## 🎯 Architectural Principles (Validated)

### 1. Event Service Pattern
**Decision**: ❌ **REMOVED** - Direct Inngest publishing only
- `eventService.append()` is a code smell (unnecessary indirection)
- Producers (API/Agents) must publish directly to Inngest bus
- No intermediate service layer

### 2. CQRS Pattern
**Decision**: ✅ **ENFORCED**
- **Commands** (create, update, delete) → Event Bus → Workers
- **Queries** (list, search, getById) → Direct projection reads
- Read operations do NOT generate events

### 3. Async Response Pattern
**Decision**: RequestId + WebSocket Channel
- API returns `{ success: true, status: 'pending', requestId }`
- Frontend subscribes to `updates:${requestId}` WebSocket channel
- Worker publishes completion/error to channel
- Real-time UI updates (no polling)

### 4. Error Handling
**Decision**: Same WebSocket Channel
- Worker failures publish `{ status: 'error', message: '...' }` to channel
- UI displays error in real-time

### 5. AI Tool Pattern
**Decision**: Fire-and-Forget
- Tools publish events, return `requestId`
- Agent responds: "In progress, I'll notify you when done"
- No blocking waits

---

## 📋 Phase 1: Validate the "Backbone" - The Event Store

**Duration**: 1 week  
**Objective**: Absolute confidence in reliable, immutable, efficient event recording

---

### 1.1 Finalize the Event Contract

**Current State**: 
- Multiple event schemas exist (`EventRecordSchema`, `AppendEventInputSchema`)
- No unified `SynapEvent` contract
- Schema validation happens in domain service, not at repository level

**Target State**:
- Single, versioned `SynapEvent` Zod schema (v1)
- All events must conform to this contract
- Validation at repository level (before insert)

**Concrete Actions**:

1. **Create `SynapEvent` Schema** (`packages/core/src/types/synap-event.ts`):
```typescript
import { z } from 'zod';

/**
 * SynapEvent v1 - The Immutable Event Contract
 * 
 * All events in the system must conform to this schema.
 * This is the single source of truth for event structure.
 */
export const SynapEventSchema = z.object({
  // Event Identity
  id: z.string().uuid(),
  version: z.literal('v1'), // Schema version for future migrations
  
  // Event Classification
  type: z.string().min(1).max(128), // e.g., 'note.creation.requested', 'task.completed'
  aggregateId: z.string().uuid().optional(), // Optional for system events
  
  // Event Data
  data: z.record(z.unknown()), // Event payload (validated by specific event type schemas)
  
  // Metadata
  userId: z.string().min(1), // Required for multi-tenant isolation
  source: z.enum(['api', 'automation', 'sync', 'migration', 'system']).default('api'),
  timestamp: z.date().default(() => new Date()),
  
  // Tracing
  correlationId: z.string().uuid().optional(), // For grouping related events
  causationId: z.string().uuid().optional(), // For event chains (A caused B)
  
  // Request Tracking (for async responses)
  requestId: z.string().uuid().optional(), // For linking API requests to events
});

export type SynapEvent = z.infer<typeof SynapEventSchema>;

/**
 * Event Type Registry
 * 
 * Each event type has its own data schema for validation.
 * This ensures type safety and validation at the event level.
 */
export const EventTypeSchemas = {
  'note.creation.requested': z.object({
    content: z.string().min(1),
    title: z.string().optional(),
    tags: z.array(z.string()).optional(),
    inputType: z.enum(['text', 'audio']).optional(),
    autoEnrich: z.boolean().optional(),
    useRAG: z.boolean().optional(),
  }),
  
  'note.creation.completed': z.object({
    entityId: z.string().uuid(),
    fileUrl: z.string().url().optional(),
    filePath: z.string().optional(),
  }),
  
  'task.creation.requested': z.object({
    title: z.string().min(1),
    description: z.string().optional(),
    dueDate: z.string().datetime().optional(),
    priority: z.number().int().min(0).max(5).optional(),
  }),
  
  // ... more event types
} as const;

/**
 * Validate event against its type-specific schema
 */
export function validateEventData<T extends keyof typeof EventTypeSchemas>(
  eventType: T,
  data: unknown
): z.infer<typeof EventTypeSchemas[T]> {
  const schema = EventTypeSchemas[eventType];
  if (!schema) {
    throw new Error(`Unknown event type: ${eventType}`);
  }
  return schema.parse(data);
}
```

2. **Update Event Repository** (`packages/database/src/repositories/event-repository.ts`):
```typescript
import { SynapEventSchema, type SynapEvent } from '@synap/core';

export class EventRepository {
  /**
   * Append event to store
   * 
   * Validates event against SynapEvent schema before insertion.
   * This is the single point of validation.
   */
  async append(event: SynapEvent): Promise<SynapEvent> {
    // Validate against schema
    const validated = SynapEventSchema.parse(event);
    
    // Insert into TimescaleDB
    const result = await this.pool.query(`
      INSERT INTO events_v2 (
        id,
        aggregate_id,
        event_type,
        user_id,
        data,
        metadata,
        version,
        correlation_id,
        causation_id,
        source,
        timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `, [
      validated.id,
      validated.aggregateId || null,
      validated.type,
      validated.userId,
      JSON.stringify(validated.data),
      JSON.stringify({
        version: validated.version,
        requestId: validated.requestId,
      }),
      1, // Aggregate version (for optimistic locking)
      validated.correlationId || null,
      validated.causationId || null,
      validated.source,
      validated.timestamp,
    ]);
    
    return validated;
  }
}
```

3. **Create Event Factory** (`packages/core/src/events/event-factory.ts`):
```typescript
import { randomUUID } from 'crypto';
import { SynapEventSchema, validateEventData, type SynapEvent } from './synap-event.js';

/**
 * Create a SynapEvent with automatic ID and timestamp
 */
export function createSynapEvent<T extends keyof typeof EventTypeSchemas>(input: {
  type: T;
  data: unknown; // Will be validated
  userId: string;
  aggregateId?: string;
  source?: SynapEvent['source'];
  correlationId?: string;
  causationId?: string;
  requestId?: string;
}): SynapEvent {
  // Validate event data against type-specific schema
  const validatedData = validateEventData(input.type, input.data);
  
  return SynapEventSchema.parse({
    id: randomUUID(),
    version: 'v1',
    type: input.type,
    aggregateId: input.aggregateId,
    data: validatedData,
    userId: input.userId,
    source: input.source || 'api',
    timestamp: new Date(),
    correlationId: input.correlationId,
    causationId: input.causationId,
    requestId: input.requestId,
  });
}
```

**Validation Criterion**: ✅ All events validated against `SynapEventSchema` before insertion

---

### 1.2 Confirm Event Store Choice

**Current State**: 
- TimescaleDB (PostgreSQL extension) for time-series events
- SQLite for local development
- `events_v2` hypertable with proper indexes

**Target State**: 
- Validate TimescaleDB performance
- Confirm local SQLite is sufficient for dev
- Document production requirements

**Concrete Actions**:

1. **Review TimescaleDB Setup**:
   - Verify `events_v2` hypertable is created
   - Confirm indexes: `(aggregate_id, timestamp DESC)`, `(user_id, timestamp DESC)`, `(event_type, timestamp DESC)`
   - Verify retention policies (if any)

2. **Document Requirements**:
   - Production: TimescaleDB on Neon/Supabase
   - Local: SQLite (sufficient for dev, not for production scale)

**Validation Criterion**: ✅ Event store choice documented and validated

---

### 1.3 Build the Access Interface

**Current State**: 
- `EventRepository` exists but uses `AppendEventData` interface
- Validation happens in domain service, not repository

**Target State**: 
- Single `append(event: SynapEvent)` method
- Validation at repository level
- Clean, simple interface

**Concrete Actions**:

1. **Refactor EventRepository** (see 1.1 above)
2. **Remove `eventService`** (per CTO decision)
3. **Update all callers** to use `EventRepository.append()` directly

**Validation Criterion**: ✅ Clean `append()` interface with schema validation

---

### 1.4 Stress and Performance Tests

**Concrete Actions**:

1. **Create Test Script** (`scripts/test-event-store-performance.ts`):
```typescript
import { EventRepository } from '@synap/database';
import { createSynapEvent } from '@synap/core';
import { randomUUID } from 'crypto';

async function testEventStorePerformance() {
  const repo = new EventRepository(pool);
  const userId = randomUUID();
  
  console.log('📊 Starting event store performance test...');
  
  const startTime = Date.now();
  const eventCount = 100_000;
  const events: SynapEvent[] = [];
  
  // Generate events
  for (let i = 0; i < eventCount; i++) {
    events.push(createSynapEvent({
      type: 'note.creation.requested',
      data: {
        content: `Test note ${i}`,
        title: `Note ${i}`,
      },
      userId,
      requestId: randomUUID(),
    }));
  }
  
  // Batch insert
  const insertStart = Date.now();
  for (const event of events) {
    await repo.append(event);
  }
  const insertTime = Date.now() - insertStart;
  
  // Time range query
  const queryStart = Date.now();
  const results = await repo.getUserStream(userId, {
    days: 1,
    limit: 1000,
  });
  const queryTime = Date.now() - queryStart;
  
  console.log(`✅ Inserted ${eventCount} events in ${insertTime}ms (${(eventCount / insertTime * 1000).toFixed(0)} events/sec)`);
  console.log(`✅ Queried ${results.length} events in ${queryTime}ms`);
  console.log(`✅ Total time: ${Date.now() - startTime}ms`);
}

testEventStorePerformance();
```

2. **Run Tests**:
   - Local SQLite: Verify basic functionality
   - TimescaleDB (Neon): Verify production performance
   - Target: >10,000 events/sec write, <100ms for time-range queries

**Validation Criterion**: ✅ Performance validated, meets requirements

---

### 🏆 Phase 1 "Little Win"

**Validation Criteria**:
- ✅ `SynapEvent` v1 schema defined and enforced
- ✅ EventRepository validates events before insertion
- ✅ TimescaleDB choice confirmed
- ✅ Performance tests pass (>10K events/sec)
- ✅ Can write millions of events securely and efficiently

**Deliverable**: Event "vault" - reliable, validated, performant event store

---

## 📋 Phase 2: Validate the "Reactions" - The Worker Layer

**Duration**: 1 week  
**Objective**: Prove we can react to events in a decoupled, reliable way

---

### 2.1 Define the Handler Interface

**Concrete Actions**:

1. **Create `IEventHandler` Interface** (`packages/jobs/src/types/handler.ts`):
```typescript
import type { SynapEvent } from '@synap/core';

/**
 * Event Handler Interface
 * 
 * All Inngest workers must implement this interface.
 * This ensures consistent handler patterns across the system.
 */
export interface IEventHandler {
  /**
   * Event type this handler subscribes to
   */
  eventType: string;
  
  /**
   * Handle the event
   * 
   * @param event - The SynapEvent to process
   * @param step - Inngest step runner for reliability
   * @returns Result of processing
   */
  handle(
    event: SynapEvent,
    step: InngestStepRunner
  ): Promise<HandlerResult>;
}

export interface HandlerResult {
  success: boolean;
  message?: string;
  data?: Record<string, unknown>;
  error?: string;
}

export interface InngestStepRunner {
  run<T>(name: string, handler: () => Promise<T> | T): Promise<T>;
}
```

2. **Create Handler Registry** (`packages/jobs/src/registry/handler-registry.ts`):
```typescript
import type { IEventHandler } from '../types/handler.js';

/**
 * Handler Registry
 * 
 * Central registry for all event handlers.
 * Handlers are registered at module load time.
 */
class HandlerRegistry {
  private handlers = new Map<string, IEventHandler[]>();
  
  /**
   * Register a handler for an event type
   */
  register(handler: IEventHandler): void {
    const existing = this.handlers.get(handler.eventType) || [];
    this.handlers.set(handler.eventType, [...existing, handler]);
  }
  
  /**
   * Get handlers for an event type
   */
  getHandlers(eventType: string): IEventHandler[] {
    return this.handlers.get(eventType) || [];
  }
  
  /**
   * Get all registered event types
   */
  getEventTypes(): string[] {
    return Array.from(this.handlers.keys());
  }
}

export const handlerRegistry = new HandlerRegistry();
```

**Validation Criterion**: ✅ Handler interface defined, registry implemented

---

### 2.2 Build the Inngest Dispatcher

**Concrete Actions**:

1. **Create Central Dispatcher** (`packages/jobs/src/dispatcher/inngest-dispatcher.ts`):
```typescript
import { inngest } from '../client.js';
import { handlerRegistry } from '../registry/handler-registry.js';
import type { SynapEvent } from '@synap/core';

/**
 * Central Inngest Dispatcher
 * 
 * Receives raw events from Inngest, finds handlers in registry,
 * and calls them. This is the single entry point for all events.
 */
export const eventDispatcher = inngest.createFunction(
  { id: 'event-dispatcher', name: 'Event Dispatcher' },
  { event: 'api/event.logged' }, // Receives events from API
  async ({ event, step }) => {
    const synapEvent: SynapEvent = {
      id: event.data.id,
      version: event.data.version || 'v1',
      type: event.data.type,
      aggregateId: event.data.aggregateId,
      data: event.data.data,
      userId: event.data.userId,
      source: event.data.source || 'api',
      timestamp: new Date(event.data.timestamp),
      correlationId: event.data.correlationId,
      causationId: event.data.causationId,
      requestId: event.data.requestId,
    };
    
    // Find handlers for this event type
    const handlers = handlerRegistry.getHandlers(synapEvent.type);
    
    if (handlers.length === 0) {
      console.warn(`⚠️  No handlers registered for event type: ${synapEvent.type}`);
      return { status: 'no-handlers', eventType: synapEvent.type };
    }
    
    // Execute all handlers
    const results = await Promise.allSettled(
      handlers.map((handler) =>
        step.run(`handle-${handler.eventType}-${handler.constructor.name}`, () =>
          handler.handle(synapEvent, step)
        )
      )
    );
    
    return {
      status: 'processed',
      eventType: synapEvent.type,
      handlerCount: handlers.length,
      results: results.map((r) => (r.status === 'fulfilled' ? r.value : { error: r.reason })),
    };
  }
);
```

2. **Update Inngest Client** to export dispatcher:
```typescript
// packages/jobs/src/index.ts
export { eventDispatcher } from './dispatcher/inngest-dispatcher.js';
export { handlerRegistry } from './registry/handler-registry.js';
```

**Validation Criterion**: ✅ Central dispatcher routes events to handlers

---

### 2.3 Implement the First Handler (Projector)

**Concrete Actions**:

1. **Create NoteProjector** (`packages/jobs/src/handlers/note-projector.ts`):
```typescript
import { handlerRegistry } from '../registry/handler-registry.js';
import type { IEventHandler, HandlerResult, InngestStepRunner } from '../types/handler.js';
import type { SynapEvent } from '@synap/core';
import { db, entities } from '@synap/database';

/**
 * Note Projector
 * 
 * Subscribes to note.creation.completed events and updates
 * the entities projection table.
 */
export class NoteProjector implements IEventHandler {
  eventType = 'note.creation.completed';
  
  async handle(
    event: SynapEvent,
    step: InngestStepRunner
  ): Promise<HandlerResult> {
    if (event.type !== 'note.creation.completed') {
      return { success: false, error: 'Invalid event type' };
    }
    
    const { entityId, fileUrl, filePath } = event.data as {
      entityId: string;
      fileUrl?: string;
      filePath?: string;
    };
    
    // Update entities table (projection)
    await step.run('update-entity-projection', async () => {
      await db.update(entities)
        .set({
          fileUrl: fileUrl || null,
          filePath: filePath || null,
          updatedAt: new Date(),
        })
        .where(eq(entities.id, entityId));
    });
    
    return {
      success: true,
      message: `Entity ${entityId} projection updated`,
    };
  }
}

// Register handler
const noteProjector = new NoteProjector();
handlerRegistry.register(noteProjector);
```

2. **Create Note Creation Handler** (`packages/jobs/src/handlers/note-creation-handler.ts`):
```typescript
import { handlerRegistry } from '../registry/handler-registry.js';
import type { IEventHandler, HandlerResult, InngestStepRunner } from '../types/handler.js';
import type { SynapEvent } from '@synap/core';
import { EventRepository } from '@synap/database';
import { storage } from '@synap/storage';
import { db, entities } from '@synap/database';
import { createSynapEvent } from '@synap/core';
import { randomUUID } from 'crypto';

/**
 * Note Creation Handler
 * 
 * Subscribes to note.creation.requested events and:
 * 1. Uploads content to storage
 * 2. Creates entity in database
 * 3. Publishes note.creation.completed event
 */
export class NoteCreationHandler implements IEventHandler {
  eventType = 'note.creation.requested';
  
  constructor(
    private eventRepo: EventRepository
  ) {}
  
  async handle(
    event: SynapEvent,
    step: InngestStepRunner
  ): Promise<HandlerResult> {
    const { content, title, tags, userId } = event.data as {
      content: string;
      title?: string;
      tags?: string[];
      userId: string;
    };
    
    const entityId = randomUUID();
    
    // Step 1: Upload to storage
    const fileMetadata = await step.run('upload-to-storage', async () => {
      const storagePath = storage.buildPath(userId, 'note', entityId, 'md');
      return await storage.upload(storagePath, content, {
        contentType: 'text/markdown',
      });
    });
    
    // Step 2: Create entity projection
    await step.run('create-entity-projection', async () => {
      await db.insert(entities).values({
        id: entityId,
        userId,
        type: 'note',
        title: title || content.slice(0, 100),
        preview: content.slice(0, 500),
        fileUrl: fileMetadata.url,
        filePath: fileMetadata.path,
        fileSize: fileMetadata.size,
        fileType: 'markdown',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });
    
    // Step 3: Publish completion event
    const completedEvent = createSynapEvent({
      type: 'note.creation.completed',
      data: {
        entityId,
        fileUrl: fileMetadata.url,
        filePath: fileMetadata.path,
      },
      userId,
      aggregateId: entityId,
      causationId: event.id, // This event was caused by the request
      requestId: event.requestId, // Link back to API request
    });
    
    await step.run('publish-completion-event', async () => {
      await this.eventRepo.append(completedEvent);
      // Also publish to Inngest for other handlers
      await inngest.send({
        name: 'api/event.logged',
        data: completedEvent,
      });
    });
    
    return {
      success: true,
      data: { entityId, fileUrl: fileMetadata.url },
    };
  }
}

// Register handler
const noteCreationHandler = new NoteCreationHandler(eventRepository);
handlerRegistry.register(noteCreationHandler);
```

**Validation Criterion**: ✅ Handlers implemented and registered

---

### 🏆 Phase 2 "Little Win"

**Validation Criteria**:
- ✅ Handler interface defined
- ✅ Central dispatcher routes events
- ✅ NoteProjector updates entities table
- ✅ NoteCreationHandler processes note creation
- ✅ Can publish `note.creation.requested` → see entity in `entities` table

**Deliverable**: Event plumbing functional - cause and effect decoupled

---

## 📋 Phase 3: Validate the "State of the World" - The Projection Layer

**Duration**: 2 weeks  
**Objective**: Solidify how we store and access current state (hybrid architecture)

---

### 3.1 Implement Storage Abstraction

**Current State**: ✅ Already implemented
- `IFileStorage` interface exists
- `R2StorageProvider` and `MinIOStorageProvider` exist
- Factory pattern for provider selection

**Validation Actions**:
1. Verify storage abstraction is used by handlers (not direct R2/MinIO calls)
2. Test both providers work correctly
3. Document storage path strategy

**Validation Criterion**: ✅ Storage abstraction validated

---

### 3.2 Finalize Projection Schemas

**Concrete Actions**:

1. **Review All Projection Tables**:
   - `entities` - Entity metadata (NOT content)
   - `task_details` - Task-specific fields
   - `conversation_messages` - Chat history
   - `entity_vectors` - Embeddings for search
   - `knowledge_facts` - AI knowledge base

2. **Verify Hybrid Architecture**:
   - ✅ `entities.file_path` points to storage (not content in DB)
   - ✅ `entities.file_url` for public access
   - ✅ All large content in storage, metadata in DB

3. **Optimize for Reads**:
   - Add indexes on frequently queried fields
   - Denormalize where needed for read performance
   - Document query patterns

**Validation Criterion**: ✅ Projections are pure materialized views, optimized for reads

---

### 3.3 Refactor Handlers to Use Storage

**Concrete Actions**:

1. **Update NoteCreationHandler** (already uses storage in Phase 2)
2. **Update Other Handlers** to use storage abstraction
3. **Remove Direct Storage Calls** from domain services

**Validation Criterion**: ✅ All handlers use storage abstraction

---

### 🏆 Phase 3 "Little Win"

**Validation Criteria**:
- ✅ Storage abstraction validated
- ✅ Projection schemas finalized
- ✅ Hybrid architecture confirmed (content in storage, metadata in DB)
- ✅ System ready for large files

**Deliverable**: Perfect separation between history (Event Store) and state (Projections)

---

## 📋 Phase 4: Validate "External Access" - The API Layer

**Duration**: 1 week  
**Objective**: Expose system securely with CQRS pattern

---

### 4.1 Build the "Command" API

**Concrete Actions**:

1. **Refactor Notes API** (`features/api/notes/templates/src/routers/notes.ts.tpl`):
```typescript
import { inngest } from '@synap/jobs';
import { randomUUID } from 'crypto';

export const notesRouter = router({
  create: protectedProcedure
    .input(z.object({
      content: z.string().min(1),
      title: z.string().optional(),
      tags: z.array(z.string()).optional(),
      // ...
    }))
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const requestId = randomUUID();
      
      // Publish event directly to Inngest (no eventService)
      await inngest.send({
        name: 'api/event.logged',
        data: {
          id: randomUUID(),
          version: 'v1',
          type: 'note.creation.requested',
          data: {
            content: input.content,
            title: input.title,
            tags: input.tags,
          },
          userId,
          source: 'api',
          timestamp: new Date().toISOString(),
          requestId, // For async response tracking
        },
      });
      
      return {
        success: true,
        status: 'pending',
        requestId,
        message: 'Note creation in progress',
      };
    }),
  
  // Read operations (CQRS - direct projection access)
  search: protectedProcedure
    .input(z.object({
      query: z.string().min(1),
      limit: z.number().default(10),
    }))
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      
      // Direct read from projection (no event)
      const results = await db.select()
        .from(entities)
        .where(and(
          eq(entities.userId, userId),
          eq(entities.type, 'note'),
          // ... search logic
        ))
        .limit(input.limit);
      
      return results;
    }),
});
```

2. **Refactor Chat API** similarly
3. **Refactor All Command Endpoints** to publish events

**Validation Criterion**: ✅ All write operations publish events, no direct service calls

---

### 4.2 Build the "Query" API

**Concrete Actions**:

1. **Implement Read Endpoints**:
   - `notes.list` - Direct DB query
   - `notes.getById` - Direct DB query
   - `tasks.list` - Direct DB query
   - `conversations.getThread` - Direct DB query

2. **Optimize Queries**:
   - Use indexes
   - Add pagination
   - Filter by userId (RLS)

**Validation Criterion**: ✅ All read operations are fast, direct projection queries

---

### 4.3 Finalize Auth

**Concrete Actions**:

1. **Integrate Better Auth** on all endpoints
2. **Enforce RLS** on read queries
3. **Validate userId** on all operations

**Validation Criterion**: ✅ Auth integrated, RLS enforced

---

### 4.4 WebSocket Integration (Future)

**Note**: WebSocket integration for async responses is Phase 5 (not in MVP)

For MVP, API returns `requestId` and frontend can poll or implement WebSocket later.

---

### 🏆 Phase 4 "Little Win"

**Validation Criteria**:
- ✅ Command API publishes events (no business logic)
- ✅ Query API reads projections directly (fast)
- ✅ CQRS pattern fully implemented
- ✅ Auth and RLS enforced

**Deliverable**: Complete API implementing CQRS - writes async/event-driven, reads fast/direct

---

## 📊 Overall Validation Checklist

### Phase 1: Event Store ✅
- [ ] SynapEvent v1 schema defined
- [ ] EventRepository validates events
- [ ] TimescaleDB confirmed
- [ ] Performance tests pass

### Phase 2: Workers ✅
- [ ] Handler interface defined
- [ ] Central dispatcher implemented
- [ ] First handler (NoteProjector) works
- [ ] Event plumbing functional

### Phase 3: Projections ✅
- [ ] Storage abstraction validated
- [ ] Projection schemas finalized
- [ ] Hybrid architecture confirmed
- [ ] Handlers use storage

### Phase 4: API ✅
- [ ] Command API publishes events
- [ ] Query API reads projections
- [ ] CQRS pattern enforced
- [ ] Auth integrated

---

## 🎯 Success Metrics

**After Phase 4 Completion**:
- ✅ 100% event-driven writes (no direct service calls from API)
- ✅ 100% direct reads (CQRS pattern)
- ✅ All business logic in workers
- ✅ Event store validated and performant
- ✅ System ready for production

---

**Roadmap Status**: Ready for Implementation  
**Next Step**: Begin Phase 1 - Event Store Validation

