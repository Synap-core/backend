/**
 * Document Repository
 *
 * Handles all document CRUD operations with automatic event emission
 */

import { eq, and } from "drizzle-orm";
import { randomUUID } from "crypto";
import { documents, documentVersions } from "../schema/documents.js";
import { stampProvenance } from "../utils/stamp-provenance.js";
import { BaseRepository } from "./base-repository.js";
import type { EventRepository } from "./event-repository.js";
import type {
  Document,
  NewDocument,
  NewDocumentVersion,
} from "../schema/documents.js";
import {
  storedVersionValues,
  uploadDocumentVersionSnapshot,
  type StoredDocumentVersionSnapshot,
} from "../utils/document-version-storage.js";

export interface CreateDocumentInput {
  /**
   * Explicit document id. Optional — omit to let the DB default a random uuid.
   * Supplied by callers (e.g. EntityBodyService bytes-mode) that pre-uploaded a
   * version snapshot under a known id and need cleanup symmetry.
   */
  id?: string;
  title: string;
  type: "text" | "markdown" | "code" | "pdf" | "docx";
  language?: string;
  storageUrl: string;
  /**
   * Storage object key for the canonical current content. `null` for external
   * references (storageUrl points off-pod, no bytes stored) — matches the
   * nullable `documents.storage_key` column.
   */
  storageKey: string | null;
  size: number;
  /** `null` for external references — matches the nullable `documents.mime_type` column. */
  mimeType: string | null;
  projectId?: string;
  metadata?: Record<string, unknown>;
  userId: string;
  workspaceId?: string | null;
  /**
   * Full content at creation time. When provided, a v1 immutable snapshot is
   * written to `document_versions` so the document has real version history
   * from the start (the canonical current content still lives in storage).
   */
  content?: string;
  /**
   * Pre-uploaded v1 snapshot (bytes-mode). When set, the blob's version snapshot
   * has ALREADY been uploaded to storage by the caller (via
   * `uploadDocumentVersionSnapshot`); create() writes the v1 `document_versions`
   * row from these values WITHOUT re-uploading — killing the double-upload for
   * binary bodies. Mutually exclusive with `content` (takes precedence).
   */
  preUploadedVersion?: {
    versionId: string;
    snapshot: StoredDocumentVersionSnapshot;
    message?: string;
  };
  // Provenance (Wave B3) — who/what authored this row. Optional; defaults below.
  createdByKind?: "human" | "ai_agent" | "system";
  createdByUserId?: string;
  agentUserId?: string;
  sourceProposalId?: string;
  correlationId?: string;
}

export interface UpdateDocumentInput {
  title?: string;
  currentVersion?: number;
  size?: number;
  metadata?: Record<string, unknown>;
}

export class DocumentRepository extends BaseRepository<
  Document,
  CreateDocumentInput,
  UpdateDocumentInput
> {
  constructor(db: any, eventRepo: EventRepository) {
    super(db, eventRepo, { subjectType: "document" });
  }

  /**
   * Create a new document
   * Emits: documents.create.completed
   */
  async create(data: CreateDocumentInput, userId: string): Promise<Document> {
    // The documents row and its v1 snapshot must be written atomically — a row
    // with currentVersion=1 but no matching version is a corrupt document. Wrap
    // both inserts in one transaction. The completed event is emitted after the
    // commit so consumers never observe a half-written document.
    const document = await this.db.transaction(async (tx: any) => {
      const [doc] = await tx
        .insert(documents)
        .values({
          ...(data.id ? { id: data.id } : {}),
          userId,
          workspaceId: data.workspaceId,
          title: data.title,
          type: data.type,
          language: data.language,
          storageUrl: data.storageUrl,
          storageKey: data.storageKey,
          size: data.size,
          mimeType: data.mimeType,
          metadata: data.metadata,
          currentVersion: 1,
          lastSavedVersion:
            data.content !== undefined || data.preUploadedVersion ? 1 : 0,
          // Provenance (Wave B3)
          ...stampProvenance({
            userId: data.createdByUserId ?? userId,
            agentUserId: data.agentUserId,
            sourceProposalId: data.sourceProposalId,
            correlationId: data.correlationId,
            createdByKind: data.createdByKind,
          }),
        } as NewDocument)
        .returning();

      // Bytes-mode: the caller already uploaded the version snapshot — write the
      // v1 row from the supplied snapshot values, no re-upload.
      if (data.preUploadedVersion) {
        await tx.insert(documentVersions).values({
          id: data.preUploadedVersion.versionId,
          documentId: doc.id,
          version: 1,
          ...storedVersionValues(data.preUploadedVersion.snapshot),
          author: "user",
          authorId: userId,
          message: data.preUploadedVersion.message ?? "Initial version",
        } as NewDocumentVersion);
      } else if (data.content !== undefined) {
        const versionId = randomUUID();
        const snapshot = await uploadDocumentVersionSnapshot({
          userId,
          documentId: doc.id,
          versionId,
          documentType: data.type,
          mimeType: data.mimeType,
          content: data.content,
        });
        await tx.insert(documentVersions).values({
          id: versionId,
          documentId: doc.id,
          version: 1,
          ...storedVersionValues(snapshot),
          author: "user",
          authorId: userId,
          message: "Initial version",
        } as NewDocumentVersion);
      }

      return doc;
    });

    // Emit completed event
    await this.emitCompleted("create", document, userId);

    return document;
  }

  /**
   * Update an existing document
   * Emits: documents.update.completed
   */
  async update(
    id: string,
    data: UpdateDocumentInput,
    userId: string
  ): Promise<Document> {
    const [document] = await this.db
      .update(documents)
      .set({
        title: data.title,
        currentVersion: data.currentVersion,
        size: data.size,
        metadata: data.metadata,
        updatedAt: new Date(),
      } as Partial<NewDocument>)
      .where(and(eq(documents.id, id), eq(documents.userId, userId)))
      .returning();

    if (!document) {
      throw new Error("Document not found");
    }

    // Emit completed event
    await this.emitCompleted("update", document, userId);

    return document;
  }

  /**
   * Delete a document
   * Emits: documents.delete.completed
   *
   * NOTE: Storage cleanup is handled by the executor, not here
   */
  async delete(id: string, userId: string): Promise<void> {
    const result = await this.db
      .delete(documents)
      .where(and(eq(documents.id, id), eq(documents.userId, userId)))
      .returning({ id: documents.id, workspaceId: documents.workspaceId });

    if (result.length === 0) {
      throw new Error("Document not found");
    }

    // Emit completed event. Must carry workspaceId — the realtime bridge
    // drops workspace-scoped event types with no workspaceId in the payload.
    await this.emitCompleted(
      "delete",
      { id, workspaceId: result[0]!.workspaceId },
      userId
    );
  }
}
