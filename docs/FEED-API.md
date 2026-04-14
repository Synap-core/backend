# Feed Service API

RESTful API for managing RSS/Atom feeds and proactive AI digests.

## Overview

The Feed Service API provides endpoints for:

- Managing RSS feed subscriptions
- Triggering feed fetches
- Retrieving feed items
- Tracking user engagement
- Configuring feed preferences

## Base URL

```
https://api.synap.io/api/feeds
```

## Authentication

All endpoints require authentication via Bearer token:

```
Authorization: Bearer <access_token>
```

## Endpoints

### List User Feeds

Returns all feeds for the authenticated user.

```http
GET /api/feeds
```

**Query Parameters:**

| Parameter     | Type    | Description                                        |
| ------------- | ------- | -------------------------------------------------- |
| `workspaceId` | string  | Filter by workspace (optional)                     |
| `type`        | string  | Filter by feed type: `rss`, `proactive` (optional) |
| `active`      | boolean | Filter by active status (optional)                 |

**Response:**

```json
{
  "feeds": [
    {
      "id": "feed-123",
      "name": "Tech News",
      "type": "rss",
      "isActive": true,
      "schedule": "0 */6 * * *",
      "lastFetchedAt": "2024-01-15T10:00:00Z",
      "lastFetchStatus": "success",
      "sources": [
        {
          "url": "https://example.com/feed.xml",
          "name": "Tech Blog"
        }
      ],
      "provider": {
        "type": "direct"
      },
      "createdAt": "2024-01-01T00:00:00Z",
      "updatedAt": "2024-01-15T10:00:00Z"
    }
  ],
  "total": 1
}
```

### Create New Feed

Creates a new RSS or proactive feed.

```http
POST /api/feeds
```

**Request Body:**

```json
{
  "name": "My Tech Feed",
  "type": "rss",
  "workspaceId": "ws-456",
  "schedule": "0 */6 * * *",
  "timezone": "UTC",
  "sources": [
    {
      "url": "https://example.com/feed.xml",
      "name": "Example Blog"
    }
  ],
  "provider": {
    "type": "direct"
  },
  "maxItemsPerRun": 10,
  "minRelevanceScore": 50,
  "postMode": "individual"
}
```

**Response:**

```json
{
  "id": "feed-123",
  "name": "My Tech Feed",
  "type": "rss",
  "isActive": true,
  "schedule": "0 */6 * * *",
  "sources": [...],
  "createdAt": "2024-01-15T12:00:00Z"
}
```

### Get Feed Details

Returns detailed information about a specific feed.

```http
GET /api/feeds/:id
```

**Response:**

```json
{
  "id": "feed-123",
  "name": "Tech News",
  "type": "rss",
  "isActive": true,
  "schedule": "0 */6 * * *",
  "timezone": "UTC",
  "sources": [...],
  "provider": {
    "type": "direct"
  },
  "extraction": {
    "fetchFullContent": false,
    "maxContentLength": 5000,
    "includeMedia": false
  },
  "status": {
    "lastRunAt": "2024-01-15T10:00:00Z",
    "nextRunAt": "2024-01-15T16:00:00Z",
    "lastRunStatus": "success",
    "totalItemsPosted": 150
  },
  "createdAt": "2024-01-01T00:00:00Z",
  "updatedAt": "2024-01-15T10:00:00Z"
}
```

### Update Feed

Updates feed configuration.

```http
PUT /api/feeds/:id
```

**Request Body:**

```json
{
  "name": "Updated Feed Name",
  "schedule": "0 */12 * * *",
  "isActive": true,
  "sources": [
    {
      "url": "https://new-source.com/feed.xml",
      "name": "New Source"
    }
  ]
}
```

**Response:**

```json
{
  "id": "feed-123",
  "name": "Updated Feed Name",
  "schedule": "0 */12 * * *",
  "updatedAt": "2024-01-15T14:00:00Z"
}
```

### Delete Feed

Deletes a feed and all associated data.

```http
DELETE /api/feeds/:id
```

**Response:**

```json
{
  "success": true,
  "deletedAt": "2024-01-15T14:00:00Z"
}
```

### Trigger Feed Fetch

Manually triggers a feed fetch, bypassing the schedule.

```http
POST /api/feeds/:id/trigger
```

**Request Body (optional):**

```json
{
  "force": false,
  "maxItems": 20
}
```

**Response:**

```json
{
  "success": true,
  "runId": "run-abc-123",
  "message": "Feed fetch queued",
  "estimatedCompletion": "2024-01-15T14:05:00Z"
}
```

### Get Feed Items

Returns items fetched from the feed.

