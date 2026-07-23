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
import {
  CP_CATALOG_SYNC_QUEUE,
  CP_CATALOG_SYNC_CRON,
} from "./workers/cp-catalog-sync.js";
import {
  CP_PROJECT_SYNC_QUEUE,
  CP_PROJECT_SYNC_CRON,
} from "./workers/cp-project-sync.js";
import {
  PAGERANK_CENTRALITY_QUEUE,
  PAGERANK_CENTRALITY_CRON,
} from "./workers/pagerank-centrality.js";
import {
  POD_HYGIENE_NEAR_DUP_QUEUE,
  POD_HYGIENE_NEAR_DUP_CRON,
} from "./workers/pod-hygiene-near-dup.js";
import {
  LIBRARIAN_ARCHIVER_QUEUE,
  LIBRARIAN_ARCHIVER_CRON,
} from "./workers/librarian-archiver.js";
import {
  PACKAGE_VERSION_BACKFILL_QUEUE,
  PACKAGE_VERSION_BACKFILL_CRON,
} from "./workers/package-version-backfill.js";
import {
  AUTOMATION_RUN_REAPER_QUEUE,
  AUTOMATION_RUN_REAPER_CRON,
} from "./workers/automation-run-reaper.js";
import { EVENT_END_CRON_QUEUE } from "./workers/event-end-cron.js";
import { FEDERATION_RECEIPT_CLEANUP_QUEUE } from "./workers/federation-receipt-cleanup.js";

const logger = createLogger({ module: "cron-scheduler" });

/**
 * One broken schedule (e.g. a queue missing from ALL_QUEUES — pg-boss v10 FK)
 * must never abort the whole registrar: before this guard, cal-backfill-cron's
 * missing queue silently unregistered EVERY cron declared after it (found live
 * 2026-07-12 — cp-catalog-sync and friends never ran). Log loud, keep going.
 */
async function scheduleSafe(
  boss: { schedule: (n: string, c: string, d: object) => Promise<unknown> },
  name: string,
  cron: string,
  data: object = {}
): Promise<void> {
  try {
    await boss.schedule(name, cron, data);
  } catch (err) {
    logger.error(
      { err, queue: name },
      "Cron schedule registration FAILED — skipping this cron (is the queue in ALL_QUEUES?)"
    );
  }
}

async function sendSafe(
  boss: { send: (n: string, d: object) => Promise<unknown> },
  name: string,
  data: object = {}
): Promise<void> {
  try {
    await boss.send(name, data);
  } catch (err) {
    logger.error(
      { err, queue: name },
      "Startup enqueue FAILED — skipping (is the queue in ALL_QUEUES?)"
    );
  }
}

/**
 * Register all cron schedules with pg-boss.
 * Call once after boss.start().
 */
