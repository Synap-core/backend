/**
 * Proactive Weekly Digest Worker
 *
 * Cron job that runs every hour.
 * For each workspace with weekly digest enabled, checks if today is the
 * configured day of week and current hour matches in the user's timezone.
 * Sends a comprehensive 7-day summary to each member's personal channel.
 *
 * Digest includes:
 *   - Entity counts by profile type (created this week)
 *   - Total entity count
 *   - Views created/modified
 *   - Proposals created/approved/rejected counts
 *   - Most active profile types
 *   - Orphan entities (no relations)
 *   - Empty views (0 matching entities)
 *   - Structural suggestions
 */

import { db, eq, and, gte, isNull, inArray } from "@synap/database";
import {
  workspaceMembers,
  entities,
  proposals,
  views,
  ProposalStatus,
} from "@synap/database/schema";
import type { WorkspaceSettings } from "@synap/database/schema";
import { getDefaultProactiveAiPreferences } from "@synap/database/schema";
import { relations as relationsTable } from "@synap/database/schema";
import { count } from "drizzle-orm";
import { createLogger } from "@synap-core/core";
import { postProactiveMessage } from "../utils/proactive-post.js";

const logger = createLogger({ module: "proactive-weekly-digest" });

// ── Timezone Helpers ────────────────────────────────────────────────────────

function getCurrentTimeInTimezone(timezone: string): {
  hour: number;
  dayOfWeek: number;
} {
  try {
    const now = new Date();
    const hourFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    });
    const hourParts = hourFormatter.formatToParts(now);
    const hour = parseInt(
      hourParts.find((p) => p.type === "hour")?.value ?? "0",
      10
    );

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

    return { hour, dayOfWeek };
  } catch {
    const now = new Date();
    return {
      hour: now.getUTCHours(),
      dayOfWeek: now.getUTCDay(),
    };
  }
}

// ── Main Handler ────────────────────────────────────────────────────────────

