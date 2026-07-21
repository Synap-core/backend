/**
 * Materialize a composite (graph) proposal's operations: create N entities, then
 * the M relations among them, resolving each relation ref → real entity id.
 *
 * Single source of truth shared by:
 *   - proposals.approve (composite branch) — human-approved graph
 *   - /import/apply — user-initiated direct import (their own data, no proposal)
 *
 * Pass 1 creates every create_entity op (canonical entity-create path → full
 * side-effects incl. linked documents when op.content is set), building a
 * ref→realId map. Pass 2 creates relations, resolving sourceRef/targetRef
 * ($opN / op `ref` / $primary / real UUID). Relation failures are logged but
 * never discard the created entities.
 */

import {
  registerEntityRef,
  resolveCompositeRef,
  type CompositeProposalOperation,
} from "@synap-core/types/proposals";
import { createLogger } from "@synap-core/core";
// RELATION_SLUGS is the single source of truth in @synap/database (owned by the
// governed entity materializer). Imported here so this composite path and the
// materializer's invariant-1 guard can never drift apart.
import { RELATION_SLUGS } from "@synap/database";

const logger = createLogger({ module: "materialize-composite" });

/**
 * Create relations from ref-based ops against a ref→realId map. The ONE
 * relation-creation loop, shared by the composite orchestrator and by
 * capture's executeWithSchema (which keeps its own upsert entity phase). Each
 * relation is resolved + created independently: a missing ref or a failed
 * create is reported via `onError` and skipped, never aborting the batch.
 */
export async function createRelationsFromRefs(
  relationOps: Array<{ sourceRef: string; targetRef: string; type: string }>,
  refToRealId: Record<string, string>,
  relationCaller: RelationCreateCaller,
  opts?: {
    /** Validate/normalize the relation type (e.g. slug fallback). */
    resolveRelationType?: (type: string) => string;
    onError?: (err: unknown, type: string) => void;
    /**
     * Relation-retry idempotency (U1): true if this (source, target, type) edge
     * already exists for the tenant → skip re-creating it. Entities are keyed
     * via external-links; relations dedup by DB existence. Only passed when
     * idempotency is active.
     */
    relationExists?: (
      sourceEntityId: string,
      targetEntityId: string,
      type: string
    ) => Promise<boolean>;
  }
): Promise<MaterializeRelationResult[]> {
  const relations: MaterializeRelationResult[] = [];
  for (const op of relationOps) {
    try {
      const sourceEntityId = resolveCompositeRef(refToRealId, op.sourceRef);
      const targetEntityId = resolveCompositeRef(refToRealId, op.targetRef);
      if (sourceEntityId === targetEntityId) continue; // no self-relations
      const type = opts?.resolveRelationType
        ? opts.resolveRelationType(op.type)
        : op.type;
      // Retry-safe: an identical edge already in the graph (a retry, or a
      // duplicate op within this proposal) is skipped, not re-created.
      if (
        opts?.relationExists &&
        (await opts.relationExists(sourceEntityId, targetEntityId, type))
      ) {
        continue;
      }
      await relationCaller.create({ sourceEntityId, targetEntityId, type });
      relations.push({ sourceEntityId, targetEntityId, type });
    } catch (err) {
      opts?.onError?.(err, op.type);
    }
  }
  return relations;
}

export interface MaterializeEntityResult {
  /** Op's stable ref (e.g. capture tempId), if it had one. */
  ref?: string;
  /** Index of the create_entity op in operations[]. */
  opIndex: number;
  /** Real entity id (created or linked-to). */
  entityId: string;
  profileSlug: string;
  /** True when this op linked an existing entity (existingEntityId) vs created. */
  linked: boolean;
  /**
   * Set by callers that DOWNGRADE a failed create to a note fallback — carries
   * the originally requested profileSlug. Additive; absent on the happy path.
   */
  degradedFrom?: string;
  /**
   * Set by callers that SALVAGE a validation failure by retrying the same
   * profile with properties dropped. Additive; absent on the happy path.
   */
  propertiesDropped?: true;
  /**
   * Set when this op carried long-form `content` (a note body) that was NOT
   * applied because the create resolved to an EXISTING entity via strong-signal
   * dedup (entities.create enriches properties on a merge, but never overwrites
   * the matched entity's document). Surfaced (mirrors the facets 'dropped'
   * pattern) so the caller can flag the discarded body instead of losing it
   * silently. Additive; absent on the happy path.
   */
  contentDropped?: true;
}

