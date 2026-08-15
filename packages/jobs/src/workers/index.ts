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
import { handleAiAnalysis } from "./ai-workers.js";
import { handleMaterialize } from "./materializer.js";
import {
  handleA2AIResponseTrigger,
  A2AI_TRIGGER_QUEUE,
} from "./a2ai-response-trigger.js";
import { handleIntelligenceHealthCheck } from "./intelligence-health-check.js";
import {
  handleApiKeyRotationCheck,
  API_KEY_ROTATION_CHECK_QUEUE,
} from "./api-key-rotation-check.js";
import { handleAutomationTriggerMatch } from "./automation-trigger-matcher.js";
import { handleAutomationExecute } from "./automation-executor.js";
import { handleAutomationCronScheduler } from "./automation-cron-scheduler.js";
import {
  handleAutomationRunReaper,
  AUTOMATION_RUN_REAPER_QUEUE,
} from "./automation-run-reaper.js";
import {
  handleFocusSessionReaper,
  FOCUS_SESSION_REAPER_QUEUE,
} from "./focus-session-reaper.js";
import {
  handlePlaybookRunReaper,
  PLAYBOOK_RUN_REAPER_QUEUE,
} from "./playbook-run-reaper.js";
import {
  handleChatTurnReaper,
  CHAT_TURN_REAPER_QUEUE,
} from "./chat-turn-reaper.js";
import { handleRelationBackfill } from "./relation-backfill.js";
import {
  handleVaultGrantExpiry,
  VAULT_GRANT_EXPIRY_QUEUE,
} from "./vault-grant-expiry-worker.js";
import {
  handleNotificationCleanup,
  NOTIFICATION_CLEANUP_QUEUE,
} from "./notification-cleanup.js";
import {
  FEDERATION_RECEIPT_CLEANUP_QUEUE,
  handleFederationReceiptCleanup,
} from "./federation-receipt-cleanup.js";
import { handleFeedScheduler } from "./feed-scheduler.js";
import {
  handleFeedSourceExecute,
  FEED_SOURCE_EXECUTE_QUEUE,
  FEED_SOURCE_ITEMS_QUEUE,
} from "./feed-source-executor.js";
import {
  handleLinkedInBulkImport,
  LINKEDIN_BULK_IMPORT_QUEUE,
} from "./linkedin-bulk-import.js";
import {
  handleImportCorpus,
  IMPORT_CORPUS_QUEUE,
} from "./import-corpus-worker.js";
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
import { handleHydrationSummaryPost } from "./hydration-summary-post.js";
import {
  handleCrmDailyDigest,
  CRM_DAILY_DIGEST_QUEUE,
} from "./crm-daily-digest.js";
import { handleMailFeedCron, MAIL_FEED_CRON_QUEUE } from "./mail-feed-cron.js";
import {
  handleCalBackfillCron,
  CAL_BACKFILL_CRON_QUEUE,
} from "./cal-backfill-cron.js";
import {
  handleFirefliesIngest,
  handleFirefliesBackfillCron,
  FIREFLIES_INGEST_QUEUE,
  FIREFLIES_BACKFILL_CRON_QUEUE,
} from "./fireflies-worker.js";
import {
  handleInboundAttachmentIngest,
  INBOUND_ATTACHMENT_QUEUE,
} from "./inbound-attachment-worker.js";
import {
  handleEventSyncCron,
  EVENT_SYNC_CRON_QUEUE,
} from "./event-sync-cron.js";
import {
  handleStaleProposalCron,
  STALE_PROPOSAL_CRON_QUEUE,
} from "./stale-proposal-cron.js";
import {
  handleBrokenAutomationCron,
  BROKEN_AUTOMATION_CRON_QUEUE,
} from "./broken-automation-cron.js";
import { handleEventEndCron, EVENT_END_CRON_QUEUE } from "./event-end-cron.js";
import { handleSessionRecap, SESSION_RECAP_QUEUE } from "./session-recap.js";
import { handleEntityExtract } from "./entity-extract-worker.js";
import {
  handleProactiveScan,
  PROACTIVE_SCAN_QUEUE,
} from "./proactive-intelligence.js";
import {
  handleProposalReviewedNotify,
  PROPOSAL_REVIEWED_NOTIFY_QUEUE,
} from "./proposal-reviewed-notifier.js";
import { handleMemoryDecay, MEMORY_DECAY_QUEUE } from "./memory-decay.js";
import {
  handleCapabilityTemplateSync,
  CAPABILITY_TEMPLATE_SYNC_QUEUE,
} from "./capability-template-sync.js";
import {
  handleCpCatalogSync,
  CP_CATALOG_SYNC_QUEUE,
} from "./cp-catalog-sync.js";
import {
  handleCpProjectSync,
  CP_PROJECT_SYNC_QUEUE,
} from "./cp-project-sync.js";
import {
  ensureSystemProfiles,
  registerCpProjectSyncTrigger,
} from "@synap/database";
import {
  handlePageRankCentrality,
  PAGERANK_CENTRALITY_QUEUE,
} from "./pagerank-centrality.js";
import {
  handlePodHygieneNearDupScan,
  POD_HYGIENE_NEAR_DUP_QUEUE,
} from "./pod-hygiene-near-dup.js";
export {
  isSentinelTitle,
  findPropertyKeyAliasHits,
  classifyIdentityHygieneEntity,
  IDENTITY_SCAN_KINDS,
  PROPERTY_KEY_ALIASES,
} from "./hygiene-identity-patterns.js";
import {
  handleGovernanceLaneScan,
  GOVERNANCE_LANE_SCANNER_QUEUE,
} from "./governance-lane-scanner.js";
import {
  handleLibrarianArchiver,
  LIBRARIAN_ARCHIVER_QUEUE,
} from "./librarian-archiver.js";
import {
  handleContextCardRefresh,
  CONTEXT_CARD_REFRESH_QUEUE,
} from "./context-card-refresh.js";

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
  "ai-analysis",
  "materialize",
  "side-effects",
  "search-reindex",
  A2AI_TRIGGER_QUEUE,
  "automation-trigger-match",
  "automation-execute",
  "automation-cron-scheduler",
  AUTOMATION_RUN_REAPER_QUEUE,
  FOCUS_SESSION_REAPER_QUEUE,
  PLAYBOOK_RUN_REAPER_QUEUE,
  CHAT_TURN_REAPER_QUEUE,
  "relation-backfill",
  VAULT_GRANT_EXPIRY_QUEUE,
  NOTIFICATION_CLEANUP_QUEUE,
  FEDERATION_RECEIPT_CLEANUP_QUEUE,
  "feed-scheduler",
  FEED_SOURCE_EXECUTE_QUEUE,
  FEED_SOURCE_ITEMS_QUEUE,
  LINKEDIN_BULK_IMPORT_QUEUE,
  IMPORT_CORPUS_QUEUE,
  SYNC_PUSH_QUEUE,
  SYNC_PULL_QUEUE,
  SYNC_PUSH_FILES_QUEUE,
  SYNC_PUSH_SUPPLEMENTARY_QUEUE,
  "hydration-summary-post",
  CRM_DAILY_DIGEST_QUEUE,
  MAIL_FEED_CRON_QUEUE,
  EVENT_SYNC_CRON_QUEUE,
  STALE_PROPOSAL_CRON_QUEUE,
  BROKEN_AUTOMATION_CRON_QUEUE,
  EVENT_END_CRON_QUEUE,
  SESSION_RECAP_QUEUE,
  PROACTIVE_SCAN_QUEUE,
  PROPOSAL_REVIEWED_NOTIFY_QUEUE,
  MEMORY_DECAY_QUEUE,
  CAPABILITY_TEMPLATE_SYNC_QUEUE,
  CP_CATALOG_SYNC_QUEUE,
  CP_PROJECT_SYNC_QUEUE,
  // Was MISSING while its worker+schedule existed — pg-boss v10 schedule() FK
  // violated → registerCronSchedules aborted → every cron after cal-backfill
  // in cron.ts silently never scheduled (found live 2026-07-12).
  CAL_BACKFILL_CRON_QUEUE,
  FIREFLIES_INGEST_QUEUE,
  FIREFLIES_BACKFILL_CRON_QUEUE,
  INBOUND_ATTACHMENT_QUEUE,
  API_KEY_ROTATION_CHECK_QUEUE,
  PAGERANK_CENTRALITY_QUEUE,
  POD_HYGIENE_NEAR_DUP_QUEUE,
  LIBRARIAN_ARCHIVER_QUEUE,
  CONTEXT_CARD_REFRESH_QUEUE,
];

