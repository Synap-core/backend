# Signal Feed Hub Protocol Endpoints

## Overview

Hub Protocol endpoints for signal feed operations. These endpoints enable the Intelligence Service and frontend to fetch, classify, capture, and manage signal items within a user's pod.

## Base Path

```
POST /api/hub/signals/{endpoint}
```

All endpoints require:

- `Authorization: Bearer {api_key}` header
- Valid API key with `signals` scope
- User context from API key validation

## Endpoint Reference

### 1. `POST /signals/fetch` - Fetch RSSHub Data

Fetches raw RSSHub data via CP proxy for processing within the pod.

**Request:**

```typescript
interface FetchSignalsRequest {
  // Source identification
  sourceRoute: string; // e.g., "/twitter/user/elonmusk"
  sourcePlatform: SignalPlatform; // "twitter", "reddit", etc.

  // Fetch options
  options?: {
    limit?: number; // Max items to fetch (default: 50)
    since?: string; // ISO timestamp (fetch items after this)
    forceRefresh?: boolean; // Skip cache (default: false)
    timeoutMs?: number; // Request timeout (default: 30000)
  };

  // Context for personalization
  context?: {
    workspaceId: string;
    userId: string;
    currentTopics?: string[]; // Topics user is currently interested in
  };
}
```

**Response:**

```typescript
interface FetchSignalsResponse {
  success: boolean;
  items: RssHubItem[];
  metadata: {
    sourceRoute: string;
    sourcePlatform: string;
    fetchedAt: string; // ISO timestamp
    cacheHit: boolean;
    itemCount: number;
    durationMs: number;

    // Rate limiting info
    rateLimit?: {
      limit: number;
      remaining: number;
      resetAt: string;
    };
  };
  error?: string;
}
```

**Example:**

```bash
curl -X POST "http://localhost:4000/api/hub/signals/fetch" \
  -H "Authorization: Bearer api_key_123" \
  -H "Content-Type: application/json" \
  -d '{
    "sourceRoute": "/twitter/user/elonmusk",
    "sourcePlatform": "twitter",
    "options": {
      "limit": 20,
      "since": "2024-01-01T00:00:00Z"
    },
    "context": {
      "workspaceId": "ws_123",
      "userId": "user_456",
      "currentTopics": ["ai", "space"]
    }
  }'
```

### 2. `POST /signals/classify` - AI Classification

Classifies fetched RSSHub items using pod's Intelligence Service and context.

**Request:**

```typescript
interface ClassifySignalsRequest {
  items: RssHubItem[]; // Items from /signals/fetch

  classification: {
    mode?: "quick" | "detailed" | "comprehensive"; // Default: quick
    extractTopics?: boolean; // Extract topics from content (default: true)
    computeRelevance?: boolean; // Compute relevance score (default: true)
    extractEntities?: boolean; // Extract people/companies (default: true)
    generateSummary?: boolean; // Generate AI summary (default: false)
  };

  context: {
    workspaceId: string;
    userId: string;

    // Optional context for better personalization
    userPreferences?: {
      subscriptions?: Array<{
        topic: string;
        confidence: number;
      }>;
      classifications?: Array<{
        topic: string;
        confidence: number;
        lastUpdated: string;
      }>;
    };

    currentFocus?: {
      activeTasks?: string[]; // Task IDs user is working on
      recentSearches?: string[]; // Recent search queries
      discussedPeople?: string[]; // People mentioned recently
    };
  };
}
```

**Response:**

