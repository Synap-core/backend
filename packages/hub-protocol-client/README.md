# @synap/hub-protocol-client

Type-safe tRPC client for Hub ↔ Data Pod communication via the Hub Protocol V1.0.

## Installation

```bash
pnpm add @synap/hub-protocol-client
```

## Usage

### Basic Example

```typescript
import { HubProtocolClient } from '@synap/hub-protocol-client';

const client = new HubProtocolClient({
  dataPodUrl: 'http://localhost:3000',
  token: 'user-session-token',
});

// Generate access token
const { token, expiresAt } = await client.generateAccessToken(
  'request-id-123',
  ['preferences', 'notes', 'tasks'],
  300 // 5 minutes
);

// Request data
const data = await client.requestData(token, ['preferences', 'notes'], {
  limit: 100,
});

// Submit insight
await client.submitInsight(token, {
  version: '1.0',
  type: 'action_plan',
  correlationId: 'request-id-123',
  actions: [
    {
      eventType: 'task.creation.requested',
      data: { title: 'My Task' },
      requiresConfirmation: true,
      priority: 70,
    },
  ],
  confidence: 0.85,
  reasoning: 'Based on user query',
});
```

### With Dynamic Token

```typescript
const client = new HubProtocolClient({
  dataPodUrl: 'http://localhost:3000',
  getToken: async () => {
    // Fetch token from your auth system
    return await fetchUserToken();
  },
});
```

### Update Data Pod URL

```typescript
// Useful when handling multiple users
client.updateDataPodUrl('http://user-datapod.com');
```

## API Reference

### `HubProtocolClient`

#### Constructor

```typescript
new HubProtocolClient(config: HubProtocolClientConfig)
```

**Config:**
- `dataPodUrl`: Data Pod API URL
- `token`: Static authentication token (optional)
- `getToken`: Function to get token dynamically (optional)
- `headers`: Additional headers (optional)
- `retry`: Retry configuration (optional)

#### Methods

##### `generateAccessToken(requestId, scope, expiresIn?, userId?)`

Generates a temporary JWT token for accessing user data.

**Parameters:**
- `requestId`: UUID of the Hub request
- `scope`: Array of data scopes to access
- `expiresIn`: Token expiration in seconds (60-300, default: 300)
- `userId`: Optional user ID

**Returns:** `{ token, expiresAt, requestId }`

##### `requestData(token, scope, filters?)`

Retrieves read-only data from the Data Pod.

**Parameters:**
- `token`: JWT token from `generateAccessToken`
- `scope`: Array of data scopes to retrieve
- `filters`: Optional filters (date range, entity types, pagination)

**Returns:** User data with metadata

##### `submitInsight(token, insight)`

Submits a structured insight to the Data Pod.

**Parameters:**
- `token`: JWT token from `generateAccessToken`
- `insight`: Structured `HubInsight` (validated with `HubInsightSchema`)

**Returns:** Success status and event IDs

##### `updateDataPodUrl(dataPodUrl)`

Updates the Data Pod URL dynamically.

## Types

### `HubScope`

```typescript
type HubScope = 
  | 'preferences'
  | 'calendar'
  | 'notes'
  | 'tasks'
  | 'projects'
  | 'conversations'
  | 'entities'
  | 'relations'
  | 'knowledge_facts';
```

### `RequestDataFilters`

```typescript
interface RequestDataFilters {
  dateRange?: {
    start: string; // ISO datetime
    end: string; // ISO datetime
  };
  entityTypes?: string[];
  limit?: number;
  offset?: number;
}
```

## Dependencies

- `@synap/hub-protocol` - Hub Protocol schemas and types
- `@synap/api` - Data Pod API types (AppRouter)
- `@trpc/client` - tRPC client
- `@synap/core` - Logging utilities

## License

MIT