```http
GET /api/feeds/:id/items
```

**Query Parameters:**

| Parameter  | Type    | Description                                 |
| ---------- | ------- | ------------------------------------------- |
| `limit`    | number  | Max items to return (default: 20, max: 100) |
| `cursor`   | string  | Pagination cursor                           |
| `since`    | string  | ISO timestamp - items after this date       |
| `minScore` | number  | Minimum relevance score (0-100)             |
| `unread`   | boolean | Only unread items                           |

**Response:**

```json
{
  "items": [
    {
      "id": "item-456",
      "feedId": "feed-123",
      "title": "AI Breakthrough Announced",
      "content": "Researchers have developed...",
      "url": "https://example.com/article",
      "author": "Jane Doe",
      "publishedAt": "2024-01-15T09:00:00Z",
      "fetchedAt": "2024-01-15T10:00:00Z",
      "metadata": {
        "feedItem": true,
        "feedType": "rss",
        "topics": ["ai", "technology"],
        "relevanceScore": 0.92,
        "aiClassified": true,
        "source": {
          "platform": "example",
          "url": "https://example.com/article"
        }
      },
      "interaction": {
        "isCaptured": false,
        "isDismissed": false
      }
    }
  ],
  "pagination": {
    "nextCursor": "eyJpZCI6Iml0ZW0tNDU2In0=",
    "hasMore": true
  }
}
```

### Track Engagement

Records user interaction with a feed item.

```http
POST /api/feeds/engagement
```

**Request Body:**

```json
{
  "itemId": "item-456",
  "action": "click",
  "dwellTimeMs": 45000,
  "context": {
    "source": "feed-list",
    "position": 3
  }
}
```

**Actions:**

- `view` - Item was viewed
- `click` - Item was clicked
- `save` - Item was saved/captured
- `dismiss` - Item was dismissed
- `share` - Item was shared

**Response:**

```json
{
  "success": true,
  "engagementId": "eng-789",
  "recordedAt": "2024-01-15T14:00:00Z"
}
```

### Get Feed Statistics

Returns analytics for a feed.

```http
GET /api/feeds/:id/stats
```

**Response:**

```json
{
  "totalItemsFetched": 1000,
  "totalItemsPosted": 850,
  "averageFetchDurationMs": 2500,
  "successRate": 0.95,
  "last24h": {
    "itemsFetched": 24,
    "itemsPosted": 20,
    "errorCount": 0
  },
  "engagement": {
    "totalViews": 5000,
    "totalClicks": 800,
    "totalSaves": 150,
    "averageDwellTimeMs": 32000
  }
}
```

### Update Feed Preferences

Updates user preferences for feed personalization.

```http
PUT /api/feeds/preferences
```

**Request Body:**

```json
{
  "interests": ["ai", "startups", "programming"],
  "persona": "cto",
  "frequency": "hourly",
  "relevanceThreshold": 60,
  "notifications": true,
  "autoCreateEntities": false
}
```

**Personas:**

- `cto` - Chief Technology Officer
- `founder` - Startup founder
- `marketing` - Marketing professional
- `sales` - Sales professional
- `product-manager` - Product manager
- `researcher` - Researcher/analyst
- `general` - General interest

**Frequencies:**

- `realtime` - As items arrive
- `hourly` - Every hour
- `daily` - Once per day
- `weekly` - Once per week

**Response:**

```json
{
  "success": true,
  "preferences": {
    "interests": ["ai", "startups", "programming"],
    "persona": "cto",
    "frequency": "hourly",
    "updatedAt": "2024-01-15T14:00:00Z"
  }
}
```

## Provider Types

### Direct

Fetches RSS/Atom feeds directly from the source URL.

```json
{
  "provider": {
    "type": "direct",
    "timeoutMs": 30000,
    "retryAttempts": 3
  }
}
```

**Use when:**

- Feed is publicly accessible
- No authentication required
- Direct access is not blocked

### RSSHub

Uses a self-hosted or public RSSHub instance to fetch feeds.

```json
{
  "provider": {
    "type": "rsshub",
    "url": "https://rsshub.app",
    "accessKey": "optional-access-key"
  }
}
```

**Use when:**

- Converting websites without RSS to feeds
- Need advanced filtering/routing
- Access to restricted routes

### CPProxy

Uses Control Plane's managed RSSHub proxy.

```json
{
  "provider": {
    "type": "cpproxy",
    "url": "https://feeds.synap.io",
    "apiKey": "your-api-key"
  }
}
```

**Use when:**

- Using Synap's managed service
- Need reliable uptime
- Want automatic failover

### Custom

User-defined provider with custom fetch logic.

