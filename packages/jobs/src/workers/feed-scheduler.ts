/**
 * Feed Scheduler Worker
 *
 * Cron job that runs every minute.
 * Queries feed channels where nextRunAt <= NOW() or triggerRequested is set,
 * and enqueues feed execution jobs.
 *
 * Priority:
 *   - RSS feeds: priority 5
 *   - Proactive feeds: priority 3
 *   - Manual triggers: priority 1 (highest)
 */

import { db, eq, and } from "@synap/database";
import {
  channels,
  ChannelType,
  ChannelStatus,
  sourceSubscriptions,
  sourceConfigs,
} from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { getBoss } from "@synap/events";
import type { RSSFeedConfig, ProactiveFeedConfig } from "@synap/shared-utils";
import { randomUUID } from "crypto";
import { calculateNextRun } from "../utils/feed-helpers.js";
import { FEED_SOURCE_EXECUTE_QUEUE } from "./feed-source-executor.js";

const logger = createLogger({ module: "feed-scheduler" });

// ── Constants ────────────────────────────────────────────────────────────────

/** Cron schedule for this worker (every minute) */
export const FEED_SCHEDULER_CRON = "* * * * *";

/** Queue names for feed execution */
const FEED_RSS_QUEUE = "feed-rss-execute";
const FEED_PROACTIVE_QUEUE = "feed-proactive-execute";

/** Job priorities */
const PRIORITY = {
  MANUAL: 1,
  RSS: 5,
  PROACTIVE: 3,
};

// ── Types ────────────────────────────────────────────────────────────────────

interface FeedChannelRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  metadata: unknown;
  updatedAt: Date;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Simple feed config parser without zod (types only).
 * Full validation happens at the API layer.
 */
function parseFeedConfig(
  data: unknown
): RSSFeedConfig | ProactiveFeedConfig | null {
  if (!data || typeof data !== "object") return null;
  const config = data as Record<string, unknown>;

  if (config.feedType !== "rss" && config.feedType !== "proactive") {
    return null;
  }

  return config as unknown as RSSFeedConfig | ProactiveFeedConfig;
}

/**
 * Check if a channel is due for execution.
 */
function isChannelDue(
  row: FeedChannelRow,
  config: RSSFeedConfig | ProactiveFeedConfig
): boolean {
  const metadata = row.metadata as Record<string, unknown> | null;
  const feedStatus = metadata?.feedStatus as Record<string, unknown> | null;

  // Check if manually triggered
  const triggerRequestedAt = feedStatus?.triggerRequestedAt as string | null;
  if (triggerRequestedAt) {
    return true;
  }

  // Check if nextRunAt is due
  const nextRunAt = feedStatus?.nextRunAt as string | null;
  if (nextRunAt) {
    const nextRun = new Date(nextRunAt);
    if (nextRun <= new Date()) {
      return true;
    }
  }

  // If no nextRunAt set, calculate from config
  if (!nextRunAt && (config as RSSFeedConfig | ProactiveFeedConfig).schedule) {
    const calculated = calculateNextRun(
      (config as RSSFeedConfig | ProactiveFeedConfig).schedule!,
      (config as RSSFeedConfig | ProactiveFeedConfig).timezone ?? "UTC"
    );
    return calculated <= new Date();
  }

  return false;
}

// ── Main Handler ─────────────────────────────────────────────────────────────

