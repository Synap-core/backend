/**
 * Write an APPROVED document — the one writer behind the `document/create`
 * approval executor and a connected plan's `create_document` step.
 *
 * An html page goes through the HTML page door (`createHtmlPage`).
 *
 * Extracted verbatim from `executors/document.ts` so the plan does not grow a
 * second copy of "upload the body, then `DocumentRepository.create`". A body
 * goes through the ONE create door (`createDocumentWithContent`); an external
 * reference through `DocumentRepository.create`. Both write the row (+ the
 * immutable v1 snapshot for a body) and emit `document.create.completed`.
 */

import {
  db,
  DocumentRepository,
  eventRepository,
  createDocumentWithContent,
  createHtmlPage,
  type CreateDocumentInput,
  normalizeDocumentType,
} from "@synap/database";
import type { DocumentScopeFields } from "../document-scope/document-scope.js";

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
  /** Scope / refresher (0387), already read through the floor by the caller. */
  fields?: DocumentScopeFields;
  /** The body's metadata (an html page's declared `reads`), already checked. */
  metadata?: Record<string, unknown>;
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
        ...input.fields,
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
  const provenance = {
    createdByKind: "human" as const,
    ...(input.sourceProposalId
      ? { sourceProposalId: input.sourceProposalId }
      : {}),
  };
  // An html page: the HTML page door, which checks it again (size cap,
  // declared reads) and stores its reads on `metadata.reads`.
  if (docType === "html") {
    const { reads, ...metadata } = input.metadata ?? {};
    await createHtmlPage(db, eventRepository, {
      id: input.documentId,
      ownerUserId: input.userId,
      workspaceId: input.workspaceId,
      title,
      content: input.content || "",
      reads,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      ...input.fields,
      provenance,
    });
    return { id: input.documentId };
  }
  const mimeType = docType === "code" ? "text/plain" : "text/markdown";
  // The ONE create door: fresh-key upload + row + v1 checkpoint. (The row's
  // mimeType is now the body's real type; it used to say text/markdown for an
  // html/code body, which the claim door then re-uploaded under.)
  await createDocumentWithContent(db, eventRepository, {
    id: input.documentId,
    ownerUserId: input.userId,
    workspaceId: input.workspaceId,
    title,
    type: docType,
    content: input.content || "",
    mimeType,
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...input.fields,
    provenance,
  });
  return { id: input.documentId };
}
