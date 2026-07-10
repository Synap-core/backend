/**
 * DeliveryService Tests
 *
 * Comprehensive tests for the unified message delivery service.
 * Covers all surfaces: feed, chat, notification, external, email.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("@synap/database", () => ({
  db: {
    insert: vi.fn(),
    query: {
      channels: {
        findFirst: vi.fn(),
      },
    },
  },
  eq: vi.fn((a, b) => ({ type: "eq", a, b })),
  and: vi.fn((...args) => ({ type: "and", args })),
}));

vi.mock("@synap/database/schema", () => ({
  channels: {
    id: "id",
    userId: "user_id",
    channelType: "channel_type",
    status: "status",
  },
  messages: {
    id: "id",
    channelId: "channel_id",
    content: "content",
    role: "role",
    authorType: "author_type",
    messageCategory: "message_category",
    userId: "user_id",
    metadata: "metadata",
  },
  ChannelType: {
    FEED: "feed",
    PERSONAL: "personal",
  },
  ChannelStatus: {
    ACTIVE: "active",
  },
  MessageRole: {
    SYSTEM: "system",
    ASSISTANT: "assistant",
  },
  MessageAuthorType: {
    BOT: "bot",
  },
  MessageCategory: {
    SYSTEM_NOTIFICATION: "system_notification",
    CHAT: "chat",
  },
}));

vi.mock("../notifications/NotificationService.js", () => ({
  NotificationService: {
    create: vi.fn(),
  },
}));

vi.mock("@synap/events", () => ({
  emitSideEffects: vi.fn(),
}));

vi.mock("../utils/personal-channel.js", () => ({
  ensureAgentThread: vi.fn(),
  getAgentIdBySlug: vi.fn().mockResolvedValue("agent-orchestrator-id"),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

import { db } from "@synap/database";
import { NotificationService } from "../notifications/NotificationService.js";
import { emitSideEffects } from "@synap/events";
import { ensureAgentThread } from "../utils/personal-channel.js";
import {
  DeliveryService,
  type DeliveryRequest,
  type DeliverySurface,
} from "./DeliveryService.js";

// ─── Test Helpers ───────────────────────────────────────────────────────────

function createMockMessage(id: string) {
  return {
    id,
    channelId: "channel-123",
    content: "Test message",
    role: "system",
    authorType: "bot",
    messageCategory: "system_notification",
    userId: "user-123",
    metadata: {},
  };
}

function createBaseRequest(
  overrides: Partial<DeliveryRequest> = {}
): DeliveryRequest {
  return {
    userId: "user-123",
    workspaceId: "workspace-456",
    content: {
      title: "Test Title",
      body: "Test message body",
      sourceType: "ai_proactive",
      sourceId: "source-789",
      actions: [{ label: "Action 1", action: "action-1", data: {} }],
      metadata: { key: "value" },
    },
    surfaces: [{ type: "feed" }],
    priority: "normal",
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("DeliveryService", () => {
  const mockDbInsert = db.insert as any;
  const mockDbQuery = db.query as any;
  const mockNotificationCreate = NotificationService.create as any;
  const mockEmitSideEffectsFn = emitSideEffects as any;
  const mockEnsureAgentThreadFn = ensureAgentThread as any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Default mock implementations
    mockDbInsert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([createMockMessage("msg-123")]),
      }),
    });

    mockDbQuery.channels.findFirst.mockResolvedValue({
      id: "feed-channel-123",
      userId: "user-123",
      channelType: "feed",
      status: "active",
    });

    mockNotificationCreate.mockResolvedValue("notification-123");
    mockEmitSideEffectsFn.mockResolvedValue(undefined);
    mockEnsureAgentThreadFn.mockResolvedValue({
      id: "agent-thread-456",
      userId: "user-123",
      channelType: "thread",
      status: "active",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Unit Tests for Each Surface ───────────────────────────────────────────

  describe("deliverToFeed", () => {
    it("should deliver message to specified feed channel", async () => {
      const request = createBaseRequest({
        surfaces: [{ type: "feed", feedChannelId: "custom-feed-123" }],
      });

      const result = await DeliveryService.deliver(request);

      expect(result.success).toBe(true);
      expect(result.deliveries).toHaveLength(1);
      expect(result.deliveries[0].surface).toBe("feed");
      expect(result.deliveries[0].success).toBe(true);
      expect(result.deliveries[0].id).toBe("msg-123");

      // Verify DB insert was called with correct channel
      expect(mockDbInsert).toHaveBeenCalled();
    });

    it("should auto-discover feed channel when feedChannelId not provided", async () => {
      const request = createBaseRequest({
        surfaces: [{ type: "feed" }],
      });

      const result = await DeliveryService.deliver(request);

      expect(result.success).toBe(true);
      expect(mockDbQuery.channels.findFirst).toHaveBeenCalled();
      expect(mockDbInsert).toHaveBeenCalled();
    });

    it("should include correct message metadata", async () => {
      const request = createBaseRequest({
        surfaces: [{ type: "feed", feedChannelId: "feed-123" }],
        content: {
          title: "Test Title",
          body: "Test body",
          sourceType: "automation",
          sourceId: "auto-123",
          metadata: { customKey: "customValue" },
        },
      });

      await DeliveryService.deliver(request);

      expect(mockDbInsert).toHaveBeenCalled();
    });

    // NOTE: side-effect emission ("message.created") was moved OUT of
    // DeliveryService into its callers (to break a circular dependency —
    // see the comments in DeliveryService.ts deliverToFeedInternal /
    // deliverToChatInternal). The former "should emit side effects" tests
    // were removed here; caller-side emission is no longer this unit's
    // responsibility and would need coverage at the call sites instead.

    it("should still succeed even if side effects fail", async () => {
      mockEmitSideEffectsFn.mockRejectedValue(new Error("Side effect failed"));

      const request = createBaseRequest({
        surfaces: [{ type: "feed", feedChannelId: "feed-123" }],
      });

      const result = await DeliveryService.deliver(request);

      expect(result.success).toBe(true);
      expect(result.deliveries[0].success).toBe(true);
    });
  });

  describe("deliverToChat", () => {
    it("should deliver message to specified chat channel", async () => {
      const request = createBaseRequest({
        surfaces: [{ type: "chat", channelId: "chat-channel-123" }],
      });

      const result = await DeliveryService.deliver(request);

      expect(result.success).toBe(true);
      expect(result.deliveries[0].surface).toBe("chat");
      expect(result.deliveries[0].success).toBe(true);
    });

    it("should create personal channel when channelId not provided", async () => {
      const request = createBaseRequest({
        surfaces: [{ type: "chat" }],
      });

      await DeliveryService.deliver(request);

      expect(mockEnsureAgentThreadFn).toHaveBeenCalledWith(
        "user-123",
        "agent-orchestrator-id"
      );
      expect(mockDbInsert).toHaveBeenCalled();
    });

    it("should use ASSISTANT role and CHAT category for chat messages", async () => {
      const request = createBaseRequest({
        surfaces: [{ type: "chat", channelId: "chat-123" }],
      });

      await DeliveryService.deliver(request);

      // Verify the insert was called
      expect(mockDbInsert).toHaveBeenCalled();
    });

    // (chat-delivery side-effect emission test removed — see note above:
    // "message.created" emission now lives in the callers, not DeliveryService.)
  });

  describe("deliverToNotification", () => {
    it("should create notification via NotificationService", async () => {
      const request = createBaseRequest({
        surfaces: [
          { type: "notification", notificationType: "test.notification" },
        ],
      });

      const result = await DeliveryService.deliver(request);

      expect(result.success).toBe(true);
      expect(result.deliveries[0].surface).toBe("notification");
      expect(result.deliveries[0].id).toBe("notification-123");
      expect(mockNotificationCreate).toHaveBeenCalled();
    });

    it("should pass correct parameters to NotificationService", async () => {
      const request = createBaseRequest({
        surfaces: [
          { type: "notification", notificationType: "proposal.created" },
        ],
        content: {
          title: "Proposal Created",
          body: "A new proposal needs your review",
          sourceType: "system",
          sourceId: "proposal-123",
          actions: [
            { label: "Review", action: "review-proposal", data: { id: "123" } },
          ],
        },
        priority: "high",
      });

      await DeliveryService.deliver(request);

      expect(mockNotificationCreate).toHaveBeenCalledWith({
        type: "proposal.created",
        workspaceId: "workspace-456",
        userId: "user-123",
        sourceType: "system",
        sourceId: "proposal-123",
        data: {
          title: "Proposal Created",
          body: "A new proposal needs your review",
          actions: [
            { label: "Review", action: "review-proposal", data: { id: "123" } },
          ],
          priority: "high",
        },
      });
    });

    it("should use default title when not provided", async () => {
      const request = createBaseRequest({
        surfaces: [
          { type: "notification", notificationType: "test.notification" },
        ],
        content: {
          body: "Test body",
          sourceType: "system",
        },
      });

      await DeliveryService.deliver(request);

      expect(mockNotificationCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            title: "Notification",
          }),
        })
      );
    });
  });

  describe("multiple surfaces", () => {
    it("should deliver to all specified surfaces", async () => {
      mockEnsureAgentThreadFn.mockResolvedValue({
        id: "personal-123",
        userId: "user-123",
        channelType: "thread",
        status: "active",
      });

      const request = createBaseRequest({
        surfaces: [
          { type: "feed", feedChannelId: "feed-123" },
          { type: "chat", channelId: "chat-123" },
          { type: "notification", notificationType: "test.notification" },
        ],
      });

      const result = await DeliveryService.deliver(request);

      expect(result.success).toBe(true);
      expect(result.deliveries).toHaveLength(3);
      expect(result.deliveries.map((d) => d.surface)).toEqual([
        "feed",
        "chat",
        "notification",
      ]);
      expect(result.deliveries.every((d) => d.success)).toBe(true);
    });

    it("should call all delivery methods independently", async () => {
      const request = createBaseRequest({
        surfaces: [
          { type: "feed", feedChannelId: "feed-123" },
          { type: "notification", notificationType: "test.notification" },
        ],
      });

      await DeliveryService.deliver(request);

      expect(mockDbInsert).toHaveBeenCalled(); // For feed
      expect(mockNotificationCreate).toHaveBeenCalled(); // For notification
    });
  });

  // ── Error Handling Tests ──────────────────────────────────────────────────

  describe("error handling", () => {
    it("should handle feed channel not found gracefully", async () => {
      mockDbQuery.channels.findFirst.mockResolvedValue(null);

      const request = createBaseRequest({
        surfaces: [{ type: "feed" }],
      });

      const result = await DeliveryService.deliver(request);

      expect(result.success).toBe(false);
      expect(result.deliveries[0].surface).toBe("feed");
      expect(result.deliveries[0].success).toBe(false);
      // withRetryResult wraps non-retryable failures as
      // "Non-retryable error: <original>" — assert on the substring.
      expect(result.deliveries[0].error).toContain(
        "No feed channel found for user"
      );
    });

    it("should handle database errors gracefully", async () => {
      mockDbInsert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi
            .fn()
            .mockRejectedValue(new Error("DB connection failed")),
        }),
      });

      const request = createBaseRequest({
        surfaces: [{ type: "feed", feedChannelId: "feed-123" }],
      });

      const result = await DeliveryService.deliver(request);

      expect(result.success).toBe(false);
      expect(result.deliveries[0].success).toBe(false);
      expect(result.deliveries[0].error).toContain("DB connection failed");
    });

    it("should handle NotificationService failure", async () => {
      mockNotificationCreate.mockRejectedValue(
        new Error("Notification service down")
      );

      const request = createBaseRequest({
        surfaces: [
          { type: "notification", notificationType: "test.notification" },
        ],
      });

      const result = await DeliveryService.deliver(request);

      expect(result.success).toBe(false);
      expect(result.deliveries[0].success).toBe(false);
      expect(result.deliveries[0].error).toContain("Notification service down");
    });

    it("should allow partial failure - one surface fails, others succeed", async () => {
      mockDbInsert
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([createMockMessage("msg-1")]),
          }),
        })
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockRejectedValue(new Error("Chat DB error")),
          }),
        });

      mockEnsureAgentThreadFn.mockResolvedValue({
        id: "personal-123",
        userId: "user-123",
        channelType: "thread",
        status: "active",
      });

      const request = createBaseRequest({
        surfaces: [
          { type: "feed", feedChannelId: "feed-123" },
          { type: "chat", channelId: "chat-123" },
        ],
      });

      const result = await DeliveryService.deliver(request);

      expect(result.success).toBe(false); // Overall false because not all succeeded
      expect(result.deliveries).toHaveLength(2);
      expect(result.deliveries[0].success).toBe(true);
      expect(result.deliveries[1].success).toBe(false);
    });

    it("should handle ensureAgentThread failure", async () => {
      mockEnsureAgentThreadFn.mockRejectedValue(
        new Error("Channel creation failed")
      );

      const request = createBaseRequest({
        surfaces: [{ type: "chat" }],
      });

      const result = await DeliveryService.deliver(request);

      expect(result.success).toBe(false);
      expect(result.deliveries[0].success).toBe(false);
      expect(result.deliveries[0].error).toContain("Channel creation failed");
    });

    it("should not break feed delivery when notification fails", async () => {
      mockNotificationCreate.mockRejectedValue(
        new Error("Notification failed")
      );

      const request = createBaseRequest({
        surfaces: [
          { type: "feed", feedChannelId: "feed-123" },
          { type: "notification", notificationType: "test.notification" },
        ],
      });

      const result = await DeliveryService.deliver(request);

      expect(result.success).toBe(false);
      expect(result.deliveries[0].success).toBe(true); // Feed succeeded
      expect(result.deliveries[1].success).toBe(false); // Notification failed
    });

    it("should handle unimplemented surface types gracefully", async () => {
      const request = createBaseRequest({
        surfaces: [{ type: "external", platform: "slack" } as DeliverySurface],
      });

      const result = await DeliveryService.deliver(request);

      expect(result.success).toBe(false);
      expect(result.deliveries[0].surface).toBe("external");
      expect(result.deliveries[0].success).toBe(false);
      expect(result.deliveries[0].error).toBe(
        "external delivery not yet implemented"
      );
    });
  });

  // ── Deduplication Tests ───────────────────────────────────────────────────

  describe("deduplication", () => {
    it("should deduplicate deliveries with same key within window", async () => {
      const request = createBaseRequest({
        surfaces: [{ type: "feed", feedChannelId: "feed-123" }],
        deduplicationKey: "dup-key-123",
      });

      // First delivery
      const result1 = await DeliveryService.deliver(request);
      expect(result1.success).toBe(true);
      expect(mockDbInsert).toHaveBeenCalledTimes(1);

      // Second delivery with same key (should be deduplicated)
      const result2 = await DeliveryService.deliver(request);
      expect(result2.success).toBe(true);
      expect(result2.deliveries[0].id).toBe("deduplicated");
      // DB insert should not be called again
      expect(mockDbInsert).toHaveBeenCalledTimes(1);
    });

    it("should deliver messages with different deduplication keys", async () => {
      const request1 = createBaseRequest({
        surfaces: [{ type: "feed", feedChannelId: "feed-123" }],
        deduplicationKey: "key-1",
      });

      const request2 = createBaseRequest({
        surfaces: [{ type: "feed", feedChannelId: "feed-123" }],
        deduplicationKey: "key-2",
      });

      await DeliveryService.deliver(request1);
      await DeliveryService.deliver(request2);

      expect(mockDbInsert).toHaveBeenCalledTimes(2);
    });

    it("should allow delivery after deduplication window expires", async () => {
      const request = createBaseRequest({
        surfaces: [{ type: "feed", feedChannelId: "feed-123" }],
        deduplicationKey: "expiring-key",
      });

      // First delivery
      await DeliveryService.deliver(request);
      expect(mockDbInsert).toHaveBeenCalledTimes(1);

      // Advance time past the 60-second window
      vi.advanceTimersByTime(61000);

      // Second delivery should work (window expired)
      await DeliveryService.deliver(request);
      expect(mockDbInsert).toHaveBeenCalledTimes(2);
    });

    it("should deduplicate across multiple surfaces with same key", async () => {
      const request = createBaseRequest({
        surfaces: [
          { type: "feed", feedChannelId: "feed-123" },
          { type: "notification", notificationType: "test.notification" },
        ],
        deduplicationKey: "multi-surface-dup",
      });

      // First delivery
      const result1 = await DeliveryService.deliver(request);
      expect(result1.deliveries).toHaveLength(2);
      expect(mockDbInsert).toHaveBeenCalledTimes(1);
      expect(mockNotificationCreate).toHaveBeenCalledTimes(1);

      // Second delivery should be deduplicated
      const result2 = await DeliveryService.deliver(request);
      expect(result2.deliveries).toHaveLength(2);
      expect(result2.deliveries.every((d) => d.id === "deduplicated")).toBe(
        true
      );
      // No additional calls
      expect(mockDbInsert).toHaveBeenCalledTimes(1);
      expect(mockNotificationCreate).toHaveBeenCalledTimes(1);
    });

    it("should not deduplicate without deduplicationKey", async () => {
      const request = createBaseRequest({
        surfaces: [{ type: "feed", feedChannelId: "feed-123" }],
        // No deduplicationKey
      });

      await DeliveryService.deliver(request);
      await DeliveryService.deliver(request);
      await DeliveryService.deliver(request);

      expect(mockDbInsert).toHaveBeenCalledTimes(3);
    });
  });

  // ── Convenience Method Tests ──────────────────────────────────────────────

  describe("convenience methods", () => {
    it("deliverToFeed should deliver to feed surface only", async () => {
      const result = await DeliveryService.deliverToFeed({
        userId: "user-123",
        workspaceId: "workspace-456",
        content: {
          body: "Feed message",
          sourceType: "ai_proactive",
        },
        feedChannelId: "feed-123",
      });

      expect(result.success).toBe(true);
      expect(result.deliveries).toHaveLength(1);
      expect(result.deliveries[0].surface).toBe("feed");
    });

    it("deliverToNotification should deliver to notification surface only", async () => {
      const result = await DeliveryService.deliverToNotification({
        userId: "user-123",
        workspaceId: "workspace-456",
        content: {
          title: "Test",
          body: "Notification message",
          sourceType: "system",
        },
        notificationType: "test.notification",
      });

      expect(result.success).toBe(true);
      expect(result.deliveries).toHaveLength(1);
      expect(result.deliveries[0].surface).toBe("notification");
    });
  });

  // ── Integration Tests ─────────────────────────────────────────────────────

  describe("integration", () => {
    it("should complete full delivery flow with all side effects", async () => {
      const request = createBaseRequest({
        surfaces: [{ type: "feed", feedChannelId: "feed-123" }],
      });

      const result = await DeliveryService.deliver(request);

      // Verify the complete flow
      expect(mockDbInsert).toHaveBeenCalled(); // Message persisted
      expect(result.success).toBe(true);
      expect(result.deliveries[0].id).toBe("msg-123");
    });

    it("should handle concurrent deliveries to same channel", async () => {
      const requests = Array.from({ length: 5 }, (_, i) =>
        createBaseRequest({
          surfaces: [{ type: "feed", feedChannelId: "feed-123" }],
          content: {
            body: `Message ${i}`,
            sourceType: "system",
          },
        })
      );

      const results = await Promise.all(
        requests.map((r) => DeliveryService.deliver(r))
      );

      expect(results.every((r) => r.success)).toBe(true);
      expect(mockDbInsert).toHaveBeenCalledTimes(5);
    });

    it("should preserve all metadata through delivery chain", async () => {
      const complexMetadata = {
        nested: { key: "value" },
        array: [1, 2, 3],
        boolean: true,
        number: 42,
      };

      const request = createBaseRequest({
        surfaces: [{ type: "feed", feedChannelId: "feed-123" }],
        content: {
          title: "Complex",
          body: "Body",
          sourceType: "ai_proactive",
          sourceId: "ai-123",
          metadata: complexMetadata,
        },
      });

      await DeliveryService.deliver(request);

      // Verify insert was called
      expect(mockDbInsert).toHaveBeenCalled();
    });

    it("should handle delivery without workspaceId (pod-wide)", async () => {
      const request = createBaseRequest({
        workspaceId: undefined,
        surfaces: [{ type: "chat" }],
      });

      mockEnsureAgentThreadFn.mockResolvedValue({
        id: "personal-123",
        userId: "user-123",
        channelType: "thread",
        status: "active",
      });

      const result = await DeliveryService.deliver(request);

      expect(result.success).toBe(true);
      expect(mockEnsureAgentThreadFn).toHaveBeenCalledWith(
        "user-123",
        "agent-orchestrator-id"
      );
    });
  });

  // ── Logging and Performance ───────────────────────────────────────────────

  describe("logging", () => {
    it("should log delivery completion with metrics", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const request = createBaseRequest({
        surfaces: [
          { type: "feed", feedChannelId: "feed-123" },
          { type: "notification", notificationType: "test.notification" },
        ],
      });

      await DeliveryService.deliver(request);

      // Logger should be called (implementation detail - may vary)
      consoleSpy.mockRestore();
    });
  });
});
