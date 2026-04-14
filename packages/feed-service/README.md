# @synap/feed-service

RSS/Atom feed ingestion service for Synap. Provides a modular pipeline for fetching, classifying, and publishing feed content to channels.

## Features

- **Multiple Providers**: Direct HTTP, RSSHub, Control Plane proxy, and custom fetchers
- **AI & Local Classification**: Intelligence Service integration or fast keyword-based classification
- **Channel Publishing**: Posts feed items as messages to Synap channels
- **Deduplication**: Content hash-based deduplication with configurable windows
- **Scheduling**: Cron-based feed fetching with timezone support
- **Health Monitoring**: Provider health checks and metrics
- **Type-Safe**: Full TypeScript support with Zod validation

## Installation

```bash
pnpm add @synap/feed-service
```

## Quick Start

```typescript
import { FeedService, FeedServiceFactory } from "@synap/feed-service";

// Create and configure the feed service
const feedService = new FeedService({
  defaultClassifier: "keyword",
  enableDeduplication: true,
  minRelevanceScore: 0.4,
});

// Process a feed
const result = await feedService.processFeed(
  {
    url: "https://example.com/feed.xml",
    provider: { type: "direct", timeoutMs: 30000 },
    name: "Example Feed",
  },
  {
    destination: {
      channelId: "channel-123",
      userId: "user-456",
    },
    userContext: {
      userId: "user-456",
      interests: ["technology", "ai"],
      priorityKeywords: ["startup", "funding"],
    },
  }
);

console.log(`Fetched: ${result.itemsFetched}`);
console.log(`Published: ${result.itemsPublished}`);
```

## Architecture

The feed service follows a modular pipeline architecture:

```
FeedSource → Provider → Classifier → Publisher → Channel
```

### Components

1. **Providers** (`IFeedProvider`): Fetch and normalize feed content
2. **Classifiers** (`IFeedClassifier`): Analyze and categorize items
3. **Publishers** (`IFeedPublisher`): Post items to destinations
4. **FeedService**: Orchestrates the pipeline

## Providers

### DirectRSSProvider

Fetches feeds directly via HTTP with support for RSS, Atom, and JSON formats.

```typescript
import { DirectRSSProvider } from "@synap/feed-service";

const provider = new DirectRSSProvider("MyApp/1.0");
const items = await provider.fetch({
  url: "https://example.com/feed.xml",
  provider: { type: "direct", timeoutMs: 30000, retryAttempts: 3 },
});
```

### RSSHubProvider

Connects to RSSHub instances for generating feeds from websites without native RSS.

```typescript
import { RSSHubProvider } from "@synap/feed-service";

const provider = new RSSHubProvider({
  url: "https://rsshub.app",
  enableCache: true,
  cacheTtlSeconds: 300,
});

const items = await provider.fetch({
  url: "https://rsshub.app/github/trending/daily/typescript",
  provider: { type: "rsshub" },
});
```

### CPProxyProvider

Routes requests through the Control Plane proxy for rate-limited feeds.

```typescript
import { CPProxyProvider } from "@synap/feed-service";

const provider = new CPProxyProvider({
  url: "https://cp.synap.io/api/feeds/proxy",
  apiKey: "your-api-key",
  rateLimitAware: true,
  region: "us-east",
});
```

### CustomProvider

Extensible provider for custom fetch and parse logic.

```typescript
import { CustomProvider } from "@synap/feed-service";

// Register custom implementations
CustomProvider.registerFetcher("myapi", async (url, config, headers) => {
  const response = await fetch(url, { headers });
  return { body: await response.text(), contentType: "application/json" };
});

CustomProvider.registerParser("myapi", (body, contentType, source) => {
  const data = JSON.parse(body);
  return data.items.map((item) => ({
    id: item.id,
    title: item.headline,
    content: item.body,
    source: { url: source.url },
  }));
});

const provider = new CustomProvider({
  fetcherId: "myapi",
  parserId: "myapi",
});
```

## Classifiers

### ISClassifier

Uses the Intelligence Service API for AI-powered classification.

```typescript
import { ISClassifier } from "@synap/feed-service";

const classifier = new ISClassifier({
  isServiceUrl: "https://is.synap.io",
  isServiceApiKey: "your-api-key",
  minConfidence: 0.6,
  enableFallback: true, // Falls back to keyword classifier on failure
});

const classified = await classifier.classify(items, {
  userId: "user-123",
  interests: ["technology", "ai"],
});
```

### KeywordClassifier

Fast, local classification using keyword matching. No external dependencies.

```typescript
import { KeywordClassifier } from "@synap/feed-service";

const classifier = new KeywordClassifier({
  minConfidence: 0.4,
  categories: [
    {
      name: "technology",
      keywords: ["ai", "software", "programming"],
      relatedKeywords: ["innovation", "startup"],
    },
  ],
});
```

### NoopClassifier

Pass-through classifier for testing.

