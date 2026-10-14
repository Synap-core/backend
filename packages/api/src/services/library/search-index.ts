/**
 * The Library's search-index jobs — ONE helper so every door that changes
 * whether an item is findable (keep, delete, restore, discard, purge) queues
 * the same job. A failed enqueue is SAID (logged) and left to the periodic
 * full reindex; it never fails the person's action.
 */

import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "library/search-index" });

export async function enqueueLibrarySearch(
  operation: "upsert" | "delete",
  documentIds: readonly string[]
): Promise<void> {
  if (documentIds.length === 0) return;
  try {
    const { getBoss } = await import("@synap/jobs");
    const boss = getBoss();
    for (const documentId of documentIds) {
      await boss.send("search-index", {
        collection: "documents",
        operation,
        documentId,
        timestamp: Date.now(),
      });
    }
  } catch (err) {
    logger.warn(
      { err, operation, count: documentIds.length },
      "library: search-index enqueue FAILED — the next full reindex corrects it"
    );
  }
}
