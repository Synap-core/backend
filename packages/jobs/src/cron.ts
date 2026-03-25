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

  // Telegram morning digest (daily at 8:00 AM)
  await boss.schedule("telegram-digest", "0 8 * * *", {});
  logger.info("Registered cron: telegram-digest (daily at 8:00 AM)");

  // Vault grant expiry (every hour — expires TTL-bounded approved vault.request proposals)
  await boss.schedule("vault-grant-expiry", "0 * * * *", {});
  logger.info("Registered cron: vault-grant-expiry (every hour)");

  // Automation pattern detection (daily at 3:00 AM UTC)
  await boss.schedule("automation-pattern-detect", "0 3 * * *", {});
  logger.info(
    "Registered cron: automation-pattern-detect (daily at 3:00 AM UTC)"
  );

  logger.info("All cron schedules registered");
}
