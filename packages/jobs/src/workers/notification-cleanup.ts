/**
 * Notification Cleanup Worker
 *
 * Runs daily via cron. Handles expired notifications:
 * - Deletes notifications where expiresAt < now() AND status = 'dismissed'
 * - Deletes notifications where expiresAt < now() AND status = 'read'
 * - Marks unread expired notifications as 'dismissed' (preserves them for awareness)
 *
 * Uses the notifications table index on (userId, workspaceId, status, createdAt)
 * for efficient queries.
 */

import { db, and, eq, lt } from "@synap/database";
import { notifications, NotificationStatus } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "notification-cleanup-worker" });

export const NOTIFICATION_CLEANUP_QUEUE = "notification-cleanup";

/**
 * Called by the cron scheduler daily.
 * Cleans up expired notifications based on their status.
 */
export async function handleNotificationCleanup(): Promise<void> {
  const now = new Date();

  try {
    // 1. Delete expired + dismissed notifications
    const deletedDismissed = await db
      .delete(notifications)
      .where(
        and(
          eq(notifications.status, NotificationStatus.DISMISSED),
          lt(notifications.expiresAt, now)
        )
      )
      .returning({ id: notifications.id });

    // 2. Delete expired + read notifications (already seen, no longer relevant)
    const deletedRead = await db
      .delete(notifications)
      .where(
        and(
          eq(notifications.status, NotificationStatus.READ),
          lt(notifications.expiresAt, now)
        )
      )
      .returning({ id: notifications.id });

    // 3. Mark expired + unread notifications as dismissed (don't delete unread)
    const markedDismissed = await db
      .update(notifications)
      .set({ status: NotificationStatus.DISMISSED })
      .where(
        and(
          eq(notifications.status, NotificationStatus.UNREAD),
          lt(notifications.expiresAt, now)
        )
      )
      .returning({ id: notifications.id });

    const totalDeleted = deletedDismissed.length + deletedRead.length;
    const totalMarked = markedDismissed.length;

    if (totalDeleted > 0 || totalMarked > 0) {
      logger.info(
        {
          deletedDismissed: deletedDismissed.length,
          deletedRead: deletedRead.length,
          markedDismissed: totalMarked,
        },
        "Notification cleanup complete"
      );
    } else {
      logger.debug("No expired notifications to clean up");
    }
  } catch (err) {
    logger.error({ err }, "Notification cleanup failed");
    throw err; // Let pg-boss handle retry
  }
}
