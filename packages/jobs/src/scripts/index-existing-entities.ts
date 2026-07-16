/**
 * Backfill Entity Embeddings
 *
 * Enqueues an `entity-embedding` job for every live entity that has no row
 * in `entity_vectors`, through the canonical pg-boss queue — the same one
 * door the per-entity CRUD reactors use. The worker owns text building
 * (title + preview + properties + facets), the IS call, and the upsert;
 * this script never talks to the IS directly.
 *
 * Recovery tool for provider outages: failed pg-boss jobs exhaust their
 * retries and never self-heal, so re-running this after the embedding
 * provider is restored re-enqueues exactly the entities left vector-less.
 *
 * Usage:
 *   pnpm --filter @synap/jobs index-entities            # only vector-less entities
 *   pnpm --filter @synap/jobs index-entities -- --all   # re-embed everything
 */

import { sql } from "@synap/database";
import { getBoss, startBoss, stopBoss } from "@synap/events";

async function indexExistingEntities() {
  const reembedAll = process.argv.includes("--all");
  console.log(
    `🚀 Enqueueing embedding jobs for ${reembedAll ? "ALL live" : "vector-less"} entities...`
  );

  const rows = (await sql`
    SELECT e.id, e.user_id
    FROM entities e
    LEFT JOIN entity_vectors ev ON ev.entity_id = e.id
    WHERE e.deleted_at IS NULL
      ${reembedAll ? sql`` : sql`AND ev.entity_id IS NULL`}
  `) as { id: string; user_id: string }[];

  console.log(`📊 Found ${rows.length} entities to enqueue`);

  await startBoss();
  const boss = getBoss();

  let enqueued = 0;
  for (const row of rows) {
    await boss.send(
      "entity-embedding",
      { entityId: row.id, userId: row.user_id },
      // Same per-entity debounce as the CRUD reactors, so a backfill that
      // overlaps live traffic can't double-enqueue the same row.
      {
        singletonKey: `entity-embedding:${row.id}`,
        singletonSeconds: 30,
      }
    );
    enqueued++;
    if (enqueued % 200 === 0) {
      console.log(`✅ Enqueued ${enqueued}/${rows.length}`);
    }
  }

  console.log(`\n🎉 Enqueued ${enqueued} embedding jobs.`);
  console.log(
    "Watch progress: SELECT state, count(*) FROM pgboss.job WHERE name='entity-embedding' GROUP BY state;"
  );

  await stopBoss();
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  indexExistingEntities()
    .then(() => {
      console.log("\n✨ Done!");
      process.exit(0);
    })
    .catch((error) => {
      console.error("\n💥 Fatal error:", error);
      process.exit(1);
    });
}

export { indexExistingEntities };
