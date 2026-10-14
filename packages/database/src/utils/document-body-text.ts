/**
 * The TEXT a document holds now — for search and other body readers.
 *
 * The canonical body is the markdown at `documents.storage_key`. The latest
 * `document_versions` row is only the last CHECKPOINT: a person's saves cut no
 * row (only an author switch does, see `claimDocumentRevision`), so a reader of
 * the version rows indexes stale text. And rows the realtime server wrote before
 * W4a hold `yjs:<base64>` editor state, which indexed as base64 noise.
 *
 * So: read the stored body. A body that is itself legacy Yjs state carries no
 * text to index and is left out. A FAILED read is reported per document in
 * `failed` — never folded into "no text" — so a caller can keep the previous
 * index entry instead of overwriting it with nothing.
 *
 * A LIBRARY item (`metadata.importItem`) is the exception: its stored body is
 * the raw it was kept as (a URL, a file's bytes), not text. Its text is what
 * the light read wrote beside it (`metadata.importRead.textKey`). Before the
 * light read there is no text — the item is found by its title only.
 */

import { inArray } from "drizzle-orm";
import { storage } from "@synap/storage";
import type { db as DbClient } from "../client-pg.js";
import { documents } from "../schema/documents.js";
import { documentVersionContentPreview } from "./document-version-storage.js";

/** The prefix the realtime server once stored Yjs state under. */
export const YJS_STATE_PREFIX = "yjs:";

export function isYjsStateText(text: string): boolean {
  return text.startsWith(YJS_STATE_PREFIX);
}

/** Where the light read stores a Library item's text (never over the item's own bytes). */
export function libraryReadTextKey(userId: string, itemId: string): string {
  return `library-read/${userId}/${itemId}.txt`;
}

/**
 * The storage key to read a document's TEXT from: the light read's text for a
 * Library item (none before the read), the stored body for anything else.
 */
export function documentTextStorageKey(row: {
  storageKey: string | null;
  metadata?: unknown;
}): string | null {
  const meta = row.metadata as
    | { importItem?: unknown; importRead?: { textKey?: unknown } }
    | null
    | undefined;
  if (meta && typeof meta === "object" && meta.importItem) {
    const key = meta.importRead?.textKey;
    return typeof key === "string" && key ? key : null;
  }
  return row.storageKey;
}

export interface DocumentBodyTexts {
  /** documentId → the stored body text (textual documents only, capped like a preview). */
  texts: Map<string, string>;
  /** documentId → why the stored body could not be read. */
  failed: Map<string, string>;
}

export interface DocumentBodyTextOptions {
  /**
   * Turns a MARKDOWN body into the prose it reads as (markdown-core
   * `markdownToPlainText`: embeds read as their fallback, props JSON and
   * directive syntax never indexed). Injected — this package does not depend
   * on the markdown spine — and required, so no reader indexes raw directives.
   */
  markdownText: (markdown: string) => string;
}

export async function loadDocumentBodyTexts(
  db: Pick<typeof DbClient, "select">,
  documentIds: string[],
  options: DocumentBodyTextOptions
): Promise<DocumentBodyTexts> {
  const texts = new Map<string, string>();
  const failed = new Map<string, string>();
  if (documentIds.length === 0) return { texts, failed };

  const rows = await db
    .select({
      id: documents.id,
      storageKey: documents.storageKey,
      mimeType: documents.mimeType,
      metadata: documents.metadata,
    })
    .from(documents)
    .where(inArray(documents.id, documentIds));

  await Promise.all(
    rows.map(async (row) => {
      const key = documentTextStorageKey(row);
      // An external reference (no stored bytes) — or a Library item not read
      // yet — has no body to index.
      if (!key) return;
      const mimeType = key === row.storageKey ? row.mimeType : "text/plain";
      let body: Buffer;
      try {
        body = await storage.downloadBuffer(key);
      } catch (err) {
        failed.set(row.id, err instanceof Error ? err.message : String(err));
        return;
      }
      const text = documentVersionContentPreview(body, mimeType);
      if (!text || isYjsStateText(text)) return;
      texts.set(
        row.id,
        (mimeType ?? "").includes("markdown")
          ? options.markdownText(text)
          : text
      );
    })
  );
  return { texts, failed };
}
