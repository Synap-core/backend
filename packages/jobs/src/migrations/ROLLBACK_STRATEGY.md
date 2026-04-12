# Unified Feeds Migration - Rollback Strategy

## Overview

This document describes the rollback strategy for the unified feeds migration system.

## Migration Components

1. **Morning Briefing Migration** (`migrate-morning-briefing.ts`)
2. **Signal Feeds Migration** (`migrate-signal-feeds.ts`)
3. **Weekly Digest Migration** (`migrate-weekly-digest.ts`)
4. **Database Index** (`0102_feed_channels_index.sql`)

## Rollback Approaches

### 1. Soft Rollback (Default)

Updates metadata to mark migrations as rolled back without removing data.

```typescript
import { rollbackFeedMigrations } from "@synap/jobs/migrations";

// Soft rollback - keeps feed channels, marks as rolled back
await rollbackFeedMigrations();
```

**Effects:**

- Updates channel metadata `_migration.rolledBackAt` timestamp
- Sets `_migration.oldWorkerDeprecated = false` for proactive feeds
- Removes proactive type from `proactiveTypes` array
- Feed channels remain active but are no longer "managed" by migration

**Use when:**

- You want to keep the feed channels for users
- Testing rollback procedure
- Partial rollback needed

### 2. Hard Rollback (With Feed Removal)

Archives feed channels created by migrations.

```typescript
import { rollbackFeedMigrations } from "@synap/jobs/migrations";

// Hard rollback - archives feed channels
await rollbackFeedMigrations({ removeFeeds: true });
```

**Effects:**

- Archives feed channels (sets `status = 'archived'`)
- Sets `metadata.archivedAt` and `metadata.archivedReason = 'rollback'`
- Removes channels from active queries
- Preserves historical data

**Use when:**

- Migration caused issues and feeds should be removed
- Complete reversal required
- Data corruption concerns

### 3. Selective Rollback

Rollback specific migrations or users.

```typescript
// Rollback specific migrations
await rollbackFeedMigrations({
  migrations: ["morning_briefing", "weekly_digest"],
  removeFeeds: true,
});

// Rollback specific users
await rollbackFeedMigrations({
  userIds: ["user_123", "user_456"],
});

// Rollback specific workspaces (for signal feeds)
await rollbackFeedMigrations({
  workspaceIds: ["ws_abc", "ws_def"],
});
```

## Rollback Data Storage

Each migration stores rollback data in channel metadata:

```typescript
// Morning Briefing / Weekly Digest
{
  _migration: {
    version: "1.0.0",
    oldWorkerDeprecated: true,
    rollbackData: {
      hadDedicatedFeed: false,
      originalConfig: {
        enabled: true,
        cronHour: 8,
        cronMinute: 0,
        timezone: "UTC",
      },
    },
    rolledBackAt: "2026-04-12T10:30:00.000Z", // Set during rollback
  },
}

// Signal Feeds
{
  _migration: {
    version: "1.0.0",
    rollbackData: {
      hadExistingFeed: false,
      subscriptionCount: 5,
      classificationCount: 3,
    },
    rolledBackAt: "2026-04-12T10:30:00.000Z",
  },
}
```

## Manual Rollback Procedures

### If Automatic Rollback Fails

1. **Identify affected channels:**

```sql
-- Find all feed channels created by migration
SELECT
  id,
  user_id,
  workspace_id,
  title,
  metadata->>'_migration' as migration_meta
FROM channels
WHERE channel_type = 'feed'
  AND metadata->'_migration' IS NOT NULL;
```

2. **Soft rollback via SQL:**

```sql
-- Mark as rolled back
UPDATE channels
SET
  metadata = jsonb_set(
    metadata,
    '{_migration}',
    (metadata->'_migration') || '{"rolledBackAt": "' || NOW()::text || '"}'::jsonb
  ),
  updated_at = NOW()
WHERE channel_type = 'feed'
  AND metadata->'_migration' IS NOT NULL;
```

3. **Hard rollback via SQL:**

```sql
-- Archive feed channels
UPDATE channels
SET
  status = 'archived',
  metadata = metadata || jsonb_build_object(
    'archivedAt', NOW()::text,
    'archivedReason', 'manual_rollback'
  ),
  updated_at = NOW()
WHERE channel_type = 'feed'
  AND metadata->'_migration' IS NOT NULL;
```

