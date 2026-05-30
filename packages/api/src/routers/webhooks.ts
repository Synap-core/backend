/**
 * Webhooks Router
 *
 * Manages webhook subscriptions for n8n and other integrations.
 */

import {
  router,
  protectedProcedure,
  workspaceProcedure,
  podAdminProcedure,
} from "../trpc.js";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";
import { db } from "@synap/database";
import {
  webhookSubscriptions,
  webhookDeliveries,
} from "@synap/database/schema";
import { eq, and } from "@synap/database";
import { randomBytes } from "crypto";

const logger = createLogger({ module: "webhooks-router" });

/**
 * Webhook input schemas - TRUE SSOT using .omit()
 *
 * Derived from: insertWebhookSubscriptionSchema (database/schema/webhook_subscriptions.ts)
 * Omits server-generated fields, keeps all user-provided fields.
 */

const UpdateWebhookInputSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100).optional(),
  url: z.string().url().optional(),
  eventTypes: z.array(z.string()).min(1).optional(),
  active: z.boolean().optional(),
});

export const webhooksRouter = router({
  /**
   * Create a new webhook subscription
   */
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        url: z.string().url(),
        eventTypes: z.array(z.string()).min(1),
        secret: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userId;
      const secret = input.secret || randomBytes(32).toString("hex");

      logger.info(
        { userId, name: input.name, url: input.url },
        "Creating webhook subscription"
      );

      try {
        const [subscription] = await db
          .insert(webhookSubscriptions)
          .values({
            userId,
            name: input.name,
            url: input.url,
            eventTypes: input.eventTypes,
            secret,
            active: true,
          })
          .returning();

        return {
          subscription,
          secret, // Return secret only once upon creation
        };
      } catch (error) {
        logger.error(
          { err: error, userId },
          "Failed to create webhook subscription"
        );
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create webhook subscription",
        });
      }
    }),

  /**
   * List all webhook subscriptions for the current user
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.userId;

    try {
      const subscriptions = await db.query.webhookSubscriptions.findMany({
        where: eq(webhookSubscriptions.userId, userId),
        orderBy: (subscriptions, { desc }) => [desc(subscriptions.createdAt)],
      });

      // Don't return secrets in list view
      return subscriptions.map(
        (s) =>
          Object.fromEntries(
            Object.entries(s).filter(([k]) => k !== "secret")
          ) as typeof s
      );
    } catch (error) {
      logger.error(
        { err: error, userId },
        "Failed to list webhook subscriptions"
      );
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to list webhook subscriptions",
      });
    }
  }),

  /**
   * Update a webhook subscription
   */
  update: protectedProcedure
    .input(UpdateWebhookInputSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userId;
      const { id, ...updates } = input;

      logger.info({ userId, webhookId: id }, "Updating webhook subscription");

      try {
        // Check ownership
        const existing = await db.query.webhookSubscriptions.findFirst({
          where: and(
            eq(webhookSubscriptions.id, id),
            eq(webhookSubscriptions.userId, userId)
          ),
        });

        if (!existing) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Webhook subscription not found",
          });
        }

        const [updated] = await db
          .update(webhookSubscriptions)
          .set(updates)
          .where(eq(webhookSubscriptions.id, id))
          .returning();

        const { secret: _, ...safeSubscription } = updated as unknown as Record<
          string,
          unknown
        > as typeof updated;
        return safeSubscription;
      } catch (error) {
        if (error instanceof TRPCError) throw error;

        logger.error(
          { err: error, userId, webhookId: id },
          "Failed to update webhook subscription"
        );
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to update webhook subscription",
        });
      }
    }),

  /**
   * Delete a webhook subscription
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userId;

      logger.info(
        { userId, webhookId: input.id },
        "Deleting webhook subscription"
      );

      try {
        const result = await db
          .delete(webhookSubscriptions)
          .where(
            and(
              eq(webhookSubscriptions.id, input.id),
              eq(webhookSubscriptions.userId, userId)
            )
          )
          .returning();

        if (result.length === 0) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Webhook subscription not found",
          });
        }

        return { success: true };
      } catch (error) {
        if (error instanceof TRPCError) throw error;

        logger.error(
          { err: error, userId, webhookId: input.id },
          "Failed to delete webhook subscription"
        );
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to delete webhook subscription",
        });
      }
    }),

  /**
   * List workspace-scoped webhook subscriptions (workspace member)
   */
  listForWorkspace: workspaceProcedure.query(async ({ ctx }) => {
    const workspaceId = ctx.workspaceId;
    const subs = await db.query.webhookSubscriptions.findMany({
      where: and(
        eq(webhookSubscriptions.workspaceId, workspaceId),
        eq(webhookSubscriptions.active, true)
      ),
      orderBy: (s, { desc }) => [desc(s.createdAt)],
    });
    return subs.map(
      (s) =>
        Object.fromEntries(
          Object.entries(s).filter(([k]) => k !== "secret")
        ) as typeof s
    );
  }),

  /**
   * Create workspace-scoped webhook subscription (workspace member)
   */
  createForWorkspace: workspaceProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        url: z.string().url(),
        eventTypes: z.array(z.string()).min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const workspaceId = ctx.workspaceId;
      const secret = randomBytes(32).toString("hex");
      const [subscription] = await db
        .insert(webhookSubscriptions)
        .values({
          userId: ctx.userId,
          workspaceId,
          name: input.name,
          url: input.url,
          eventTypes: input.eventTypes,
          secret,
          active: true,
        })
        .returning();
      return {
        subscription: Object.fromEntries(
          Object.entries(subscription).filter(([k]) => k !== "secret")
        ) as typeof subscription,
        secret,
      };
    }),

  /**
   * Delete workspace-scoped webhook subscription (workspace member, must own)
   */
  deleteForWorkspace: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const workspaceId = ctx.workspaceId;
      const result = await db
        .delete(webhookSubscriptions)
        .where(
          and(
            eq(webhookSubscriptions.id, input.id),
            eq(webhookSubscriptions.workspaceId, workspaceId)
          )
        )
        .returning();
      if (result.length === 0)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Webhook not found",
        });
      return { success: true };
    }),

  /**
   * Toggle active state (workspace member)
   */
  toggleForWorkspace: workspaceProcedure
    .input(z.object({ id: z.string().uuid(), active: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const workspaceId = ctx.workspaceId;
      const [updated] = await db
        .update(webhookSubscriptions)
        .set({ active: input.active })
        .where(
          and(
            eq(webhookSubscriptions.id, input.id),
            eq(webhookSubscriptions.workspaceId, workspaceId)
          )
        )
        .returning();
      if (!updated)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Webhook not found",
        });
      const { secret: _, ...safe } = updated as unknown as Record<
        string,
        unknown
      > as typeof updated;
      return safe;
    }),

  /**
   * List workspace-scoped webhook subscriptions (pod admin)
   */
  adminListForWorkspace: podAdminProcedure
    .input(z.object({ workspaceId: z.string().uuid() }))
    .query(async ({ input }) => {
      const subs = await db.query.webhookSubscriptions.findMany({
        where: eq(webhookSubscriptions.workspaceId, input.workspaceId),
        orderBy: (s, { desc }) => [desc(s.createdAt)],
      });
      return subs.map(
        (s) =>
          Object.fromEntries(
            Object.entries(s).filter(([k]) => k !== "secret")
          ) as typeof s
      );
    }),

  /**
   * Create workspace-scoped webhook subscription (pod admin)
   */
  adminCreateForWorkspace: podAdminProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid(),
        url: z.string().url(),
        events: z.array(z.string()).min(1),
        description: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const secret = randomBytes(32).toString("hex");
      const [subscription] = await db
        .insert(webhookSubscriptions)
        .values({
          userId: "pod-admin",
          workspaceId: input.workspaceId,
          name: input.description ?? input.url,
          url: input.url,
          eventTypes: input.events,
          secret,
          active: true,
        })
        .returning();
      return {
        subscription: Object.fromEntries(
          Object.entries(subscription).filter(([k]) => k !== "secret")
        ) as typeof subscription,
        secret,
      };
    }),

  /**
   * Delete workspace-scoped webhook subscription (pod admin)
   */
  adminDeleteForWorkspace: podAdminProcedure
    .input(z.object({ id: z.string().uuid(), workspaceId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const result = await db
        .delete(webhookSubscriptions)
        .where(
          and(
            eq(webhookSubscriptions.id, input.id),
            eq(webhookSubscriptions.workspaceId, input.workspaceId)
          )
        )
        .returning();
      if (result.length === 0)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Webhook not found",
        });
      return { success: true };
    }),

  /**
   * Toggle active state (pod admin)
   */
  adminToggleForWorkspace: podAdminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        workspaceId: z.string().uuid(),
        active: z.boolean(),
      })
    )
    .mutation(async ({ input }) => {
      const [updated] = await db
        .update(webhookSubscriptions)
        .set({ active: input.active })
        .where(
          and(
            eq(webhookSubscriptions.id, input.id),
            eq(webhookSubscriptions.workspaceId, input.workspaceId)
          )
        )
        .returning();
      if (!updated)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Webhook not found",
        });
      const { secret: _, ...safe } = updated as unknown as Record<
        string,
        unknown
      > as typeof updated;
      return safe;
    }),

  /**
   * Get recent deliveries for a subscription (pod admin)
   */
  deliveriesForSubscription: podAdminProcedure
    .input(
      z.object({
        subscriptionId: z.string().uuid(),
        limit: z.number().int().min(1).max(50).default(20),
      })
    )
    .query(async ({ input }) => {
      return db.query.webhookDeliveries.findMany({
        where: eq(webhookDeliveries.subscriptionId, input.subscriptionId),
        orderBy: (d, { desc }) => [desc(d.createdAt)],
        limit: input.limit,
      });
    }),

  /**
   * List recent deliveries for a subscription owned by the current user.
   *
   * Powers the Reactions Health tab + Replay. Verifies the subscription
   * belongs to the caller, then returns the delivery log mapped to the
   * `WebhookDeliveryItem` shape (id, status, responseStatus, attempt,
   * deliveredAt).
   */
  deliveries: protectedProcedure
    .input(
      z.object({
        subscriptionId: z.string().uuid(),
        limit: z.number().int().min(1).max(100).default(50),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.userId;

      const subscription = await db.query.webhookSubscriptions.findFirst({
        where: and(
          eq(webhookSubscriptions.id, input.subscriptionId),
          eq(webhookSubscriptions.userId, userId)
        ),
        columns: { id: true },
      });
      if (!subscription) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Webhook subscription not found",
        });
      }

      const rows = await db.query.webhookDeliveries.findMany({
        where: eq(webhookDeliveries.subscriptionId, input.subscriptionId),
        orderBy: (d, { desc }) => [desc(d.createdAt)],
        limit: input.limit,
      });

      return rows.map((d) => ({
        id: d.id,
        status: d.status as "success" | "failed" | "pending",
        responseStatus:
          d.responseStatus != null ? String(d.responseStatus) : undefined,
        attempt: d.attempt,
        deliveredAt: d.deliveredAt ? d.deliveredAt.toISOString() : undefined,
      }));
    }),
});
