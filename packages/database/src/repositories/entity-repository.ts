/**
 * Entity Repository with Profile-Based Validation
 *
 * Entities now use profiles (dynamic types) instead of hardcoded EntityType enum.
 * Properties are validated against profile schemas and stored in entities.properties JSONB.
 */

import { eq, and } from "drizzle-orm";
import { entities } from "../schema/index.js";
import { BaseRepository } from "./base-repository.js";
import type { EventRepository } from "./event-repository.js";
import type { Entity, NewEntity } from "../schema/entities.js";
import {
  ProfileResolutionService,
  PropertyValidationService,
  PropertyIndexService,
} from "../services/index.js";
import {
  ProfileNotFoundError,
  PropertyValidationError,
} from "../errors/index.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

export interface CreateEntityInput {
  // Profile-based (required)
  profileId?: string;
  profileSlug?: string; // Alternative to profileId

  // Common fields
  title?: string;
  preview?: string;
  documentId?: string; // Link to document for content

  // Properties (validated against profile)
  properties?: Record<string, unknown>;

  workspaceId: string;
  userId: string;
}

export interface UpdateEntityInput {
  title?: string;
  preview?: string;
  content?: string;

  // Properties (validated against profile)
  properties?: Record<string, unknown>;
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
  private profileResolution: ProfileResolutionService;
  private propertyValidation: PropertyValidationService;
  private propertyIndex: PropertyIndexService;

  constructor(
    db: PostgresJsDatabase<typeof import("../schema/index.js")>,
    eventRepo: EventRepository
  ) {
    super(db, eventRepo, { subjectType: "entity", pluralName: "entities" });
    this.profileResolution = new ProfileResolutionService(db);
    this.propertyValidation = new PropertyValidationService(
      this.profileResolution
    );
    this.propertyIndex = new PropertyIndexService(db);
  }

  /**
   * Create a new entity with profile-based validation
   * Emits: entities.create.completed
   */
  async create(data: CreateEntityInput, userId: string): Promise<Entity> {
    // 1. Resolve profile (required)
    let profileId: string | null = null;
    let entityType: string;

    if (data.profileId) {
      profileId = data.profileId;
      const profile = await this.profileResolution.resolveProfile(
        profileId,
        userId,
        data.workspaceId
      );
      if (!profile) {
        throw new ProfileNotFoundError(profileId, userId, data.workspaceId);
      }
      entityType = profile.slug;
    } else if (data.profileSlug) {
      const profile = await this.profileResolution.resolveProfile(
        data.profileSlug,
        userId,
        data.workspaceId
      );
      if (!profile) {
        throw new ProfileNotFoundError(
          data.profileSlug,
          userId,
          data.workspaceId
        );
      }
      profileId = profile.id;
      entityType = profile.slug;
    } else {
      throw new Error("Either profileId or profileSlug must be provided");
    }

    // 2. Validate and normalize properties
    let validatedProperties: Record<string, unknown> = {};
    if (profileId && data.properties) {
      const validationResult = await this.propertyValidation.validateProperties(
        data.properties,
        profileId
      );

      if (!validationResult.valid) {
        const errors = validationResult.errors.map((err, idx) => ({
          field: `property_${idx}`,
          message: err,
        }));
        throw new PropertyValidationError(errors, profileId);
      }

      validatedProperties = validationResult.normalized;
    } else if (data.properties) {
      // No profile - just store properties as-is (flexible)
      validatedProperties = data.properties;
    }

    // 3. Create entity
    const [entity] = await this.db
      .insert(entities)
      .values({
        userId,
        workspaceId: data.workspaceId,
        profileId,
        type: entityType,
        title: data.title,
        preview: data.preview,
        documentId: data.documentId,
        properties: validatedProperties,
      } as NewEntity)
      .returning();

    // 4. Index properties (async, non-blocking)
    if (profileId && Object.keys(validatedProperties).length > 0) {
      this.propertyIndex
        .indexEntityProperties(entity.id, validatedProperties, profileId)
        .catch((error) => {
          console.warn(
            `Failed to index properties for entity ${entity.id}:`,
            error
          );
        });
    }

    // 5. Emit completed event
    await this.emitCompleted("create", entity, userId);

    return entity;
  }

  /**
   * Update an existing entity with profile-based validation
   * Emits: entities.update.completed
   */
  async update(
    id: string,
    data: UpdateEntityInput,
    userId: string
  ): Promise<Entity> {
    // 1. Get existing entity
    const existing = await this.db.query.entities.findFirst({
      where: and(eq(entities.id, id), eq(entities.userId, userId)),
    });

    if (!existing) {
      throw new Error("Entity not found");
    }

    // 2. Validate and merge properties if provided
    let updatedProperties = existing.properties || {};
    if (data.properties && existing.profileId) {
      // Merge with existing properties
      const mergedProperties = {
        ...(existing.properties as Record<string, unknown>),
        ...data.properties,
      };

      const validationResult = await this.propertyValidation.validateProperties(
        mergedProperties,
        existing.profileId
      );

      if (!validationResult.valid) {
        throw new Error(
          `Property validation failed: ${validationResult.errors.join(", ")}`
        );
      }

      updatedProperties = validationResult.normalized;
    } else if (data.properties) {
      // No profile - just merge properties
      updatedProperties = {
        ...(existing.properties as Record<string, unknown>),
        ...data.properties,
      };
    }

    // 3. Update entity
    const [entity] = await this.db
      .update(entities)
      .set({
        title: data.title,
        preview: data.preview,
        content: data.content,
        properties: updatedProperties,
        updatedAt: new Date(),
      } as Partial<NewEntity>)
      .where(and(eq(entities.id, id), eq(entities.userId, userId)))
      .returning();

    if (!entity) {
      throw new Error("Entity not found");
    }

    // 4. Reindex properties if changed
    if (data.properties && existing.profileId) {
      this.propertyIndex
        .reindexEntity(
          entity.id,
          updatedProperties as Record<string, unknown>,
          existing.profileId
        )
        .catch((error) => {
          console.warn(
            `Failed to reindex properties for entity ${entity.id}:`,
            error
          );
        });
    }

    // 5. Emit completed event
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
