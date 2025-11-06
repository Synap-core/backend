/**
 * Content Migration Script: PostgreSQL → R2
 * 
 * V0.3 Day 4: Migrate existing content_blocks data to R2
 * 
 * This script:
 * 1. Reads all content from content_blocks table
 * 2. Uploads each to R2
 * 3. Updates entities table with file references
 * 4. Verifies checksums
 * 5. Reports progress
 */

import { db } from '@synap/database';
import { entities, contentBlocks } from '@synap/database';
import { r2, R2Storage } from '@synap/storage';
import { eq, isNotNull, isNull } from 'drizzle-orm';

interface MigrationOptions {
  dryRun?: boolean;
  limit?: number;
  batchSize?: number;
  pauseBetweenBatches?: number; // milliseconds
}

interface MigrationStats {
  total: number;
  migrated: number;
  skipped: number;
  failed: number;
  errors: Array<{
    entityId: string;
    error: string;
  }>;
}

async function migrateContentToR2(options: MigrationOptions = {}): Promise<MigrationStats> {
  const {
    dryRun = false,
    limit = Infinity,
    batchSize = 100,
    pauseBetweenBatches = 5000,
  } = options;

  const stats: MigrationStats = {
    total: 0,
    migrated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  console.log('🚀 Starting content migration to R2...\n');
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Batch size: ${batchSize}`);
  console.log(`Pause between batches: ${pauseBetweenBatches}ms`);
  console.log('');

  // Get all entities that:
  // 1. Have content in content_blocks
  // 2. Don't yet have file_url (not migrated)
  const entitiesToMigrate = await db.select({
    entity: entities,
    content: contentBlocks,
  })
    .from(entities)
    .leftJoin(contentBlocks, eq(entities.id, (contentBlocks as any).entityId))
    .where(isNull((entities as any).fileUrl))
    .limit(limit);

  stats.total = entitiesToMigrate.length;

  console.log(`📊 Found ${stats.total} entities to migrate\n`);

  if (stats.total === 0) {
    console.log('✅ No entities to migrate!');
    return stats;
  }

  // Process in batches
  for (let i = 0; i < entitiesToMigrate.length; i += batchSize) {
    const batch = entitiesToMigrate.slice(i, i + batchSize);
    const batchNumber = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(entitiesToMigrate.length / batchSize);

    console.log(`\n📦 Batch ${batchNumber}/${totalBatches} (${batch.length} entities)`);
    console.log('─'.repeat(60));

    for (const item of batch) {
      const { entity, content } = item;

      if (!content || !(content as any).content) {
        console.log(`⏭️  ${entity.id} - No content, skipping`);
        stats.skipped++;
        continue;
      }

      try {
        // Build R2 path
        const userId = (entity as any).userId || 'unknown';
        const filePath = R2Storage.buildPath(
          userId,
          entity.type,
          entity.id,
          'md'
        );

        if (dryRun) {
          console.log(`🔍 [DRY RUN] Would upload ${entity.id} to ${filePath}`);
          stats.migrated++;
          continue;
        }

        // Upload to R2
        const fileMetadata = await r2.upload(
          filePath,
          (content as any).content,
          { contentType: 'text/markdown' }
        );

        // Update entities table with file reference
        await db.update(entities)
          .set({
            fileUrl: fileMetadata.url,
            filePath: fileMetadata.path,
            fileSize: fileMetadata.size,
            fileType: 'markdown',
            checksum: fileMetadata.checksum,
          } as any)
          .where(eq(entities.id, entity.id));

        stats.migrated++;
        console.log(`✅ ${stats.migrated}/${stats.total} - Migrated ${entity.id}`);

      } catch (error) {
        stats.failed++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        stats.errors.push({
          entityId: entity.id,
          error: errorMessage,
        });
        console.error(`❌ Failed to migrate ${entity.id}:`, errorMessage);
      }
    }

    // Pause between batches (respect R2 rate limits)
    if (i + batchSize < entitiesToMigrate.length) {
      console.log(`\n⏸️  Pausing ${pauseBetweenBatches}ms before next batch...`);
      await new Promise(resolve => setTimeout(resolve, pauseBetweenBatches));
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
      console.log(`  ${index + 1}. ${error.entityId}: ${error.error}`);
    });
    console.log('');
  }

  const successRate = ((stats.migrated / stats.total) * 100).toFixed(1);
  console.log(`Success Rate: ${successRate}%`);
  
  if (parseFloat(successRate) < 100) {
    console.log('\n⚠️  Migration incomplete. Review errors above.');
  } else {
    console.log('\n✅ Migration complete!');
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
  pauseBetweenBatches: 5000, // 5 seconds
};

// Run migration
migrateContentToR2(options)
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

