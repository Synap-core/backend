/**
 * Feed Service Migration
 *
 * Migrates existing feed configurations from legacy format to new unified format.
 *
 * Migration path:
 * - Old: channels.metadata.feedConfig with rsshubConfig.useCpProxy
 * - New: channels.metadata.feedConfig with provider.type and unified structure
 *
 * Features:
 * - Idempotent: safe to run multiple times
 * - Observable: logs progress and counts
 * - Reversible: supports rollback
 * - Backward compatible: keeps old fields for safety
 *
 * @module feed-service-migration
 */

import { db } from "@synap/database";
import { eq, and, sql } from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "feed-service-migration" });

// ============================================================================
// Types
// ============================================================================

export interface MigrationOptions {
  /** Dry run - don't actually modify anything */
  dryRun?: boolean;
  /** Specific channel IDs to migrate */
  channelIds?: string[];
  /** Specific user IDs to migrate */
  userIds?: string[];
  /** Specific workspace IDs to migrate */
  workspaceIds?: string[];
  /** Skip already migrated channels */
  skipMigrated?: boolean;
  /** Log level */
  logLevel?: "debug" | "info" | "warn" | "error";
}

export interface MigrationResult {
  success: boolean;
  migrated: number;
  skipped: number;
  failed: number;
  errors: Array<{
    channelId: string;
    error: string;
  }>;
  durationMs: number;
}

export interface LegacyFeedConfig {
  feedType?: string;
  enabled?: boolean;
  schedule?: string;
  timezone?: string;
  maxItemsPerRun?: number;
  dedupWindowDays?: number;
  minRelevanceScore?: number;
  postMode?: string;
  sources?: Array<{
    url: string;
    name?: string;
    rsshubRoute?: string;
    headers?: Record<string, string>;
    iconUrl?: string;
  }>;
  rsshubConfig?: {
    useCpProxy?: boolean;
    instanceUrl?: string;
    accessKey?: string;
  };
  include?: {
    tasksDue?: boolean;
    tasksDueDays?: number;
    pendingProposals?: boolean;
    recentEntities?: boolean;
    recentEntitiesHours?: number;
    recentCaptures?: boolean;
    recentCapturesHours?: number;
    activitySummary?: boolean;
  };
  summarization?: {
    style?: string;
    maxItems?: number;
    includeInsights?: boolean;
  };
}

export interface MigratedFeedConfig extends LegacyFeedConfig {
  /** Migration marker */
  _migrated?: {
    version: string;
    at: string;
    fromFormat: string;
  };
  /** New provider structure */
  provider?: {
    type: "direct" | "rsshub" | "cpproxy" | "custom";
    url?: string;
    apiKey?: string;
  };
}

// ============================================================================
// Migration Logic
// ============================================================================

/**
 * Migrate a single feed configuration from legacy to new format.
 *
 * Transformation rules:
 * 1. If rsshubConfig.useCpProxy = true → provider.type = "cpproxy"
 * 2. If rsshubConfig.useCpProxy = false → provider.type = "direct"
 * 3. If rsshubConfig.instanceUrl exists → provider.type = "rsshub"
 * 4. Otherwise → provider.type = "direct"
 */
export function migrateFeedConfig(
  legacyConfig: LegacyFeedConfig
): MigratedFeedConfig {
  const newConfig: MigratedFeedConfig = {
    ...legacyConfig,
    _migrated: {
      version: "1.0.0",
      at: new Date().toISOString(),
      fromFormat: "legacy-rsshub",
    },
  };

  // Determine provider type based on legacy config
  const rsshubConfig = legacyConfig.rsshubConfig;

  if (rsshubConfig?.useCpProxy) {
    newConfig.provider = {
      type: "cpproxy",
      url: rsshubConfig.instanceUrl,
    };
  } else if (rsshubConfig?.instanceUrl) {
    newConfig.provider = {
      type: "rsshub",
      url: rsshubConfig.instanceUrl,
      apiKey: rsshubConfig.accessKey,
    };
  } else {
    newConfig.provider = {
      type: "direct",
    };
  }

  // Normalize sources with provider info
  if (newConfig.sources && newConfig.provider) {
    newConfig.sources = newConfig.sources.map((source) => ({
      ...source,
      // Add route info if it was implicit
      rsshubRoute: source.rsshubRoute || extractRouteFromUrl(source.url),
    }));
  }

  return newConfig;
}

/**
 * Extract RSSHub route from URL if present.
 */
function extractRouteFromUrl(url: string): string | undefined {
  try {
    const urlObj = new URL(url);
    // Check if it's a RSSHub URL
    if (urlObj.hostname.includes("rsshub")) {
      return urlObj.pathname;
    }
  } catch {
    // Invalid URL
  }
  return undefined;
}

/**
 * Check if a config has already been migrated.
 */
