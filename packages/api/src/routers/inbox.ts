/**
 * Inbox Router - Life Feed Integration
 *
 * Handles external items from N8N (emails, calendar, Slack)
 * Lifecycle: N8N → inbox.ingest → inbox_items table → Mobile app queries
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { db, inboxItems, eq, and, desc, or } from "@synap/database";

import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "inbox-router" });

/**
 * Inbox item validation schema - TRUE SSOT using .omit()
 *
 * Derived from: insertInboxItemSchema (database/schema/inbox-items.ts)
 * Omits server-generated fields, keeps all user-provided fields.
 *
 * Note: Type assertion needed due to Drizzle-Zod v0.8.3 type inference limitations
 * with .omit() on schemas containing arrays/JSONB fields. Runtime validation is correct.
 */
const InboxItemSchema = z.object({
  provider: z.string(),
  account: z.string(),
  externalId: z.string(),
  deepLink: z.string().optional(),
  type: z.string(),
  title: z.string(),
  preview: z.string().optional(),
  timestamp: z.date(),
  data: z.record(z.string(), z.any()).optional(),
  workspaceId: z.string().uuid(),
});

export const inboxRouter = router({
  /**
   * Ingest items from N8N
   * N8N workflows call this to add external items
   */
  ingest: protectedProcedure
    .input(
      z.object({
        items: z.array(InboxItemSchema),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userId;
      const created: string[] = [];
      const skipped: string[] = [];

      logger.info(
        { count: input.items.length, userId },
        "Ingesting inbox items"
      );

      for (const item of input.items) {
        try {
          // Insert with ON CONFLICT DO NOTHING (deduplication by provider + externalId)
          const result = await db
            .insert(inboxItems)
            .values({
              userId,
              provider: item.provider,
              account: item.account,
              externalId: item.externalId,
              deepLink: item.deepLink,
              type: item.type,
              title: item.title,
              preview: item.preview,
              timestamp: item.timestamp,
              data: item.data,
              status: "unread",
              workspaceId: item.workspaceId,
            })
            .onConflictDoNothing({
              target: [
                inboxItems.userId,
                inboxItems.provider,
                inboxItems.externalId,
              ],
            })
            .returning({ id: inboxItems.id });

          if (result.length > 0) {
            created.push(result[0].id);
            logger.debug(
              { id: result[0].id, type: item.type, title: item.title },
              "Created inbox item"
            );
          } else {
            skipped.push(item.externalId);
            logger.debug(
              { externalId: item.externalId },
              "Skipped duplicate inbox item"
            );
          }
        } catch (error) {
          logger.error({ error, item }, "Failed to ingest inbox item");
        }
      }

      logger.info(
        { created: created.length, skipped: skipped.length },
        "Inbox ingestion complete"
      );

      return {
        success: true,
        created: created.length,
        skipped: skipped.length,
        total: input.items.length,
      };
    }),

  /**
   * List inbox items
   * Mobile app calls this to get items for Life Feed
   */
  list: protectedProcedure
    .input(
      z.object({
        status: z.enum(["unread", "snoozed", "archived"]).optional(),
        types: z.array(z.string()).optional(),
        limit: z.number().optional(),
        offset: z.number().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.userId;

      logger.debug({ userId, filters: input }, "Listing inbox items");

      const conditions = [];

      // Filter by status
      if (input.status) {
        conditions.push(eq(inboxItems.status, input.status));
      }

      // Filter by type
      if (input.types && input.types.length > 0) {
        conditions.push(
          or(...input.types.map((type: string) => eq(inboxItems.type, type)))!
        );
      }

      const items = await db.query.inboxItems.findMany({
        where: and(eq(inboxItems.userId, userId), ...conditions),
        orderBy: [desc(inboxItems.timestamp)],
        limit: input.limit || 50,
        offset: input.offset || 0,
      });

      logger.debug({ count: items.length }, "Retrieved inbox items");

      return items;
    }),

  /**
   * Update status (archive, snooze, mark read)
   * Mobile app calls this when user swipes
   */
  updateStatus: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        status: z.enum(["read", "archived", "snoozed"]),
        snoozedUntil: z.coerce.date().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userId;

      logger.debug(
        { id: input.id, status: input.status },
        "Updating inbox item status"
      );

      const result = await db
        .update(inboxItems)
        .set({
          status: input.status,
          snoozedUntil: input.snoozedUntil,
          updatedAt: new Date(),
        })
        .where(and(eq(inboxItems.id, input.id), eq(inboxItems.userId, userId)))
        .returning({ id: inboxItems.id });

      if (result.length === 0) {
        throw new Error("Inbox item not found or access denied");
      }

      logger.info(
        { id: input.id, status: input.status },
        "Updated inbox item status"
      );

      return { success: true, id: result[0].id };
    }),

  /**
   * Batch update (for efficient swipe operations)
   */
  batchUpdate: protectedProcedure
    .input(
      z.object({
        ids: z.array(z.string().uuid()),
        action: z.enum(["archive", "snooze", "markRead"]),
        snoozedUntil: z.coerce.date().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userId;

      const status =
        input.action === "archive"
          ? "archived"
          : input.action === "snooze"
            ? "snoozed"
            : "read";

      logger.info(
        { count: input.ids.length, action: input.action },
        "Batch updating inbox items"
      );

      const result = await db
        .update(inboxItems)
        .set({
          status,
          snoozedUntil: input.snoozedUntil,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(inboxItems.userId, userId),
            or(...input.ids.map((id) => eq(inboxItems.id, id)))!
          )
        )
        .returning({ id: inboxItems.id });

      logger.info({ updated: result.length }, "Batch update complete");

      return {
        success: true,
        updated: result.length,
      };
    }),

  /**
   * Get stats (for header display)
   */
  stats: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.userId;

    const [unread, snoozed] = await Promise.all([
      db
        .select({ count: inboxItems.id })
        .from(inboxItems)
        .where(
          and(eq(inboxItems.userId, userId), eq(inboxItems.status, "unread"))
        ),
      db
        .select({ count: inboxItems.id })
        .from(inboxItems)
        .where(
          and(eq(inboxItems.userId, userId), eq(inboxItems.status, "snoozed"))
        ),
    ]);

    return {
      unread: unread.length,
      snoozed: snoozed.length,
    };
  }),
});
