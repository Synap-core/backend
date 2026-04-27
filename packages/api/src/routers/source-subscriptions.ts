/**
 * Source Subscriptions Router (tRPC)
 *
 * User-scoped CRUD for managing feed subscriptions. Each subscription binds
 * a `feedId` (opaque UUID) to a `sourceConfig` with per-feed params and cursor.
 *
 * This router is the user-facing surface that the reusable `@synap/feed`
 * frontend package consumes. Source config management (provider registration,
 * credential vault refs) remains behind `sourceConfigsRouter` (podAdmin).
 *
 * Access model: `protectedProcedure` — users CRUD their own subscriptions.
 *
 * Lifecycle status values: active | paused | error
 *
 * Procedures:
 *   list              — user's subscriptions (with source config summary)
 *   listBySourceConfig — subscriptions tied to one source config
 *   get                — single subscription with eager source_config
 *   create            — new subscription for an existing source config
 *   update            — patch params/status
 *   delete           — remove a subscription
 *   pause            — set status = 'paused'
 *   resume           — set status = 'active'
 */

import { z } from "zod";
import { db, eq, and, or, isNull, desc } from "@synap/database";
import { sourceSubscriptions, sourceConfigs } from "@synap/database/schema";
import { router, protectedProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "source-subs-router" });

// ── Input schemas ────────────────────────────────────────────────────────────

const statusSchema = z.enum(["active", "paused", "error"]);

const createInputSchema = z.object({
  feedId: z.string().uuid(),
  sourceConfigId: z.string().uuid(),
  params: z.record(z.string(), z.unknown()).default({}),
  workspaceId: z.string().uuid().nullable().optional(),
});

