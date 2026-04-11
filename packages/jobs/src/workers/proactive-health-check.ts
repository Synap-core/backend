/**
 * Proactive Health Check Worker
 *
 * Cron job that runs daily.
 * For each workspace with health check enabled, checks workspace data quality:
 *   - Orphan entities (no relations)
 *   - Empty views (0 matching entities)
 *   - Profiles with 0 entities
 *   - Stale entities (not updated in 30+ days)
 *
 * Only posts if actual issues are found. Respects frequencyDays setting
 * by checking the last health_check message timestamp.
 */

import { db, eq, and, isNull, gte, inArray } from "@synap/database";
import {
  workspaceMembers,
  entities,
  profiles,
  views,
  messages,
  MessageRole,
} from "@synap/database/schema";
import type { WorkspaceSettings } from "@synap/database/schema";
import { getDefaultProactiveAiPreferences } from "@synap/database/schema";
import { relations as relationsTable } from "@synap/database/schema";
import { channels, ChannelType, ChannelStatus } from "@synap/database/schema";
import { count } from "drizzle-orm";
import { createLogger } from "@synap-core/core";
import { routeProactiveMessage } from "../utils/proactive-post.js";

const logger = createLogger({ module: "proactive-health-check" });

const STALE_THRESHOLD_DAYS = 30;

// ── Main Handler ────────────────────────────────────────────────────────────

export async function handleProactiveHealthCheck(): Promise<void> {
  logger.info("Starting proactive health check");

  const allWorkspaces = await db.query.workspaces.findMany({
    columns: { id: true, name: true, settings: true },
  });

  let sentCount = 0;
  let skipCount = 0;

  for (const ws of allWorkspaces) {
    try {
      const settings = (ws.settings ?? {}) as WorkspaceSettings;
      const prefs = settings.proactiveAi ?? getDefaultProactiveAiPreferences();

      if (!prefs.enabled || !prefs.healthCheck.enabled) {
        continue;
      }

      // Check mutedUntil
      if (prefs.mutedUntil) {
        const mutedUntilDate = new Date(prefs.mutedUntil);
        if (!isNaN(mutedUntilDate.getTime()) && mutedUntilDate > new Date()) {
          continue;
        }
      }

      // Check frequencyDays: find last health_check message for any member
      const frequencyDays = prefs.healthCheck.frequencyDays;
      const shouldRun = await checkFrequency(ws.id, frequencyDays);
      if (!shouldRun) {
        continue;
      }

      // Get members
      const members = await db.query.workspaceMembers.findMany({
        where: eq(workspaceMembers.workspaceId, ws.id),
        columns: { userId: true },
      });

      if (members.length === 0) continue;

      // Gather health data
      const healthData = await gatherHealthData(ws.id);

      // Skip if no issues
      if (
        healthData.orphanCount === 0 &&
        healthData.emptyViewCount === 0 &&
        healthData.unusedProfileCount === 0 &&
        healthData.staleCount === 0
      ) {
        skipCount += members.length;
        continue;
      }

      // Compose message
      const content = composeHealthCheck({
        workspaceName: ws.name,
        ...healthData,
      });

      // Send to each member
      for (const member of members) {
        try {
          const result = await routeProactiveMessage({
            userId: member.userId,
            workspaceId: ws.id,
            content,
            proactiveType: "health_check",
            metadata: {
              orphanCount: healthData.orphanCount,
              emptyViewCount: healthData.emptyViewCount,
              unusedProfileCount: healthData.unusedProfileCount,
              staleCount: healthData.staleCount,
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
            "Failed to send health check to member"
          );
        }
      }
    } catch (err) {
      logger.error(
        { err, workspaceId: ws.id },
        "Failed to process health check for workspace"
      );
    }
  }

  logger.info(
    { sent: sentCount, skipped: skipCount },
    "Proactive health check complete"
  );
}

// ── Frequency Check ─────────────────────────────────────────────────────────

/**
 * Check if enough days have passed since the last health_check message
 * was sent to any member of this workspace.
 */
async function checkFrequency(
  workspaceId: string,
  frequencyDays: number
): Promise<boolean> {
  // Get all members to find their personal channels
  const members = await db.query.workspaceMembers.findMany({
    where: eq(workspaceMembers.workspaceId, workspaceId),
    columns: { userId: true },
  });

  if (members.length === 0) return true;

  // Check the first member's proactive feed channel for the last health_check message
  // (all members get the same health check at the same time, so checking one is sufficient)
  const firstUserId = members[0]!.userId;

  const proactiveFeedChannel = await db.query.channels.findFirst({
    where: and(
      eq(channels.userId, firstUserId),
      eq(channels.channelType, ChannelType.FEED),
      eq(channels.status, ChannelStatus.ACTIVE)
    ),
    columns: { id: true },
  });

  if (!proactiveFeedChannel) return true; // No channel yet — first time, send it

  // Find the most recent health_check message
  const cutoffDate = new Date(Date.now() - frequencyDays * 24 * 60 * 60 * 1000);

  const recentHealthChecks = await db.query.messages.findMany({
    where: and(
      eq(messages.channelId, proactiveFeedChannel.id),
      eq(messages.role, MessageRole.SYSTEM),
      gte(messages.timestamp, cutoffDate)
    ),
    columns: { metadata: true },
    limit: 10,
  });

  const hasRecent = recentHealthChecks.some((m) => {
    const meta = m.metadata as Record<string, unknown> | null;
    return meta?.proactiveType === "health_check";
  });

  return !hasRecent;
}

// ── Data Gathering ──────────────────────────────────────────────────────────

interface HealthData {
  orphanCount: number;
  orphanSamples: string[];
  emptyViewCount: number;
  emptyViewNames: string[];
  unusedProfileCount: number;
  unusedProfileNames: string[];
  staleCount: number;
}

async function gatherHealthData(workspaceId: string): Promise<HealthData> {
  // All entities in workspace
  const allEntities = await db.query.entities.findMany({
    where: and(
      eq(entities.workspaceId, workspaceId),
      isNull(entities.deletedAt)
    ),
    columns: { id: true, title: true, profileId: true, updatedAt: true },
  });

  // --- Orphan entities (no relations) ---
  const entityIdsInRelations = new Set<string>();
  const wsRelations = await db.query.relations.findMany({
    where: eq(relationsTable.workspaceId, workspaceId),
    columns: { sourceEntityId: true, targetEntityId: true },
  });
  for (const rel of wsRelations) {
    entityIdsInRelations.add(rel.sourceEntityId);
    entityIdsInRelations.add(rel.targetEntityId);
  }

  const orphans = allEntities.filter((e) => !entityIdsInRelations.has(e.id));
  const orphanCount = orphans.length;
  const orphanSamples = orphans.slice(0, 5).map((e) => e.title || "Untitled");

  // --- Empty views ---
  const workspaceViews = await db.query.views.findMany({
    where: eq(views.workspaceId, workspaceId),
    columns: { id: true, name: true, scopeProfileIds: true, type: true },
  });

  const emptyViewNames: string[] = [];
  for (const view of workspaceViews) {
    // Skip bento/whiteboard — they don't scope by profile
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
            eq(entities.workspaceId, workspaceId),
            inArray(entities.profileId, view.scopeProfileIds),
            isNull(entities.deletedAt)
          )
        );
      if ((matchResult?.value ?? 0) === 0) {
        emptyViewNames.push(view.name);
      }
    }
  }

  // --- Profiles with 0 entities ---
  const wsProfiles = await db.query.profiles.findMany({
    where: eq(profiles.workspaceId, workspaceId),
    columns: { id: true, displayName: true },
  });

  const usedProfileIds = new Set(
    allEntities.map((e) => e.profileId).filter(Boolean)
  );

  const unusedProfiles = wsProfiles.filter((p) => !usedProfileIds.has(p.id));
  const unusedProfileNames = unusedProfiles.map((p) => p.displayName);

  // --- Stale entities (not updated in 30+ days) ---
  const staleThreshold = new Date(
    Date.now() - STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000
  );
  const staleCount = allEntities.filter(
    (e) => e.updatedAt < staleThreshold
  ).length;

  return {
    orphanCount,
    orphanSamples,
    emptyViewCount: emptyViewNames.length,
    emptyViewNames,
    unusedProfileCount: unusedProfileNames.length,
    unusedProfileNames,
    staleCount,
  };
}

