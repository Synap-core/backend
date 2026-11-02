/**
 * "Is this a filed document?": ONE answer for every read that lists or indexes
 * `documents` rows (`documents.list`, `documents.listInWorkspace`, the search
 * indexer).
 *
 * A `documents` row is not always a document someone filed. Four kinds of row
 * are something else's body, and showing them as documents lists the same
 * thing twice (a note under Documents AND under Things; a note found twice in
 * the palette):
 *   - an ENTITY's body            (`entities.document_id`)
 *   - a VIEW's body (whiteboard)  (`views.document_id`)
 *   - a SKILL's body              (`skills.body_document_id`)
 *   - an entity's picture         (`metadata.uploadKind = "media-copy"`)
 * and three are intake, not filing:
 *   - a staged import item        (`intakeSource.pending`)
 *   - a Library item              (`importItem`: it lives in the Library)
 *   - a raw capture               (`intakeSource`: it lives in `captures.list`)
 *
 * The lists and the index differ on exactly one thing: the index keeps Library
 * items (kept means findable, capture-vs-library decision 4) and raw captures
 * (a capture that was never structured is findable only by its own text). Both
 * are built from the same `notAnotherRowsBodyWhere`, so a body is never
 * listed or indexed as a document.
 */

import { and, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  notLibraryItemWhere,
  notStagedImportItemWhere,
  searchIndexableDocumentWhere,
} from "./import-staging.js";

/** `documents.metadata.intakeSource`: the key every staged intake input carries. */
export const INTAKE_SOURCE_KEY = "intakeSource";

/** `documents.metadata.uploadKind` of an entity's (or Library item's) picture copy. */
export const MEDIA_COPY_UPLOAD_KIND = "media-copy";

/** `metadata` is NOT a media copy. A row with no metadata (NULL) is kept. */
export function notMediaCopyDocumentWhere(metadataColumn: AnyPgColumn): SQL {
  return sql`(${metadataColumn} ->> 'uploadKind') IS DISTINCT FROM ${MEDIA_COPY_UPLOAD_KIND}`;
}

/**
 * No entity, view or skill holds this document as its body. Raw table names
 * (not the schema objects) so the predicate also runs against the tiny tables
 * a pglite test builds; the three columns are pinned by
 * `filed-document.pglite.test.ts` and by the migrations that created them.
 */
export function notOwnedDocumentWhere(documentIdColumn: AnyPgColumn): SQL {
  return sql`(NOT EXISTS (SELECT 1 FROM entities WHERE entities.document_id = ${documentIdColumn})
    AND NOT EXISTS (SELECT 1 FROM views WHERE views.document_id = ${documentIdColumn})
    AND NOT EXISTS (SELECT 1 FROM skills WHERE skills.body_document_id = ${documentIdColumn}))`;
}

/** `metadata` is NOT a raw intake source (a capture). A row with no metadata is kept. */
export function notIntakeSourceDocumentWhere(metadataColumn: AnyPgColumn): SQL {
  return sql`NOT COALESCE(${metadataColumn} ? ${INTAKE_SOURCE_KEY}, false)`;
}

export interface DocumentColumns {
  id: AnyPgColumn;
  metadata: AnyPgColumn;
}

/** Not another row's body or picture: the part the lists and the index share. */
export function notAnotherRowsBodyWhere(cols: DocumentColumns): SQL {
  return and(
    notMediaCopyDocumentWhere(cols.metadata),
    notOwnedDocumentWhere(cols.id)
  )!;
}

/** What a document LIST shows: the documents someone filed. */
export function filedDocumentWhere(cols: DocumentColumns): SQL {
  return and(
    notStagedImportItemWhere(cols.metadata),
    notLibraryItemWhere(cols.metadata),
    notIntakeSourceDocumentWhere(cols.metadata),
    notAnotherRowsBodyWhere(cols)
  )!;
}

/** What the search index holds of `documents`: filed documents, plus Library items and captures. */
export function indexableDocumentWhere(cols: DocumentColumns): SQL {
  return and(
    searchIndexableDocumentWhere(cols.metadata),
    notAnotherRowsBodyWhere(cols)
  )!;
}