```json
{
  "provider": {
    "type": "custom",
    "fetcherId": "my-custom-fetcher",
    "customConfig": {
      "apiEndpoint": "https://api.example.com/items",
      "authHeader": "Bearer token"
    }
  }
}
```

**Use when:**

- Integrating with custom APIs
- Need specialized parsing
- Working with non-standard feeds

## Feed Types

### RSS Feed

Traditional RSS/Atom feed subscription.

```json
{
  "type": "rss",
  "schedule": "0 */6 * * *",
  "sources": [
    {
      "url": "https://example.com/feed.xml",
      "name": "Example Blog"
    }
  ],
  "postMode": "individual"
}
```

### Proactive Feed

AI-generated digest of workspace activity.

```json
{
  "type": "proactive",
  "schedule": "0 9 * * *",
  "include": {
    "tasksDue": true,
    "tasksDueDays": 3,
    "pendingProposals": true,
    "recentEntities": true,
    "recentEntitiesHours": 24,
    "recentCaptures": true,
    "recentCapturesHours": 24,
    "activitySummary": true
  },
  "summarization": {
    "style": "brief",
    "maxItems": 10,
    "includeInsights": true
  }
}
```

## Error Handling

### HTTP Status Codes

| Code | Description                             |
| ---- | --------------------------------------- |
| 200  | Success                                 |
| 201  | Created                                 |
| 400  | Bad Request - Invalid parameters        |
| 401  | Unauthorized - Invalid or missing token |
| 403  | Forbidden - Insufficient permissions    |
| 404  | Not Found - Feed or item doesn't exist  |
| 409  | Conflict - Duplicate or invalid state   |
| 422  | Unprocessable - Validation failed       |
| 429  | Rate Limited - Too many requests        |
| 500  | Server Error                            |

### Error Response Format

```json
{
  "error": {
    "code": "FEED_NOT_FOUND",
    "message": "Feed with ID 'feed-123' not found",
    "details": {
      "feedId": "feed-123"
    }
  }
}
```

### Common Error Codes

- `FEED_NOT_FOUND` - Feed doesn't exist
- `INVALID_FEED_CONFIG` - Configuration validation failed
- `PROVIDER_ERROR` - Feed provider returned an error
- `RATE_LIMITED` - Too many requests to provider
- `FETCH_FAILED` - Unable to fetch feed
- `CLASSIFICATION_FAILED` - AI classification error

## Rate Limits

| Endpoint         | Limit          |
| ---------------- | -------------- |
| List feeds       | 100/min        |
| Create feed      | 10/min         |
| Update feed      | 30/min         |
| Trigger fetch    | 5/min per feed |
| Get items        | 200/min        |
| Track engagement | 500/min        |

## Webhooks

Subscribe to feed events via webhooks:

```http
POST /api/webhooks/subscribe
```

```json
{
  "url": "https://your-app.com/webhooks/feed",
  "events": ["feed.item.created", "feed.fetch.completed"],
  "secret": "webhook-signing-secret"
}
```

### Events

- `feed.created` - New feed created
- `feed.updated` - Feed configuration updated
- `feed.deleted` - Feed deleted
- `feed.item.created` - New item fetched
- `feed.fetch.started` - Fetch job started
- `feed.fetch.completed` - Fetch job completed
- `feed.fetch.failed` - Fetch job failed
- `feed.engagement` - User engaged with item

## SDK Examples

### JavaScript/TypeScript

```typescript
import { SynapClient } from "@synap/sdk";

const client = new SynapClient({ apiKey: "your-api-key" });

// Create a feed
const feed = await client.feeds.create({
  name: "Tech News",
  type: "rss",
  sources: [{ url: "https://example.com/feed.xml" }],
  provider: { type: "direct" },
});

// Get items
const items = await client.feeds.getItems(feed.id, {
  limit: 20,
  minScore: 60,
});

// Track engagement
await client.feeds.trackEngagement({
  itemId: items[0].id,
  action: "click",
});
```

### cURL

```bash
# List feeds
curl -H "Authorization: Bearer $TOKEN" \
  https://api.synap.io/api/feeds

# Create feed
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Feed",
    "type": "rss",
    "sources": [{"url": "https://example.com/feed.xml"}]
  }' \
  https://api.synap.io/api/feeds

# Trigger fetch
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  https://api.synap.io/api/feeds/feed-123/trigger
```

## Changelog

### v1.0.0 (2024-01-15)

- Initial release
- Support for RSS/Atom feeds
- Proactive feed digests
- AI-powered classification
- Provider abstraction (direct, RSSHub, CPProxy, custom)