```typescript
interface ClassifySignalsResponse {
  success: boolean;
  items: ClassifiedSignalItem[];
  metadata: {
    classificationMode: string;
    modelUsed: string; // e.g., "deepseek-chat"
    durationMs: number;
    tokensUsed?: number;

    // Classification summary
    summary?: {
      totalItems: number;
      topicsFound: string[];
      averageRelevance: number;
      entityExtractionStats: {
        people: number;
        companies: number;
        products: number;
      };
    };
  };
  error?: string;
}

interface ClassifiedSignalItem {
  // Original RSSHub data
  id: string; // Unique ID for this processing run
  originalItem: RssHubItem;

  // AI classification results
  topics: Array<{
    name: string; // e.g., "ai", "programming"
    confidence: number; // 0-1
    source: "explicit" | "inferred" | "contextual";
  }>;

  relevanceScore: number; // 0-1 relevance to user

  // Extracted entities
  entities?: Array<{
    type: "person" | "company" | "product" | "location";
    name: string;
    confidence: number;
    context?: string; // Where mentioned in text
  }>;

  // Generated content
  aiSummary?: string; // Generated summary if requested

  // Metadata
  classificationTimestamp: string;
  classificationModel: string;
}
```

**Example:**

```bash
curl -X POST "http://localhost:4000/api/hub/signals/classify" \
  -H "Authorization: Bearer api_key_123" \
  -H "Content-Type: application/json" \
  -d '{
    "items": [...],
    "classification": {
      "mode": "detailed",
      "extractTopics": true,
      "computeRelevance": true,
      "extractEntities": true,
      "generateSummary": true
    },
    "context": {
      "workspaceId": "ws_123",
      "userId": "user_456",
      "userPreferences": {
        "subscriptions": [
          {"topic": "ai", "confidence": 0.9},
          {"topic": "space", "confidence": 0.7}
        ]
      },
      "currentFocus": {
        "activeTasks": ["task_789"],
        "recentSearches": ["rocket launch", "starship"]
      }
    }
  }'
```

### 3. `POST /signals/capture` - Capture Signal Item

Creates a `signal_item` entity in the pod from a classified signal item.

**Request:**

```typescript
interface CaptureSignalRequest {
  signalData: {
    // Core signal data
    sourcePlatform: SignalPlatform;
    sourceRoute: string;
    url: string;
    title: string;
    description?: string;
    publishedAt: string; // ISO timestamp

    // Author information
    authorUsername?: string;
    authorDisplayName?: string;
    authorUrl?: string;

    // AI classification results (from /signals/classify)
    aiSummary?: string;
    topics: string[]; // Simplified topics array
    relevanceScore?: number;

    // Raw data for debugging
    rawData?: any; // Original RSSHub item
  };

  capture: {
    workspaceId: string;
    userId: string;

    // Capture metadata
    captureMethod?: "manual" | "automation" | "ai_suggestion";
    captureReason?: string; // Why user captured this

    // Auto-linking options
    autoLinkEntities?: boolean; // Default: true
    linkStrengthThreshold?: number; // Default: 0.3

    // Notification preferences
    createNotification?: boolean; // Default: true
    notificationType?: "toast" | "feed" | "both"; // Default: "toast"
  };
}
```

**Response:**

```typescript
interface CaptureSignalResponse {
  success: boolean;
  entity: {
    id: string;
    profileSlug: "signal_item";
    name: string;
    properties: Record<string, any>;
    createdAt: string;
    updatedAt: string;
  };

  autoLinking?: {
    linkedEntities: Array<{
      entityId: string;
      entityType: string;
      entityName: string;
      linkType: string;
      linkStrength: number;
    }>;
    totalLinked: number;
  };

  automationResults?: {
    triggered: string[]; // Automation IDs that were triggered
    results: Array<{
      automationId: string;
      automationName: string;
      success: boolean;
      output?: any;
    }>;
  };

  metadata: {
    captureTimestamp: string;
    captureMethod: string;
    processingDurationMs: number;
  };

  error?: string;
}
```

**Example:**

```bash
curl -X POST "http://localhost:4000/api/hub/signals/capture" \
  -H "Authorization: Bearer api_key_123" \
  -H "Content-Type: application/json" \
  -d '{
    "signalData": {
      "sourcePlatform": "twitter",
      "sourceRoute": "/twitter/user/elonmusk",
      "url": "https://twitter.com/elonmusk/status/123456",
      "title": "Starship launch successful!",
      "description": "Full successful test of Starship orbital launch system.",
      "publishedAt": "2024-01-15T14:30:00Z",
      "authorUsername": "elonmusk",
      "authorDisplayName": "Elon Musk",
      "aiSummary": "Elon Musk announces successful Starship orbital launch test.",
      "topics": ["space", "technology", "engineering"],
      "relevanceScore": 0.85,
      "rawData": {...}
    },
    "capture": {
      "workspaceId": "ws_123",
      "userId": "user_456",
      "captureMethod": "manual",
      "captureReason": "Relevant to space project",
      "autoLinkEntities": true,
      "createNotification": true
    }
  }'
```

