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
import { FacetRepository } from "./facet-repository.js";
import type { EntityFacet } from "../schema/entity-facets.js";
import type { Entity, NewEntity } from "../schema/entities.js";
import {
  ProfileResolutionService,
  PropertyValidationService,
  PropertyIndexService,
} from "../services/index.js";
import type { UnmodeledProperty } from "../services/property-validation-service.js";
import {
  ProfileNotFoundError,
  PropertyValidationError,
} from "../errors/index.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { stampProvenance } from "../utils/stamp-provenance.js";
import {
  extractIdentitySignals,
  registerIdentitySignals,
} from "../services/identity-resolution-service.js";

/**
 * Bounded-concurrency guard for the fire-and-forget identity-signal writes in
 * `create()`. Signal registration never blocks a create (it must not add
 * latency to the single-capture path), but a bulk import fans out one create
 * per row — with nothing capping it, N rows means N concurrent inserts piling
 * onto the pool at once. Cap in-flight writes; anything past the cap queues.
 * Mirrors the guard that previously lived in the entities.create tRPC proc,
 * moved down here so it protects EVERY create door (imports, provisioning,
 * automation/feed workers), not just the one router that had it.
 */
const MAX_INFLIGHT_SIGNAL_WRITES = 25;
let inFlightSignalWrites = 0;
const signalWriteQueue: Array<() => void> = [];

function runBoundedSignalWrite(task: () => Promise<void>): void {
  const start = () => {
    inFlightSignalWrites++;
    // Promise.resolve().then(task): a synchronous throw from task() would
    // otherwise skip .finally() and leak the counter — 25 leaks and every
    // future signal write queues forever.
    Promise.resolve()
      .then(task)
      .catch(() => {})
      .finally(() => {
        inFlightSignalWrites--;
        signalWriteQueue.shift()?.();
      });
  };
  if (inFlightSignalWrites < MAX_INFLIGHT_SIGNAL_WRITES) {
    start();
  } else {
    signalWriteQueue.push(start);
  }
}

/**
 * Typed carrier for `EntityRepository.create`'s TEACHING rejections — the
 * caller aimed the generic create door at something that is not an entity
 * (a project, a multi-kind role). These were `throw new Error(...)`, which no
 * cause-chain mapper can classify, so the clearest teaching prose in the
 * codebase reached the client as a 500 ("Database operation failed") and the
 * agent learned nothing.
 *
 * Extends `PropertyValidationError` deliberately: that class is ALREADY mapped
 * to 400 by `mapDbErrorToTRPC` (instanceof), `isDbDomainError`, and the hub
 * REST `facetErrorStatus` (duck-typed on `.name`). A brand-new name would fall
 * straight back to 500 without edits in @synap/api — so the inherited
 * `name = "PropertyValidationError"` is kept on purpose; the specific case is
 * carried by `guard` for callers that want to branch on it.
 *
 * The message is the teaching prose VERBATIM — the inherited
 * "Property validation failed for profile X: ..." envelope is overwritten.
 */
export class EntityCreateRejectedError extends PropertyValidationError {
  constructor(
    public readonly guard:
      | "project-is-not-an-entity"
      | "role-is-not-a-kind"
      | "file-requires-document",
    message: string,
    profileId: string
  ) {
    super([{ field: "profileSlug", message }], profileId);
    this.message = message;
  }
}

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

/**
 * What `create()` / `update()` hand back: the written row PLUS the advisory
 * signal the property validator produced for it.
 *
 * `unmodeled` lists keys the caller wrote that the profile does not model.
 * They ARE stored (verbatim, in the JSONB bag — the flexible-schema tolerance
 * is deliberate back-compat) and they never make the write fail; the field
 * exists so a caller that invented a key learns it invented one, with a
 * `didYouMean` hint, instead of reading a 200 as "modelled and queryable".
 *
 * OMITTED when there is nothing to report, so the common path returns exactly
 * the row it always did (this object is spread into API responses).
 */