```typescript
import { NoopClassifier } from "@synap/feed-service";

const classifier = new NoopClassifier({
  defaultCategory: "general",
  shouldPublish: true,
});
```

## Publishers

### ChannelMessagePublisher

Posts feed items as messages to Synap channels.

```typescript
import { ChannelMessagePublisher } from "@synap/feed-service";

const publisher = new ChannelMessagePublisher({
  maxBatchSize: 10,
  rateLimitPerMinute: 60,
  enableDeduplication: true,
  format: {
    includeContent: true,
    includeClassification: true,
  },
});

await publisher.publish(classifiedItems, {
  channelId: "channel-123",
  userId: "user-456",
  feedName: "Tech News",
  batchMode: true,
});
```

## Factory Pattern

Use `FeedServiceFactory` for convenient component creation:

```typescript
import { FeedServiceFactory } from "@synap/feed-service";

// Configure factory
FeedServiceFactory.configure({
  userAgent: "MyApp/1.0",
  keywordConfig: { minConfidence: 0.5 },
  publisherConfig: { maxBatchSize: 20 },
});

// Create components
const provider = FeedServiceFactory.createProvider({ type: "direct" });
const classifier = FeedServiceFactory.createClassifier("keyword");
const publisher = FeedServiceFactory.createPublisher("channel");

// Or create a complete pipeline
const pipeline = FeedServiceFactory.createPipeline({
  provider: { type: "rsshub", url: "https://rsshub.app" },
  classifier: "is",
  publisher: "channel",
});
```

## Configuration

### Zod Schemas

All configurations are validated using Zod:

```typescript
import {
  RSSProviderConfigSchema,
  FeedSourceConfigSchema,
} from "@synap/feed-service";

// Validate configuration
const config = RSSProviderConfigSchema.parse({
  type: "direct",
  timeoutMs: 30000,
});
```

### Environment Variables

```bash
# IS Classifier
IS_SERVICE_URL=https://is.synap.io
IS_SERVICE_API_KEY=your-api-key

# CP Proxy
CP_PROXY_URL=https://cp.synap.io/api/feeds/proxy
CP_PROXY_API_KEY=your-api-key
```

## Error Handling

The service uses standard Synap error types:

```typescript
import { FeedFetchError, FeedParseError } from "@synap/shared-utils";
import { ServiceUnavailableError } from "@synap-core/core";

try {
  await feedService.processFeed(source, options);
} catch (error) {
  if (error instanceof FeedFetchError) {
    console.error(`Fetch failed: ${error.message}`);
  } else if (error instanceof FeedParseError) {
    console.error(`Parse failed: ${error.message}`);
  }
}
```

## Advanced Usage

### Custom Pipeline

```typescript
import {
  DirectRSSProvider,
  KeywordClassifier,
  ChannelMessagePublisher,
} from "@synap/feed-service";

// Create custom components
const provider = new DirectRSSProvider();
const classifier = new KeywordClassifier({
  categories: [...], // Custom categories
});
const publisher = new ChannelMessagePublisher({
  format: { includeContent: false }, // Summary only
});

// Fetch
const items = await provider.fetch(source);

// Classify
const classified = await classifier.classify(items, userContext);

// Filter
const highRelevance = classified.filter((c) => (c.relevanceScore ?? 0) > 0.7);

// Publish
await publisher.publish(highRelevance, destination);
```

### Scheduling

```typescript
// Schedule a feed to run every 6 hours
const { jobId, nextRunAt } = await feedService.scheduleFeed(
  "feed-123",
  source,
  "0 */6 * * *",
  "America/New_York"
);

// Cancel scheduled feed
await feedService.cancelScheduledFeed(jobId);
```

### Health Checks

```typescript
// Check provider health
const health = await feedService.getFeedHealth(source);
console.log(`Healthy: ${health.healthy}`);
console.log(`Last error: ${health.error}`);

// Provider-level health check
const provider = new DirectRSSProvider();
const status = await provider.healthCheck();
console.log(`Consecutive failures: ${status.consecutiveFailures}`);
```

## API Reference

### FeedService

| Method                               | Description                                   |
| ------------------------------------ | --------------------------------------------- |
| `processFeed(source, options)`       | Complete pipeline: fetch → classify → publish |
| `fetchFeed(source)`                  | Fetch only, return result metadata            |
| `validateFeed(source)`               | Validate feed accessibility                   |
| `scheduleFeed(id, source, cron, tz)` | Schedule periodic fetching                    |
| `cancelScheduledFeed(jobId)`         | Cancel scheduled job                          |
| `getFeedHealth(source)`              | Get provider health status                    |

### Interfaces

- `IFeedProvider`: `fetch()`, `validate()`, `healthCheck()`, `getProviderType()`
- `IFeedClassifier`: `classify(items, context)`, `getClassifierType()`
- `IFeedPublisher`: `publish(items, destination)`, `publishOne(item, destination)`, `getPublisherType()`

## License

MIT - Synap Systems