### 4. `GET /signals/feed` - Get Personalized Feed

Returns a personalized feed of signal items based on user context and preferences.

**Query Parameters:**

```typescript
interface GetFeedQuery {
  // Pagination
  limit?: number; // Default: 20, Max: 100
  offset?: number; // Default: 0

  // Filtering
  topics?: string[]; // Comma-separated topics
  platforms?: SignalPlatform[]; // Comma-separated platforms
  since?: string; // ISO timestamp (only items after)
  until?: string; // ISO timestamp (only items before)

  // Personalization
  useMemory?: boolean; // Use AI memory (default: true)
  useSubscriptions?: boolean; // Use user subscriptions (default: true)
  useContext?: boolean; // Use current work context (default: true)

  // Display options
  includeRaw?: boolean; // Include raw RSSHub data (default: false)
  includeClassification?: boolean; // Include classification metadata (default: true)

  // Advanced
  minRelevance?: number; // Minimum relevance score (0-1, default: 0.1)
  diversification?: number; // 0-1, higher = more diverse topics (default: 0.3)
  freshnessBoost?: number; // 0-1, higher = newer items boosted (default: 0.5)
}
```

**Response:**

```typescript
interface GetFeedResponse {
  success: boolean;
  items: FeedItem[];
  pagination: {
    total: number; // Total items available
    limit: number;
    offset: number;
    hasMore: boolean;
    nextOffset?: number;
  };

  context: {
    workspaceId: string;
    userId: string;

    // Personalization context used
    personalization: {
      usedMemory: boolean;
      usedSubscriptions: boolean;
      usedContext: boolean;
      topicsConsidered: string[];
      platformsConsidered: SignalPlatform[];
    };

    // User preferences snapshot
    preferences?: {
      subscriptions: Array<{
        topic: string;
        confidence: number;
      }>;
      classifications: Array<{
        topic: string;
        confidence: number;
        lastUpdated: string;
      }>;
    };
  };

  metadata: {
    fetchDurationMs: number;
    classificationDurationMs?: number;
    sourcesFetched: number;
    cacheHitRate: number;

    // Feed statistics
    statistics?: {
      averageRelevance: number;
      topicDistribution: Record<string, number>;
      platformDistribution: Record<string, number>;
      freshnessDistribution: Record<string, number>; // e.g., {"<1h": 5, "<24h": 15}
    };
  };

  error?: string;
}

interface FeedItem {
  // Core signal data
  id: string; // Unique feed item ID
  sourcePlatform: SignalPlatform;
  sourceRoute: string;
  url: string;
  title: string;
  description?: string;
  publishedAt: string;

  // Author
  authorUsername?: string;
  authorDisplayName?: string;
  authorUrl?: string;

  // AI metadata
  aiSummary?: string;
  topics: string[];
  relevanceScore: number;
  sentiment?: "positive" | "neutral" | "negative" | "mixed";

  // Display metadata
  display: {
    // For cards
    cardTitle?: string; // May differ from original title
    cardImage?: string; // Featured image
    cardColor?: string; // Thematic color
    cardEmoji?: string; // Relevant emoji

    // Actions
    actions: Array<{
      label: string;
      icon: string;
      action: "open" | "capture" | "share" | "summarize" | "dismiss";
      payload?: any;
    }>;
  };

  // Classification metadata (if includeClassification=true)
  classification?: {
    model: string;
    timestamp: string;
    extractedEntities?: Array<{
      type: string;
      name: string;
      confidence: number;
    }>;
  };

  // Raw data (if includeRaw=true)
  rawData?: any;
}
```

**Example:**

