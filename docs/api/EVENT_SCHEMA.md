# SynapEvent Schema Reference

**Version:** v1  
**Last Updated:** 2025-12-04  

---

## Overview

All events in the Synap system must conform to the `SynapEvent` schema. This schema is defined using Zod and provides runtime validation for all event data.

**Location:** `packages/types/src/synap-event.ts`

---

## Required Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `id` | `string` (UUID) | Unique event identifier | `"123e4567-e89b-12d3-a456-426614174000"` |
| `version` | `'v1'` (literal) | Schema version | `'v1'` ⚠️ **Not** `1` |
| `type` | `string` | Event type descriptor | `'note.created'`, `'entity.updated'` |
| `data` | `Record<string, unknown>` | Event payload | `{ content: "..." }` |
| `userId` | `string` | User who triggered event | `"user-123"` |
| `source` | `EventSource` (enum) | Event origin | `'api'` |
| `timestamp` | `Date` | When event occurred | `new Date()` |

---

## Optional Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `aggregateId` | `string` (UUID) | Related aggregate ID | `"entity-456"` |
| `correlationId` | `string` (UUID) | Request correlation | `"req-789"` |
| `causationId` | `string` (UUID) | Causing event ID | `"event-012"` |
| `requestId` | `string` (UUID) | HTTP request ID | `"req-345"` |

---

## EventSource Enum

The `source` field **must** be one of these values:

| Value | Description | When to Use |
|-------|-------------|-------------|
| `'api'` | From API requests | HTTP/REST/tRPC endpoints |
| `'automation'` | From automated processes | Scheduled tasks, triggers |
| `'sync'` | From synchronization | Data sync operations |
| `'migration'` | From data migration | Schema migrations, imports |
| `'system'` | From system operations | Internal system events |

---

## Common Event Types

### Entity Events
```typescript
'entity.created'    // New entity created
'entity.updated'    // Entity modified
'entity.deleted'    // Entity soft-deleted
```

### Note Events
```typescript
'note.created'      // New note created
'note.updated'      // Note content changed
'note.archived'     // Note archived
```

### Knowledge Events
```typescript
'knowledge.extracted'    // Facts extracted from content
'knowledge.linked'       // Entities linked together
```

---

## Creating Events

### Basic Example

```typescript
import type { SynapEvent } from '@synap/types';

const event: SynapEvent = {
  id: crypto.randomUUID(),
  version: 'v1',           // ⚠️ Must be literal 'v1'
  type: 'note.created',
  userId: 'user-123',
  data: { 
    content: 'My note',
    title: 'Meeting Notes' 
  },
  source: 'api',           // ⚠️ Must be valid enum value
  timestamp: new Date(),
};
```

### With Optional Fields

```typescript
const event: SynapEvent = {
  id: crypto.randomUUID(),
  version: 'v1',
  type: 'entity.updated',
  userId: 'user-123',
  data: { changes: { title: 'New Title' } },
  source: 'api',
  timestamp: new Date(),
  // Optional fields
  aggregateId: 'entity-456',
  correlationId: 'req-789',
  requestId: 'req-345',
};
```

---

## Common Mistakes

### ❌ Wrong: Number Version
```typescript
const event = {
  version: 1,  // ❌ Type error!
  // ...
};
```

### ✅ Correct: String Literal
```typescript
const event: SynapEvent = {
  version: 'v1',  // ✅ Correct
  // ...
};
```

---

### ❌ Wrong: Invalid Source
```typescript
const event = {
  source: 'user',      // ❌ Not in enum!
  source: 'frontend',  // ❌ Not valid!
  // ...
};
```

### ✅ Correct: Valid Enum Value
```typescript
const event: SynapEvent = {
  source: 'api',        // ✅ Valid
  source: 'automation', // ✅ Valid
  // ...
};
```

---

### ❌ Wrong: Missing Required Fields
```typescript
const event = {
  id: crypto.randomUUID(),
  type: 'note.created',
  // ❌ Missing: version, userId, data, source, timestamp
};
```

