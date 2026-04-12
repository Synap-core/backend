# Signal Item Entity Profile & Database Schema

## Overview

The `signal_item` entity profile enables external content (from RSSHub) to become first-class citizens in Synap's knowledge graph. When users capture signal items, they create entities that can be searched, linked, viewed, and processed just like any other data in the system.

## Entity Profile Definition

### Core Profile (`signal_item`)

```typescript
// Location: synap-backend/packages/database/src/utils/ensure-system-profiles.ts

{
  slug: "signal_item",
  parentSlug: "bookmark",  // Inherits: url, title, summary, favicon
  name: "Signal Item",
  icon: "signal",
  color: "cyan",
  entityScope: "workspace",  // Scoped to workspace (not pod-wide)

  // Property definitions
  properties: {
    // Required: source identification
    sourcePlatform: {
      type: "string",
      required: true,
      enum: ["twitter", "reddit", "youtube", "github", "hackernews",
             "producthunt", "linkedin", "threads", "telegram", "rss"],
      ui: { label: "Platform", display: "badge" },
    },

    sourceRoute: {
      type: "string",
      required: true,
      ui: { label: "Source Route", display: "text", hidden: true },
    },

    // Author information
    authorUsername: {
      type: "string",
      ui: { label: "Author Username", display: "text" },
    },

    authorDisplayName: {
      type: "string",
      ui: { label: "Author Name", display: "text" },
    },

    authorUrl: {
      type: "string",
      ui: { label: "Author Profile", display: "link", hidden: true },
    },

    // Timing
    publishedAt: {
      type: "datetime",
      required: true,
      ui: { label: "Published", display: "relative_date" },
    },

    fetchedAt: {
      type: "datetime",
      ui: { label: "Fetched", display: "relative_date", hidden: true },
    },

    // AI metadata
    aiSummary: {
      type: "string",
      ui: { label: "AI Summary", display: "markdown", multiline: true },
    },

    topics: {
      type: "string[]",
      required: true,
      default: [],
      ui: { label: "Topics", display: "tags" },
    },

    relevanceScore: {
      type: "number",
      default: 0.5,
      ui: { label: "Relevance", display: "progress", hidden: true },
    },

    // Content classification
    sentiment: {
      type: "string",
      enum: ["positive", "neutral", "negative", "mixed"],
      ui: { label: "Sentiment", display: "badge", hidden: true },
    },

    importance: {
      type: "number",
      min: 0,
      max: 1,
      ui: { label: "Importance", display: "progress", hidden: true },
    },

    // Raw data (for debugging/reprocessing)
    rawData: {
      type: "json",
      ui: { label: "Raw Data", display: "json", hidden: true },
    },

    // Integration flags
    capturedFromFeed: {
      type: "boolean",
      default: false,
      ui: { label: "Captured from Feed", display: "checkbox", hidden: true },
    },

    captureMethod: {
      type: "string",
      enum: ["manual", "automation", "ai_suggestion"],
      ui: { label: "Capture Method", display: "badge", hidden: true },
    },

    // Auto-linking results
    autoLinkedEntities: {
      type: "string[]",
      default: [],
      ui: { label: "Linked Entities", display: "entity_reference", hidden: true },
    },

    // Engagement tracking
    viewCount: {
      type: "number",
      default: 0,
      ui: { label: "Views", display: "number", hidden: true },
    },

    captureCount: {
      type: "number",
      default: 0,
      ui: { label: "Captures", display: "number", hidden: true },
    },
  },

  // Profile metadata
  description: "External content captured from signal feeds (Twitter, Reddit, Hacker News, etc.)",
  isSystem: true,
  isHidden: false,
  sortOrder: 100,

  // Default views
  defaultView: "table",
  quickActions: [
    { label: "Open Original", icon: "external-link", action: "openUrl" },
    { label: "Summarize", icon: "sparkles", action: "ai_summarize" },
    { label: "Share", icon: "share", action: "share" },
  ],

  // AI prompts for this entity type
  aiPrompts: {
    summarize: "Summarize this signal item and explain why it might be relevant to the user's work.",
    extract_entities: "Extract people, companies, products, and topics mentioned in this signal.",
    relate_to_context: "How does this signal relate to the user's current tasks and projects?",
  },
}
```

