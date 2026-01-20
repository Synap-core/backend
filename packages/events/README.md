# Event Architecture V2.0

## Overview

Synap uses a **schema-driven event sourcing architecture** where all state changes flow through a standardized event pattern. V2.0 consolidates the event system into a clear, consistent flow that enables fine-grained control for both users and AI agents.

## The Pattern

### Core Structure

```
{table}.{action}.{modifier}
```

- **table**: Database table (e.g., `entities`, `documents`, `chatThreads`)
- **action**: CRUD operation (`create`, `update`, `delete`)
- **modifier**: Flow stage (`requested`, `validated`)

### Example Events

```typescript
// Creation flow
"entities.create.requested"; // Intent submitted
"entities.create.validated"; // Change confirmed and applied

// Update flow
"entities.update.requested"; // Update intent
"entities.update.validated"; // Update confirmed

// Deletion flow
"entities.delete.requested"; // Delete intent
"entities.delete.validated"; // Delete confirmed
```

## Why This Pattern?

### 1. **Explicit Intent vs. Execution**

Every state change has two phases:

- **Requested**: Expresses intent (from user or AI)
- **Validated**: Confirms execution (after approval/validation)

This separation creates an audit trail and enables intervention points.

### 2. **User Control Over AI Actions**

AI agents can propose changes without directly modifying data:

```typescript
// AI suggests creating a task
await publishEvent({
  type: "entities.create.requested",
  data: {
    type: "task",
    title: "AI-suggested task",
    source: "ai-agent",
  },
});

// User reviews and approves (or system auto-approves)
// Only then: entities.create.validated is published
```

### 3. **Granular Access Control**

Different actors have different permissions:

| Actor        | Can Publish   | Auto-Validated       |
| ------------ | ------------- | -------------------- |
| **User**     | `*.requested` | ✅ Yes (instant)     |
| **AI Agent** | `*.requested` | ❌ Requires approval |
| **System**   | `*.validated` | ✅ Always            |

### 4. **Data Pod Integration**

For personal data pods, users can configure:

- Which AI agents can auto-validate
- Which changes require manual review
- Audit logs of all AI proposals

```typescript
// Data pod configuration
{
  "ai_permissions": {
    "gpt-4": {
      "auto_validate": ["entities.create.requested"],
      "require_review": ["entities.delete.requested"]
    }
  }
}
```

## Architecture

### Event Flow

```
┌─────────────┐
│ User/AI     │
│ Action      │
└──────┬──────┘
       │
       ▼
┌─────────────────────────┐
│ {table}.{action}        │
│       .requested        │◄─── Intent expressed
└──────────┬──────────────┘
           │
           ▼
      ┌────────┐
      │Validate│──► User approval
      │  ?     │    Policy check
      └────┬───┘    Permission check
           │
           ▼
┌─────────────────────────┐
│ {table}.{action}        │
│       .validated        │◄─── Execution confirmed
└──────────┬──────────────┘
           │
           ▼
    ┌──────────────┐
    │  DB Write    │
    │ Side Effects │
    └──────────────┘
```

### Generated Event Types

Events are automatically generated from database tables:

```typescript
// packages/events/src/generator.ts
export const CORE_TABLES = [
  "entities",
  "documents",
  "documentVersions",
  "chatThreads",
  "conversationMessages",
  "webhookSubscriptions",
  "apiKeys",
  "tags",
  "agents",
] as const;

// Result: 9 tables × 6 events = 54 generated events
```

## Usage

### Publishing Events

```typescript
import { createSynapEvent, GeneratedEventTypes } from "@synap/types";
import { publishEvent } from "@synap/events";

// User creates a note
const event = createSynapEvent({
  type: GeneratedEventTypes.entities["create.requested"],
  userId: "user-123",
  data: {
    type: "note",
    title: "My Note",
    content: "...",
  },
});

await publishEvent("api/event.logged", event);
```

### Subscribing to Events

