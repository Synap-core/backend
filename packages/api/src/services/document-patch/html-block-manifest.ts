/**
 * The BLOCK MANIFEST of an HTML page, stamped on `documents.metadata.blocks`
 * for the revision it was read at — the same shape and rule as the
 * diagnostics stamp (`metadata.diagnostics`): written after every save by the
 * after-save reactor (`diagnostics-reactor.ts`, which hears every content
 * door's `document.create` / `document.update`), compare-and-set on
 * `content_revision`, so a stamp always describes the text it read. A reader
 * trusts it only at the current revision and current extractor
 * (`readStoredHtmlBlocks`); otherwise it re-derives from the content.
 */

import { and, db, documents, drizzleSql, eq } from "@synap/database";
import {
  HTML_BLOCK_EXTRACTOR,
  htmlBlockManifest,
  type HtmlBlock,
} from "./html-blocks.js";
import { readPatchDocumentContent } from "./apply-document-patch.js";

/** A page larger than this is not parsed for its manifest (the frame cap is 2 MB). */
const HTML_BLOCK_MANIFEST_MAX_CHARS = 2_000_000;

/** `documents.metadata.blocks`. */
export interface StoredHtmlBlockManifest {
  revision: number;
  extractor: number;
  items: HtmlBlock[];
}

/** The stamped manifest when it describes `revision` under the current extractor; else null. */
function readStoredHtmlBlocks(
  metadata: unknown,
  revision: number
): HtmlBlock[] | null {
  const b = (metadata as { blocks?: StoredHtmlBlockManifest } | null)?.blocks;
  return b &&
    Array.isArray(b.items) &&
    b.revision === revision &&
    b.extractor === HTML_BLOCK_EXTRACTOR
    ? b.items
    : null;
}

/**
 * Stamp the manifest of an html document's current content. Skips anything
 * that is not a stored html page, and a stamp that is already current.
 * `moved` = the content changed while it was read (the next save's reaction
 * stamps it). A failed read throws.
 */
export async function refreshHtmlBlockManifest(
  documentId: string
): Promise<"stamped" | "current" | "skipped" | "moved"> {
  const [doc] = await db
    .select({
      type: documents.type,
      storageKey: documents.storageKey,
      metadata: documents.metadata,
      contentRevision: documents.contentRevision,
    })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  if (!doc || doc.type !== "html" || !doc.storageKey) return "skipped";
  if (readStoredHtmlBlocks(doc.metadata, doc.contentRevision)) return "current";
  const content = await readPatchDocumentContent(doc);
  if (content.length > HTML_BLOCK_MANIFEST_MAX_CHARS) return "skipped";
  const stored: StoredHtmlBlockManifest = {
    revision: doc.contentRevision,
    extractor: HTML_BLOCK_EXTRACTOR,
    items: htmlBlockManifest(content),
  };
  const patch = JSON.stringify({ blocks: stored });
  const rows = await db
    .update(documents)
    .set({
      metadata: drizzleSql`COALESCE(${documents.metadata}, '{}'::jsonb) || ${patch}::jsonb`,
    })
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.contentRevision, doc.contentRevision)
      )
    )
    .returning({ id: documents.id });
  return rows.length > 0 ? "stamped" : "moved";
}