## Database Schema

### Signal-Specific Tables

#### 1. `signal_subscriptions` (Pod Schema)

```sql
-- User's explicit signal preferences
CREATE TABLE signal_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- Subscription target
  topic TEXT NOT NULL,  -- e.g., "ai", "programming"
  source_platform TEXT, -- e.g., "twitter", NULL for all platforms
  source_route TEXT,    -- e.g., "/twitter/user/elonmusk", NULL for topic-based

  -- Subscription settings
  is_active BOOLEAN NOT NULL DEFAULT true,
  confidence FLOAT NOT NULL DEFAULT 0.5,  -- 0-1 user-set importance
  notification_preference TEXT DEFAULT 'none' CHECK (notification_preference IN ('none', 'digest', 'immediate')),

  -- Metadata
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_fetched_at TIMESTAMPTZ,

  -- Constraints
  UNIQUE(user_id, workspace_id, topic, source_platform, source_route)
);

-- Indexes
CREATE INDEX idx_signal_subscriptions_user_workspace
  ON signal_subscriptions(user_id, workspace_id) WHERE is_active = true;
CREATE INDEX idx_signal_subscriptions_topic
  ON signal_subscriptions(topic) WHERE is_active = true;
```

#### 2. `signal_classifications` (Pod Schema)

```sql
-- AI-classified user interests (implicit learning)
CREATE TABLE signal_classifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- Classification
  topic TEXT NOT NULL,           -- e.g., "ai", "startups"
  confidence FLOAT NOT NULL DEFAULT 0.0,  -- 0-1 AI-computed confidence

  -- Source tracking
  source_type TEXT NOT NULL CHECK (source_type IN ('capture', 'view', 'dwell', 'search', 'ai_inferred')),
  source_entity_id UUID,         -- Entity that triggered this classification
  source_signal_id UUID REFERENCES entities(id) ON DELETE SET NULL,

  -- Counters
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  total_weight FLOAT NOT NULL DEFAULT 1.0,

  -- Time tracking
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Decay tracking (for relevance over time)
  decay_rate FLOAT NOT NULL DEFAULT 0.95,  -- Per-day decay multiplier
  last_decay_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  UNIQUE(user_id, workspace_id, topic)
);

-- Indexes
CREATE INDEX idx_signal_classifications_user_workspace
  ON signal_classifications(user_id, workspace_id);
CREATE INDEX idx_signal_classifications_confidence
  ON signal_classifications(confidence DESC) WHERE confidence > 0.1;
CREATE INDEX idx_signal_classifications_recency
  ON signal_classifications(last_seen_at DESC);
```

#### 3. `signal_fetch_history` (Pod Schema)

```sql
-- History of signal fetches (for analytics and rate limiting)
CREATE TABLE signal_fetch_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- Fetch details
  source_route TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  fetch_type TEXT NOT NULL CHECK (fetch_type IN ('feed', 'manual', 'automation', 'ai_proactive')),

  -- Results
  item_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  cache_hit BOOLEAN NOT NULL DEFAULT false,

  -- Performance
  duration_ms INTEGER NOT NULL,
  response_size_bytes INTEGER,

  -- Metadata
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_agent TEXT,
  client_ip INET,

  -- Indexes for analytics
  INDEX idx_signal_fetch_history_user_time
    ON signal_fetch_history(user_id, fetched_at DESC),
  INDEX idx_signal_fetch_history_platform
    ON signal_fetch_history(source_platform, fetched_at DESC)
);
```

#### 4. `signal_auto_links` (Pod Schema)

