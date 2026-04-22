/**
 * Morning Briefing Migration
 *
 * Migrates users with proactive morning briefing enabled to unified feed channels.
 * Creates "The Morning Feed" channel for each user with morning briefing enabled.
 *
 * Features:
 * - Idempotent: checks if feed already exists before creating
 * - Observable: logs progress and counts
 * - Reversible: stores old config in metadata for rollback
 *
 * @example
 * ```ts
 * import { migrateMorningBriefing } from "./migrate-morning-briefing.js";
 * const result = await migrateMorningBriefing();
 * console.log(`Created ${result.created} feeds, skipped ${result.skipped}`);
 * ```
 */

import { db, eq, and } from "@synap/database";
import {
  channels,
  workspaceMembers,
  ChannelType,
  ChannelScope,
  FeedScope,
  ChannelStatus,
} from "@synap/database/schema";
import type { WorkspaceSettings } from "@synap/database/schema";
import { getDefaultProactiveAiPreferences } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "migrate-morning-briefing" });

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MorningBriefingMigrationResult {
  /** Number of feed channels created */
  created: number;
  /** Number of users skipped (already migrated or disabled) */
  skipped: number;
  /** Number of errors encountered */
  errors: number;
  /** Details per user */
  details: Array<{
    userId: string;
    workspaceId: string;
    channelId?: string;
    status: "created" | "skipped" | "error";
    reason?: string;
  }>;
  /** Migration metadata for rollback */
  metadata: {
    migratedAt: string;
    version: string;
    oldWorkerDeprecated: boolean;
  };
}

