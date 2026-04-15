/**
 * pg-boss Workers Registry
 *
 * Registers all queue handlers with pg-boss.
 * Call registerAllWorkers() after boss.start().
 *
 * pg-boss v10: work() handlers receive Job<T>[] (batch array).
 * We destructure to get a single job since we process one at a time.
 */

import { getBoss } from "@synap/events";
import { createLogger } from "@synap-core/core";
import { collectionService } from "@synap/search";
import {
  handleSearchIndex,
  handleBulkIndex,
  handleFullReindex,
} from "./search-worker.js";
import { handleWorkspaceInit } from "./workspace-init.js";
import { handleCrossChannelNotify } from "./cross-channel-notifier.js";
import {
  handleDocumentSnapshot,
  handleDocumentRestore,
  handleDocumentAutoSave,
  handleDocumentPersistence,
  handleWhiteboardSnapshot,
  handleWhiteboardRestore,
  handleWhiteboardAutoSave,
} from "./snapshot-worker.js";
import { handleEntityEmbedding } from "./entity-embedding.js";
import { handleWebhookDelivery } from "./webhook-worker.js";
import { handleBackgroundTaskScheduler } from "./background-task-scheduler.js";
import { handleAiAnalysis } from "./ai-workers.js";
import { handleMaterialize } from "./materializer.js";
import {
  handleA2AIResponseTrigger,
  A2AI_TRIGGER_QUEUE,
} from "./a2ai-response-trigger.js";
import { handleIntelligenceHealthCheck } from "./intelligence-health-check.js";
import { handleAutomationTriggerMatch } from "./automation-trigger-matcher.js";
import { handleAutomationExecute } from "./automation-executor.js";
import { handleAutomationCronScheduler } from "./automation-cron-scheduler.js";
import { handleTelegramDigest } from "./telegram-digest.js";
import { handleRelationBackfill } from "./relation-backfill.js";
import {
  handleVaultGrantExpiry,
  VAULT_GRANT_EXPIRY_QUEUE,
} from "./vault-grant-expiry-worker.js";
import { handleAutomationPatternDetect } from "./automation-pattern-detector.js";
import {
  handleNotificationCleanup,
  NOTIFICATION_CLEANUP_QUEUE,
} from "./notification-cleanup.js";
import { handleFeedScheduler } from "./feed-scheduler.js";
import { handleFeedRSSExecute } from "./feed-rss-executor.js";
import { handleFeedProactiveExecute } from "./feed-proactive-executor.js";
import {
  handleTelegramBulkImport,
  TELEGRAM_BULK_IMPORT_QUEUE,
} from "./telegram-bulk-import.js";
import {
  handleLinkedInBulkImport,
  LINKEDIN_BULK_IMPORT_QUEUE,
} from "./linkedin-bulk-import.js";
import { handleSyncPush, SYNC_PUSH_QUEUE } from "./sync-push.js";
import { handleSyncPull, SYNC_PULL_QUEUE } from "./sync-pull.js";
import {
  handleSyncPushFiles,
  SYNC_PUSH_FILES_QUEUE,
} from "./sync-push-files.js";
import {
  handleSyncPushSupplementary,
  SYNC_PUSH_SUPPLEMENTARY_QUEUE,
} from "./sync-push-supplementary.js";

const logger = createLogger({ module: "workers" });

/**
 * All queue names used by the system.
 * pg-boss v10 requires queues to be created before work() or schedule().
 */
const ALL_QUEUES = [
  "intelligence-health-check",
  "search-index",
  "search-bulk-index",
  "workspace-init",
  "cross-thread-notify",
  "document-snapshot",
  "document-restore",
  "doc-autosave",
  "doc-persistence",
  "whiteboard-snapshot",
  "whiteboard-restore",
  "whiteboard-autosave",
  "entity-embedding",
  "webhook-delivery",
  "background-task-scheduler",
  "ai-analysis",
  "materialize",
  "side-effects",
  "search-reindex",
  A2AI_TRIGGER_QUEUE,
  "automation-trigger-match",
  "automation-execute",
  "automation-cron-scheduler",
  "telegram-digest",
  "relation-backfill",
  VAULT_GRANT_EXPIRY_QUEUE,
  "automation-pattern-detect",
  NOTIFICATION_CLEANUP_QUEUE,
  "feed-scheduler",
  "feed-rss-execute",
  "feed-proactive-execute",
  TELEGRAM_BULK_IMPORT_QUEUE,
  LINKEDIN_BULK_IMPORT_QUEUE,
  SYNC_PUSH_QUEUE,
  SYNC_PULL_QUEUE,
  SYNC_PUSH_FILES_QUEUE,
  SYNC_PUSH_SUPPLEMENTARY_QUEUE,
];

