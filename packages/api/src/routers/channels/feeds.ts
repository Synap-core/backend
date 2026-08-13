/**
 * Channels Router - tRPC routes for channels (conversations) with branching
 *
 * Handles:
 * - Channel management (channels table, was chat_threads)
 * - Message sending/receiving with Intelligence Hub
 * - Entity extraction
 * - Branching logic
 * - Context tracking via channel_context_items
 */

import { z } from "zod";
import { protectedProcedure } from "../../trpc.js";

import { db, eq, asc, and, drizzleSql } from "@synap/database";
import {
  channels,
  ChannelType,
  FeedScope,
  ChannelStatus,
  sourceConfigs,
  sourceSubscriptions,
} from "@synap/database/schema";

import { ensureProactiveFeedChannel } from "../../utils/personal-channel.js";

import { randomUUID } from "crypto";
import { createLogger } from "@synap-core/core";

import { deriveFeedQueries, listChannelsWithFlags } from "./helpers.js";

const logger = createLogger({ module: "channels" });

export const feedsProcedures = {
  /**
   * List only feed channels.
   */
  listFeeds: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().optional(),
        feedScope: z.enum([FeedScope.USER, FeedScope.WORKSPACE]).optional(),
        limit: z.number().min(1).max(100).default(20),
        offset: z.number().min(0).default(0),
      })
    )
    .query(async ({ input, ctx }) => {
      const items = await listChannelsWithFlags({
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        channelType: ChannelType.FEED,
        feedScope: input.feedScope,
        limit: input.limit + 1,
        offset: input.offset,
      });

      const hasMore = items.length > input.limit;
      const trimmed = hasMore ? items.slice(0, input.limit) : items;
      return {
        items: trimmed,
        pagination: {
          hasMore,
          limit: input.limit,
          offset: input.offset,
        },
      };
    }),

  /**
   * Upsert a personal feed channel for the caller and attach source
   * subscriptions to it. Called by Relay onboarding (and feed settings) to
   * materialise a user's feed preferences into real backend resources.
   *
   * Idempotent: returns the existing feed channel if one already exists.
   * Each source is matched by URL — duplicate URLs are skipped.
   */
  /**
   * Set up (or update) the user's personal feed channel for a given archetype.
   * Resolves the pre-provisioned source_config for the archetype (seeded by CP
   * at pod provisioning time) and creates a subscription linking it to the
   * user's feed channel.
   *
   * Idempotent: calling again for the same archetype returns the existing
   * channelId without creating duplicates.
   */
  setupFeed: protectedProcedure
    .input(
      z.object({
        archetype: z.enum([
          "leads",
          "hiring",
          "investors",
          "trends",
          "competitors",
          "press",
        ]),
        /** NL context forwarded to IS for relevance scoring */
        criteria: z.string().max(1000).optional(),
        /** Cron schedule — defaults to every 15 minutes */
        scheduleCron: z.string().optional(),
        /** Relevance threshold 0-100 */
        relevanceThreshold: z.number().min(0).max(100).optional(),
        /** Channel display name — defaults to archetype label */
        name: z.string().min(1).max(255).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.userId;

      // 1. Resolve the archetype source_config seeded by CP provisioning
      let archetypeConfig = await db.query.sourceConfigs.findFirst({
        where: and(
          eq(sourceConfigs.userId, userId),
          drizzleSql`metadata->>'archetype' = ${input.archetype}`,
          drizzleSql`metadata->>'isArchetypeSeed' = 'true'`
        ),
      });

      if (!archetypeConfig) {
        // Self-hosted pod with no CP provisioning — auto-seed a default
        // http-api source config using the HN Algolia JSON API so feeds
        // work out of the box without a Control Plane.
        const ARCHETYPE_SOURCES: Record<
          string,
          { name: string; endpoint: string; query: string }
        > = {
          leads: {
            name: "HN Hiring (default)",
            endpoint: "https://hn.algolia.com/api/v1/search",
            query: "tags=ask_hn,hiring&hitsPerPage=25",
          },
          hiring: {
            name: "HN Who's Hiring (default)",
            endpoint: "https://hn.algolia.com/api/v1/search",
            query: "tags=ask_hn,hiring&hitsPerPage=25",
          },
          investors: {
            name: "HN Funding News (default)",
            endpoint: "https://hn.algolia.com/api/v1/search",
            query: "query=seed+funding+venture&tags=story&hitsPerPage=25",
          },
          trends: {
            name: "HN Trending (default)",
            endpoint: "https://hn.algolia.com/api/v1/search",
            query: "tags=front_page&hitsPerPage=25",
          },
          competitors: {
            name: "HN Tech News (default)",
            endpoint: "https://hn.algolia.com/api/v1/search",
            query: "query=startup+product+launch&tags=story&hitsPerPage=25",
          },
          press: {
            name: "HN Press (default)",
            endpoint: "https://hn.algolia.com/api/v1/search",
            query: "query=announcement+launch&tags=story&hitsPerPage=25",
          },
        };
        const src =
          ARCHETYPE_SOURCES[input.archetype] ?? ARCHETYPE_SOURCES.trends!;
        const [seeded] = await db
          .insert(sourceConfigs)
          .values({
            id: randomUUID(),
            userId,
            workspaceId: null,
            providerType: "http-api",
            name: src.name,
            config: {
              endpoint: `${src.endpoint}?${src.query}`,
              method: "GET",
              itemsPath: "hits",
              mapping: {
                title: "title",
                url: "url",
                externalId: "objectID",
                publishedAt: "created_at",
                excerpt: "story_text",
                author: "author",
              },
            },
            metadata: {
              archetype: input.archetype,
              isArchetypeSeed: true,
              selfHostedDefault: true,
            },
            enabled: true,
          })
          .returning();
        archetypeConfig = seeded!;
      }

      // 2. Resolve the user's personal feed channel through the ONE race-safe
      //    door (one feed per user, dedups against channels_user_feed_uniq) —
      //    NOT a hand-rolled findFirst+insert (a duplication vector). If the feed
      //    has no title yet, label it from the archetype for a nicer first run.
      const feedChannel = await ensureProactiveFeedChannel(userId);
      if (!feedChannel.title) {
        const archetypeLabels: Record<string, string> = {
          leads: "Leads",
          hiring: "Hiring",
          investors: "Investors",
          trends: "Trends",
          competitors: "Competitors",
          press: "Press",
        };
        const title =
          input.name ?? archetypeLabels[input.archetype] ?? "My Feed";
        await db
          .update(channels)
          .set({ title, updatedAt: new Date() })
          .where(eq(channels.id, feedChannel.id));
      }

      const channelId = feedChannel.id;

      // 3. Expand archetype + criteria into concrete fetch targets via the CP query planner.
      //    Best-effort: derivedQueries is [] if the CP isn't configured or plan-queries fails.
      const derivedQueries = await deriveFeedQueries(
        archetypeConfig,
        input.archetype,
        input.criteria
      );

      // 4. Upsert subscription — idempotent by (sourceConfigId, feedId)
      const existingSub = await db.query.sourceSubscriptions.findFirst({
        where: and(
          eq(sourceSubscriptions.sourceConfigId, archetypeConfig.id),
          drizzleSql`${sourceSubscriptions.feedId} = ${channelId}`
        ),
      });

      let subscriptionId: string | null = existingSub?.id ?? null;

      if (!existingSub) {
        const [newSub] = await db
          .insert(sourceSubscriptions)
          .values({
            id: randomUUID(),
            userId,
            workspaceId: null,
            sourceConfigId: archetypeConfig.id,
            feedId: channelId,
            status: "active",
            params: {
              feedType: input.archetype,
              scheduleCron: input.scheduleCron ?? "*/15 * * * *",
              agentConfig: {
                feedType: input.archetype,
                criteria: input.criteria ?? "",
                minRelevanceScore: input.relevanceThreshold
                  ? input.relevanceThreshold / 100
                  : 0,
              },
              ...(derivedQueries.length > 0 && { derivedQueries }),
            },
          })
          .returning();
        subscriptionId = newSub.id;
      } else if (
        input.criteria ||
        input.scheduleCron ||
        input.relevanceThreshold !== undefined
      ) {
        // Update criteria/schedule and refresh derived queries on existing subscription
        await db
          .update(sourceSubscriptions)
          .set({
            params: {
              feedType: input.archetype,
              scheduleCron: input.scheduleCron ?? "*/15 * * * *",
              agentConfig: {
                feedType: input.archetype,
                criteria: input.criteria ?? "",
                minRelevanceScore: input.relevanceThreshold
                  ? input.relevanceThreshold / 100
                  : 0,
              },
              ...(derivedQueries.length > 0 && { derivedQueries }),
            },
            updatedAt: new Date(),
          })
          .where(eq(sourceSubscriptions.id, existingSub.id));
      }

      logger.info(
        { userId, channelId, archetype: input.archetype, subscriptionId },
        "Feed setup complete"
      );

      return { channelId, subscriptionId };
    }),

  /**
   * Return the user's personal feed channel and its active subscriptions.
   * Optionally filter subscriptions by archetype.
   */
  getFeedChannel: protectedProcedure
    .input(
      z.object({
        archetype: z
          .enum([
            "leads",
            "hiring",
            "investors",
            "trends",
            "competitors",
            "press",
          ])
          .optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.userId;

      const channel = await db.query.channels.findFirst({
        where: and(
          eq(channels.userId, userId),
          eq(channels.channelType, ChannelType.FEED),
          eq(channels.feedScope, FeedScope.USER),
          // Active only + oldest-wins, so a post-0182 'merged' duplicate feed is
          // never returned (which would key the subscriptions query on a dead id).
          eq(channels.status, ChannelStatus.ACTIVE)
        ),
        orderBy: [asc(channels.createdAt)],
      });

      if (!channel) return { channel: null, subscriptions: [] };

      const subs = await db.query.sourceSubscriptions.findMany({
        where: and(
          drizzleSql`${sourceSubscriptions.feedId} = ${channel.id}`,
          eq(sourceSubscriptions.status, "active")
        ),
      });

      const filtered = input.archetype
        ? subs.filter(
            (s) =>
              (s.params as Record<string, unknown>)?.feedType ===
              input.archetype
          )
        : subs;

      return { channel, subscriptions: filtered };
    }),

  // ── Multiplayer room membership (Wave 1 foundation) ───────────────────────
  //
  // Add / remove AI teammates and list room members (humans + teammates). The
  // later routing-engine pass consumes channel_members + the per-teammate
  // capability flags written here; it adds no new membership surface.
};
