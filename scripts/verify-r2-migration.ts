/**
 * Verification Script: R2 Migration Complete
 * 
 * V0.3 Day 5: Verify migration before dropping content_blocks table
 */

import { db } from '@synap/database';
import { entities, contentBlocks } from '@synap/database';
import { r2 } from '@synap/storage';
import { isNotNull } from 'drizzle-orm';
import { createHash } from 'crypto';

interface VerificationResult {
  totalEntities: number;
  withFileUrl: number;
  missingFileUrl: number;
  r2FilesExist: number;
  r2FilesMissing: number;
  checksumMatches: number;
  checksumMismatches: number;
  errors: Array<{
    entityId: string;
    issue: string;
    details?: string;
  }>;
}

async function verifyMigration(): Promise<VerificationResult> {
  const result: VerificationResult = {
    totalEntities: 0,
    withFileUrl: 0,
    missingFileUrl: 0,
    r2FilesExist: 0,
    r2FilesMissing: 0,
    checksumMatches: 0,
    checksumMismatches: 0,
    errors: [],
  };

  console.log('🔍 Verifying R2 migration...\n');

  // Get all entities
  const allEntities = await db.select().from(entities);
  result.totalEntities = allEntities.length;

  console.log(`📊 Total entities: ${result.totalEntities}`);

  for (const entity of allEntities) {
    const fileUrl = (entity as any).fileUrl;

    // Check if entity has file URL
    if (!fileUrl) {
      result.missingFileUrl++;
      result.errors.push({
        entityId: entity.id,
        issue: 'missing_file_url',
        details: 'Entity does not have file_url set',
      });
      continue;
    }

    result.withFileUrl++;

    // Check if R2 file exists
    const filePath = (entity as any).filePath;
    const exists = await r2.exists(filePath);

    if (!exists) {
      result.r2FilesMissing++;
      result.errors.push({
        entityId: entity.id,
        issue: 'r2_file_missing',
        details: `File not found in R2: ${filePath}`,
      });
      continue;
    }

    result.r2FilesExist++;

    // Verify checksum
    if ((entity as any).checksum) {
      try {
        const content = await r2.download(filePath);
        const actualChecksum = `sha256:${createHash('sha256').update(content).digest('base64')}`;

        if (actualChecksum === (entity as any).checksum) {
          result.checksumMatches++;
        } else {
          result.checksumMismatches++;
          result.errors.push({
            entityId: entity.id,
            issue: 'checksum_mismatch',
            details: `Expected: ${(entity as any).checksum}, Got: ${actualChecksum}`,
          });
        }
      } catch (error) {
        result.errors.push({
          entityId: entity.id,
          issue: 'checksum_verification_failed',
          details: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return result;
}

function printReport(result: VerificationResult): boolean {
  console.log('\n' + '='.repeat(60));
  console.log('📊 VERIFICATION REPORT');
  console.log('='.repeat(60));
  console.log(`📈 Total Entities: ${result.totalEntities}`);
  console.log(`✅ With File URL: ${result.withFileUrl}`);
  console.log(`❌ Missing File URL: ${result.missingFileUrl}`);
  console.log('');
  console.log(`✅ R2 Files Exist: ${result.r2FilesExist}`);
  console.log(`❌ R2 Files Missing: ${result.r2FilesMissing}`);
  console.log('');
  console.log(`✅ Checksum Matches: ${result.checksumMatches}`);
  console.log(`❌ Checksum Mismatches: ${result.checksumMismatches}`);
  console.log('');

  const isFullyMigrated = result.missingFileUrl === 0 && result.r2FilesMissing === 0;

  if (isFullyMigrated) {
    console.log('✅ MIGRATION COMPLETE!');
    console.log('   All entities have been migrated to R2.');
    console.log('   Safe to drop content_blocks table.');
  } else {
    console.log('❌ MIGRATION INCOMPLETE!');
    console.log(`   ${result.missingFileUrl} entities missing file_url`);
    console.log(`   ${result.r2FilesMissing} R2 files missing`);
    console.log('   DO NOT drop content_blocks table yet!');
  }

  if (result.errors.length > 0) {
    console.log('');
    console.log('🚨 ERRORS:');
    result.errors.forEach((error, index) => {
      console.log(`  ${index + 1}. [${error.entityId}] ${error.issue}`);
      if (error.details) {
        console.log(`     ${error.details}`);
      }
    });
  }

  console.log('='.repeat(60));
  console.log('');

  return isFullyMigrated;
}

// Run verification
verifyMigration()
  .then(result => {
    const success = printReport(result);
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error('💥 Verification failed:', error);
    process.exit(1);
  });

