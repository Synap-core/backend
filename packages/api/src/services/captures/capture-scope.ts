/**
 * Which documents are "my captures" — ONE definition shared by the captures
 * router (`list` / `get`) and `captures.structureAgain`, so the redo door can
 * never reach a row the caller's own capture reads would not.
 */

import {
  and,
  eq,
  isNull,
  drizzleSql,
  documents,
  notStagedImportItemWhere,
  notLibraryItemWhere,
} from "@synap/database";
import {
  INTAKE_SOURCE_METADATA_KEY,
  type IntakeSourceMetadata,
} from "../intake/stage-intake-source.js";

/**
 * The user capture kinds `captures.list` shows and `captures.structureAgain`
 * redoes. An allowlist, not a denylist: machine intake kinds added later (sync
 * records, run I/O) must never flood the list or be replayed as a capture.
 */
export const CAPTURE_LIST_KINDS = [
  "text",
  "url",
  "file",
  "import_item",
] as const satisfies ReadonlyArray<IntakeSourceMetadata["kind"]>;

/**
 * Own, live intake source documents. Read through `scopedDb` (the `documents`
 * VisibilityRule) and NARROWED to the caller: the rule lets a workspace member
 * see a colleague's documents, but "my captures" is the caller's own.
 *
 * A STAGED import item (`intakeSource.pending = "awaiting_curation"`) is not a
 * capture: nothing read it and nobody decided what it is, so it would only ever
 * read "Not structured".
 *
 * A LIBRARY item (anything staged with `importItem`) is never a capture, before
 * or after its group is built (CAPTURE_LIBRARY_PLAN decision 4): it is something
 * the person KEPT, not their words. It lives in the Library.
 */
export function ownCapturesWhere(userId: string) {
  return and(
    eq(documents.userId, userId),
    isNull(documents.deletedAt),
    drizzleSql`${documents.metadata} ? ${INTAKE_SOURCE_METADATA_KEY}`,
    notStagedImportItemWhere(documents.metadata),
    notLibraryItemWhere(documents.metadata)
  )!;
}