```typescript
import { inngest } from "./inngest";

// Worker that processes validated entities
export const entityCreatedHandler = inngest.createFunction(
  { id: "entity-created-handler" },
  { event: "entities.create.validated" },
  async ({ event }) => {
    // Process the validated entity
    const { entityId, type } = event.data;
    await processEntity(entityId, type);
  }
);
```

## Extension Points

### Adding New Tables

1. **Add to generator**:

```typescript
// packages/events/src/generator.ts
export const CORE_TABLES = [
  // ...
  "myNewTable",
] as const;
```

2. **Events auto-generate**:

```
myNewTable.create.requested
myNewTable.create.validated
myNewTable.update.requested
myNewTable.update.validated
myNewTable.delete.requested
myNewTable.delete.validated
```

### Custom Validation Logic

```typescript
// Implement custom approval workflow
inngest.createFunction(
  { id: "ai-proposal-reviewer" },
  { event: "*.create.requested" },
  async ({ event }) => {
    if (event.data.source === "ai-agent") {
      // Check if auto-approve is enabled
      const canAutoApprove = await checkAIPermissions(
        event.userId,
        event.data.aiAgent
      );

      if (canAutoApprove) {
        // Auto-approve
        await publishEvent({
          type: event.type.replace(".requested", ".validated"),
          ...event,
        });
      } else {
        // Queue for manual review
        await queueForReview(event);
      }
    }
  }
);
```

### Adding System Events

For cross-cutting concerns that don't map to tables:

```typescript
// packages/types/src/event-types.ts
export const SystemEventTypes = {
  WEBHOOK_DELIVERY: "webhooks.deliver.requested",
  EMAIL_SEND: "emails.send.requested",
  // ...
} as const;
```

## Migration from V1

### Breaking Changes

| V1 Event                    | V2 Event                                          |
| --------------------------- | ------------------------------------------------- |
| `entities.create`           | ❌ Removed (use `.requested`)                     |
| `entities.create.completed` | ✅ `entities.create.validated`                    |
| `taskDetails.*`             | ❌ Removed (extension table)                      |
| `projects.*`                | ❌ Removed (use `entities` with `type='project'`) |

### Update Pattern

```typescript
// Before (V1)
type: "entities.create.completed";

// After (V2)
type: GeneratedEventTypes.entities["create.validated"];
```

## Best Practices

### 1. Always Use Generated Types

```typescript
// ✅ Good
type: GeneratedEventTypes.entities["create.requested"];

// ❌ Bad (hard-coded strings)
type: "entities.create.requested";
```

### 2. Validate at Boundaries

```typescript
import { isGeneratedEventType } from "@synap/events";

if (!isGeneratedEventType(eventType)) {
  throw new Error(`Invalid event type: ${eventType}`);
}
```

### 3. Document Data Schemas

```typescript
// packages/types/src/synap-event.ts
export const EventTypeSchemas = {
  "entities.create.requested": z.object({
    type: z.string(),
    title: z.string().optional(),
    content: z.string().optional(),
    // ...
  }),
};
```

## Monitoring

### Event Counts

```bash
curl http://localhost:3000/trpc/system.getCapabilities

# Response:
{
  "eventTypes": 55,  // 54 generated + 1 system
  "workers": 7
}
```

### Pattern Breakdown

- **requested**: 27 events
- **validated**: 27 events
- **system**: 1 event

## Future Enhancements

### Planned Features

1. **Conditional Validation**
   - Rule-based approval workflows
   - Multi-step approvals for sensitive operations

2. **Event Replay**
   - Time-travel debugging
   - State reconstruction from events

3. **Federation**
   - Cross-pod event propagation
   - Distributed event sourcing

## References

- [Event Sourcing Pattern](https://martinfowler.com/eaaDev/EventSourcing.html)
- [CQRS](https://martinfowler.com/bliki/CQRS.html)
- [Inngest Documentation](https://www.inngest.com/docs)
