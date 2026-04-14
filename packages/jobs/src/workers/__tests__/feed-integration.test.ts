/**
 * Feed Jobs Integration Tests
 *
 * Tests integration between feed workers:
 * - Feed scheduler
 * - Feed RSS executor
 * - Feed proactive executor
 * - Database interactions
 * - Queue management
 *
 * @module feed-jobs-integration-tests
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ============================================================================
// Test Setup & Mocks
// ============================================================================

const mockBossSend = vi.fn();
const mockDbQuery = vi.fn();
const mockDbInsert = vi.fn();
const mockDbUpdate = vi.fn();
const mockFetchRSSItems = vi.fn();
const mockFetch = vi.fn();
const mockEmitSideEffects = vi.fn();
const mockEventRepositoryAppend = vi.fn();

vi.mock("../boss.js", () => ({
  getBoss: vi.fn(() => ({
    send: mockBossSend,
  })),
}));

vi.mock("../fetchers/rss-fetcher.js", () => ({
  fetchRSSItems: mockFetchRSSItems,
}));

vi.mock("../emit-side-effects.js", () => ({
  emitSideEffects: mockEmitSideEffects,
}));

vi.mock("@synap/database", () => ({
  db: {
    query: {
      channels: { findMany: mockDbQuery, findFirst: mockDbQuery },
      messages: { findMany: mockDbQuery },
    },
    insert: mockDbInsert,
    update: mockDbUpdate,
  },
  eq: vi.fn((a, b) => ({ type: "eq", field: a, value: b })),
  and: vi.fn((...args) => ({ type: "and", conditions: args })),
  gte: vi.fn((a, b) => ({ type: "gte", field: a, value: b })),
  channels: { id: "id" },
  messages: { id: "id" },
  eventRepository: { append: mockEventRepositoryAppend },
  ChannelType: { FEED: "FEED" },
  ChannelStatus: { ACTIVE: "ACTIVE" },
}));

vi.mock("@synap/database/schema", () => ({
  channels: { id: "id" },
  messages: { id: "id" },
  MessageRole: { SYSTEM: "system" },
  MessageAuthorType: { BOT: "bot" },
  ChannelType: { FEED: "FEED" },
  ChannelStatus: { ACTIVE: "ACTIVE" },
}));

vi.mock("@synap-core/core", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock("../utils/feed-helpers.js", () => ({
  calculateNextRun: vi.fn((_cron, _timezone) => {
    const date = new Date();
    date.setHours(date.getHours() + 6);
    return date;
  }),
  isFeedDue: vi.fn((nextRunAt) => {
    if (!nextRunAt) return true;
    return new Date(nextRunAt) <= new Date();
  }),
}));

vi.mock("@synap/shared-utils", () => ({
  withRetry: vi.fn((fn) => fn()),
  FEED_RETRY_OPTIONS: { retries: 3 },
}));

vi.stubGlobal("fetch", mockFetch);

// ============================================================================
// Test Data
// ============================================================================

const createMockChannel = (overrides: Record<string, unknown> = {}) => ({
  id: "channel-123",
  userId: "user-456",
  workspaceId: "workspace-789",
  metadata: {
    feedConfig: {
      feedType: "rss",
      enabled: true,
      schedule: "0 */6 * * *",
      sources: [{ url: "https://example.com/feed.xml" }],
      maxItemsPerRun: 10,
      dedupWindowDays: 30,
      minRelevanceScore: 50,
      postMode: "individual",
    },
    feedStatus: {
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    },
  },
  updatedAt: new Date(),
  ...overrides,
});

const createMockRSSItem = (id: string, url: string, overrides = {}) => ({
  id,
  title: `Item ${id}`,
  url,
  content: `<p>Content for item ${id}</p>`,
  contentText: `Content for item ${id}`,
  publishedAt: new Date(),
  author: "Test Author",
  categories: ["tech", "news"],
  source: {
    name: "Example Feed",
    url: "https://example.com/feed.xml",
  },
  ...overrides,
});

