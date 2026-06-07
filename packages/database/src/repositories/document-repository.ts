/**
 * Document Repository
 *
 * Handles all document CRUD operations with automatic event emission
 */

import { eq, and } from "drizzle-orm";
import { randomUUID } from "crypto";
import { documents, documentVersions } from "../schema/documents.js";
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
} from "../utils/document-version-storage.js";

export interface CreateDocumentInput {
  title: string;
  type: "text" | "markdown" | "code" | "pdf" | "docx";
  language?: string;
  storageUrl: string;
  storageKey: string;
  size: number;
  mimeType: string;
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
          lastSavedVersion: data.content !== undefined ? 1 : 0,
          // Provenance (Wave B3)
          createdByKind:
            data.createdByKind ?? (data.agentUserId ? "ai_agent" : "human"),
          createdByUserId: data.createdByUserId ?? userId,
          agentUserId: data.agentUserId,
          sourceProposalId: data.sourceProposalId,
          correlationId: data.correlationId,
        } as NewDocument)
        .returning();

      // Write the v1 immutable snapshot when content is supplied, so the
      // document has real version history from creation (storage holds current
      // content).
      if (data.content !== undefined) {
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
      .returning({ id: documents.id });

    if (result.length === 0) {
      throw new Error("Document not found");
    }

    // Emit completed event
    await this.emitCompleted("delete", { id }, userId);
  }
}