function isAlreadyMigrated(config: unknown): boolean {
  return (
    typeof config === "object" &&
    config !== null &&
    "_migrated" in config &&
    typeof (config as { _migrated?: { version?: string } })._migrated
      ?.version === "string"
  );
}

/**
 * Validate migrated configuration.
 */
function validateMigratedConfig(
  config: MigratedFeedConfig
): Array<{ field: string; message: string }> {
  const errors: Array<{ field: string; message: string }> = [];

  if (!config.feedType) {
    errors.push({ field: "feedType", message: "feedType is required" });
  }

  if (
    config.feedType === "rss" &&
    (!config.sources || config.sources.length === 0)
  ) {
    errors.push({
      field: "sources",
      message: "RSS feed requires at least one source",
    });
  }

  if (!config.provider) {
    errors.push({
      field: "provider",
      message: "provider is required after migration",
    });
  } else if (!config.provider.type) {
    errors.push({
      field: "provider.type",
      message: "provider.type is required",
    });
  }

  return errors;
}

// ============================================================================
// Main Migration Function
// ============================================================================

/**
 * Migrate feed configurations from legacy to new format.
 *
 * @param options Migration options
 * @returns Migration result
 */
export async function migrateFeedConfigurations(
  options: MigrationOptions = {}
): Promise<MigrationResult> {
  const {
    dryRun = false,
    channelIds,
    userIds,
    workspaceIds,
    skipMigrated = true,
  } = options;

  const startTime = Date.now();
  const result: MigrationResult = {
    success: true,
    migrated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    durationMs: 0,
  };

  logger.info(
    { dryRun, skipMigrated, channelCount: channelIds?.length },
    "Starting feed configuration migration"
  );

  try {
    // Build query conditions
    const conditions = [eq(sql`channels.channel_type`, "FEED")];

    if (channelIds && channelIds.length > 0) {
      // Use IN clause for specific channels
      conditions.push(sql`channels.id IN (${sql.join(channelIds)})`);
    }

    if (userIds && userIds.length > 0) {
      conditions.push(sql`channels.user_id IN (${sql.join(userIds)})`);
    }

    if (workspaceIds && workspaceIds.length > 0) {
      conditions.push(
        sql`channels.workspace_id IN (${sql.join(workspaceIds)})`
      );
    }

    // Fetch channels with feed configuration
    const channels = await db.query.channels.findMany({
      where: and(...conditions),
      columns: {
        id: true,
        userId: true,
        workspaceId: true,
        metadata: true,
        updatedAt: true,
      },
    });

    logger.info({ count: channels.length }, "Found channels to process");

    for (const channel of channels) {
      try {
        const metadata = (channel.metadata || {}) as {
          feedConfig?: LegacyFeedConfig;
        };
        const feedConfig = metadata.feedConfig;

        // Skip if no feed config
        if (!feedConfig) {
          logger.debug({ channelId: channel.id }, "No feed config, skipping");
          result.skipped++;
          continue;
        }

        // Skip if already migrated
        if (skipMigrated && isAlreadyMigrated(feedConfig)) {
          logger.debug({ channelId: channel.id }, "Already migrated, skipping");
          result.skipped++;
          continue;
        }

        // Perform migration
        const migratedConfig = migrateFeedConfig(feedConfig);

        // Validate
        const validationErrors = validateMigratedConfig(migratedConfig);
        if (validationErrors.length > 0) {
          logger.warn(
            { channelId: channel.id, errors: validationErrors },
            "Validation failed"
          );
          result.failed++;
          result.errors.push({
            channelId: channel.id,
            error: `Validation failed: ${validationErrors.map((e) => e.message).join(", ")}`,
          });
          continue;
        }

        if (!dryRun) {
          // Update channel with migrated config
          await db
            .update(sql`channels`)
            .set({
              metadata: sql`jsonb_set(metadata, '{feedConfig}', ${JSON.stringify(
                migratedConfig
              )}::jsonb)`,
              updatedAt: new Date(),
            })
            .where(eq(sql`channels.id`, channel.id));

          logger.info({ channelId: channel.id }, "Migrated channel");
        } else {
          logger.info(
            { channelId: channel.id, migratedConfig },
            "Would migrate channel (dry run)"
          );
        }

        result.migrated++;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logger.error(
          { channelId: channel.id, error: errorMessage },
          "Migration failed"
        );
        result.failed++;
        result.errors.push({
          channelId: channel.id,
          error: errorMessage,
        });
      }
    }

    result.durationMs = Date.now() - startTime;
    result.success = result.failed === 0;

    logger.info(
      {
        migrated: result.migrated,
        skipped: result.skipped,
        failed: result.failed,
        durationMs: result.durationMs,
      },
      "Migration complete"
    );

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMessage }, "Migration failed");

    result.success = false;
    result.durationMs = Date.now() - startTime;
    return result;
  }
}

