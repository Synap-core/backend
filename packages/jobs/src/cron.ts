/**
 * Cron Scheduler
 *
 * Registers pg-boss cron schedules for periodic tasks.
 * Replaces Inngest cron functions.
 */

import { getBoss } from "@synap/events";
import { createLogger } from "@synap-core/core";
import {
  CAPABILITY_TEMPLATE_SYNC_QUEUE,
  CAPABILITY_TEMPLATE_SYNC_CRON,
} from "./workers/capability-template-sync.js";

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

  // Search bulk-index catch-up (every 5 minutes).
  // Individual items are indexed immediately via indexNow(); this cron only flushes
  // items that were queued as fallback when Typesense was temporarily unavailable.
  await boss.schedule("search-bulk-index", "*/5 * * * *", {});
  logger.info("Registered cron: search-bulk-index (every 5min, catch-up only)");

  // Intelligence service health checks (every 2 minutes)
  await boss.schedule("intelligence-health-check", "*/2 * * * *", {});
  logger.info("Registered cron: intelligence-health-check (every 2min)");

  // API key rotation check (daily at 04:00 UTC — flags agent hub keys whose
  // rotation_scheduled_at has passed; flag-only, no auto-rotation)
  await boss.schedule("api-key-rotation-check", "0 4 * * *", {});
  logger.info("Registered cron: api-key-rotation-check (daily at 04:00 UTC)");

  // Automation cron scheduler (every 1 minute — checks due cron-triggered automations)
  await boss.schedule("automation-cron-scheduler", "* * * * *", {});
  logger.info("Registered cron: automation-cron-scheduler (every 1min)");

  // Vault grant expiry (every hour — expires TTL-bounded approved vault.request proposals)
  await boss.schedule("vault-grant-expiry", "0 * * * *", {});
  logger.info("Registered cron: vault-grant-expiry (every hour)");

  // Automation pattern detection (daily at 3:00 AM UTC)
  await boss.schedule("automation-pattern-detect", "0 3 * * *", {});
  logger.info(
    "Registered cron: automation-pattern-detect (daily at 3:00 AM UTC)"
  );

  // Notification cleanup (daily at 2:00 AM UTC — expires/deletes old notifications)
  await boss.schedule("notification-cleanup", "0 2 * * *", {});
  logger.info("Registered cron: notification-cleanup (daily at 2:00 AM UTC)");

  // Feed scheduler (every minute — checks for due feeds and enqueues execution jobs)
  await boss.schedule("feed-scheduler", "* * * * *", {});
  logger.info("Registered cron: feed-scheduler (every 1min)");

  // Pod-to-pod replication — event log (catch-up + cursor maintenance; realtime hook is primary path)
  await boss.schedule("sync-push", "* * * * *", {});
  logger.info("Registered cron: sync-push (every 1min)");
  await boss.schedule("sync-pull", "* * * * *", {});
  logger.info("Registered cron: sync-pull (every 1min)");

  // Non-event payloads (large file blobs; less frequent)
  await boss.schedule("sync-push-files", "*/10 * * * *", {});
  logger.info("Registered cron: sync-push-files (every 10min)");
  await boss.schedule("sync-push-supplementary", "*/5 * * * *", {});
  logger.info("Registered cron: sync-push-supplementary (every 5min)");

  // CRM daily digest (daily at 08:55 UTC — fires just before most workdays start)
  // Only runs if at least one user has connected messaging accounts.
  await boss.schedule("crm-daily-digest", "55 8 * * *", {});
  logger.info("Registered cron: crm-daily-digest (daily at 08:55 UTC)");

  // Mail feed (every 2 hours — the cron worker invokes the api-side mail-feed
  // runner in-process (IoC slot) to fetch + triage Gmail and post relevant
  // emails to the Discord-bound channel). No-ops unless the pod's Discord tool
  // has mailFeed.enabled.
  await boss.schedule("mail-feed-cron", "0 */2 * * *", {});
  logger.info("Registered cron: mail-feed-cron (every 2h)");

  // Event sync (every 6 hours — the cron worker invokes the api-side event-sync
  // runner in-process (IoC slot) to mirror upcoming Synap events + Stellar
  // deadlines + Google Calendar into native Discord scheduled events). No-ops
  // unless the pod's Discord tool has
  // eventSync.enabled.
  await boss.schedule("event-sync-cron", "0 */6 * * *", {});
  logger.info("Registered cron: event-sync-cron (every 6h)");

  // Hermes trigger (every 60s — dispatches idle devplane features to Hermes AI)
  // Only schedule when Hermes is configured.
  if (process.env.HERMES_TRIGGER_URL) {
    await boss.schedule("hermes-trigger", "* * * * *", {});
    logger.info("Registered cron: hermes-trigger (every 1min)");
  }

  // Memory decay (daily at 03:30 UTC — applies Ebbinghaus decay to knowledge_facts)
  await boss.schedule("memory-decay", "30 3 * * *", {});
  logger.info("Registered cron: memory-decay (daily at 03:30 UTC)");

  // Capability template sync — refresh the pod-local capability_template_cache
  // from the Control Plane every 10 minutes, AND once now (on startup) so a cold
  // pod populates its cache without waiting for the first cron tick. The catalog
  // read path serves from this cache, so it never blocks on a slow/down CP.
  await boss.schedule(
    CAPABILITY_TEMPLATE_SYNC_QUEUE,
    CAPABILITY_TEMPLATE_SYNC_CRON,
    {}
  );
  logger.info("Registered cron: capability-template-sync (every 10min)");
  await boss.send(CAPABILITY_TEMPLATE_SYNC_QUEUE, {});
  logger.info("Enqueued startup run: capability-template-sync");

  logger.info("All cron schedules registered");
}
