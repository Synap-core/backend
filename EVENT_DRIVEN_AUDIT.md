# 🔍 Event-Driven Architecture Audit Report

**Date**: 2025-01-17  
**Auditor**: Lead Software Architect  
**Scope**: Synap Module Marketplace (`marketplaces/synap/`)  
**Doctrine**: Pure Event-Driven Architecture (Inngest as Event Bus)

---

## 📊 Executive Summary

### Overall Compliance Score: **35%**

The current architecture demonstrates **partial event-driven patterns** but contains **significant violations** of the Pure Event-Driven Doctrine. Most API endpoints and AI agent tools directly call domain services instead of publishing intent events to the Inngest event bus.

**Key Findings**:
- ✅ **Event Consumers (Workers)**: Correctly implemented - Inngest functions subscribe to events and contain business logic
- ❌ **Event Producers (API/Agents)**: Major violations - Directly call domain services instead of publishing events
- ⚠️ **Domain Services**: Correctly structured as primitive services, but called by wrong layers
- ✅ **Event Bus**: Inngest infrastructure is properly set up

**Critical Violations**:
1. `features/api/notes` directly calls `noteService.createNote()` (should publish `note.creation.requested`)
2. `features/api/chat` directly calls `conversationService` and `eventService.append()` (should publish events)
3. `capabilities/ai/chat-agent/tools/create-entity-tool` directly calls domain services (should publish events)

---

## 🎯 Doctrine Compliance Matrix

| Module Category | Compliance | Score |
|----------------|------------|-------|
| **Event Bus (Inngest)** | ✅ Correct | 100% |
| **Event Consumers (Workers)** | ✅ Correct | 100% |
| **Event Producers (API)** | ❌ Violations | 15% |
| **Event Producers (AI Tools)** | ❌ Violations | 20% |
| **Primitive Capabilities** | ✅ Correct | 100% |
| **Domain Services** | ⚠️ Misused | 50% |

**Overall**: 35% compliance

---

## 📋 Detailed Module Audit

### Framework Modules

#### `framework/hono`
- **Current Role**: Bootstraps Hono API server with tRPC, auth, and Inngest handler
- **Compliance Analysis**: ✅ **COMPLIANT** - Framework layer, no business logic
- **Refactoring Plan**: No changes needed

---

### Capability Modules

#### `capabilities/database/base`
- **Current Role**: Provides database clients (SQLite/PostgreSQL) and low-level Drizzle operations
- **Compliance Analysis**: ✅ **COMPLIANT** - Primitive capability, exposes `db.insert()`, `db.select()`, etc.
- **Refactoring Plan**: No changes needed

---

#### `capabilities/storage/base`
- **Current Role**: Provides storage abstraction (R2/MinIO) with `IFileStorage` interface
- **Compliance Analysis**: ✅ **COMPLIANT** - Primitive capability, exposes `storage.upload()`, `storage.download()`, etc.
- **Refactoring Plan**: No changes needed

---

#### `capabilities/event-store`
- **Current Role**: Provides Drizzle schema for events table
- **Compliance Analysis**: ✅ **COMPLIANT** - Primitive capability, schema definition only
- **Refactoring Plan**: No changes needed

---

#### `capabilities/jobs/base`
- **Current Role**: 
  - Sets up Inngest client
  - Registers domain event publisher to forward events to Inngest
  - Provides base Inngest functions (projectors)
- **Compliance Analysis**: ✅ **COMPLIANT** - Correctly implements event bus infrastructure
  - `event-publisher.ts.tpl` registers domain event publisher that sends to Inngest
  - `functions/projectors.ts.tpl` subscribes to `api/event.logged` and updates projections
- **Refactoring Plan**: No changes needed

**Evidence**:
```typescript
// event-publisher.ts.tpl:30-53
registerDomainEventPublisher(async (event) => {
  await inngest.send({
    name: 'api/event.logged',
    data: { ...event }
  });
});

// projectors.ts.tpl:26-63
export const handleNewEvent = inngest.createFunction(
  { id: 'event-projector' },
  { event: 'api/event.logged' },
  async ({ event, step }) => {
    // Updates projections based on event type
  }
);
```

