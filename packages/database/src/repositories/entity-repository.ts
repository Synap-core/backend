/**
 * Entity Repository with Profile-Based Validation
 *
 * Entities now use profiles (dynamic types) instead of hardcoded EntityType enum.
 * Properties are validated against profile schemas and stored in entities.properties JSONB.
 */

import { eq, and, or, isNull, inArray, desc } from "drizzle-orm";
import { entities } from "../schema/index.js";
import type * as schema from "../schema/index.js";
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
  /**
   * Pin the new row's id instead of letting the DB mint one. Used by the
   * proposal materializer so the created entity's id equals the event
   * `subjectId` — this is what makes proposal revert (delete-by-targetId) and
   * the create-idempotency guard (lookup-by-subjectId) actually hit the row.
   * Omit for normal creates (DB `defaultRandom()` applies).
   */
  id?: string;

  // Profile-based (required)
  profileId?: string;
  profileSlug?: string; // Alternative to profileId

  // Common fields
  title?: string;
  preview?: string;
  documentId?: string; // Link to document for content

  // Properties (validated against profile)
  properties?: Record<string, unknown>;

  workspaceId?: string | null; // null for pod-wide entities
  userId: string;

  // Provenance (Wave B3) — who/what authored this row. Optional; the repo
  // derives sensible defaults (created_by_user_id = userId; created_by_kind =
  // ai_agent when agentUserId is present, else human).
  createdByKind?: "human" | "ai_agent" | "system";
  createdByUserId?: string;
  agentUserId?: string;
  sourceProposalId?: string;
  correlationId?: string;

  /**
   * Skip property validation. Use for trusted seed data during workspace provisioning
   * where template property slugs may differ from system profile property defs.
   * Properties are stored as-is without enum/required checks.
   */
  skipValidation?: boolean;
}

export interface UpdateEntityInput {
  title?: string;
  preview?: string;
  content?: string;
  /** Link entity to a document (for content). */
  documentId?: string | null;

  // Properties (validated against profile)
  properties?: Record<string, unknown>;

  /** Change entity's profile type by slug */
  profileSlug?: string;

  /**
   * The workspace context for validation/rendering. Required when updating
   * pod-wide entities whose stored `workspaceId` is null — without this the
   * write path can't resolve the caller's overlay property set. Callers in
   * workspaceProcedure routers should always pass `ctx.workspaceId`.
   */
  workspaceId?: string | null;

  /**
   * Keys to remove from the entity's properties object before applying any
   * `properties` merge. Keys listed here are deleted even if `properties` is
   * absent. Useful when the caller needs to remove a property without
   * replacing the entire object.
   */
  deleteProperties?: string[];

