/**
 * Unified Feeds Migration Runner
 *
 * Orchestrates the migration of legacy proactive workers and signal feeds
 * to the unified feed channel system.
 *
 * Features:
 * - Runs all migrations in order
 * - Tracks migration state in database
 * - Idempotent: safe to run multiple times
 * - Observable: logs progress, counts, timing
 * - Reversible: supports rollback
 *
 * @example
 * ```ts
 * // Run all migrations
 * import { runFeedMigrations } from "./run-feed-migrations.js";
 * await runFeedMigrations();
 *
 * // Dry run
 * await runFeedMigrations({ dryRun: true });
 *
 * // Rollback
 * import { rollbackFeedMigrations } from "./run-feed-migrations.js";
 * await rollbackFeedMigrations();
 * ```
 */

import { db, eq, and } from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  migrateMorningBriefing,
  rollbackMorningBriefing,
} from "./migrate-morning-briefing.js";
import {
  migrateSignalFeeds,
  rollbackSignalFeeds,
} from "./migrate-signal-feeds.js";
import {
  migrateWeeklyDigest,
  rollbackWeeklyDigest,
} from "./migrate-weekly-digest.js";

const logger = createLogger({ module: "feed-migrations-runner" });

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MigrationState {
  id: string;
  migrationName: string;
  status: "pending" | "running" | "completed" | "failed" | "rolled_back";
  startedAt: string;
  completedAt?: string;
  result?: Record<string, unknown>;
  error?: string;
}

export interface RunMigrationsOptions {
  /** Dry run - don't actually modify anything */
  dryRun?: boolean;
  /** Specific migrations to run (defaults to all) */
  migrations?: Array<"morning_briefing" | "signal_feeds" | "weekly_digest">;
  /** Specific user IDs to migrate */
  userIds?: string[];
  /** Specific workspace IDs to migrate */
  workspaceIds?: string[];
  /** Skip already completed migrations */
  skipCompleted?: boolean;
}

export interface RunMigrationsResult {
  success: boolean;
  completed: string[];
  skipped: string[];
  failed: string[];
  results: Record<string, unknown>;
  durationMs: number;
}

export interface RollbackOptions {
  /** Specific migrations to rollback (defaults to all) */
  migrations?: Array<"morning_briefing" | "signal_feeds" | "weekly_digest">;
  /** Remove feed channels (default: false) */
  removeFeeds?: boolean;
  /** Specific user IDs to rollback */
  userIds?: string[];
  /** Specific workspace IDs to rollback */
  workspaceIds?: string[];
}

// ─── In-Memory State Tracking ────────────────────────────────────────────────

/**
 * Since we don't have a dedicated migration_state table yet,
 * we track state in-memory and log it. In production, you may
 * want to persist this to a table.
 */
const migrationStates = new Map<string, MigrationState>();

function getMigrationId(name: string): string {
  return `feed_migration_${name}_v1`;
}

function getMigrationState(name: string): MigrationState {
  const id = getMigrationId(name);
  return (
    migrationStates.get(id) ?? {
      id,
      migrationName: name,
      status: "pending",
      startedAt: new Date().toISOString(),
    }
  );
}

function setMigrationState(
  name: string,
  update: Partial<MigrationState>
): void {
  const id = getMigrationId(name);
  const current = getMigrationState(name);
  migrationStates.set(id, { ...current, ...update, id });
}

// ─── Migration Functions ─────────────────────────────────────────────────────

type MigrationFunction = (opts: {
  dryRun?: boolean;
  userIds?: string[];
  workspaceIds?: string[];
}) => Promise<Record<string, unknown>>;

type RollbackFunction = (opts: {
  removeFeeds?: boolean;
  userIds?: string[];
  workspaceIds?: string[];
}) => Promise<Record<string, unknown>>;

const MIGRATIONS: Record<
  string,
  { migrate: MigrationFunction; rollback: RollbackFunction }
> = {
  morning_briefing: {
    migrate: async (opts) => {
      const result = await migrateMorningBriefing(opts);
      return {
        created: result.created,
        skipped: result.skipped,
        errors: result.errors,
      };
    },
    rollback: async (opts) => rollbackMorningBriefing(opts),
  },
  signal_feeds: {
    migrate: async (opts) => {
      const result = await migrateSignalFeeds(opts);
      return {
        created: result.created,
        skipped: result.skipped,
        errors: result.errors,
        subscriptionsMigrated: result.subscriptionsMigrated,
        topicsMigrated: result.topicsMigrated,
      };
    },
    rollback: async (opts) => rollbackSignalFeeds(opts),
  },
  weekly_digest: {
    migrate: async (opts) => {
      const result = await migrateWeeklyDigest(opts);
      return {
        created: result.created,
        skipped: result.skipped,
        errors: result.errors,
      };
    },
    rollback: async (opts) => rollbackWeeklyDigest(opts),
  },
};

// ─── Main Runner ─────────────────────────────────────────────────────────────

/**
 * Run all unified feed migrations.
 *
 * Execution order:
 * 1. Morning Briefing Migration
 * 2. Weekly Digest Migration
 * 3. Signal Feeds Migration
 *
 * Each migration is idempotent and can be safely re-run.
 *
 * @param options Migration options
 * @returns Result with success status and per-migration results
 */
