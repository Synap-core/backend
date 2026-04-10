/**
 * Proactive Morning Briefing Worker
 *
 * Cron job that runs every 15 minutes.
 * For each workspace with morning briefings enabled, checks if it is the
 * configured morning time (in the user's timezone) and sends a daily briefing
 * to each member's personal channel.
 *
 * Briefing includes:
 *   - Pending proposals count
 *   - Tasks due today (from entity properties JSONB)
 *   - 24h activity summary (created/updated counts by profile)
 */

import { db, eq, and, gte, isNull } from "@synap/database";
import {
  workspaceMembers,
  entities,
  proposals,
  profiles,
  ProposalStatus,
} from "@synap/database/schema";
import type { WorkspaceSettings } from "@synap/database/schema";
import { getDefaultProactiveAiPreferences } from "@synap/database/schema";
import { count } from "drizzle-orm";
import { createLogger } from "@synap-core/core";
import { routeProactiveMessage } from "../utils/proactive-post.js";

const logger = createLogger({ module: "proactive-morning-briefing" });

// ── Timezone Helpers ────────────────────────────────────────────────────────

/**
 * Get the current hour and minute in a given IANA timezone.
 * Falls back to UTC on invalid timezone.
 */
function getCurrentTimeInTimezone(timezone: string): {
  hour: number;
  minute: number;
  dayOfWeek: number;
} {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "numeric",
      hour12: false,
      weekday: "short",
    });

    const parts = formatter.formatToParts(now);
    const hour = parseInt(
      parts.find((p) => p.type === "hour")?.value ?? "0",
      10
    );
    const minute = parseInt(
      parts.find((p) => p.type === "minute")?.value ?? "0",
      10
    );

    // Get day of week (0=Sun..6=Sat)
    const dayFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long",
    });
    const dayStr = dayFormatter.format(now);
    const dayMap: Record<string, number> = {
      Sunday: 0,
      Monday: 1,
      Tuesday: 2,
      Wednesday: 3,
      Thursday: 4,
      Friday: 5,
      Saturday: 6,
    };
    const dayOfWeek = dayMap[dayStr] ?? 0;

    return { hour, minute, dayOfWeek };
  } catch {
    // Invalid timezone — fall back to UTC
    const now = new Date();
    return {
      hour: now.getUTCHours(),
      minute: now.getUTCMinutes(),
      dayOfWeek: now.getUTCDay(),
    };
  }
}

/**
 * Check if the current time in the given timezone matches the target time
 * within a +/- 15 minute window (since this cron runs every 15 minutes).
 */
function isWithinWindow(
  timezone: string,
  targetHour: number,
  targetMinute: number
): boolean {
  const { hour, minute } = getCurrentTimeInTimezone(timezone);
  const currentMinutes = hour * 60 + minute;
  const targetMinutes = targetHour * 60 + targetMinute;

  const diff = Math.abs(currentMinutes - targetMinutes);
  // Handle midnight wraparound
  const wrappedDiff = Math.min(diff, 1440 - diff);
  return wrappedDiff < 15;
}

/**
 * Get the start of today in a given IANA timezone as a UTC Date.
 */
function startOfTodayInTimezone(timezone: string): Date {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = formatter.formatToParts(now);
    const year = parts.find((p) => p.type === "year")?.value ?? "2026";
    const month = parts.find((p) => p.type === "month")?.value ?? "01";
    const day = parts.find((p) => p.type === "day")?.value ?? "01";

    // Create a date string in the timezone, then convert to UTC
    const dateStr = `${year}-${month}-${day}T00:00:00`;
    // Use a rough offset approach: find the difference between local midnight and UTC
    const localMidnight = new Date(dateStr);
    const utcOffset = getTimezoneOffsetMs(timezone);
    return new Date(localMidnight.getTime() - utcOffset);
  } catch {
    // Fallback: UTC start of today
    const now = new Date();
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    );
  }
}

/**
 * Get the approximate timezone offset in milliseconds for an IANA timezone.
 */
