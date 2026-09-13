/**
 * Write an APPROVED document — the one writer behind the `document/create`
 * approval executor and a connected plan's `create_document` step.
 *
 * Extracted verbatim from `executors/document.ts` so the plan does not grow a
 * second copy of "upload the body, then `DocumentRepository.create`". Both
 * branches route through the ONE document door (`DocumentRepository.create`),
 * which writes the row + the immutable v1 snapshot and emits
 * `document.create.completed`.
 */

import {
  db,
  DocumentRepository,
  eventRepository,
  type CreateDocumentInput,
  normalizeDocumentType,
} from "@synap/database";
import { storage } from "@synap/storage";

export async function materializeApprovedDocument(input: {
  /** The id the row is written with (a proposal's targetId, or a fresh one). */
  documentId: string;
  title: string;
  type?: string;
  content?: string;
  /** External reference: no bytes, storageKey NULL. */
  url?: string | null;
  userId: string;
  workspaceId: string | null;
  /** Lineage — null when no proposal row exists to point at (FK). */
  sourceProposalId: string | null;
}): Promise<{ id: string }> {
  const docRepo = new DocumentRepository(db, eventRepository);
  const title = input.title || "Untitled";

  // External URL reference: no bytes to store. Mirror the auto-approved
  // external branch in documents.ts (storageUrl = url, storageKey = NULL,
  // metadata.external = true) — skip the MinIO upload + version snapshot.
  if (typeof input.url === "string" && input.url) {
    await docRepo.create(
      {
        id: input.documentId,
        title,
        type: normalizeDocumentType(
          input.type || "markdown",
          "markdown"
        ) as CreateDocumentInput["type"],
        storageUrl: input.url,
        storageKey: null,
        size: 0,
        mimeType: null,
        metadata: { external: true },
        userId: input.userId,
        workspaceId: input.workspaceId,
        ...(input.sourceProposalId
          ? { sourceProposalId: input.sourceProposalId }
          : {}),
      },
      input.userId
    );
    return { id: input.documentId };
  }

  const docType = normalizeDocumentType(input.type || "markdown", "markdown");
  const extension = docType === "markdown" ? "md" : docType;
  const content = input.content || "";
  const storageKey = storage.buildPath(
    input.userId,
    "document",
    input.documentId,
    extension
  );
  const mimeType =
    docType === "html"
      ? "text/html"
      : docType === "code"
        ? "text/plain"
        : "text/markdown";
  const metadata = await storage.upload(storageKey, content, {
    contentType: mimeType,
  });

  // ONE door: create() writes the row + the immutable v1 snapshot atomically.
  // The row's mimeType stays "text/markdown" exactly as the prior raw insert
  // (the computed `mimeType` above is only the storage content-type).
  await docRepo.create(
    {
      id: input.documentId,
      title,
      type: docType as CreateDocumentInput["type"],
      storageUrl: metadata.url,
      storageKey: metadata.path,
      size: metadata.size,
      mimeType: "text/markdown",
      userId: input.userId,
      workspaceId: input.workspaceId,
      content, // → writes the v1 document_versions snapshot
      ...(input.sourceProposalId
        ? { sourceProposalId: input.sourceProposalId }
        : {}),
    },
    input.userId
  );
  return { id: input.documentId };
}
