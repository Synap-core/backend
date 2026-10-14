/**
 * Which of an entity's copy documents still exist. A copy whose document was
 * deleted (or whose id is not even a document id) counts as not made: its URL
 * is owed again, and the record of it is pruned on the next run.
 */
import { db, and, inArray, isNull, documents } from "@synap/database";

const DOCUMENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function liveDocumentIds(ids: string[]): Promise<Set<string>> {
  const wellFormed = [...new Set(ids.filter((id) => DOCUMENT_ID.test(id)))];
  if (wellFormed.length === 0) return new Set();
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(inArray(documents.id, wellFormed), isNull(documents.deletedAt)));
  return new Set(rows.map((r) => r.id));
}