/**
 * Queues whose worker has been DELETED from the code. pg-boss doesn't prune
 * these on its own, so we explicitly unschedule + delete them on boot (see the
 * retirement loop in `registerAllWorkers`). Keep the name here even long after
 * removal — it stays a cheap idempotent no-op once the queue is gone.
 */
const RETIRED_QUEUES: string[] = [
  // Removed 2026-07: stamped `settings.packageVersion` WITHOUT reconciling
  // content (so it lied) AND keyed on the vestigial `package_slug` column
  // (near-always NULL) instead of the JSONB the drift surfaces read — it never
  // healed the workspaces it was meant to. The boot-sweep stamp-on-reconcile
  // (`reconcile-workspaces-to-templates.ts`) is now the single truthful stamp.
  "package-version-backfill",
  // Removed 2026-08-15: the nightly LLM pattern detector asked the IS to GUESS
  // which activity should become an automation, then wrote a draft automation
  // DIRECTLY — no proposal row, so it bypassed the review inbox entirely. It
  // produced nothing in two weeks on the live pod. Its replacement mines the
  // human approval log instead of guessing, and files a normal proposal.
  "automation-pattern-detect",
];

/**
 * Wave 4.R retry census (PHASE 4 F4): queues whose handler's terminal effect is
 * an unguarded, non-idempotent message/digest insert AND whose work is recurring
 * (a genuine miss is covered by the next scheduled tick) get retryLimit:0. A
 * pg-boss redelivery would only re-post a duplicate (and re-bill the IS) with no
 * recovery value. Narrow by design — most other side-effecting handlers either
 * swallow their own errors (never retried) or benefit from retry (webhook
 * delivery, whose consumers dedupe on X-Synap-Event-Id).
 *
 * Currently empty — the only census member (feed-proactive-execute) was removed
 * with the dead proactive-digest worker; keep the mechanism for future
 * retry-free recurring inserts.
 */
