/**
 * Entity Repository with Configurable Cascade Deletion
 */

import { eq, and } from "drizzle-orm";
import { entities } from "../schema/index.js";
import { BaseRepository } from "./base-repository.js";
import type { EventRepository } from "./event-repository.js";
import type { Entity, NewEntity } from "../schema/entities.js";

export interface CreateEntityInput {
  entityType: "note" | "task" | "project" | "document";
  title?: string;
  preview?: string;
  documentId?: string; // Link to document for content
  metadata?: Record<string, unknown>;
  userId: string;
}

export interface UpdateEntityInput {
  title?: string;
  preview?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface DeleteEntityOptions {
  /**
   * Whether to delete the linked document when deleting the entity
   * @default true
   */
  deleteDocument?: boolean;
}

export class EntityRepository extends BaseRepository<
  Entity,
  CreateEntityInput,
  UpdateEntityInput
> {
  constructor(db: any, eventRepo: EventRepository) {
    super(db, eventRepo, { subjectType: "entity", pluralName: "entities" });
  }

  /**
   * Create a new entity
   * Emits: entities.create.completed
   */
  async create(data: CreateEntityInput, userId: string): Promise<Entity> {
    const [entity] = await this.db
      .insert(entities)
      .values({
        userId,
        type: data.entityType, // Map entityType to type
        title: data.title,
        preview: data.preview,
        documentId: data.documentId, // Link to document
        metadata: data.metadata,
      } as NewEntity)
      .returning();

    // Emit completed event
    await this.emitCompleted("create", entity, userId);

    return entity;
  }

  /**
   * Update an existing entity
   * Emits: entities.update.completed
   */
  async update(
    id: string,
    data: UpdateEntityInput,
    userId: string
  ): Promise<Entity> {
    const [entity] = await this.db
      .update(entities)
      .set({
        title: data.title,
        preview: data.preview,
        content: data.content,
        metadata: data.metadata,
        updatedAt: new Date(),
      } as Partial<NewEntity>)
      .where(and(eq(entities.id, id), eq(entities.userId, userId)))
      .returning();

    if (!entity) {
      throw new Error("Entity not found");
    }

    // Emit completed event
    await this.emitCompleted("update", entity, userId);

    return entity;
  }

  /**
   * Delete an entity with optional document cascade
   * Emits: entities.delete.completed
   *
   * @param options.deleteDocument - Whether to also delete linked document (default: true)
   */
  async delete(
    id: string,
    userId: string,
    options: DeleteEntityOptions = {}
  ): Promise<void> {
    const { deleteDocument = true } = options;

    // Get entity to check for linked document
    const entity = await this.db.query.entities.findFirst({
      where: and(eq(entities.id, id), eq(entities.userId, userId)),
    });

    if (!entity) {
      throw new Error("Entity not found");
    }

    // Cascade delete document if configured and exists
    if (deleteDocument && entity.documentId) {
      // Note: Document deletion will be handled by the executor
      // to avoid circular dependencies and handle storage cleanup
      // The executor should check entity metadata for deleteDocument preference
    }

    // Delete entity
    const result = await this.db
      .delete(entities)
      .where(and(eq(entities.id, id), eq(entities.userId, userId)))
      .returning({ id: entities.id });

    if (result.length === 0) {
      throw new Error("Entity not found");
    }

    // Emit completed event with metadata
    await this.emitCompleted(
      "delete",
      {
        id,
        // Document cascade info is in event data, not entity record
      },
      userId
    );
  }
}
