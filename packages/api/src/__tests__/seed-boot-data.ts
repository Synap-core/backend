import {
  db,
  drizzleSql,
  ensureDefaultRelationDefs,
  ensureSystemProfiles,
} from "@synap/database";

/**
 * Seed what a pod's BOOT seeds, for a live-Postgres test: the core kinds
 * (`ensureSystemProfiles`, apps/api startup-hooks.ts) and the pod-wide relation
 * types (`ensureDefaultRelationDefs(null, "system")`, jobs workers/index.ts).
 * CI's database is migrations-only, so a test that needs `note` or `relates_to`
 * must seed them itself, not count on another file having done it.
 *
 * Boot runs the seeders in ONE process; test files run in parallel workers, and
 * concurrent seeders race on their unique indexes. A transaction-scoped
 * advisory lock serializes them across workers; the seeders are idempotent, so
 * every caller after the first finds the rows and writes nothing.
 *
 * A seeder that reports `error` throws with its message: a failed seed is not
 * a seeded database.
 */
export async function seedBootData(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(hashtext('synap-test-seed-boot-data'))`
    );
    const profiles = await ensureSystemProfiles();
    if (profiles.status === "error") {
      throw new Error(`ensureSystemProfiles failed: ${profiles.message}`);
    }
    const relationDefs = await ensureDefaultRelationDefs(null, "system");
    if (relationDefs.status === "error") {
      throw new Error(
        `ensureDefaultRelationDefs failed: ${relationDefs.message}`
      );
    }
  });
}
