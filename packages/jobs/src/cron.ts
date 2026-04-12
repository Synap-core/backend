/**
 * Cron Scheduler
 *
 * Registers pg-boss cron schedules for periodic tasks.
 * Replaces Inngest cron functions.
 */

import { getBoss } from "./boss.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "cron-scheduler" });

/**
 * Register all cron schedules with pg-boss.
 * Call once after boss.start().
 */
export async function registerCronSchedules(): Promise<void> {
  const boss = getBoss();

  // Document auto-save (every 30 minutes)
  await boss.schedule("doc-autosave", "*/30 * * * *", {});
  logger.info("Registered cron: doc-autosave (every 30min)");

  // Whiteboard auto-save (every 30 minutes)
  await boss.schedule("whiteboard-autosave", "*/30 * * * *", {});
  logger.info("Registered cron: whiteboard-autosave (every 30min)");

  // Document persistence (every 10 minutes)
  await boss.schedule("doc-persistence", "*/10 * * * *", {});
  logger.info("Registered cron: doc-persistence (every 10min)");

  // Background task scheduler (every 1 minute)
  await boss.schedule("background-task-scheduler", "* * * * *", {});
  logger.info("Registered cron: background-task-scheduler (every 1min)");

  // Search bulk-index catch-up (every 5 minutes).
  // Individual items are indexed immediately via indexNow(); this cron only flushes
  // items that were queued as fallback when Typesense was temporarily unavailable.
  await boss.schedule("search-bulk-index", "*/5 * * * *", {});
  logger.info("Registered cron: search-bulk-index (every 5min, catch-up only)");

  // Intelligence service health checks (every 2 minutes)
  await boss.schedule("intelligence-health-check", "*/2 * * * *", {});
  logger.info("Registered cron: intelligence-health-check (every 2min)");

  // Automation cron scheduler (every 1 minute — checks due cron-triggered automations)
  await boss.schedule("automation-cron-scheduler", "* * * * *", {});
  logger.info("Registered cron: automation-cron-scheduler (every 1min)");

  // Telegram morning digest (daily at 8:00 AM) — only when Telegram bot is enabled
  if (process.env.TELEGRAM_BOT_ENABLED === "true") {
    await boss.schedule("telegram-digest", "0 8 * * *", {});
    logger.info("Registered cron: telegram-digest (daily at 8:00 AM)");
  }

  // Vault grant expiry (every hour — expires TTL-bounded approved vault.request proposals)
  await boss.schedule("vault-grant-expiry", "0 * * * *", {});
  logger.info("Registered cron: vault-grant-expiry (every hour)");

  // Automation pattern detection (daily at 3:00 AM UTC)
  await boss.schedule("automation-pattern-detect", "0 3 * * *", {});
  logger.info(
    "Registered cron: automation-pattern-detect (daily at 3:00 AM UTC)"
  );

  // Proactive morning briefing (every 15 minutes — checks timezone windows)
  await boss.schedule("proactive-morning-briefing", "*/15 * * * *", {});
  logger.info("Registered cron: proactive-morning-briefing (every 15min)");

  // Proactive weekly digest (every hour — checks day-of-week + hour match)
  await boss.schedule("proactive-weekly-digest", "0 * * * *", {});
  logger.info("Registered cron: proactive-weekly-digest (every hour)");

  // Proactive health check (daily at 4:00 AM UTC — respects frequencyDays)
  await boss.schedule("proactive-health-check", "0 4 * * *", {});
  logger.info("Registered cron: proactive-health-check (daily at 4:00 AM UTC)");

  // Notification cleanup (daily at 2:00 AM UTC — expires/deletes old notifications)
  await boss.schedule("notification-cleanup", "0 2 * * *", {});
  logger.info("Registered cron: notification-cleanup (daily at 2:00 AM UTC)");

  // Sync push (every 60 seconds — pushes completed events to registered sync peers)
  await boss.schedule("sync-push", "* * * * *", {});
  logger.info("Registered cron: sync-push (every 60s)");

  // Sync push supplementary (every 5 minutes — pushes non-event tables to peers)
  await boss.schedule("sync-push-supplementary", "*/5 * * * *", {});
  logger.info("Registered cron: sync-push-supplementary (every 5min)");

  // Sync push files (every 10 minutes — pushes document content + file blobs to peers)
  await boss.schedule("sync-push-files", "*/10 * * * *", {});
  logger.info("Registered cron: sync-push-files (every 10min)");

  // Sync pull (every 60 seconds — pulls events from pull/bidirectional peers)
  await boss.schedule("sync-pull", "* * * * *", {});
  logger.info("Registered cron: sync-pull (every 60s)");

  // Feed scheduler (every minute — checks for due feeds and enqueues execution jobs)
  await boss.schedule("feed-scheduler", "* * * * *", {});
  logger.info("Registered cron: feed-scheduler (every 1min)");

  logger.info("All cron schedules registered");
}
