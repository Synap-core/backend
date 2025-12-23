# @synap/sdk

High-level SDK for Synap - Event-sourced personal data platform

## Installation

```bash
pnpm add @synap/sdk
```

## Quick Start

```typescript
import { SynapSDK } from '@synap/sdk';

// Initialize SDK
const synap = new SynapSDK({
  url: 'https://api.synap.app',
  apiKey: 'your-api-key'
});

// Create entity (event-sourced)
const { entityId } = await synap.entities.create({
  type: 'task',
  title: 'Call Marie tomorrow',
  metadata: {
    dueDate: '2024-12-20',
    priority: 'high'
  }
});

// Create relationship (event-sourced)
await synap.relations.create(entityId, personId, 'assigned_to');

// Query data (direct reads)
const tasks = await synap.entities.list({ type: 'task' });
const history = await synap.events.getHistory(entityId);
```

## Architecture

### Event Sourcing

All **mutations** go through event sourcing:
- `entities.create/update/delete` → `events.log` → Inngest worker → Database
- `relations.create/delete` → `events.log` → Inngest worker → Database

All **queries** are direct database reads:
- `entities.get/list/search` → Direct query
- `relations.get/getRelated` → Direct query
- `events.getHistory` → Direct query

### Benefits

- **Audit trail**: Every change logged as immutable event
- **Time travel**: Replay events to see past states
- **Reliability**: Workers handle async processing with retries
- **Real-time**: Events trigger webhooks and SSE broadcasts

## API Reference

### Entities API

```typescript
// Create
const { entityId } = await synap.entities.create({
  type: 'note',
  title: 'Meeting Notes',
  content: '# Discussion points...'
});

// Update
await synap.entities.update(entityId, {
  title: 'Updated Title'
});

// Delete (soft delete)
await synap.entities.delete(entityId);

// Get
const entity = await synap.entities.get(entityId);

// List
const notes = await synap.entities.list({
  type: 'note',
  limit: 20
});

// Search
const results = await synap.entities.search({
  query: 'project planning',
  types: ['note', 'task']
});
```

### Relations API

```typescript
// Create relationship
await synap.relations.create(
  sourceEntityId,
  targetEntityId,
  'assigned_to'
);

// Get relations
const relations = await synap.relations.get(entityId, {
  type: 'assigned_to',
  direction: 'both' // 'source' | 'target' | 'both'
});

// Get related entities
const people = await synap.relations.getRelated(taskId, {
  type: 'assigned_to',
  direction: 'source'
});

// Get statistics
const stats = await synap.relations.getStats(entityId);
// Returns: { total, outgoing, incoming, byType }

// Delete relationship
await synap.relations.delete(relationId);
```

### Events API

```typescript
// Get entity history
const history = await synap.events.getHistory(entityId, {
  eventTypes: ['entities.create.validated'],
  limit: 100
});

// Get user timeline
const timeline = await synap.events.getTimeline({
  limit: 50
});

// Replay events to rebuild state
const state = await synap.events.replay(entityId);
```

## Entity Types

```typescript
type EntityType = 
  | 'task'
  | 'note'
  | 'person'
  | 'event'
  | 'file';
```

## Relation Types

```typescript
type RelationType =
  | 'assigned_to'    // Task → Person
  | 'mentions'       // Note → Entity
  | 'links_to'       // Note → Note
  | 'parent_of'      // Project → Task
  | 'relates_to'     // Generic
  | 'tagged_with'    // Entity → Tag
  | 'created_by'     // Entity → Person
  | 'attended_by'    // Event → Person
  | 'depends_on'     // Task → Task
  | 'blocks';        // Task → Task
```

## License

AGPL-3.0
