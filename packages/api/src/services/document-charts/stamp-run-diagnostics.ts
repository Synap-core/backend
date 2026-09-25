/**
 * Stamp RUN-TIME diagnostics on a document — what a flow learned while writing
 * it that its content cannot say (today: `freeze_failed`, a report chart the
 * freeze step had to leave live).
 *
 * ONE store: W4b's `documents.metadata.diagnostics {revision, checkedAt, items}`,
 * through its own writer (`storeDocumentDiagnostics`). The stamp must describe
 * the WHOLE document at that revision, so the content diagnostics are re-run
 * (`diagnoseForDocument`, as the owner) and the run-time items are added to
 * them. Revision-bound, like every stamp: written only while the document is
 * still at the revision the flow created, and replaced by the after-save
 * reactor at the next revision (the chart is then simply live).
 *
 * Never a false "checked": a content check that could not run stamps NOTHING.
 */

import { TRPCError } from "@trpc/server";
import {
  diagnoseForDocument,
  loadPatchDocument,
  readPatchDocumentContent,
  storeDocumentDiagnostics,
} from "../document-patch/apply-document-patch.js";
import type { DocumentDiagnostic } from "../document-patch/document-diagnostics.js";

/** Codes a flow may stamp — run-time facts only; content codes are derived, never asserted. */
export const RUN_TIME_DIAGNOSTIC_CODES = ["freeze_failed"] as const;

export type StampRunDiagnosticsResult =
  | { status: "stamped"; documentId: string; revision: number; items: number }
  | { status: "nothing_to_stamp" | "no_document"; reason: string }
  | { status: "moved"; documentId: string; reason: string }
  | { status: "not_checked"; documentId: string; reason: string };

export async function stampRunDiagnostics(input: {
  documentId?: string | null;
  items: DocumentDiagnostic[];
  actingUserId: string;
}): Promise<StampRunDiagnosticsResult> {
  if (input.items.length === 0) {
    return {
      status: "nothing_to_stamp",
      reason: "No run-time diagnostics to record.",
    };
  }
  if (!input.documentId) {
    // e.g. the report was PROPOSED (an agent-owned run): no document exists yet.
    return {
      status: "no_document",
      reason: "No document was created to record these on.",
    };
  }
  const doc = await loadPatchDocument(input.documentId);
  // Only the document's owner (the run that created it) may annotate it.
  if (doc.userId !== input.actingUserId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Only the document's owner can record run-time diagnostics on it.",
    });
  }
  const content = await readPatchDocumentContent(doc);
  const outcome = await diagnoseForDocument(content, doc, doc.userId);
  if (!outcome.items) {
    return { status: "not_checked", documentId: doc.id, reason: outcome.error };
  }
  const items = [...outcome.items, ...input.items];
  const stored = await storeDocumentDiagnostics(
    doc.id,
    doc.contentRevision,
    items
  );
  return stored
    ? {
        status: "stamped",
        documentId: doc.id,
        revision: doc.contentRevision,
        items: items.length,
      }
    : {
        status: "moved",
        documentId: doc.id,
        reason:
          "The document changed before the stamp; its diagnostics are re-checked for the new text.",
      };
}