export async function registerCronSchedules(): Promise<void> {
  const boss = getBoss();

  // Document auto-save (every 30 minutes)
  await scheduleSafe(boss, "doc-autosave", "*/30 * * * *", {});
  logger.info("Registered cron: doc-autosave (every 30min)");

  // Whiteboard auto-save (every 30 minutes)
  await scheduleSafe(boss, "whiteboard-autosave", "*/30 * * * *", {});
  logger.info("Registered cron: whiteboard-autosave (every 30min)");

  // Document persistence (every 10 minutes)
  await scheduleSafe(boss, "doc-persistence", "*/10 * * * *", {});
  logger.info("Registered cron: doc-persistence (every 10min)");

  // Search bulk-index catch-up (every 5 minutes).
  // Individual items are indexed immediately via indexNow(); this cron only flushes
  // items that were queued as fallback when Typesense was temporarily unavailable.
  await scheduleSafe(boss, "search-bulk-index", "*/5 * * * *", {});
  logger.info("Registered cron: search-bulk-index (every 5min, catch-up only)");

  // Intelligence service health checks (every 2 minutes)
  await scheduleSafe(boss, "intelligence-health-check", "*/2 * * * *", {});
  logger.info("Registered cron: intelligence-health-check (every 2min)");

  // API key rotation check (daily at 04:00 UTC — flags agent hub keys whose
  // rotation_scheduled_at has passed; flag-only, no auto-rotation)
  await scheduleSafe(boss, "api-key-rotation-check", "0 4 * * *", {});
  logger.info("Registered cron: api-key-rotation-check (daily at 04:00 UTC)");

  // Automation cron scheduler (every 1 minute — checks due cron-triggered automations)
  await scheduleSafe(boss, "automation-cron-scheduler", "* * * * *", {});
  logger.info("Registered cron: automation-cron-scheduler (every 1min)");

  // Automation run reaper (every ~5min — finalizes stale "running" automation
  // runs orphaned by a setup-window throw or worker death; delay-suspended exempt)
  await scheduleSafe(
    boss,
    AUTOMATION_RUN_REAPER_QUEUE,
    AUTOMATION_RUN_REAPER_CRON,
    {}
  );
  logger.info("Registered cron: automation-run-reaper (every 5min)");

  // Vault grant expiry (every hour — expires TTL-bounded approved vault.request proposals)
  await scheduleSafe(boss, "vault-grant-expiry", "0 * * * *", {});
  logger.info("Registered cron: vault-grant-expiry (every hour)");

  // Automation pattern detection (daily at 3:00 AM UTC)
  await scheduleSafe(boss, "automation-pattern-detect", "0 3 * * *", {});
  logger.info(
    "Registered cron: automation-pattern-detect (daily at 3:00 AM UTC)"
  );

  // Pod hygiene near-dup scan (daily at 3:15 AM UTC — after pattern-detect).
  // Files PENDING entity merge proposals only; never auto-merges.
  await scheduleSafe(
    boss,
    POD_HYGIENE_NEAR_DUP_QUEUE,
    POD_HYGIENE_NEAR_DUP_CRON,
    {}
  );
  logger.info(
    "Registered cron: pod-hygiene.near-dup-scan (daily at 3:15 AM UTC)"
  );

  // Librarian project archiver (daily at 3:45 AM UTC — after near-dup at 3:15).
  // Proposes archival of stale 0-gravity active projects; never auto-archives.
  await scheduleSafe(
    boss,
    LIBRARIAN_ARCHIVER_QUEUE,
    LIBRARIAN_ARCHIVER_CRON,
    {}
  );
  logger.info(
    "Registered cron: librarian.project-archiver (daily at 3:45 AM UTC)"
  );

  // Notification cleanup (daily at 2:00 AM UTC — expires/deletes old notifications)
  await scheduleSafe(boss, "notification-cleanup", "0 2 * * *", {});
  logger.info("Registered cron: notification-cleanup (daily at 2:00 AM UTC)");

  // Federation receipts are short-lived and single-use. Remove only receipts
  // already past expiry; the indexed predicate keeps this maintenance bounded.
  await scheduleSafe(boss, FEDERATION_RECEIPT_CLEANUP_QUEUE, "15 2 * * *", {});
  logger.info(
    "Registered cron: federation-receipt-cleanup (daily at 2:15 AM UTC)"
  );

  // Feed scheduler (every minute — checks for due feeds and enqueues execution jobs)
  await scheduleSafe(boss, "feed-scheduler", "* * * * *", {});
  logger.info("Registered cron: feed-scheduler (every 1min)");

  // Pod-to-pod replication — event log (catch-up + cursor maintenance; realtime hook is primary path)
  await scheduleSafe(boss, "sync-push", "* * * * *", {});
  logger.info("Registered cron: sync-push (every 1min)");
  await scheduleSafe(boss, "sync-pull", "* * * * *", {});
  logger.info("Registered cron: sync-pull (every 1min)");

  // Non-event payloads (large file blobs; less frequent)
  await scheduleSafe(boss, "sync-push-files", "*/10 * * * *", {});
  logger.info("Registered cron: sync-push-files (every 10min)");
  await scheduleSafe(boss, "sync-push-supplementary", "*/5 * * * *", {});
  logger.info("Registered cron: sync-push-supplementary (every 5min)");

  // CRM daily digest (daily at 08:55 UTC — fires just before most workdays start)
  // Only runs if at least one user has connected messaging accounts.
  await scheduleSafe(boss, "crm-daily-digest", "55 8 * * *", {});
  logger.info("Registered cron: crm-daily-digest (daily at 08:55 UTC)");

  // Mail feed (every 2 hours — the cron worker invokes the api-side mail-feed
  // runner in-process (IoC slot) to fetch + triage Gmail and post relevant
  // emails to the Discord-bound channel). No-ops unless the pod's Discord tool
  // has mailFeed.enabled.
  await scheduleSafe(boss, "mail-feed-cron", "0 */2 * * *", {});
  logger.info("Registered cron: mail-feed-cron (every 2h)");

  // Cal.com backfill (every 30min) — lists upcoming bookings and captures any not
  // yet seen (safety net for the inbound webhook). No-ops unless the cal_com tool
  // has calcom.backfill.enabled.
  await scheduleSafe(boss, "cal-backfill-cron", "*/30 * * * *", {});
  logger.info("Registered cron: cal-backfill-cron (every 30min)");

  // Event sync (every 6 hours — the cron worker invokes the api-side runner
  // in-process (IoC slot): FIRST imports Google Calendar → Synap `event`
  // entities, THEN mirrors upcoming Synap events + Stellar deadlines into
  // native Discord scheduled events). No-ops unless the pod's Discord tool has
  // eventSync.enabled.
  await scheduleSafe(boss, "event-sync-cron", "0 */6 * * *", {});
  logger.info("Registered cron: event-sync-cron (every 6h)");

  // Event end (every 5 min — the cron worker invokes the api-side event-end
  // runner in-process (IoC slot) which flips focus sessions bound to an event
  // whose endDate just crossed into their `post` stage, triggering the recap).
  // Idempotent via a systemData.eventEndFired stamp on the event entity.
  await scheduleSafe(boss, EVENT_END_CRON_QUEUE, "*/5 * * * *", {});
  logger.info("Registered cron: event-end-cron (every 5min)");

  // Memory decay (daily at 03:30 UTC — applies Ebbinghaus decay to knowledge_facts)
  await scheduleSafe(boss, "memory-decay", "30 3 * * *", {});
  logger.info("Registered cron: memory-decay (daily at 03:30 UTC)");

  // Capability template sync — refresh the pod-local capability_template_cache
  // from the Control Plane every 10 minutes, AND once now (on startup) so a cold
  // pod populates its cache without waiting for the first cron tick. The catalog
  // read path serves from this cache, so it never blocks on a slow/down CP.
  await scheduleSafe(
    boss,
    CAPABILITY_TEMPLATE_SYNC_QUEUE,
    CAPABILITY_TEMPLATE_SYNC_CRON,
    {}
  );
  logger.info("Registered cron: capability-template-sync (every 10min)");
  await sendSafe(boss, CAPABILITY_TEMPLATE_SYNC_QUEUE, {});
  logger.info("Enqueued startup run: capability-template-sync");

  // CP catalog sync — refresh the pod-local cp_catalog_cache (all four
  // marketplace kinds) every 10 minutes, AND once now on startup. Additive to
  // capability-template-sync above (P2.4-B) — both run until a later cutover.
  await scheduleSafe(boss, CP_CATALOG_SYNC_QUEUE, CP_CATALOG_SYNC_CRON, {});
  logger.info("Registered cron: cp-catalog-sync (every 10min)");
  await sendSafe(boss, CP_CATALOG_SYNC_QUEUE, {});
  logger.info("Enqueued startup run: cp-catalog-sync");

  // CP project directory sync — announce the pod's full project list to the
  // Control Plane every 30 minutes (reconcile), AND once now on startup so a
  // freshly provisioned pod appears in the directory without waiting. Project
  // CRUD additionally enqueues one-off runs via the repository trigger (see
  // workers/index.ts). No-ops when the pod has no CP config (self-hosted).
  await scheduleSafe(boss, CP_PROJECT_SYNC_QUEUE, CP_PROJECT_SYNC_CRON, {});
  logger.info("Registered cron: cp-project-sync (every 30min)");
  await sendSafe(boss, CP_PROJECT_SYNC_QUEUE, {});
  logger.info("Enqueued startup run: cp-project-sync");

  // PageRank centrality (every 6h + one startup run so a cold pod populates
  // entity_centrality without waiting for the first tick — this is also the
  // "devplane re-seed"-style on-demand trigger: boss.send(PAGERANK_CENTRALITY_QUEUE)).
  await scheduleSafe(
    boss,
    PAGERANK_CENTRALITY_QUEUE,
    PAGERANK_CENTRALITY_CRON,
    {}
  );
  logger.info("Registered cron: pagerank-centrality (every 6h at :20)");
  await sendSafe(boss, PAGERANK_CENTRALITY_QUEUE, {});
  logger.info("Enqueued startup run: pagerank-centrality");

  // Package version backfill — self-heals workspaces installed before
  // `settings.packageVersion` existed, by stamping the version currently
  // known for their `package_slug` in cp_catalog_cache. Every 30 minutes,
  // AND once now on startup so newly-synced cache rows (from
  // cp-catalog-sync's own startup run) can backfill immediately rather than
  // waiting for the first tick.
  await scheduleSafe(
    boss,
    PACKAGE_VERSION_BACKFILL_QUEUE,
    PACKAGE_VERSION_BACKFILL_CRON,
    {}
  );
  logger.info("Registered cron: package-version-backfill (every 30min)");
  await sendSafe(boss, PACKAGE_VERSION_BACKFILL_QUEUE, {});
  logger.info("Enqueued startup run: package-version-backfill");

  logger.info("All cron schedules registered");
}
