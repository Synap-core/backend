/**
 * The AFTER-SAVE diagnostics reactor: when a document's content changes by any
 * door (a person's autosave, a restore, an approval, a patch), re-check what
 * will not render and stamp it on `documents.metadata.diagnostics` for the
 * revision it checked. For an html page it also stamps the block manifest
 * (`metadata.blocks`, `html-block-manifest.ts`).
 *
 * A reactor, not a line in each save door, for the reason
 * `closing-report-reactor.ts` gives: every content door already emits
 * `document.update` / `document.create`, and a reaction registered off it
 * cannot be forgotten by the next door. It runs off the save's request path,
 * so a keystroke never waits for it.
 *
 * Idempotent by the stamp: a document whose stored diagnostics already describe
 * its current revision under the current checker (the patch door stamps its
 * own) is skipped; a stamp from an older checker is re-stamped, keeping its
 * run-time items (content cannot re-derive them). A check that
 * cannot run stamps NOTHING — readers then see "not checked" (the read door
 * re-checks live), never an empty list that claims the document is clean.
 */

import { createLogger } from "@synap-core/core";
import { db, eq, documents } from "@synap/database";
import { registerReactor, type Reactor } from "@synap/events";
import {
  diagnoseForDocument,
  readPatchDocumentContent,
  readStoredDiagnostics,
  storeDocumentDiagnostics,
  storedRunTimeDiagnostics,
} from "./apply-document-patch.js";
import { readsAsMarkdown } from "./read-document.js";
import { refreshHtmlBlockManifest } from "./html-block-manifest.js";

const logger = createLogger({ module: "document-diagnostics-reactor" });

export async function refreshDocumentDiagnostics(
  documentId: string
): Promise<"stamped" | "current" | "skipped" | "moved" | "failed"> {
  const [doc] = await db
    .select({
      id: documents.id,
      userId: documents.userId,
      workspaceId: documents.workspaceId,
      type: documents.type,
      mimeType: documents.mimeType,
      storageKey: documents.storageKey,
      metadata: documents.metadata,
      contentRevision: documents.contentRevision,
    })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  // The one read rule (`readsAsMarkdown`, the agent read's): only a markdown
  // or text body is checked; a stored file is never downloaded for it, and
  // a body over the cap is never parsed. The parse runs on the pod's thread:
  // on 3 Nov 2026 a 126 MB video parsed for 60-110 s and froze the pod.
  if (!doc || !doc.storageKey || !readsAsMarkdown(doc, "")) return "skipped";
  if (readStoredDiagnostics(doc.metadata, doc.contentRevision))
    return "current";
  const content = await readPatchDocumentContent(doc);
  if (!readsAsMarkdown(doc, content)) return "skipped";
  // Judged as the document's owner would write it: the leak floor is the
  // owner's, the readers' lens is the document's own workspace.
  const outcome = await diagnoseForDocument(content, doc, doc.userId);
  if (!outcome.items) return "failed";
  return (await storeDocumentDiagnostics(doc.id, doc.contentRevision, [
    ...outcome.items,
    ...storedRunTimeDiagnostics(doc.metadata, doc.contentRevision),
  ]))
    ? "stamped"
    : "moved";
}

export const documentDiagnosticsReactor: Reactor = {
  id: "document-diagnostics",
  match: (payload) =>
    payload.subjectType === "document" &&
    (payload.action === "update" || payload.action === "create"),
  async handler(payload) {
    const documentId =
      (payload.data?.id as string | undefined) ?? payload.subjectId;
    if (!documentId) return;
    try {
      const outcome = await refreshDocumentDiagnostics(documentId);
      if (outcome === "failed") {
        logger.warn(
          { documentId },
          "document diagnostics could not run after a save"
        );
      }
    } catch (error) {
      logger.error(
        { error, documentId },
        "document diagnostics reactor failed — the document keeps no stamp for this revision"
      );
    }
    // An html page's block manifest (`metadata.blocks`), stamped the same way:
    // its own step, so a failed manifest never costs the diagnostics stamp.
    try {
      await refreshHtmlBlockManifest(documentId);
    } catch (error) {
      logger.error(
        { error, documentId },
        "html block manifest could not be stamped — readers re-derive it from the content"
      );
    }
  },
};

let registered = false;

/** Register the reactor. Called once at API boot (`apps/api/src/index.ts`). */
export function registerDocumentDiagnosticsReactor(): void {
  if (registered) return;
  registered = true;
  registerReactor(documentDiagnosticsReactor);
  logger.info("Registered document diagnostics reactor");
}