### ✅ Correct: All Required Fields
```typescript
const event: SynapEvent = {
  id: crypto.randomUUID(),
  version: 'v1',
  type: 'note.created',
  userId: 'user-123',
  data: { content: 'Note' },
  source: 'api',
  timestamp: new Date(),
};
```

---

## Validation

Events are validated at runtime using Zod:

```typescript
import { SynapEventSchema } from '@synap/types';

// Validate event
const result = SynapEventSchema.safeParse(event);

if (!result.success) {
  console.error('Invalid event:', result.error);
} else {
  console.log('Valid event:', result.data);
}
```

---

## Storage Considerations

### Date Serialization

When storing events in PostgreSQL via postgres.js:

```typescript
// ❌ Wrong: Date object directly
await sql`INSERT INTO events (...) VALUES (${event.timestamp})`;

// ✅ Correct: Convert to ISO string
await sql`INSERT INTO events (...) VALUES (${event.timestamp.toISOString()})`;
```

### EventRepository Usage

The `EventRepository` handles serialization automatically:

```typescript
import { eventRepository } from '@synap/database';

// ✅ EventRepository handles Date conversion
await eventRepository.append(event);
```

---

## Testing Events

### Creating Test Events

```typescript
import type { SynapEvent } from '@synap/types';

const createTestEvent = (userId: string): SynapEvent => ({
  id: crypto.randomUUID(),
  version: 'v1',
  type: 'note.created',
  userId,
  data: { content: 'Test content' },
  source: 'api',  // Always use 'api' in tests
  timestamp: new Date(),
});

// Usage in tests
const event = createTestEvent('test-user-123');
```

---

## Type Safety

TypeScript provides full type safety:

```typescript
import type { SynapEvent } from '@synap/types';

function processEvent(event: SynapEvent) {
  // TypeScript knows all fields
  console.log(event.id);        // ✅ string
  console.log(event.version);   // ✅ 'v1'
  console.log(event.source);    // ✅ EventSource enum
  console.log(event.data);      // ✅ Record<string, unknown>
}
```

---

## Schema Definition

Full Zod schema (for reference):

```typescript
export const SynapEventSchema = z.object({
  id: z.string().uuid(),
  version: z.literal('v1'),
  type: z.string(),
  data: z.record(z.unknown()),
  userId: z.string(),
  source: z.enum(['api', 'automation', 'sync', 'migration', 'system']),
  timestamp: z.date(),
  aggregateId: z.string().uuid().optional(),
  correlationId: z.string().uuid().optional(),
  causationId: z.string().uuid().optional(),
  requestId: z.string().uuid().optional(),
});

export type SynapEvent = z.infer<typeof SynapEventSchema>;
```

---

## Best Practices

### 1. Always Use Type Annotation
```typescript
const event: SynapEvent = { /* ... */ };  // ✅ Catches errors early
```

### 2. Generate UUIDs Properly
```typescript
id: crypto.randomUUID()  // ✅ Browser-safe
id: uuid()               // ✅ If using uuid package
```

### 3. Use Current Timestamp
```typescript
timestamp: new Date()    // ✅ Current time
```

### 4. Meaningful Event Types
```typescript
type: 'note.created'     // ✅ Clear action
type: 'created'          // ❌ Too vague
```

### 5. Structured Data Payload
```typescript
data: {                  // ✅ Structured
  content: '...',
  metadata: { ... }
}

data: { raw: '...' }     // ❌ Unstructured
```

---

## References

- **Schema Definition:** `packages/types/src/synap-event.ts`
- **Repository:** `packages/database/src/repositories/event-repository.ts`
- **Tests:** `packages/database/src/__tests__/event-repository.test.ts`
- **Error Report:** See `error_resolution_report.md` for common pitfalls

---

## Need Help?

**Common Issues:**
1. Version as number → Use `'v1'` (string literal)
2. Invalid source → Check enum values above
3. Missing fields → Ensure all required fields present
4. Date serialization → Use EventRepository or convert to ISO string

**Further Reading:**
- Event Sourcing patterns
- CQRS architecture
- Database testing guide