### Restore Original Workers

The original proactive workers (`proactive-morning-briefing.ts`, `proactive-weekly-digest.ts`) read their configuration from `workspace.settings.proactiveAi`, which was never modified during migration.

To restore original behavior:

1. Ensure workers are still registered in `workers/index.ts`
2. No configuration changes needed - workers will resume normal operation
3. Feed channels will continue to exist but won't receive new proactive messages

## Safety Checks

### Pre-Rollback Checklist

- [ ] Verify backup exists (if required by policy)
- [ ] Confirm rollback reason is documented
- [ ] Check affected user count
- [ ] Notify users if hard rollback (feeds will disappear)
- [ ] Verify old workers are still functional

### Post-Rollback Verification

```typescript
// Check migration status
import { getFeedMigrationStatus } from "@synap/jobs/migrations";

const status = getFeedMigrationStatus();
console.log(status);
// [
//   { migrationName: "morning_briefing", status: "rolled_back", ... },
//   { migrationName: "weekly_digest", status: "rolled_back", ... },
//   { migrationName: "signal_feeds", status: "rolled_back", ... }
// ]
```

### Verify Channel States

```sql
-- Count active feed channels by type
SELECT
  metadata->>'feedType' as feed_type,
  metadata->>'mode' as mode,
  COUNT(*) as count
FROM channels
WHERE channel_type = 'feed'
  AND status = 'active'
GROUP BY metadata->>'feedType', metadata->>'mode';

-- Check for channels with migration metadata
SELECT
  status,
  COUNT(*) as count
FROM channels
WHERE channel_type = 'feed'
  AND metadata->'_migration' IS NOT NULL
GROUP BY status;
```

## Database Index Rollback

The database index migration (`0102_feed_channels_index.sql`) is additive only and doesn't require rollback. If needed, indexes can be removed:

```sql
-- Remove feed channel indexes (if necessary)
DROP INDEX IF EXISTS "channels_feed_type_scope_idx";
DROP INDEX IF EXISTS "channels_feed_workspace_idx";
DROP INDEX IF EXISTS "channels_feed_user_idx";
DROP INDEX IF EXISTS "channels_feed_scheduler_idx";
```

**Note:** These indexes improve query performance and have minimal storage overhead. Removal is rarely necessary.

## Rollback CLI

```bash
# Navigate to jobs package
cd synap-backend/packages/jobs

# Soft rollback (default)
npx tsx src/migrations/run-feed-migrations.ts --rollback

# Hard rollback (removes feeds)
npx tsx src/migrations/run-feed-migrations.ts --rollback --remove-feeds

# Rollback specific migration
npx tsx src/migrations/run-feed-migrations.ts --rollback morning_briefing

# Dry run migration (preview only)
npx tsx src/migrations/run-feed-migrations.ts --dry-run
```

## Troubleshooting

### Common Issues

1. **"Migration not found"**
   - Verify migration name is correct
   - Check that migration module is exported

2. **"Channel not found for rollback"**
   - Channel may have been manually deleted
   - Metadata may have been corrupted
   - Use SQL queries to verify channel state

3. **"Cannot rollback - no migration metadata"**
   - Channel was not created by migration
   - Metadata was manually modified
   - Use SQL to inspect channel metadata

### Debug Commands

```sql
-- Inspect specific channel
SELECT
  id,
  user_id,
  title,
  channel_type,
  feed_scope,
  status,
  metadata
FROM channels
WHERE id = 'your-channel-id';

-- Find channels with proactive types
SELECT
  id,
  metadata->>'proactiveTypes' as proactive_types,
  metadata->'morningBriefing' as morning_config,
  metadata->'weeklyDigest' as weekly_config
FROM channels
WHERE channel_type = 'feed'
  AND status = 'active';
```

## Emergency Contacts

- **Migration Author:** [Your team/individual]
- **Database Admin:** [Your DBA]
- **On-Call Engineer:** [Your on-call rotation]

## Related Documentation

- [Channel System V2](../docs/CHANNEL-SYSTEM.md)
- [Proactive Intelligence Layer](../docs/PROACTIVE-INTELLIGENCE.md)
- [Feed System Design](../docs/FEED-SYSTEM.md)