/**
 * Register all pg-boss workers.
 * Must be called after startBoss().
 */
export async function registerAllWorkers(): Promise<void> {
  const boss = getBoss();

  // Create all queues first (pg-boss v10 requires this before work/schedule)
  for (const name of ALL_QUEUES) {
    await boss.createQueue(name);
  }
  logger.info({ count: ALL_QUEUES.length }, "Created all pg-boss queues");

  // Ensure Typesense collections exist before registering search workers.
  // Non-fatal: if Typesense is not running the search feature degrades gracefully.
  try {
    await collectionService.initializeCollections();
    logger.info("Typesense collections initialized");
  } catch (err) {
    logger.warn(
      { err },
      "Typesense collection init failed — search unavailable until Typesense is reachable"
    );
  }

  // Search indexing
  await boss.work("search-index", async ([job]: any[]) =>
    handleSearchIndex(job)
  );
  await boss.work("search-bulk-index", async () => handleBulkIndex());
  logger.info("Registered worker: search-index, search-bulk-index");

  // Workspace initialization (default project, views, commands)
  await boss.work("workspace-init", async ([job]: any[]) =>
    handleWorkspaceInit(job)
  );
  logger.info("Registered worker: workspace-init");

  // Cross-channel notifications
  await boss.work("cross-thread-notify", async ([job]: any[]) =>
    handleCrossChannelNotify(job)
  );
  logger.info(
    "Registered worker: cross-thread-notify (cross-channel-notifier)"
  );

  // Document snapshots
  await boss.work("document-snapshot", async ([job]: any[]) =>
    handleDocumentSnapshot(job)
  );
  await boss.work("document-restore", async ([job]: any[]) =>
    handleDocumentRestore(job)
  );
  await boss.work("doc-autosave", async () => handleDocumentAutoSave());
  await boss.work("doc-persistence", async () => handleDocumentPersistence());
  logger.info(
    "Registered workers: document-snapshot, document-restore, doc-autosave, doc-persistence"
  );

  // Whiteboard snapshots
  await boss.work("whiteboard-snapshot", async ([job]: any[]) =>
    handleWhiteboardSnapshot(job)
  );
  await boss.work("whiteboard-restore", async ([job]: any[]) =>
    handleWhiteboardRestore(job)
  );
  await boss.work("whiteboard-autosave", async () =>
    handleWhiteboardAutoSave()
  );
  logger.info(
    "Registered workers: whiteboard-snapshot, whiteboard-restore, whiteboard-autosave"
  );

  // Entity embedding
  await boss.work("entity-embedding", async ([job]: any[]) =>
    handleEntityEmbedding(job)
  );
  logger.info("Registered worker: entity-embedding");

  // Webhook delivery
  await boss.work("webhook-delivery", async ([job]: any[]) =>
    handleWebhookDelivery(job)
  );
  logger.info("Registered worker: webhook-delivery");

  // Background task scheduler
  await boss.work("background-task-scheduler", async () =>
    handleBackgroundTaskScheduler()
  );
  logger.info("Registered worker: background-task-scheduler");

  // AI analysis
  await boss.work("ai-analysis", async ([job]: any[]) => handleAiAnalysis(job));
  logger.info("Registered worker: ai-analysis");

  // Materializer (processes .validated events into DB writes)
  await boss.work("materialize", async ([job]: any[]) =>
    handleMaterialize(job)
  );
  logger.info("Registered worker: materialize");

  // Side-effects (generic handler for search, embedding, webhook dispatch)
  await boss.work("side-effects", async ([job]: any[]) => {
    logger.debug({ data: job.data }, "Processing side-effect");
  });
  logger.info("Registered worker: side-effects");

  // Search reindex (triggered by admin) — full DB→Typesense sync
  await boss.work("search-reindex", async ([job]: any[]) =>
    handleFullReindex(job)
  );
  logger.info("Registered worker: search-reindex");

  // A2AI response trigger (with retry, replaces fire-and-forget)
  await boss.work(
    A2AI_TRIGGER_QUEUE,
    { includeMetadata: true },
    async ([job]: any[]) => handleA2AIResponseTrigger(job)
  );
  logger.info("Registered worker: a2ai-response-trigger");

  // Intelligence service health checks (cron: every 2min)
  await boss.work("intelligence-health-check", async () =>
    handleIntelligenceHealthCheck()
  );
  logger.info("Registered worker: intelligence-health-check");

  // Automation trigger matching (event → automation run)
  await boss.work("automation-trigger-match", async ([job]: any[]) =>
    handleAutomationTriggerMatch(job)
  );
  logger.info("Registered worker: automation-trigger-match");

  // Automation execution (walk DAG, execute steps)
  await boss.work("automation-execute", async ([job]: any[]) =>
    handleAutomationExecute(job)
  );
  logger.info("Registered worker: automation-execute");

  // Automation cron scheduler (polls due cron automations every minute)
  await boss.work("automation-cron-scheduler", async () =>
    handleAutomationCronScheduler()
  );
  logger.info("Registered worker: automation-cron-scheduler");

  // Telegram morning digest (cron: daily at 8:00 AM) — only when Telegram bot is enabled
  if (process.env.TELEGRAM_BOT_ENABLED === "true") {
    await boss.work("telegram-digest", async () => handleTelegramDigest());
    logger.info("Registered worker: telegram-digest");
  }

  // Relation backfill (one-time: creates relation rows for existing entity_id property values)
  await boss.work("relation-backfill", async ([job]: any[]) =>
    handleRelationBackfill(job)
  );
  logger.info("Registered worker: relation-backfill");

  // Vault grant expiry (cron: every hour — expires TTL-bounded approved vault.request proposals)
  await boss.work(VAULT_GRANT_EXPIRY_QUEUE, async () =>
    handleVaultGrantExpiry()
  );
  logger.info("Registered worker: vault-grant-expiry");

  // Automation pattern detection (cron: daily at 3:00 AM UTC)
  await boss.work("automation-pattern-detect", async () =>
    handleAutomationPatternDetect()
  );
  logger.info("Registered worker: automation-pattern-detect");

  // Notification cleanup (cron: daily at 2:00 AM UTC)
  await boss.work(NOTIFICATION_CLEANUP_QUEUE, async () =>
    handleNotificationCleanup()
  );
  logger.info("Registered worker: notification-cleanup");

  // Feed scheduler (cron: every minute — schedules due feed executions)
  await boss.work("feed-scheduler", async () => handleFeedScheduler());
  logger.info("Registered worker: feed-scheduler");

  // Feed RSS executor (on-demand — executes RSS feed fetch and post)
  await boss.work("feed-rss-execute", async ([job]: any[]) =>
    handleFeedRSSExecute(job)
  );
  logger.info("Registered worker: feed-rss-execute");

  // Feed proactive executor (on-demand — executes proactive digest generation)
  await boss.work("feed-proactive-execute", async ([job]: any[]) =>
    handleFeedProactiveExecute(job)
  );
  logger.info("Registered worker: feed-proactive-execute");

  // Contacts archive imports (on-demand — heavy batch upserts)
  await boss.work(TELEGRAM_BULK_IMPORT_QUEUE, async ([job]: any[]) =>
    handleTelegramBulkImport(job)
  );
  await boss.work(LINKEDIN_BULK_IMPORT_QUEUE, async ([job]: any[]) =>
    handleLinkedInBulkImport(job)
  );
  logger.info("Registered workers: telegram-bulk-import, linkedin-bulk-import");

  // Pod-to-pod sync (event log replication + supplementary rows + file payloads)
  await boss.work(SYNC_PUSH_QUEUE, async () => handleSyncPush());
  await boss.work(SYNC_PULL_QUEUE, async () => handleSyncPull());
  await boss.work(SYNC_PUSH_FILES_QUEUE, async () => handleSyncPushFiles());
  await boss.work(SYNC_PUSH_SUPPLEMENTARY_QUEUE, async () =>
    handleSyncPushSupplementary()
  );
  logger.info(
    "Registered workers: sync-push, sync-pull, sync-push-files, sync-push-supplementary"
  );

  // Note: Delivery retry and dead letter workers removed to avoid circular dependency
  // (jobs → api → jobs). Retry functionality is handled inline in DeliveryService.

  logger.info("All workers registered");
}
