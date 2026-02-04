/**
 * Backfill Entity Profiles Migration Script
 *
 * Migrates existing entities to use profiles based on their type.
 * This script is idempotent - safe to run multiple times.
 */

import postgres from "postgres";
import { getDb } from "../dist/client-pg.js";
import { ProfileRepository, entities, eq, sql } from "../dist/index.js";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("❌ ERROR: DATABASE_URL environment variable is required");
  process.exit(1);
}

const postgresClient = postgres(databaseUrl, { max: 1 });

async function backfillEntityProfiles() {
  console.log("🔄 Backfilling entity profiles...\n");

  const db = await getDb();
  const profileRepo = new ProfileRepository(db);

  try {
    // 1. Get all system profiles
    const systemProfiles = await db.query.profiles.findMany({
      where: eq(sql`scope`, "system"),
    });

    const profileMap = new Map<string, string>();
    for (const profile of systemProfiles) {
      profileMap.set(profile.slug, profile.id);
    }

    console.log(`📋 Found ${systemProfiles.length} system profiles:`);
    systemProfiles.forEach((p) => {
      console.log(`  - ${p.slug} (${p.id})`);
    });
    console.log("");

    // 2. Get all entities without profile_id
    const entitiesWithoutProfile = await db.query.entities.findMany({
      where: eq(sql`profile_id`, null),
    });

    console.log(
      `📊 Found ${entitiesWithoutProfile.length} entities without profile_id\n`
    );

    if (entitiesWithoutProfile.length === 0) {
      console.log("✅ All entities already have profiles assigned\n");
      return;
    }

    // 3. Update entities with matching profiles
    let updated = 0;
    let skipped = 0;

    for (const entity of entitiesWithoutProfile) {
      const profileId = profileMap.get(entity.type);

      if (profileId) {
        await db
          .update(entities)
          .set({ profileId })
          .where(eq(entities.id, entity.id));

        updated++;
        if (updated % 100 === 0) {
          console.log(`  ✓ Updated ${updated} entities...`);
        }
      } else {
        skipped++;
        console.log(
          `  ⚠️  Skipped entity ${entity.id} (type: ${entity.type}) - no matching profile`
        );
      }
    }

    console.log(`\n✅ Backfill complete:`);
    console.log(`  - Updated: ${updated} entities`);
    console.log(`  - Skipped: ${skipped} entities (no matching profile)\n`);
  } catch (error) {
    console.error("❌ Error backfilling entity profiles:", error);
    throw error;
  } finally {
    await postgresClient.end();
  }
}

backfillEntityProfiles()
  .then(() => {
    console.log("✅ Backfill script completed successfully");
    process.exit(0);
  })
  .catch((error) => {
    console.error("❌ Backfill script failed:", error);
    process.exit(1);
  });