interface MorningBriefingConfig {
  enabled: boolean;
  cronHour: number;
  cronMinute: number;
  timezone: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MIGRATION_VERSION = "1.0.0";
const FEED_TITLE = "The Morning Feed";
const FEED_RETENTION_DAYS = 30;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract morning briefing config from workspace settings.
 */
function extractMorningBriefingConfig(
  settings: WorkspaceSettings
): MorningBriefingConfig | null {
  const prefs = settings.proactiveAi ?? getDefaultProactiveAiPreferences();

  if (!prefs.enabled || !prefs.morningBriefing?.enabled) {
    return null;
  }

  return {
    enabled: prefs.morningBriefing.enabled,
    cronHour: prefs.morningBriefing.cronHour ?? 8,
    cronMinute: prefs.morningBriefing.cronMinute ?? 0,
    timezone: prefs.morningBriefing.timezone ?? "UTC",
  };
}

/**
 * Check if user already has a morning briefing feed channel.
 */
async function hasExistingMorningFeed(userId: string): Promise<boolean> {
  const existing = await db.query.channels.findFirst({
    where: and(
      eq(channels.userId, userId),
      eq(channels.channelType, ChannelType.FEED),
      eq(channels.feedScope, FeedScope.USER),
      eq(channels.status, ChannelStatus.ACTIVE)
    ),
  });

  if (!existing) return false;

  // Check if this is specifically a morning briefing feed via metadata
  const metadata = existing.metadata as Record<string, unknown> | null;
  return (
    metadata?.feedType === "morning_briefing" ||
    metadata?.feedType === "proactive"
  );
}

/**
 * Create morning briefing feed channel for a user.
 */
async function createMorningBriefingFeed(
  userId: string,
  config: MorningBriefingConfig,
  _workspaceId: string
): Promise<{ channelId: string; created: boolean }> {
  // Double-check idempotency
  const existing = await db.query.channels.findFirst({
    where: and(
      eq(channels.userId, userId),
      eq(channels.channelType, ChannelType.FEED),
      eq(channels.feedScope, FeedScope.USER),
      eq(channels.status, ChannelStatus.ACTIVE)
    ),
  });

  if (existing) {
    // Update metadata to include morning briefing config
    const metadata = (existing.metadata as Record<string, unknown>) ?? {};
    const updatedMetadata = {
      ...metadata,
      feedType: "proactive",
      proactiveTypes: [
        ...((metadata.proactiveTypes as string[]) ?? []),
        "morning_briefing",
      ],
      morningBriefing: {
        schedule: {
          hour: config.cronHour,
          minute: config.cronMinute,
          timezone: config.timezone,
        },
        migratedAt: new Date().toISOString(),
        migratedFrom: "worker",
      },
      retentionDays: FEED_RETENTION_DAYS,
      mode: "batch", // batch mode for proactive feeds
      // Store old config for rollback
      _migration: {
        version: MIGRATION_VERSION,
        oldWorkerDeprecated: true,
        rollbackData: {
          hadDedicatedFeed: false,
          originalConfig: config,
        },
      },
    };

    await db
      .update(channels)
      .set({
        metadata: updatedMetadata,
        updatedAt: new Date(),
      })
      .where(eq(channels.id, existing.id));

    return { channelId: existing.id, created: false };
  }

  // Create new feed channel
  const [channel] = await db
    .insert(channels)
    .values({
      userId,
      workspaceId: null, // pod-wide for personal feeds
      title: FEED_TITLE,
      channelType: ChannelType.FEED,
      scope: ChannelScope.POD,
      feedScope: FeedScope.USER,
      status: ChannelStatus.ACTIVE,
      agentConfig: {
        systemPrompt:
          "You are a proactive assistant that delivers morning briefings. " +
          "Summarize workspace activity, pending tasks, and proposals concisely.",
        tools: ["entity_search", "proposal_list", "task_due_today"],
      },
      metadata: {
        feedType: "proactive",
        proactiveTypes: ["morning_briefing"],
        morningBriefing: {
          schedule: {
            hour: config.cronHour,
            minute: config.cronMinute,
            timezone: config.timezone,
          },
          migratedAt: new Date().toISOString(),
          migratedFrom: "worker",
        },
        retentionDays: FEED_RETENTION_DAYS,
        mode: "batch",
        // Store old config for rollback
        _migration: {
          version: MIGRATION_VERSION,
          oldWorkerDeprecated: true,
          rollbackData: {
            hadDedicatedFeed: false,
            originalConfig: config,
          },
        },
      },
    })
    .returning({ id: channels.id });

  return { channelId: channel!.id, created: true };
}

// ─── Main Migration Function ──────────────────────────────────────────────────

/**
 * Migrate morning briefing users to unified feed channels.
 *
 * This migration:
 * 1. Finds all workspaces with morning briefing enabled
 * 2. For each workspace member, creates/checks "The Morning Feed" channel
 * 3. Copies schedule config from workspace.settings.proactiveAi
 * 4. Sets feed config: feedType='proactive', batch mode, 30 day retention
 * 5. Marks old worker as deprecated in metadata
 *
 * @param options Migration options
 * @returns Migration result with counts and details
 */
export async function migrateMorningBriefing(
  options: {
    /** Dry run - don't actually create anything */
    dryRun?: boolean;
    /** Specific user IDs to migrate (defaults to all) */
    userIds?: string[];
    /** Specific workspace IDs to migrate (defaults to all) */
    workspaceIds?: string[];
  } = {}
): Promise<MorningBriefingMigrationResult> {
  const { dryRun = false, userIds, workspaceIds } = options;

  logger.info(
    {
      dryRun,
      userCount: userIds?.length,
      workspaceCount: workspaceIds?.length,
    },
    "Starting morning briefing migration"
  );

  const result: MorningBriefingMigrationResult = {
    created: 0,
    skipped: 0,
    errors: 0,
    details: [],
    metadata: {
      migratedAt: new Date().toISOString(),
      version: MIGRATION_VERSION,
      oldWorkerDeprecated: true,
    },
  };

  try {
    // Get all workspaces with morning briefing enabled
    const allWorkspaces = await db.query.workspaces.findMany({
      columns: { id: true, name: true, settings: true },
      ...(workspaceIds?.length
        ? { where: (ws: any, { inArray }: any) => inArray(ws.id, workspaceIds) }
        : {}),
    });

    // Filter to workspaces with morning briefing enabled
    const targetWorkspaces = allWorkspaces.filter((ws) => {
      const settings = (ws.settings ?? {}) as WorkspaceSettings;
      const config = extractMorningBriefingConfig(settings);
      return config !== null;
    });

    logger.info(
      { total: allWorkspaces.length, target: targetWorkspaces.length },
      "Found workspaces with morning briefing enabled"
    );

    for (const ws of targetWorkspaces) {
      try {
        const settings = (ws.settings ?? {}) as WorkspaceSettings;
        const config = extractMorningBriefingConfig(settings)!;

        // Get all members of this workspace
        const members = await db.query.workspaceMembers.findMany({
          where: eq(workspaceMembers.workspaceId, ws.id),
          columns: { userId: true },
        });

        // Filter to specific users if provided
        const targetMembers = userIds?.length
          ? members.filter((m) => userIds.includes(m.userId))
          : members;

        for (const member of targetMembers) {
          try {
            // Check if already migrated
            if (await hasExistingMorningFeed(member.userId)) {
              result.skipped++;
              result.details.push({
                userId: member.userId,
                workspaceId: ws.id,
                status: "skipped",
                reason: "already_migrated",
              });
              logger.debug(
                { userId: member.userId },
                "Skipping - already has morning feed"
              );
              continue;
            }

            if (dryRun) {
              result.created++;
              result.details.push({
                userId: member.userId,
                workspaceId: ws.id,
                status: "created",
                reason: "dry_run",
              });
              logger.debug(
                { userId: member.userId },
                "Would create morning feed (dry run)"
              );
              continue;
            }

            // Create the feed channel
            const { channelId, created } = await createMorningBriefingFeed(
              member.userId,
              config,
              ws.id
            );

            if (created) {
              result.created++;
            } else {
              result.skipped++;
            }

            result.details.push({
              userId: member.userId,
              workspaceId: ws.id,
              channelId,
              status: created ? "created" : "skipped",
              reason: created ? "created_new" : "updated_existing",
            });

            logger.info(
              { userId: member.userId, channelId, created },
              `${created ? "Created" : "Updated"} morning briefing feed`
            );
          } catch (err) {
            result.errors++;
            result.details.push({
              userId: member.userId,
              workspaceId: ws.id,
              status: "error",
              reason: err instanceof Error ? err.message : String(err),
            });
            logger.error(
              { err, userId: member.userId, workspaceId: ws.id },
              "Failed to migrate morning briefing for user"
            );
          }
        }
      } catch (err) {
        result.errors++;
        logger.error(
          { err, workspaceId: ws.id },
          "Failed to process workspace"
        );
      }
    }

    logger.info(
      {
        created: result.created,
        skipped: result.skipped,
        errors: result.errors,
      },
      "Morning briefing migration complete"
    );
  } catch (err) {
    logger.error({ err }, "Fatal error during morning briefing migration");
    throw err;
  }

  return result;
}

/**
 * Rollback morning briefing migration.
 *
 * Restores old worker config from metadata and optionally removes feed channels.
 *
 * @param options Rollback options
 * @returns Rollback result
 */
export async function rollbackMorningBriefing(
  options: {
    /** Remove feed channels (default: false - only restore config) */
    removeFeeds?: boolean;
    /** Specific user IDs to rollback */
    userIds?: string[];
  } = {}
): Promise<{
  restored: number;
  removed: number;
  errors: number;
}> {
  const { removeFeeds = false, userIds } = options;

  logger.info({ removeFeeds }, "Starting morning briefing rollback");

  let restored = 0;
  let removed = 0;
  let errors = 0;

  try {
    // Find all feed channels with morning briefing migration metadata
    const feedChannels = await db.query.channels.findMany({
      where: and(
        eq(channels.channelType, ChannelType.FEED),
        eq(channels.feedScope, FeedScope.USER)
      ),
    });

    for (const channel of feedChannels) {
      try {
        if (userIds?.length && !userIds.includes(channel.userId)) {
          continue;
        }

        const metadata = (channel.metadata as Record<string, unknown>) ?? {};
        const migrationMeta = metadata._migration as
          | Record<string, unknown>
          | undefined;

        if (!migrationMeta?.oldWorkerDeprecated) {
          continue; // Not a migrated channel
        }

        // Restore old config is automatic - the worker reads from workspace.settings
        // which was never modified. Just update metadata to mark as not deprecated.
        const updatedMetadata = {
          ...metadata,
          _migration: {
            ...migrationMeta,
            rolledBackAt: new Date().toISOString(),
            oldWorkerDeprecated: false,
          },
        };

        if (removeFeeds) {
          await db
            .update(channels)
            .set({
              status: ChannelStatus.ARCHIVED,
              metadata: {
                ...updatedMetadata,
                archivedAt: new Date().toISOString(),
                archivedReason: "rollback",
              },
              updatedAt: new Date(),
            })
            .where(eq(channels.id, channel.id));
          removed++;
        } else {
          await db
            .update(channels)
            .set({
              metadata: updatedMetadata,
              updatedAt: new Date(),
            })
            .where(eq(channels.id, channel.id));
        }

        restored++;
        logger.info(
          { userId: channel.userId, channelId: channel.id },
          "Rolled back morning briefing"
        );
      } catch (err) {
        errors++;
        logger.error(
          { err, channelId: channel.id },
          "Failed to rollback channel"
        );
      }
    }

    logger.info(
      { restored, removed, errors },
      "Morning briefing rollback complete"
    );
  } catch (err) {
    logger.error({ err }, "Fatal error during rollback");
    throw err;
  }

  return { restored, removed, errors };
}

export default migrateMorningBriefing;
