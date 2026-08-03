/**
 * Notification Center Router
 *
 * Provides CRUD for the notifications table.
 * Mounted as trpc.notifCenter.* in root.ts.
 *
 * Separate from the legacy notifications router (inbox items from N8N).
 */

import { z } from "zod";
import { router, protectedProcedure, workspaceProcedure } from "../trpc.js";
import {
  db,
  notifications,
  notificationPreferences,
  eq,
  and,
  desc,
  count,
  inArray,
  isNull,
  lte,
} from "@synap/database";
import { NotificationStatus } from "@synap/database";
import { ScopeFilterShape, resolveScope } from "../utils/scope-filter.js";
import { requireUserId } from "../utils/user-scoped.js";

/**
 * Flip any DUE snoozes (snoozedUntil now past) back to `unread` for this user,
 * across all workspaces. Called lazily at the top of every read door so a woken
 * item reappears in the bell without a dedicated cron. A 0-row UPDATE is cheap —
 * it is served by the partial index `notifs_snoozed_until_idx` (migration 0226).
 */
async function wakeDueSnoozes(userId: string): Promise<void> {
  await db
    .update(notifications)
    .set({ status: NotificationStatus.UNREAD, snoozedUntil: null })
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.status, NotificationStatus.SNOOZED),
        lte(notifications.snoozedUntil, new Date())
      )
    );
}

export const notifCenterRouter = router({
  /**
   * THE one door for notifications (collapses the old list/listAll split).
   *
   * Notifications are user-owned (the `userId` field is the recipient), so the
   * floor is `eq(userId)` — every door for this table starts there. The
   * workspace lens then NARROWS within the user's own rows:
   *   - no `workspaceId` (and no active-ws header) → ALL my notifications
   *   - active-ws header / a `workspaceId` → that workspace's notifications
   *   - `workspaceId: null` → pod-wide (workspaceId IS NULL) notifications
   *   - `workspaceId: [a, b]` → those workspaces (union)
   * No project axis (notifications aren't project-scoped). Default: unread only.
   */
  list: protectedProcedure
    .input(
      z.object({
        workspaceId: ScopeFilterShape.workspaceId,
        status: z
          .enum(["unread", "read", "dismissed", "snoozed", "all"])
          .default("unread"),
        category: z
          .enum(["governance", "data", "ai", "system", "inbox"])
          .optional(),
        limit: z.number().min(1).max(100).default(50),
        offset: z.number().min(0).default(0),
      })
    )
    .query(async ({ ctx, input }) => {
      // Surface any due snoozes before reading (flips them back to unread).
      await wakeDueSnoozes(requireUserId(ctx.userId));
      const { workspaceLens } = resolveScope(ctx, input);
      const conditions = [eq(notifications.userId, requireUserId(ctx.userId))];

      // Workspace lens narrows within the user's own rows (the floor is userId).
      if (workspaceLens === null) {
        conditions.push(isNull(notifications.workspaceId));
      } else if (Array.isArray(workspaceLens)) {
        if (workspaceLens.length > 0) {
          conditions.push(inArray(notifications.workspaceId, workspaceLens));
        }
      } else if (typeof workspaceLens === "string") {
        conditions.push(eq(notifications.workspaceId, workspaceLens));
      }

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
    // Wake due snoozes first so the badge counts them (0-row UPDATE when none).
    await wakeDueSnoozes(ctx.userId);
    // COUNT(*) in the DB — was materializing up to 100 id rows then taking
    // .length (which also silently capped the badge at 100). This is polled
    // frequently (bell badge); the aggregate is served entirely from the
    // partial index `notifs_unread_user_workspace_idx` (migration 0122).
    const [row] = await db
      .select({ value: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.workspaceId, ctx.workspaceId),
          eq(notifications.userId, ctx.userId),
          eq(notifications.status, NotificationStatus.UNREAD)
        )
      );

    return { count: row?.value ?? 0 };
  }),

  /**
   * Mark a single notification as read.
   */
  markRead: protectedProcedure
    .input(z.object({ notificationId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await db
        .update(notifications)
        .set({ status: NotificationStatus.READ, readAt: new Date() })
        .where(
          and(
            eq(notifications.id, input.notificationId),
            // Inbox is user-wide. An item from another Space stays actionable
            // after the active lens changes; user ownership is the security floor.
            eq(notifications.userId, requireUserId(ctx.userId))
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
   * Snooze a notification until `until` (triage-defer). Hidden from the active
   * unread list until then; `wakeDueSnoozes` flips it back to unread on the next
   * read. User-owned floor (`eq(userId)`) — snoozeable from any lens.
   */
  snooze: protectedProcedure
    .input(
      z.object({
        notificationId: z.string().uuid(),
        until: z.string().datetime(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await db
        .update(notifications)
        .set({
          status: NotificationStatus.SNOOZED,
          snoozedUntil: new Date(input.until),
        })
        .where(
          and(
            eq(notifications.id, input.notificationId),
            eq(notifications.userId, requireUserId(ctx.userId))
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