```sql
-- Tracks auto-linking between signal items and other entities
CREATE TABLE signal_auto_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  linked_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,

  -- Link details
  link_type TEXT NOT NULL CHECK (link_type IN ('mentions', 'related_to', 'cites', 'discusses')),
  link_strength FLOAT NOT NULL DEFAULT 0.5,  -- 0-1 confidence
  link_context TEXT,  -- e.g., "mentioned in paragraph 3"

  -- Source of link
  source TEXT NOT NULL CHECK (source IN ('ai', 'manual', 'rule_based')),
  source_model TEXT,  -- e.g., "deepseek-chat", "gpt-4"

  -- Metadata
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  UNIQUE(signal_entity_id, linked_entity_id, link_type)
);

-- Indexes
CREATE INDEX idx_signal_auto_links_signal
  ON signal_auto_links(signal_entity_id);
CREATE INDEX idx_signal_auto_links_linked
  ON signal_auto_links(linked_entity_id);
CREATE INDEX idx_signal_auto_links_strength
  ON signal_auto_links(link_strength DESC);
```

## Drizzle Schema Definition

```typescript
// Location: synap-backend/packages/database/src/schema/signals.ts

import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  jsonb,
  integer,
  numeric,
  primaryKey,
  foreignKey,
  index,
} from "drizzle-orm/pg-core";
import { users, workspaces, entities } from "./index";

// Signal subscriptions
export const signalSubscriptions = pgTable(
  "signal_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),

    topic: text("topic").notNull(),
    sourcePlatform: text("source_platform"),
    sourceRoute: text("source_route"),

    isActive: boolean("is_active").notNull().default(true),
    confidence: numeric("confidence", { precision: 3, scale: 2 })
      .notNull()
      .default("0.50"),
    notificationPreference: text("notification_preference")
      .notNull()
      .default("none"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({
      columns: [
        table.userId,
        table.workspaceId,
        table.topic,
        table.sourcePlatform,
        table.sourceRoute,
      ],
    }),
    index("signal_subscriptions_user_workspace_idx")
      .on(table.userId, table.workspaceId)
      .where(table.isActive.eq(true)),
    index("signal_subscriptions_topic_idx")
      .on(table.topic)
      .where(table.isActive.eq(true)),
  ]
);

// Signal classifications
export const signalClassifications = pgTable(
  "signal_classifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),

    topic: text("topic").notNull(),
    confidence: numeric("confidence", { precision: 3, scale: 2 })
      .notNull()
      .default("0.00"),

    sourceType: text("source_type").notNull(),
    sourceEntityId: uuid("source_entity_id"),
    sourceSignalId: uuid("source_signal_id").references(() => entities.id, {
      onDelete: "set null",
    }),

    occurrenceCount: integer("occurrence_count").notNull().default(1),
    totalWeight: numeric("total_weight", { precision: 6, scale: 3 })
      .notNull()
      .default("1.000"),

    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    decayRate: numeric("decay_rate", { precision: 3, scale: 2 })
      .notNull()
      .default("0.95"),
    lastDecayAt: timestamp("last_decay_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.workspaceId, table.topic] }),
    index("signal_classifications_confidence_idx")
      .on(table.confidence.desc())
      .where(table.confidence.gt(0.1)),
    index("signal_classifications_recency_idx").on(table.lastSeenAt.desc()),
  ]
);

// Fetch history
export const signalFetchHistory = pgTable(
  "signal_fetch_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),

    sourceRoute: text("source_route").notNull(),
    sourcePlatform: text("source_platform").notNull(),
    fetchType: text("fetch_type").notNull(),

    itemCount: integer("item_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    cacheHit: boolean("cache_hit").notNull().default(false),

    durationMs: integer("duration_ms").notNull(),
    responseSizeBytes: integer("response_size_bytes"),

    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    userAgent: text("user_agent"),
    clientIp: text("client_ip"),
  },
  (table) => [
    index("signal_fetch_history_user_time_idx").on(
      table.userId,
      table.fetchedAt.desc()
    ),
    index("signal_fetch_history_platform_idx").on(
      table.sourcePlatform,
      table.fetchedAt.desc()
    ),
  ]
);

// Auto-links
export const signalAutoLinks = pgTable(
  "signal_auto_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    signalEntityId: uuid("signal_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    linkedEntityId: uuid("linked_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),

    linkType: text("link_type").notNull(),
    linkStrength: numeric("link_strength", { precision: 3, scale: 2 })
      .notNull()
      .default("0.50"),
    linkContext: text("link_context"),

    source: text("source").notNull(),
    sourceModel: text("source_model"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    primaryKey({
      columns: [table.signalEntityId, table.linkedEntityId, table.linkType],
    }),
    index("signal_auto_links_signal_idx").on(table.signalEntityId),
    index("signal_auto_links_linked_idx").on(table.linkedEntityId),
    index("signal_auto_links_strength_idx").on(table.linkStrength.desc()),
  ]
);
```