  /**
   * Suppress the repository's standard `entities.update.completed` event.
   *
   * Callers that emit their own domain event (e.g. the automation executor
   * wraps updates in an automation-context event via `emitSideEffects()`)
   * pass `skipEvent: true` to avoid double-emission while still benefiting
   * from validation, indexing, and the workspace lens. Downstream
   * materializers react to the caller's event, not the repo's.
   */
  skipEvent?: boolean;
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
    db: PostgresJsDatabase<typeof schema>,
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
   * List entities across multiple workspaces (used by cross-workspace queries).
   * Returns entities where workspaceId is in the provided list.
   * Optionally includes global entities (workspaceId IS NULL).
   */
  async listForWorkspaces(
    workspaceIds: string[],
    userId: string,
    opts: {
      profileSlug?: string;
      limit?: number;
      includeGlobal?: boolean;
    } = {}
  ): Promise<Entity[]> {
    const { profileSlug, limit = 50, includeGlobal = false } = opts;

    // Build workspace condition
    let workspaceCondition;
    if (workspaceIds.length > 0 && includeGlobal) {
      workspaceCondition = or(
        inArray(entities.workspaceId, workspaceIds),
        isNull(entities.workspaceId)
      );
    } else if (workspaceIds.length > 0) {
      workspaceCondition = inArray(entities.workspaceId, workspaceIds);
    } else if (includeGlobal) {
      workspaceCondition = isNull(entities.workspaceId);
    } else {
      // No workspaces + no global → return empty
      return [];
    }

    const conditions = [eq(entities.userId, userId), workspaceCondition];

    if (profileSlug) {
      conditions.push(eq(entities.type, profileSlug));
    }

    return this.db.query.entities.findMany({
      where: and(...conditions),
      orderBy: [desc(entities.updatedAt)],
      limit,
    });
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
        data.workspaceId ?? ""
      );
      if (!profile) {
        throw new ProfileNotFoundError(
          profileId,
          userId,
          data.workspaceId ?? ""
        );
      }
      entityType = profile.slug;
    } else if (data.profileSlug) {
      const profile = await this.profileResolution.resolveProfile(
        data.profileSlug,
        userId,
        data.workspaceId ?? ""
      );
      if (!profile) {
        throw new ProfileNotFoundError(
          data.profileSlug,
          userId,
          data.workspaceId ?? ""
        );
      }
      profileId = profile.id;
      entityType = profile.slug;
    } else {
      throw new Error("Either profileId or profileSlug must be provided");
    }

    // 1b. The router is the single source of truth for the effective
    // workspaceId. It already resolves global / explicit-scope / profile
    // pod-default into `data.workspaceId`, so the repo simply stores what it
    // is given (null = pod-wide). Do NOT re-derive scope from the profile here
    // — doing so would override an explicit workspace request (e.g. imports).
    const effectiveWorkspaceId = data.workspaceId ?? null;

    // 2. Validate and normalize properties
    let validatedProperties: Record<string, unknown> = {};
    if (data.skipValidation) {
      // Trusted seed data (template provisioning) — store as-is without schema enforcement
      validatedProperties = data.properties ?? {};
    } else if (profileId) {
      // Merge top-level title into properties before validation so profiles that
      // declare a required "title" property_def don't fail when the caller only
      // passes title at the entity level (which is the common frontend pattern).
      const propsToValidate: Record<string, unknown> = { ...data.properties };
      if (data.title !== undefined && !("title" in propsToValidate)) {
        propsToValidate["title"] = data.title;
      }

      // Validate through the requesting workspace's lens — overlay props
      // owned by other workspaces are treated as unknown (ignored), so cross-
      // workspace schema leaks can't happen here.
      const validationResult = await this.propertyValidation.validateProperties(
        propsToValidate,
        profileId,
        data.workspaceId ?? null
      );

      if (!validationResult.valid) {
        const errors = validationResult.errors.map((err, idx) => ({
          field: `property_${idx}`,
          message: err,
        }));
        throw new PropertyValidationError(errors, profileId);
      }

      validatedProperties = validationResult.normalized;
    } else if (!profileId && data.properties) {
      // No profile - just store properties as-is (flexible)
      validatedProperties = data.properties;
    }

    // 3. Create entity
    const [entity] = await this.db
      .insert(entities)
      .values({
        // Pin id only when the caller supplied one (materializer); otherwise
        // undefined → Drizzle omits it → DB defaultRandom() mints a fresh uuid.
        ...(data.id ? { id: data.id } : {}),
        userId,
        workspaceId: effectiveWorkspaceId,
        profileId,
        type: entityType,
        title: data.title,
        preview: data.preview,
        documentId: data.documentId,
        properties: validatedProperties,
        // Provenance (Wave B3)
        createdByKind:
          data.createdByKind ?? (data.agentUserId ? "ai_agent" : "human"),
        createdByUserId: data.createdByUserId ?? userId,
        agentUserId: data.agentUserId,
        sourceProposalId: data.sourceProposalId,
        correlationId: data.correlationId,
      } as NewEntity)
      .returning();

    // 4. Index properties (async, non-blocking) — index through the
    //    requesting workspace's lens so overlay props get indexed too.
    if (profileId && Object.keys(validatedProperties).length > 0) {
      this.propertyIndex
        .indexEntityProperties(
          entity.id,
          validatedProperties,
          profileId,
          data.workspaceId ?? null
        )
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
    // 2b. Resolve new profile if profileSlug is provided
    let newProfileId: string | undefined;
    let newType: string | undefined;
    if (data.profileSlug) {
      const newProfile = await this.profileResolution.resolveProfile(
        data.profileSlug,
        userId,
        existing.workspaceId ?? ""
      );
      if (newProfile) {
        newProfileId = newProfile.id;
        newType = newProfile.slug;
      }
    }

    const validationProfileId = newProfileId || existing.profileId;

    // Apply key deletions first so the merge step never re-introduces them.
    const baseProperties: Record<string, unknown> = {
      ...(existing.properties as Record<string, unknown>),
    };
    if (data.deleteProperties?.length) {
      for (const key of data.deleteProperties) {
        delete baseProperties[key];
      }
    }

    let updatedProperties: Record<string, unknown> = baseProperties;
    if (data.properties && validationProfileId) {
      // Merge with existing properties (after deletions)
      const mergedProperties = {
        ...baseProperties,
        ...data.properties,
      };

      // Lens resolution: the caller's workspace context (if supplied) takes
      // precedence over the entity's stored workspace. Pod-wide entities
      // have a null stored workspace, so without `data.workspaceId` we'd
      // lose sight of the caller's overlay props. Callers in workspace
      // procedures should always pass `ctx.workspaceId`.
      const lensWorkspaceId = data.workspaceId ?? existing.workspaceId ?? null;
      const validationResult = await this.propertyValidation.validateProperties(
        mergedProperties,
        validationProfileId,
        lensWorkspaceId
      );

      if (!validationResult.valid) {
        throw new Error(
          `Property validation failed: ${validationResult.errors.join(", ")}`
        );
      }

      updatedProperties = validationResult.normalized;
    } else if (data.properties) {
      // No profile - just merge properties (after deletions already applied to baseProperties)
      updatedProperties = {
        ...baseProperties,
        ...data.properties,
      };
    }

    // 3. Update entity
    const [entity] = await this.db
      .update(entities)
      .set({
        ...(data.title !== undefined && { title: data.title }),
        ...(data.preview !== undefined && { preview: data.preview }),
        ...(data.documentId !== undefined && { documentId: data.documentId }),
        ...(newProfileId && { profileId: newProfileId }),
        ...(newType && { type: newType }),
        properties: updatedProperties,
        updatedAt: new Date(),
      } as Partial<NewEntity>)
      .where(and(eq(entities.id, id), eq(entities.userId, userId)))
      .returning();

    if (!entity) {
      throw new Error("Entity not found");
    }

    // 4. Reindex properties if changed — use the same lens as validation
    const reindexProfileId = newProfileId || existing.profileId;
    if (
      (data.properties || data.deleteProperties?.length) &&
      reindexProfileId
    ) {
      const lensWorkspaceId = data.workspaceId ?? existing.workspaceId ?? null;
      this.propertyIndex
        .reindexEntity(
          entity.id,
          updatedProperties as Record<string, unknown>,
          reindexProfileId,
          lensWorkspaceId
        )
        .catch((error) => {
          console.warn(
            `Failed to reindex properties for entity ${entity.id}:`,
            error
          );
        });
    }

    // 5. Emit completed event (unless caller is wrapping the write in its
    //    own domain event — see `skipEvent` on UpdateEntityInput)
    if (!data.skipEvent) {
      await this.emitCompleted("update", entity, userId);
    }

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

    // Idempotent: entity already gone — treat as success
    if (!entity) {
      return;
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
      return; // deleted between check and write — idempotent
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