export async function handleProactiveWeeklyDigest(): Promise<void> {
  logger.info("Starting proactive weekly digest check");

  const allWorkspaces = await db.query.workspaces.findMany({
    columns: { id: true, name: true, settings: true },
  });

  let sentCount = 0;
  let skipCount = 0;

  for (const ws of allWorkspaces) {
    try {
      const settings = (ws.settings ?? {}) as WorkspaceSettings;
      const prefs = settings.proactiveAi ?? getDefaultProactiveAiPreferences();

      if (!prefs.enabled || !prefs.weeklyDigest.enabled) {
        continue;
      }

      // Check mutedUntil
      if (prefs.mutedUntil) {
        const mutedUntilDate = new Date(prefs.mutedUntil);
        if (!isNaN(mutedUntilDate.getTime()) && mutedUntilDate > new Date()) {
          continue;
        }
      }

      // Check if today is the configured day and hour matches
      const { dayOfWeek, cronHour, timezone } = prefs.weeklyDigest;
      const current = getCurrentTimeInTimezone(timezone);

      if (current.dayOfWeek !== dayOfWeek || current.hour !== cronHour) {
        continue;
      }

      // Get members
      const members = await db.query.workspaceMembers.findMany({
        where: eq(workspaceMembers.workspaceId, ws.id),
        columns: { userId: true },
      });

      if (members.length === 0) continue;

      // Gather 7-day data
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const weekStart = new Date(sevenDaysAgo);
      const weekEnd = new Date();

      // Entities created this week (by type)
      const createdEntities = await db.query.entities.findMany({
        where: and(
          eq(entities.workspaceId, ws.id),
          gte(entities.createdAt, sevenDaysAgo),
          isNull(entities.deletedAt)
        ),
        columns: { id: true, type: true },
      });

      // Entities updated this week
      const updatedEntities = await db.query.entities.findMany({
        where: and(
          eq(entities.workspaceId, ws.id),
          gte(entities.updatedAt, sevenDaysAgo),
          isNull(entities.deletedAt)
        ),
        columns: { id: true },
      });

      // Total entity count
      const [totalResult] = await db
        .select({ value: count() })
        .from(entities)
        .where(
          and(eq(entities.workspaceId, ws.id), isNull(entities.deletedAt))
        );
      const totalEntities = totalResult?.value ?? 0;

      // Views created/modified this week
      const modifiedViews = await db.query.views.findMany({
        where: and(
          eq(views.workspaceId, ws.id),
          gte(views.updatedAt, sevenDaysAgo)
        ),
        columns: { id: true },
      });

      const createdViews = await db.query.views.findMany({
        where: and(
          eq(views.workspaceId, ws.id),
          gte(views.createdAt, sevenDaysAgo)
        ),
        columns: { id: true },
      });

      // Proposals this week
      const weekProposals = await db.query.proposals.findMany({
        where: and(
          eq(proposals.workspaceId, ws.id),
          gte(proposals.createdAt, sevenDaysAgo)
        ),
        columns: { status: true },
      });

      const proposalsTotal = weekProposals.length;
      const proposalsApproved = weekProposals.filter(
        (p) =>
          p.status === ProposalStatus.APPROVED ||
          p.status === ProposalStatus.AUTO_APPROVED
      ).length;
      const proposalsRejected = weekProposals.filter(
        (p) => p.status === ProposalStatus.REJECTED
      ).length;

      // Orphan entities: entities with no relations
      // Get all entity IDs in this workspace
      const allEntityIds = await db.query.entities.findMany({
        where: and(eq(entities.workspaceId, ws.id), isNull(entities.deletedAt)),
        columns: { id: true },
      });

      // Get entity IDs that appear in relations (as source or target)
      const entityIdsInRelations = new Set<string>();
      if (allEntityIds.length > 0) {
        const sourceRels = await db.query.relations.findMany({
          where: eq(relationsTable.workspaceId, ws.id),
          columns: { sourceEntityId: true, targetEntityId: true },
        });
        for (const rel of sourceRels) {
          entityIdsInRelations.add(rel.sourceEntityId);
          entityIdsInRelations.add(rel.targetEntityId);
        }
      }

      const orphanCount = allEntityIds.filter(
        (e) => !entityIdsInRelations.has(e.id)
      ).length;

      // Empty views: views with 0 matching entities (use scopeProfileIds)
      const workspaceViews = await db.query.views.findMany({
        where: eq(views.workspaceId, ws.id),
        columns: { id: true, name: true, scopeProfileIds: true, type: true },
      });

      // For simplicity, count views with scopeProfileIds that have no entities
      let emptyViewCount = 0;
      for (const view of workspaceViews) {
        // Skip bento/whiteboard — they don't have entity scopes
        if (view.type === "bento" || view.type === "whiteboard") continue;

        if (
          view.scopeProfileIds &&
          Array.isArray(view.scopeProfileIds) &&
          view.scopeProfileIds.length > 0
        ) {
          const [matchResult] = await db
            .select({ value: count() })
            .from(entities)
            .where(
              and(
                eq(entities.workspaceId, ws.id),
                inArray(entities.profileId, view.scopeProfileIds),
                isNull(entities.deletedAt)
              )
            );
          if ((matchResult?.value ?? 0) === 0) {
            emptyViewCount++;
          }
        }
      }

      // Profile breakdown
      const profileBreakdown = new Map<string, number>();
      for (const e of createdEntities) {
        profileBreakdown.set(e.type, (profileBreakdown.get(e.type) ?? 0) + 1);
      }

      // Skip if nothing to report
      if (
        createdEntities.length === 0 &&
        updatedEntities.length === 0 &&
        proposalsTotal === 0 &&
        orphanCount === 0 &&
        emptyViewCount === 0
      ) {
        skipCount += members.length;
        continue;
      }

      // Compose digest
      const content = composeWeeklyDigest({
        workspaceName: ws.name,
        weekStart,
        weekEnd,
        totalCreated: createdEntities.length,
        totalUpdated: updatedEntities.length,
        totalEntities,
        profileBreakdown,
        viewsCreated: createdViews.length,
        viewsModified: modifiedViews.length,
        proposalsTotal,
        proposalsApproved,
        proposalsRejected,
        orphanCount,
        emptyViewCount,
        workspaceViews,
      });

      // Send to each member
      for (const member of members) {
        try {
          const result = await postProactiveMessage({
            userId: member.userId,
            workspaceId: ws.id,
            content,
            proactiveType: "weekly_digest",
            metadata: {
              totalCreated: createdEntities.length,
              totalUpdated: updatedEntities.length,
              proposalsTotal,
              orphanCount,
              emptyViewCount,
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
            "Failed to send weekly digest to member"
          );
        }
      }
    } catch (err) {
      logger.error(
        { err, workspaceId: ws.id },
        "Failed to process weekly digest for workspace"
      );
    }
  }

  logger.info(
    { sent: sentCount, skipped: skipCount },
    "Proactive weekly digest complete"
  );
}

// ── Compose Digest ──────────────────────────────────────────────────────────

function formatDate(d: Date): string {
  return d.toISOString().split("T")[0]!;
}

function composeWeeklyDigest(data: {
  workspaceName: string;
  weekStart: Date;
  weekEnd: Date;
  totalCreated: number;
  totalUpdated: number;
  totalEntities: number;
  profileBreakdown: Map<string, number>;
  viewsCreated: number;
  viewsModified: number;
  proposalsTotal: number;
  proposalsApproved: number;
  proposalsRejected: number;
  orphanCount: number;
  emptyViewCount: number;
  workspaceViews: Array<{ id: string; name: string; type: string }>;
}): string {
  const lines: string[] = [];

  lines.push(`## Weekly Review — ${data.workspaceName}`);
  lines.push(``);
  lines.push(
    `**Week of ${formatDate(data.weekStart)} — ${formatDate(data.weekEnd)}**`
  );
  lines.push(``);

  // Activity
  lines.push(`### Activity`);
  if (data.totalCreated > 0) {
    const breakdown = [...data.profileBreakdown.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, c]) => `${c} ${type}${c === 1 ? "" : "s"}`)
      .join(", ");
    lines.push(`- **${data.totalCreated}** new entities (${breakdown})`);
  } else {
    lines.push(`- No new entities created`);
  }

  if (data.totalUpdated > 0) {
    lines.push(`- **${data.totalUpdated}** updates`);
  }

  if (data.proposalsTotal > 0) {
    lines.push(
      `- **${data.proposalsApproved}/${data.proposalsTotal}** proposals reviewed`
    );
    if (data.proposalsRejected > 0) {
      lines.push(`  - ${data.proposalsRejected} rejected`);
    }
  }

  if (data.viewsCreated > 0 || data.viewsModified > 0) {
    const parts: string[] = [];
    if (data.viewsCreated > 0) parts.push(`${data.viewsCreated} created`);
    if (data.viewsModified > 0) parts.push(`${data.viewsModified} modified`);
    lines.push(`- Views: ${parts.join(", ")}`);
  }

  lines.push(``);

  // Growth
  if (data.totalEntities > 0) {
    lines.push(`### Growth`);
    lines.push(`Total entities: **${data.totalEntities}**`);
    if (data.profileBreakdown.size > 0) {
      const sorted = [...data.profileBreakdown.entries()].sort(
        (a, b) => b[1] - a[1]
      );
      for (const [type, c] of sorted) {
        lines.push(`- ${type}: +${c}`);
      }
    }
    lines.push(``);
  }

  // Workspace Health
  if (data.orphanCount > 0 || data.emptyViewCount > 0) {
    lines.push(`### Workspace Health`);
    if (data.orphanCount > 0) {
      lines.push(
        `- ${data.orphanCount} entit${data.orphanCount === 1 ? "y" : "ies"} with no relations`
      );
    }
    if (data.emptyViewCount > 0) {
      lines.push(
        `- ${data.emptyViewCount} view${data.emptyViewCount === 1 ? "" : "s"} with no matching data`
      );
    }
    lines.push(``);
  }

  // Suggestions
  const suggestions = generateSuggestions(data);
  if (suggestions.length > 0) {
    lines.push(`### Suggestions`);
    for (const suggestion of suggestions) {
      lines.push(`- ${suggestion}`);
    }
    lines.push(``);
  }

  return lines.join("\n");
}