```bash
curl "http://localhost:4000/api/hub/signals/feed?\
  limit=20&\
  offset=0&\
  topics=ai,space&\
  platforms=twitter,hackernews&\
  useMemory=true&\
  minRelevance=0.3&\
  diversification=0.4" \
  -H "Authorization: Bearer api_key_123"
```

### 5. `GET /signals/context` - Get Personalization Context

Returns the current personalization context for a user/workspace.

**Query Parameters:**

```typescript
interface GetContextQuery {
  // What to include
  includeSubscriptions?: boolean; // Default: true
  includeClassifications?: boolean; // Default: true
  includeMemory?: boolean; // Default: true
  includeCurrentFocus?: boolean; // Default: true
  includeHistory?: boolean; // Default: false

  // Time window for history
  historyWindow?: string; // e.g., "7d", "30d", "90d"
}
```

**Response:**

```typescript
interface GetContextResponse {
  success: boolean;
  context: {
    workspaceId: string;
    userId: string;

    // Explicit preferences
    subscriptions?: Array<{
      id: string;
      topic: string;
      sourcePlatform?: string;
      sourceRoute?: string;
      isActive: boolean;
      confidence: number;
      createdAt: string;
      updatedAt: string;
    }>;

    // Implicit classifications
    classifications?: Array<{
      id: string;
      topic: string;
      confidence: number;
      sourceType: string;
      occurrenceCount: number;
      firstSeenAt: string;
      lastSeenAt: string;
      decayedConfidence: number; // Confidence after time decay
    }>;

    // AI memory
    memory?: {
      recentTopics: Array<{
        topic: string;
        frequency: number;
        lastMentioned: string;
      }>;
      entityAffinities: Array<{
        entityId: string;
        entityType: string;
        entityName: string;
        affinity: number; // 0-1
        interactionCount: number;
      }>;
      temporalPatterns?: {
        activeHours: number[]; // Hours of day user is most active (0-23)
        peakDays: string[]; // Days of week user is most active
      };
    };

    // Current focus
    currentFocus?: {
      activeTasks: Array<{
        id: string;
        name: string;
        status: string;
        dueDate?: string;
      }>;
      recentSearches: string[];
      discussedPeople: Array<{
        entityId: string;
        name: string;
        mentionCount: number;
        lastMentioned: string;
      }>;
      viewedEntities: Array<{
        entityId: string;
        entityType: string;
        name: string;
        viewCount: number;
        lastViewed: string;
      }>;
    };

    // History (if requested)
    history?: {
      captures: Array<{
        date: string;
        count: number;
        topics: string[];
      }>;
      views: Array<{
        date: string;
        count: number;
        averageDwellTime: number;
      }>;
      searches: Array<{
        date: string;
        queries: string[];
      }>;
    };
  };

  metadata: {
    generatedAt: string;
    processingDurationMs: number;
    dataFreshness: {
      subscriptions: string; // e.g., "5 minutes ago"
      classifications: string;
      memory: string;
      currentFocus: string;
    };
  };

  error?: string;
}
```

**Example:**

```bash
curl "http://localhost:4000/api/hub/signals/context?\
  includeSubscriptions=true&\
  includeClassifications=true&\
  includeMemory=true&\
  includeCurrentFocus=true&\
  historyWindow=7d" \
  -H "Authorization: Bearer api_key_123"
```

### 6. `POST /signals/subscriptions` - Manage Subscriptions

Create, update, or delete signal subscriptions.

**Request:**

```typescript
interface ManageSubscriptionsRequest {
  workspaceId: string;
  userId: string;

  operations: Array<{
    operation: "create" | "update" | "delete" | "toggle";

    // For create/update
    subscription?: {
      topic: string;
      sourcePlatform?: string;
      sourceRoute?: string;
      confidence?: number; // 0-1 user importance
      notificationPreference?: "none" | "digest" | "immediate";
    };

    // For update/delete/toggle
    subscriptionId?: string;

    // For toggle
    isActive?: boolean;
  }>;
}
```

**Response:**

