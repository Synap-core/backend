/**
 * Proactive Scheduler Worker
 *
 * Cron job that runs every minute.
 * Finds proactive feed channels (channelType=FEED, metadata.feedType='proactive')
 * and enqueues `feed-proactive-execute` jobs for the ones that are due now.
 *
 * The feed-proactive-execute worker is the executor; nothing enqueued it until
 * this scheduler existed. Morning briefing and weekly digest are stored as
 * channel metadata (NOT workspace settings):
 *
 *   metadata.proactiveTypes: ['morning_briefing' | 'weekly_digest', ...]
 *   metadata.morningBriefing.schedule = { hour, minute, timezone }   → daily
 *   metadata.weeklyDigest.schedule    = { dayOfWeek, hour, timezone } → weekly
 *   metadata.feedStatus.lastRunAt     = ISO string (run tracking, set by executor)
 *
 * Due-check: derive a daily/weekly cron from each active proactive type's
 * schedule, compute the previous fire boundary, and fire once when the current
 * minute has passed that boundary and we have not already fired in this window
 * (guarded by feedStatus.lastRunAt — mirrors feed-scheduler's interval guard).
 */

import { db, eq, and, drizzleSql } from "@synap/database";
import { channels, ChannelType, ChannelStatus } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { getBoss } from "@synap/events";
import { randomUUID } from "crypto";
import { calculateNextRun } from "../utils/feed-helpers.js";
import type {
  ProactiveFeedConfig,
  FeedExecutionPayload,
} from "@synap-core/types";

const logger = createLogger({ module: "proactive-scheduler" });

// ── Constants ────────────────────────────────────────────────────────────────

/** Cron schedule for this worker (every minute). */
export const PROACTIVE_SCHEDULER_CRON = "* * * * *";

/** Queue the executor listens on. */
const FEED_PROACTIVE_EXECUTE_QUEUE = "feed-proactive-execute";

/**
 * Minimum gap between two fires of the same feed. Guards against double-fire
 * within the same scheduled window (the cron ticks every minute, but a daily /
 * weekly schedule must only fire once). 23h covers daily; weekly is naturally
 * spaced further apart so the same guard is safe.
 */
const MIN_RUN_GAP_MS = 23 * 60 * 60 * 1000; // 23 hours

// ── Schedule shapes (as persisted by the migrations) ───────────────────────────

interface DailySchedule {
  hour: number;
  minute?: number;
  timezone?: string;
}

