/**
 * Backfill — documents whose latest checkpoint row holds `yjs:` editor state.
 *
 * Documents-centerpiece W4a. Before W4a the realtime server wrote the Yjs state
 * of an open document (`yjs:<base64>`) INTO the current `document_versions`
 * row, and cut a `yjs:` row on every room close. The history rail, version
 * previews, search, embeddings and retrieval all read those rows, so they saw
 * base64 instead of text. W4a stops the writes (Yjs is now a cache in
 * `documents.working_state`); this script repairs what they left behind.
 *
 * For every document whose LATEST version row starts with `yjs:`:
 *   - stored body is markdown (the usual case: autosave kept writing it) →
 *     cut ONE checkpoint of that markdown through `claimDocumentRevision`, the
 *     one content-write door, attributed to `system/w4a-backfill`. The rail's
 *     latest row then holds text again. Nothing is deleted: the old `yjs:` rows
 *     stay in history (restore already refuses them).
 *   - stored body is itself `yjs:` state (an old restore wrote it there) → NOT
 *     repairable here: turning Yjs state into markdown needs the editor schema,
 *     which lives in the client. Reported only; the realtime room loads such a
 *     body so the next collaborative session writes markdown back.
 *   - stored body unreadable → reported, untouched.
 *
 * DRY RUN BY DEFAULT. Idempotent: once a document's latest row is markdown it
 * no longer matches. Do NOT run against production without an operator.
 *
 *   DATABASE_URL=… tsx packages/database/src/scripts/backfill-yjs-version-rows.ts
 *   DATABASE_URL=… tsx packages/database/src/scripts/backfill-yjs-version-rows.ts --apply
 */

import { sql } from "drizzle-orm";
import { storage } from "@synap/storage";
import { db } from "../client-pg.js";
import { claimDocumentRevision } from "../utils/claim-document-revision.js";
import { isYjsStateText } from "../utils/document-body-text.js";

const apply = process.argv.slice(2).includes("--apply");

interface Candidate {
  id: string;
  storage_key: string | null;
  latest_version: number;
}

async function main(): Promise<void> {
  console.log(
    `Backfill: yjs: checkpoint rows — ${apply ? "APPLY" : "DRY RUN (no writes)"}\n`
  );

  const result = await db.execute(sql`
    SELECT d.id, d.storage_key, lv.version AS latest_version
    FROM documents d
    JOIN LATERAL (
      SELECT v.version, v.content
      FROM document_versions v
      WHERE v.document_id = d.id
      ORDER BY v.version DESC, v.created_at DESC
      LIMIT 1
    ) lv ON true
    WHERE lv.content LIKE 'yjs:%'
  `);
  // postgres-js: db.execute returns a RowList (array-like) of result rows.
  const candidates = [...(result as unknown as Candidate[])];

  let resnapshot = 0;
  const bodyIsYjs: string[] = [];
  const unreadable: Array<{ id: string; error: string }> = [];
  const noBody: string[] = [];

  for (const doc of candidates) {
    if (!doc.storage_key) {
      noBody.push(doc.id);
      continue;
    }
    let body: string;
    try {
      body = (await storage.downloadBuffer(doc.storage_key)).toString("utf-8");
    } catch (err) {
      unreadable.push({
        id: doc.id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (isYjsStateText(body)) {
      bodyIsYjs.push(doc.id);
      continue;
    }
    resnapshot += 1;
    if (!apply) {
      console.log(
        `  would re-snapshot ${doc.id} (latest row v${doc.latest_version} is yjs:)`
      );
      continue;
    }
    const claimed = await db.transaction((tx) =>
      claimDocumentRevision(
        tx,
        doc.id,
        undefined,
        { authorKind: "system", authorId: "w4a-backfill" },
        {
          checkpoint: {
            message:
              "Re-snapshot of the text (the previous row held editor state)",
          },
        }
      )
    );
    console.log(`  re-snapshotted ${doc.id} → v${claimed.currentVersion}`);
  }

  console.log(`\nCandidates: ${candidates.length}`);
  console.log(
    `  ${apply ? "re-snapshotted" : "to re-snapshot"}: ${resnapshot}`
  );
  console.log(
    `  body is yjs: state (client write-back needed): ${bodyIsYjs.length}`
  );
  for (const id of bodyIsYjs) console.log(`    ${id}`);
  console.log(`  unreadable body (untouched): ${unreadable.length}`);
  for (const u of unreadable) console.log(`    ${u.id}: ${u.error}`);
  console.log(`  no stored body (reference): ${noBody.length}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  });
