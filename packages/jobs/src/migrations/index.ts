/**
 * Feed Migrations
 *
 * Migration scripts for unified feeds system:
 * - Morning Briefing Migration
 * - Signal Feeds Migration
 * - Weekly Digest Migration
 * - Migration Runner
 *
 * @example
 * ```ts
 * import { runFeedMigrations, rollbackFeedMigrations } from "@synap/jobs/migrations";
 *
 * // Run all migrations
 * const result = await runFeedMigrations();
 *
 * // Dry run
 * const dryResult = await runFeedMigrations({ dryRun: true });
 *
 * // Rollback
 * await rollbackFeedMigrations();
 * ```
 */

// Individual migrations
export {
  migrateMorningBriefing,
  rollbackMorningBriefing,
  type MorningBriefingMigrationResult,
} from "./migrate-morning-briefing.js";

export {
  migrateWeeklyDigest,
  rollbackWeeklyDigest,
  type WeeklyDigestMigrationResult,
} from "./migrate-weekly-digest.js";

// Migration runner
export {
  runFeedMigrations,
  rollbackFeedMigrations,
  getFeedMigrationStatus,
  resetMigrationState,
  type RunMigrationsOptions,
  type RunMigrationsResult,
  type RollbackOptions,
  type MigrationState,
} from "./run-feed-migrations.js";
