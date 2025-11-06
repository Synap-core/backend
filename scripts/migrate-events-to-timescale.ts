/**
 * Event Migration Script: Old events → TimescaleDB events_v2
 * 
 * V0.3: Migrate historical events from old table to new event store
 * 
 * This script:
 * 1. Reads all events from old 'events' table
 * 2. Transforms to new event sourcing structure
 * 3. Inserts into 'events_v2' hypertable
 * 4. Maintains version numbers per aggregate
 * 5. Preserves timestamps and user IDs
 */

import { db } from '@synap/database';
import { events } from '@synap/database';
import { eventRepository, AggregateType, EventSource } from '@synap/database';
import { eq } from 'drizzle-orm';

interface MigrationOptions {
  dryRun?: boolean;
  limit?: number;
  batchSize?: number;
}

interface MigrationStats {
  total: number;
  migrated: number;
  skipped: number;
  failed: number;
  errors: Array<{
    eventId: string;
    error: string;
  }>;
}

async function migrateEventsToTimescale(options: MigrationOptions = {}): Promise<MigrationStats> {
  const {
    dryRun = false,
    limit = Infinity,
    batchSize = 100,
  } = options;

  const stats: MigrationStats = {
    total: 0,
    migrated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  console.log('🚀 Starting events migration to TimescaleDB...\n');
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Batch size: ${batchSize}`);
  console.log('');

  // Get all events from old table
  const oldEvents = await db.select()
    .from(events)
    .limit(limit)
    .all();

  stats.total = oldEvents.length;

  console.log(`📊 Found ${stats.total} events to migrate\n`);

  if (stats.total === 0) {
    console.log('✅ No events to migrate!');
    return stats;
  }

  // Track versions per aggregate
  const aggregateVersions = new Map<string, number>();

  // Process in batches
  for (let i = 0; i < oldEvents.length; i += batchSize) {
    const batch = oldEvents.slice(i, i + batchSize);
    const batchNumber = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(oldEvents.length / batchSize);

    console.log(`\n📦 Batch ${batchNumber}/${totalBatches} (${batch.length} events)`);
    console.log('─'.repeat(60));

    for (const event of batch) {
      try {
        // Extract data
        const eventData = (event as any).data || {};
        const userId = (event as any).userId || 'system';
        
        // Determine aggregate ID (use event ID or entity ID from data)
        const aggregateId = eventData.entityId || event.id;
        
        // Get or initialize version for this aggregate
        let version = aggregateVersions.get(aggregateId) || 0;
        version += 1;
        aggregateVersions.set(aggregateId, version);

        if (dryRun) {
          console.log(`🔍 [DRY RUN] Would migrate ${event.id} (aggregate: ${aggregateId}, version: ${version})`);
          stats.migrated++;
          continue;
        }

        // Insert into events_v2
        await eventRepository.append({
          aggregateId,
          aggregateType: AggregateType.ENTITY, // Default, can be inferred from event type
          eventType: (event as any).type || 'unknown',
          userId,
          data: eventData,
          metadata: {
            migratedFrom: 'events_table',
            originalId: event.id,
            originalTimestamp: (event as any).createdAt,
          },
          version,
          source: EventSource.MIGRATION,
        });

        stats.migrated++;
        console.log(`✅ ${stats.migrated}/${stats.total} - Migrated ${event.id}`);

      } catch (error) {
        stats.failed++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        stats.errors.push({
          eventId: event.id,
          error: errorMessage,
        });
        console.error(`❌ Failed to migrate ${event.id}:`, errorMessage);
      }
    }

    // Small pause between batches
    if (i + batchSize < oldEvents.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return stats;
}

function printFinalReport(stats: MigrationStats, dryRun: boolean) {
  console.log('\n' + '='.repeat(60));
  console.log(`📊 MIGRATION ${dryRun ? 'DRY RUN' : 'FINAL'} REPORT`);
  console.log('='.repeat(60));
  console.log(`✅ Migrated: ${stats.migrated}`);
  console.log(`⏭️  Skipped: ${stats.skipped}`);
  console.log(`❌ Failed: ${stats.failed}`);
  console.log(`📈 Total: ${stats.total}`);
  console.log('');

  if (stats.failed > 0) {
    console.log('❌ ERRORS:');
    stats.errors.forEach((error, index) => {
      console.log(`  ${index + 1}. ${error.eventId}: ${error.error}`);
    });
    console.log('');
  }

  const successRate = stats.total > 0 ? ((stats.migrated / stats.total) * 100).toFixed(1) : '0.0';
  console.log(`Success Rate: ${successRate}%`);
  
  if (parseFloat(successRate) < 100) {
    console.log('\n⚠️  Migration incomplete. Review errors above.');
  } else {
    console.log('\n✅ Migration complete!');
    console.log('\nNext steps:');
    console.log('1. Verify events_v2 table: psql $DATABASE_URL -c "SELECT COUNT(*) FROM events_v2;"');
    console.log('2. Test event replay: tsx scripts/test-event-replay.ts');
    console.log('3. Switch API to use events_v2');
    console.log('4. Drop old events table (after validation)');
  }

  console.log('='.repeat(60));
  console.log('');
}

// Parse command line args
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const limitArg = args.find(arg => arg.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : undefined;

const options: MigrationOptions = {
  dryRun: isDryRun,
  limit,
  batchSize: 100,
};

// Run migration
migrateEventsToTimescale(options)
  .then(stats => {
    printFinalReport(stats, isDryRun);
    
    if (stats.failed > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  })
  .catch(error => {
    console.error('💥 Migration failed:', error);
    process.exit(1);
  });