## Entity Creation Flow

### 1. Signal Item Creation

```typescript
async function createSignalItemEntity(
  data: SignalCaptureData,
  workspaceId: string,
  userId: string
): Promise<Entity> {
  // 1. Create base entity from bookmark parent
  const entity = await entityRepository.create({
    workspaceId,
    createdById: userId,
    profileSlug: "signal_item",

    // Core properties (inherited from bookmark)
    name: data.title,
    properties: {
      url: data.url,
      summary: data.description || data.title,

      // Signal-specific properties
      sourcePlatform: data.sourcePlatform,
      sourceRoute: data.sourceRoute,
      authorUsername: data.authorUsername,
      authorDisplayName: data.authorDisplayName,
      publishedAt: data.publishedAt,
      fetchedAt: new Date().toISOString(),

      // AI metadata
      aiSummary: data.aiSummary,
      topics: data.topics,
      relevanceScore: data.relevanceScore || 0.5,

      // Raw data
      rawData: data.rawData,

      // Integration flags
      capturedFromFeed: true,
      captureMethod: "manual",
    },
  });

  // 2. Run auto-linking
  await autoLinkSignalItem(entity, workspaceId);

  // 3. Update user classifications
  await updateSignalClassifications(userId, workspaceId, data.topics, {
    sourceType: "capture",
    sourceEntityId: entity.id,
  });

  // 4. Trigger automations
  await triggerAutomations("signal_item.created", {
    entityId: entity.id,
    workspaceId,
    userId,
    data,
  });

  return entity;
}
```

### 2. Auto-Linking Implementation

```typescript
async function autoLinkSignalItem(entity: Entity, workspaceId: string) {
  const rawData = entity.properties.rawData as any;
  const textContent = `${rawData.title} ${rawData.description || ""}`;

  // Extract entities using AI
  const extracted = await aiService.extractEntities(textContent, {
    types: ["person", "company", "product", "project"],
    workspaceId,
  });

  const linkedIds: string[] = [];

  for (const extractedEntity of extracted) {
    // Find existing entities
    const existing = await entityRepository.findSimilar({
      workspaceId,
      type: extractedEntity.type,
      name: extractedEntity.name,
      similarityThreshold: 0.8,
    });

    if (existing.length > 0) {
      // Create auto-link
      await signalAutoLinksRepository.create({
        signalEntityId: entity.id,
        linkedEntityId: existing[0].id,
        linkType: "mentions",
        linkStrength: extractedEntity.confidence,
        linkContext: extractedEntity.context,
        source: "ai",
        sourceModel: "deepseek-chat",
      });

      linkedIds.push(existing[0].id);
    }
  }

  // Update entity with linked IDs
  await entityRepository.update(entity.id, {
    properties: {
      ...entity.properties,
      autoLinkedEntities: linkedIds,
    },
  });
}
```

## Property Resolution & Inheritance

### Inheritance Chain

```
signal_item → bookmark → base_entity
```

### Resolved Properties

```typescript
const resolvedProperties = {
  // From base_entity
  id: string,
  createdAt: datetime,
  updatedAt: datetime,
  workspaceId: string,
  profileSlug: string,

  // From bookmark
  url: string,
  title: string,
  summary: string,
  favicon: string,
  domain: string,

  // From signal_item
  sourcePlatform: string,
  sourceRoute: string,
  authorUsername: string,
  authorDisplayName: string,
  publishedAt: datetime,
  fetchedAt: datetime,
  aiSummary: string,
  topics: string[],
  relevanceScore: number,
  sentiment: string,
  importance: number,
  rawData: json,
  capturedFromFeed: boolean,
  captureMethod: string,
  autoLinkedEntities: string[],
  viewCount: number,
  captureCount: number,
};
```