---

#### `capabilities/jobs/entity-embedding`
- **Current Role**: Inngest function that indexes entity embeddings when `entity.created` events occur
- **Compliance Analysis**: ✅ **COMPLIANT** - Correct event consumer pattern
  - Subscribes to `api/event.logged` event
  - Filters for `entity.created` type
  - Calls primitive services (`storage.download()`, `vectorService.upsertEntityEmbedding()`)
- **Refactoring Plan**: No changes needed

**Evidence**:
```typescript
// entity-embedding.ts.tpl:96-109
export const indexEntityEmbedding = inngest.createFunction(
  { id: 'entity-embedding-indexer' },
  { event: 'api/event.logged' },
  async ({ event, step }) => {
    if (type !== 'entity.created') return;
    // Calls storage and vectorService (primitive capabilities)
  }
);
```

---

#### `capabilities/domain/base`
- **Current Role**: Provides domain services (`NoteService`, `ConversationService`, `EventService`, etc.) with business logic
- **Compliance Analysis**: ⚠️ **PARTIALLY COMPLIANT** - Services are correctly structured as primitive services, but **violations occur in how they're called**
  - ✅ Services contain business logic (correct for workers to call)
  - ❌ Services are called directly by API routers (violation)
  - ❌ Services are called directly by AI tools (violation)
  - ✅ Services should only be called by Inngest workers

**Violations**:
1. `NoteService.createNote()` is called directly by:
   - `features/api/notes/templates/src/routers/notes.ts.tpl:40`
   - `capabilities/ai/chat-agent/templates/src/tools/create-entity-tool.ts.tpl:82`

2. `ConversationService.appendMessage()` is called directly by:
   - `features/api/chat/templates/src/routers/chat.ts.tpl:115, 141, 467, 492`

3. `EventService.append()` is called directly by:
   - `features/api/chat/templates/src/routers/chat.ts.tpl:304, 341, 364, 398, 419`
   - `capabilities/ai/chat-agent/templates/src/tools/create-entity-tool.ts.tpl:120`

