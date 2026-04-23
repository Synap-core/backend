/**
 * Feed Scheduler Worker
 *
 * Cron job that runs every minute.
 * Schedules feed fetch execution jobs from active source subscriptions
 * whose lastFetchedAt exceeds the poll cadence.
 *
 * Source: source_subscriptions joined to source_configs (pluggable source
 * system, Phase 1 + 2).
 *
 * The legacy channel-based scheduling (channelType=FEED channels) has been
 * removed. channelType=FEED channels are still used by the UI to render
 * feed items — only feed creation/scheduling is no longer driven by the
 * channels table.
 *
 * Priority:
 *   - Default poll cadence: priority 5
 *
 */

import { db, eq, and } from "@synap/database";
import { sourceSubscriptions, sourceConfigs } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { getBoss } from "@synap/events";
import { randomUUID } from "crypto";
import { FEED_SOURCE_EXECUTE_QUEUE } from "./feed-source-executor.js";

const logger = createLogger({ module: "feed-scheduler" });

// ── Constants ────────────────────────────────────────────────────────────────

/** Cron schedule for this worker (every minute) */
export const FEED_SCHEDULER_CRON = "* * * * *";

/** Default poll cadence when a subscription has no explicit cron. */
const DEFAULT_POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

/** Job priority */
const PRIORITY = 5;

// ── Main Handler ─────────────────────────────────────────────────────────────

export async function handleFeedScheduler(): Promise<void> {
  logger.info("Starting feed scheduler check");

  const now = Date.now();
  let scheduledCount = 0;
  let skippedCount = 0;

  try {
    // Inner join — only subscriptions whose source_config is enabled and
    // whose subscription status is active.
    const rows = await db
      .select({
        subscriptionId: sourceSubscriptions.id,
        lastFetchedAt: sourceSubscriptions.lastFetchedAt,
        providerType: sourceConfigs.providerType,
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

    for (const row of rows) {
      try {
        const lastFetchedMs = row.lastFetchedAt
          ? new Date(row.lastFetchedAt).getTime()
          : 0;
        if (now - lastFetchedMs < DEFAULT_POLL_INTERVAL_MS) {
          skippedCount++;
          continue;
        }

        await boss.send(
          FEED_SOURCE_EXECUTE_QUEUE,
          {
            subscriptionId: row.subscriptionId,
            runId: randomUUID(),
          },
          { priority: PRIORITY }
        );

        scheduledCount++;
      } catch (err) {
        logger.error(
          { err, subscriptionId: row.subscriptionId },
          "Failed to schedule source subscription"
        );
        skippedCount++;
      }
    }

    logger.info(
      {
        scheduled: scheduledCount,
        skipped: skippedCount,
        totalActive: rows.length,
      },
      "Feed scheduler complete"
    );
  } catch (err) {
    logger.error({ err }, "Feed scheduler failed");
    throw err;
  }
}
