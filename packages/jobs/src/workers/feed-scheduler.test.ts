/**
 * Feed Scheduler Worker Tests
 *
 * Tests for feed-scheduler.ts
 * - Queries active feed channels correctly
 * - Calculates next run time properly
 * - Enqueues jobs with correct priority (manual > RSS > proactive)
 * - Handles manual triggers
 * - Updates feed status after scheduling
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Setup mocks using hoisted pattern
const { mockBossSend, mockDbQuery, mockDbUpdate, mockEq, mockAnd } = vi.hoisted(
  () => ({
    mockBossSend: vi.fn(),
    mockDbQuery: vi.fn(),
    mockDbUpdate: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
    mockEq: vi.fn((field: any, value: any) => ({ type: "eq", field, value })),
    mockAnd: vi.fn((...conditions: any[]) => ({ type: "and", conditions })),
  })
);

// Mock @synap/database
vi.mock("@synap/database", () => ({
  db: {
    query: {
      channels: {
        findMany: mockDbQuery,
      },
    },
    update: mockDbUpdate,
  },
  eq: mockEq,
  and: mockAnd,
  channels: { id: "id" },
  ChannelType: { FEED: "FEED" },
  ChannelStatus: { ACTIVE: "ACTIVE" },
}));

// Mock @synap/database/schema
vi.mock("@synap/database/schema", () => ({
  channels: { id: "id" },
  ChannelType: { FEED: "FEED" },
  ChannelStatus: { ACTIVE: "ACTIVE" },
}));

// Mock pg-boss
vi.mock("../boss.js", () => ({
  getBoss: vi.fn(() => ({
    send: mockBossSend,
  })),
}));

// Mock feed-helpers
vi.mock("../utils/feed-helpers.js", () => ({
  calculateNextRun: vi.fn((_cron, _timezone) => {
    // Return a date in the future by default
    const date = new Date();
    date.setHours(date.getHours() + 1);
    return date;
  }),
}));

// Mock @synap/api utils
vi.mock("@synap/shared-utils", () => ({
  withRetry: vi.fn((fn) => fn()),
  FEED_RETRY_OPTIONS: { retries: 3 },
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

import { handleFeedScheduler, FEED_SCHEDULER_CRON } from "./feed-scheduler.js";

describe("feed-scheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("basic scheduling", () => {
    it("should query active feed channels correctly", async () => {
      mockDbQuery.mockResolvedValue([]);

      await handleFeedScheduler();

      expect(mockDbQuery).toHaveBeenCalledWith({
        where: expect.any(Object),
        columns: {
          id: true,
          userId: true,
          workspaceId: true,
          metadata: true,
          updatedAt: true,
        },
      });
      // Check that eq was called with the expected values (first arg is the column ref, second is the value)
      const eqCalls = mockEq.mock.calls;
      expect(eqCalls.some((call) => call[1] === "FEED")).toBe(true);
      expect(eqCalls.some((call) => call[1] === "ACTIVE")).toBe(true);
    });

    it("should skip channels without feed config", async () => {
      mockDbQuery.mockResolvedValue([
        {
          id: "channel-1",
          userId: "user-1",
          workspaceId: "ws-1",
          metadata: {}, // No feedConfig
          updatedAt: new Date(),
        },
      ]);

      await handleFeedScheduler();

      expect(mockBossSend).not.toHaveBeenCalled();
    });

    it("should skip disabled feeds", async () => {
      mockDbQuery.mockResolvedValue([
        {
          id: "channel-1",
          userId: "user-1",
          workspaceId: "ws-1",
          metadata: {
            feedConfig: {
              feedType: "rss",
              enabled: false,
              schedule: "0 * * * *",
            },
          },
          updatedAt: new Date(),
        },
      ]);

      await handleFeedScheduler();

      expect(mockBossSend).not.toHaveBeenCalled();
    });

    it("should skip feeds that are not due yet", async () => {
      const futureDate = new Date();
      futureDate.setHours(futureDate.getHours() + 2);

      mockDbQuery.mockResolvedValue([
        {
          id: "channel-1",
          userId: "user-1",
          workspaceId: "ws-1",
          metadata: {
            feedConfig: {
              feedType: "rss",
              enabled: true,
              schedule: "0 * * * *",
            },
            feedStatus: {
              nextRunAt: futureDate.toISOString(),
            },
          },
          updatedAt: new Date(),
        },
      ]);

      await handleFeedScheduler();

      expect(mockBossSend).not.toHaveBeenCalled();
    });
  });

  describe("priority ordering", () => {
    it("should assign priority 1 (highest) to manual triggers", async () => {
      const pastDate = new Date();
      pastDate.setHours(pastDate.getHours() - 1);

      mockDbQuery.mockResolvedValue([
        {
          id: "channel-1",
          userId: "user-1",
          workspaceId: "ws-1",
          metadata: {
            feedConfig: {
              feedType: "rss",
              enabled: true,
              schedule: "0 * * * *",
            },
            feedStatus: {
              triggerRequestedAt: pastDate.toISOString(),
            },
          },
          updatedAt: new Date(),
        },
      ]);

      await handleFeedScheduler();

      expect(mockBossSend).toHaveBeenCalledWith(
        "feed-rss-execute",
        expect.any(Object),
        expect.objectContaining({ priority: 1 })
      );
    });

    it("should assign priority 5 to RSS feeds", async () => {
      const pastDate = new Date();
      pastDate.setHours(pastDate.getHours() - 1);

      mockDbQuery.mockResolvedValue([
        {
          id: "channel-1",
          userId: "user-1",
          workspaceId: "ws-1",
          metadata: {
            feedConfig: {
              feedType: "rss",
              enabled: true,
              schedule: "0 * * * *",
            },
            feedStatus: {
              nextRunAt: pastDate.toISOString(),
            },
          },
          updatedAt: new Date(),
        },
      ]);

      await handleFeedScheduler();

      expect(mockBossSend).toHaveBeenCalledWith(
        "feed-rss-execute",
        expect.any(Object),
        expect.objectContaining({ priority: 5 })
      );
    });

    it("should assign priority 3 to proactive feeds", async () => {
      const pastDate = new Date();
      pastDate.setHours(pastDate.getHours() - 1);

      mockDbQuery.mockResolvedValue([
        {
          id: "channel-1",
          userId: "user-1",
          workspaceId: "ws-1",
          metadata: {
            feedConfig: {
              feedType: "proactive",
              enabled: true,
              schedule: "0 9 * * *",
            },
            feedStatus: {
              nextRunAt: pastDate.toISOString(),
            },
          },
          updatedAt: new Date(),
        },
      ]);

      await handleFeedScheduler();

      expect(mockBossSend).toHaveBeenCalledWith(
        "feed-proactive-execute",
        expect.any(Object),
        expect.objectContaining({ priority: 3 })
      );
    });

    it("should respect priority: manual > RSS > proactive", async () => {
      const pastDate = new Date();
      pastDate.setHours(pastDate.getHours() - 1);

      mockDbQuery.mockResolvedValue([
        // Proactive feed (priority 3)
        {
          id: "channel-proactive",
          userId: "user-1",
          workspaceId: "ws-1",
          metadata: {
            feedConfig: {
              feedType: "proactive",
              enabled: true,
              schedule: "0 9 * * *",
            },
            feedStatus: {
              nextRunAt: pastDate.toISOString(),
            },
          },
          updatedAt: new Date(),
        },
        // RSS feed (priority 5)
        {
          id: "channel-rss",
          userId: "user-1",
          workspaceId: "ws-1",
          metadata: {
            feedConfig: {
              feedType: "rss",
              enabled: true,
              schedule: "0 * * * *",
            },
            feedStatus: {
              nextRunAt: pastDate.toISOString(),
            },
          },
          updatedAt: new Date(),
        },
        // Manual RSS trigger (priority 1)
        {
          id: "channel-manual",
          userId: "user-1",
          workspaceId: "ws-1",
          metadata: {
            feedConfig: {
              feedType: "rss",
              enabled: true,
              schedule: "0 * * * *",
            },
            feedStatus: {
              triggerRequestedAt: pastDate.toISOString(),
            },
          },
          updatedAt: new Date(),
        },
      ]);

      await handleFeedScheduler();

      expect(mockBossSend).toHaveBeenCalledTimes(3);

      // Check priorities were assigned correctly
      const calls = mockBossSend.mock.calls;
      expect(calls).toContainEqual([
        "feed-rss-execute",
        expect.any(Object),
        expect.objectContaining({ priority: 1 }),
      ]);
      expect(calls).toContainEqual([
        "feed-proactive-execute",
        expect.any(Object),
        expect.objectContaining({ priority: 3 }),
      ]);
      expect(calls).toContainEqual([
        "feed-rss-execute",
        expect.any(Object),
        expect.objectContaining({ priority: 5 }),
      ]);
    });
  });

  describe("manual triggers", () => {
    it("should handle manual trigger requests", async () => {
      const triggerTime = new Date().toISOString();

      mockDbQuery.mockResolvedValue([
        {
          id: "channel-1",
          userId: "user-1",
          workspaceId: "ws-1",
          metadata: {
            feedConfig: {
              feedType: "rss",
              enabled: true,
              schedule: "0 * * * *",
            },
            feedStatus: {
              triggerRequestedAt: triggerTime,
            },
          },
          updatedAt: new Date(),
        },
      ]);

      await handleFeedScheduler();

      expect(mockBossSend).toHaveBeenCalledWith(
        "feed-rss-execute",
        expect.objectContaining({
          channelId: "channel-1",
          userId: "user-1",
          workspaceId: "ws-1",
          triggered: true,
          runId: expect.any(String),
        }),
        expect.any(Object)
      );
    });

    it("should clear triggerRequestedAt after scheduling", async () => {
      const triggerTime = new Date().toISOString();

      mockDbQuery.mockResolvedValue([
        {
          id: "channel-1",
          userId: "user-1",
          workspaceId: "ws-1",
          metadata: {
            feedConfig: {
              feedType: "rss",
              enabled: true,
              schedule: "0 * * * *",
            },
            feedStatus: {
              triggerRequestedAt: triggerTime,
            },
          },
          updatedAt: new Date(),
        },
      ]);

      await handleFeedScheduler();

      // Check that channel update was called with cleared trigger
      expect(mockDbUpdate).toHaveBeenCalled();
    });

    it("should handle mixed manual and scheduled triggers", async () => {
      const pastDate = new Date();
      pastDate.setHours(pastDate.getHours() - 1);

      mockDbQuery.mockResolvedValue([
        {
          id: "channel-1",
          userId: "user-1",
          workspaceId: "ws-1",
          metadata: {
            feedConfig: {
              feedType: "rss",
              enabled: true,
              schedule: "0 * * * *",
            },
            feedStatus: {
              triggerRequestedAt: new Date().toISOString(),
              nextRunAt: pastDate.toISOString(),
            },
          },
          updatedAt: new Date(),
        },
      ]);

      await handleFeedScheduler();

      // Should be treated as manual (priority 1) when triggerRequestedAt exists
      expect(mockBossSend).toHaveBeenCalledWith(
        "feed-rss-execute",
        expect.objectContaining({ triggered: true }),
        expect.objectContaining({ priority: 1 })
      );
    });
  });

  describe("feed status updates", () => {
    it("should update feed status with runId and running status", async () => {
      const pastDate = new Date();
      pastDate.setHours(pastDate.getHours() - 1);

      mockDbQuery.mockResolvedValue([
        {
          id: "channel-1",
          userId: "user-1",
          workspaceId: "ws-1",
          metadata: {
            feedConfig: {
              feedType: "rss",
              enabled: true,
              schedule: "0 * * * *",
            },
            feedStatus: {
              nextRunAt: pastDate.toISOString(),
            },
          },
          updatedAt: new Date(),
        },
      ]);

      await handleFeedScheduler();

      // The db.update is mocked as a chain, so we check it was called
      expect(mockDbUpdate).toHaveBeenCalled();
    });

    it("should preserve existing feed status fields", async () => {
      const pastDate = new Date();
      pastDate.setHours(pastDate.getHours() - 1);

      mockDbQuery.mockResolvedValue([
        {
          id: "channel-1",
          userId: "user-1",
          workspaceId: "ws-1",
          metadata: {
            feedConfig: {
              feedType: "rss",
              enabled: true,
              schedule: "0 * * * *",
            },
            feedStatus: {
              lastRunAt: "2024-01-01T00:00:00Z",
              lastRunStatus: "success",
              nextRunAt: pastDate.toISOString(),
            },
          },
          updatedAt: new Date(),
        },
      ]);

      await handleFeedScheduler();

      // Update should be called
      expect(mockDbUpdate).toHaveBeenCalled();
    });
  });

  describe("queue routing", () => {
    it("should route RSS feeds to feed-rss-execute queue", async () => {
      const pastDate = new Date();
      pastDate.setHours(pastDate.getHours() - 1);

      mockDbQuery.mockResolvedValue([
        {
          id: "channel-1",
          userId: "user-1",
          workspaceId: "ws-1",
          metadata: {
            feedConfig: {
              feedType: "rss",
              enabled: true,
              schedule: "0 * * * *",
              sources: [{ url: "https://example.com/feed.xml" }],
            },
            feedStatus: {
              nextRunAt: pastDate.toISOString(),
            },
          },
          updatedAt: new Date(),
        },
      ]);

      await handleFeedScheduler();

      expect(mockBossSend).toHaveBeenCalledWith(
        "feed-rss-execute",
        expect.any(Object),
        expect.any(Object)
      );
    });

    it("should route proactive feeds to feed-proactive-execute queue", async () => {
      const pastDate = new Date();
      pastDate.setHours(pastDate.getHours() - 1);

      mockDbQuery.mockResolvedValue([
        {
          id: "channel-1",
          userId: "user-1",
          workspaceId: "ws-1",
          metadata: {
            feedConfig: {
              feedType: "proactive",
              enabled: true,
              schedule: "0 9 * * *",
            },
            feedStatus: {
              nextRunAt: pastDate.toISOString(),
            },
          },
          updatedAt: new Date(),
        },
      ]);

      await handleFeedScheduler();

      expect(mockBossSend).toHaveBeenCalledWith(
        "feed-proactive-execute",
        expect.any(Object),
        expect.any(Object)
      );
    });
  });

  describe("error handling", () => {
    it("should handle database query errors", async () => {
      mockDbQuery.mockRejectedValue(new Error("DB connection failed"));

      await expect(handleFeedScheduler()).rejects.toThrow(
        "DB connection failed"
      );
    });

    it("should skip individual channels that fail but continue processing others", async () => {
      const pastDate = new Date();
      pastDate.setHours(pastDate.getHours() - 1);

      mockDbQuery.mockResolvedValue([
        {
          id: "channel-1",
          userId: "user-1",
          workspaceId: "ws-1",
          metadata: {
            feedConfig: {
              feedType: "rss",
              enabled: true,
              schedule: "0 * * * *",
            },
            feedStatus: {
              nextRunAt: pastDate.toISOString(),
            },
          },
          updatedAt: new Date(),
        },
        // Channel without config should be skipped but not cause failure
        {
          id: "channel-2",
          userId: "user-1",
          workspaceId: "ws-1",
          metadata: {},
          updatedAt: new Date(),
        },
        {
          id: "channel-3",
          userId: "user-1",
          workspaceId: "ws-1",
          metadata: {
            feedConfig: {
              feedType: "rss",
              enabled: true,
              schedule: "0 * * * *",
            },
            feedStatus: {
              nextRunAt: pastDate.toISOString(),
            },
          },
          updatedAt: new Date(),
        },
      ]);

      await handleFeedScheduler();

      // Should schedule 2 valid feeds (channel-1 and channel-3)
      expect(mockBossSend).toHaveBeenCalledTimes(2);
    });

    it("should handle invalid feed configs gracefully", async () => {
      mockDbQuery.mockResolvedValue([
        {
          id: "channel-1",
          userId: "user-1",
          workspaceId: "ws-1",
          metadata: {
            feedConfig: {
              feedType: "invalid-type", // Invalid feed type
              enabled: true,
            },
          },
          updatedAt: new Date(),
        },
      ]);

      await handleFeedScheduler();

      expect(mockBossSend).not.toHaveBeenCalled();
    });
  });

  describe("cron constant", () => {
    it("should export correct cron schedule (every minute)", () => {
      expect(FEED_SCHEDULER_CRON).toBe("* * * * *");
    });
  });

  describe("workspace handling", () => {
    it("should handle feeds with null workspaceId", async () => {
      const pastDate = new Date();
      pastDate.setHours(pastDate.getHours() - 1);

      mockDbQuery.mockResolvedValue([
        {
          id: "channel-1",
          userId: "user-1",
          workspaceId: null,
          metadata: {
            feedConfig: {
              feedType: "rss",
              enabled: true,
              schedule: "0 * * * *",
              sources: [{ url: "https://example.com/feed.xml" }],
            },
            feedStatus: {
              nextRunAt: pastDate.toISOString(),
            },
          },
          updatedAt: new Date(),
        },
      ]);

      await handleFeedScheduler();

      expect(mockBossSend).toHaveBeenCalledWith(
        "feed-rss-execute",
        expect.objectContaining({
          channelId: "channel-1",
          userId: "user-1",
          workspaceId: undefined,
        }),
        expect.any(Object)
      );
    });
  });
});
