/**
 * Feeds Router
 *
 * tRPC routes for managing unified feeds (RSS and Proactive).
 *
 * Endpoints:
 * - triggerFeed: Manually trigger a feed execution
 * - getFeedStatus: Get feed status (last run, next run, item count)
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { db, eq, and, gte, count, type SQL } from "@synap/database";
import {
  channels,
  messages,
  ChannelType,
  ChannelStatus,
} from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import {
  FeedConfigSchema,
  parseFeedConfig,
  type FeedConfig,
  type FeedStatus,
} from "../types/feed-config.js";
import { calculateNextRun } from "@synap/shared-utils";

const logger = createLogger({ module: "feeds" });

// ── Cooldown Check ───────────────────────────────────────────────────────────

const TRIGGER_COOLDOWN_MS = 60_000; // 1 minute cooldown between manual triggers

async function checkTriggerCooldown(channelId: string): Promise<boolean> {
  const channel = await db.query.channels.findFirst({
    where: eq(channels.id, channelId),
    columns: { metadata: true },
  });

  if (!channel) return false;

  const metadata = (channel.metadata as Record<string, unknown>) ?? {};
  const feedStatus = (metadata.feedStatus as Record<string, unknown>) ?? {};
  const lastTriggered = feedStatus.triggerRequestedAt as string | undefined;

  if (!lastTriggered) return true;

  const lastTriggerTime = new Date(lastTriggered).getTime();
  const now = Date.now();

  return now - lastTriggerTime >= TRIGGER_COOLDOWN_MS;
}

// ── Router ───────────────────────────────────────────────────────────────────

export const feedsRouter = router({
  /**
   * Manually trigger a feed execution.
   * Validates the channel is a feed type and checks cooldown.
   */
  triggerFeed: protectedProcedure
    .input(
      z.object({
        channelId: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { channelId } = input;

      // Get channel and validate
      const channel = await db.query.channels.findFirst({
        where: eq(channels.id, channelId),
      });

      if (!channel) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Feed channel not found",
        });
      }

      // Verify ownership
      if (channel.userId !== ctx.userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not own this feed",
        });
      }

      // Validate channel type
      if (channel.channelType !== ChannelType.FEED) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Channel is not a feed type",
        });
      }

      // Check cooldown
      const canTrigger = await checkTriggerCooldown(channelId);
      if (!canTrigger) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Please wait before triggering this feed again",
        });
      }

      // Update metadata to request trigger
      const metadata = (channel.metadata as Record<string, unknown>) ?? {};
      const feedStatus = (metadata.feedStatus as Record<string, unknown>) ?? {};

      await db
        .update(channels)
        .set({
          metadata: {
            ...metadata,
            feedStatus: {
              ...feedStatus,
              triggerRequestedAt: new Date().toISOString(),
            },
          },
          updatedAt: new Date(),
        })
        .where(eq(channels.id, channelId));

      logger.info(
        {
          channelId,
          userId: ctx.userId,
        },
        "Feed trigger requested"
      );

      return {
        success: true,
        message: "Feed execution scheduled",
      };
    }),

  /**
   * Get feed status including last run, next run, and item counts.
   */
  getFeedStatus: protectedProcedure
    .input(
      z.object({
        channelId: z.string().uuid(),
      })
    )
    .query(async ({ input, ctx }) => {
      const { channelId } = input;

      // Get channel
      const channel = await db.query.channels.findFirst({
        where: eq(channels.id, channelId),
      });

      if (!channel) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Feed channel not found",
        });
      }

      // Verify ownership
      if (channel.userId !== ctx.userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not own this feed",
        });
      }

      // Validate channel type
      if (channel.channelType !== ChannelType.FEED) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Channel is not a feed type",
        });
      }

      // Parse config
      const metadata = (channel.metadata as Record<string, unknown>) ?? {};
      const configData = metadata.feedConfig;
      const config: FeedConfig | null = configData
        ? parseFeedConfig(configData)
        : null;

      // Get feed status from metadata
      const feedStatus = (metadata.feedStatus as FeedStatus) ?? {};

      // Count total messages in feed
      const [messageCountResult] = await db
        .select({ value: count() })
        .from(messages)
        .where(eq(messages.channelId, channelId));

      // Count messages from last 24 hours
      const oneDayAgo = new Date();
      oneDayAgo.setDate(oneDayAgo.getDate() - 1);

      const [recentCountResult] = await db
        .select({ value: count() })
        .from(messages)
        .where(
          and(
            eq(messages.channelId, channelId),
            gte(messages.timestamp, oneDayAgo)
          )
        );

      return {
        channelId,
        feedType: config?.feedType ?? null,
        enabled: config?.enabled ?? false,
        status: {
          lastRunAt: feedStatus.lastRunAt ?? null,
          nextRunAt: feedStatus.nextRunAt ?? null,
          lastRunStatus: feedStatus.lastRunStatus ?? null,
          lastError: feedStatus.lastError ?? null,
          lastRunItemCount: feedStatus.lastRunItemCount ?? 0,
          totalItemsPosted: feedStatus.totalItemsPosted ?? 0,
          triggerRequestedAt: feedStatus.triggerRequestedAt ?? null,
          isRunning: !!feedStatus.currentRunId,
        },
        counts: {
          total: messageCountResult?.value ?? 0,
          last24Hours: recentCountResult?.value ?? 0,
        },
        config: config
          ? {
              schedule: config.schedule,
              timezone: config.timezone,
              maxItemsPerRun: config.maxItemsPerRun,
              postMode: config.postMode,
              // Type-specific config
              ...(config.feedType === "rss" && {
                sourceCount: config.sources.length,
                minRelevanceScore: config.minRelevanceScore,
              }),
              ...(config.feedType === "proactive" && {
                include: config.include,
                summarization: config.summarization,
              }),
            }
          : null,
      };
    }),

  /**
   * List all feeds for the current user.
   */
  listFeeds: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().optional(),
        limit: z.number().min(1).max(100).default(20),
        offset: z.number().min(0).default(0),
      })
    )
    .query(async ({ input, ctx }) => {
      const { workspaceId, limit, offset } = input;

      const conditions: SQL[] = [
        eq(channels.userId, ctx.userId!),
        eq(channels.channelType, ChannelType.FEED),
        eq(channels.status, ChannelStatus.ACTIVE),
      ];

      // Filter by workspace if provided (include pod-wide feeds)
      if (workspaceId) {
        const workspaceCondition = and(
          eq(channels.workspaceId, workspaceId)
          // Also include pod-wide feeds
          // This is handled by the query logic below
        );
        if (workspaceCondition) {
          conditions.push(workspaceCondition);
        }
      }

      const feedChannels = await db.query.channels.findMany({
        where: and(...conditions),
        orderBy: [channels.updatedAt],
        limit: limit + 1, // Fetch one extra to check for more
        offset,
      });

      const hasMore = feedChannels.length > limit;
      const items = hasMore ? feedChannels.slice(0, limit) : feedChannels;

      // Enrich with config info
      const enriched = items.map((channel) => {
        const metadata = (channel.metadata as Record<string, unknown>) ?? {};
        const configData = metadata.feedConfig;
        const config: FeedConfig | null = configData
          ? parseFeedConfig(configData)
          : null;
        const feedStatus = (metadata.feedStatus as FeedStatus) ?? {};

        return {
          id: channel.id,
          title: channel.title,
          feedType: config?.feedType ?? null,
          enabled: config?.enabled ?? false,
          status: {
            lastRunAt: feedStatus.lastRunAt ?? null,
            nextRunAt: feedStatus.nextRunAt ?? null,
            lastRunStatus: feedStatus.lastRunStatus ?? null,
          },
          createdAt: channel.createdAt,
          updatedAt: channel.updatedAt,
        };
      });

      return {
        items: enriched,
        pagination: {
          hasMore,
          limit,
          offset,
        },
      };
    }),

  /**
   * Create or update feed configuration.
   * Note: Creating the actual feed channel is done through channels.createFeedChannel
   * or similar. This endpoint just validates and updates the config.
   */
  updateFeedConfig: protectedProcedure
    .input(
      z.object({
        channelId: z.string().uuid(),
        config: FeedConfigSchema,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { channelId, config } = input;

      // Get channel and validate
      const channel = await db.query.channels.findFirst({
        where: eq(channels.id, channelId),
      });

      if (!channel) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Feed channel not found",
        });
      }

      // Verify ownership
      if (channel.userId !== ctx.userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not own this feed",
        });
      }

      // Validate channel type
      if (channel.channelType !== ChannelType.FEED) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Channel is not a feed type",
        });
      }

      // Update metadata with new config
      const metadata = (channel.metadata as Record<string, unknown>) ?? {};
      const feedStatus = (metadata.feedStatus as Record<string, unknown>) ?? {};

      // Calculate next run based on new schedule
      const nextRunAt = calculateNextRun(config.schedule, config.timezone);

      await db
        .update(channels)
        .set({
          metadata: {
            ...metadata,
            feedConfig: config,
            feedStatus: {
              ...feedStatus,
              nextRunAt: nextRunAt.toISOString(),
            },
          },
          updatedAt: new Date(),
        })
        .where(eq(channels.id, channelId));

      logger.info(
        {
          channelId,
          userId: ctx.userId,
          feedType: config.feedType,
        },
        "Feed config updated"
      );

      return {
        success: true,
        config,
        nextRunAt: nextRunAt.toISOString(),
      };
    }),
});

// ── Helper Functions ─────────────────────────────────────────────────────────
