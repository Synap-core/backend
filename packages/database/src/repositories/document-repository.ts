/**
 * Document Repository
 *
 * Handles all document CRUD operations with automatic event emission
 */

import { eq, and } from "drizzle-orm";
import { documents } from "../schema/documents.js";
import { BaseRepository } from "./base-repository.js";
import type { EventRepository } from "./event-repository.js";
import type { Document, NewDocument } from "../schema/documents.js";

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
    const [document] = await this.db
      .insert(documents)
      .values({
        userId,
        title: data.title,
        type: data.type,
        language: data.language,
        storageUrl: data.storageUrl,
        storageKey: data.storageKey,
        size: data.size,
        mimeType: data.mimeType,
        projectId: data.projectId,
        metadata: data.metadata,
        currentVersion: 1,
      } as NewDocument)
      .returning();

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