## Views & Display

### Default Table View

```typescript
const defaultTableView = {
  columns: [
    { field: "title", width: 300, sortable: true },
    { field: "sourcePlatform", width: 100, render: "badge" },
    { field: "authorDisplayName", width: 150 },
    { field: "topics", width: 200, render: "tags" },
    { field: "publishedAt", width: 150, render: "relative_date" },
    { field: "relevanceScore", width: 100, render: "progress" },
  ],
  filters: [
    { field: "sourcePlatform", type: "multi-select" },
    { field: "topics", type: "multi-select" },
    { field: "publishedAt", type: "date-range" },
  ],
  sort: { field: "publishedAt", direction: "desc" },
};
```

### Feed Card Display

```typescript
const feedCardProps = {
  variant: "signal",
  size: "medium",
  show: [
    "title",
    "summary",
    "sourcePlatform",
    "author",
    "topics",
    "publishedAt",
    "aiSummary",
    "actions",
  ],
  actions: [
    { label: "Open", icon: "external-link", action: "openUrl" },
    { label: "Save", icon: "bookmark", action: "capture" },
    { label: "Summarize", icon: "sparkles", action: "ai_summarize" },
  ],
};
```

## Migration Strategy

### Phase 1: Schema Creation

```sql
-- Migration 0066_signal_system.sql
CREATE TYPE signal_platform AS ENUM (
  'twitter', 'reddit', 'youtube', 'github', 'hackernews',
  'producthunt', 'linkedin', 'threads', 'telegram', 'rss'
);

CREATE TYPE signal_notification_pref AS ENUM ('none', 'digest', 'immediate');
CREATE TYPE signal_source_type AS ENUM ('capture', 'view', 'dwell', 'search', 'ai_inferred');
CREATE TYPE signal_fetch_type AS ENUM ('feed', 'manual', 'automation', 'ai_proactive');
CREATE TYPE signal_link_type AS ENUM ('mentions', 'related_to', 'cites', 'discusses');
CREATE TYPE signal_link_source AS ENUM ('ai', 'manual', 'rule_based');

-- Create tables (see above)
```

### Phase 2: Profile Registration

```typescript
// In ensure-system-profiles.ts
export async function ensureSignalItemProfile() {
  const profile = {
    slug: "signal_item",
    // ... profile definition
  };

  await profileRepository.upsert(profile);

  // Add to system profiles array
  SYSTEM_PROFILES.push(profile);
}
```

### Phase 3: Data Migration

```typescript
// Migrate existing bookmark entities that are actually signals
async function migrateExistingSignalBookmarks() {
  const bookmarks = await entityRepository.findByProfile("bookmark");

  for (const bookmark of bookmarks) {
    if (isLikelySignal(bookmark)) {
      await entityRepository.updateProfile(bookmark.id, "signal_item", {
        // Extract signal metadata from existing properties
        sourcePlatform: inferPlatform(bookmark.url),
        capturedFromFeed: false,
        // ... other properties
      });
    }
  }
}
```

## Indexing Strategy

### Full-Text Search

```sql
-- Enable full-text search on signal content
CREATE INDEX idx_signal_fts ON entities
  USING gin(to_tsvector('english',
    COALESCE(properties->>'title', '') || ' ' ||
    COALESCE(properties->>'summary', '') || ' ' ||
    COALESCE(properties->>'aiSummary', '') || ' ' ||
    COALESCE(properties->>'authorDisplayName', '')
  ))
  WHERE profile_slug = 'signal_item';
```

### Composite Indexes

