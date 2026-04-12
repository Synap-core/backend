# RSSHub Integration for Signal Feed

## Overview

RSSHub is the external content source for Synap's Signal Feed. It provides 100+ platform routes (Twitter, Reddit, YouTube, GitHub, etc.) that convert websites into RSS feeds.

## Architecture

### CP as Infrastructure Proxy

The Control Plane runs RSSHub as a shared Docker service and provides a rate-limited proxy API for pods to access it.

```
Pod → HTTPS → CP Proxy API → RSSHub Docker → Website
     (Hub Protocol)    (rate limiting)   (100+ routes)
```

### Why CP Proxy, Not Direct?

1. **Rate limiting**: Prevent abuse of RSSHub instance
2. **Caching**: CP can cache popular feeds
3. **Monitoring**: Track usage metrics
4. **Isolation**: Pods don't need RSSHub credentials

## Implementation

### 1. Docker Services

```yaml
# synap-control-plane-api/docker-compose.yml
services:
  rsshub:
    image: diygod/rsshub:latest
    container_name: synap-rsshub
    restart: unless-stopped
    ports:
      - "1200:1200"
    environment:
      - NODE_ENV=production
      - CACHE_TYPE=redis
      - REDIS_URL=redis://redis:6379
      - PUPPETEER_WS_ENDPOINT=ws://browserless:3000
    depends_on:
      - redis
      - browserless

  browserless:
    image: browserless/chrome:latest
    container_name: synap-browserless
    restart: unless-stopped
    environment:
      - CONNECTION_TIMEOUT=60000
      - MAX_CONCURRENT_SESSIONS=10
```

### 2. CP Proxy API

```typescript
// synap-control-plane-api/src/routes/rsshub-proxy.ts
import { Hono } from "hono";
import { rateLimiter } from "../lib/rate-limiter";

const app = new Hono();

// Rate limiting: 100 requests/hour per IP
const RSSHUB_RATE_LIMIT = {
  window: 3600, // 1 hour
  max: 100,
};

app.get("/api/rsshub-proxy/*", async (c) => {
  const clientIp =
    c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "anonymous";

  // Rate limit check
  const limit = await rateLimiter.check(clientIp, "rsshub", RSSHUB_RATE_LIMIT);
  if (limit.remaining <= 0) {
    return c.json(
      {
        error: "Rate limit exceeded",
        retryAfter: limit.resetAfter,
      },
      429
    );
  }

  // Extract RSSHub path
  const proxyPath = c.req.path.replace("/api/rsshub-proxy", "");
  const rsshubUrl = `${process.env.RSSHUB_URL}${proxyPath}${c.req.url.search}`;

  try {
    // Forward to RSSHub with timeout
    const response = await fetch(rsshubUrl, {
      signal: AbortSignal.timeout(30000), // 30s timeout
      headers: {
        "User-Agent": "Synap-Signal-Feed/1.0",
      },
    });

    if (!response.ok) {
      throw new Error(
        `RSSHub error: ${response.status} ${response.statusText}`
      );
    }

    // Return as XML
    const xml = await response.text();
    return c.body(xml, {
      headers: {
        "Content-Type": "application/xml",
        "X-RateLimit-Limit": limit.max.toString(),
        "X-RateLimit-Remaining": limit.remaining.toString(),
        "X-RateLimit-Reset": limit.resetAfter.toString(),
      },
    });
  } catch (error) {
    console.error("RSSHub proxy error:", error);
    return c.json(
      {
        error: "Failed to fetch from RSSHub",
        details: error.message,
      },
      502
    );
  }
});

// Health check endpoint
app.get("/api/rsshub-proxy/health", async (c) => {
  try {
    const response = await fetch(`${process.env.RSSHUB_URL}/`);
    return c.json({
      status: response.ok ? "healthy" : "unhealthy",
      rsshub: response.ok,
    });
  } catch {
    return c.json(
      {
        status: "unhealthy",
        rsshub: false,
      },
      503
    );
  }
});

export default app;
```

### 3. Pod Hub Protocol Endpoint