// ── Compose Health Check ────────────────────────────────────────────────────

function composeHealthCheck(
  data: HealthData & { workspaceName: string }
): string {
  const lines: string[] = [];

  lines.push(`## Workspace Health Check — ${data.workspaceName}`);
  lines.push(``);

  if (data.orphanCount > 0) {
    lines.push(
      `**${data.orphanCount}** entit${data.orphanCount === 1 ? "y has" : "ies have"} no relations`
    );
    if (data.orphanSamples.length > 0) {
      for (const name of data.orphanSamples) {
        lines.push(`- ${name}`);
      }
      if (data.orphanCount > 5) {
        lines.push(`- ...and ${data.orphanCount - 5} more`);
      }
    }
    lines.push(``);
  }

  if (data.emptyViewCount > 0) {
    lines.push(
      `**${data.emptyViewCount}** view${data.emptyViewCount === 1 ? " has" : "s have"} no matching entities`
    );
    for (const name of data.emptyViewNames) {
      lines.push(`- ${name}`);
    }
    lines.push(``);
  }

  if (data.unusedProfileCount > 0) {
    lines.push(
      `**${data.unusedProfileCount}** profile${data.unusedProfileCount === 1 ? " has" : "s have"} no entities`
    );
    for (const name of data.unusedProfileNames) {
      lines.push(`- ${name}`);
    }
    lines.push(``);
  }

  if (data.staleCount > 0) {
    lines.push(
      `**${data.staleCount}** entit${data.staleCount === 1 ? "y hasn't" : "ies haven't"} been updated in ${STALE_THRESHOLD_DAYS}+ days`
    );
    lines.push(``);
  }

  lines.push(
    `Consider reviewing these items to keep your workspace organized.`
  );

  return lines.join("\n");
}