```sql
-- For feed queries
CREATE INDEX idx_signal_feed ON entities
  (workspace_id, (properties->>'publishedAt') DESC NULLS LAST)
  WHERE profile_slug = 'signal_item'
    AND (properties->>'capturedFromFeed')::boolean = true;

-- For topic-based queries
CREATE INDEX idx_signal_topics ON entities
  USING gin((properties->'topics'))
  WHERE profile_slug = 'signal_item';
```

## Testing

### Entity Creation Tests

```typescript
describe("Signal Item Entity", () => {
  test("creates signal_item with proper inheritance", async () => {
    const entity = await createSignalItemEntity(
      mockSignalData,
      workspaceId,
      userId
    );

    expect(entity.profileSlug).toBe("signal_item");
    expect(entity.properties.url).toBe(mockSignalData.url);
    expect(entity.properties.sourcePlatform).toBe("twitter");
    expect(entity.properties.topics).toEqual(["ai", "technology"]);
  });

  test("auto-links to existing entities", async () => {
    const entity = await createSignalItemEntity(
      signalWithMentions,
      workspaceId,
      userId
    );

    const links = await signalAutoLinksRepository.findBySignal(entity.id);
    expect(links).toHaveLength(2); // Should link to 2 existing entities
  });

  test("updates user classifications", async () => {
    await createSignalItemEntity(signalWithAITopic, workspaceId, userId);

    const classification =
      await signalClassificationsRepository.findByUserAndTopic(
        userId,
        workspaceId,
        "ai"
      );

    expect(classification.confidence).toBeGreaterThan(0);
  });
});
```

### Performance Tests

```typescript
describe("Signal Feed Performance", () => {
  test("fetches feed in under 500ms", async () => {
    const start = Date.now();
    const feed = await signalService.getPersonalizedFeed({
      userId,
      workspaceId,
      limit: 20,
    });
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(500);
    expect(feed.items).toHaveLength(20);
  });

  test("scales to 1000 signal items", async () => {
    // Create 1000 signal items
    await createManySignalItems(1000);

    const feed = await signalService.getPersonalizedFeed({
      userId,
      workspaceId,
      limit: 50,
    });

    expect(feed.items).toHaveLength(50);
    expect(feed.hasMore).toBe(true);
  });
});
```

## Security Considerations

### Property Validation

```typescript
function validateSignalProperties(properties: Record<string, any>) {
  // Required fields
  if (!properties.sourcePlatform) {
    throw new Error("sourcePlatform is required");
  }

  // Enum validation
  const validPlatforms = ["twitter", "reddit" /* ... */];
  if (!validPlatforms.includes(properties.sourcePlatform)) {
    throw new Error(`Invalid platform: ${properties.sourcePlatform}`);
  }

  // URL validation
  if (properties.url && !isValidUrl(properties.url)) {
    throw new Error("Invalid URL");
  }

  // Data size limits
  if (JSON.stringify(properties.rawData).length > 1000000) {
    throw new Error("Raw data too large (max 1MB)");
  }
}
```

### Privacy Controls

```typescript
// User can control what signal data is stored
interface SignalPrivacySettings {
  storeRawData: boolean; // Default: true
  storeAIMetadata: boolean; // Default: true
  autoLinkEntities: boolean; // Default: true
  trackEngagement: boolean; // Default: true
  shareClassifications: boolean; // Default: false (pod-only)

  // Retention policies
  rawDataRetentionDays: number; // Default: 90
  engagementRetentionDays: number; // Default: 30
}
```

## Future Enhancements

### 1. Advanced Topic Modeling

- Hierarchical topics (ai.machine_learning.deep_learning)
- Dynamic topic discovery (clustering)
- Cross-lingual topic mapping

### 2. Relationship Inference

- Signal → signal relationships (threads, conversations)
- Temporal relationships (cause/effect, trends)
- Network analysis (influence graphs)

### 3. Quality Metrics

- Source reliability scoring
- Content quality assessment
- Bias detection and labeling

### 4. Advanced Search

- Semantic search over signal content
- Trend detection and alerts
- Cross-entity correlation search

---

_Last updated: 2026-04-12_
_Owner: Data Model Team_
_Status: Ready for Implementation_