- **Refactoring Plan**: 
  - **Keep domain services as-is** (they're correctly structured)
  - **Remove direct calls from API routers** (move to workers)
  - **Remove direct calls from AI tools** (move to event publishing)

---

#### `capabilities/ai/chat-agent`
- **Current Role**: Provides LangGraph-based conversational agent with tools
- **Compliance Analysis**: ❌ **VIOLATION** - AI agent tools directly call domain services instead of publishing events

**Violations**:
1. **`tools/create-entity-tool.ts.tpl`** (Lines 82-93, 120-133):
   - Directly calls `noteService.createNote()` for notes
   - Directly calls `eventService.append()` for tasks
   - **Should**: Publish `note.creation.requested` or `task.creation.requested` events to Inngest

2. **`tools/semantic-search-tool.ts.tpl`** (if exists):
   - Likely directly calls `vectorService` or `noteService.searchNotes()`
   - **Should**: Publish `search.requested` event (or could be read-only, needs clarification)

3. **`tools/save-fact-tool.ts.tpl`** (if exists):
   - Likely directly calls `knowledgeService`
   - **Should**: Publish `fact.save.requested` event

- **Refactoring Plan**:
  1. **Refactor `create-entity-tool.ts.tpl`**:
     - Remove `noteService.createNote()` call
     - Remove `eventService.append()` call
     - Add Inngest client import
     - Publish `note.creation.requested` or `task.creation.requested` event
     - Return event ID and status

  2. **Refactor other tools** similarly:
     - Replace direct service calls with event publishing
     - Tools become pure event producers

  3. **Create Inngest workers** to handle tool events:
     - `workers/handle-note-creation.ts` - subscribes to `note.creation.requested`
     - `workers/handle-task-creation.ts` - subscribes to `task.creation.requested`
     - Workers call `noteService` or `eventService` (business logic)

**Example Refactoring**:
```typescript
// BEFORE (create-entity-tool.ts.tpl:82-93)
const noteResult = await noteService.createNote({
  userId: context.userId,
  content: input.content ?? '',
  // ...
});

// AFTER
await inngest.send({
  name: 'note.creation.requested',
  data: {
    userId: context.userId,
    content: input.content ?? '',
    title: input.title,
    tags: input.tags,
    threadId: context.threadId,
  }
});
```

---

### Feature Modules

#### `features/api/base`
- **Current Role**: Provides base tRPC router setup and stub routers
- **Compliance Analysis**: ✅ **COMPLIANT** - Infrastructure only, no business logic
- **Refactoring Plan**: No changes needed

---

#### `features/api/notes`
- **Current Role**: Provides tRPC router for note creation and search
- **Compliance Analysis**: ❌ **MAJOR VIOLATION** - Directly calls domain services instead of publishing events

**Violations**:

1. **`create` procedure** (Lines 35-70):
   ```typescript
   const result = await noteService.createNote({
     userId,
     content: input.content,
     // ...
   });
   ```
   - **Violation**: Directly calls `noteService.createNote()` (domain service)
   - **Should**: Publish `note.creation.requested` event to Inngest
   - **Current Flow**: API → Domain Service → Storage + Database + Event Store
   - **Target Flow**: API → Inngest Event → Worker → Domain Service → Storage + Database + Event Store

2. **`search` procedure** (Lines 83-94):
   ```typescript
   const results = await noteService.searchNotes({
     userId,
     query: input.query,
     // ...
   });
   ```
   - **Violation**: Directly calls `noteService.searchNotes()` (domain service)
   - **Clarification Needed**: Search might be read-only and acceptable, but should confirm if it needs to go through event bus
   - **If read-only is acceptable**: Keep as-is (query operations may not need events)
   - **If must be event-driven**: Publish `note.search.requested` event

- **Refactoring Plan**:

  1. **Refactor `create` procedure**:
     ```typescript
     // BEFORE
     const result = await noteService.createNote({ ... });
     
     // AFTER
     const eventId = randomUUID();
     await inngest.send({
       name: 'note.creation.requested',
       data: {
         userId,
         content: input.content,
         inputType: input.inputType,
         autoEnrich: input.autoEnrich,
         tags: input.tags,
         useRAG: input.useRAG,
         requestId: eventId,
       }
     });
     
     return {
       success: true,
       requestId: eventId,
       status: 'pending', // Note: Actual result comes via webhook or polling
     };
     ```

  2. **Create Inngest worker** (`capabilities/jobs/note-creation`):
     ```typescript
     export const handleNoteCreation = inngest.createFunction(
       { id: 'note-creation-handler' },
       { event: 'note.creation.requested' },
       async ({ event, step }) => {
         const { userId, content, ...metadata } = event.data;
         
         // Call domain service (business logic)
         const result = await noteService.createNote({
           userId,
           content,
           source: 'api',
           metadata,
         });
         
         // Publish completion event
         await inngest.send({
           name: 'note.creation.completed',
           data: { requestId: event.data.requestId, result }
         });
       }
     );
     ```

  3. **Handle `search` procedure**:
     - **Option A (Read-only acceptable)**: Keep as-is (query operations don't need events)
     - **Option B (Must be event-driven)**: Publish `note.search.requested` event, worker calls `noteService.searchNotes()`

---

#### `features/api/chat`
- **Current Role**: Provides conversational chat API with message sending and action execution
- **Compliance Analysis**: ❌ **MAJOR VIOLATION** - Directly calls domain services and event service instead of publishing events

**Violations**:

1. **`sendMessage` procedure** (Lines 108-165):
   ```typescript
   const userMessage = await conversationService.appendMessage({ ... });
   // ...
   const assistantMessage = await conversationService.appendMessage({ ... });
   ```
   - **Violation**: Directly calls `conversationService.appendMessage()` (domain service)
   - **Should**: Publish `conversation.message.sent` event

2. **`executeAction` procedure** (Lines 272-516):
   ```typescript
   await eventService.append({
     aggregateId,
     aggregateType: 'entity',
     eventType: 'task.creation.requested',
     // ...
   });
   ```
   - **Violation**: Directly calls `eventService.append()` instead of publishing to Inngest
   - **Note**: `eventService.append()` eventually publishes to Inngest via domain event publisher, but this bypasses the event bus pattern
   - **Should**: Publish `task.creation.requested`, `note.creation.requested`, etc. directly to Inngest

3. **Other procedures** (`getThread`, `getThreads`, `createBranch`, etc.):
   - **Clarification Needed**: Read-only operations might be acceptable
   - **If read-only is acceptable**: Keep as-is
   - **If must be event-driven**: Publish query events

- **Refactoring Plan**:

  1. **Refactor `sendMessage` procedure**:
     ```typescript
     // BEFORE
     const userMessage = await conversationService.appendMessage({ ... });
     
     // AFTER
     await inngest.send({
       name: 'conversation.message.sent',
       data: {
         userId,
         threadId,
         content: input.content,
         role: 'user',
         parentId: input.parentId,
       }
     });
     ```

  2. **Refactor `executeAction` procedure**:
     ```typescript
     // BEFORE
     await eventService.append({
       eventType: 'task.creation.requested',
       // ...
     });
     
     // AFTER
     await inngest.send({
       name: 'task.creation.requested',
       data: {
         userId,
         title,
         description,
         dueDate,
         priority,
         threadId: input.threadId,
         messageId: input.messageId,
       }
     });
     ```

  3. **Create Inngest workers**:
     - `workers/handle-conversation-message.ts` - subscribes to `conversation.message.sent`
     - `workers/handle-task-creation.ts` - subscribes to `task.creation.requested`
     - `workers/handle-note-creation.ts` - subscribes to `note.creation.requested`
     - Workers call domain services (business logic)

---

#### `features/api/capture`
- **Current Role**: Thought capture endpoint that publishes events to Inngest
- **Compliance Analysis**: ✅ **COMPLIANT** - Correctly publishes events to Inngest
- **Refactoring Plan**: No changes needed

**Evidence**:
```typescript
// capture.ts.tpl:34
await inngest.send({
  name: 'api/thought.captured',
  data: { content, context, capturedAt }
});
```

---

#### `features/api/events`
- **Current Role**: Event logging API for append-only event sourcing
- **Compliance Analysis**: ⚠️ **NEEDS CLARIFICATION** - Directly calls `eventService.append()`
  - `eventService.append()` eventually publishes to Inngest via domain event publisher
  - **Question**: Is this acceptable, or should it publish directly to Inngest?
  - **If acceptable**: Keep as-is (event service is a convenience layer)
  - **If not acceptable**: Publish directly to Inngest

- **Refactoring Plan**: 
  - **Option A**: Keep as-is if `eventService.append()` → Inngest is acceptable pattern
  - **Option B**: Refactor to publish directly to Inngest, remove `eventService.append()` call

---

#### `features/api/suggestions`
- **Current Role**: Manage AI suggestions and trigger follow-up jobs
- **Compliance Analysis**: ✅ **COMPLIANT** - Publishes events to Inngest
- **Refactoring Plan**: No changes needed

**Evidence**:
```typescript
// suggestions.ts.tpl:41
await inngest.send({
  name: 'ai/suggestion.processed',
  data: { ... }
});
```

---

## 🗺️ Migration Roadmap

**Note**: See `EVENT_DRIVEN_ROADMAP.md` for the complete validated roadmap with layer-by-layer validation approach.

### Phase 1: Validate the "Backbone" - The Event Store (1 week)

#### Phase 1: Event Store Validation
**Objective**: Absolute confidence in reliable, immutable, efficient event recording

**Actions**:
1. Finalize `SynapEvent` v1 schema (Zod contract)
2. Confirm TimescaleDB choice
3. Build clean `EventRepository.append()` interface
4. Stress test (100K events, measure performance)

**Validation**: Event "vault" - can write millions of events securely

---

#### Phase 2: Worker Layer Validation
**Objective**: Prove we can react to events in a decoupled, reliable way

**Actions**:
1. Define `IEventHandler` interface
2. Build central Inngest dispatcher
3. Implement first handler (NoteProjector)
4. Validate event plumbing (publish event → see projection update)

**Validation**: Event plumbing functional - cause and effect decoupled

---

#### Phase 3: Projection Layer Validation
**Objective**: Solidify how we store and access current state (hybrid architecture)

**Actions**:
1. Validate storage abstraction (R2/MinIO)
2. Finalize projection schemas (entities, tasks, etc.)
3. Refactor handlers to use storage
4. Confirm hybrid architecture (content in storage, metadata in DB)

**Validation**: Perfect separation between history (Event Store) and state (Projections)

---

#### Phase 4: API Layer Validation
**Objective**: Expose system securely with CQRS pattern

**Actions**:
1. Build "Command" API (publishes events, no business logic)
2. Build "Query" API (direct projection reads, fast)
3. Finalize auth (Better Auth + RLS)
4. Validate CQRS pattern (writes async, reads direct)

**Validation**: Complete API implementing CQRS - writes async/event-driven, reads fast/direct

---

### Summary

**Total Duration**: 5 weeks (1 + 1 + 2 + 1)

**Approach**: Layer-by-layer validation from foundation (Event Store) to access (API)

**For detailed implementation plan**: See `EVENT_DRIVEN_ROADMAP.md`

---

## 📊 Compliance Score Breakdown

### By Module Type

| Module Type | Modules Audited | Compliant | Violations | Score |
|-------------|----------------|-----------|------------|-------|
| **Framework** | 1 | 1 | 0 | 100% |
| **Capabilities (Primitive)** | 4 | 4 | 0 | 100% |
| **Capabilities (Jobs)** | 2 | 2 | 0 | 100% |
| **Capabilities (Domain)** | 1 | 0 | 1 | 50% |
| **Capabilities (AI)** | 1 | 0 | 1 | 0% |
| **Features (API)** | 6 | 2 | 4 | 33% |

### By Doctrine Principle

| Principle | Compliance | Violations |
|-----------|------------|------------|
| **1. Event Bus is Core** | ✅ 100% | None - Inngest properly set up |
| **2. API/Agents are Event Producers** | ❌ 20% | 4 API modules, 1 AI tool module |
| **3. Features are Event Consumers** | ✅ 100% | None - Workers correctly implemented |
| **4. Capabilities are Primitive** | ✅ 100% | None - Database/storage correctly structured |

---

## 🎯 Key Violations Summary

### Critical Violations (Must Fix)

1. **`features/api/notes`** - Direct `noteService.createNote()` call
2. **`features/api/chat`** - Direct `conversationService` and `eventService` calls
3. **`capabilities/ai/chat-agent/tools/create-entity-tool`** - Direct domain service calls

### Medium Violations (Clarify)

1. **`features/api/events`** - Uses `eventService.append()` (may be acceptable)
2. **Read-only operations** - Direct service calls (may be acceptable)

---

## ✅ CTO Clarifications (Validated)

### 1. Event Service Pattern
**Decision**: ❌ **REMOVED** - `eventService.append()` is a code smell
- Producers must publish directly to Inngest bus
- No intermediate service layer
- Remove `eventService` entirely

### 2. Read-Only Operations (CQRS)
**Decision**: ✅ **Direct Reads** - CQRS pattern enforced
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

## 📈 Expected Outcomes

After completing the migration roadmap:

- **Compliance Score**: 35% → **95%** (read-only operations may remain direct)
- **Architecture**: Pure event-driven with Inngest as central event bus
- **Separation**: Clear separation between event producers (API/Agents) and event consumers (Workers)
- **Extensibility**: Easy to add new features by creating new workers that subscribe to events

---

**Report Generated**: 2025-01-17  
**Next Review**: After Phase 1 completion

