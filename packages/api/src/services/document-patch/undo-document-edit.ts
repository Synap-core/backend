/**
 * Undo ONE applied document patch — the impure half of `document-edit-undo.ts`.
 *
 * Reads the document as it is NOW, puts back each recorded part that still
 * holds what the edit wrote (`planDocumentEditUndo`), and writes the result
 * as a NEW revision through the one content door (`writePatch` →
 * `claimDocumentRevision`), authored by the person undoing, compare-and-set on
 * the revision just read. Parts edited since are left alone and returned as
 * skips with why. A write that lands between the read and the claim makes the
 * claim refuse: nothing is undone, and the caller is told to try again.
 *
 * Never a version restore: the previous version would also wipe every edit
 * made after this one (decision 6c5e9642).
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  eq,
  documents,
  DocumentRevisionConflictError,
} from "@synap/database";
import { loadEditableDocument } from "../../utils/document-edit-access.js";
import {
  diagnoseForDocument,
  loadPatchDocument,
  readPatchDocumentContent,
  writePatch,
} from "./apply-document-patch.js";
import {
  planDocumentEditUndo,
  type DocumentEditRecord,
  type DocumentEditSkip,
} from "./document-edit-undo.js";

export interface DocumentEditUndoResult {
  /** Parts put back (sections, the body, the name). */
  restored: number;
  skipped: DocumentEditSkip[];
}

export async function undoDocumentEdit(args: {
  edit: DocumentEditRecord;
  /** The person undoing — the author of the new revision. */
  userId: string;
}): Promise<DocumentEditUndoResult> {
  const { edit, userId } = args;
  const [row] = await db
    .select({ deletedAt: documents.deletedAt })
    .from(documents)
    .where(eq(documents.id, edit.documentId))
    .limit(1);
  if (!row || row.deletedAt) {
    return {
      restored: 0,
      skipped: [
        {
          target: {
            kind: "document_section",
            documentId: edit.documentId,
            sectionId: null,
            title: null,
          },
          reason: "not_found",
          detail: "the document no longer exists",
        },
      ],
    };
  }
  // The person undoing must be able to edit the document: Undo writes it.
  await loadEditableDocument(userId, edit.documentId);
  const doc = await loadPatchDocument(edit.documentId);
  const current = await readPatchDocumentContent(doc);
  const plan = planDocumentEditUndo(
    { content: current, title: doc.title },
    edit
  );
  if (plan.restored === 0) return { restored: 0, skipped: plan.skipped };

  try {
    await writePatch({
      doc,
      base: { revision: doc.contentRevision },
      baseContent: current,
      newContent: plan.content,
      author: { kind: "user", id: userId },
      message: "Edit undone",
      diagnostics: await diagnoseForDocument(plan.content, doc, userId),
      rename: plan.rename,
    });
  } catch (err) {
    if (err instanceof DocumentRevisionConflictError) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "The document changed while the edit was being undone. Nothing was undone — try again.",
      });
    }
    throw err;
  }
  return { restored: plan.restored, skipped: plan.skipped };
}
