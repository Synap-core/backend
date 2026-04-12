# Unified Feeds Migration - Summary

## Files Created

### Migration Scripts (packages/jobs/src/migrations/)

1. **migrate-morning-briefing.ts** (15.7 KB)
   - Migrates users with proactive morning briefing enabled
   - Creates "The Morning Feed" channel per user
   - Copies schedule from `workspace.settings.proactiveAi`
   - Sets config: `feedType='proactive'`, batch mode, 30-day retention
   - Includes rollback support

2. **migrate-signal-feeds.ts** (19.5 KB)
   - Migrates users with signal feed subscriptions
   - Creates RSS feed channels for subscriptions
   - Migrates topic preferences to `topicsFilter`
   - Sets individual mode, 30-day retention
   - Includes rollback support

3. **migrate-weekly-digest.ts** (16.4 KB)
   - Similar to morning briefing migration
   - Creates "Weekly Roundup" feed channel
   - Copies schedule config from workspace settings
   - Includes rollback support

4. **run-feed-migrations.ts** (12.4 KB)
   - Orchestrates all migrations
   - Runs in order: morning_briefing → weekly_digest → signal_feeds
   - Tracks migration state
   - Idempotent and observable
   - CLI support with --dry-run and --rollback flags

5. **index.ts** (1.2 KB)
   - Barrel export for all migrations
   - Exports individual migrations and runner functions
   - Type exports for TypeScript consumers

6. **ROLLBACK_STRATEGY.md** (7.8 KB)
   - Complete rollback documentation
   - Soft rollback (metadata only) vs hard rollback (archive feeds)
   - Manual rollback procedures
   - SQL queries for debugging

### Database Migration (packages/database/migrations/)

7. **0102_feed_channels_index.sql** (1.7 KB)
   - Index on `channel_type='feed'` for scheduler queries
   - Composite indexes for common query patterns
   - Comments for documentation

### Package.json Updates (packages/jobs/package.json)

8. **Export path added:**

   ```json
   "./migrations": {
     "types": "./dist/migrations/index.d.ts",
     "import": "./dist/migrations/index.js"
   }
   ```

9. **Scripts added:**
   ```json
   "migrate:feeds": "tsx src/migrations/run-feed-migrations.ts"
   "migrate:feeds:dry-run": "tsx src/migrations/run-feed-migrations.ts --dry-run"
   "migrate:feeds:rollback": "tsx src/migrations/run-feed-migrations.ts --rollback"
   ```

## Usage

### Run All Migrations

```typescript
import { runFeedMigrations } from "@synap/jobs/migrations";

const result = await runFeedMigrations();
console.log(
  `Created: ${result.completed.length}, Failed: ${result.failed.length}`
);
```

### Dry Run

```typescript
const result = await runFeedMigrations({ dryRun: true });
// Preview changes without modifying database
```

### Specific Users/Workspaces

```typescript
await runFeedMigrations({
  userIds: ["user_123", "user_456"],
  workspaceIds: ["ws_abc"],
});
```

### Rollback

```typescript
import { rollbackFeedMigrations } from "@synap/jobs/migrations";

// Soft rollback (keep feeds, mark as rolled back)
await rollbackFeedMigrations();

// Hard rollback (archive feed channels)
await rollbackFeedMigrations({ removeFeeds: true });
```

### CLI Usage

```bash
# From synap-backend/packages/jobs
pnpm migrate:feeds

# Dry run
pnpm migrate:feeds:dry-run

# Rollback
pnpm migrate:feeds:rollback

# Or directly with tsx
npx tsx src/migrations/run-feed-migrations.ts --dry-run
```

## Key Features

### Idempotency

- Each migration checks if feed already exists before creating
- Can safely run multiple times
- Updates existing feeds with new config if already present

### Observability

- Structured logging with progress updates
- Detailed result objects with per-user status
- Error tracking with context

### Rollback Support

- Soft rollback: updates metadata, keeps channels
- Hard rollback: archives feed channels
- Stores original config in metadata for restoration

### Safety

- Dry-run mode for testing
- Selective migration by user/workspace
- Transaction-safe operations
- Error handling per user (doesn't stop on single failure)

## Migration Metadata Structure

Each migrated channel stores rollback data:

```typescript
{
  _migration: {
    version: "1.0.0",
    oldWorkerDeprecated: true,
    rollbackData: {
      hadDedicatedFeed: false,
      originalConfig: { /* original proactiveAi config */ }
    },
    rolledBackAt: "2026-04-12T10:30:00.000Z" // Set during rollback
  }
}
```

## Database Indexes Added

```sql
-- Feed type + scope lookup
CREATE INDEX channels_feed_type_scope_idx
  ON channels (channel_type, feed_scope, status)
  WHERE channel_type = 'feed';

-- Workspace-scoped feeds
CREATE INDEX channels_feed_workspace_idx
  ON channels (workspace_id, channel_type, status)
  WHERE channel_type = 'feed' AND workspace_id IS NOT NULL;

-- User feeds
CREATE INDEX channels_feed_user_idx
  ON channels (user_id, channel_type, status)
  WHERE channel_type = 'feed';

-- Scheduler queries
CREATE INDEX channels_feed_scheduler_idx
  ON channels (user_id, feed_scope, status, channel_type);
```

## Testing Checklist

- [ ] Run dry-run mode to preview changes
- [ ] Test with single user/workspace
- [ ] Verify channel metadata is correct
- [ ] Test rollback (soft)
- [ ] Test rollback (hard with removeFeeds)
- [ ] Verify indexes are created
- [ ] Check worker registry updates
- [ ] Monitor logs for errors

## Post-Migration

After successful migration:

1. Monitor feed channels for activity
2. Verify proactive messages are routing to feeds
3. Update any documentation referencing old workers
4. Consider deprecating old workers after validation period