function getTimezoneOffsetMs(timezone: string): number {
  try {
    const now = new Date();
    const utcStr = now.toLocaleString("en-US", { timeZone: "UTC" });
    const tzStr = now.toLocaleString("en-US", { timeZone: timezone });
    return new Date(tzStr).getTime() - new Date(utcStr).getTime();
  } catch {
    return 0;
  }
}

// ── Main Handler ────────────────────────────────────────────────────────────

export async function handleProactiveMorningBriefing(): Promise<void> {
  logger.info("Starting proactive morning briefing check");

  // 1. Get all workspaces
  const allWorkspaces = await db.query.workspaces.findMany({
    columns: { id: true, name: true, settings: true },
  });

  let sentCount = 0;
  let skipCount = 0;

  for (const ws of allWorkspaces) {
    try {
      const settings = (ws.settings ?? {}) as WorkspaceSettings;
      const prefs = settings.proactiveAi ?? getDefaultProactiveAiPreferences();

      // Skip disabled workspaces
      if (!prefs.enabled || !prefs.morningBriefing.enabled) {
        continue;
      }

      // Check mutedUntil
      if (prefs.mutedUntil) {
        const mutedUntilDate = new Date(prefs.mutedUntil);
        if (!isNaN(mutedUntilDate.getTime()) && mutedUntilDate > new Date()) {
          continue;
        }
      }

      // 2. Get all members of this workspace
      const members = await db.query.workspaceMembers.findMany({
        where: eq(workspaceMembers.workspaceId, ws.id),
        columns: { userId: true },
      });

      if (members.length === 0) continue;

      // 3. Check if current time matches the configured morning time
      const { cronHour, cronMinute, timezone } = prefs.morningBriefing;
      if (!isWithinWindow(timezone, cronHour, cronMinute)) {
        continue;
      }

      // 4. Gather workspace data
      const todayStart = startOfTodayInTimezone(timezone);
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

      // Pending proposals for this workspace
      const [pendingResult] = await db
        .select({ value: count() })
        .from(proposals)
        .where(
          and(
            eq(proposals.workspaceId, ws.id),
            eq(proposals.status, ProposalStatus.PENDING)
          )
        );
      const pendingProposals = pendingResult?.value ?? 0;

      // Tasks due today (entities with profile slug "task" and dueDate = today)
      // Properties are JSONB: { dueDate: "2026-03-27", status: "todo", ... }
      // We need to join with profiles to get task entities
      const taskProfile = await db.query.profiles.findFirst({
        where: eq(profiles.slug, "task"),
        columns: { id: true },
      });

      let tasksDueToday: Array<{ id: string; title: string | null }> = [];
      if (taskProfile) {
        // Query tasks in this workspace due today
        // dueDate is stored as a string in properties JSONB
        const todayStr = todayStart.toISOString().split("T")[0];
        const allTasks = await db.query.entities.findMany({
          where: and(
            eq(entities.workspaceId, ws.id),
            eq(entities.profileId, taskProfile.id),
            isNull(entities.deletedAt)
          ),
          columns: { id: true, title: true, properties: true },
          limit: 100,
        });

        tasksDueToday = allTasks.filter((t) => {
          const props = t.properties as Record<string, unknown>;
          const dueDate = props?.dueDate as string | undefined;
          if (!dueDate) return false;
          // Compare date string (YYYY-MM-DD prefix)
          return dueDate.startsWith(todayStr);
        });
      }

      // Entities created in last 24h (count by profile type)
      const recentEntities = await db.query.entities.findMany({
        where: and(
          eq(entities.workspaceId, ws.id),
          gte(entities.createdAt, twentyFourHoursAgo),
          isNull(entities.deletedAt)
        ),
        columns: { id: true, type: true },
      });

      // Entities updated in last 24h (count)
      const updatedEntities = await db.query.entities.findMany({
        where: and(
          eq(entities.workspaceId, ws.id),
          gte(entities.updatedAt, twentyFourHoursAgo),
          isNull(entities.deletedAt)
        ),
        columns: { id: true },
      });

      // Skip if nothing to report
      if (
        pendingProposals === 0 &&
        tasksDueToday.length === 0 &&
        recentEntities.length === 0 &&
        updatedEntities.length === 0
      ) {
        skipCount += members.length;
        continue;
      }

      // 5. Compose the briefing
      const content = composeMorningBriefing({
        workspaceName: ws.name,
        pendingProposals,
        tasksDueToday,
        recentEntities,
        updatedCount: updatedEntities.length,
      });

      // 6. Send to each member
      for (const member of members) {
        try {
          const result = await routeProactiveMessage({
            userId: member.userId,
            workspaceId: ws.id,
            content,
            proactiveType: "morning_briefing",
            metadata: {
              pendingProposals,
              tasksDueToday: tasksDueToday.length,
              recentCreated: recentEntities.length,
              recentUpdated: updatedEntities.length,
            },
          });

          if (result.posted) {
            sentCount++;
          } else {
            skipCount++;
          }
        } catch (err) {
          logger.error(
            { err, userId: member.userId, workspaceId: ws.id },
            "Failed to send morning briefing to member"
          );
        }
      }
    } catch (err) {
      logger.error(
        { err, workspaceId: ws.id },
        "Failed to process morning briefing for workspace"
      );
    }
  }

  logger.info(
    { sent: sentCount, skipped: skipCount },
    "Proactive morning briefing complete"
  );
}

