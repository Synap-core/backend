# Synap Event-Driven Architecture with Unified Metadata

> **The Definitive Guide to Events and AI Enrichments in the Synap Platform**

## Table of Contents

1. [Philosophy & Design Principles](#philosophy--design-principles)
2. [Architecture Overview](#architecture-overview)
3. [The Unified Event Model](#the-unified-event-model)
4. [Metadata Extensibility](#metadata-extensibility)
5. [Adding Your Own Intelligence](#adding-your-own-intelligence)
6. [Adding Custom Types](#adding-custom-types)
7. [Creating New Agents](#creating-new-agents)
8. [Query Patterns](#query-patterns)
9. [Best Practices](#best-practices)

---

## Philosophy & Design Principles

### The Core Insight

**Every event is a first-class citizen, regardless of who created it (user or AI).**

```typescript
// User creates a task manually
{
  type: 'entity.created',
  data: { id: 'task_123', type: 'task', title: 'Call John' },
  metadata: undefined  // No additional context
}

// AI extracts a task from conversation
{
  type: 'entity.created',  // SAME event type!
  data: { id: 'task_456', type: 'task', title: 'Call John' },
  metadata: {
    ai: {
      agent: 'orchestrator',
      confidence: { score: 0.92 },
      extraction: {
        extractedFrom: { messageId: 'msg_789', threadId: 'thread_abc' },
        method: 'explicit',
      },
    },
  },
}
```

**Both create real entities. The metadata tells the story of how it came to be.**

### Why This Approach?

| Design Choice | Benefit |
|---------------|---------|
| **Unified events** | AI and humans are equal producers |
| **Metadata is optional** | Zero overhead when not needed |
| **Event type stays the same** | No event explosion |
| **Metadata is extensible** | AI, import, sync, automation, plugins... |
| **Intelligence-agnostic core** | Data Pod doesn't know about AI |

### Core Principles

| Principle | Description |
|-----------|-------------|
| **Immutability** | Events are never modified or deleted |
| **Single Source of Truth** | Events table is authoritative |
| **Projections are Disposable** | Can be rebuilt from events anytime |
| **Dynamic by Default** | JSONB allows any data structure |
| **Type Safety is Optional** | TypeScript types are for DX, not enforcement |
| **Loose Coupling** | Intelligence Hub doesn't need Data Pod internals |

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│  USER PATH                               AI PATH                             │
│                                                                              │
│  User clicks                             User types message                  │
│  "Create Task"                           "Remind me to call John"            │
│       │                                          │                           │
│       │                                          ▼                           │
│       │                                 ┌─────────────────────┐              │
│       │                                 │  Intelligence Hub   │              │
│       │                                 │  (extracts entity)  │              │
│       │                                 │  + adds metadata    │              │
│       │                                 └──────────┬──────────┘              │
│       │                                            │                         │
│       ▼                                            ▼                         │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                                                                        │ │
│  │   EVENT: entity.created                                                │ │
│  │   ├─ data: { type: 'task', title: 'Call John' }                        │ │
│  │   └─ metadata?: { ai?: { agent, confidence, extraction... } }          │ │
│  │                   ▲                                                    │ │
│  │                   └── Optional AI context                              │ │
│  │                                                                        │ │
│  └────────────────────────────────────┬───────────────────────────────────┘ │
│                                       │                                      │
│                                       ▼                                      │
│                              ┌─────────────────┐                            │
│                              │    DATA POD     │                            │
│                              │  Events Table   │                            │
│                              └────────┬────────┘                            │
│                                       │                                      │
│                           ┌───────────┼───────────┐                         │
│                           ▼           ▼           ▼                         │
│                    ┌───────────┐ ┌───────────┐ ┌───────────┐               │
│                    │ entities  │ │enrichments│ │   ...     │               │
│                    │(projected)│ │(from meta)│ │           │               │
│                    └───────────┘ └───────────┘ └───────────┘               │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## The Unified Event Model

### Event Structure

```typescript
interface SynapEvent {
  // Identity
  id: string;           // UUID
  version: 'v1';        // Schema version
  
  // Classification
  type: string;         // e.g., 'entity.created', 'note.creation.completed'
  aggregateId?: string; // Entity ID this event relates to
  
  // WHAT happened (core payload)
  data: Record<string, unknown>;
  
  // HOW/WHY it happened (extensible context)
  metadata?: Record<string, unknown>;
  
  // Ownership & Source
  userId: string;
  source: 'api' | 'automation' | 'sync' | 'migration' | 'system' | 'intelligence';
  timestamp: Date;
  
  // Tracing
  correlationId?: string;
  causationId?: string;
  requestId?: string;
}
```

### The `data` vs `metadata` Split

| Field | Purpose | Example |
|-------|---------|---------|
| `data` | **WHAT** happened | `{ id, type, title, content }` |
| `metadata` | **HOW/WHY** it happened | `{ ai: {...}, import: {...} }` |

```typescript
// Example: Task created by AI from conversation
{
  type: 'entity.created',
  
  // WHAT: A task was created
  data: {
    id: 'task_123',
    type: 'task',
    title: 'Call John tomorrow',
  },
  
  // HOW: AI extracted it from a message
  metadata: {
    ai: {
      agent: 'orchestrator',
      confidence: { score: 0.92, reasoning: 'User said "remind me"' },
      extraction: {
        extractedFrom: { messageId: 'msg_456', threadId: 'thread_789' },
        method: 'explicit',
      },
    },
  },
  
  source: 'intelligence',
  userId: 'user_abc',
}
```

---

## Metadata Extensibility

### Built-in Metadata Types

```typescript
interface EventMetadata {
  // AI enrichment context
  ai?: AIMetadata;
  
  // Import from external sources
  import?: ImportMetadata;
  
  // Sync from mobile/devices
  sync?: SyncMetadata;
  
  // Rule-based automation
  automation?: AutomationMetadata;
  
  // Extensible: any additional context
  custom?: Record<string, unknown>;
}
```

### AI Metadata Structure

```typescript
interface AIMetadata {
  // Required: which agent produced this
  agent: string;
  
  // Optional: confidence scoring
  confidence?: {
    score: number;      // 0.0 - 1.0
    reasoning?: string; // Why this confidence?
  };
  
  // Optional: if extracted from conversation
  extraction?: {
    extractedFrom: {
      messageId: string;
      threadId: string;
      content?: string;  // Snippet that triggered
    };
    method: 'explicit' | 'implicit' | 'relationship';
  };
  
  // Optional: classification results
  classification?: {
    categories: Array<{ name: string; confidence: number }>;
    tags?: string[];
    method: 'embedding_similarity' | 'llm_analysis' | 'rule_based';
  };
  
  // Optional: discovered relationships
  relationships?: {
    relationships: Array<{
      targetEntityId: string;
      type: 'related_to' | 'part_of' | 'depends_on' | ...;
      confidence: number;
      bidirectional: boolean;
    }>;
  };
  
  // Optional: reasoning trace for transparency
  reasoning?: {
    steps: Array<{
      type: 'thinking' | 'tool_call' | 'tool_result' | 'decision';
      content: string;
    }>;
    outcome?: { action: string; confidence: number };
    durationMs?: number;
  };
  
  // Optional: inferred properties (flexible)
  inferredProperties?: Record<string, unknown>;
}
```

### Import Metadata Structure

```typescript
interface ImportMetadata {
  source: 'notion' | 'obsidian' | 'roam' | 'logseq' | 'markdown' | 'csv' | 'api' | 'other';
  externalId?: string;
  externalUrl?: string;
  importedAt: Date;
  batchId?: string;
  transformed?: boolean;
}
```

### Sync Metadata Structure

```typescript
interface SyncMetadata {
  deviceId: string;
  platform: 'ios' | 'android' | 'web' | 'desktop' | 'cli';
  syncedAt: Date;
  offline?: boolean;
  conflictResolution?: 'client_wins' | 'server_wins' | 'merged';
}
```

---

## Adding Your Own Intelligence

### Example: AI Creates Entity with Metadata

```typescript
import { createSynapEvent, EventTypes, createAIExtractionMetadata } from '@synap/types';

// In your agent/intelligence service:
async function createEntityFromMessage(params: {
  message: { id: string; threadId: string; content: string };
  userId: string;
}) {
  // 1. AI analyzes the message and extracts entity
  const extracted = await myAIModel.extractEntity(params.message.content);
  
  // 2. Create event with AI metadata
  const event = createSynapEvent({
    type: EventTypes.ENTITY_CREATED,
    userId: params.userId,
    source: 'intelligence',
    aggregateId: extracted.entityId,
    
    // WHAT happened
    data: {
      id: extracted.entityId,
      type: extracted.type,
      title: extracted.title,
      preview: extracted.preview,
    },
    
    // HOW/WHY it happened
    metadata: createAIExtractionMetadata({
      agent: 'my-extraction-agent',
      messageId: params.message.id,
      threadId: params.message.threadId,
      confidence: extracted.confidence,
      method: 'explicit',
      reasoning: 'User said "remind me to..." which indicates task creation',
    }),
  });
  
  // 3. Publish to Data Pod
  await dataPod.events.publish(event);
}
```

### Example: External Intelligence Service

```typescript
// my-analytics-service/index.ts
const synap = new SynapClient({ ... });

// Subscribe to entity creation events
synap.events.subscribe('entity.created', async (event) => {
  // Skip if already has AI classification
  if (event.metadata?.ai?.classification) {
    return;
  }
  
  // Run classification
  const classification = await myClassifier.classify(event.data);
  
  // Emit update event with classification metadata
  await synap.events.publish({
    type: 'entity.updated',
    aggregateId: event.aggregateId,
    userId: event.userId,
    source: 'intelligence',
    data: {
      // No data changes, just adding metadata
    },
    metadata: {
      ai: {
        agent: 'my-classifier',
        classification: {
          categories: classification.categories,
          tags: classification.tags,
          method: 'embedding_similarity',
        },
      },
    },
  });
});
```

---

## Adding Custom Types

### Step 1: Define Your Metadata Schema

```typescript
// @my-package/types/metadata.ts
import { z } from 'zod';

export const MyAnalyticsMetadataSchema = z.object({
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  topics: z.array(z.string()),
  score: z.number().min(0).max(100),
  processedBy: z.string(),
});

export type MyAnalyticsMetadata = z.infer<typeof MyAnalyticsMetadataSchema>;
```

### Step 2: Use in Events

```typescript
import { createSynapEvent, EventTypes } from '@synap/types';
import { MyAnalyticsMetadataSchema } from './types/metadata';

// Validate your metadata
const analyticsData = MyAnalyticsMetadataSchema.parse({
  sentiment: 'positive',
  topics: ['productivity', 'ai'],
  score: 85.5,
  processedBy: 'my-analytics-v2',
});

// Publish with custom metadata
const event = createSynapEvent({
  type: EventTypes.ENTITY_UPDATED,
  aggregateId: entityId,
  userId: userId,
  source: 'automation',
  data: { /* ... */ },
  metadata: {
    custom: {
      myAnalytics: analyticsData,
    },
  },
});
```

### Step 3: Query Your Metadata

```sql
-- No schema changes needed! Query via JSONB
SELECT 
  id,
  data->>'title' as title,
  metadata->'custom'->'myAnalytics'->>'sentiment' as sentiment,
  (metadata->'custom'->'myAnalytics'->>'score')::float as score
FROM events
WHERE type = 'entity.updated'
  AND metadata->'custom'->'myAnalytics' IS NOT NULL;
```

---

## Creating New Agents

### Minimal Agent Template

```typescript
// agents/my-agent.ts
import { createSynapEvent, EventTypes, EventMetadata } from '@synap/types';

interface AgentContext {
  message: { id: string; threadId: string; content: string };
  userId: string;
  entities: Entity[];
}

export async function runMyAgent(ctx: AgentContext): Promise<void> {
  // 1. Your AI logic
  const result = await myAIModel.process(ctx);
  
  // 2. Create entities with AI metadata
  for (const extraction of result.extractions) {
    const metadata: EventMetadata = {
      ai: {
        agent: 'my-agent',
        confidence: { score: extraction.confidence },
        extraction: {
          extractedFrom: {
            messageId: ctx.message.id,
            threadId: ctx.message.threadId,
          },
          method: extraction.method,
        },
        reasoning: {
          steps: result.reasoningSteps,
          outcome: { action: 'entity_created', confidence: extraction.confidence },
        },
      },
    };
    
    await dataPod.events.publish(createSynapEvent({
      type: EventTypes.ENTITY_CREATED,
      userId: ctx.userId,
      source: 'intelligence',
      aggregateId: extraction.id,
      data: extraction.data,
      metadata,
    }));
  }
}
```

---

## Query Patterns

### Check if Entity was AI-Created

```sql
-- Simple check
SELECT * FROM events 
WHERE type = 'entity.created'
  AND metadata->'ai' IS NOT NULL;

-- Get AI agent that created it
SELECT 
  data->>'id' as entity_id,
  data->>'title' as title,
  metadata->'ai'->>'agent' as created_by_agent,
  (metadata->'ai'->'confidence'->>'score')::float as confidence
FROM events
WHERE type = 'entity.created'
  AND metadata->'ai'->'extraction' IS NOT NULL;
```

### Get Extraction Source

```sql
-- Find what message an entity was extracted from
SELECT 
  data->>'id' as entity_id,
  metadata->'ai'->'extraction'->'extractedFrom'->>'messageId' as source_message,
  metadata->'ai'->'extraction'->'extractedFrom'->>'threadId' as source_thread
FROM events
WHERE type = 'entity.created'
  AND aggregateId = $1
  AND metadata->'ai'->'extraction' IS NOT NULL;
```

### Use Materialized Projections

```typescript
// Fast query via projections (if projector is enabled)
const enrichments = await trpc.enrichments.getEntityEnrichments.query({
  entityId: 'entity_123',
});

// Returns: { extraction: {...}, classification: {...}, relationships: [...] }
```

---

## Best Practices

### ✅ Do

| Practice | Reason |
|----------|--------|
| Include `agent` in AI metadata | Know which system created it |
| Add confidence scores | Let consumers filter by quality |
| Add reasoning traces | Enable transparency and debugging |
| Validate metadata at producer | Catch errors early |
| Use `source: 'intelligence'` | Clearly mark AI events |

### ❌ Don't

| Anti-Pattern | Why It's Bad |
|--------------|--------------|
| Create separate enrichment events | Use metadata instead |
| Modify events after creation | Breaks immutability |
| Put huge blobs in metadata | Keep focused |
| Skip userId | Breaks multi-tenancy |

### Metadata Size Guidance

| Size | Recommendation |
|------|----------------|
| < 10KB | ✅ Perfect |
| 10-100KB | ⚠️ Consider if all fields needed |
| > 100KB | ❌ Store separately, reference by ID |

---

## Summary

The Synap unified event model provides:

1. **Simplicity**: One event type per action, metadata for context
2. **Equality**: AI and humans create events the same way
3. **Extensibility**: Metadata supports AI, import, sync, automation, custom
4. **Traceability**: Full audit trail with provenance
5. **Performance**: Projections materialize hot paths
6. **Type Safety**: Optional but recommended for DX

**Events tell what happened. Metadata tells the story of how and why.**
