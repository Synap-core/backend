/**
 * Backfill Document Passages
 *
 * Enqueues a `document-passages` build for every live text document whose
 * passages were never built, through the one enqueue door
 * (`enqueueDocumentPassages`) the document reactor and the revision sweep
 * use. The worker owns reading, splitting, embedding and the write; this
 * script never talks to the IS.
 *
 * Run once per pod after the 0358 deploy (recall plan A-W2). A model change
 * later is the same script with `--all`: every passage embedded again,
 * planned, never a side effect of an edit.
 *
 * Cost: one IS embedding per passage (~2,000 chars ≈ 500 tokens at most);
 * the script prints the documents and stored body bytes it queued.
 *
 * Usage:
 *   pnpm --filter @synap/jobs index-passages            # never-built documents
 *   pnpm --filter @synap/jobs index-passages -- --all   # every passage again
 */

import { sql } from "@synap/database";
import {
  enqueueDocumentPassages,
  getBoss,
  startBoss,
  stopBoss,
} from "@synap/events";
import { PASSAGE_DOCUMENT_TYPES } from "../workers/document-passages.js";

async function indexDocumentPassages() {
  const reembed = process.argv.includes("--all");
  console.log(
    `🚀 Enqueueing passage builds for ${reembed ? "ALL live" : "never-built"} text documents...`
  );

  // Same set as the worker builds: live, text, not a Library item.
  const rows = (await sql`
    SELECT d.id, COALESCE(d.size, 0)::bigint AS size
    FROM documents d
    LEFT JOIN document_passage_state s ON s.document_id = d.id
    WHERE d.deleted_at IS NULL
      AND d.type = ANY(${[...PASSAGE_DOCUMENT_TYPES]})
      AND NOT (COALESCE(d.metadata, '{}'::jsonb) ? 'importItem')
      ${reembed ? sql`` : sql`AND s.document_id IS NULL`}
  `) as { id: string; size: string | number }[];

  const bytes = rows.reduce((n, r) => n + Number(r.size), 0);
  console.log(
    `📊 Found ${rows.length} documents to enqueue (${bytes} stored body bytes ≈ ${Math.ceil(bytes / 4)} tokens at most)`
  );

  await startBoss();
  const boss = getBoss();

  let enqueued = 0;
  for (const row of rows) {
    await enqueueDocumentPassages(
      { documentId: row.id, ...(reembed ? { reembed: true } : {}) },
      boss
    );
    enqueued++;
    if (enqueued % 200 === 0) {
      console.log(`✅ Enqueued ${enqueued}/${rows.length}`);
    }
  }

  console.log(`\n🎉 Enqueued ${enqueued} passage builds.`);
  console.log(
    "Watch progress: SELECT state, count(*) FROM pgboss.job WHERE name='document-passages' GROUP BY state;"
  );

  await stopBoss();
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  indexDocumentPassages()
    .then(() => {
      console.log("\n✨ Done!");
      process.exit(0);
    })
    .catch((error) => {
      console.error("\n💥 Fatal error:", error);
      process.exit(1);
    });
}

export { indexDocumentPassages };