// ── Compose Briefing ────────────────────────────────────────────────────────

function composeMorningBriefing(data: {
  workspaceName: string;
  pendingProposals: number;
  tasksDueToday: Array<{ id: string; title: string | null }>;
  recentEntities: Array<{ id: string; type: string }>;
  updatedCount: number;
}): string {
  const lines: string[] = [];

  lines.push(`## Good morning ☀️`);
  lines.push(``);
  lines.push(`Here's what's happening in **${data.workspaceName}** today:`);
  lines.push(``);

  // Pending proposals
  if (data.pendingProposals > 0) {
    lines.push(
      `**${data.pendingProposals}** pending proposal${data.pendingProposals === 1 ? "" : "s"} awaiting your review`
    );
    lines.push(``);
  }

  // Tasks due today
  if (data.tasksDueToday.length > 0) {
    lines.push(
      `**Due today**: ${data.tasksDueToday.length} task${data.tasksDueToday.length === 1 ? "" : "s"}`
    );
    const displayTasks = data.tasksDueToday.slice(0, 5);
    for (const task of displayTasks) {
      lines.push(`- ${task.title || "Untitled task"}`);
    }
    if (data.tasksDueToday.length > 5) {
      lines.push(`- ...and ${data.tasksDueToday.length - 5} more`);
    }
    lines.push(``);
  }

  // Yesterday's activity
  if (data.recentEntities.length > 0 || data.updatedCount > 0) {
    const parts: string[] = [];
    if (data.recentEntities.length > 0) {
      parts.push(
        `${data.recentEntities.length} new item${data.recentEntities.length === 1 ? "" : "s"}`
      );
    }
    if (data.updatedCount > 0) {
      parts.push(
        `${data.updatedCount} update${data.updatedCount === 1 ? "" : "s"}`
      );
    }
    lines.push(`**Yesterday's activity**: ${parts.join(", ")}`);

    // Breakdown by profile type
    if (data.recentEntities.length > 0) {
      const byType = new Map<string, number>();
      for (const e of data.recentEntities) {
        byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
      }
      const sorted = [...byType.entries()].sort((a, b) => b[1] - a[1]);
      for (const [type, typeCount] of sorted) {
        lines.push(`- ${typeCount} ${type}${typeCount === 1 ? "" : "s"}`);
      }
    }
    lines.push(``);
  }

  lines.push(`Have a productive day!`);

  return lines.join("\n");
}