const NO_RETRY_QUEUES = new Set<string>([]);

/**
 * Queues whose handler is a LONG, NON-IDEMPOTENT walk that must never be
 * redelivered while it is still executing.
 *
 * THE BUG THIS CLOSES (2026-07-31). pg-boss 10.4.2 gives every queue a default
 * `expire_in` of 15 minutes (`src/plans.js:192`). When that elapses,
 * `failJobsByTimeout` (`src/plans.js:566`) DELETEs the active row and re-INSERTs
 * it as a retry — while the Node handler is still running. With the boss.ts
 * default `retryLimit: 3`, a walk over 15 minutes therefore executes up to FOUR
 * times, concurrently.
 *
 * Nothing downstream caught it:
 *   - The executor's redelivery guard (`automation-executor.ts`, the
 *     `run.status !== "running"` check) cannot help: a run that is STILL
 *     EXECUTING is `running`, so the guard passes and the DAG re-walks from an
 *     empty `completedNodeIds`.
 *   - Only `notification` and `channel_message` steps carry an `outputIdemId`.
 *     `entity_create` does NOT — so entity writes, document materialization and
 *     governance proposals duplicate on every redelivery.
 *   - The run reaper fires at 45 minutes (REAPER_STALE_MINUTES), three times
 *     LATER than the 15-minute reclaim. It never gets there first.
 *
 * The walk got longer in the same wave that found this: `is-call-budget.ts`
 * raised the per-call `generation` budget to 180s, and the executor's per-step
 * retry loop allows 3 retries — so ONE `ai.generate` step is now up to
 * 4 × 180s = 12 minutes. Two AI steps, or one loop node with an AI call inside,
 * clears 900s trivially. The defect was latent before that change; it is
 * reachable after it.
 *
 * The policy (decision "C"): retryLimit 0 AND an explicit expiry BELOW the
 * reaper's 45-minute threshold.
 *   - `retryLimit: 0` closes duplicate execution BY CONSTRUCTION, at any walk
 *     length — not by a number staying larger than the longest walk forever.
 *     Every future budget raise would otherwise re-open this.
 *   - `expireInSeconds: 2400` (40 min) bounds the job's lifetime instead of
 *     inheriting 900s, and sitting UNDER 2700s keeps the ordering sane: pg-boss
 *     marks the job failed first, THEN the reaper finalizes the run row and
 *     posts the summary. Above 2700s the reaper would mark a still-executing run
 *     `failed` and report a completed run as a failure.
 *
 * THE COST, stated plainly: a hard worker death (redeploy SIGTERM, OOM) no
 * longer auto-retries. The run stays `running` until the reaper sweeps it —
 * 45-minute threshold plus up to 5 minutes of cron latency, so up to ~50 minutes
 * before the user sees `failed`. That is the deliberate trade: crash-recovery
 * latency in exchange for never double-writing entities.
 */