function generateSuggestions(data: {
  profileBreakdown: Map<string, number>;
  workspaceViews: Array<{ id: string; name: string; type: string }>;
  orphanCount: number;
  totalEntities: number;
}): string[] {
  const suggestions: string[] = [];

  // Check if there are task entities but no kanban view
  const taskCount = data.profileBreakdown.get("task") ?? 0;
  const hasKanban = data.workspaceViews.some((v) => v.type === "kanban");
  if (taskCount > 3 && !hasKanban) {
    suggestions.push(
      `You created ${taskCount} tasks this week but have no kanban view — consider creating one`
    );
  }

  // Check for fast-growing profile types
  const sorted = [...data.profileBreakdown.entries()].sort(
    (a, b) => b[1] - a[1]
  );
  if (sorted.length > 0) {
    const [topType, topCount] = sorted[0]!;
    if (topCount >= 10) {
      suggestions.push(
        `${topType} entities are growing fast (${topCount} this week). A dedicated view could help organize them.`
      );
    }
  }

  // Orphan entities suggestion
  if (data.orphanCount > 10 && data.totalEntities > 0) {
    const pct = Math.round((data.orphanCount / data.totalEntities) * 100);
    if (pct > 30) {
      suggestions.push(
        `${pct}% of your entities have no relations — linking them can help surface connections`
      );
    }
  }

  return suggestions;
}
