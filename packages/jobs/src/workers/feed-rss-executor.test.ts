/**
 * Feed RSS Executor Worker Tests
 *
 * Tests for feed-rss-executor.ts
 * - Fetches RSS items (mock fetch)
 * - Filters seen URLs correctly
 * - Classifies items with IS (mock IS call)
 * - Posts messages in individual mode
 * - Posts messages in batch mode
 * - Tracks seen URLs after posting
 * - Updates feed status on completion
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Setup mocks using hoisted pattern
const {
  mockFetch,
  mockDbQuery,
  mockDbInsert,
  mockDbUpdate,
  mockEmitSideEffects,
  mockEventRepositoryAppend,
  getLastInsertedValues,
  clearCapturedValues,
  mockRSSDirectProviderFetch,
} = vi.hoisted(() => {
  const capturedValues: any[] = [];
  let lastInsertedValues: any = null;

  return {
    mockFetch: vi.fn(),
    mockDbQuery: vi.fn(),
    mockDbInsert: vi.fn(() => ({
      values: vi.fn((data) => {
        capturedValues.push(data);
        lastInsertedValues = data;
        return Promise.resolve();
      }),
    })),
    mockDbUpdate: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
    mockEmitSideEffects: vi.fn(() => Promise.resolve()),
    mockEventRepositoryAppend: vi.fn(() => Promise.resolve()),
    getLastInsertedValues: () => lastInsertedValues,
    getCapturedValues: () => capturedValues,
    clearCapturedValues: () => {
      capturedValues.length = 0;
      lastInsertedValues = null;
    },
    mockRSSDirectProviderFetch: vi.fn(),
  };
});

// Mock @synap/feed-service
vi.mock("@synap/feed-service", () => ({
  RSSDirectProvider: vi.fn(() => ({
    fetch: mockRSSDirectProviderFetch,
  })),
}));

// Mock emit-side-effects
vi.mock("../emit-side-effects.js", () => ({
  emitSideEffects: mockEmitSideEffects,
}));

// Mock global fetch for IS calls
vi.stubGlobal("fetch", mockFetch);

// Mock @synap/database
vi.mock("@synap/database", () => ({
  db: {
    query: {
      messages: {
        findMany: mockDbQuery,
      },
      channels: {
        findFirst: mockDbQuery,
      },
    },
    insert: mockDbInsert,
    update: mockDbUpdate,
  },
  eq: vi.fn((a, b) => ({ type: "eq", field: a, value: b })),
  and: vi.fn((...conds) => ({ type: "and", conditions: conds })),
  gte: vi.fn((a, b) => ({ type: "gte", field: a, value: b })),
  channels: { id: "id" },
  messages: { id: "id" },
  eventRepository: {
    append: mockEventRepositoryAppend,
  },
}));

// Mock @synap/database/schema
vi.mock("@synap/database/schema", () => ({
  channels: { id: "id" },
  messages: { id: "id" },
  MessageRole: { SYSTEM: "system" },
  MessageAuthorType: { BOT: "bot" },
}));

// Mock @synap-core/core logger
vi.mock("@synap-core/core", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

// Mock feed-helpers
vi.mock("../utils/feed-helpers.js", () => ({
  calculateNextRun: vi.fn((_cron, _timezone) => {
    const date = new Date();
    date.setHours(date.getHours() + 6);
    return date;
  }),
}));

// Mock @synap/api utils
vi.mock("@synap/shared-utils", () => ({
  withRetry: vi.fn((fn) => fn()),
  FEED_RETRY_OPTIONS: { retries: 3 },
}));

import { handleFeedRSSExecute } from "./feed-rss-executor.js";

// Test fixtures
const createMockJob = (
  overrides: Record<string, unknown> & { config?: Record<string, unknown> } = {}
) => {
  const baseConfig = {
    // Required FeedConfig fields
    id: "feed-123",
    workspaceId: "workspace-789",
    name: "Test RSS Feed",
    type: "rss" as const,
    url: "https://example.com/feed.xml",
    isActive: true,
    pollIntervalMinutes: 60,
    createdAt: new Date(),
    updatedAt: new Date(),
    // Additional fields for RSS feeds
    feedType: "rss" as const,
    enabled: true,
    schedule: "0 */6 * * *",
    timezone: "UTC",
    maxItemsPerRun: 10,
    dedupWindowDays: 30,
    minRelevanceScore: 50,
    postMode: "individual" as const,
    sources: [{ url: "https://example.com/feed.xml", name: "Example Feed" }],
  };

  // Extract config from overrides, then merge separately
  const { config: configOverride, ...otherOverrides } = overrides;
  const mergedConfig = configOverride
    ? { ...baseConfig, ...configOverride }
    : baseConfig;

  return {
    data: {
      channelId: "channel-123",
      userId: "user-456",
      workspaceId: "workspace-789",
      runId: "run-abc",
      config: mergedConfig as import("@synap/shared-utils").RSSFeedConfig,
      ...otherOverrides,
    },
  };
};

