/**
 * Facet Repository — Kind + Facets
 *
 * THE one door for entity_facets writes. No other code may INSERT into
 * entity_facets — attach a role-profile to an entity only through
 * `FacetRepository.attach()`.
 */

import { eq, and, isNull, desc } from "drizzle-orm";
import { entityFacets } from "../schema/entity-facets.js";
import { facetVisibilityConditions } from "../utils/facet-visibility.js";
import { entities } from "../schema/entities.js";
import { BaseRepository } from "./base-repository.js";
import type { EventRepository } from "./event-repository.js";
import type { EntityFacet, NewEntityFacet } from "../schema/entity-facets.js";
import {
  ProfileResolutionService,
  PropertyValidationService,
} from "../services/index.js";
import {
  ProfileNotFoundError,
  PropertyValidationError,
  FacetProfileKindError,
  FacetKindMismatchError,
} from "../errors/index.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../schema/index.js";
import { stampProvenance } from "../utils/stamp-provenance.js";

/** Postgres error code for a unique constraint violation. */
const UNIQUE_VIOLATION = "23505";

export interface AttachFacetInput {
  entityId: string;
  profileId?: string;
  profileSlug?: string;
  userId: string;
  workspaceId?: string | null;
  contextEntityId?: string | null;
  status?: string;
  properties?: Record<string, unknown>;

  /**
   * Skip role-profile validation (profileKind/applicableKinds) and property
   * validation. Use for trusted seed data only — mirrors
   * `CreateEntityInput.skipValidation` on the entity repository.
   */
  skipValidation?: boolean;

  /**
   * Suppress the repository's standard `entity_facets.create.completed`
   * event. Callers that run `attach()` inside a caller-owned transaction
   * (e.g. `EntityRepository.create`'s role-adapter) pass `skipEvent: true`
   * because `this.eventRepo` writes on its OWN connection, not the passed-in
   * `tx` — emitting from inside the transaction would durably record the
   * event even if the transaction later rolls back. The caller is
   * responsible for emitting the event itself, after the transaction
   * commits, via `emitAttachCompletedEvent()`.
   */
  skipEvent?: boolean;

  // Provenance — mirrors CreateEntityInput.
  createdByKind?: "human" | "ai_agent" | "system";
  createdByUserId?: string;
  agentUserId?: string;
  sourceProposalId?: string;
  correlationId?: string;
}

export interface UpdateFacetInput {
  status?: string;
  properties?: Record<string, unknown>;
  /** Workspace lens for property validation — defaults to the facet's stored workspaceId. */
  workspaceId?: string | null;
}

export interface ListFacetsOptions {
  /** Caller's user id — the owner floor for pod-wide (null-workspace) facets. */
  userId: string;
  /**
   * undefined = all workspaces (unfiltered); null = pod-wide facets only;
   * string = that workspace's facets plus pod-wide facets.
   */
  workspaceId?: string | null;
}

export class FacetRepository extends BaseRepository<
  EntityFacet,
  AttachFacetInput,
  UpdateFacetInput
