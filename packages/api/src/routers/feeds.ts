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
import { db, eq, and, gte, count, desc, type SQL } from "@synap/database";
import {
  channels,
  messages,
  feeds,
  sourceSubscriptions,
  FEED_TYPES,
  FEED_STATUSES,
  ChannelType,
  ChannelStatus,
  ChannelScope,
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

  // ── Phase 4: typed feeds table (Person / Ecosystem researchers) ────────────
  //
  // These endpoints operate on the dedicated `feeds` table (migration 0007).
  // They coexist with the legacy metadata-based endpoints above, which remain
  // for backwards compatibility with existing proactive/rss feeds.
  //
  // Agent 1 is concurrently building `source_configs` + `source_subscriptions`.
  // The `sources` input on `create` is accepted but not written to the
  // subscription table here — when Agent 1's work lands the subscription
  // insert can be wired in alongside the feed insert.

  list: protectedProcedure
    .input(
      z
        .object({
          workspaceId: z.string().uuid().optional(),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      const conditions: SQL[] = [eq(feeds.userId, ctx.userId)];
      if (input?.workspaceId) {
        conditions.push(eq(feeds.workspaceId, input.workspaceId));
      }
      const rows = await db
        .select()
        .from(feeds)
        .where(and(...conditions))
        .orderBy(desc(feeds.updatedAt));
      return { feeds: rows };
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const feed = await db.query.feeds.findFirst({
        where: eq(feeds.id, input.id),
      });
      if (!feed) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Feed not found" });
      }
      if (feed.userId !== ctx.userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not own this feed",
        });
      }
      const subscriptions = await db
        .select()
        .from(sourceSubscriptions)
        .where(eq(sourceSubscriptions.feedId, feed.id));
      return { feed, subscriptions };
    }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(200),
        feedType: z.enum(FEED_TYPES),
        criteria: z.string().min(1).max(2000),
        workspaceId: z.string().uuid().nullable().optional(),
        sources: z
          .array(
            z.object({
              sourceConfigId: z.string().uuid(),
              params: z.record(z.string(), z.unknown()).optional(),
            })
          )
          .default([]),
        scheduleCron: z.string().min(1).max(100).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Create the backing FEED-type channel first so channelId is stable.
      const [channel] = await db
        .insert(channels)
        .values({
          userId: ctx.userId,
          workspaceId: input.workspaceId ?? null,
          title: input.name,
          channelType: ChannelType.FEED,
          scope: input.workspaceId ? ChannelScope.WORKSPACE : ChannelScope.POD,
          status: ChannelStatus.ACTIVE,
          metadata: {
            feedKind: "researcher",
            feedType: input.feedType,
          },
        })
        .returning();

      if (!channel) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create feed channel",
        });
      }

      const [feed] = await db
        .insert(feeds)
        .values({
          userId: ctx.userId,
          workspaceId: input.workspaceId ?? null,
          name: input.name,
          feedType: input.feedType,
          criteria: input.criteria,
          channelId: channel.id,
          scheduleCron: input.scheduleCron ?? "*/15 * * * *",
          status: "active",
        })
        .returning();

      if (!feed) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create feed",
        });
      }

      // Persist subscriptions binding this feed to each selected source config.
      if (input.sources.length > 0) {
        await db.insert(sourceSubscriptions).values(
          input.sources.map((s) => ({
            userId: ctx.userId,
            workspaceId: input.workspaceId ?? null,
            feedId: feed.id,
            sourceConfigId: s.sourceConfigId,
            params: s.params ?? {},
            status: "active" as const,
          }))
        );
      }

      logger.info(
        {
          feedId: feed.id,
          channelId: channel.id,
          feedType: input.feedType,
          sourceCount: input.sources.length,
          userId: ctx.userId,
        },
        "Feed created (Phase 4)"
      );

      return { feed };
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        patch: z
          .object({
            name: z.string().min(1).max(200).optional(),
            criteria: z.string().min(1).max(2000).optional(),
            scheduleCron: z.string().min(1).max(100).optional(),
            status: z.enum(FEED_STATUSES).optional(),
          })
          .refine((p) => Object.keys(p).length > 0, {
            message: "patch must include at least one field",
          }),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const existing = await db.query.feeds.findFirst({
        where: eq(feeds.id, input.id),
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Feed not found" });
      }
      if (existing.userId !== ctx.userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not own this feed",
        });
      }
      const [updated] = await db
        .update(feeds)
        .set({ ...input.patch, updatedAt: new Date() })
        .where(eq(feeds.id, input.id))
        .returning();
      return { feed: updated };
    }),

  pause: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const existing = await db.query.feeds.findFirst({
        where: eq(feeds.id, input.id),
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Feed not found" });
      }
      if (existing.userId !== ctx.userId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Forbidden" });
      }
      const [updated] = await db
        .update(feeds)
        .set({ status: "paused", updatedAt: new Date() })
        .where(eq(feeds.id, input.id))
        .returning();
      return { feed: updated };
    }),

  resume: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const existing = await db.query.feeds.findFirst({
        where: eq(feeds.id, input.id),
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Feed not found" });
      }
      if (existing.userId !== ctx.userId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Forbidden" });
      }
      const [updated] = await db
        .update(feeds)
        .set({
          status: "active",
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(feeds.id, input.id))
        .returning();
      return { feed: updated };
    }),

  delete: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        deleteChannel: z.boolean().default(false),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const existing = await db.query.feeds.findFirst({
        where: eq(feeds.id, input.id),
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Feed not found" });
      }
      if (existing.userId !== ctx.userId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Forbidden" });
      }

      // source_subscriptions cascade-delete via FK (see schema/source-configs.ts).
      await db.delete(feeds).where(eq(feeds.id, input.id));

      if (input.deleteChannel) {
        await db.delete(channels).where(eq(channels.id, existing.channelId));
      }

      logger.info(
        {
          feedId: input.id,
          deletedChannel: input.deleteChannel,
          userId: ctx.userId,
        },
        "Feed deleted"
      );

      return { success: true };
    }),
});

// ── Helper Functions ─────────────────────────────────────────────────────────