```typescript
interface ManageSubscriptionsResponse {
  success: boolean;
  results: Array<{
    operation: string;
    subscriptionId?: string;
    success: boolean;
    error?: string;

    // For successful operations
    subscription?: {
      id: string;
      topic: string;
      sourcePlatform?: string;
      sourceRoute?: string;
      isActive: boolean;
      confidence: number;
      notificationPreference: string;
      createdAt: string;
      updatedAt: string;
    };
  }>;

  metadata: {
    processedAt: string;
    totalOperations: number;
    successfulOperations: number;
  };

  error?: string;
}
```

**Example:**

```bash
curl -X POST "http://localhost:4000/api/hub/signals/subscriptions" \
  -H "Authorization: Bearer api_key_123" \
  -H "Content-Type: application/json" \
  -d '{
    "workspaceId": "ws_123",
    "userId": "user_456",
    "operations": [
      {
        "operation": "create",
        "subscription": {
          "topic": "ai",
          "sourcePlatform": "twitter",
          "confidence": 0.9,
          "notificationPreference": "digest"
        }
      },
      {
        "operation": "delete",
        "subscriptionId": "sub_789"
      }
    ]
  }'
```

### 7. `POST /signals/batch` - Batch Operations

Perform multiple signal operations in a single request.

**Request:**

```typescript
interface BatchOperationsRequest {
  workspaceId: string;
  userId: string;

  operations: Array<{
    type: "fetch" | "classify" | "capture";
    id: string; // Client-generated ID for correlation

    // Operation-specific data
    data: any;

    // Dependencies (IDs of other operations that must complete first)
    dependsOn?: string[];
  }>;

  // Batch options
  options?: {
    maxConcurrency?: number; // Default: 3
    stopOnError?: boolean; // Default: false
    timeoutMs?: number; // Default: 60000
  };
}
```

**Response:**

```typescript
interface BatchOperationsResponse {
  success: boolean;
  operations: Array<{
    id: string;
    type: string;
    success: boolean;
    durationMs: number;

    // Operation result (type-specific)
    result?: any;

    error?: {
      code: string;
      message: string;
      details?: any;
    };
  }>;

  metadata: {
    totalOperations: number;
    successfulOperations: number;
    failedOperations: number;
    totalDurationMs: number;
    averageDurationMs: number;
  };

  error?: string;
}
```

**Example:**

```bash
curl -X POST "http://localhost:4000/api/hub/signals/batch" \
  -H "Authorization: Bearer api_key_123" \
  -H "Content-Type: application/json" \
  -d '{
    "workspaceId": "ws_123",
    "userId": "user_456",
    "operations": [
      {
        "type": "fetch",
        "id": "fetch_1",
        "data": {
          "sourceRoute": "/twitter/user/elonmusk",
          "sourcePlatform": "twitter",
          "options": {"limit": 10}
        }
      },
      {
        "type": "classify",
        "id": "classify_1",
        "data": {
          "items": {"$ref": "fetch_1.result.items"},
          "classification": {"mode": "quick"}
        },
        "dependsOn": ["fetch_1"]
      }
    ]
  }'
```

## Error Handling

### Error Response Format

```typescript
interface ErrorResponse {
  success: false;
  error: string;
  errorCode: string;
  details?: any;

  // Rate limiting
  rateLimit?: {
    limit: number;
    remaining: number;
    resetAt: string;
    retryAfter: number; // Seconds
  };

  // Validation errors
  validationErrors?: Array<{
    field: string;
    message: string;
    code: string;
  }>;
}
```

### Common Error Codes

