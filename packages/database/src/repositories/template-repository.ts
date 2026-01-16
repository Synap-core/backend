/**
 * Template Repository
 *
 * Handles all entity template CRUD operations with automatic event emission
 */

import { eq, and } from "drizzle-orm";
import { entityTemplates } from "../schema/entity-templates.js";
import { BaseRepository } from "./base-repository.js";
import type { EventRepository } from "./event-repository.js";
import type {
  EntityTemplate,
  NewEntityTemplate,
} from "../schema/entity-templates.js";

export interface CreateTemplateInput {
  id?: string;
  name: string;
  description?: string;
  targetType: "entity" | "document" | "project" | "inbox_item";
  entityType?: string;
  inboxItemType?: string;
  config?: Record<string, unknown>;
  isDefault?: boolean;
  isPublic?: boolean;
  userId?: string;
  workspaceId?: string;
}

export interface UpdateTemplateInput {
  name?: string;
  description?: string;
  config?: Record<string, unknown>;
  isDefault?: boolean;
  isPublic?: boolean;
}

export class TemplateRepository extends BaseRepository<
  EntityTemplate,
  CreateTemplateInput,
  UpdateTemplateInput
> {
  constructor(db: any, eventRepo: EventRepository) {
    super(db, eventRepo, { subjectType: "template", pluralName: "templates" });
  }

  /**
   * Create a new entity template
   * Emits: templates.create.completed
   */
  async create(
    data: CreateTemplateInput,
    userId: string
  ): Promise<EntityTemplate> {
    const [template] = await this.db
      .insert(entityTemplates)
      .values({
        id: data.id,
        name: data.name,
        description: data.description,
        targetType: data.targetType,
        entityType: data.entityType,
        inboxItemType: data.inboxItemType,
        config: data.config || {},
        isDefault: data.isDefault || false,
        isPublic: data.isPublic || false,
        userId: data.userId || userId,
        workspaceId: data.workspaceId,
      } as NewEntityTemplate)
      .returning();

    // Emit completed event
    await this.emitCompleted("create", template, userId);

    return template;
  }

  /**
   * Update an existing template
   * Emits: templates.update.completed
   */
  async update(
    id: string,
    data: UpdateTemplateInput,
    userId: string
  ): Promise<EntityTemplate> {
    const [template] = await this.db
      .update(entityTemplates)
      .set({
        name: data.name,
        description: data.description,
        config: data.config,
        isDefault: data.isDefault,
        isPublic: data.isPublic,
        updatedAt: new Date(),
      } as Partial<NewEntityTemplate>)
      .where(
        and(eq(entityTemplates.id, id), eq(entityTemplates.userId, userId))
      )
      .returning();

    if (!template) {
      throw new Error("Template not found");
    }

    // Emit completed event
    await this.emitCompleted("update", template, userId);

    return template;
  }

  /**
   * Delete a template
   * Emits: templates.delete.completed
   */
  async delete(id: string, userId: string): Promise<void> {
    const result = await this.db
      .delete(entityTemplates)
      .where(
        and(eq(entityTemplates.id, id), eq(entityTemplates.userId, userId))
      )
      .returning({ id: entityTemplates.id });

    if (result.length === 0) {
      throw new Error("Template not found");
    }

    // Emit completed event
    await this.emitCompleted("delete", { id }, userId);
  }
}