const updateInputSchema = z.object({
  id: z.string().uuid(),
  patch: z.object({
    params: z.record(z.string(), z.unknown()).optional(),
    status: statusSchema.optional(),
    cursor: z.string().optional(),
  }),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fetch a subscription with its linked source_config (projection).
 */
async function getSubscriptionWithConfig(subId: string, userId: string) {
  const [row] = await db
    .select({
      subscription: sourceSubscriptions,
      sourceConfig: {
        id: sourceConfigs.id,
        providerType: sourceConfigs.providerType,
        name: sourceConfigs.name,
        enabled: sourceConfigs.enabled,
      },
    })
    .from(sourceSubscriptions)
    .innerJoin(
      sourceConfigs,
      eq(sourceSubscriptions.sourceConfigId, sourceConfigs.id)
    )
    .where(
      and(
        eq(sourceSubscriptions.id, subId),
        eq(sourceSubscriptions.userId, userId)
      )
    );

  return row ?? null;
}

// ── Router ───────────────────────────────────────────────────────────────────

export const sourceSubscriptionsRouter = router({
  /**
   * List the caller's subscriptions, ordered by updatedAt desc.
   * Returns a flat array (not joined) — lightweight for listing.
   * Includes source config summary as an extra (no JOIN).
   */
  list: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().optional(),
        status: statusSchema.optional(),
        limit: z.number().min(1).max(100).default(50),
        offset: z.number().min(0).default(0),
      })
    )
    .query(async ({ input, ctx }) => {
      const conditions: any[] = [eq(sourceSubscriptions.userId, ctx.userId)];
      if (input.workspaceId) {
        conditions.push(
          or(
            eq(sourceSubscriptions.workspaceId, input.workspaceId),
            isNull(sourceSubscriptions.workspaceId)
          ) as any
        );
      }
      if (input.status) {
        conditions.push(eq(sourceSubscriptions.status, input.status));
      }

      const rows = await db
        .select()
        .from(sourceSubscriptions)
        .where(and(...conditions))
        .orderBy(desc(sourceSubscriptions.updatedAt))
        .limit(input.limit)
        .offset(input.offset);

      return rows;
    }),

  /**
   * List subscriptions attached to a specific source_config.
   */
  listBySourceConfig: protectedProcedure
    .input(z.object({ sourceConfigId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const rows = await db
        .select()
        .from(sourceSubscriptions)
        .where(
          and(
            eq(sourceSubscriptions.userId, ctx.userId),
            eq(sourceSubscriptions.sourceConfigId, input.sourceConfigId)
          )
        )
        .orderBy(desc(sourceSubscriptions.updatedAt));

      return rows;
    }),

  /**
   * Get a single subscription with its source config summary.
   * Throws 404 if not found or not owned by caller.
   */
  get: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const result = await getSubscriptionWithConfig(input.id, ctx.userId);
      if (!result) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Subscription not found",
        });
      }
      return {
        id: result.subscription.id,
        feedId: result.subscription.feedId,
        params: result.subscription.params,
        cursor: result.subscription.cursor,
        lastFetchedAt: result.subscription.lastFetchedAt,
        status: result.subscription.status,
        errorMessage: result.subscription.errorMessage,
        sourceConfig: result.sourceConfig,
      };
    }),

  /**
   * Create a new subscription bound to an existing source_config.
   * Validates ownership of the source_config.
   */
  create: protectedProcedure
    .input(createInputSchema)
    .mutation(async ({ input, ctx }) => {
      // Verify source_config exists and is accessible (owned by caller or pod-wide)
      const sourceConfig = await db.query.sourceConfigs.findFirst({
        where: and(
          eq(sourceConfigs.id, input.sourceConfigId),
          or(
            eq(sourceConfigs.userId, ctx.userId),
            isNull(sourceConfigs.workspaceId) // pod-wide, but still needs an owner
          )
        ),
      });

      if (!sourceConfig) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Source config not found or not accessible",
        });
      }

      // Reject if the source_config is disabled
      if (!sourceConfig.enabled) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Source config is disabled — enable it first",
        });
      }

      const [row] = await db
        .insert(sourceSubscriptions)
        .values({
          userId: ctx.userId,
          workspaceId: input.workspaceId ?? null,
          feedId: input.feedId,
          sourceConfigId: input.sourceConfigId,
          params: input.params,
        })
        .returning();

      logger.info(
        { subscriptionId: row.id, feedId: input.feedId },
        "Subscription created"
      );
      return row;
    }),

  /**
   * Update a subscription: patch params, status, or cursor.
   */
  update: protectedProcedure
    .input(updateInputSchema)
    .mutation(async ({ input, ctx }) => {
      const existing = await db.query.sourceSubscriptions.findFirst({
        where: and(
          eq(sourceSubscriptions.id, input.id),
          eq(sourceSubscriptions.userId, ctx.userId)
        ),
      });

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Subscription not found",
        });
      }

      const [row] = await db
        .update(sourceSubscriptions)
        .set({
          params: input.patch.params ?? existing.params,
          status: input.patch.status ?? existing.status,
          cursor: input.patch.cursor ?? existing.cursor,
          updatedAt: new Date(),
        })
        .where(eq(sourceSubscriptions.id, input.id))
        .returning();

      logger.info(
        { subscriptionId: row.id, status: row.status },
        "Subscription updated"
      );
      return row;
    }),

  /**
   * Delete a subscription.
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const existing = await db.query.sourceSubscriptions.findFirst({
        where: and(
          eq(sourceSubscriptions.id, input.id),
          eq(sourceSubscriptions.userId, ctx.userId)
        ),
      });

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Subscription not found",
        });
      }

      await db
        .delete(sourceSubscriptions)
        .where(eq(sourceSubscriptions.id, input.id));

      logger.info({ subscriptionId: input.id }, "Subscription deleted");
      return { ok: true };
    }),

  /**
   * Pause a subscription (status = 'paused').
   * The scheduler will skip paused subscriptions.
   */
  pause: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const existing = await db.query.sourceSubscriptions.findFirst({
        where: and(
          eq(sourceSubscriptions.id, input.id),
          eq(sourceSubscriptions.userId, ctx.userId)
        ),
      });

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Subscription not found",
        });
      }

      const [row] = await db
        .update(sourceSubscriptions)
        .set({
          status: "paused",
          updatedAt: new Date(),
        })
        .where(eq(sourceSubscriptions.id, input.id))
        .returning();

      logger.info({ subscriptionId: input.id }, "Subscription paused");
      return row;
    }),

  /**
   * Resume a subscription (status = 'active').
   */
  resume: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const existing = await db.query.sourceSubscriptions.findFirst({
        where: and(
          eq(sourceSubscriptions.id, input.id),
          eq(sourceSubscriptions.userId, ctx.userId)
        ),
      });

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Subscription not found",
        });
      }

      const [row] = await db
        .update(sourceSubscriptions)
        .set({
          status: "active",
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(sourceSubscriptions.id, input.id))
        .returning();

      logger.info({ subscriptionId: input.id }, "Subscription resumed");
      return row;
    }),

  /**
   * Update cursor after a successful fetch.
   * Internal-use helper (called by executor workers).
   */
  updateCursor: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        cursor: z.string(),
        lastFetchedAt: z.coerce.date().optional(),
        lastItemAt: z.coerce.date().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const [row] = await db
        .update(sourceSubscriptions)
        .set({
          cursor: input.cursor,
          lastFetchedAt: input.lastFetchedAt ?? new Date(),
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
});
