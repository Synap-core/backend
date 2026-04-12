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
import { channels, ChannelType, ChannelStatus } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { getBoss } from "../boss.js";
import type { FeedConfig } from "@synap-core/types";
import { randomUUID } from "crypto";

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
function parseFeedConfig(data: unknown): FeedConfig | null {
  if (!data || typeof data !== "object") return null;
  const config = data as Record<string, unknown>;

  if (config.feedType !== "rss" && config.feedType !== "proactive") {
    return null;
  }

  return config as FeedConfig;
}

/**
 * Calculate next run time based on cron expression.
 * Simple implementation - for complex expressions, consider cron-parser package.
 */
function calculateNextRun(cronExpr: string, _timezone: string): Date {
  const now = new Date();

  // Handle common simple patterns
  // Every X minutes: */X * * * *
  const minuteMatch = cronExpr.match(/^\*\/([0-9]+) \* \* \* \*$/);
  if (minuteMatch) {
    const interval = parseInt(minuteMatch[1], 10);
    const next = new Date(now);
    const currentMinutes = next.getMinutes();
    const nextMinutes = Math.ceil((currentMinutes + 1) / interval) * interval;
    if (nextMinutes >= 60) {
      next.setHours(next.getHours() + 1);
      next.setMinutes(nextMinutes - 60);
    } else {
      next.setMinutes(nextMinutes);
    }
    next.setSeconds(0);
    next.setMilliseconds(0);
    return next;
  }

  // Every X hours: 0 */X * * *
  const hourMatch = cronExpr.match(/^0 \*\/([0-9]+) \* \* \*$/);
  if (hourMatch) {
    const interval = parseInt(hourMatch[1], 10);
    const next = new Date(now);
    const currentHours = next.getHours();
    const nextHours = Math.ceil((currentHours + 1) / interval) * interval;
    if (nextHours >= 24) {
      next.setDate(next.getDate() + 1);
      next.setHours(0);
    } else {
      next.setHours(nextHours);
    }
    next.setMinutes(0);
    next.setSeconds(0);
    next.setMilliseconds(0);
    return next;
  }

  // Daily at specific hour: 0 H * * *
  const dailyMatch = cronExpr.match(/^0 ([0-9]+) \* \* \*$/);
  if (dailyMatch) {
    const hour = parseInt(dailyMatch[1], 10);
    const next = new Date(now);
    next.setHours(hour);
    next.setMinutes(0);
    next.setSeconds(0);
    next.setMilliseconds(0);
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }
    return next;
  }

  // Default: every 6 hours
  const next = new Date(now);
  next.setHours(next.getHours() + 6);
  next.setMinutes(0);
  next.setSeconds(0);
  next.setMilliseconds(0);
  return next;
}

/**
 * Check if a channel is due for execution.
 */
function isChannelDue(row: FeedChannelRow, config: FeedConfig): boolean {
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
  if (!nextRunAt && config.schedule) {
    const calculated = calculateNextRun(
      config.schedule,
      config.timezone || "UTC"
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
        if (!config.enabled) {
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