export async function handleFeedScheduler(): Promise<void> {
  logger.info("Starting feed scheduler check");

  const now = new Date();
  let scheduledCount = 0;
  let skippedCount = 0;

  try {
    // Query all active feed channels
    const feedChannels = await db.query.channels.findMany({
      where: and(
        eq(channels.channelType, ChannelType.FEED),
        eq(channels.status, ChannelStatus.ACTIVE)
      ),
      columns: {
        id: true,
        userId: true,
        workspaceId: true,
        metadata: true,
        updatedAt: true,
      },
    });

    logger.info({ count: feedChannels.length }, "Found feed channels");

    const boss = getBoss();

    for (const row of feedChannels) {
      try {
        // Parse feed config from metadata
        const metadata = row.metadata as Record<string, unknown> | null;
        const configData = metadata?.feedConfig;

        if (!configData) {
          logger.warn({ channelId: row.id }, "Feed channel missing config");
          skippedCount++;
          continue;
        }

        const config = parseFeedConfig(configData);
        if (!config) {
          logger.warn({ channelId: row.id }, "Invalid feed config");
          skippedCount++;
          continue;
        }

        // Skip disabled feeds
        if ((config as RSSFeedConfig | ProactiveFeedConfig).enabled === false) {
          skippedCount++;
          continue;
        }

        // Check if due
        if (!isChannelDue(row, config)) {
          skippedCount++;
          continue;
        }

        // Determine queue and priority
        const isManualTrigger = !!(
          metadata?.feedStatus as Record<string, unknown>
        )?.triggerRequestedAt;
        const queue =
          config.feedType === "rss" ? FEED_RSS_QUEUE : FEED_PROACTIVE_QUEUE;
        const priority = isManualTrigger
          ? PRIORITY.MANUAL
          : config.feedType === "rss"
            ? PRIORITY.RSS
            : PRIORITY.PROACTIVE;

        const runId = randomUUID();

        // Enqueue job
        await boss.send(
          queue,
          {
            channelId: row.id,
            userId: row.userId,
            workspaceId: row.workspaceId ?? undefined,
            config,
            runId,
            triggered: isManualTrigger,
          },
          { priority }
        );

        // Update channel metadata
        const currentStatus =
          (metadata?.feedStatus as Record<string, unknown>) ?? {};
        const updatedMetadata = {
          ...metadata,
          feedStatus: {
            ...currentStatus,
            currentRunId: runId,
            lastRunStatus: "running",
            // Clear trigger flag
            triggerRequestedAt: undefined,
          },
        };

        await db
          .update(channels)
          .set({
            metadata: updatedMetadata,
            updatedAt: now,
          })
          .where(eq(channels.id, row.id));

        logger.info(
          {
            channelId: row.id,
            feedType: config.feedType,
            queue,
            priority,
            runId,
          },
          "Scheduled feed execution"
        );

        scheduledCount++;
      } catch (err) {
        logger.error({ err, channelId: row.id }, "Failed to schedule feed");
        skippedCount++;
      }
    }

    // ── NEW: iterate source_subscriptions joined to source_configs ────────
    //
    // The pluggable source system (Phase 1 + 2) schedules fetches at the
    // subscription level, not the channel level. For each active, enabled
    // subscription whose lastFetchedAt is older than DEFAULT_POLL_INTERVAL_MS
    // (or null), enqueue a `feed-source-execute` job.
    //
    // This path coexists with the legacy channel-based path above; they share
    // no state. Agent 3 will eventually unify both under the feeds table.
    const sourceResult = await scheduleDueSourceSubscriptions();
    scheduledCount += sourceResult.scheduled;
    skippedCount += sourceResult.skipped;

    logger.info(
      {
        scheduled: scheduledCount,
        skipped: skippedCount,
      },
      "Feed scheduler complete"
    );
  } catch (err) {
    logger.error({ err }, "Feed scheduler failed");
    throw err;
  }
}

// ── Source Subscription Scheduling (Phase 1 + 2) ────────────────────────────

/** Default poll cadence when a subscription has no explicit cron. */
const DEFAULT_POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

async function scheduleDueSourceSubscriptions(): Promise<{
  scheduled: number;
  skipped: number;
}> {
  let scheduled = 0;
  let skipped = 0;

  // Inner join — we only care about subscriptions whose source_config is
  // enabled and whose subscription status is active.
  const rows = await db
    .select({
      subscriptionId: sourceSubscriptions.id,
      lastFetchedAt: sourceSubscriptions.lastFetchedAt,
      providerType: sourceConfigs.providerType,
      configEnabled: sourceConfigs.enabled,
    })
    .from(sourceSubscriptions)
    .innerJoin(
      sourceConfigs,
      eq(sourceSubscriptions.sourceConfigId, sourceConfigs.id)
    )
    .where(
      and(
        eq(sourceSubscriptions.status, "active"),
        eq(sourceConfigs.enabled, true)
      )
    );

  const boss = getBoss();
  const now = Date.now();

  for (const row of rows) {
    try {
      const lastFetchedMs = row.lastFetchedAt
        ? new Date(row.lastFetchedAt).getTime()
        : 0;
      if (now - lastFetchedMs < DEFAULT_POLL_INTERVAL_MS) {
        skipped++;
        continue;
      }

      await boss.send(
        FEED_SOURCE_EXECUTE_QUEUE,
        {
          subscriptionId: row.subscriptionId,
          runId: randomUUID(),
        },
        { priority: PRIORITY.RSS }
      );
      scheduled++;
    } catch (err) {
      logger.error(
        { err, subscriptionId: row.subscriptionId },
        "Failed to schedule source subscription"
      );
      skipped++;
    }
  }

  logger.info(
    { scheduled, skipped, totalActive: rows.length },
    "Source subscription scheduling complete"
  );

  return { scheduled, skipped };
}
