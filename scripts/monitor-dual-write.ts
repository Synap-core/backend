/**
 * Dual-Write Monitoring Script
 * 
 * V0.3: Monitors synchronization between R2 and PostgreSQL
 * Runs continuously to detect discrepancies.
 */

import { db } from '@synap/database';
import { entities, contentBlocks } from '@synap/database';
import { r2 } from '@synap/storage';
import { eq, isNotNull } from 'drizzle-orm';

interface SyncStatus {
  total: number;
  synced: number;
  r2Missing: number;
  postgresqlMissing: number;
  checksumMismatch: number;
  errors: Array<{
    entityId: string;
    issue: string;
    details?: string;
  }>;
}

async function checkSync(): Promise<SyncStatus> {
  const status: SyncStatus = {
    total: 0,
    synced: 0,
    r2Missing: 0,
    postgresqlMissing: 0,
    checksumMismatch: 0,
    errors: [],
  };

  // Get all entities with file URLs (created in V0.3)
  const allEntities = await db.select()
    .from(entities)
    .where(isNotNull((entities as any).fileUrl))
    .limit(1000);

  status.total = allEntities.length;

  for (const entity of allEntities) {
    try {
      // Check R2 file exists
      const r2Exists = await r2.exists((entity as any).filePath);

      if (!r2Exists) {
        status.r2Missing++;
        status.errors.push({
          entityId: entity.id,
          issue: 'r2_missing',
          details: `File not found in R2: ${(entity as any).filePath}`,
        });
        continue;
      }

      // Check PostgreSQL content exists
      const pgContent = await db.select()
        .from(contentBlocks)
        .where(eq((contentBlocks as any).entityId, entity.id));

      if (pgContent.length === 0) {
        status.postgresqlMissing++;
        status.errors.push({
          entityId: entity.id,
          issue: 'postgresql_missing',
          details: 'Content not found in content_blocks table',
        });
        continue;
      }

      // Verify checksum matches
      if ((entity as any).checksum) {
        const r2Content = await r2.download((entity as any).filePath);
        const { createHash } = await import('crypto');
        const actualChecksum = `sha256:${createHash('sha256').update(r2Content).digest('base64')}`;

        if (actualChecksum !== (entity as any).checksum) {
          status.checksumMismatch++;
          status.errors.push({
            entityId: entity.id,
            issue: 'checksum_mismatch',
            details: `Expected: ${(entity as any).checksum}, Got: ${actualChecksum}`,
          });
          continue;
        }
      }

      // All good!
      status.synced++;

    } catch (error) {
      status.errors.push({
        entityId: entity.id,
        issue: 'error',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return status;
}

async function printReport(status: SyncStatus) {
  console.log('\n' + '='.repeat(60));
  console.log('📊 DUAL-WRITE SYNC REPORT');
  console.log('='.repeat(60));
  console.log(`⏰ Timestamp: ${new Date().toISOString()}`);
  console.log('');
  console.log(`📈 Total Entities: ${status.total}`);
  console.log(`✅ Synced: ${status.synced} (${((status.synced / status.total) * 100).toFixed(1)}%)`);
  console.log(`❌ R2 Missing: ${status.r2Missing}`);
  console.log(`❌ PostgreSQL Missing: ${status.postgresqlMissing}`);
  console.log(`❌ Checksum Mismatch: ${status.checksumMismatch}`);
  console.log('');

  if (status.errors.length > 0) {
    console.log('🚨 ERRORS:');
    console.log('');
    status.errors.slice(0, 10).forEach(error => {
      console.log(`  - [${error.entityId}] ${error.issue}`);
      if (error.details) {
        console.log(`    ${error.details}`);
      }
    });

    if (status.errors.length > 10) {
      console.log(`  ... and ${status.errors.length - 10} more errors`);
    }
  } else {
    console.log('✅ No errors detected!');
  }

  console.log('='.repeat(60));
  console.log('');
}

async function monitorContinuously(intervalSeconds: number = 60) {
  console.log(`🔍 Starting continuous monitoring (every ${intervalSeconds}s)...`);
  console.log('Press Ctrl+C to stop\n');

  while (true) {
    try {
      const status = await checkSync();
      await printReport(status);

      // Alert if sync rate drops below 95%
      const syncRate = (status.synced / status.total) * 100;
      if (syncRate < 95) {
        console.log('🚨 WARNING: Sync rate below 95%!');
        console.log('   Check R2 credentials and network connection.');
      }

    } catch (error) {
      console.error('❌ Monitoring error:', error);
    }

    // Wait before next check
    await new Promise(resolve => setTimeout(resolve, intervalSeconds * 1000));
  }
}

// Parse command line args
const args = process.argv.slice(2);
const mode = args[0] || 'once';
const interval = parseInt(args[1] || '60', 10);

if (mode === 'continuous') {
  monitorContinuously(interval)
    .catch(error => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
} else {
  // Run once
  checkSync()
    .then(printReport)
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Error:', error);
      process.exit(1);
    });
}