export interface MaterializeRelationResult {
  sourceEntityId: string;
  targetEntityId: string;
  /** Actual relation type used (post type-resolution/fallback). */
  type: string;
}

export interface MaterializeResult {
  /** Count of entities CREATED (excludes linked existing entities). */
  created: number;
  /** Count of relations created. */
  linked: number;
  primaryId: string;
  refToRealId: Record<string, string>;
  /** Per-entity detail (order matches create_entity ops) for response building. */
  entities: MaterializeEntityResult[];
  /** Per-relation detail for response building. */
  relations: MaterializeRelationResult[];
}

/**
 * Caller shapes — structurally satisfied by the tRPC entitiesRouter /
 * relationsRouter createCaller(...) objects. Typed loosely (the tRPC caller's
 * `create` carries a much wider inferred input than we use) so this util can be
 * shared without re-deriving the router's exact procedure types.
 */

export type EntityCreateCaller = { create: (input: any) => Promise<any> };

export type RelationCreateCaller = { create: (input: any) => Promise<any> };

/**
 * Structurally satisfied by the tRPC entitiesRouter caller — reuses its
 * `attachFacet` procedure (same governance ctx as `entityCaller`, so a
 * human-approved proposal attaches directly rather than re-proposing).
 */
export type FacetAttachCaller = {
  attachFacet: (input: any) => Promise<any>;
};

export interface MaterializeOptions {
  /**
   * Pin every created entity to the caller's active workspace, OVERRIDING any
   * profile pod-default `entityScope`. Imports set this so their data is
   * isolated to the target workspace (and is later purgeable on workspace
   * deletion). Interactive proposal approval leaves it false so pod-default
   * profiles keep their global graph.
   */
  workspaceScoped?: boolean;
  /**
   * Resolve/validate a relation type before creating it (e.g. fall back to a
   * generic type when a slug isn't a valid workspace relation_def). Defaults to
   * pass-through. Capture injects a workspace-aware validator here so the one
   * relation loop serves both the governed (router) and direct-write paths.
   */
  resolveRelationType?: (type: string) => string;
  /**
   * Source tag stamped on each created entity (governance/audit provenance).
   * Defaults to "system" (proposal-approve / import). Capture may pass its own.
   */
  source?: string;
  /**
   * Pre-existing ref→realId mappings from EARLIER chunks of a chunked import.
   * Seeded into pass 1's map so pass 2 relations whose endpoints were created in
   * a previous chunk still resolve. Used by `applyLarge`; omitted for a single
   * call. Entities created in THIS call append to (and override) the seed.
   */
  seedRefToRealId?: Record<string, string>;
  /**
   * Operation-keyed idempotency (U1). When present, each created entity is keyed
   * in an external-link store by `${namespace}:${op.ref}` where `namespace` is a
   * CLIENT-STABLE id (import proposalId / capture idempotencyKey). Before
   * creating an op with a `ref`, we `lookup(provider, externalId)`: a hit LINKS
   * the existing entity (retry-safe — no duplicate); a miss creates then
   * `register`s the key. Distinct ops have distinct `op.ref` → distinct keys →
   * both create (two same-named notes stay separate). Absent → behavior is
   * byte-identical to today (no idempotency).
   */
  idempotency?: {
    namespace: string;
    provider: string;
    lookup: (provider: string, externalId: string) => Promise<string | null>;
    register: (
      entityId: string,
      provider: string,
      externalId: string
    ) => Promise<void>;
    // Relation-retry idempotency: skip an edge that already exists for the tenant.
    relationExists?: (
      sourceEntityId: string,
      targetEntityId: string,
      type: string
    ) => Promise<boolean>;
  };
  /**
   * Cross-CHUNK within-proposal dedup guard. `applyLarge` calls this materializer
   * once per chunk; the in-call "duplicate op.ref → create separate, don't merge"
   * guard is otherwise reset every chunk, so a producer that emits the same
   * `op.ref` in two different chunks would have the second chunk treat the first's
   * registered key as a prior-run retry hit and MERGE two distinct entities.
   * Passing one shared Set across every chunk of a single apply makes the guard
   * span the whole proposal. Omitted for a single call (the local Set suffices).
   */
  idemSeen?: Set<string>;
  /**
   * Facet attacher (Kind + Facets) — when provided, each create_entity op's
   * declared `facets` are attached right after that entity resolves (created
   * OR linked-existing). Omitted → ops carrying `facets` are silently
   * ignored, keeping every existing caller (which doesn't pass this) additive.
   */
  facetCaller?: FacetAttachCaller;
}