// ============================================================================
// Rollback
// ============================================================================

/**
 * Rollback migrated configurations to legacy format.
 *
 * Note: This removes the _migrated marker and provider field,
 * but keeps the rsshubConfig for compatibility.
 */
export async function rollbackFeedConfigurations(
  options: Pick<
    MigrationOptions,
    "dryRun" | "channelIds" | "userIds" | "workspaceIds"
  > = {}
): Promise<MigrationResult> {
  const { dryRun = false, channelIds, userIds, workspaceIds } = options;

  const startTime = Date.now();
  const result: MigrationResult = {
    success: true,
    migrated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    durationMs: 0,
  };

  logger.info({ dryRun }, "Starting rollback");

  try {
    // Build query conditions
    const conditions = [eq(sql`channels.channel_type`, "FEED")];

    if (channelIds && channelIds.length > 0) {
      conditions.push(sql`channels.id IN (${sql.join(channelIds)})`);
    }

    if (userIds && userIds.length > 0) {
      conditions.push(sql`channels.user_id IN (${sql.join(userIds)})`);
    }

    if (workspaceIds && workspaceIds.length > 0) {
      conditions.push(
        sql`channels.workspace_id IN (${sql.join(workspaceIds)})`
      );
    }

    // Fetch migrated channels
    const channels = await db.query.channels.findMany({
      where: and(
        ...conditions,
        sql`metadata->'feedConfig'->'_migrated' IS NOT NULL`
      ),
      columns: {
        id: true,
        metadata: true,
      },
    });

    for (const channel of channels) {
      try {
        const metadata = channel.metadata as {
          feedConfig?: MigratedFeedConfig;
        };
        const feedConfig = metadata.feedConfig;

        if (!feedConfig?._migrated) {
          result.skipped++;
          continue;
        }

        // Create rolled back config
        const rolledBackConfig: LegacyFeedConfig = { ...feedConfig };
        delete (rolledBackConfig as Partial<MigratedFeedConfig>)._migrated;
        delete (rolledBackConfig as Partial<MigratedFeedConfig>).provider;

        if (!dryRun) {
          await db
            .update(sql`channels`)
            .set({
              metadata: sql`jsonb_set(metadata, '{feedConfig}', ${JSON.stringify(
                rolledBackConfig
              )}::jsonb)`,
              updatedAt: new Date(),
            })
            .where(eq(sql`channels.id`, channel.id));

          logger.info({ channelId: channel.id }, "Rolled back channel");
        } else {
          logger.info(
            { channelId: channel.id },
            "Would roll back channel (dry run)"
          );
        }

        result.migrated++;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        result.failed++;
        result.errors.push({
          channelId: channel.id,
          error: errorMessage,
        });
      }
    }

    result.durationMs = Date.now() - startTime;
    result.success = result.failed === 0;

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    result.success = false;
    result.durationMs = Date.now() - startTime;
    return result;
  }
}

// ============================================================================
// Status Check
// ============================================================================

/**
 * Get migration status for all feed channels.
 */
export async function getMigrationStatus(): Promise<{
  total: number;
  migrated: number;
  pending: number;
  legacy: number;
}> {
  const channels = await db.query.channels.findMany({
    where: eq(sql`channels.channel_type`, "FEED"),
    columns: {
      id: true,
      metadata: true,
    },
  });

  let migrated = 0;
  let legacy = 0;
  let pending = 0;

  for (const channel of channels) {
    const metadata = channel.metadata as { feedConfig?: LegacyFeedConfig };
    const feedConfig = metadata.feedConfig;

    if (!feedConfig) {
      pending++;
    } else if (isAlreadyMigrated(feedConfig)) {
      migrated++;
    } else {
      legacy++;
    }
  }

  return {
    total: channels.length,
    migrated,
    pending,
    legacy,
  };
}

// ============================================================================
// CLI Support
// ============================================================================

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const rollback = args.includes("--rollback");
  const status = args.includes("--status");

  if (status) {
    getMigrationStatus()
      .then((result) => {
        console.log("Migration Status:");
        console.log(JSON.stringify(result, null, 2));
        process.exit(0);
      })
      .catch((err) => {
        console.error("Status check failed:", err);
        process.exit(1);
      });
  } else if (rollback) {
    rollbackFeedConfigurations({ dryRun })
      .then((result) => {
        console.log("Rollback Result:");
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.success ? 0 : 1);
      })
      .catch((err) => {
        console.error("Rollback failed:", err);
        process.exit(1);
      });
  } else {
    migrateFeedConfigurations({ dryRun })
      .then((result) => {
        console.log("Migration Result:");
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.success ? 0 : 1);
      })
      .catch((err) => {
        console.error("Migration failed:", err);
        process.exit(1);
      });
  }
}