interface WeeklySchedule {
  dayOfWeek: number;
  hour: number;
  minute?: number;
  timezone?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Build a daily cron expression from a morning-briefing schedule. */
function dailyCron(s: DailySchedule): string {
  return `${s.minute ?? 0} ${s.hour} * * *`;
}

/** Build a weekly cron expression from a weekly-digest schedule. */
function weeklyCron(s: WeeklySchedule): string {
  return `${s.minute ?? 0} ${s.hour} * * ${s.dayOfWeek}`;
}

/**
 * Determine whether a cron-based schedule is due right now.
 *
 * calculateNextRun returns the NEXT fire after `now`. The PREVIOUS fire boundary
 * is therefore `nextRun - period`. A feed is due when the current minute is at or
 * past a fire boundary that we have not yet acted on (lastRun is null or older
 * than that boundary).
 */
function isCronDue(
  cron: string,
  timezone: string,
  now: Date,
  lastRunMs: number
): boolean {
  // Anchor 70s in the past so the boundary we're currently sitting on is treated
  // as the "previous" fire rather than the "next" one (cron-parser excludes the
  // anchor instant from next()).
  const anchor = new Date(now.getTime() - 70 * 1000);
  let prevFire: Date;
  try {
    // next() after the anchor = the boundary at/after (now - 70s). If that
    // boundary is <= now, it is the fire we owe.
    prevFire = calculateNextRun(cron, timezone, anchor);
  } catch {
    return false;
  }
  if (prevFire.getTime() > now.getTime()) return false; // boundary still in future
  // Have we already fired for this (or a later) boundary?
  return lastRunMs < prevFire.getTime();
}

// ── Main Handler ─────────────────────────────────────────────────────────────

export async function handleProactiveScheduler(): Promise<void> {
  logger.info("Starting proactive scheduler check");

  const now = new Date();
  let scheduledCount = 0;
  let skippedCount = 0;

  try {
    const rows = await db
      .select({
        id: channels.id,
        userId: channels.userId,
        workspaceId: channels.workspaceId,
        metadata: channels.metadata,
      })
      .from(channels)
      .where(
        and(
          eq(channels.channelType, ChannelType.FEED),
          eq(channels.status, ChannelStatus.ACTIVE),
          drizzleSql`${channels.metadata}->>'feedType' = 'proactive'`
        )
      );

    const boss = getBoss();

    for (const row of rows) {
      try {
        const metadata = (row.metadata as Record<string, unknown>) ?? {};
        const proactiveTypes = Array.isArray(metadata.proactiveTypes)
          ? (metadata.proactiveTypes as string[])
          : [];

        // Defensive: a feed with no proactive types / no schedule has nothing to fire.
        if (proactiveTypes.length === 0) {
          skippedCount++;
          continue;
        }

        const feedStatus =
          (metadata.feedStatus as Record<string, unknown> | undefined) ?? {};
        const lastRunAt = feedStatus.lastRunAt as string | undefined;
        const lastRunMs = lastRunAt ? new Date(lastRunAt).getTime() : 0;

        // Double-fire guard: skip if we ran within the minimum gap.
        if (now.getTime() - lastRunMs < MIN_RUN_GAP_MS) {
          skippedCount++;
          continue;
        }

        let due = false;
        let scheduleCron = "0 9 * * *";
        let timezone = "UTC";

        if (proactiveTypes.includes("morning_briefing")) {
          const mb = (metadata.morningBriefing as Record<string, unknown>)
            ?.schedule as DailySchedule | undefined;
          if (mb && typeof mb.hour === "number") {
            const cron = dailyCron(mb);
            const tz = mb.timezone ?? "UTC";
            if (isCronDue(cron, tz, now, lastRunMs)) {
              due = true;
              scheduleCron = cron;
              timezone = tz;
            }
          }
        }

        if (!due && proactiveTypes.includes("weekly_digest")) {
          const wd = (metadata.weeklyDigest as Record<string, unknown>)
            ?.schedule as WeeklySchedule | undefined;
          if (
            wd &&
            typeof wd.hour === "number" &&
            typeof wd.dayOfWeek === "number"
          ) {
            const cron = weeklyCron(wd);
            const tz = wd.timezone ?? "UTC";
            if (isCronDue(cron, tz, now, lastRunMs)) {
              due = true;
              scheduleCron = cron;
              timezone = tz;
            }
          }
        }

        if (!due) {
          skippedCount++;
          continue;
        }

        // Build the executor payload's ProactiveFeedConfig. The executor reads
        // config.feedType (must be "proactive"), config.summarization,
        // config.include, config.schedule, config.timezone.
        const config: ProactiveFeedConfig = {
          feedType: "proactive",
          enabled: true,
          schedule: scheduleCron,
          timezone,
          maxItemsPerRun: 50,
          dedupWindowDays: 7,
          minRelevanceScore: 0,
          postMode: "batch",
          summarization: { style: "brief", includeInsights: true },
          include: {
            tasksDue: true,
            pendingProposals: true,
            recentEntities: true,
            recentCaptures: true,
            activitySummary: true,
          },
        };

        const payload: FeedExecutionPayload = {
          channelId: row.id,
          userId: row.userId,
          workspaceId: row.workspaceId ?? undefined,
          config,
          runId: randomUUID(),
        };

        await boss.send(FEED_PROACTIVE_EXECUTE_QUEUE, payload);
        scheduledCount++;
      } catch (err) {
        logger.error(
          { err, channelId: row.id },
          "Failed to schedule proactive feed"
        );
        skippedCount++;
      }
    }

    logger.info(
      {
        scheduled: scheduledCount,
        skipped: skippedCount,
        totalProactive: rows.length,
      },
      "Proactive scheduler complete"
    );
  } catch (err) {
    logger.error({ err }, "Proactive scheduler failed");
    throw err;
  }
}