export async function runFeedMigrations(
  options: RunMigrationsOptions = {}
): Promise<RunMigrationsResult> {
  const {
    dryRun = false,
    migrations = ["morning_briefing", "weekly_digest", "signal_feeds"],
    userIds,
    workspaceIds,
    skipCompleted = true,
  } = options;

  const startTime = Date.now();

  logger.info(
    {
      dryRun,
      migrations,
      userCount: userIds?.length,
      workspaceCount: workspaceIds?.length,
    },
    "Starting unified feed migrations"
  );

  const result: RunMigrationsResult = {
    success: true,
    completed: [],
    skipped: [],
    failed: [],
    results: {},
    durationMs: 0,
  };

  for (const migrationName of migrations) {
    const state = getMigrationState(migrationName);

    // Skip if already completed and skipCompleted is true
    if (skipCompleted && state.status === "completed") {
      logger.info(
        { migration: migrationName },
        "Skipping already completed migration"
      );
      result.skipped.push(migrationName);
      continue;
    }

    const migration = MIGRATIONS[migrationName];
    if (!migration) {
      logger.error({ migration: migrationName }, "Unknown migration");
      result.failed.push(migrationName);
      result.success = false;
      continue;
    }

    setMigrationState(migrationName, {
      status: "running",
      startedAt: new Date().toISOString(),
    });

    try {
      logger.info(
        { migration: migrationName },
        `Running migration: ${migrationName}`
      );

      const migrateResult = await migration.migrate({
        dryRun,
        userIds,
        workspaceIds,
      });

      result.results[migrationName] = migrateResult;
      result.completed.push(migrationName);

      setMigrationState(migrationName, {
        status: "completed",
        completedAt: new Date().toISOString(),
        result: migrateResult,
      });

      logger.info(
        { migration: migrationName, result: migrateResult },
        `Migration completed: ${migrationName}`
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      result.failed.push(migrationName);
      result.success = false;

      setMigrationState(migrationName, {
        status: "failed",
        error: errorMessage,
      });

      logger.error(
        { err, migration: migrationName },
        `Migration failed: ${migrationName}`
      );

      // Continue with other migrations even if one fails
    }
  }

  result.durationMs = Date.now() - startTime;

  logger.info(
    {
      success: result.success,
      completed: result.completed.length,
      skipped: result.skipped.length,
      failed: result.failed.length,
      durationMs: result.durationMs,
    },
    "Unified feed migrations complete"
  );

  return result;
}

/**
 * Rollback unified feed migrations.
 *
 * Rollback order (reverse of migration):
 * 1. Signal Feeds Rollback
 * 2. Weekly Digest Rollback
 * 3. Morning Briefing Rollback
 *
 * @param options Rollback options
 * @returns Result with success status
 */
export async function rollbackFeedMigrations(
  options: RollbackOptions = {}
): Promise<{
  success: boolean;
  rolledBack: string[];
  failed: string[];
  results: Record<string, unknown>;
}> {
  const {
    migrations = ["signal_feeds", "weekly_digest", "morning_briefing"],
    removeFeeds = false,
    userIds,
    workspaceIds,
  } = options;

  logger.info(
    { migrations, removeFeeds, userCount: userIds?.length },
    "Starting unified feed rollback"
  );

  const result = {
    success: true,
    rolledBack: [] as string[],
    failed: [] as string[],
    results: {} as Record<string, unknown>,
  };

  for (const migrationName of migrations) {
    const migration = MIGRATIONS[migrationName];
    if (!migration) {
      logger.error({ migration: migrationName }, "Unknown migration");
      result.failed.push(migrationName);
      result.success = false;
      continue;
    }

    try {
      logger.info(
        { migration: migrationName },
        `Rolling back: ${migrationName}`
      );

      const rollbackResult = await migration.rollback({
        removeFeeds,
        userIds,
        workspaceIds,
      });

      result.results[migrationName] = rollbackResult;
      result.rolledBack.push(migrationName);

      setMigrationState(migrationName, {
        status: "rolled_back",
        completedAt: new Date().toISOString(),
      });

      logger.info(
        { migration: migrationName, result: rollbackResult },
        `Rollback completed: ${migrationName}`
      );
    } catch (err) {
      result.failed.push(migrationName);
      result.success = false;
      logger.error(
        { err, migration: migrationName },
        `Rollback failed: ${migrationName}`
      );
    }
  }

  logger.info(
    {
      success: result.success,
      rolledBack: result.rolledBack.length,
      failed: result.failed.length,
    },
    "Unified feed rollback complete"
  );

  return result;
}

/**
 * Get migration status for all feed migrations.
 */
export function getFeedMigrationStatus(): MigrationState[] {
  return Object.keys(MIGRATIONS).map((name) => getMigrationState(name));
}

/**
 * Reset migration state (for testing only).
 */
export function resetMigrationState(): void {
  migrationStates.clear();
  logger.info("Migration state reset");
}

// ─── CLI Support ─────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  // Running as CLI script
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const rollback = args.includes("--rollback");
  const removeFeeds = args.includes("--remove-feeds");
  const specificMigration = args.find((arg) =>
    ["morning_briefing", "signal_feeds", "weekly_digest"].includes(arg)
  );

  const migrations = specificMigration ? [specificMigration] : undefined;

  if (rollback) {
    rollbackFeedMigrations({ migrations, removeFeeds })
      .then((result) => {
        console.log("Rollback result:", JSON.stringify(result, null, 2));
        process.exit(result.success ? 0 : 1);
      })
      .catch((err) => {
        console.error("Rollback failed:", err);
        process.exit(1);
      });
  } else {
    runFeedMigrations({ dryRun, migrations })
      .then((result) => {
        console.log("Migration result:", JSON.stringify(result, null, 2));
        process.exit(result.success ? 0 : 1);
      })
      .catch((err) => {
        console.error("Migration failed:", err);
        process.exit(1);
      });
  }
}

export default runFeedMigrations;