export type WrittenEntity = Entity & { unmodeled?: UnmodeledProperty[] };

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
  async create(
    data: CreateEntityInput,
    userId: string
  ): Promise<WrittenEntity> {
    // Advisory: unknown property keys seen by the validator on this write.
    // Collected across BOTH validation passes (the role-adapter's facet pass
    // in 1a and the entity pass in 2) and returned on the row — never a reason
    // to reject, never a change to what gets stored.
    const unmodeled: UnmodeledProperty[] = [];
    // 1. Resolve profile (required)
    const profileRef = data.profileId ?? data.profileSlug;
    if (!profileRef) {
      throw new Error("Either profileId or profileSlug must be provided");
    }
    let profile = await this.profileResolution.resolveProfile(
      profileRef,
      userId,
      data.workspaceId ?? ""
    );
    if (!profile) {
      throw new ProfileNotFoundError(
        profileRef,
        userId,
        data.workspaceId ?? ""
      );
    }

    // 1a-pre. Ghost-project door (P1 guardrail e). A project is a COMMITMENT
    // WITH GRAVITY held in the `projects` TABLE — never an entity. Pre-0151
    // fossils created `project`-profile entities via this generic door, orphan
    // rows that bypass the projects table AND the (a)–(d) project guardrails
    // (dedup / provenance / gravity). Block CREATE only — update/read of the
    // remaining fossils stay allowed (this is the create path; update is
    // separate). Route the caller to the real project door.
    if (profile.slug === "project") {
      throw new EntityCreateRejectedError(
        "project-is-not-an-entity",
        "Projects are not entities. Use the project door (MCP synap_create_project / POST /api/hub/projects) — agent creation requires evidenceEntityIds (≥5). To group work, link entities to an existing project via belongs_to_project.",
        profile.id
      );
    }

    // 1a-pre-2. File-is-uploaded-bytes door. The `file` kind is ONLY for real
    // uploaded bytes — its identity is a stored `documents` row reached via
    // `documentId`. Authored text is NOT a file: it belongs to a content kind
    // (note/article/…) whose body auto-becomes a document. Reject a `file`
    // create that carries no upload-derived `documentId` so an agent can't
    // mislabel prose as a file (which would then synthesize an empty/ghost
    // document). The governed upload door supplies a real `documentId` and so
    // passes cleanly. Backstop for the API-entry guard in entities.create.
    if (profile.slug === "file" && !data.documentId) {
      throw new EntityCreateRejectedError(
        "file-requires-document",
        "A `file` entity must be backed by an uploaded document — use the upload door (synap upload / POST /api/hub/entities/files). Authored text should be a content kind (note/article/…); its body becomes a document automatically.",
        profile.id
      );
    }

    // 1a. Role profiles are hats, never things (Kind + Facets). A create
    // aimed at a role profile is transparently adapted to the same shape
    // ConvertToFacetOp produces: the entity is created on the role's single
    // applicable KIND, and the role attaches as a facet carrying the supplied
    // properties (attached atomically with the insert in step 3). This keeps
    // every legacy door — capture,
    // remember_fact, research persistence, raw create_entity — writing the
    // kind+facet shape without per-caller edits. A multi-kind role (client →
    // person|company) can't guess its target entity, so it is rejected toward
    // the attach door instead.
    let roleFacetProfile: typeof profile | null = null;
    let roleFacetProperties: Record<string, unknown> = {};
    if (profile.profileKind === "role" && data.skipValidation) {
      // skipValidation (trusted seeds/imports) intentionally bypasses the
      // adapter — but that means a seed/template referencing a role slug
      // directly reintroduces the exact drift this feature exists to close,
      // silently. No shipped automation/template does this today (checked),
      // but there's no structural guard against a future one doing so — log
      // loud so it's visible in practice instead of a quiet ontology drift.
      console.warn(
        `EntityRepository.create: skipValidation created an entity directly ` +
          `on role profile '${profile.slug}' (profileId=${profile.id}) — this ` +
          `bypasses the role→kind+facet adapter and violates one-entity-one-kind. ` +
          `The caller should target the role's applicable kind and attach '${profile.slug}' as a facet instead.`
      );
    }
    if (profile.profileKind === "role" && !data.skipValidation) {
      const applicable = profile.applicableKinds ?? [];
      if (applicable.length !== 1) {
        throw new EntityCreateRejectedError(
          "role-is-not-a-kind",
          `Profile '${profile.slug}' is a role (a hat), not a kind — it cannot ` +
            `be created as an entity. Resolve or create the target entity ` +
            `(applicable kinds: ${applicable.join(", ") || "none"}) first, ` +
            `then attach the '${profile.slug}' facet to it.`,
          profile.id
        );
      }
      const target = await this.profileResolution.resolveProfile(
        applicable[0],
        userId,
        data.workspaceId ?? ""
      );
      if (!target || target.profileKind === "role") {
        throw new Error(
          `Role '${profile.slug}' targets kind '${applicable[0]}', which is ` +
            `not an active kind profile on this pod`
        );
      }
      // Validate the role's properties against the ROLE profile up front, so
      // a bad payload fails BEFORE the kind entity is inserted (no orphan).
      // Merge data.title in first — a converted role can carry a vestigial
      // required `title` def left over from when it was a kind (e.g.
      // `contact`), and the caller supplies title at the top level (the
      // common frontend/API pattern), not inside `properties`. Mirrors the
      // identical merge the non-role path below already does, and does NOT
      // disable enforceRequired wholesale (unlike attach()'s enforceRequired:
      // false) — a role's OWN required fields (e.g. knowledge's ek_type)
      // must still fail loud here; only the vestigial-title case is real.
      const roleTitleAlreadyInProps =
        data.properties && "title" in data.properties;
      const propsToValidateForRole: Record<string, unknown> = {
        ...data.properties,
      };
      if (data.title !== undefined && !roleTitleAlreadyInProps) {
        propsToValidateForRole["title"] = data.title;
      }
      const facetValidation = await this.propertyValidation.validateProperties(
        propsToValidateForRole,
        profile.id,
        data.workspaceId ?? null
      );
      if (!facetValidation.valid) {
        throw new PropertyValidationError(
          facetValidation.errors.map((err, idx) => ({
            field: `property_${idx}`,
            message: err,
          })),
          profile.id
        );
      }
      unmodeled.push(...facetValidation.unmodeled);
      roleFacetProfile = profile;
      roleFacetProperties = { ...facetValidation.normalized };
      if (!roleTitleAlreadyInProps) {
        // title was merged in ONLY to satisfy a vestigial required def — it
        // belongs on the kind entity (see comment below), not duplicated
        // onto the facet's own properties.
        delete roleFacetProperties["title"];
      }
      profile = target;
      // The role's data lives on the facet; the kind entity carries only the
      // identity columns (title/preview/document).
      data = { ...data, properties: {} };
    }

    const profileId: string = profile.id;
    const entityType: string = profile.slug;

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
      unmodeled.push(...validationResult.unmodeled);
    } else if (!profileId && data.properties) {
      // No profile - just store properties as-is (flexible)
      validatedProperties = data.properties;
    }

    // 3. Create entity
    const provenance = stampProvenance({
      userId: data.createdByUserId ?? userId,
      agentUserId: data.agentUserId,
      createdByKind: data.createdByKind,
    });
    const insertValues = {
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
      createdByKind: provenance.createdByKind,
      createdByUserId: provenance.createdByUserId,
      agentUserId: data.agentUserId,
      sourceProposalId: data.sourceProposalId,
      correlationId: data.correlationId,
    } as NewEntity;

    let entity: Entity;
    if (roleFacetProfile) {
      // Role-adapter write is ATOMIC: the kind entity and its role facet
      // commit together, so a facet failure (FK, connection drop, anything
      // beyond attach's handled conflict) rolls the entity back instead of
      // stranding an empty `item` while the role payload — already moved off
      // entity.properties — is lost. This matters doubly on the materializer
      // path, whose subjectId idempotency guard would otherwise skip the
      // retry and never heal the missing facet. Facet properties were
      // validated against the ROLE profile in 1a, hence skipValidation
      // (attach's own door validates with enforceRequired:false anyway —
      // the stricter 1a check is deliberate: legacy capture flows depend on
      // required-def failures like a missing ek_type surfacing early).
      const roleProfileId = roleFacetProfile.id;
      // The facet's own completed event must NOT fire from inside this
      // transaction: EventRepository writes on its own connection, separate
      // from `tx` — an in-transaction emit would durably record the event
      // even if the transaction later fails to commit. attach() is called
      // with skipEvent:true; the facet row is captured and its event is
      // emitted below, once the transaction has actually resolved — the
      // same ordering this method already uses for the entity's own event
      // (emitCompleted after, never inside, the write).
      let attachedFacet: EntityFacet | undefined;
      entity = await this.db.transaction(async (tx: any) => {
        const [row] = await tx
          .insert(entities)
          .values(insertValues)
          .returning();
        const facetRepo = new FacetRepository(tx, this.eventRepo);
        attachedFacet = await facetRepo.attach(
          {
            entityId: row.id,
            profileId: roleProfileId,
            userId,
            workspaceId: effectiveWorkspaceId,
            properties: roleFacetProperties,
            skipValidation: true,
            skipEvent: true,
            createdByKind: provenance.createdByKind,
            createdByUserId: provenance.createdByUserId,
            agentUserId: data.agentUserId,
            sourceProposalId: data.sourceProposalId,
            correlationId: data.correlationId,
          },
          userId
        );
        return row as Entity;
      });
      if (attachedFacet) {
        const outerFacetRepo = new FacetRepository(this.db, this.eventRepo);
        await outerFacetRepo.emitAttachCompletedEvent(attachedFacet, userId);
      }
    } else {
      const [row] = await this.db
        .insert(entities)
        .values(insertValues)
        .returning();
      entity = row;
    }

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

    // 6. Auto-register identity signals (email/phone/url/handle) — non-blocking.
    //    THE door: every producer that reaches EntityRepository.create (tRPC
    //    create, imports, provisioning, automation/feed workers) now feeds
    //    resolveIdentity's strong path, so a later write dedups against this
    //    entity instead of silently creating a duplicate. Never blocks or fails
    //    the create — a signal-write error is logged and swallowed.
    const signals = extractIdentitySignals(validatedProperties);
    if (signals.length > 0) {
      runBoundedSignalWrite(() =>
        registerIdentitySignals(
          this.db,
          entity.id,
          signals,
          "entity-repository.create"
        ).catch((error) => {
          console.warn(
            `Failed to register identity signals for entity ${entity.id}:`,
            error
          );
        })
      );
    }

    // Additive: the row exactly as before, plus the advisory `unmodeled` list
    // when (and only when) there is something to tell the caller.
    return unmodeled.length ? { ...entity, unmodeled } : entity;
  }

  /**
   * Update an existing entity with profile-based validation
   * Emits: entities.update.completed
   */
  async update(
    id: string,
    data: UpdateEntityInput,
    userId: string
  ): Promise<WrittenEntity> {
    // Same advisory contract as create() — see WrittenEntity.
    const unmodeled: UnmodeledProperty[] = [];
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
      unmodeled.push(...validationResult.unmodeled);
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

    return unmodeled.length ? { ...entity, unmodeled } : entity;
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

    // Emit completed event with metadata. Must carry workspaceId (the
    // realtime bridge drops workspace-scoped event types with no workspaceId
    // in the payload) and type, sourced from the pre-delete snapshot since the
    // row itself is now gone.
    await this.emitCompleted(
      "delete",
      {
        id,
        workspaceId: entity.workspaceId,
        type: entity.type,
        // Document cascade info is in event data, not entity record
      },
      userId
    );
  }
}