const LONG_WALK_QUEUES = new Map<string, number>([
  ["automation-execute", 2400],
]);

/**
 * Register all pg-boss workers.
 * Must be called after startBoss().
 */
export async function registerAllWorkers(): Promise<void> {
  const boss = getBoss();

  // Reconcile system-owned profile contracts on every worker deployment, not
  // just when a new workspace is created. This lets existing pods receive
  // schema and renderer upgrades without waiting for unrelated workspace work.
  // The routine is idempotent and preserves user-owned overrides; workspace
  // init remains a safe retry when the database is briefly unavailable at boot.
  try {
    const profileResult = await ensureSystemProfiles();
    logger.info(
      { ...profileResult },
      "System profiles reconciled at worker boot"
    );
  } catch (err) {
    logger.warn(
      { err },
      "System profile reconciliation failed at worker boot; workspace init will retry"
    );
  }

  // Create all queues first (pg-boss v10 requires this before work/schedule)
  for (const name of ALL_QUEUES) {
    const longWalkExpiry = LONG_WALK_QUEUES.get(name);
    const policy =
      longWalkExpiry !== undefined
        ? { name, retryLimit: 0, expireInSeconds: longWalkExpiry }
        : NO_RETRY_QUEUES.has(name)
          ? { name, retryLimit: 0 }
          : undefined;
    await boss.createQueue(name, policy);
    // createQueue is `ON CONFLICT DO NOTHING`, so a queue that already exists on
    // the pod keeps its old policy. updateQueue forces the retry-free policy for
    // the census queues on redeploy too (pg-boss resolves a job's retry as
    // COALESCE(jobRetry, queueRetry, ctorDefault) — a queue policy of 0 wins over
    // the boss.ts default of 3 for any send that doesn't set retryLimit itself).
    // WITHOUT this updateQueue the fix would be a no-op on every existing pod:
    // `automation-execute` already exists there with the inherited 15-min/retry-3
    // policy, so createQueue silently does nothing.
    if (policy) {
      await boss.updateQueue(name, policy);
    }
  }
  logger.info({ count: ALL_QUEUES.length }, "Created all pg-boss queues");

  // Retire queues whose worker was removed from the code. pg-boss NEVER prunes
  // queues or schedules on its own (ALL_QUEUES is create-only, `schedule()` only
  // upserts), so a deleted cron leaves an orphaned schedule that keeps minting
  // jobs into a queue nothing consumes — they pile up forever. Explicitly
  // unschedule THEN delete each retired queue. Idempotent + non-fatal: both are
  // no-ops once the queue is gone, so this is safe to keep across redeploys.
  for (const name of RETIRED_QUEUES) {
    try {
      await boss.unschedule(name);
      await boss.deleteQueue(name);
      logger.info({ queue: name }, "Retired orphaned pg-boss queue");
    } catch (err) {
      logger.warn(
        { err, queue: name },
        "Retired-queue cleanup failed (non-fatal)"
      );
    }
  }

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

  // API key rotation check (cron: daily) — flag-only, see worker header.
  await boss.work(API_KEY_ROTATION_CHECK_QUEUE, async () =>
    handleApiKeyRotationCheck()
  );
  logger.info("Registered worker: api-key-rotation-check");

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

  // Automation run reaper (cron: every ~5min — finalizes stale "running" runs
  // orphaned by a setup-window throw or worker death; delay-suspended runs exempt)
  await boss.work(AUTOMATION_RUN_REAPER_QUEUE, async () =>
    handleAutomationRunReaper()
  );
  logger.info("Registered worker: automation-run-reaper");

  // Focus session reaper (cron: every hour — marks stale active/paused sessions)
  await boss.work(FOCUS_SESSION_REAPER_QUEUE, async () =>
    handleFocusSessionReaper()
  );
  logger.info("Registered worker: focus-session-reaper");

  // Playbook run reaper (cron: every ~30min — force-fails playbook_runs stuck
  // 'running' past PLAYBOOK_RUN_REAPER_STALE_HOURS with a quiet session; the
  // gap automation-run-reaper never covered)
  await boss.work(PLAYBOOK_RUN_REAPER_QUEUE, async () =>
    handlePlaybookRunReaper()
  );
  logger.info("Registered worker: playbook-run-reaper");

  // Chat turn reaper (cron: every ~15min — fails chat_turns stuck in "running"
  // after a mid-stream crash; threshold via CHAT_TURN_STUCK_HOURS, default 2h)
  await boss.work(CHAT_TURN_REAPER_QUEUE, async () => handleChatTurnReaper());
  logger.info("Registered worker: chat-turn-reaper");

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

  // Notification cleanup (cron: daily at 2:00 AM UTC)
  await boss.work(NOTIFICATION_CLEANUP_QUEUE, async () =>
    handleNotificationCleanup()
  );
  logger.info("Registered worker: notification-cleanup");

  // Federation receipt cleanup (cron: daily at 2:15 AM UTC)
  await boss.work(FEDERATION_RECEIPT_CLEANUP_QUEUE, async () =>
    handleFederationReceiptCleanup()
  );
  logger.info("Registered worker: federation-receipt-cleanup");

  // Feed scheduler (cron: every minute — schedules due source subscription fetches)
  await boss.work("feed-scheduler", async () => handleFeedScheduler());
  logger.info("Registered worker: feed-scheduler");

  // Feed pluggable source executor (Phase 1 + 2) — fetches one subscription via
  // the provider registry. Downstream items land on FEED_SOURCE_ITEMS_QUEUE
  // for Agent 3's classifier/publisher to consume.
  await boss.work(FEED_SOURCE_EXECUTE_QUEUE, async ([job]: any[]) =>
    handleFeedSourceExecute(job)
  );
  logger.info("Registered worker: feed-source-execute");

  // Entity extraction (consumes items from FEED_SOURCE_ITEMS_QUEUE — dedup, IS classify, filter, create entities, post to proactive feed)
  await boss.work("feed-source-items", async ([job]: any[]) =>
    handleEntityExtract(job)
  );
  logger.info("Registered worker: feed-source-items (entity-extract)");

  // Contacts archive imports (on-demand — heavy batch upserts)
  await boss.work(LINKEDIN_BULK_IMPORT_QUEUE, async ([job]: any[]) =>
    handleLinkedInBulkImport(job)
  );
  logger.info("Registered worker: linkedin-bulk-import");

  // Large corpus import (on-demand — heavy background analyzeLarge → governed
  // import.graph proposal). Handler slot filled by the api layer at boot (IoC).
  await boss.work(IMPORT_CORPUS_QUEUE, async ([job]: any[]) =>
    handleImportCorpus(job)
  );
  logger.info("Registered worker: import-corpus");

  // Hydration summary post — Orchestrator's first proactive message after
  // import review (Gap 3 of onboarding). One attempt, swallow-on-fail.
  await boss.work("hydration-summary-post", async ([job]: any[]) =>
    handleHydrationSummaryPost(job)
  );
  logger.info("Registered worker: hydration-summary-post");

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

  // CRM daily digest (cron: daily at 08:55 UTC)
  // Posts unread linked messages + overdue follow-ups to each user's personal channel.
  await boss.work(CRM_DAILY_DIGEST_QUEUE, async ([job]: any[]) =>
    handleCrmDailyDigest(job)
  );
  logger.info("Registered worker: crm-daily-digest");

  // Mail feed (cron: every 2h) — invokes the api-side mail-feed runner in-process
  // (IoC slot) to fetch + triage Gmail and post relevant emails to the Discord-bound channel.
  await boss.work(MAIL_FEED_CRON_QUEUE, async ([job]: any[]) =>
    handleMailFeedCron(job)
  );
  logger.info("Registered worker: mail-feed-cron");

  // Cal.com backfill (cron: every 30min) — invokes the api-side backfill runner
  // in-process (IoC slot) to capture any Cal.com booking the webhook missed.
  await boss.work(CAL_BACKFILL_CRON_QUEUE, async ([job]: any[]) =>
    handleCalBackfillCron(job)
  );
  logger.info("Registered worker: cal-backfill-cron");

  // Fireflies transcript ingest (on-demand) — the inbound webhook enqueues one
  // job per completed meeting; the api-side runner (IoC slot) fetches the
  // transcript and lands it as a channel message via recordInboundMessage.
  // Re-throws on failure so pg-boss retries; the backfill cron is the last net.
  await boss.work(FIREFLIES_INGEST_QUEUE, async ([job]: any[]) =>
    handleFirefliesIngest(job)
  );
  logger.info("Registered worker: fireflies-ingest");

  // Fireflies backfill (cron: every 30min) — invokes the api-side backfill runner
  // in-process (IoC slot) to re-ingest any transcript whose completion webhook was
  // missed. No-ops unless the fireflies tool has fireflies.backfill.enabled.
  await boss.work(FIREFLIES_BACKFILL_CRON_QUEUE, async ([job]: any[]) =>
    handleFirefliesBackfillCron(job)
  );
  logger.info("Registered worker: fireflies-backfill-cron");

  // Inbound attachment ingest (on-demand) — the inbound sensor recorder enqueues
  // one job per inbound message that carried attachments; the api-side runner
  // (IoC slot) fetches each url's bytes and stores it via the GOVERNED file door,
  // then links the `file` entity to the channel + message. Swallows on failure.
  await boss.work(INBOUND_ATTACHMENT_QUEUE, async ([job]: any[]) =>
    handleInboundAttachmentIngest(job)
  );
  logger.info("Registered worker: inbound-attachment-ingest");

  // Event sync (cron: every 6h) — invokes the api-side event-sync runner in-process
  // (IoC slot) to mirror upcoming events + Stellar deadlines + Google Calendar into
  // native Discord scheduled events.
  await boss.work(EVENT_SYNC_CRON_QUEUE, async ([job]: any[]) =>
    handleEventSyncCron(job)
  );
  logger.info("Registered worker: event-sync-cron");

  // Stale-proposal scan (cron: every 6h) — invokes the api-side runner in-process
  // (IoC slot) to notify owners of pending proposals whose target workspace is gone.
  await boss.work(STALE_PROPOSAL_CRON_QUEUE, async ([job]: any[]) =>
    handleStaleProposalCron(job)
  );
  logger.info("Registered worker: stale-proposal-cron");

  // Broken-automation scan (cron: every 6h) — invokes the api-side runner
  // in-process (IoC slot) to notify members of automations in status='error'.
  await boss.work(BROKEN_AUTOMATION_CRON_QUEUE, async ([job]: any[]) =>
    handleBrokenAutomationCron(job)
  );
  logger.info("Registered worker: broken-automation-cron");

  // Event end (cron: every 5min) — invokes the api-side event-end runner
  // in-process (IoC slot) to flip focus sessions bound to just-ended events into
  // their `post` stage, which triggers the session recap.
  await boss.work(EVENT_END_CRON_QUEUE, async ([job]: any[]) =>
    handleEventEndCron(job)
  );
  logger.info("Registered worker: event-end-cron");

  // Session recap (on-demand) — enqueued by the session-recap reactor when a
  // focus session advances to the `post` stage. Delegates to the api-side runner
  // (IoC slot) which summarizes the session's captures + posts a governed recap.
  await boss.work(SESSION_RECAP_QUEUE, async ([job]: any[]) =>
    handleSessionRecap(job)
  );
  logger.info("Registered worker: session-recap");

  // Proactive scan — cluster assembly → intelligence-service brain. Reachable as
  // an action a loop/automation can invoke (no parallel per-event auto-trigger).
  await boss.work(PROACTIVE_SCAN_QUEUE, async ([job]: any[]) =>
    handleProactiveScan(job)
  );
  logger.info("Registered worker: proactive.scan");

  // Proposal reviewed notifier (on-demand — posts a status message back to the
  // originating channel so waiting agents can resume work after approval/rejection)
  await boss.work(PROPOSAL_REVIEWED_NOTIFY_QUEUE, async ([job]: any[]) =>
    handleProposalReviewedNotify(job)
  );
  logger.info("Registered worker: proposal-reviewed-notifier");

  // Memory decay (cron: daily at 03:30 UTC — applies Ebbinghaus decay to knowledge_facts)
  await boss.work(MEMORY_DECAY_QUEUE, async () => handleMemoryDecay());
  logger.info("Registered worker: memory-decay");

  // Capability template sync — handler still registered so a manually/legacy-
  // enqueued job runs, but NO LONGER cron-scheduled or startup-enqueued: the
  // cron was cut over to cp-catalog-sync below (P2.4-B). See the worker's header.
  await boss.work(CAPABILITY_TEMPLATE_SYNC_QUEUE, async () =>
    handleCapabilityTemplateSync()
  );
  logger.info("Registered worker: capability-template-sync");

  // CP catalog sync (cron: every 10min + on startup — refreshes the pod-local
  // cp_catalog_cache across all four marketplace kinds). This is now the SOLE
  // cron catalog sync — it superseded capability-template-sync above (P2.4-B).
  await boss.work(CP_CATALOG_SYNC_QUEUE, async () => handleCpCatalogSync());
  logger.info("Registered worker: cp-catalog-sync");

  // CP project directory sync (cron: every 30min + on startup + one-off pushes
  // from ProjectRepository mutations). Announces the pod's full project list to
  // the Control Plane `pod_projects` mirror (P4-lite W1). The IoC slot below is
  // how @synap/database (which cannot import @synap/events) enqueues the
  // one-offs — ProjectRepository.create/update/delete is the ONE trigger door.
  await boss.work(CP_PROJECT_SYNC_QUEUE, async () => handleCpProjectSync());
  registerCpProjectSyncTrigger(() => {
    // singletonKey debounces mutation bursts: N project writes within the
    // window collapse into one full-list push (each push is a full snapshot,
    // so coalescing loses nothing; the 30-min reconcile is the backstop).
    void boss
      .send(
        CP_PROJECT_SYNC_QUEUE,
        {},
        { singletonKey: "cp-project-sync-debounce", singletonSeconds: 30 }
      )
      .catch((err) => {
        logger.warn(
          { err },
          "cp-project-sync enqueue failed (reconcile cron will catch up)"
        );
      });
  });
  logger.info("Registered worker: cp-project-sync (+ repository trigger)");

  // PageRank centrality (cron: every 6h + on startup — recomputes global
  // PageRank over each user's relation graph into entity_centrality, which
  // Horizon reads as its centrality signal C).
  await boss.work(PAGERANK_CENTRALITY_QUEUE, async () =>
    handlePageRankCentrality()
  );
  logger.info("Registered worker: pagerank-centrality");

  // Pod hygiene near-dup scan (cron: daily 03:15 UTC — files merge proposals only)
  await boss.work(POD_HYGIENE_NEAR_DUP_QUEUE, async () =>
    handlePodHygieneNearDupScan()
  );
  logger.info("Registered worker: pod-hygiene.near-dup-scan");

  // Governance trusted-lane scanner (cron: daily 03:30 UTC — files
  // governance.widen_lane proposals only; never writes governance_rules)
  await boss.work(GOVERNANCE_LANE_SCANNER_QUEUE, async () =>
    handleGovernanceLaneScan()
  );
  logger.info("Registered worker: governance.lane-scan");

  await boss.work(LIBRARIAN_ARCHIVER_QUEUE, async () =>
    handleLibrarianArchiver()
  );
  logger.info("Registered worker: librarian.project-archiver");

  // Context-card refresh (cron: daily 06:10 UTC — enqueues one
  // refresh_context_card egress per Discord client TEAM thread so the bridge
  // re-renders the pinned card with fresh status/deals/activity).
  await boss.work(CONTEXT_CARD_REFRESH_QUEUE, async () =>
    handleContextCardRefresh()
  );
  logger.info("Registered worker: context-card-refresh");

  logger.info("All workers registered");
}