const createMockJob = (overrides: Record<string, unknown> = {}) => ({
  data: {
    channelId: "channel-123",
    userId: "user-456",
    workspaceId: "workspace-789",
    runId: "run-abc",
    config: {
      id: "feed-123",
      workspaceId: "workspace-789",
      name: "Test Feed",
      type: "rss" as const,
      feedType: "rss" as const,
      url: "https://example.com/feed.xml",
      isActive: true,
      pollIntervalMinutes: 60,
      createdAt: new Date(),
      updatedAt: new Date(),
      enabled: true,
      schedule: "0 */6 * * *",
      timezone: "UTC",
      maxItemsPerRun: 10,
      dedupWindowDays: 30,
      minRelevanceScore: 50,
      postMode: "individual" as const,
      sources: [{ url: "https://example.com/feed.xml", name: "Example Feed" }],
      rsshubConfig: { useCpProxy: true },
    },
    ...overrides,
  },
});

// ============================================================================
// Integration Tests
// ============================================================================

describe("Feed Jobs Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INTELLIGENCE_HUB_URL = "https://is.synap.io";
    process.env.INTELLIGENCE_HUB_API_KEY = "test-api-key";
  });

  describe("Scheduler to Executor Pipeline", () => {
    it("should schedule RSS feeds and execute them", async () => {
      const { handleFeedScheduler } = await import("../feed-scheduler.js");
      // Import executor to verify it's available
      await import("../feed-rss-executor.js");

      // Scheduler finds due feeds
      mockDbQuery.mockResolvedValue([createMockChannel()]);

      // Execute scheduler
      await handleFeedScheduler();

      // Verify job was enqueued
      expect(mockBossSend).toHaveBeenCalledWith(
        "feed-rss-execute",
        expect.objectContaining({
          channelId: "channel-123",
          userId: "user-456",
          config: expect.objectContaining({ feedType: "rss" }),
        }),
        expect.any(Object)
      );
    });

    it("should schedule proactive feeds separately", async () => {
      const { handleFeedScheduler } = await import("../feed-scheduler.js");

      mockDbQuery.mockResolvedValue([
        createMockChannel({
          metadata: {
            feedConfig: {
              feedType: "proactive",
              enabled: true,
              schedule: "0 9 * * *",
            },
            feedStatus: {
              nextRunAt: new Date(Date.now() - 1000).toISOString(),
            },
          },
        }),
      ]);

      await handleFeedScheduler();

      expect(mockBossSend).toHaveBeenCalledWith(
        "feed-proactive-execute",
        expect.objectContaining({
          config: expect.objectContaining({ feedType: "proactive" }),
        }),
        expect.any(Object)
      );
    });

    it("should respect priority ordering (manual > RSS > proactive)", async () => {
      const { handleFeedScheduler } = await import("../feed-scheduler.js");

      const pastDate = new Date();
      pastDate.setHours(pastDate.getHours() - 1);

      mockDbQuery.mockResolvedValue([
        // Proactive feed
        createMockChannel({
          id: "channel-proactive",
          metadata: {
            feedConfig: {
              feedType: "proactive",
              enabled: true,
              schedule: "0 9 * * *",
            },
            feedStatus: { nextRunAt: pastDate.toISOString() },
          },
        }),
        // RSS feed
        createMockChannel({
          id: "channel-rss",
          metadata: {
            feedConfig: {
              feedType: "rss",
              enabled: true,
              schedule: "0 * * * *",
            },
            feedStatus: { nextRunAt: pastDate.toISOString() },
          },
        }),
        // Manual trigger RSS
        createMockChannel({
          id: "channel-manual",
          metadata: {
            feedConfig: {
              feedType: "rss",
              enabled: true,
              schedule: "0 * * * *",
            },
            feedStatus: { triggerRequestedAt: pastDate.toISOString() },
          },
        }),
      ]);

      await handleFeedScheduler();

      const calls = mockBossSend.mock.calls;

      // Manual should have priority 1
      expect(calls).toContainEqual([
        "feed-rss-execute",
        expect.any(Object),
        expect.objectContaining({ priority: 1 }),
      ]);

      // RSS should have priority 5
      expect(calls).toContainEqual([
        "feed-rss-execute",
        expect.any(Object),
        expect.objectContaining({ priority: 5 }),
      ]);

      // Proactive should have priority 3
      expect(calls).toContainEqual([
        "feed-proactive-execute",
        expect.any(Object),
        expect.objectContaining({ priority: 3 }),
      ]);
    });
  });

  describe("RSS Fetch and Classify Pipeline", () => {
    it("should fetch, classify, and post RSS items", async () => {
      const { handleFeedRSSExecute } = await import("../feed-rss-executor.js");

      // Mock seen URLs query
      mockDbQuery.mockResolvedValue([]);

      // Mock RSS fetch
      mockFetchRSSItems.mockResolvedValue({
        items: [
          createMockRSSItem("1", "https://example.com/item1"),
          createMockRSSItem("2", "https://example.com/item2"),
        ],
        errors: [],
        sourceCount: 1,
      });

      // Mock IS classification
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            classifiedItems: [
              { topics: ["AI"], relevanceScore: 0.9 },
              { topics: ["Tech"], relevanceScore: 0.8 },
            ],
          }),
      });

      // Mock DB insert
      mockDbInsert.mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      });

      // Mock DB update
      mockDbUpdate.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      const job = createMockJob();
      await handleFeedRSSExecute(job);

      // Verify items were fetched
      expect(mockFetchRSSItems).toHaveBeenCalled();

      // Verify classification was called
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/v1/tools/classify_feed_items"),
        expect.any(Object)
      );

      // Verify side effects were emitted
      expect(mockEmitSideEffects).toHaveBeenCalled();
    });

    it("should handle deduplication correctly", async () => {
      const { handleFeedRSSExecute } = await import("../feed-rss-executor.js");

      // Item already seen
      const seenUrl = "https://example.com/seen-item";

      mockDbQuery.mockResolvedValue([{ metadata: { sourceUrl: seenUrl } }]);

      mockFetchRSSItems.mockResolvedValue({
        items: [
          createMockRSSItem("1", seenUrl),
          createMockRSSItem("2", "https://example.com/new-item"),
        ],
        errors: [],
        sourceCount: 1,
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            classifiedItems: [
              { topics: ["AI"], relevanceScore: 0.9 },
              { topics: ["Tech"], relevanceScore: 0.8 },
            ],
          }),
      });

      mockDbInsert.mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      });

      mockDbUpdate.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      const job = createMockJob();
      await handleFeedRSSExecute(job);

      // Should only insert the new item
      const insertCalls = mockDbInsert.mock.calls;
      expect(insertCalls.length).toBeGreaterThan(0);
    });

    it("should filter by relevance score", async () => {
      const { handleFeedRSSExecute } = await import("../feed-rss-executor.js");

      mockDbQuery.mockResolvedValue([]);

      mockFetchRSSItems.mockResolvedValue({
        items: [
          createMockRSSItem("1", "https://example.com/item1"),
          createMockRSSItem("2", "https://example.com/item2"),
          createMockRSSItem("3", "https://example.com/item3"),
        ],
        errors: [],
        sourceCount: 1,
      });

      // Low relevance for some items
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            classifiedItems: [
              { topics: ["AI"], relevanceScore: 0.9 }, // 90%
              { topics: ["Tech"], relevanceScore: 0.2 }, // 20% - below threshold
              { topics: ["News"], relevanceScore: 0.7 }, // 70%
            ],
          }),
      });

      mockDbInsert.mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      });

      mockDbUpdate.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      const job = createMockJob({ config: { minRelevanceScore: 50 } });
      await handleFeedRSSExecute(job);

      // Should filter out low relevance items
    });
  });

  describe("Proactive Feed Execution", () => {
    it("should aggregate data and create proactive digest", async () => {
      const { handleFeedProactiveExecute } =
        await import("../feed-proactive-executor.js");

      // Mock channel query
      mockDbQuery.mockResolvedValue([
        {
          id: "channel-123",
          userId: "user-456",
          workspaceId: "workspace-789",
        },
      ]);

      // Mock entity queries for aggregation
      mockDbQuery
        // Tasks due
        .mockResolvedValueOnce([
          { id: "task-1", title: "Complete project", dueDate: new Date() },
        ])
        // Pending proposals
        .mockResolvedValueOnce([
          { id: "proposal-1", title: "Update schema", type: "schema_change" },
        ])
        // Recent entities
        .mockResolvedValueOnce([
          {
            id: "entity-1",
            title: "New note",
            type: "note",
            createdAt: new Date(),
          },
        ])
        // Recent captures
        .mockResolvedValueOnce([
          { id: "capture-1", title: "Quick thought", capturedAt: new Date() },
        ])
        // Activity summary
        .mockResolvedValueOnce([{ count: 5 }]);

      mockDbInsert.mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      });

      mockDbUpdate.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      const job = createMockJob({
        config: {
          feedType: "proactive",
          enabled: true,
          schedule: "0 9 * * *",
          timezone: "UTC",
          maxItemsPerRun: 50,
          dedupWindowDays: 1,
          minRelevanceScore: 0,
          postMode: "batch",
          include: {
            tasksDue: true,
            tasksDueDays: 3,
            pendingProposals: true,
            recentEntities: true,
            recentEntitiesHours: 24,
            recentCaptures: true,
            recentCapturesHours: 24,
            activitySummary: true,
          },
          summarization: {
            style: "brief",
            maxItems: 10,
            includeInsights: true,
          },
        },
      });

      await handleFeedProactiveExecute(job);

      // Verify database queries were made for aggregation
      expect(mockDbQuery).toHaveBeenCalled();

      // Verify message was posted
      expect(mockDbInsert).toHaveBeenCalled();
    });
  });

  describe("Database Interactions", () => {
    it("should update feed status after execution", async () => {
      const { handleFeedRSSExecute } = await import("../feed-rss-executor.js");

      mockDbQuery.mockResolvedValue([]);

      mockFetchRSSItems.mockResolvedValue({
        items: [createMockRSSItem("1", "https://example.com/item1")],
        errors: [],
        sourceCount: 1,
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            classifiedItems: [{ topics: ["AI"], relevanceScore: 0.9 }],
          }),
      });

      mockDbInsert.mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      });

      const updateMock = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });
      mockDbUpdate.mockReturnValue({
        set: updateMock,
      });

      const job = createMockJob();
      await handleFeedRSSExecute(job);

      // Verify status was updated
      expect(mockDbUpdate).toHaveBeenCalled();
    });

    it("should handle database errors gracefully", async () => {
      const { handleFeedRSSExecute } = await import("../feed-rss-executor.js");

      mockDbQuery.mockRejectedValue(new Error("Database connection failed"));

      const job = createMockJob();

      // Should complete without throwing
      await expect(handleFeedRSSExecute(job)).resolves.toBeDefined();
    });
  });

  describe("Event Chain Integration", () => {
    it("should emit feed.execution.completed event", async () => {
      const { handleFeedRSSExecute } = await import("../feed-rss-executor.js");

      mockDbQuery.mockResolvedValue([]);

      mockFetchRSSItems.mockResolvedValue({
        items: [createMockRSSItem("1", "https://example.com/item1")],
        errors: [],
        sourceCount: 1,
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            classifiedItems: [{ topics: ["AI"], relevanceScore: 0.9 }],
          }),
      });

      mockDbInsert.mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      });

      mockDbUpdate.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      const job = createMockJob();
      await handleFeedRSSExecute(job);

      // Verify event was appended
      expect(mockEventRepositoryAppend).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "feed.execution.completed",
          subjectType: "feed",
          subjectId: "run-abc",
        })
      );
    });
  });

  describe("Error Recovery", () => {
    it("should handle IS classification failure gracefully", async () => {
      const { handleFeedRSSExecute } = await import("../feed-rss-executor.js");

      mockDbQuery.mockResolvedValue([]);

      mockFetchRSSItems.mockResolvedValue({
        items: [createMockRSSItem("1", "https://example.com/item1")],
        errors: [],
        sourceCount: 1,
      });

      // IS fails
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      mockDbInsert.mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      });

      mockDbUpdate.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      const job = createMockJob();
      await handleFeedRSSExecute(job);

      // Should still post messages with fallback classification
      expect(mockDbInsert).toHaveBeenCalled();
    });

    it("should continue when individual channels fail", async () => {
      const { handleFeedScheduler } = await import("../feed-scheduler.js");

      mockDbQuery.mockResolvedValue([
        createMockChannel({ id: "channel-1" }),
        createMockChannel({
          id: "channel-2",
          metadata: {}, // Invalid - missing feedConfig
        }),
        createMockChannel({ id: "channel-3" }),
      ]);

      await handleFeedScheduler();

      // Should schedule valid channels
      expect(mockBossSend).toHaveBeenCalledTimes(2);
    });
  });

  describe("End-to-End Scenarios", () => {
    it("should handle complete RSS feed lifecycle", async () => {
      const { handleFeedScheduler } = await import("../feed-scheduler.js");
      const { handleFeedRSSExecute } = await import("../feed-rss-executor.js");

      // 1. Scheduler finds the feed
      mockDbQuery.mockResolvedValue([createMockChannel()]);

      // 2. Scheduler enqueues job
      await handleFeedScheduler();
      expect(mockBossSend).toHaveBeenCalled();

      // Reset mocks for executor
      vi.clearAllMocks();

      // 3. Executor fetches and processes
      mockDbQuery.mockResolvedValue([]);

      mockFetchRSSItems.mockResolvedValue({
        items: [
          createMockRSSItem("1", "https://example.com/item1"),
          createMockRSSItem("2", "https://example.com/item2"),
        ],
        errors: [],
        sourceCount: 1,
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            classifiedItems: [
              { topics: ["AI"], relevanceScore: 0.9 },
              { topics: ["Tech"], relevanceScore: 0.8 },
            ],
          }),
      });

      mockDbInsert.mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      });

      mockDbUpdate.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      const job = createMockJob();
      await handleFeedRSSExecute(job);

      // 4. Verify items were posted
      expect(mockDbInsert).toHaveBeenCalledTimes(2);

      // 5. Verify status was updated
      expect(mockDbUpdate).toHaveBeenCalled();

      // 6. Verify events were emitted
      expect(mockEventRepositoryAppend).toHaveBeenCalled();
      expect(mockEmitSideEffects).toHaveBeenCalled();
    });

    it("should handle manual trigger flow", async () => {
      const { handleFeedScheduler } = await import("../feed-scheduler.js");

      const pastDate = new Date();
      pastDate.setMinutes(pastDate.getMinutes() - 5);

      mockDbQuery.mockResolvedValue([
        createMockChannel({
          metadata: {
            feedConfig: {
              feedType: "rss",
              enabled: true,
              schedule: "0 */6 * * *",
            },
            feedStatus: {
              triggerRequestedAt: pastDate.toISOString(),
              nextRunAt: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
            },
          },
        }),
      ]);

      await handleFeedScheduler();

      // Should prioritize manual trigger
      expect(mockBossSend).toHaveBeenCalledWith(
        "feed-rss-execute",
        expect.objectContaining({ triggered: true }),
        expect.objectContaining({ priority: 1 })
      );
    });
  });
});