```typescript
const SIGNAL_ERRORS = {
  // Authentication & Authorization
  INVALID_API_KEY: "invalid_api_key",
  MISSING_SCOPE: "missing_scope_signals",
  USER_NOT_FOUND: "user_not_found",
  WORKSPACE_ACCESS_DENIED: "workspace_access_denied",

  // Rate limiting
  RATE_LIMIT_EXCEEDED: "rate_limit_exceeded",
  RSSHUB_RATE_LIMIT: "rsshub_rate_limit",

  // Validation
  INVALID_SOURCE_ROUTE: "invalid_source_route",
  INVALID_PLATFORM: "invalid_platform",
  MISSING_REQUIRED_FIELD: "missing_required_field",
  INVALID_TIMESTAMP: "invalid_timestamp",

  // RSSHub errors
  RSSHUB_UNAVAILABLE: "rsshub_unavailable",
  RSSHUB_TIMEOUT: "rsshub_timeout",
  RSSHUB_PARSE_ERROR: "rsshub_parse_error",

  // AI classification
  AI_CLASSIFICATION_FAILED: "ai_classification_failed",
  AI_MODEL_UNAVAILABLE: "ai_model_unavailable",
  AI_TOKEN_LIMIT_EXCEEDED: "ai_token_limit_exceeded",

  // Database errors
  ENTITY_CREATION_FAILED: "entity_creation_failed",
  SUBSCRIPTION_CONFLICT: "subscription_conflict",

  // Resource limits
  ITEM_LIMIT_EXCEEDED: "item_limit_exceeded",
  BATCH_SIZE_EXCEEDED: "batch_size_exceeded",
  MEMORY_LIMIT_EXCEEDED: "memory_limit_exceeded",
};
```

## Rate Limiting

### Default Limits

```typescript
const SIGNAL_RATE_LIMITS = {
  // Per-user limits (sliding window)
  fetch: {
    window: 3600, // 1 hour
    limit: 100, // 100 requests/hour
  },

  classify: {
    window: 3600,
    limit: 50, // 50 classifications/hour
  },

  capture: {
    window: 3600,
    limit: 200, // 200 captures/hour
  },

  feed: {
    window: 300, // 5 minutes
    limit: 20, // 20 feed requests/5min
  },

  // RSSHub proxy limits (stricter)
  rsshub_proxy: {
    window: 3600,
    limit: 50, // 50 RSSHub requests/hour/user
  },
};
```

