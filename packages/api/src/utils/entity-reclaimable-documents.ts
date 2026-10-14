/**
 * Every `documents` row a HARD-deleted entity takes with it: its body and
 * source-file documents (`ownedDocumentIds`, beside their writer) AND the
 * pod-held media copies it records (`systemData.media[].documentId`, written
 * by the media copy). Without the media leg every copied cover/avatar outlived
 * its entity — an object and a row nothing lists or reclaims.
 *
 * Owner lock on the media leg: `systemData` is reachable from writers, so a
 * listed document is reclaimed only when the ENTITY's owner owns it (the media
 * copy stores under the owner). Deleting your own entity never deletes
 * someone else's document because you listed it.
 */
import { and, eq, inArray, documents } from "@synap/database";
import type { getDb } from "@synap/database";
import { readEntityMediaCopies } from "@synap-core/types/presentation";
import { ownedDocumentIds } from "./store-entity-source-blob.js";

type Database = Awaited<ReturnType<typeof getDb>>;

export async function reclaimableDocumentIds(
  database: Database,
  row: {
    userId: string;
    documentId?: string | null;
    properties?: unknown;
    systemData?: unknown;
  }
): Promise<string[]> {
  const ids = new Set(ownedDocumentIds(row));
  const media = readEntityMediaCopies(row.systemData)
    .map((m) => m.documentId)
    .filter((id) => !ids.has(id));
  if (media.length > 0) {
    const owned = await database
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(inArray(documents.id, media), eq(documents.userId, row.userId))
      );
    for (const d of owned) ids.add(d.id);
  }
  return [...ids];
}