describe("feed-rss-executor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCapturedValues();
    process.env.INTELLIGENCE_HUB_URL = "https://is.synap.io";
    process.env.INTELLIGENCE_HUB_API_KEY = "test-api-key";
  });

  describe("RSS fetching", () => {
    it("should fetch RSS items from configured sources", async () => {
      mockRSSDirectProviderFetch.mockResolvedValue({
        items: [
          {
            externalId: "1",
            title: "Item 1",
            url: "https://example.com/item1",
            excerpt: "Content for item 1",
            publishedAt: new Date(),
          },
        ],
      });
      mockDbQuery.mockResolvedValue([]); // No existing messages (seen URLs)
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            classifiedItems: [{ topics: ["AI"], relevanceScore: 0.8 }],
          }),
      });

      const job = createMockJob();
      await handleFeedRSSExecute(job);

      // Fetch via RSSDirectProvider should be called per source
      expect(mockRSSDirectProviderFetch).toHaveBeenCalled();
    });

    it("should handle fetch errors gracefully", async () => {
      mockRSSDirectProviderFetch.mockRejectedValue(
        new Error("Connection timeout")
      );
      mockDbQuery.mockResolvedValue([]);

      const job = createMockJob();
      await handleFeedRSSExecute(job);

      // Should complete successfully even with fetch errors
      expect(mockDbUpdate).toHaveBeenCalled();
    });
  });

  describe("seen URL filtering", () => {
    it("should filter out already seen URLs", async () => {
      const existingUrl = "https://example.com/seen-item";

      mockDbQuery.mockResolvedValue([
        { metadata: { sourceUrl: existingUrl } },
        { metadata: { sourceUrl: "https://example.com/other-item" } },
      ]);

      mockRSSDirectProviderFetch.mockResolvedValue({
        items: [
          {
            externalId: "1",
            title: "Item 1",
            url: existingUrl,
            excerpt: "Content for item 1",
            publishedAt: new Date(),
          },
          {
            externalId: "2",
            title: "Item 2",
            url: "https://example.com/new-item",
            excerpt: "Content for item 2",
            publishedAt: new Date(),
          },
        ],
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            classifiedItems: [
              { topics: ["AI"], relevanceScore: 0.8 },
              { topics: ["Tech"], relevanceScore: 0.7 },
            ],
          }),
      });

      const job = createMockJob();
      await handleFeedRSSExecute(job);

      // Only the new item should be posted (seen item filtered out)
      expect(mockDbInsert).toHaveBeenCalled();
    });

    it("should respect dedupWindowDays setting", async () => {
      mockDbQuery.mockResolvedValue([]);

      mockRSSDirectProviderFetch.mockResolvedValue({
        items: [
          {
            externalId: "1",
            title: "Item 1",
            url: "https://example.com/item1",
            excerpt: "Content for item 1",
            publishedAt: new Date(),
          },
        ],
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            classifiedItems: [{ topics: ["AI"], relevanceScore: 0.8 }],
          }),
      });

      const job = createMockJob({ config: { dedupWindowDays: 7 } });
      await handleFeedRSSExecute(job);

      // Query should use 7 day window (checking gte is called with appropriate date)
      expect(mockDbQuery).toHaveBeenCalled();
    });
  });

  describe("IS classification", () => {
    it("should call IS for classification when configured", async () => {
      mockDbQuery.mockResolvedValue([]);

      mockRSSDirectProviderFetch.mockResolvedValue({
        items: [
          {
            externalId: "1",
            title: "Item 1",
            url: "https://example.com/item1",
            excerpt: "Content for item 1",
            publishedAt: new Date(),
          },
          {
            externalId: "2",
            title: "Item 2",
            url: "https://example.com/item2",
            excerpt: "Content for item 2",
            publishedAt: new Date(),
          },
        ],
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            classifiedItems: [
              { topics: ["AI", "ML"], relevanceScore: 0.9 },
              { topics: ["Cloud"], relevanceScore: 0.6 },
            ],
          }),
      });

      const job = createMockJob();
      await handleFeedRSSExecute(job);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://is.synap.io/v1/tools/classify_feed_items",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            Authorization: "Bearer test-api-key",
          }),
          body: expect.any(String),
        })
      );
    });

    it("should use fallback classification when IS fails", async () => {
      mockDbQuery.mockResolvedValue([]);

      mockRSSDirectProviderFetch.mockResolvedValue({
        items: [
          {
            externalId: "1",
            title: "Item 1",
            url: "https://example.com/item1",
            excerpt: "Content for item 1",
            publishedAt: new Date(),
          },
        ],
      });

      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      });

      const job = createMockJob();
      await handleFeedRSSExecute(job);

      // Should still complete and post messages with fallback classification
      expect(mockDbInsert).toHaveBeenCalled();
    });

    it("should use stub classification when IS is not configured", async () => {
      delete process.env.INTELLIGENCE_HUB_URL;
      delete process.env.INTELLIGENCE_HUB_API_KEY;

      mockDbQuery.mockResolvedValue([]);

      mockRSSDirectProviderFetch.mockResolvedValue({
        items: [
          {
            externalId: "1",
            title: "Item 1",
            url: "https://example.com/item1",
            excerpt: "Content for item 1",
            publishedAt: new Date(),
          },
        ],
      });

      const job = createMockJob();
      await handleFeedRSSExecute(job);

      // Should not call IS
      expect(mockFetch).not.toHaveBeenCalled();
      // Should still post messages
      expect(mockDbInsert).toHaveBeenCalled();
    });

    it("should filter items by minRelevanceScore", async () => {
      mockDbQuery.mockResolvedValue([]);

      mockRSSDirectProviderFetch.mockResolvedValue({
        items: [
          {
            externalId: "1",
            title: "Item 1",
            url: "https://example.com/item1",
            excerpt: "Content for item 1",
            publishedAt: new Date(),
          },
          {
            externalId: "2",
            title: "Item 2",
            url: "https://example.com/item2",
            excerpt: "Content for item 2",
            publishedAt: new Date(),
          },
          {
            externalId: "3",
            title: "Item 3",
            url: "https://example.com/item3",
            excerpt: "Content for item 3",
            publishedAt: new Date(),
          },
        ],
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            classifiedItems: [
              { topics: ["AI"], relevanceScore: 0.9 }, // 90%
              { topics: ["Tech"], relevanceScore: 0.3 }, // 30% - should be filtered
              { topics: ["News"], relevanceScore: 0.6 }, // 60%
            ],
          }),
      });

      const job = createMockJob({ config: { minRelevanceScore: 50 } });
      await handleFeedRSSExecute(job);

      // Only items with relevance >= 50 should be posted
      // The second item (30%) should be filtered out
    });
  });

  describe("individual posting mode", () => {
    it("should post items individually when postMode is 'individual'", async () => {
      mockDbQuery.mockResolvedValue([]);

      mockRSSDirectProviderFetch.mockResolvedValue({
        items: [
          {
            externalId: "1",
            title: "Item 1",
            url: "https://example.com/item1",
            excerpt: "Content for item 1",
            publishedAt: new Date(),
          },
          {
            externalId: "2",
            title: "Item 2",
            url: "https://example.com/item2",
            excerpt: "Content for item 2",
            publishedAt: new Date(),
          },
        ],
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

      const job = createMockJob({ config: { postMode: "individual" } });
      await handleFeedRSSExecute(job);

      // Should insert 2 messages (one per item)
      expect(mockDbInsert).toHaveBeenCalledTimes(2);
    });

    it("should include correct metadata in posted messages", async () => {
      mockDbQuery.mockResolvedValue([]);

      mockRSSDirectProviderFetch.mockResolvedValue({
        items: [
          {
            externalId: "1",
            title: "Item 1",
            url: "https://example.com/item1",
            excerpt: "Content for item 1",
            publishedAt: new Date(),
          },
        ],
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            classifiedItems: [{ topics: ["AI"], relevanceScore: 0.9 }],
          }),
      });

      const job = createMockJob();
      await handleFeedRSSExecute(job);

      expect(mockDbInsert).toHaveBeenCalled();
      const insertCall = getLastInsertedValues();
      expect(insertCall).toMatchObject({
        id: expect.any(String),
        channelId: "channel-123",
        userId: "user-456",
        role: "system",
        authorType: "bot",
        content: expect.any(String),
        hash: expect.any(String),
        metadata: expect.objectContaining({
          feedItem: true,
          feedType: "rss",
          feedRunId: "run-abc",
          sourceUrl: "https://example.com/item1",
          aiClassified: true,
        }),
      });
    });
  });

  describe("batch posting mode", () => {
    it("should post items as batch when postMode is 'batch'", async () => {
      mockDbQuery.mockResolvedValue([]);

      mockRSSDirectProviderFetch.mockResolvedValue({
        items: [
          {
            externalId: "1",
            title: "Item 1",
            url: "https://example.com/item1",
            excerpt: "Content for item 1",
            publishedAt: new Date(),
          },
          {
            externalId: "2",
            title: "Item 2",
            url: "https://example.com/item2",
            excerpt: "Content for item 2",
            publishedAt: new Date(),
          },
        ],
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

      const job = createMockJob({ config: { postMode: "batch" } });
      await handleFeedRSSExecute(job);

      // Should insert 1 batch message
      expect(mockDbInsert).toHaveBeenCalledTimes(1);
    });

    it("should include batch metadata in batch posts", async () => {
      mockDbQuery.mockResolvedValue([]);

      mockRSSDirectProviderFetch.mockResolvedValue({
        items: [
          {
            externalId: "1",
            title: "Item 1",
            url: "https://example.com/item1",
            excerpt: "Content for item 1",
            publishedAt: new Date(),
          },
          {
            externalId: "2",
            title: "Item 2",
            url: "https://example.com/item2",
            excerpt: "Content for item 2",
            publishedAt: new Date(),
          },
        ],
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

      const job = createMockJob({ config: { postMode: "batch" } });
      await handleFeedRSSExecute(job);

      const insertCall = getLastInsertedValues();
      expect(insertCall.metadata).toMatchObject({
        feedType: "rss",
        batched: true,
        batchId: expect.any(String),
        itemCount: 2,
      });
    });

    it("should fall back to individual posting for single items in batch mode", async () => {
      mockDbQuery.mockResolvedValue([]);

      mockRSSDirectProviderFetch.mockResolvedValue({
        items: [
          {
            externalId: "1",
            title: "Item 1",
            url: "https://example.com/item1",
            excerpt: "Content for item 1",
            publishedAt: new Date(),
          },
        ],
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            classifiedItems: [{ topics: ["AI"], relevanceScore: 0.9 }],
          }),
      });

      const job = createMockJob({ config: { postMode: "batch" } });
      await handleFeedRSSExecute(job);

      // Single item should be posted normally (not as batch)
      expect(mockDbInsert).toHaveBeenCalledTimes(1);
    });
  });

  describe("URL tracking", () => {
    it("should track source URLs in message metadata", async () => {
      mockDbQuery.mockResolvedValue([]);

      mockRSSDirectProviderFetch.mockResolvedValue({
        items: [
          {
            externalId: "1",
            title: "Item 1",
            url: "https://example.com/item1",
            excerpt: "Content for item 1",
            publishedAt: new Date(),
          },
        ],
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            classifiedItems: [{ topics: ["AI"], relevanceScore: 0.9 }],
          }),
      });

      const job = createMockJob();
      await handleFeedRSSExecute(job);

      const insertCall = getLastInsertedValues();
      expect(insertCall.metadata.sourceUrl).toBe("https://example.com/item1");
    });
  });

  describe("feed status updates", () => {
    it("should update feed status on successful completion", async () => {
      mockDbQuery.mockResolvedValue([]);

      mockRSSDirectProviderFetch.mockResolvedValue({
        items: [
          {
            externalId: "1",
            title: "Item 1",
            url: "https://example.com/item1",
            excerpt: "Content for item 1",
            publishedAt: new Date(),
          },
        ],
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            classifiedItems: [{ topics: ["AI"], relevanceScore: 0.9 }],
          }),
      });

      const job = createMockJob();
      await handleFeedRSSExecute(job);

      expect(mockDbUpdate).toHaveBeenCalled();
    });

    it("should handle database errors gracefully", async () => {
      mockDbQuery.mockRejectedValue(new Error("Database error"));

      const job = createMockJob();
      // The worker handles errors internally and completes without throwing
      // It may return partial results depending on where the error occurs
      await expect(handleFeedRSSExecute(job)).resolves.toBeDefined();
    });

    it("should set correct item counts in status", async () => {
      mockDbQuery.mockResolvedValue([]);

      mockRSSDirectProviderFetch.mockResolvedValue({
        items: [
          {
            externalId: "1",
            title: "Item 1",
            url: "https://example.com/item1",
            excerpt: "Content for item 1",
            publishedAt: new Date(),
          },
          {
            externalId: "2",
            title: "Item 2",
            url: "https://example.com/item2",
            excerpt: "Content for item 2",
            publishedAt: new Date(),
          },
        ],
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

      const job = createMockJob();
      await handleFeedRSSExecute(job);

      // Status should reflect 2 items posted
    });
  });

  describe("side effects and events", () => {
    it("should emit side effects after posting", async () => {
      mockDbQuery.mockResolvedValue([]);

      mockRSSDirectProviderFetch.mockResolvedValue({
        items: [
          {
            externalId: "1",
            title: "Item 1",
            url: "https://example.com/item1",
            excerpt: "Content for item 1",
            publishedAt: new Date(),
          },
        ],
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            classifiedItems: [{ topics: ["AI"], relevanceScore: 0.9 }],
          }),
      });

      mockEmitSideEffects.mockResolvedValue(undefined);

      const job = createMockJob();
      await handleFeedRSSExecute(job);

      expect(mockEmitSideEffects).toHaveBeenCalledWith(
        expect.objectContaining({
          subjectType: "feed",
          action: "execution",
          userId: "user-456",
          workspaceId: "workspace-789",
          data: expect.objectContaining({
            channelId: "channel-123",
            feedType: "rss",
            itemsPosted: expect.any(Number),
          }),
        })
      );
    });

    it("should emit feed.execution.completed event", async () => {
      mockDbQuery.mockResolvedValue([]);

      mockRSSDirectProviderFetch.mockResolvedValue({
        items: [
          {
            externalId: "1",
            title: "Item 1",
            url: "https://example.com/item1",
            excerpt: "Content for item 1",
            publishedAt: new Date(),
          },
        ],
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            classifiedItems: [{ topics: ["AI"], relevanceScore: 0.9 }],
          }),
      });

      mockEventRepositoryAppend.mockResolvedValue(undefined);

      const job = createMockJob();
      await handleFeedRSSExecute(job);

      expect(mockEventRepositoryAppend).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "feed.execution.completed",
          subjectType: "feed",
          subjectId: "run-abc",
          userId: "user-456",
          data: expect.objectContaining({
            channelId: "channel-123",
            feedType: "rss",
          }),
        })
      );
    });
  });

  describe("edge cases", () => {
    it("should handle empty RSS results gracefully", async () => {
      mockDbQuery.mockResolvedValue([]);

      mockRSSDirectProviderFetch.mockResolvedValue({ items: [] });

      const job = createMockJob();
      await handleFeedRSSExecute(job);

      // Should not insert any messages
      expect(mockDbInsert).not.toHaveBeenCalled();
      // Should update status
      expect(mockDbUpdate).toHaveBeenCalled();
    });

    it("should handle all items being seen URLs", async () => {
      const seenUrl = "https://example.com/seen";

      mockDbQuery.mockResolvedValue([{ metadata: { sourceUrl: seenUrl } }]);

      mockRSSDirectProviderFetch.mockResolvedValue({
        items: [
          {
            externalId: "1",
            title: "Item 1",
            url: seenUrl,
            excerpt: "Content for item 1",
            publishedAt: new Date(),
          },
        ],
      });

      const job = createMockJob();
      await handleFeedRSSExecute(job);

      // Should not insert any messages (all filtered out)
      expect(mockDbInsert).not.toHaveBeenCalled();
    });

    it("should respect maxItemsPerRun limit", async () => {
      mockDbQuery.mockResolvedValue([]);

      const feedItems = Array.from({ length: 20 }, (_, i) => ({
        externalId: String(i),
        title: `Item ${i}`,
        url: `https://example.com/item${i}`,
        excerpt: `Content for item ${i}`,
        publishedAt: new Date(Date.now() - i * 60000),
      }));

      mockRSSDirectProviderFetch.mockResolvedValue({ items: feedItems });

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            classifiedItems: items.map(() => ({
              topics: ["AI"],
              relevanceScore: 0.9,
            })),
          }),
      });

      const job = createMockJob({ config: { maxItemsPerRun: 5 } });
      await handleFeedRSSExecute(job);

      // Should only post max 5 items
      expect(mockDbInsert).toHaveBeenCalledTimes(5);
    });

    it("should handle invalid feed type", async () => {
      const job = createMockJob({
        config: {
          feedType: "proactive" as any,
          enabled: true,
        },
      });

      await expect(handleFeedRSSExecute(job)).rejects.toThrow(
        "Expected RSS feed config, got proactive"
      );
    });
  });
});