### Response Headers

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1705093200
X-RateLimit-Policy: user-hourly
Retry-After: 300
```

## Implementation Details

### Endpoint Handler Structure

```typescript
// Example: /signals/fetch endpoint
export async function handleFetchSignals(
  c: Context,
  request: FetchSignalsRequest
): Promise<FetchSignalsResponse> {
  const { userId, apiKey } = c.get("auth");
  const workspaceId = request.context?.workspaceId || c.get("defaultWorkspaceId");

  // 1. Validate request
  validateFetchRequest(request);

  // 2. Check rate limits
  await checkRateLimit(userId, "fetch");
  await checkRsshubRateLimit(userId, request.sourcePlatform);

  // 3. Fetch from RSSHub via CP proxy
  const rsshubResponse = await fetchFromRsshub(
    request.sourceRoute,
    request.options,
    apiKey
  );

  // 4. Parse and transform
  const items = parseRsshubResponse(rsshubResponse, request.sourcePlatform);

  // 5. Update fetch history
  await recordFetchHistory({
    userId,
    workspaceId,
    sourceRoute: request.sourceRoute,
    sourcePlatform: request.sourcePlatform,
    itemCount: items.length,
    durationMs: /* calculate */,
  });

  // 6. Return response
  return {
    success: true,
    items,
    metadata: {
      sourceRoute: request.sourceRoute,
      sourcePlatform: request.sourcePlatform,
      fetchedAt: new Date().toISOString(),
      cacheHit: rsshubResponse.cacheHit,
      itemCount: items.length,
      durationMs: /* calculate */,
      rateLimit: {
        limit: /* from headers */,
        remaining: /* from headers */,
        resetAt: /* from headers */,
      },
    },
  };
}
```

### Context Injection

```typescript
// Middleware for signal endpoints
app.use("/signals/*", async (c, next) => {
  // Extract auth
  const apiKey = extractApiKey(c);
  const { userId, scopes } = await validateApiKey(apiKey);

  // Check scope
  if (!scopes.includes("signals")) {
    return c.json(
      {
        success: false,
        error: "Missing signals scope",
        errorCode: "missing_scope_signals",
      },
      403
    );
  }

  // Inject context
  c.set("userId", userId);
  c.set("apiKey", apiKey);
  c.set("scopes", scopes);

  // Get default workspace if not specified
  const defaultWorkspace = await getDefaultWorkspace(userId);
  c.set("defaultWorkspaceId", defaultWorkspace?.id);

  await next();
});
```

### Request Validation

```typescript
function validateFetchRequest(request: FetchSignalsRequest) {
  // Required fields
  if (!request.sourceRoute) {
    throw new ValidationError(
      "sourceRoute is required",
      "missing_required_field"
    );
  }

  if (!request.sourcePlatform) {
    throw new ValidationError(
      "sourcePlatform is required",
      "missing_required_field"
    );
  }

  // Validate platform
  const validPlatforms = ["twitter", "reddit" /* ... */];
  if (!validPlatforms.includes(request.sourcePlatform)) {
    throw new ValidationError(
      `Invalid platform: ${request.sourcePlatform}`,
      "invalid_platform"
    );
  }

  // Validate source route format
  if (!isValidRsshubRoute(request.sourceRoute, request.sourcePlatform)) {
    throw new ValidationError(
      `Invalid route for platform ${request.sourcePlatform}`,
      "invalid_source_route"
    );
  }

  // Validate options
  if (request.options) {
    if (
      request.options.limit &&
      (request.options.limit < 1 || request.options.limit > 100)
    ) {
      throw new ValidationError(
        "Limit must be between 1 and 100",
        "validation_error"
      );
    }

    if (request.options.since && !isValidISODate(request.options.since)) {
      throw new ValidationError("Invalid since timestamp", "invalid_timestamp");
    }
  }
}
```

## Testing Endpoints

### Test Suite Structure

```typescript
describe("Signal Hub Protocol Endpoints", () => {
  let apiKey: string;
  let userId: string;
  let workspaceId: string;

  beforeAll(async () => {
    // Setup test user and API key
    ({ apiKey, userId, workspaceId } = await setupTestUser());
  });

  test("fetch endpoint returns RSSHub data", async () => {
    const response = await fetchSignals({
      sourceRoute: "/hackernews/newest",
      sourcePlatform: "hackernews",
      options: { limit: 5 },
      context: { workspaceId, userId },
    }, apiKey);

    expect(response.success).toBe(true);
    expect(response.items).toHaveLength(5);
    expect(response.metadata.sourcePlatform).toBe("hackernews");
  });

  test("classify endpoint adds AI metadata", async () => {
    const items = [...]; // Mock RSSHub items

    const response = await classifySignals({
      items,
      classification: { mode: "quick" },
      context: { workspaceId, userId },
    }, apiKey);

    expect(response.success).toBe(true);
    expect(response.items[0].topics).toBeDefined();
    expect(response.items[0].relevanceScore).toBeGreaterThan(0);
  });

  test("capture endpoint creates entity", async () => {
    const signalData = {...}; // Mock signal data

    const response = await captureSignal({
      signalData,
      capture: { workspaceId, userId },
    }, apiKey);

    expect(response.success).toBe(true);
    expect(response.entity.profileSlug).toBe("signal_item");
    expect(response.entity.properties.sourcePlatform).toBe(signalData.sourcePlatform);
  });

  test("feed endpoint returns personalized items", async () => {
    const response = await getFeed({
      limit: 10,
      useMemory: true,
      minRelevance: 0.3,
    }, apiKey);

    expect(response.success).toBe(true);
    expect(response.items).toHaveLength(10);
    expect(response.pagination.hasMore).toBeDefined();
    expect(response.context.personalization.usedMemory).toBe(true);
  });

  test("rate limiting is enforced", async () => {
    // Make 101 requests quickly
    const promises = Array.from({ length: 101 }, () =>
      fetchSignals({
        sourceRoute: "/hackernews/newest",
        sourcePlatform: "hackernews",
        options: { limit: 1 },
        context: { workspaceId, userId },
      }, apiKey)
    );

    const responses = await Promise.allSettled(promises);

    // At least one should be rate limited
    const rateLimited = responses.filter(r =>
      r.status === "fulfilled" &&
      r.value.success === false &&
      r.value.errorCode === "rate_limit_exceeded"
    );

    expect(rateLimited.length).toBeGreaterThan(0);
  });
});
```

### Integration Test Setup

```typescript
// test/integration/signals.test.ts
import { setupTestEnvironment } from "../setup";
import { startTestServer, stopTestServer } from "../server";
import { createTestUser, createTestApiKey } from "../auth";