```typescript
// synap-backend/packages/api/src/routers/hub-protocol/signals.ts
app.post("/signals/fetch", async (c) => {
  const { sourceRoute, platform, options } = await c.req.json();
  const apiKey = c.get("apiKey");

  // Validate sourceRoute format
  if (!isValidRssHubRoute(sourceRoute, platform)) {
    return c.json({ error: "Invalid RSSHub route" }, 400);
  }

  // Call CP proxy
  const cpUrl = `${process.env.CP_API_URL}/api/rsshub-proxy${sourceRoute}`;
  const response = await fetch(cpUrl, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Forwarded-For": c.get("userId"), // For rate limiting
    },
  });

  if (!response.ok) {
    return c.json(
      {
        error: "Failed to fetch from RSSHub",
        status: response.status,
      },
      502
    );
  }

  const xml = await response.text();
  const items = parseRssXml(xml, platform);

  return c.json({ items });
});
```

## Supported Platforms

### Twitter/X

```typescript
// User timeline
"/twitter/user/elonmusk";

// List
"/twitter/list/1234567890";

// Search (requires API key)
"/twitter/keyword/ai";
```

### Reddit

```typescript
// Subreddit
"/reddit/r/programming";

// User posts
"/reddit/user/spez";

// Search
"/reddit/search/rss?q=ai&sort=relevance&t=week";
```

### YouTube

```typescript
// Channel
"/youtube/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw";

// Playlist
"/youtube/playlist/PLMC9KNkIncKtPzgY-5rmhvj7fax8fdxoj";

// User (legacy)
"/youtube/user/GoogleDevelopers";
```

### GitHub

```typescript
// Repository releases
"/github/releases/vercel/next.js";

// Repository issues
"/github/issues/facebook/react";

// User activity
"/github/user/DIYgod";
```

### Hacker News

```typescript
// Front page
"/hackernews/frontpage";

// Newest
"/hackernews/newest";

// Best
"/hackernews/best";
```

### Product Hunt

```typescript
// Today's products
"/producthunt/today";

// Upcoming
"/producthunt/upcoming";

// User collections
"/producthunt/collections/123";
```

### LinkedIn (via Nitter/Invidious proxy)

```typescript
// Company updates
"/linkedin/company/microsoft";

// Hashtag
"/linkedin/hashtag/ai";
```

### RSS/Atom (Generic)

```typescript
// Any RSS feed
"/rss/https://news.ycombinator.com/rss";

// Atom feed
"/atom/https://github.blog/feed/";
```

## Route Validation

```typescript
function isValidRssHubRoute(route: string, platform: string): boolean {
  const ALLOWED_ROUTES = {
    twitter: /^\/twitter\/(user|list|keyword)\/[a-zA-Z0-9_\-]+/,
    reddit: /^\/reddit\/(r|user|search)\/[a-zA-Z0-9_\-]+/,
    youtube: /^\/youtube\/(channel|playlist|user)\/[a-zA-Z0-9_\-]+/,
    github:
      /^\/github\/(releases|issues|user)\/[a-zA-Z0-9_\-]+\/[a-zA-Z0-9_\-]+/,
    hackernews: /^\/hackernews\/(frontpage|newest|best)/,
    producthunt: /^\/producthunt\/(today|upcoming|collections)/,
    linkedin: /^\/linkedin\/(company|hashtag)\/[a-zA-Z0-9_\-]+/,
    rss: /^\/rss\/https?:\/\/.+/,
  };

  const pattern = ALLOWED_ROUTES[platform];
  return pattern ? pattern.test(route) : false;
}
```

## Rate Limiting Strategy

### Per-User Limits (Pod-level)

```typescript
const USER_LIMITS = {
  free: {
    requestsPerHour: 50,
    concurrentFetches: 3,
    cacheTtl: 3600, // 1 hour
  },
  pro: {
    requestsPerHour: 200,
    concurrentFetches: 10,
    cacheTtl: 1800, // 30 minutes
  },
  enterprise: {
    requestsPerHour: 1000,
    concurrentFetches: 25,
    cacheTtl: 900, // 15 minutes
  },
};
```

### Caching Strategy

