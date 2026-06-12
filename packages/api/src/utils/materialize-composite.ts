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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EntityCreateCaller = { create: (input: any) => Promise<any> };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RelationCreateCaller = { create: (input: any) => Promise<any> };

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
  // refs and skip creation.
  const refToRealId: Record<string, string> = {};
  const entities: MaterializeEntityResult[] = [];
  let primaryId = "";
  let created = 0;
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    if (op.op !== "create_entity") continue;

    let realId: string;
    let linkedExisting = false;
    let resultProfileSlug = op.profileSlug;
    let degradedFrom: string | undefined;
    let propertiesDropped: true | undefined;
    if (op.existingEntityId) {
      realId = op.existingEntityId;
      linkedExisting = true;
    } else {
      const result = await entityCaller.create({
        profileSlug: op.profileSlug,
        title: op.title || "Untitled",
        description: op.description,
        properties: op.properties,
        content: op.content, // long-form body → linked document
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
      created++;
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
    });
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
