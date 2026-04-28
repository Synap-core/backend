/**
 * Feeds Router (tRPC)
 *
 * User-facing unified feed view surface. Aggregates subscription data with
 * recent fetch results to build a timeline of feed items across all sources.
 *
 * This router replaces the legacy `chat.listFeeds` (channelType=FEED) query
 * for the new source_subscriptions system. It provides a clean API for the
 * reusable `@synap/feed` frontend package.
 *
 * Access model: `protectedProcedure` — users access their own feeds.
 *
 * Procedures:
 *   list              — subscriptions with health summary + source config info
 *   recentItems       — recent feed items (via subscription cursor-based query)
 *   updateLastFetched — mark a subscription as fetched (used by executor)
 *   healthSummary     — aggregate health metrics for dashboard widgets
 */

import { z } from "zod";
import {
  db,
  eq,
  and,
  or,
  isNull,
  desc,
  count,
  drizzleSql,
} from "@synap/database";
import { sourceSubscriptions, sourceConfigs } from "@synap/database/schema";
import { router, protectedProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";

// ── Input schemas ────────────────────────────────────────────────────────────

const statusSchema = z.enum(["active", "paused", "error"]);

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fetch subscriptions with an eager source_config JOIN.
 * Returns flat projection for listing.
 */
async function listSubscriptionsWithConfig(
  userId: string,
  whereConditions: any[]
) {
  return await db
    .select({
      id: sourceSubscriptions.id,
      feedId: sourceSubscriptions.feedId,
      params: sourceSubscriptions.params,
      cursor: sourceSubscriptions.cursor,
      lastFetchedAt: sourceSubscriptions.lastFetchedAt,
      lastItemAt: sourceSubscriptions.lastItemAt,
      status: sourceSubscriptions.status,
      errorMessage: sourceSubscriptions.errorMessage,
      sourceConfig: {
        id: sourceConfigs.id,
        name: sourceConfigs.name,
        providerType: sourceConfigs.providerType,
        enabled: sourceConfigs.enabled,
      },
    })
    .from(sourceSubscriptions)
    .innerJoin(
      sourceConfigs,
      eq(sourceSubscriptions.sourceConfigId, sourceConfigs.id)
    )
    .where(and(eq(sourceSubscriptions.userId, userId), ...whereConditions))
    .orderBy(desc(sourceSubscriptions.updatedAt));
}

// ── Router ───────────────────────────────────────────────────────────────────

export const feedsRouter = router({
  /**
   * List all user subscriptions with their source config summary.
   * Use this for "My feeds" views.
   */
  list: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().optional(),
        sourceConfigId: z.string().uuid().optional(),
        status: statusSchema.optional(),
        limit: z.number().min(1).max(100).default(50),
        offset: z.number().min(0).default(0),
      })
    )
    .query(async ({ input, ctx }) => {
      const conditions: any[] = [];

      // Workspace filtering: user's workspace + global subscriptions
      if (input.workspaceId) {
        conditions.push(
          or(
            eq(sourceSubscriptions.workspaceId, input.workspaceId),
            isNull(sourceSubscriptions.workspaceId)
          )
        );
      }

      if (input.sourceConfigId) {
        conditions.push(
          eq(sourceSubscriptions.sourceConfigId, input.sourceConfigId)
        );
      }

      if (input.status) {
        conditions.push(eq(sourceSubscriptions.status, input.status));
      }

      const rows = await listSubscriptionsWithConfig(ctx.userId, conditions);

      return rows.map((row) => {
        const params = (row.params ?? {}) as Record<string, unknown>;
        const dqs = params.derivedQueries as
          | Array<{ upstreamType: string; label: string }>
          | undefined;
        return {
          ...row,
          derivedQueryCount: dqs?.length ?? 0,
          derivedQueries: dqs?.map((q) => ({
            upstreamType: q.upstreamType,
            label: q.label,
          })),
        };
      });
    }),

  /**
   * Get recent feed items from a subscription via its cursor.
   * This is a lightweight snapshot — actual item data lives in
   * the `messages` table under the feed channel (legacy path) or
   * via the `entities` table for new bookmark entities.
   *
   * For now, returns subscription metadata with health indicators.
   * Actual item retrieval will use the chat.getMessages API.
   */
  recentItems: protectedProcedure
    .input(
      z.object({
        subscriptionId: z.string().uuid(),
        limit: z.number().min(1).max(100).default(20),
      })
    )
    .query(async ({ input, ctx }) => {
      const sub = await db.query.sourceSubscriptions.findFirst({
        where: and(
          eq(sourceSubscriptions.id, input.subscriptionId),
          eq(sourceSubscriptions.userId, ctx.userId)
        ),
      });

      if (!sub) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Subscription not found",
        });
      }

      // Return subscription metadata with health indicators.
      // Actual message items come from chat.getMessages (feed channel).
      return {
        subscription: {
          id: sub.id,
          feedId: sub.feedId,
          status: sub.status,
          lastFetchedAt: sub.lastFetchedAt,
          lastItemAt: sub.lastItemAt,
          errorMessage: sub.errorMessage,
        },
        messageLimit: input.limit,
        note: "Actual message items are retrieved via trpc.chat.getMessages with the feed channel threadId",
      };
    }),

  /**
   * Mark a subscription as fetched (update lastFetchedAt).
   * This is the executor worker's callback after a successful fetch.
   */
  updateLastFetched: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        cursor: z.string().optional(),
        lastItemAt: z.coerce.date().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const [row] = await db
        .update(sourceSubscriptions)
        .set({
          lastFetchedAt: new Date(),
          ...(input.cursor && { cursor: input.cursor }),
          ...(input.lastItemAt && { lastItemAt: input.lastItemAt }),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(sourceSubscriptions.id, input.id),
            eq(sourceSubscriptions.userId, ctx.userId)
          )
        )
        .returning();

      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Subscription not found",
        });
      }

      return row;
    }),

  /**
   * Aggregate health metrics for dashboard widgets.
   * Used by the home bento "feed health" card.
   */
  healthSummary: protectedProcedure.query(async ({ ctx }) => {
    const all = await db
      .select({ status: sourceSubscriptions.status })
      .from(sourceSubscriptions)
      .where(eq(sourceSubscriptions.userId, ctx.userId));

    const total = all.length;
    const active = all.filter((s) => s.status === "active").length;
    const paused = all.filter((s) => s.status === "paused").length;
    const error = all.filter((s) => s.status === "error").length;

    // Recent fetches: subscriptions fetched in last 24 hours
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentFetches = await db
      .select({ count: count() })
      .from(sourceSubscriptions)
      .where(
        and(
          eq(sourceSubscriptions.userId, ctx.userId),
          or(
            isNull(sourceSubscriptions.lastFetchedAt),
            drizzleSql`${sourceSubscriptions.lastFetchedAt} >= ${cutoff}`
          )
        )
      );

    return {
      total,
      active,
      paused,
      error,
      recentlyFetched: recentFetches[0]?.count ?? 0,
      lastRefreshed: new Date(),
    };
  }),

  /**
   * Count subscriptions by source config for UI grouping.
   */
  countBySourceConfig: protectedProcedure.query(async ({ ctx }) => {
    const rows = await db
      .select({
        sourceConfigId: sourceSubscriptions.sourceConfigId,
        sourceConfigName: sourceConfigs.name,
        providerType: sourceConfigs.providerType,
        count: count(),
      })
      .from(sourceSubscriptions)
      .leftJoin(
        sourceConfigs,
        eq(sourceSubscriptions.sourceConfigId, sourceConfigs.id)
      )
      .where(eq(sourceSubscriptions.userId, ctx.userId))
      .groupBy(
        sourceSubscriptions.sourceConfigId,
        sourceConfigs.name,
        sourceConfigs.providerType
      );

    return rows;
  }),
});