```typescript
interface CacheConfig {
  // Redis cache keys
  keyPrefix: "rsshub:cache";

  // TTL based on platform
  ttls: {
    twitter: 300; // 5 minutes (fast-changing)
    hackernews: 900; // 15 minutes
    youtube: 1800; // 30 minutes
    github: 3600; // 1 hour
    rss: 7200; // 2 hours
  };

  // Cache invalidation on error
  errorBackoff: {
    initial: 60; // 1 minute
    multiplier: 2;
    max: 3600; // 1 hour
  };
}
```

## Error Handling

### Common RSSHub Errors

```typescript
const RSSHUB_ERRORS = {
  "Route not found": 404,
  "Rate limit exceeded": 429,
  Timeout: 504,
  "Network error": 502,
  "Parse error": 500,
};

// Retry strategy
async function fetchWithRetry(url: string, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fetch(url);
    } catch (error) {
      if (i === maxRetries - 1) throw error;

      // Exponential backoff
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 * Math.pow(2, i))
      );
    }
  }
}
```

## Monitoring

### Metrics to Track

```typescript
interface RssHubMetrics {
  // Usage metrics
  totalRequests: number;
  requestsByPlatform: Record<string, number>;
  cacheHitRate: number;

  // Performance metrics
  averageLatency: number;
  errorRate: number;
  timeoutRate: number;

  // Quality metrics
  itemsPerRequest: number;
  parseSuccessRate: number;
  emptyResponseRate: number;
}
```

### Health Checks

```bash
# Check RSSHub service
curl http://rsshub:1200/

# Check CP proxy
curl http://localhost:3000/api/rsshub-proxy/health

# Test a route
curl "http://localhost:3000/api/rsshub-proxy/hackernews/newest"
```

## Security Considerations

### 1. Input Validation

```typescript
// Prevent SSRF attacks
function sanitizeRssHubUrl(url: string): string {
  // Remove any attempts to access internal services
  const internalHosts = ["localhost", "127.0.0.1", "0.0.0.0", "internal"];
  const parsed = new URL(url);

  if (internalHosts.some((host) => parsed.hostname.includes(host))) {
    throw new Error("Invalid RSSHub URL");
  }

  return url;
}
```

### 2. Rate Limiting

- IP-based limits for anonymous users
- User-based limits for authenticated users
- Platform-specific limits (Twitter stricter than RSS)

### 3. Content Filtering

```typescript
// Optional content filtering
const CONTENT_FILTERS = {
  blockAdult: true,
  blockViolence: true,
  blockHateSpeech: true,
  allowedLanguages: ["en", "fr"], // Default: all
};

async function filterContent(items: RssHubItem[]): Promise<RssHubItem[]> {
  // Implement ML-based or keyword-based filtering
  return items.filter((item) => !containsBlockedContent(item));
}
```

## Configuration

### Environment Variables

```bash
# Required
RSSHUB_URL=http://rsshub:1200
RSSHUB_PROXY_ENABLED=true

# Optional
RSSHUB_RATE_LIMIT=100/hour
RSSHUB_CACHE_ENABLED=true
RSSHUB_CACHE_TTL=3600
RSSHUB_TIMEOUT=30000
RSSHUB_USER_AGENT=Synap-Signal-Feed/1.0

# Platform-specific (API keys for rate-limited platforms)
TWITTER_BEARER_TOKEN=...
REDDIT_CLIENT_ID=...
REDDIT_CLIENT_SECRET=...
YOUTUBE_API_KEY=...
GITHUB_TOKEN=...
```

### Platform Configuration

```json
{
  "platforms": {
    "twitter": {
      "enabled": true,
      "rateLimit": "50/hour",
      "requiresAuth": true,
      "cacheTtl": 300
    },
    "hackernews": {
      "enabled": true,
      "rateLimit": "100/hour",
      "requiresAuth": false,
      "cacheTtl": 900
    },
    "rss": {
      "enabled": true,
      "rateLimit": "200/hour",
      "requiresAuth": false,
      "cacheTtl": 3600
    }
  }
}
```

## Testing

### Unit Tests

```typescript
describe("RSSHub Integration", () => {
  test("validates RSSHub routes", () => {
    expect(isValidRssHubRoute("/twitter/user/elonmusk", "twitter")).toBe(true);
    expect(isValidRssHubRoute("/invalid/route", "twitter")).toBe(false);
  });

  test("parses RSS XML correctly", () => {
    const xml = `<rss><channel><item><title>Test</title></item></channel></rss>`;
    const items = parseRssXml(xml, "rss");
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Test");
  });

  test("respects rate limits", async () => {
    // Mock rate limiter
    // Test that 101st request in hour returns 429
  });
});
```