> {
  private profileResolution: ProfileResolutionService;
  private propertyValidation: PropertyValidationService;

  constructor(
    db: PostgresJsDatabase<typeof schema>,
    eventRepo: EventRepository
  ) {
    super(db, eventRepo, {
      subjectType: "entity_facet",
      pluralName: "entity_facets",
    });
    this.profileResolution = new ProfileResolutionService(db);
    this.propertyValidation = new PropertyValidationService(
      this.profileResolution
    );
  }

  /**
   * Attach a role-profile to an entity as a facet.
   *
   * Idempotent-friendly: if an identical live facet already exists (same
   * entity/profile/contextEntityId/workspaceId — the unique index's key),
   * the existing row is returned instead of throwing.
   *
   * Emits: entity_facets.create.completed
   */
  async attach(data: AttachFacetInput, userId: string): Promise<EntityFacet> {
    const workspaceId = data.workspaceId ?? null;

    // 1. Resolve the role profile.
    const identifier = data.profileId ?? data.profileSlug;
    if (!identifier) {
      throw new Error("Either profileId or profileSlug must be provided");
    }
    const profile = await this.profileResolution.resolveProfile(
      identifier,
      userId,
      workspaceId ?? ""
    );
    if (!profile) {
      throw new ProfileNotFoundError(identifier, userId, workspaceId ?? "");
    }

    let validatedProperties: Record<string, unknown> = data.properties ?? {};

    if (!data.skipValidation) {
      // 2. Only 'role' profiles can be attached as facets.
      if (profile.profileKind !== "role") {
        throw new FacetProfileKindError(profile.id, profile.slug);
      }

      // 3. If the role profile restricts which entity kinds it applies to,
      // load the target entity's kind (profile) slug and check membership.
      const applicableKinds = profile.applicableKinds;
      if (applicableKinds && applicableKinds.length > 0) {
        const entity = await this.db.query.entities.findFirst({
          where: eq(entities.id, data.entityId),
          columns: { type: true },
        });
        // `entities.type` mirrors the entity's kind-profile slug (kept in
        // sync with profile.slug — see schema/entities.ts).
        const entityKindSlug = entity?.type;
        if (!entityKindSlug || !applicableKinds.includes(entityKindSlug)) {
          throw new FacetKindMismatchError(
            profile.slug,
            entityKindSlug ?? "(unknown)",
            applicableKinds
          );
        }
      }

      // 4. Validate properties against the role-profile's effective properties.
      // enforceRequired:false — attach is "ask MINIMUM to exist": provided
      // values are type-checked, but a role's required defs never gate the
      // attach (converted roles carry vestigial kind defs like `title` that
      // live on the parent entity).
      const validationResult = await this.propertyValidation.validateProperties(
        data.properties ?? {},
        profile.id,
        workspaceId,
        { enforceRequired: false }
      );
      if (!validationResult.valid) {
        const errors = validationResult.errors.map((err, idx) => ({
          field: `property_${idx}`,
          message: err,
        }));
        throw new PropertyValidationError(errors, profile.id);
      }
      validatedProperties = validationResult.normalized;
    }

    const provenance = stampProvenance({
      userId: data.createdByUserId ?? userId,
      agentUserId: data.agentUserId,
      createdByKind: data.createdByKind,
    });

    try {
      const [facet] = await this.db
        .insert(entityFacets)
        .values({
          entityId: data.entityId,
          profileId: profile.id,
          userId,
          workspaceId,
          contextEntityId: data.contextEntityId ?? null,
          status: data.status,
          properties: validatedProperties,
          createdByKind: provenance.createdByKind,
          createdByUserId: provenance.createdByUserId,
          agentUserId: data.agentUserId,
          sourceProposalId: data.sourceProposalId,
          correlationId: data.correlationId,
        } as NewEntityFacet)
        .returning();

      if (!data.skipEvent) {
        await this.emitCompleted("create", facet, userId);
      }
      return facet;
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        const existing = await this.findLiveMatch(
          data.entityId,
          profile.id,
          data.contextEntityId ?? null,
          workspaceId
        );
        if (existing) return existing;
      }
      throw error;
    }
  }

  /**
   * Emit the `entity_facets.create.completed` event for a facet attached
   * with `skipEvent: true`. Call this on a FacetRepository instance built
   * with the OUTER (non-transactional) db — after the caller's transaction
   * has committed — never from inside the transaction itself.
   */
  async emitAttachCompletedEvent(
    facet: EntityFacet,
    userId: string
  ): Promise<void> {
    await this.emitCompleted("create", facet, userId);
  }

  /** BaseRepository contract — delegates to `attach()` (the real name). */
  async create(data: AttachFacetInput, userId: string): Promise<EntityFacet> {
    return this.attach(data, userId);
  }

  /** BaseRepository contract — delegates to `detach()` (the real name). */
  async delete(facetId: string, userId: string): Promise<void> {
    return this.detach(facetId, userId);
  }

  /** Soft-delete a facet. Never hard-deletes. */
  async detach(
    facetId: string,
    userId: string,
    ownerUserId = userId
  ): Promise<void> {
    const result = await this.db
      .update(entityFacets)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(entityFacets.id, facetId),
          eq(entityFacets.userId, ownerUserId),
          isNull(entityFacets.deletedAt)
        )
      )
      .returning({ id: entityFacets.id });

    if (result.length === 0) return; // already detached/gone — idempotent

    await this.emitCompleted("delete", { id: facetId }, userId);
  }

  /** Update a facet's status/properties. */
  async update(
    facetId: string,
    data: UpdateFacetInput,
    userId: string,
    ownerUserId = userId
  ): Promise<EntityFacet> {
    const existing = await this.db.query.entityFacets.findFirst({
      where: and(
        eq(entityFacets.id, facetId),
        eq(entityFacets.userId, ownerUserId),
        isNull(entityFacets.deletedAt)
      ),
    });
    if (!existing) {
      throw new Error("Facet not found");
    }

    let updatedProperties = existing.properties as Record<string, unknown>;
    if (data.properties) {
      const merged = {
        ...(existing.properties as Record<string, unknown>),
        ...data.properties,
      };
      const lensWorkspaceId = data.workspaceId ?? existing.workspaceId ?? null;
      const validationResult = await this.propertyValidation.validateProperties(
        merged,
        existing.profileId,
        lensWorkspaceId,
        // Same progressive-enrichment rule as attach.
        { enforceRequired: false }
      );
      if (!validationResult.valid) {
        throw new PropertyValidationError(
          validationResult.errors.map((err, idx) => ({
            field: `property_${idx}`,
            message: err,
          })),
          existing.profileId
        );
      }
      updatedProperties = validationResult.normalized;
    }

    const [facet] = await this.db
      .update(entityFacets)
      .set({
        ...(data.status !== undefined && { status: data.status }),
        properties: updatedProperties,
        updatedAt: new Date(),
      } as Partial<NewEntityFacet>)
      .where(eq(entityFacets.id, facetId))
      .returning();

    await this.emitCompleted("update", facet, userId);
    return facet;
  }

  async getById(facetId: string): Promise<EntityFacet | null> {
    const facet = await this.db.query.entityFacets.findFirst({
      where: and(eq(entityFacets.id, facetId), isNull(entityFacets.deletedAt)),
    });
    return facet ?? null;
  }

  /**
   * All live facets attached to an entity.
   * `workspaceId`: undefined = all workspaces; null = pod-wide facets only;
   * string = that workspace's facets plus pod-wide facets.
   */
  async getByEntity(
    entityId: string,
    opts: ListFacetsOptions
  ): Promise<EntityFacet[]> {
    const conditions = [
      eq(entityFacets.entityId, entityId),
      isNull(entityFacets.deletedAt),
      ...facetVisibilityConditions(opts),
    ];

    return this.db.query.entityFacets.findMany({
      where: and(...conditions),
      orderBy: [desc(entityFacets.createdAt)],
    });
  }

  /** All live facets using a given role profile. */
  async listByProfile(
    profileId: string,
    opts: ListFacetsOptions
  ): Promise<EntityFacet[]> {
    const conditions = [
      eq(entityFacets.profileId, profileId),
      isNull(entityFacets.deletedAt),
      ...facetVisibilityConditions(opts),
    ];

    return this.db.query.entityFacets.findMany({
      where: and(...conditions),
      orderBy: [desc(entityFacets.createdAt)],
    });
  }

  private async findLiveMatch(
    entityId: string,
    profileId: string,
    contextEntityId: string | null,
    workspaceId: string | null
  ): Promise<EntityFacet | null> {
    const conditions = [
      eq(entityFacets.entityId, entityId),
      eq(entityFacets.profileId, profileId),
      isNull(entityFacets.deletedAt),
      contextEntityId
        ? eq(entityFacets.contextEntityId, contextEntityId)
        : isNull(entityFacets.contextEntityId),
      workspaceId
        ? eq(entityFacets.workspaceId, workspaceId)
        : isNull(entityFacets.workspaceId),
    ];
    const facet = await this.db.query.entityFacets.findFirst({
      where: and(...conditions),
    });
    return facet ?? null;
  }

  private isUniqueViolation(error: unknown): boolean {
    // Walk the cause chain: drizzle wraps the postgres error (DrizzleQueryError
    // with the pg error as `.cause`), so 23505 is often NOT on the top-level
    // error — a top-only check let a duplicate attach surface as a raw
    // "Failed query" 500 instead of the idempotent existing-row return
    // (verified live).
    let cursor: unknown = error;
    for (
      let depth = 0;
      cursor && typeof cursor === "object" && depth < 4;
      depth++
    ) {
      if ((cursor as { code?: unknown }).code === UNIQUE_VIOLATION) return true;
      cursor = (cursor as { cause?: unknown }).cause;
    }
    return false;
  }
}