describe("Signal Feed Integration", () => {
  let serverUrl: string;
  let apiKey: string;

  beforeAll(async () => {
    serverUrl = await startTestServer();
    await setupTestEnvironment();

    const user = await createTestUser();
    apiKey = await createTestApiKey(user.id, ["signals"]);
  });

  afterAll(async () => {
    await stopTestServer();
  });

  test("full signal flow", async () => {
    // 1. Fetch
    const fetchRes = await fetch(`${serverUrl}/api/hub/signals/fetch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sourceRoute: "/hackernews/newest",
        sourcePlatform: "hackernews",
        options: { limit: 3 },
      }),
    });

    const fetchData = await fetchRes.json();
    expect(fetchRes.status).toBe(200);
    expect(fetchData.items).toHaveLength(3);

    // 2. Classify
    const classifyRes = await fetch(`${serverUrl}/api/hub/signals/classify`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        items: fetchData.items,
        classification: { mode: "quick" },
        context: { userId: "test", workspaceId: "test" },
      }),
    });

    const classifyData = await classifyRes.json();
    expect(classifyRes.status).toBe(200);
    expect(classifyData.items[0].topics).toBeDefined();

    // 3. Capture one item
    const item = classifyData.items[0];
    const captureRes = await fetch(`${serverUrl}/api/hub/signals/capture`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        signalData: {
          sourcePlatform: item.originalItem.sourcePlatform,
          sourceRoute: item.originalItem.sourceRoute,
          url: item.originalItem.link,
          title: item.originalItem.title,
          description: item.originalItem.description,
          publishedAt: item.originalItem.pubDate,
          topics: item.topics.map((t: any) => t.name),
          relevanceScore: item.relevanceScore,
        },
        capture: {
          workspaceId: "test",
          userId: "test",
          captureMethod: "manual",
        },
      }),
    });

    const captureData = await captureRes.json();
    expect(captureRes.status).toBe(200);
    expect(captureData.entity.profileSlug).toBe("signal_item");

    // 4. Get feed (should include captured item)
    const feedRes = await fetch(`${serverUrl}/api/hub/signals/feed?limit=10`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const feedData = await feedRes.json();
    expect(feedRes.status).toBe(200);
    expect(feedData.items.length).toBeGreaterThan(0);
  });
});
```

## Monitoring & Metrics

### Key Metrics to Track

```typescript
interface SignalMetrics {
  // Endpoint usage
  endpointCalls: Record<string, number>;
  endpointErrors: Record<string, number>;
  endpointLatency: Record<string, number>; // P95

  // RSSHub integration
  rsshubRequests: number;
  rsshubCacheHitRate: number;
  rsshubErrorRate: number;

  // AI classification
  classificationRequests: number;
  classificationTokens: number;
  classificationLatency: number;

  // User engagement
  feedViews: number;
  captures: number;
  averageRelevanceScore: number;

  // Resource usage
  entityCreations: number;
  databaseQueries: number;
  memoryUsage: number;
}
```

### Health Check Endpoint

```typescript
app.get("/signals/health", async (c) => {
  const checks = {
    database: await checkDatabaseConnection(),
    rsshub: await checkRsshubConnection(),
    ai: await checkAIService(),
    redis: await checkRedisConnection(),
    rateLimiter: await checkRateLimiter(),
  };

  const allHealthy = Object.values(checks).every((check) => check.healthy);

  return c.json(
    {
      status: allHealthy ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      checks,
    },
    allHealthy ? 200 : 503
  );
});
```

---

_Last updated: 2026-04-12_
_Owner: Backend Team_
_Status: Ready for Implementation_
