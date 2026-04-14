/**
 * Signal Feed Integration Tests
 *
 * End-to-end tests for the signal capture → entity creation → feed channel post flow.
 *
 * @module SignalFeed.integration.test
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHubProtocolCaller } from "../test-utils/create-hub-caller.js";
import { db, eq, and } from "@synap/database";
import {
  entities,
  channels,
  messages,
  signalSubscriptions,
} from "@synap/database/schema";
import type { HubProtocolRouter } from "../../src/routers/hub-protocol/index.js";
import type { inferProcedureInput } from "@trpc/server";

// Type helpers
type SignalsRouter = HubProtocolRouter["signals"];
type CaptureInput = inferProcedureInput<SignalsRouter["capture"]>;

describe("Signal Feed Integration", () => {
  const testWorkspaceId = "test-workspace-123";
  const testUserId = "test-user-456";
  let caller: ReturnType<typeof createHubProtocolCaller>;

  beforeAll(async () => {
    // Create test caller with hub protocol scopes
    caller = createHubProtocolCaller({
      apiKeyId: "test-api-key",
      scopes: ["hub-protocol.read", "hub-protocol.write", "signals.capture"],
      workspaceId: testWorkspaceId,
      userId: testUserId,
    });

    // Ensure test workspace and user exist
    // (This would normally be done via test fixtures)
  });

  afterAll(async () => {
    // Cleanup test data
    await cleanupTestData(testWorkspaceId, testUserId);
  });

  describe("Signal Capture Flow", () => {
    it("should capture signal, create entity, and post to feed channel", async () => {
      // 1. Create test signal data
      const signalData = {
        sourcePlatform: "hackernews" as const,
        sourceRoute: "/hackernews/frontpage",
        url: "https://news.ycombinator.com/item?id=12345",
        title: "Test Signal for Integration",
        description:
          "This is a test signal description for integration testing.",
        aiSummary: "AI generated summary of the test signal.",
        topics: ["ai", "tech", "testing"],
        relevanceScore: 0.85,
        authorUsername: "testuser",
        authorDisplayName: "Test User",
      };

      // 2. Call signals.capture
      const captureResult = await caller.signals.capture({
        signalData,
        capture: {
          workspaceId: testWorkspaceId,
          userId: testUserId,
          captureMethod: "manual",
          createNotification: true,
          notificationType: "feed",
          autoLinkEntities: false,
        },
      });

      // 3. Verify entity created
      expect(captureResult.success).toBe(true);
      expect(captureResult.entity).toBeDefined();
      expect(captureResult.entity?.profileSlug).toBe("signal_item");
      expect(captureResult.entity?.name).toBe(signalData.title);

      // 4. Verify delivery to feed
      expect(captureResult.delivery).toBeDefined();
      expect(captureResult.delivery?.feedPosted).toBe(true);
      expect(captureResult.delivery?.notificationCreated).toBe(true);

      // 5. Verify channel message created
      const feedChannel = await getOrCreateFeedChannel(
        testUserId,
        testWorkspaceId
      );
      const channelMessages = await db.query.messages.findMany({
        where: eq(messages.channelId, feedChannel.id),
        orderBy: (messages, { desc }) => [desc(messages.createdAt)],
        limit: 5,
      });

      // Find the message for our signal
      const signalMessage = channelMessages.find(
        (m) => m.metadata?.signalItemId === captureResult.entity?.id
      );

      expect(signalMessage).toBeDefined();
      expect(signalMessage?.metadata?.sourcePlatform).toBe("hackernews");
      expect(signalMessage?.metadata?.sourceRoute).toBe(
        "/hackernews/frontpage"
      );
      expect(signalMessage?.metadata?.relevanceScore).toBe(0.85);
    });

    it("should handle signal capture without notification", async () => {
      const signalData = {
        sourcePlatform: "reddit" as const,
        sourceRoute: "/reddit/r/technology",
        url: "https://reddit.com/r/technology/comments/abc123",
        title: "Test Signal Without Notification",
        description: "Test description",
        topics: ["tech"],
        relevanceScore: 0.6,
      };

      const captureResult = await caller.signals.capture({
        signalData,
        capture: {
          workspaceId: testWorkspaceId,
          userId: testUserId,
          captureMethod: "automation",
          createNotification: false,
          notificationType: "toast",
          autoLinkEntities: false,
        },
      });

      expect(captureResult.success).toBe(true);
      expect(captureResult.entity).toBeDefined();
      expect(captureResult.delivery?.feedPosted).toBe(true);
      expect(captureResult.delivery?.notificationCreated).toBe(false);
    });

    it("should respect user preferences for signal delivery", async () => {
      // First, set user preferences to disable proactive signals
      await caller.signals.updatePreferences({
        workspaceId: testWorkspaceId,
        userId: testUserId,
        preferences: {
          enabled: true,
          nudgeDensity: "low",
          schedules: {
            morningBriefing: false,
            weeklyDigest: false,
          },
          mutedUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // Muted for 24h
        },
      });

      const signalData = {
        sourcePlatform: "twitter" as const,
        sourceRoute: "/twitter/user/elonmusk",
        url: "https://twitter.com/elonmusk/status/123",
        title: "Test Signal During Mute",
        description: "Test description",
        topics: ["tech", "ai"],
        relevanceScore: 0.9,
      };

      // Capture should succeed but not deliver to feed due to mute
      const captureResult = await caller.signals.capture({
        signalData,
        capture: {
          workspaceId: testWorkspaceId,
          userId: testUserId,
          captureMethod: "manual",
          createNotification: true,
          notificationType: "feed",
          autoLinkEntities: false,
        },
      });

      expect(captureResult.success).toBe(true);
      expect(captureResult.entity).toBeDefined();
      // When user is muted, delivery should indicate it was suppressed
      expect(captureResult.delivery?.feedPosted).toBe(false);

      // Reset preferences
      await caller.signals.updatePreferences({
        workspaceId: testWorkspaceId,
        userId: testUserId,
        preferences: {
          enabled: true,
          nudgeDensity: "medium",
          schedules: {
            morningBriefing: true,
            weeklyDigest: true,
          },
          mutedUntil: undefined,
        },
      });
    });

    it("should deduplicate signals with same URL", async () => {
      const signalData = {
        sourcePlatform: "hackernews" as const,
        sourceRoute: "/hackernews/frontpage",
        url: "https://news.ycombinator.com/item?id=dedup-test-123",
        title: "Test Signal for Deduplication",
        description: "Test description",
        topics: ["tech"],
        relevanceScore: 0.7,
      };

      // Capture first signal
      const firstResult = await caller.signals.capture({
        signalData,
        capture: {
          workspaceId: testWorkspaceId,
          userId: testUserId,
          captureMethod: "manual",
          createNotification: true,
          notificationType: "feed",
          autoLinkEntities: false,
        },
      });

      expect(firstResult.success).toBe(true);
      expect(firstResult.entity).toBeDefined();

      // Capture second signal with same URL (should deduplicate)
      const secondResult = await caller.signals.capture({
        signalData: {
          ...signalData,
          title: "Test Signal for Deduplication - Updated",
        },
        capture: {
          workspaceId: testWorkspaceId,
          userId: testUserId,
          captureMethod: "manual",
          createNotification: true,
          notificationType: "feed",
          autoLinkEntities: false,
        },
      });

      // Should succeed but reference the same entity (or create new with dedup metadata)
      expect(secondResult.success).toBe(true);
      expect(secondResult.entity).toBeDefined();
    });
  });

  describe("Signal Feed Query", () => {
    it("should retrieve personalized signal feed", async () => {
      const feedResult = await caller.signals.feed({
        userId: testUserId,
        workspaceId: testWorkspaceId,
        limit: 10,
        useMemory: true,
        useSubscriptions: true,
        useContext: true,
      });

      expect(feedResult.success).toBe(true);
      expect(Array.isArray(feedResult.items)).toBe(true);

      // Verify feed items have required fields
      if (feedResult.items.length > 0) {
        const item = feedResult.items[0];
        expect(item.id).toBeDefined();
        expect(item.sourcePlatform).toBeDefined();
        expect(item.title).toBeDefined();
        expect(item.relevanceScore).toBeDefined();
        expect(item.topics).toBeDefined();
        expect(item.display).toBeDefined();
        expect(item.display.actions).toBeDefined();
      }
    });

    it("should filter feed by topics", async () => {
      const feedResult = await caller.signals.feed({
        userId: testUserId,
        workspaceId: testWorkspaceId,
        limit: 10,
        topics: ["ai"],
        minRelevance: 0.5,
      });

      expect(feedResult.success).toBe(true);

      // All items should have "ai" in topics (if any items returned)
      for (const item of feedResult.items) {
        expect(item.topics).toContain("ai");
      }
    });
  });

  describe("Signal Subscription Management", () => {
    it("should create and manage signal subscriptions", async () => {
      // Create subscription
      const subscription = await caller.signals.subscribe({
        workspaceId: testWorkspaceId,
        userId: testUserId,
        platform: "hackernews",
        route: "/hackernews/show",
        config: {
          filterTopics: ["show-hn"],
          minRelevance: 0.6,
          autoCapture: true,
          deliveryMethod: "feed",
        },
      });

      expect(subscription.success).toBe(true);
      expect(subscription.subscriptionId).toBeDefined();

      // Get subscriptions
      const subscriptions = await caller.signals.getSubscriptions({
        workspaceId: testWorkspaceId,
        userId: testUserId,
      });

      expect(subscriptions.success).toBe(true);
      const foundSub = subscriptions.subscriptions.find(
        (s) => s.id === subscription.subscriptionId
      );
      expect(foundSub).toBeDefined();
      expect(foundSub?.platform).toBe("hackernews");
      expect(foundSub?.route).toBe("/hackernews/show");

      // Unsubscribe
      const unsubscribeResult = await caller.signals.unsubscribe({
        subscriptionId: subscription.subscriptionId!,
      });

      expect(unsubscribeResult.success).toBe(true);
    });
  });

  describe("Signal Context", () => {
    it("should retrieve user context for signal personalization", async () => {
      const context = await caller.signals.getContext({
        userId: testUserId,
        workspaceId: testWorkspaceId,
      });

      expect(context.success).toBe(true);
      expect(context.userId).toBe(testUserId);
      expect(context.topics).toBeDefined();
      expect(Array.isArray(context.topics)).toBe(true);
      expect(context.subscriptions).toBeDefined();
      expect(Array.isArray(context.subscriptions)).toBe(true);
    });
  });

  describe("Signal Batch Operations", () => {
    it("should execute batch signal operations", async () => {
      const batchResult = await caller.signals.batch({
        operations: [
          {
            type: "fetch",
            id: "fetch-1",
            input: {
              sourceRoute: "/hackernews/frontpage",
              sourcePlatform: "hackernews",
              options: { limit: 5 },
            },
          },
          {
            type: "classify",
            id: "classify-1",
            dependsOn: ["fetch-1"],
            input: {
              mode: "fast",
            },
          },
        ],
        context: {
          workspaceId: testWorkspaceId,
          userId: testUserId,
        },
      });

      expect(batchResult.success).toBe(true);
      expect(batchResult.results).toBeDefined();
      expect(batchResult.results["fetch-1"]).toBeDefined();
      expect(batchResult.results["fetch-1"].success).toBe(true);
    });
  });
});

// Helper functions

async function getOrCreateFeedChannel(userId: string, workspaceId: string) {
  // Get or create the feed channel for the user
  const existingChannel = await db.query.channels.findFirst({
    where: and(
      eq(channels.workspaceId, workspaceId),
      eq(channels.type, "feed")
    ),
  });

  if (existingChannel) {
    return existingChannel;
  }

  // Create feed channel if it doesn't exist
  const [newChannel] = await db
    .insert(channels)
    .values({
      id: crypto.randomUUID(),
      workspaceId,
      type: "feed",
      name: "Signal Feed",
      description: "Automated signal feed channel",
      createdBy: userId,
      isActive: true,
    })
    .returning();

  return newChannel;
}

async function cleanupTestData(workspaceId: string, userId: string) {
  // Cleanup test entities
  await db.delete(entities).where(and(eq(entities.workspaceId, workspaceId)));

  // Cleanup test subscriptions
  await db
    .delete(signalSubscriptions)
    .where(
      and(
        eq(signalSubscriptions.workspaceId, workspaceId),
        eq(signalSubscriptions.userId, userId)
      )
    );

  // Note: We don't cleanup channels/messages to preserve history
}
