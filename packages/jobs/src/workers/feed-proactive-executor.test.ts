/**
 * Feed Proactive Executor Worker Tests
 *
 * Tests for feed-proactive-executor.ts
 * - Aggregates workspace data correctly (mock DB queries)
 * - Calls IS for summarization (mock IS call)
 * - Posts batch digest
 * - Handles empty content gracefully
 * - Updates feed status
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Setup mocks using hoisted pattern
const {
  mockAggregateWorkspaceData,
  mockFetch,
  mockDbQuery,
  mockDbInsert,
  mockDbUpdate,
  mockEmitSideEffects,
  mockEventRepositoryAppend,
  getLastInsertedValues,
  clearCapturedValues,
} = vi.hoisted(() => {
  const capturedValues: any[] = [];
  let lastInsertedValues: any = null;

  return {
    mockAggregateWorkspaceData: vi.fn(),
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
  };
});

// Mock proactive-aggregator
vi.mock("../fetchers/proactive-aggregator.js", () => ({
  aggregateWorkspaceData: mockAggregateWorkspaceData,
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
      channels: {
        findFirst: mockDbQuery,
      },
    },
    insert: mockDbInsert,
    update: mockDbUpdate,
  },
  eq: vi.fn((a, b) => ({ type: "eq", field: a, value: b })),
  and: vi.fn((...conds) => ({ type: "and", conditions: conds })),
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
    date.setHours(date.getHours() + 24);
    return date;
  }),
}));

// Mock @synap/api utils
vi.mock("@synap/shared-utils", () => ({
  withRetry: vi.fn((fn) => fn()),
  FEED_RETRY_OPTIONS: { retries: 3 },
}));

import { handleFeedProactiveExecute } from "./feed-proactive-executor.js";

// Test fixtures
const createMockJob = (
  overrides: Record<string, unknown> & { config?: Record<string, unknown> } = {}
) => {
  const baseConfig = {
    // Required FeedConfig fields
    id: "feed-123",
    workspaceId: "workspace-789",
    name: "Test Feed",
    type: "proactive" as const,
    url: "https://example.com/feed",
    isActive: true,
    pollIntervalMinutes: 60,
    createdAt: new Date(),
    updatedAt: new Date(),
    // Additional fields for proactive feeds
    feedType: "proactive" as const,
    enabled: true,
    schedule: "0 9 * * *",
    timezone: "UTC",
    maxItemsPerRun: 50,
    dedupWindowDays: 1,
    minRelevanceScore: 0,
    postMode: "batch" as const,
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
      style: "brief" as const,
      maxItems: 10,
      includeInsights: true,
    },
  };

  // Extract config from overrides, then merge separately
  const { config: configOverride, ...otherOverrides } = overrides;

  // Deep merge for nested config properties
  const mergedConfig = configOverride
    ? {
        ...baseConfig,
        ...configOverride,
        include: configOverride.include
          ? { ...baseConfig.include, ...configOverride.include }
          : baseConfig.include,
        summarization: configOverride.summarization
          ? { ...baseConfig.summarization, ...configOverride.summarization }
          : baseConfig.summarization,
      }
    : baseConfig;

  return {
    data: {
      channelId: "channel-123",
      userId: "user-456",
      workspaceId: "workspace-789",
      runId: "run-abc",
      config: mergedConfig as import("@synap/shared-utils").ProactiveFeedConfig,
      ...otherOverrides,
    },
  };
};

const createMockAggregatedData = (overrides = {}) => ({
  tasksDue: [
    { id: "task-1", title: "Task 1", dueDate: "2024-01-15", priority: "high" },
    {
      id: "task-2",
      title: "Task 2",
      dueDate: "2024-01-16",
      priority: "medium",
    },
  ],
  pendingProposals: [
    {
      id: "prop-1",
      title: "Proposal 1",
      type: "entity_create",
      createdAt: new Date(),
    },
  ],
  recentEntities: [
    { id: "entity-1", type: "note", title: "New Note", createdAt: new Date() },
    { id: "entity-2", type: "task", title: "New Task", createdAt: new Date() },
  ],
  recentCaptures: [
    {
      id: "cap-1",
      title: "Capture 1",
      url: "https://example.com/1",
      capturedAt: new Date(),
    },
  ],
  activitySummary: {
    entitiesCreated: 5,
    entitiesUpdated: 3,
    proposalsCreated: 1,
    capturesCreated: 2,
  },
  ...overrides,
});

describe("feed-proactive-executor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCapturedValues();
    process.env.INTELLIGENCE_HUB_URL = "https://is.synap.io";
    process.env.INTELLIGENCE_HUB_API_KEY = "test-api-key";
  });

  describe("workspace data aggregation", () => {
    it("should aggregate workspace data with correct workspaceId", async () => {
      mockAggregateWorkspaceData.mockResolvedValue(createMockAggregatedData());

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            digest: "## Workspace Update\n\n**Activity:** 5 created, 3 updated",
          }),
      });

      const job = createMockJob();
      await handleFeedProactiveExecute(job);

      expect(mockAggregateWorkspaceData).toHaveBeenCalledWith(
        "workspace-789",
        expect.objectContaining({
          feedType: "proactive",
          include: expect.objectContaining({
            tasksDue: true,
            pendingProposals: true,
            recentEntities: true,
          }),
        })
      );
    });

    it("should pass config options to aggregator", async () => {
      mockAggregateWorkspaceData.mockResolvedValue(createMockAggregatedData());

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ digest: "Test digest" }),
      });

      const job = createMockJob({
        config: {
          include: {
            tasksDue: true,
            tasksDueDays: 7,
            pendingProposals: false,
            recentEntities: true,
            recentEntitiesHours: 48,
            recentCaptures: false,
            activitySummary: true,
          },
        },
      });
      await handleFeedProactiveExecute(job);

      expect(mockAggregateWorkspaceData).toHaveBeenCalledWith(
        "workspace-789",
        expect.objectContaining({
          include: expect.objectContaining({
            tasksDueDays: 7,
            pendingProposals: false,
            recentEntitiesHours: 48,
            recentCaptures: false,
          }),
        })
      );
    });

    it("should require workspaceId for proactive feeds", async () => {
      const job = createMockJob({ workspaceId: undefined });

      await expect(handleFeedProactiveExecute(job)).rejects.toThrow(
        "Proactive feed requires workspaceId"
      );
    });
  });

  describe("IS summarization", () => {
    it("should call IS for summarization when configured", async () => {
      mockAggregateWorkspaceData.mockResolvedValue(createMockAggregatedData());

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            digest:
              "## AI-Generated Digest\n\nKey insights from your workspace...",
          }),
      });

      const job = createMockJob();
      await handleFeedProactiveExecute(job);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://is.synap.io/v1/tools/generate_feed_digest",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            Authorization: "Bearer test-api-key",
          }),
          body: expect.any(String),
        })
      );

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody).toMatchObject({
        items: expect.any(Array),
        style: "brief",
        maxLength: 500,
      });
    });

    it("should pass recent entities to IS for summarization", async () => {
      const aggregatedData = createMockAggregatedData({
        recentEntities: [
          {
            id: "e1",
            type: "note",
            title: "Note 1",
            createdAt: new Date("2024-01-01"),
          },
          {
            id: "e2",
            type: "task",
            title: "Task 1",
            createdAt: new Date("2024-01-02"),
          },
        ],
      });

      mockAggregateWorkspaceData.mockResolvedValue(aggregatedData);

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ digest: "Digest content" }),
      });

      const job = createMockJob();
      await handleFeedProactiveExecute(job);

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.items).toHaveLength(2);
      expect(requestBody.items[0]).toMatchObject({
        title: expect.any(String),
        type: expect.any(String),
        createdAt: expect.any(String),
      });
    });

    it("should use fallback when IS fails", async () => {
      mockAggregateWorkspaceData.mockResolvedValue(createMockAggregatedData());

      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      });

      const job = createMockJob();
      await handleFeedProactiveExecute(job);

      // Should still post a message with fallback content
      expect(mockDbInsert).toHaveBeenCalled();
    });

    it("should use stub digest when IS is not configured", async () => {
      delete process.env.INTELLIGENCE_HUB_URL;
      delete process.env.INTELLIGENCE_HUB_API_KEY;

      mockAggregateWorkspaceData.mockResolvedValue(createMockAggregatedData());

      const job = createMockJob();
      await handleFeedProactiveExecute(job);

      // Should not call IS
      expect(mockFetch).not.toHaveBeenCalled();
      // Should still post a message
      expect(mockDbInsert).toHaveBeenCalled();
    });
  });

  describe("digest posting", () => {
    it("should post batch digest message", async () => {
      mockAggregateWorkspaceData.mockResolvedValue(createMockAggregatedData());

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            digest: "## Workspace Update\n\nKey insights...",
          }),
      });

      const job = createMockJob();
      await handleFeedProactiveExecute(job);

      expect(mockDbInsert).toHaveBeenCalledWith(expect.any(Object));
      const insertCall = getLastInsertedValues();
      expect(insertCall).toMatchObject({
        id: expect.any(String),
        channelId: "channel-123",
        userId: "user-456",
        role: "system",
        authorType: "bot",
        content: expect.stringContaining("Workspace Update"),
        metadata: expect.objectContaining({
          feedType: "proactive",
          batched: true,
          feedRunId: "run-abc",
        }),
      });
    });

    it("should include priority in message metadata", async () => {
      mockAggregateWorkspaceData.mockResolvedValue(
        createMockAggregatedData({
          tasksDue: Array.from({ length: 10 }, (_, i) => ({
            id: `task-${i}`,
            title: `Task ${i}`,
            dueDate: "2024-01-15",
          })),
        })
      );

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ digest: "High priority digest" }),
      });

      const job = createMockJob();
      await handleFeedProactiveExecute(job);

      const insertCall = getLastInsertedValues();
      expect(insertCall.metadata.priority).toBe("high");
    });

    it("should include insights in message metadata when available", async () => {
      mockAggregateWorkspaceData.mockResolvedValue(
        createMockAggregatedData({
          tasksDue: Array.from({ length: 6 }, (_, i) => ({
            id: `task-${i}`,
            title: `Task ${i}`,
            dueDate: "2024-01-15",
          })),
          pendingProposals: [
            {
              id: "prop-1",
              title: "Proposal 1",
              type: "create",
              createdAt: new Date(),
            },
          ],
        })
      );

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ digest: "Digest with insights" }),
      });

      const job = createMockJob();
      await handleFeedProactiveExecute(job);

      const insertCall = getLastInsertedValues();
      expect(insertCall.metadata.insights).toBeInstanceOf(Array);
      expect(insertCall.metadata.insights.length).toBeGreaterThan(0);
    });
  });

  describe("empty content handling", () => {
    it("should handle empty workspace gracefully", async () => {
      mockAggregateWorkspaceData.mockResolvedValue({
        tasksDue: [],
        pendingProposals: [],
        recentEntities: [],
        recentCaptures: [],
        activitySummary: {
          entitiesCreated: 0,
          entitiesUpdated: 0,
          proposalsCreated: 0,
          capturesCreated: 0,
        },
      });

      // Mock channel lookup for updateFeedStatus
      mockDbQuery.mockResolvedValue({ metadata: {} });

      const job = createMockJob();
      await handleFeedProactiveExecute(job);

      // Should not post any message when there's no content
      expect(mockDbInsert).not.toHaveBeenCalled();
      // Should still update status
      expect(mockDbUpdate).toHaveBeenCalled();
    });

    it("should handle disabled content sections", async () => {
      mockAggregateWorkspaceData.mockResolvedValue({
        tasksDue: [],
        pendingProposals: [],
        recentEntities: [],
        recentCaptures: [],
        activitySummary: {
          entitiesCreated: 0,
          entitiesUpdated: 0,
          proposalsCreated: 0,
          capturesCreated: 0,
        },
      });

      // Mock channel lookup for updateFeedStatus
      mockDbQuery.mockResolvedValue({ metadata: {} });

      const job = createMockJob({
        config: {
          include: {
            tasksDue: false,
            pendingProposals: false,
            recentEntities: false,
            recentCaptures: false,
            activitySummary: false,
          },
        },
      });
      await handleFeedProactiveExecute(job);

      expect(mockDbInsert).not.toHaveBeenCalled();
    });

    it("should post digest when at least one section has content", async () => {
      mockAggregateWorkspaceData.mockResolvedValue({
        tasksDue: [],
        pendingProposals: [],
        recentEntities: [
          { id: "e1", type: "note", title: "Note", createdAt: new Date() },
        ],
        recentCaptures: [],
        activitySummary: {
          entitiesCreated: 1,
          entitiesUpdated: 0,
          proposalsCreated: 0,
          capturesCreated: 0,
        },
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ digest: "Digest content" }),
      });

      const job = createMockJob();
      await handleFeedProactiveExecute(job);

      expect(mockDbInsert).toHaveBeenCalled();
    });
  });

  describe("digest styles", () => {
    it("should use 'brief' style by default", async () => {
      mockAggregateWorkspaceData.mockResolvedValue(createMockAggregatedData());

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ digest: "Brief digest" }),
      });

      const job = createMockJob();
      await handleFeedProactiveExecute(job);

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.style).toBe("brief");
    });

    it("should pass 'detailed' style when configured", async () => {
      mockAggregateWorkspaceData.mockResolvedValue(createMockAggregatedData());

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ digest: "Detailed digest" }),
      });

      const job = createMockJob({
        config: {
          summarization: {
            style: "detailed",
          },
        },
      });
      await handleFeedProactiveExecute(job);

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.style).toBe("detailed");
    });

    it("should pass 'bullet_points' style when configured", async () => {
      mockAggregateWorkspaceData.mockResolvedValue(createMockAggregatedData());

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ digest: "Bullet digest" }),
      });

      const job = createMockJob({
        config: {
          summarization: {
            style: "bullet_points",
          },
        },
      });
      await handleFeedProactiveExecute(job);

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.style).toBe("bullet_points");
    });
  });

  describe("priority levels", () => {
    it("should set priority to 'high' when many tasks are due", async () => {
      mockAggregateWorkspaceData.mockResolvedValue(
        createMockAggregatedData({
          tasksDue: Array.from({ length: 6 }, (_, i) => ({
            id: `task-${i}`,
            title: `Task ${i}`,
            dueDate: "2024-01-15",
          })),
        })
      );

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ digest: "High priority" }),
      });

      const job = createMockJob();
      await handleFeedProactiveExecute(job);

      const insertCall = getLastInsertedValues();
      expect(insertCall.metadata.priority).toBe("high");
    });

    it("should set priority to 'high' when many proposals pending", async () => {
      mockAggregateWorkspaceData.mockResolvedValue(
        createMockAggregatedData({
          pendingProposals: Array.from({ length: 4 }, (_, i) => ({
            id: `prop-${i}`,
            title: `Proposal ${i}`,
            type: "create",
            createdAt: new Date(),
          })),
        })
      );

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ digest: "High priority" }),
      });

      const job = createMockJob();
      await handleFeedProactiveExecute(job);

      const insertCall = getLastInsertedValues();
      expect(insertCall.metadata.priority).toBe("high");
    });

    it("should set priority to 'medium' when some tasks or proposals exist", async () => {
      mockAggregateWorkspaceData.mockResolvedValue(
        createMockAggregatedData({
          tasksDue: [{ id: "task-1", title: "Task 1", dueDate: "2024-01-15" }],
          pendingProposals: [],
        })
      );

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ digest: "Medium priority" }),
      });

      const job = createMockJob();
      await handleFeedProactiveExecute(job);

      const insertCall = getLastInsertedValues();
      expect(insertCall.metadata.priority).toBe("medium");
    });

    it("should set priority to 'low' when no urgent items", async () => {
      mockAggregateWorkspaceData.mockResolvedValue({
        tasksDue: [],
        pendingProposals: [],
        recentEntities: [
          { id: "e1", type: "note", title: "Note", createdAt: new Date() },
        ],
        recentCaptures: [],
        activitySummary: {
          entitiesCreated: 1,
          entitiesUpdated: 0,
          proposalsCreated: 0,
          capturesCreated: 0,
        },
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ digest: "Low priority" }),
      });

      const job = createMockJob();
      await handleFeedProactiveExecute(job);

      const insertCall = getLastInsertedValues();
      expect(insertCall.metadata.priority).toBe("low");
    });
  });

  describe("feed status updates", () => {
    it("should update feed status on successful completion", async () => {
      mockAggregateWorkspaceData.mockResolvedValue(createMockAggregatedData());

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ digest: "Digest" }),
      });

      const job = createMockJob();
      await handleFeedProactiveExecute(job);

      expect(mockDbUpdate).toHaveBeenCalled();
    });

    it("should handle aggregation errors gracefully", async () => {
      mockAggregateWorkspaceData.mockRejectedValue(
        new Error("Aggregation failed")
      );

      const job = createMockJob();
      // The worker handles aggregation errors internally and returns an error result
      const result = await handleFeedProactiveExecute(job);
      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe("side effects and events", () => {
    it("should emit side effects after posting", async () => {
      mockAggregateWorkspaceData.mockResolvedValue(createMockAggregatedData());

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ digest: "Digest" }),
      });

      mockEmitSideEffects.mockResolvedValue(undefined);

      const job = createMockJob();
      await handleFeedProactiveExecute(job);

      expect(mockEmitSideEffects).toHaveBeenCalledWith(
        expect.objectContaining({
          subjectType: "feed",
          action: "execution",
          userId: "user-456",
          workspaceId: "workspace-789",
          data: expect.objectContaining({
            channelId: "channel-123",
            feedType: "proactive",
            messageId: expect.any(String),
            priority: expect.any(String),
            tasksDue: expect.any(Number),
            pendingProposals: expect.any(Number),
            recentEntities: expect.any(Number),
            recentCaptures: expect.any(Number),
            durationMs: expect.any(Number),
          }),
        })
      );
    });

    it("should emit feed.execution.completed event", async () => {
      mockAggregateWorkspaceData.mockResolvedValue(createMockAggregatedData());

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ digest: "Digest" }),
      });

      mockEventRepositoryAppend.mockResolvedValue(undefined);

      const job = createMockJob();
      await handleFeedProactiveExecute(job);

      expect(mockEventRepositoryAppend).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "feed.execution.completed",
          subjectType: "feed",
          subjectId: "run-abc",
          userId: "user-456",
          data: expect.objectContaining({
            channelId: "channel-123",
            feedType: "proactive",
            messageId: expect.any(String),
            priority: expect.any(String),
            tasksDue: expect.any(Number),
            pendingProposals: expect.any(Number),
            recentEntities: expect.any(Number),
            recentCaptures: expect.any(Number),
            durationMs: expect.any(Number),
          }),
        })
      );
    });
  });

  describe("edge cases", () => {
    it("should handle aggregator returning partial data", async () => {
      mockAggregateWorkspaceData.mockResolvedValue({
        tasksDue: [{ id: "task-1", title: "Task 1" }],
        pendingProposals: [],
        recentEntities: [],
        recentCaptures: [],
        activitySummary: {
          entitiesCreated: 0,
          entitiesUpdated: 0,
          proposalsCreated: 0,
          capturesCreated: 0,
        },
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ digest: "Partial digest" }),
      });

      const job = createMockJob();
      await handleFeedProactiveExecute(job);

      expect(mockDbInsert).toHaveBeenCalled();
    });

    it("should handle invalid feed type", async () => {
      const job = createMockJob({
        config: {
          feedType: "rss" as any,
          enabled: true,
        },
      });

      await expect(handleFeedProactiveExecute(job)).rejects.toThrow(
        "Expected proactive feed config, got rss"
      );
    });

    it("should handle IS network errors", async () => {
      mockAggregateWorkspaceData.mockResolvedValue(createMockAggregatedData());

      mockFetch.mockRejectedValue(new Error("Network error"));

      const job = createMockJob();
      await handleFeedProactiveExecute(job);

      // Should fallback and still post
      expect(mockDbInsert).toHaveBeenCalled();
    });
  });
});
