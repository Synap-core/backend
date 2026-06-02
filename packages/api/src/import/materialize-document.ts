/**
 * Content → versioned document materializer.
 *
 * Single shared path for turning a blob of long-form markdown into a REAL
 * versioned document: uploads the content to storage (MinIO), creates a
 * `documents` row (storageUrl/storageKey/currentVersion) plus a
 * `document_versions` v1 snapshot, indexes it into Typesense, and returns the
 * new document id so the caller can link it via `entity.documentId`.
 *
 * Factored out of `entities.create` so the capture pipeline and the import
 * pipeline materialize documents exactly the same way (one definition of "make
 * this content a document"). Pure orchestration — no entity creation here; the
 * caller owns the entity so it can set documentId.
 */

import { DocumentRepository, type EventRepository } from "@synap/database";
import { emitSideEffects } from "@synap/events";
import { randomUUID } from "crypto";

export interface MaterializeContentDocumentInput {
  /** Long-form markdown body to persist as the document's content. */
  content: string;
  /** Document title. */
  title?: string;
  userId: string;
  /** Pass null for pod-wide documents. */
  workspaceId?: string | null;
  /** Drizzle db handle (from getDb()). */
  db: unknown;
  /** Event repository for document create event emission. */
  eventRepo: EventRepository;
}

/**
 * Materialize long-form content into a versioned document.
 * Returns the created document's id.
 */
export async function materializeContentDocument(
  input: MaterializeContentDocumentInput
): Promise<string> {
  const { content, title, userId, workspaceId, db, eventRepo } = input;

  const { storage } = await import("@synap/storage");

  const key = storage.buildPath(userId, "entity", randomUUID(), "md");
  const metadata = await storage.upload(key, content, {
    contentType: "text/markdown",
  });

  const docRepo = new DocumentRepository(db, eventRepo);
  const createdDocument = await docRepo.create(
    {
      title: title || "Untitled",
      type: "markdown",
      storageUrl: metadata.url,
      storageKey: metadata.path,
      size: metadata.size,
      mimeType: "text/markdown",
      userId,
      workspaceId: workspaceId ?? undefined,
      content,
    },
    userId
  );

  // Index into Typesense (documents collection) via the standard side-effect.
  // Fire-and-forget — indexing failure never blocks document creation.
  emitSideEffects({
    subjectType: "document",
    action: "create",
    subjectId: createdDocument.id,
    userId,
    workspaceId: workspaceId ?? undefined,
  }).catch(() => {});

  return createdDocument.id;
}