export async function materializeCompositeGraph(
  operations: CompositeProposalOperation[],
  entityCaller: EntityCreateCaller,
  relationCaller: RelationCreateCaller,
  onRelationError?: (err: unknown, type: string) => void,
  options?: MaterializeOptions
): Promise<MaterializeResult> {
  // Pass 1 — entities → ref→realId map. An op may LINK an existing entity
  // (existingEntityId) instead of creating one; in that case we register its
  // refs and skip creation. Seeded with earlier-chunk refs (chunked imports) so
  // pass-2 relations across chunk boundaries resolve.
  const refToRealId: Record<string, string> = {
    ...(options?.seedRefToRealId ?? {}),
  };
  const entities: MaterializeEntityResult[] = [];
  let primaryId = "";
  let created = 0;
  // Idempotency keys already handled in THIS materialize call. Guards against a
  // duplicate `op.ref` within ONE proposal silently merging two distinct
  // entities (a producer bug): a second op with the same key creates a separate
  // entity instead of linking to the first. Cross-CALL retries (key registered
  // in a prior call, absent here) still link correctly. `applyLarge` passes a
  // shared Set so the guard spans every chunk of one apply (see `idemSeen`).
  const idemSeenThisCall = options?.idemSeen ?? new Set<string>();
  // Facet-attach ops deferred to pass 1.5 (see below) — collected here so a
  // facet's `contextRef` can resolve against the FULL refToRealId map, not
  // just the entities created before it in operations[].
  const pendingFacetAttaches: Array<{
    realId: string;
    facets: NonNullable<
      Extract<CompositeProposalOperation, { op: "create_entity" }>["facets"]
    >;
  }> = [];
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    if (op.op !== "create_entity") continue;

    // Guard (narrow, exact-match): drop a materialized entity whose title OR
    // profileSlug EXACTLY equals a known relation slug (trimmed, case-insensitive)
    // — a misclassified edge-type from IS structure/import output. Skip + warn;
    // NEVER throw, so the rest of a multi-entity batch still materializes.
    const titleKey = op.title?.trim().toLowerCase();
    const slugKey = op.profileSlug?.trim().toLowerCase();
    if (
      (titleKey && RELATION_SLUGS.has(titleKey)) ||
      (slugKey && RELATION_SLUGS.has(slugKey))
    ) {
      logger.warn(
        {
          title: op.title,
          profileSlug: op.profileSlug,
          source: options?.source ?? "system",
        },
        "Skipping materialized entity: title/type collides with a known relation slug (likely misclassified edge-type from IS structure/import output)"
      );
      continue;
    }

    let realId: string;
    let linkedExisting = false;
    let resultProfileSlug = op.profileSlug;
    let degradedFrom: string | undefined;
    let propertiesDropped: true | undefined;
    let contentDropped: true | undefined;
    // Operation-keyed idempotency (U1): if this op already materialized under
    // the caller's stable namespace (a retry), link the prior entity instead of
    // re-creating. Keyed by `${namespace}:${op.ref}` — distinct ops have
    // distinct refs, so two same-named entities never collide.
    const idemExternalId =
      options?.idempotency && op.ref
        ? `${options.idempotency.namespace}:${op.ref}`
        : undefined;
    let idemHitId: string | null = null;
    if (
      options?.idempotency &&
      idemExternalId &&
      !op.existingEntityId &&
      // Only honor a hit from a PRIOR call (a real retry). A hit on a key already
      // created in THIS call is a within-proposal duplicate ref → do NOT merge.
      !idemSeenThisCall.has(idemExternalId)
    ) {
      idemHitId = await options.idempotency.lookup(
        options.idempotency.provider,
        idemExternalId
      );
    }

    if (op.existingEntityId) {
      // `existingEntityId` is normally a real entity UUID, but a chunked import
      // may link to an entity CREATED in an earlier chunk — in that case it is a
      // synthetic ref present in the seeded map. Resolve through the seed (no-op
      // for a real UUID, which is absent from the map).
      realId = refToRealId[op.existingEntityId] ?? op.existingEntityId;
      linkedExisting = true;
    } else if (idemHitId) {
      // Same namespace + ref seen before → link the prior entity (retry-safe,
      // no duplicate). Treated exactly like the existingEntityId link branch.
      realId = idemHitId;
      linkedExisting = true;
      if (idemExternalId) idemSeenThisCall.add(idemExternalId);
    } else {
      const result = await entityCaller.create({
        profileSlug: op.profileSlug,
        title: op.title || "Untitled",
        description: op.description,
        properties: op.properties,
        content: op.content, // long-form body → linked document
        // `projectId` is additive on the composite wire contract. Some
        // consumers still compile against a pre-generated proposal declaration,
        // so narrow locally until that generated declaration refreshes.
        ...((op as { projectId?: string }).projectId
          ? { projectId: (op as { projectId?: string }).projectId }
          : {}),
        source: options?.source ?? "system",
        // Explicit workspace-scope request (imports): pin to the caller's
        // workspace even for pod-default profiles. The create router reads the
        // active workspace from ctx.workspaceId.
        workspaceScoped: options?.workspaceScoped ?? false,
      });
      realId = (result as { id: string }).id;
      // A caller may report the ACTUAL profile it created (e.g. capture's
      // retry-as-note downgrades the slug); prefer it for the response.
      resultProfileSlug =
        (result as { profileSlug?: string }).profileSlug ?? op.profileSlug;
      // Carry caller-reported salvage/downgrade provenance through (additive).
      degradedFrom = (result as { degradedFrom?: string }).degradedFrom;
      propertiesDropped = (result as { propertiesDropped?: true })
        .propertiesDropped;
      // entities.create resolve-then-merge: a strong-signal dedup returns the
      // PRE-EXISTING entity with `deduplicated: true` (it enriched properties +
      // attached roles, but did NOT create a row). Treat it exactly like an
      // existingEntityId link so revert never DELETES the pre-existing entity and
      // the created-count stays honest. If this op carried a long-form `content`
      // body, the merge silently discards it (create only overwrites properties on
      // a dedup) — flag it so the body isn't lost without a trace.
      if ((result as { deduplicated?: boolean }).deduplicated === true) {
        linkedExisting = true;
        // B3: entities.create now RECOVERS a dropped body onto the deduped entity
        // when it safely can (no existing body to clobber) and reports the
        // residual via `contentDropped`. Prefer that signal; fall back to the old
        // "any content on a dedup is dropped" heuristic only if an older door
        // omits it.
        const reportedDropped = (result as { contentDropped?: boolean })
          .contentDropped;
        if (reportedDropped !== undefined) {
          if (reportedDropped) contentDropped = true;
        } else if (op.content && op.content.trim().length > 0) {
          contentDropped = true;
        }
      } else {
        created++;
      }
      // Register the op's stable key so a retry under the same namespace links
      // this entity instead of re-creating it.
      if (options?.idempotency && idemExternalId) {
        await options.idempotency.register(
          realId,
          options.idempotency.provider,
          idemExternalId
        );
        idemSeenThisCall.add(idemExternalId);
      }
    }

    registerEntityRef(refToRealId, i, op.ref, realId, !primaryId);
    if (!primaryId) primaryId = realId;
    entities.push({
      ref: op.ref,
      opIndex: i,
      entityId: realId,
      profileSlug: resultProfileSlug,
      linked: linkedExisting,
      ...(degradedFrom ? { degradedFrom } : {}),
      ...(propertiesDropped ? { propertiesDropped: true as const } : {}),
      ...(contentDropped ? { contentDropped: true as const } : {}),
    });

    // Declared facets are attached in pass 1.5 below (once every create_entity
    // op has resolved), not here — a facet's `contextRef` may point at an
    // entity created LATER in this same batch, which pass 1 can't resolve yet.
    if (op.facets && op.facets.length > 0) {
      pendingFacetAttaches.push({ realId, facets: op.facets });
    }
  }

  // Pass 1.5 — declared facets (Kind + Facets), after every create_entity op
  // has resolved so refToRealId is fully populated: a facet's `contextRef` can
  // now point at ANY entity in the batch, including one created after it.
  // Additive — only ops carrying `facets` AND a caller that opted in via
  // options.facetCaller attach anything. A failed attach is logged and
  // skipped, never discarding the entity.
  //
  // Re-approval idempotency verdict: `FacetRepository.attach` (@synap/database)
  // catches the unique-index violation on (entityId, profileId, contextEntityId,
  // workspaceId) and returns the existing live row instead of throwing —
  // packages/database/src/repositories/facet-repository.ts:194-205. The
  // `entities.attachFacet` tRPC door (facetCaller here) surfaces that returned
  // row as its normal `{ status: "attached" }` success response — it never
  // inspects "was this a fresh insert or a conflict" —
  // packages/api/src/routers/entities.ts:1993-2046. So a same-(entity, profile,
  // context, workspace) facet attach replayed twice is already a no-op success,
  // not an error. In practice a full proposal re-approval can't reach this path
  // at all: `proposals.approve` rejects any non-PENDING proposal up front
  // (packages/api/src/routers/proposals.ts:2231-2235, "Already ${status}"), so
  // this idempotency only matters for a retry WITHIN one approve/import call
  // (e.g. materialize resumed after a partial failure) — no extra guard needed.
  if (options?.facetCaller) {
    for (const { realId, facets } of pendingFacetAttaches) {
      for (const facetOp of facets) {
        try {
          const contextEntityId = facetOp.contextRef
            ? resolveCompositeRef(refToRealId, facetOp.contextRef)
            : undefined;
          await options.facetCaller.attachFacet({
            entityId: realId,
            profileSlug: facetOp.profileSlug,
            status: facetOp.status,
            properties: facetOp.properties,
            ...(contextEntityId ? { contextEntityId } : {}),
            source: options?.source ?? "system",
          });
        } catch (err) {
          logger.warn(
            { err, entityId: realId, profileSlug: facetOp.profileSlug },
            "Skipping composite facet attach (entity kept)"
          );
        }
      }
    }
  }

  // Pass 2 — relations via the shared loop (resolution + create guarded
  // per-relation; a malformed/failed relation is reported and skipped, never
  // discarding the entities already created).
  const relationOps = operations
    .filter((op) => op.op === "create_relation")
    .map((op) => {
      const r = op as Extract<
        CompositeProposalOperation,
        { op: "create_relation" }
      >;
      return { sourceRef: r.sourceRef, targetRef: r.targetRef, type: r.type };
    });
  const relations = await createRelationsFromRefs(
    relationOps,
    refToRealId,
    relationCaller,
    {
      resolveRelationType: options?.resolveRelationType,
      onError: onRelationError,
      relationExists: options?.idempotency?.relationExists,
    }
  );

  return {
    created,
    linked: relations.length,
    primaryId,
    refToRealId,
    entities,
    relations,
  };
}
