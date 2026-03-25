/**
 * Notification Center Router
 *
 * Provides CRUD for the notifications table.
 * Mounted as trpc.notifCenter.* in root.ts.
 *
 * Separate from the legacy notifications router (inbox items from N8N).
 */

import { z } from "zod";
import { router, workspaceProcedure } from "../trpc.js";
import {
  db,
  notifications,
  notificationPreferences,
  eq,
  and,
  desc,
} from "@synap/database";
import { NotificationStatus } from "@synap/database";

export const notifCenterRouter = router({
  /**
   * List notifications for the current user in the current workspace.
   * Default: unread only, newest first, max 50.
   */
  list: workspaceProcedure
    .input(
      z.object({
        status: z
          .enum(["unread", "read", "dismissed", "all"])
          .default("unread"),
        category: z
          .enum(["governance", "data", "ai", "system", "inbox"])
          .optional(),
        limit: z.number().min(1).max(100).default(50),
        offset: z.number().min(0).default(0),
      })
    )
    .query(async ({ ctx, input }) => {
      const conditions = [
        eq(notifications.workspaceId, ctx.workspaceId),
        eq(notifications.userId, ctx.userId),
      ];

      if (input.status !== "all") {
        conditions.push(eq(notifications.status, input.status));
      }

      if (input.category) {
        conditions.push(eq(notifications.category, input.category));
      }

      const rows = await db
        .select()
        .from(notifications)
        .where(and(...conditions))
        .orderBy(desc(notifications.createdAt))
        .limit(input.limit)
        .offset(input.offset);

      return { notifications: rows, total: rows.length };
    }),

  /**
   * Total unread count for the bell badge.
   */
  unreadCount: workspaceProcedure.query(async ({ ctx }) => {
    const rows = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.workspaceId, ctx.workspaceId),
          eq(notifications.userId, ctx.userId),
          eq(notifications.status, NotificationStatus.UNREAD)
        )
      )
      .limit(100);

    return { count: rows.length };
  }),

  /**
   * Mark a single notification as read.
   */
  markRead: workspaceProcedure
    .input(z.object({ notificationId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await db
        .update(notifications)
        .set({ status: NotificationStatus.READ, readAt: new Date() })
        .where(
          and(
            eq(notifications.id, input.notificationId),
            eq(notifications.userId, ctx.userId),
            eq(notifications.workspaceId, ctx.workspaceId)
          )
        );
      return { success: true };
    }),

  /**
   * Mark all unread notifications as read.
   */
  markAllRead: workspaceProcedure.mutation(async ({ ctx }) => {
    await db
      .update(notifications)
      .set({ status: NotificationStatus.READ, readAt: new Date() })
      .where(
        and(
          eq(notifications.workspaceId, ctx.workspaceId),
          eq(notifications.userId, ctx.userId),
          eq(notifications.status, NotificationStatus.UNREAD)
        )
      );
    return { success: true };
  }),

  /**
   * Dismiss a notification (soft-delete from bell).
   */
  dismiss: workspaceProcedure
    .input(z.object({ notificationId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await db
        .update(notifications)
        .set({ status: NotificationStatus.DISMISSED })
        .where(
          and(
            eq(notifications.id, input.notificationId),
            eq(notifications.userId, ctx.userId),
            eq(notifications.workspaceId, ctx.workspaceId)
          )
        );
      return { success: true };
    }),

  /**
   * Dismiss all notifications (clear bell).
   */
  dismissAll: workspaceProcedure.mutation(async ({ ctx }) => {
    await db
      .update(notifications)
      .set({ status: NotificationStatus.DISMISSED })
      .where(
        and(
          eq(notifications.workspaceId, ctx.workspaceId),
          eq(notifications.userId, ctx.userId),
          eq(notifications.status, NotificationStatus.UNREAD)
        )
      );
    return { success: true };
  }),

  /**
   * Get notification preferences for the current user + workspace.
   */
  getPrefs: workspaceProcedure.query(async ({ ctx }) => {
    const prefs = await db.query.notificationPreferences.findFirst({
      where: and(
        eq(notificationPreferences.userId, ctx.userId),
        eq(notificationPreferences.workspaceId, ctx.workspaceId)
      ),
    });
    return prefs ?? null;
  }),

  /**
   * Update notification preferences.
   */
  updatePrefs: workspaceProcedure
    .input(
      z.object({
        enabled: z.boolean().optional(),
        quietHoursEnabled: z.boolean().optional(),
        quietHoursStart: z.string().optional(),
        quietHoursEnd: z.string().optional(),
        soundEnabled: z.boolean().optional(),
        routingRules: z.record(z.string(), z.any()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await db.query.notificationPreferences.findFirst({
        where: and(
          eq(notificationPreferences.userId, ctx.userId),
          eq(notificationPreferences.workspaceId, ctx.workspaceId)
        ),
      });

      if (existing) {
        await db
          .update(notificationPreferences)
          .set({ ...input, updatedAt: new Date() })
          .where(eq(notificationPreferences.id, existing.id));
      } else {
        await db.insert(notificationPreferences).values({
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
          ...input,
        });
      }

      return { success: true };
    }),
});