### Integration Tests

```bash
# Test RSSHub service
docker-compose up -d rsshub redis browserless
sleep 30  # Wait for services to start

# Test proxy endpoint
curl -v "http://localhost:3000/api/rsshub-proxy/hackernews/newest"

# Test with authentication
curl -H "Authorization: Bearer test-key" \
  "http://localhost:3000/api/rsshub-proxy/twitter/user/elonmusk"
```

## Troubleshooting

### Common Issues

1. **RSSHub returns 404**
   - Check route syntax
   - Verify platform is enabled
   - Check RSSHub logs

2. **Rate limit errors**
   - Check X-RateLimit headers
   - Implement exponential backoff
   - Consider caching strategy

3. **Timeout errors**
   - Increase timeout (default: 30s)
   - Check network connectivity
   - Verify RSSHub health

4. **Parse errors**
   - Validate XML structure
   - Handle malformed feeds
   - Implement fallback parsing

### Logging

```typescript
import { createLogger } from "@synap/core";

const logger = createLogger({ module: "rsshub-proxy" });

// Log all requests
app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const duration = Date.now() - start;

  logger.info("RSSHub request", {
    path: c.req.path,
    status: c.res.status,
    duration,
    client: c.req.header("x-forwarded-for"),
  });
});
```

## Performance Optimization

### 1. Caching

```typescript
// Multi-level caching
async function getWithCache(route: string): Promise<RssHubItem[]> {
  // Level 1: Memory cache (5 minutes)
  const memoryKey = `memory:${route}`;
  if (memoryCache.has(memoryKey)) {
    return memoryCache.get(memoryKey);
  }

  // Level 2: Redis cache (configurable TTL)
  const redisKey = `rsshub:${route}`;
  const cached = await redis.get(redisKey);
  if (cached) {
    memoryCache.set(memoryKey, JSON.parse(cached));
    return JSON.parse(cached);
  }

  // Level 3: Fetch from RSSHub
  const items = await fetchFromRssHub(route);

  // Update caches
  memoryCache.set(memoryKey, items);
  await redis.setex(redisKey, getTtlForRoute(route), JSON.stringify(items));

  return items;
}
```

### 2. Concurrent Fetching

```typescript
// Fetch multiple sources concurrently
async function fetchMultiple(sources: Source[]): Promise<SignalItem[]> {
  const batches = chunk(sources, 5); // 5 concurrent fetches
  const allItems: SignalItem[] = [];

  for (const batch of batches) {
    const promises = batch.map((source) => fetchSource(source));
    const results = await Promise.allSettled(promises);

    for (const result of results) {
      if (result.status === "fulfilled") {
        allItems.push(...result.value);
      } else {
        logger.error("Failed to fetch source", { error: result.reason });
      }
    }
  }

  return allItems;
}
```

### 3. Lazy Loading

```typescript
// Paginate feed items
interface FeedPage {
  items: SignalItem[];
  nextOffset?: number;
  hasMore: boolean;
}

async function getFeedPage(offset = 0, limit = 20): Promise<FeedPage> {
  // Only fetch sources needed for this page
  const sources = selectSourcesForPage(offset, limit);
  const items = await fetchMultiple(sources);

  return {
    items: items.slice(0, limit),
    nextOffset: items.length > limit ? offset + limit : undefined,
    hasMore: items.length > limit,
  };
}
```

## Future Enhancements

### 1. Smart Caching

- Predictive pre-fetching based on user patterns
- Cache warming for popular feeds
- Adaptive TTL based on update frequency

### 2. Quality Scoring

- Detect and filter low-quality sources
- Score feeds based on reliability
- User feedback integration

### 3. Advanced Routing

- Route fallbacks (if Twitter fails, try Nitter)
- Geographic routing (localized content)
- Platform-specific optimizations

### 4. Analytics Integration

- Track which sources users engage with
- A/B test different source combinations
- Predictive source recommendations

---

_Last updated: 2026-04-12_
_Owner: Infrastructure Team_
_Status: Ready for Implementation_
